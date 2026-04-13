# 方案详图：正式视图房间丢失 — 根因定位与修复计划
 
## Context
 
在"方案详图"中，左侧正式视图（`svg-ag41`，60% 宽）通过"包围框矩形"表示各房间，  
右侧调试视图（`debug-grid-container`，40% 宽）逐格渲染真实网格单元（每格 500mm）。  
用户观察到：调试视图中可见的房间，在正式视图中完全消失。
 
**要求**：房间必须紧密、不重合地占据整个楼层（等同于调试视图的格子分配关系）。  
不能用 z 排序修复，因为大房间的矩形区域本身就必须排除小房间所在的那部分面积。
 
---
 
## 根本原因
 
### 两步叠加导致房间消失
 
#### 第 1 步：`finalizeLayout()` 将非矩形房间错误地近似为包围框矩形
 
`layout-generator.js:338-360`，`finalizeLayout()` 只存 bbox：
```js
const roomLayout = {
  x: bbox.minX * GRID_SIZE,
  y: bbox.minY * GRID_SIZE,
  w: (bbox.maxX - bbox.minX + 1) * GRID_SIZE,   // 整行/列宽
  d: (bbox.maxY - bbox.minY + 1) * GRID_SIZE,   // 整行/列深
};
```
 
扩展算法（`expandRooms`）在矩形扩展被阻挡时，fallback 到
`findBestFillExpansion`（line 261）和 `findFallbackExpansion`（line 265），
后两者逐格添加，使房间变成 **L / U / C 等不规则形状**。
 
结果：大房间（如 `parking`，约 680 格）的包围框可完全包含小房间（如 `dock1`，36 格）
的坐标，尽管大房间的格子实际上不占那些位置。
 
#### 第 2 步：`renderHalf()` 按任意顺序绘制矩形，大矩形盖住小矩形
 
`layout-svg.js:154`，按 `Object.entries(placements)` 顺序绘制 SVG：
若大房间后画，其填充矩形完全盖住小房间的矩形 → 小房间**视觉消失**。
 
调试视图（`renderDebugGrid`, svg-helpers.js:71-77）按格着色，同一格只属于一个房间，
天然无重叠，因此无此问题。
 
**Z 排序不能解决问题**：即使小房间在上层绘制，大房间矩形的颜色区域仍然错误地
覆盖了本不属于它的那部分面积——只是视觉上小房间"浮"在上面，两者还是重叠的。
 
---
 
## 正确修复方案：用真实单元格轮廓渲染正式视图
 
让每个房间的正式渲染形状 = 其真实格子的外轮廓多边形，彻底消除重叠。
 
### 需修改的文件
 
| 文件 | 修改内容 |
|------|---------|
| `src/layout/layout-generator.js` | `finalizeLayout()` 在 placement 对象中额外存储 `cells` 数组和 `gridSize` |
| `src/render/svg-helpers.js` | 新增 `computeRoomOutlinePath(cells, gridSize, ps, ox, oy)` 函数 |
| `src/render/layout-svg.js` | `renderHalf()` 和 `renderLayoutSVG()` 改用轮廓路径渲染（有 `cells` 时） |
 
---
 
## 详细实现步骤
 
### 步骤 1：`finalizeLayout()` 导出 cells 数据
 
**文件**：`src/layout/layout-generator.js:338-360`
 
```js
function finalizeLayout(grid) {
  const layout = { ground: {}, level1: {} };
  const roomIds = Object.keys(grid.roomData);
 
  for (const roomId of roomIds) {
    const cells = grid.roomData[roomId];          // ← 取真实单元格列表
    const bbox = grid.getBoundingBox(roomId);
    if (bbox) {
      const roomLayout = {
        x: bbox.minX * GRID_SIZE,
        y: bbox.minY * GRID_SIZE,
        w: (bbox.maxX - bbox.minX + 1) * GRID_SIZE,
        d: (bbox.maxY - bbox.minY + 1) * GRID_SIZE,
        cells,          // ← 新增：原始格子坐标列表 [{x,y}, ...]
        gridSize: GRID_SIZE, // ← 新增：方便渲染层使用
      };
      const roomDef = ROOM_DEFS[roomId];
      if (roomDef) {
        const floor = roomDef.floor === 'ground' ? 'ground' : 'level1';
        layout[floor][roomId] = roomLayout;
      }
    }
  }
  return layout;
}
```
 
