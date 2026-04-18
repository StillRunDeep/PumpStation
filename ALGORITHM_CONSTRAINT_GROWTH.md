# 约束生长算法 (Constraint Growth Algorithm)

**文件**: `src/layout/layout-generator.js`  
**关键函数**: `generateLayoutVariants()`  
**算法分类**: 多阶段随机约束优化

---

## 高级概述

约束生长算法通过三个阶段逐步在网格上放置房间，每个阶段应用不同的约束集合：

```
┌─ Phase 1: 种子放置 (Seed Placement)
│  ├─ 目标: 在网格上放置所有房间的初始"种子"位置
│  ├─ 约束: ADJACENCY_MUST (相邻关系) + EXT_ACCESS (外墙约束)
│  ├─ 方法: 优先级队列 + 权重采样
│  └─ 输出: 9 个可行的初始配置
│
├─ Phase 2: L/U 扩展 (Polygon Expansion)
│  ├─ 目标: 从种子向外扩展房间，满足面积目标
│  ├─ 约束: 保持 ADJACENCY_MUST，避免碰撞
│  ├─ 方法: 迭代边界扩展（L 形或 U 形增长）
│  ├─ 迭代数: 5000 次/方案 × 9 方案 = 45000 次
│  └─ 输出: 9 个更接近目标面积的配置
│
└─ Phase 3: 填充空隙 (Gap Filling)
   ├─ 目标: 优化房间形状，移除孤立的空白区域
   ├─ 约束: 保持相邻性和外墙约束
   ├─ 方法: 贪心扩展，优先向邻接边界扩展
   └─ 输出: 9 个最终方案，交由 Checkpoint A/B/C 评分
```

---

## 数据结构

### Grid 类
```
class Grid {
  grid[height][width]     // 2D 数组，每个单元格存储 roomId (或 0 表示空)
  roomData[roomId]        // { x, y } 数组，记录该房间占据的所有格子
  bboxes[roomId]          // { minX, minY, maxX, maxY }，包围盒缓存（O(1)查询）
}

Grid.CELL_SIZE = 500mm    // 单位: 500mm × 500mm
```

### Room 定义
```
ROOM_DEFS[roomId] = {
  id: string
  targetGridCount: number   // 目标格子数 (≈目标面积)
  constraints: [
    'ext_access'            // 必须接触非南面外墙
    'must_adjacent:[roomId]' // 必须与指定房间相邻
  ]
}
```

### Seed 对象
```
placedSeeds[roomId] = {
  x: number     // 种子中心格子 X 坐标
  y: number     // 种子中心格子 Y 坐标
}
```

---

## Phase 1: 种子放置 (Seed Placement)

### 算法流程
```
Algorithm PlaceRoomSeeds(rooms[], rng):
  Input: 待放置房间列表，随机数生成器
  Output: placedSeeds[roomId] = {x, y}

  placedSeeds ← {}
  roomsToPlace ← rooms[]
  
  while roomsToPlace.length > 0 and rounds < MAX_ROUNDS:
    for each room in roomsToPlace:
      // 检查 MUST 邻接前置条件
      if not all(MUST partners are in placedSeeds):
        skip this room (defer to next round)
      
      // 生成权重图
      weightMap ← generateWeightMapForRoom(grid, room, placedSeeds)
      
      // 采样初始位置
      position ← samplePositionFromWeightMap(weightMap, rng)
      
      // 尝试放置（如果合法）
      if canPlace(room, position, grid, constraints):
        placeRoom(room, position, grid)
        placedSeeds[room.id] ← position
        roomsToPlace.remove(room)
        placedInRound ← true
      else:
        remainingRooms.push(room)  // 推迟到下一轮
    
    rooms ← remainingRooms
    rounds++
  
  return placedSeeds
```

### 权重图生成 (generateWeightMapForRoom)

权重图是一个 height × width 的浮点数数组，表示每个格子位置的"吸引力"。采样时以权重概率选择。

