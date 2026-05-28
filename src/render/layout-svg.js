import { ROOM_DEFS } from '../layout/model/room-defs.js'
import { _r, _l, _t, _dh, _dv, decomposeRoomIntoRects, calculateLabelPosition } from './svg-helpers.js'

const FONT = 'Microsoft YaHei,sans-serif';

// 检测两个bounding box是否重叠
function bboxesOverlap(p1, p2) {
  return !(p1.x + p1.w <= p2.x || p2.x + p2.w <= p1.x ||
           p1.y + p1.d <= p2.y || p2.y + p2.d <= p1.y);
}

// 计算面积
function getArea(p) {
  return p.w * p.d;
}

// 从大bbox中减去小bbox，返回多边形顶点或null（如果无法形成有效多边形）
function subtractBbox(larger, smaller) {
  const l = larger, s = smaller;
  if (!bboxesOverlap(l, s)) return null;

  const ox1 = Math.max(l.x, s.x);
  const oy1 = Math.max(l.y, s.y);
  const ox2 = Math.min(l.x + l.w, s.x + s.w);
  const oy2 = Math.min(l.y + l.d, s.y + s.d);

  if (ox2 <= ox1 || oy2 <= oy1) return null;

  const lx1 = l.x, ly1 = l.y, lx2 = l.x + l.w, ly2 = l.y + l.d;

  // 生成凹多边形顶点（逆时针）
  // 沿大矩形边界走，在遇到小矩形时绕过它
  const points = [];

  // 顶边（从左到右）
  points.push([lx1, ly1]);
  if (ox1 > lx1) points.push([ox1, ly1]); // 在小矩形左边
  points.push([ox1, oy1]); // 进入小矩形
  points.push([ox2, oy1]); // 穿过小矩形顶边
  if (ox2 < lx2) points.push([ox2, ly1]); // 小矩形右边
  points.push([lx2, ly1]); // 回到大矩形右上

  // 右边（从上到下）
  points.push([lx2, ly2]);

  // 底边（从右到左）
  if (ox2 < lx2) points.push([ox2, ly2]); // 小矩形右下方
  points.push([ox2, oy2]); // 进入小矩形
  points.push([ox1, oy2]); // 穿过小矩形底边
  if (ox1 > lx1) points.push([ox1, ly2]); // 小矩形左下方
  points.push([lx1, ly2]);

  // 左边（从下到上）
  points.push([lx1, ly1]); // 闭合

  return { type: 'polygon', points };
}

// 解决所有房间的重叠问题（从小到大递归处理）
function resolveOverlaps(placements) {
  if (!placements || Object.keys(placements).length === 0) {
    return {};
  }

  const entries = Object.entries(placements || {});
  const result = {};

  // 第一阶段：初始化所有房间形状为矩形
  for (const [id, p] of entries) {
    result[id] = { type: 'rect', ...p };
  }

  // 第二阶段：按面积从小到大排序
  const sortedByArea = entries.sort((a, b) => getArea(a[1]) - getArea(b[1]));

  // 第三阶段：从最小房间开始，递归处理与更大房间的冲突
  for (const [id, placement] of sortedByArea) {
    // 检查该房间是否与任何更大的房间重叠
    for (const [largerId, largerPlacement] of sortedByArea) {
      if (id === largerId) break; // 已经到达当前房间，之后都是更小的房间，停止

      const largerArea = getArea(largerPlacement);
      const currentArea = getArea(placement);

      // 只处理更大的房间与当前房间的重叠
      if (largerArea > currentArea && bboxesOverlap(largerPlacement, placement)) {
        // 从大房间的当前形状中减去小房间
        const largerCurrentShape = result[largerId];
        const subtracted = subtractBboxFromShape(largerCurrentShape, placement);

        if (subtracted) {
          result[largerId] = subtracted;
        }
      }
    }
  }

  return result;
}

// 从任意形状（矩形或多边形）中减去一个bounding box
function subtractBboxFromShape(shape, smallerBbox) {
  if (shape.type === 'rect') {
    // 从矩形中减去bbox
    return subtractBbox(shape, smallerBbox);
  } else if (shape.type === 'polygon') {
    // 从多边形中减去bbox - 这里简化处理，只对矩形bbox进行减法
    // 实际的多边形布尔运算会很复杂，这里保持多边形不变
    // （因为已经被减过一次，再减更小的房间概率较低）
    return shape;
  }
  return shape;
}