---
 
### 步骤 2：新增 `computeRoomOutlinePath()` 到 svg-helpers.js
 
**文件**：`src/render/svg-helpers.js`（在文件末尾追加）
 
```js
/**
 * 根据房间的真实格子列表，计算其外轮廓 SVG path 字符串。
 * 每条格子边：若相邻格不属于同一房间则为"外边"，收集后连成多边形。
 *
 * @param {Array<{x:number,y:number}>} cells  格子坐标（格子单位，非 mm）
 * @param {number} gs    每格尺寸（mm），例如 500
 * @param {number} ps    像素/mm 比例
 * @param {number} ox    SVG 原点 x（像素）
 * @param {number} oy    SVG 原点 y（像素）
 * @returns {string}  SVG path d 属性字符串（可能含多个子路径，对应孤立格团）
 */
export function computeRoomOutlinePath(cells, gs, ps, ox, oy) {
  if (!cells || cells.length === 0) return '';
 
  const cellSet = new Set(cells.map(c => `${c.x},${c.y}`));
  const scale = gs * ps;
 
  // 1. 收集所有外边（格子坐标系，端点为格子角点）
  //    约定：外边有方向，使外部区域在左侧（顺时针轮廓）
  const edgeMap = new Map(); // "x1,y1" → [{x,y}, ...]
 
  const addEdge = (x1, y1, x2, y2) => {
    const k = `${x1},${y1}`;
    if (!edgeMap.has(k)) edgeMap.set(k, []);
    edgeMap.get(k).push({ x: x2, y: y2 });
  };
 
  for (const { x, y } of cells) {
    if (!cellSet.has(`${x},${y - 1}`)) addEdge(x, y,     x + 1, y    ); // 上边 →
    if (!cellSet.has(`${x + 1},${y}`)) addEdge(x + 1, y, x + 1, y + 1); // 右边 ↓
    if (!cellSet.has(`${x},${y + 1}`)) addEdge(x + 1, y + 1, x, y + 1); // 下边 ←
    if (!cellSet.has(`${x - 1},${y}`)) addEdge(x, y + 1, x, y    ); // 左边 ↑
  }
 
  // 2. 沿边追踪多边形
  const usedStarts = new Set();
  const polygons = [];
 
  for (const startKey of edgeMap.keys()) {
    if (usedStarts.has(startKey)) continue;
    const poly = [];
    let [cx, cy] = startKey.split(',').map(Number);
    const firstKey = startKey;
 
    for (let guard = 0; guard < 10000; guard++) {
      const key = `${cx},${cy}`;
      const nexts = edgeMap.get(key);
      if (!nexts || nexts.length === 0) break;
      const next = nexts.shift(); // 消费该边，防止重复
      if (nexts.length === 0) edgeMap.delete(key);
      usedStarts.add(key);
      poly.push({ x: cx, y: cy });
      cx = next.x; cy = next.y;
      if (`${cx},${cy}` === firstKey) break;
    }
 
    if (poly.length >= 3) polygons.push(poly);
  }
 
  // 3. 转为 SVG path（像素坐标）
  return polygons.map(poly => {
    const pts = poly.map(p =>
      `${(ox + p.x * scale).toFixed(1)},${(oy + p.y * scale).toFixed(1)}`
    );
    return `M ${pts.join(' L ')} Z`;
  }).join(' ');
}
```
 
---
 
### 步骤 3：`renderHalf()` 改用轮廓路径
 