```
Algorithm GenerateWeightMapForRoom(room, placedSeeds):
  weightMap ← Array(height).fill(1)  // 初始化为 1（均匀）
  
  // Rule 1: 外墙约束加权
  if room has 'ext_access' constraint:
    for each boundary cell (north, west, east):
      weightMap[cell] *= 10  // 10 倍权重偏向外墙
  
  // Rule 2: 相邻约束加权
  for each MUST partner in ADJACENCY_MUST:
    if partner is already placed:
      partner_x, partner_y ← placedSeeds[partner]
      // 在伙伴周围 3×3 网格单位（1500mm）范围内加权
      for each cell in (x±3, y±3) around partner:
        weightMap[cell] *= 50  // 50 倍权重靠近伙伴
  
  return weightMap
```

### 采样策略
- **加权随机采样**: 从权重图中按概率采样有效位置
- **重试机制**: 若采样位置非法，重试最多 200 次
- **后备方案**: 若无有效位置，标记为"延迟放置"，下一轮重试

### 关键参数
| 参数 | 值 | 说明 |
|------|-----|------|
| MAX_PLACEMENT_ROUNDS | rooms.length × 2 | 最多轮数，避免死锁 |
| 相邻权重倍数 | 50 | MUST 伙伴周围的权重倍增 |
| 外墙权重倍数 | 10 | 外墙附近的权重倍增 |
| 采样重试次数 | 200 | 单次放置的最大尝试次数 |

---

## Phase 2: L/U 扩展 (Polygon Expansion)

### 目标
从种子位置向外扩展房间，使其逼近目标面积（targetGridCount）。

### 算法流程
```
Algorithm ExpandPolygons(grid, placedSeeds, targetAreas, rng):
  Input: 初始网格（包含种子）、目标面积字典
  Output: 扩展后的网格
  
  for iteration = 1 to MAX_EXPANSION_ITERATIONS:
    // 优先级排序：选择与目标最远的房间优先扩展
    room ← selectRoomFarthestFromTarget(grid, targetAreas)
    
    // 计算边界（与空白相邻的格子）
    boundary ← getBoundary(room, grid)
    
    // 候选扩展格子：边界周围的空白格子
    candidates ← []
    for each boundary_cell:
      for each neighbor in (4-connectivity):
        if grid[neighbor] == 0 and neighbor not in candidates:
          candidates.push(neighbor)
    
    // 评估候选并选择最优扩展格子
    best_cell ← selectExpansionCell(candidates, room, grid, placedSeeds)
    
    if best_cell exists:
      // 检查约束（MUST 邻接、EXT_ACCESS）
      if isLegalExpansion(best_cell, room, grid, constraints):
        grid.addRoomCell(room, best_cell.x, best_cell.y)
    else:
      // 无法继续扩展，标记为"已停滞"
      room.stalled ← true

  return grid
```

### 扩展格子选择标准
优先级顺序：
1. **邻接推力**: 靠近 MUST 伙伴的候选加权 ×5
2. **距离衡量**: 选择使房间重心向外移动的格子（避免"螺旋"）
3. **随机破局**: 同分候选中随机选择（增加多样性）

### 停滞检测
- 若连续 50 次迭代无有效扩展，房间标记为"完成"
- 若所有房间都已完成，Phase 2 提前结束

### 关键参数
| 参数 | 值 | 说明 |
|------|-----|------|
| MAX_EXPANSION_ITERATIONS | 5000 | 每个方案的最大迭代次数 |
| 邻接推力倍数 | 5 | 靠近 MUST 伙伴时的权重倍增 |
| 停滞阈值 | 50 | 连续无进展的迭代数 |

---

## Phase 3: 填充空隙 (Gap Filling)

### 目标
消除房间内的孤立空洞（actualArea < bboxArea）。

### 算法流程
```
Algorithm FillGaps(grid):
  Input: Phase 2 的扩展网格
  Output: 更紧凑的房间形状
  
  for each room:
    while true:
      bbox ← getBoundingBox(room, grid)
      // 查找 bbox 内的空白格子
      holes ← findHolesWithinBbox(room, bbox, grid)
      
      if holes.length == 0:
        break  // 无更多空洞
      
      // 贪心填充：优先填充与房间边界接触最多的空洞
      hole ← holes.sort(by adjacencyCount).first()
      
      // 检查约束：填充是否会违反邻接关系或形状约束？
      if isLegalToFill(hole, room, grid, constraints):
        grid.addRoomCell(room, hole.x, hole.y)
      else:
        break
```

### 空洞检测
- 空洞定义: bbox 内的格子 grid[x][y] == 0（且未被其他房间占据）
- 邻接性: 计算空洞与房间边界相邻的边数（4-connectivity）