export function renderLayoutSVG(variant, floor, vw, vh, opts = {}) {
  const { showDims = true, showCrane = true } = opts;
  const { groundPlacements, level1Placements, buildingW, buildingD, crane15, crane5 } = variant;
  const placements = floor === 'level1' ? level1Placements : groundPlacements;
  const crane = floor === 'level1' ? crane5 : crane15;

  const MARGIN = { top: 48, right: 48, bottom: 48, left: 56 };
  const drawW = vw - MARGIN.left - MARGIN.right;
  const drawH = vh - MARGIN.top - MARGIN.bottom;
  const ps = Math.min(drawW / buildingW, drawH / buildingD);
  const ox = MARGIN.left + (drawW - buildingW * ps) / 2;
  const oy = MARGIN.top  + (drawH - buildingD * ps) / 2;

  let s = _r(0, 0, vw, vh, '#f4f6f8', 'none');
  s += _r(ox, oy, buildingW * ps, buildingD * ps, '#ffffff', '#2c3e50', 2.5);

  if (showCrane && crane) {
      s += _r(ox + crane.x * ps, oy + crane.y * ps, crane.w * ps, crane.d * ps,
        'rgba(255,193,7,0.08)', '#f0a500', 1.5, 'stroke-dasharray="6,3"');
  }

  const resolvedShapes = resolveOverlaps(placements || {});

  for (const [id, shape] of Object.entries(resolvedShapes || {})) {
    const def = ROOM_DEFS[id];
    if (!def) continue;

    const p = placements[id];
    const rx = ox + p.x * ps, ry = oy + p.y * ps, rw = p.w * ps, rd = p.d * ps;

    if (def.isOpening) {
      s += _r(rx, ry, rw, rd, '#cde6f7', def.strokeColor || '#2471a3', 1.5, 'stroke-dasharray="4,2"');
    } else if (shape.type === 'polygon') {
      const points = shape.points.map(([x, y]) => `${ox + x * ps},${oy + y * ps}`).join(' ');
      s += `<polygon points="${points}" fill="${def.color}" stroke="${def.strokeColor || '#555'}" stroke-width="1.5"/>`;
    } else {
      s += _r(rx, ry, rw, rd, def.color, def.strokeColor || '#555', 1.5);
    }

    const labelSz = Math.max(7, Math.min(10, rw / (def.label.length * 0.7)));
    s += _t(rx + rw/2, ry + rd/2, def.label, labelSz, '#2c3e50');
  }

  if (showDims) {
    const bx1 = ox, bx2 = ox + buildingW * ps;
    const by1 = oy, by2 = oy + buildingD * ps;
    s += _dh(bx1, bx2, by2 + 30, `总宽 ${(buildingW / 1000).toFixed(1)} m`, '#1a3a5c');
    s += _dv(bx1 - 36, by1, by2, `总深 ${(buildingD / 1000).toFixed(1)} m`, '#1a3a5c');
  }

  const floorLabel = floor === 'level1' ? '一层平面' : '地面层平面';
  s += _t(vw / 2, MARGIN.top - 14, floorLabel, 13, '#1a5276', 'middle', 'bold');

  return s;
}

/**
 * Render a dual-floor overview (ground + level1 side by side) for the detail view.
 */