**文件**：`src/render/layout-svg.js:154-169`（`renderLayoutSVGDual` 内的 `renderHalf`）
 
```js
// 在 renderHalf 内，替换原来的 for 循环：
for (const [id, p] of Object.entries(placements || {})) {
  const def = ROOM_DEFS[id];
  if (!def) continue;
 
  if (p.cells && p.cells.length > 0 && p.gridSize) {
    // ── 新路径：用真实格子外轮廓渲染 ──
    const d = computeRoomOutlinePath(p.cells, p.gridSize, ps, ox, oy);
    if (!d) continue;
    if (def.isOpening) {
      s += `<path d="${d}" fill="#cde6f7" stroke="${def.strokeColor || '#2471a3'}" stroke-width="1" stroke-dasharray="3,2"/>`
      // 斜线装饰
      const rx = ox + p.x * ps, ry = oy + p.y * ps;
      const rw = p.w * ps, rd = p.d * ps;
      s += _l(rx, ry, rx + rw, ry + rd, '#aed6f1', 0.8);
      s += _l(rx + rw, ry, rx, ry + rd, '#aed6f1', 0.8);
    } else {
      s += `<path d="${d}" fill="${def.color}" stroke="${def.strokeColor || '#555'}" stroke-width="1"/>`;
    }
    // 标签：放在 bbox 中心（仍可用 p.x, p.w 等）
    const rw = p.w * ps, rd = p.d * ps;
    if (rw > 22 && rd > 16) {
      const cx = ox + (p.x + p.w / 2) * ps;
      const cy = oy + (p.y + p.d / 2) * ps;
      const labelSz = Math.max(7, Math.min(10, rw / (def.label.length * 0.7)));
      s += _t(cx, cy + 3, def.label.slice(0, Math.floor(rw / 7)), labelSz, '#2c3e50');
    }
  } else {
    // ── 旧路径（兜底）：用包围框矩形渲染 ──
    const rx = ox + p.x * ps, ry = oy + p.y * ps;
    const rw = p.w * ps, rd = p.d * ps;
    if (def.isOpening) {
      s += _r(rx, ry, rw, rd, '#cde6f7', def.strokeColor || '#2471a3', 1, 'stroke-dasharray="3,2"');
      s += _l(rx, ry, rx + rw, ry + rd, '#aed6f1', 0.8);
      s += _l(rx + rw, ry, rx, ry + rd, '#aed6f1', 0.8);
    } else {
      s += _r(rx, ry, rw, rd, def.color, def.strokeColor || '#555', 1);
    }
    if (rw > 22 && rd > 16) {
      const labelSz = Math.max(7, Math.min(10, rw / (def.label.length * 0.7)));
      s += _t(rx + rw / 2, ry + rd / 2 + 3, def.label.slice(0, Math.floor(rw / 7)), labelSz, '#2c3e50');
    }
  }
}
```
 
同样的修改也需应用到 `renderLayoutSVG()`（line 57-89），以保持缩略图与详图一致。
 
---
 
## 需要导入的函数
 
`layout-svg.js` 顶部的 import 需增加 `computeRoomOutlinePath`：
 
```js
// 修改前：
import { _r, _l, _t, _dh, _dv } from './svg-helpers.js'
// 修改后：
import { _r, _l, _t, _dh, _dv, computeRoomOutlinePath } from './svg-helpers.js'
```
 
---
 
## 验证方法
 
1. 生成多个变体方案，选取不同长宽比（R1.0 ~ R2.4）
2. 进入方案详图，对比左侧正式视图与右侧调试视图：
   - 正式视图中每个房间的轮廓形状应与调试视图中的格子分布完全对应
   - 两个房间之间不应出现颜色重叠
   - 所有格子均有颜色覆盖（无白色空洞，除 building 边框内空间全覆盖）
3. 重点检查小房间：`dock1`、`meter_main`、`meter_sub`、`fire_equip`、`dock2`
4. 检查地面层和一层均正常