---

## Checkpoint A/B/C 评分集成

Phase 1 → Phase 2 → Phase 3 完成后，每个方案通过以下评分checkpoint：

### Checkpoint A (Phase 1 后)
**时机**: Phase 1 种子放置完成立即评分  
**用途**: 早期筛选，排除不可行的配置  
**指标**:
- 所有必需房间是否存在
- MUST 约束满足率
- EXT_ACCESS 约束满足率

**通过条件**: 得分 ≥ 0（所有红线约束均满足）

### Checkpoint B (Phase 2 后)
**时机**: Phase 2 L/U 扩展完成评分  
**用途**: 排名 9 个方案，选择最优 3～6 个继续优化  
**指标**:
- Checkpoint A 的所有指标
- 空间效率 (functional area / building area)
- 形状质量 (aspect ratio, utilization, vertex count)

### Checkpoint C (Phase 3 后)
**时机**: Phase 3 填充空隙完成最终评分  
**用途**: 最终排名和展示  
**指标**:
- 所有 Tier 1 + Tier 2 指标
- 优化项: 成长顺利度、相邻关系质量、走廊完整性

---

## 缓存和性能优化

### 缓存策略
```
1. bboxes[roomId] ← { minX, minY, maxX, maxY }
   • 每次 addRoomCell 时增量更新
   • 查询时 O(1)
   
2. boundary[roomId] ← 与空白相邻的边界格子集合
   • Phase 2 开始前计算一次
   • 扩展后增量更新边界
   
3. weightMap ← 房间放置的权重图
   • 每轮种子放置时重新计算
   • 避免重复的权重采样开销
```

### 性能指标（目标）
| 操作 | 当前耗时 | 目标 | 优化策略 |
|------|---------|------|--------|
| Phase 1 种子放置 | 200ms | 100ms | 并行化采样，减少权重图重计算 |
| Phase 2 L/U 扩展 | 25s | 10s | Web Worker 并行处理 9 方案 |
| Phase 3 填充空隙 | 3s | 1s | KD-树加速邻接查询 |
| **总计** | **28.2s** | **11s** | **3 倍加速** |

---

## 约束详解

### ADJACENCY_MUST
```
meter_main ↔ meter_sub   // 水表房并排，共用外墙
trafo1 ↔ trafo2          // 变压器相邻（共享侧墙）
parking ↔ repair_zone    // 停车区与检修区相邻（b803908）
```

**强制程度**: 违规导致方案通不过 Checkpoint A（扣 500 分）

### EXT_ACCESS (外墙约束)
```
应施加 EXT_ACCESS 的房间:
- trafo1, trafo2         // 大容量变压器需外部散热
- meter_main, meter_sub  // 水表需外部读表
- fire_equip             // 消防设备需外部访问
```

**实现方式**: 这些房间的边界至少 1 个格子接触非南面外墙

---

## 调试指南

### 启用调试日志
```javascript
const DEBUG_LAYOUT = true;  // 在 layout-generator.js 第 18 行
```

输出内容:
- 每轮种子放置的成功/失败
- Phase 2 的每次扩展（位置、新格子数）
- Phase 3 的空隙填充进度

### 常见问题排查

**问题**: Phase 1 无法放置所有房间
- **原因**: ADJACENCY_MUST 约束冲突（死锁）
- **排查**: 检查 ADJACENCY_MUST 是否存在循环依赖
- **修复**: 调整 generateWeightMapForRoom 的权重倍数

**问题**: Phase 2 扩展停滞，房间未达目标面积
- **原因**: 房间被其他房间"困住"，无法继续扩展
- **排查**: 检查初始 Phase 1 的种子位置是否太密集
- **修复**: 增加种子放置时的相邻权重，拉开间距

**问题**: Checkpoint A 通过率下降
- **原因**: 参数调整（如 aspectRatioPenalty）过度严苛
- **排查**: 运行 CODE_REVIEW_b803908.md 中的验证用例
- **修复**: 调整 scorer-params.js 的参数，或松动约束

---

## 参考文献

- **文件**: `/02模块设计/AG4建筑平面布局4_评价.md` (v1.8+)
- **评分规则**: `/src/layout/scorer.js`
- **约束定义**: `/src/layout/adjacency.js`, `/src/layout/room-defs.js`