export function renderLayoutSVGDual(variant, vw, vh) {
  const { groundPlacements, level1Placements, buildingW, buildingD, crane15, crane5 } = variant;
  const halfW = Math.floor(vw / 2) - 8

  const MARGIN = { top: 48, right: 32, bottom: 48, left: 44 }
  const drawW = halfW - MARGIN.left - MARGIN.right
  const drawH = vh   - MARGIN.top  - MARGIN.bottom
  const ps    = Math.min(drawW / buildingW, drawH / buildingD)

  const renderHalf = (placements, offsetX, floorLabel, crane) => {
    console.log(`Rendering floor: ${floorLabel}`, placements); // Debug log
    const ox = offsetX + MARGIN.left + (drawW - buildingW * ps) / 2
    const oy = MARGIN.top + (drawH - buildingD * ps) / 2
    let s = ''

    s += _r(ox, oy, buildingW * ps, buildingD * ps, '#ffffff', '#2c3e50', 2)

    // Crane
    if (crane) {
      s += _r(ox + crane.x * ps, oy + crane.y * ps, crane.w * ps, crane.d * ps,
        'rgba(255,193,7,0.08)', '#f0a500', 1.2, 'stroke-dasharray="5,3"')
    }

    const resolvedShapes = resolveOverlaps(placements || {});

    for (const [id, shape] of Object.entries(resolvedShapes || {})) {
        const def = ROOM_DEFS[id];
        if (!def) continue;
        const p = placements[id];

        if (p.cells && p.gridSize) {
            const rects = decomposeRoomIntoRects(p.cells);
            let pathData = '';
            for (const r of rects) {
                const rx_cell = ox + r.x * p.gridSize * ps;
                const ry_cell = oy + r.y * p.gridSize * ps;
                const rw_cell = r.w * p.gridSize * ps;
                const rh_cell = r.h * p.gridSize * ps;
                pathData += `M ${rx_cell} ${ry_cell} h ${rw_cell} v ${rh_cell} h ${-rw_cell} Z `;
            }

            if (def.isOpening) {
                s += `<path d="${pathData}" fill="#cde6f7" stroke="${def.strokeColor || '#2471a3'}" stroke-width="1" stroke-dasharray="3,2"/>`;
                const rx = ox + p.x * ps, ry = oy + p.y * ps, rw = p.w * ps, rd = p.d * ps;
                s += _l(rx, ry, rx + rw, ry + rd, '#aed6f1', 0.8);
                s += _l(rx + rw, ry, rx, ry + rd, '#aed6f1', 0.8);
            } else {
                s += `<path d="${pathData}" fill="${def.color}" stroke="${def.strokeColor || '#555'}" stroke-width="1"/>`;
            }
        } else {
            // Fallback to bounding box
            const rx = ox + p.x * ps, ry = oy + p.y * ps, rw = p.w * ps, rd = p.d * ps;
            if (def.isOpening) {
                s += _r(rx, ry, rw, rd, '#cde6f7', def.strokeColor || '#2471a3', 1, 'stroke-dasharray="3,2"');
                s += _l(rx, ry, rx + rw, ry + rd, '#aed6f1', 0.8);
                s += _l(rx + rw, ry, rx, ry + rd, '#aed6f1', 0.8);
            } else if (shape.type === 'polygon') {
                const points = shape.points.map(([x, y]) => `${ox + x * ps},${oy + y * ps}`).join(' ');
                s += `<polygon points="${points}" fill="${def.color}" stroke="${def.strokeColor || '#555'}" stroke-width="1"/>`;
            } else {
                s += _r(rx, ry, rw, rd, def.color, def.strokeColor || '#555', 1);
            }
        }

        // Labels
        const debugInfo = variant._debug && variant._debug[floorLabel === '地面层平面' ? 'ground' : 'level1'];
        const cells = debugInfo && debugInfo.grid && debugInfo.grid.roomData[id];
        const rw = p.w * ps, rd = p.d * ps;

        if (rw > 22 && rd > 16) {
            let cx = ox + (p.x + p.w / 2) * ps;
            let cy = oy + (p.y + p.d / 2) * ps + 3;

            if (cells && p.gridSize) {
                const labelPos = calculateLabelPosition(cells);
                cx = ox + labelPos.x * p.gridSize * ps;
                cy = oy + labelPos.y * p.gridSize * ps + 3;
            }

            const labelSz = Math.max(7, Math.min(10, rw / (def.label.length * 0.7)));
            s += _t(cx, cy, def.label.slice(0, Math.floor(rw / 7)), labelSz, '#2c3e50');
        }
    }

    // Doors for this floor
    const floorDoors = (variant.doors || []).filter(d => {
        const room = placements[d.rooms[0]] || placements[d.rooms[1]];
        return !!room;
    });

    for (const door of floorDoors) {
        const doorW = door.w === 0 ? 3 : door.w * ps;
        const doorH = door.d === 0 ? 3 : door.d * ps;
        const doorX = ox + (door.x * ps) - (doorW/2);
        const doorY = oy + (door.y * ps) - (doorH/2);
        s += _r(doorX, doorY, doorW, doorH, '#d35400', 'none');
    }

    // Floor label
    s += _t(offsetX + halfW / 2, MARGIN.top - 16, floorLabel, 12, '#1a5276', 'middle', 'bold')

    // Dim
    const bx1 = ox, bx2 = ox + buildingW * ps
    const by1 = oy, by2 = oy + buildingD * ps
    s += _dh(bx1, bx2, by2 + 28, `${(buildingW / 1000).toFixed(1)}m`, '#1a3a5c')
    s += _dv(bx1 - 30, by1, by2, `${(buildingD / 1000).toFixed(1)}m`, '#1a3a5c')

    return s
  }

  let s = _r(0, 0, vw, vh, '#f4f6f8', 'none')
  s += renderHalf(groundPlacements, 0,      '地面层平面', crane15)
  s += renderHalf(level1Placements, halfW + 16, '一层平面',   crane5)

  // Divider
  s += _l(halfW + 8, 20, halfW + 8, vh - 20, '#ccc', 1, '5,3')

  return s
}
