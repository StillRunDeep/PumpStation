import { ROOM_DEFS } from '../layout/room-defs.js'
import { _r, _l, _t, _dh, _dv, decomposeRoomIntoRects, calculateLabelPosition } from './svg-helpers.js'

const FONT = 'Microsoft YaHei,sans-serif'

/**
 * Render a building layout variant as an SVG string.
 *
 * @param {object}  variant     Result from runAG41() (has .template, .groundPlacements, .level1Placements)
 * @param {number}  vw          SVG canvas width (px)
 * @param {number}  vh          SVG canvas height (px)
 * @param {object}  opts
 * @param {boolean} opts.showDims     Draw dimension annotations
 * @param {'ground'|'level1'|'both'} opts.floor  Which floor(s) to show
 * @param {boolean} opts.showCrane    Draw crane coverage dashed box
 */
export function renderLayoutSVG(variant, vw, vh, opts = {}) {
  const { showDims = true, floor = 'ground', showCrane = true } = opts
  const { groundPlacements, level1Placements, buildingW, buildingD, crane15, crane5 } = variant;
  const placements = floor === 'level1' ? level1Placements : groundPlacements;

  const MARGIN = { top: 48, right: 48, bottom: 48, left: 56 }
  const drawW = vw - MARGIN.left - MARGIN.right
  const drawH = vh - MARGIN.top  - MARGIN.bottom

  // Scale to fit: px per mm
  const ps = Math.min(drawW / buildingW, drawH / buildingD)

  // Origin (NW corner of building in SVG px)
  const ox = MARGIN.left  + (drawW - buildingW * ps) / 2
  const oy = MARGIN.top   + (drawH - buildingD * ps) / 2

  let s = _r(0, 0, vw, vh, '#f4f6f8', 'none')

  // Building background
  s += _r(ox, oy, buildingW * ps, buildingD * ps, '#ffffff', '#2c3e50', 2.5)

  // Crane coverage box
  if (showCrane) {
    const showCrane15 = floor === 'ground'
    const showCrane5  = floor === 'level1'
    if (showCrane15 && crane15) {
      const c = crane15
      s += _r(ox + c.x * ps, oy + c.y * ps, c.w * ps, c.d * ps,
        'rgba(255,193,7,0.08)', '#f0a500', 1.5, 'stroke-dasharray="6,3"')
      s += _t(ox + c.x * ps + 6, oy + c.y * ps + 14, '15t 桥吊覆盖', 10, '#b7770d', 'start')
    }
    if (showCrane5 && crane5) {
      const c = crane5
      s += _r(ox + c.x * ps, oy + c.y * ps, c.w * ps, c.d * ps,
        'rgba(100,149,237,0.08)', '#5b8dd9', 1.5, 'stroke-dasharray="6,3"')
      s += _t(ox + c.x * ps + 6, oy + c.y * ps + 14, '5t 单轨吊覆盖', 10, '#2e5ca8', 'start')
    }
  }

  // Rooms
  for (const [id, p] of Object.entries(placements || {})) {
    const def = ROOM_DEFS[id]
    if (!def) continue

    if (p.cells && p.gridSize) {
        const rects = decomposeRoomIntoRects(p.cells);
        let pathData = '';
        for (const r of rects) {
            const rx = ox + r.x * p.gridSize * ps;
            const ry = oy + r.y * p.gridSize * ps;
            const rw = r.w * p.gridSize * ps;
            const rh = r.h * p.gridSize * ps;
            pathData += `M ${rx} ${ry} h ${rw} v ${rh} h ${-rw} Z `;
        }

        if (def.isOpening) {
            s += `<path d="${pathData}" fill="#cde6f7" stroke="${def.strokeColor || '#2471a3'}" stroke-width="1.5" stroke-dasharray="4,2"/>`;
            const rx = ox + p.x * ps, ry = oy + p.y * ps, rw = p.w * ps, rd = p.d * ps;
            s += _l(rx, ry, rx + rw, ry + rd, '#aed6f1', 1);
            s += _l(rx + rw, ry, rx, ry + rd, '#aed6f1', 1);
        } else {
            s += `<path d="${pathData}" fill="${def.color}" stroke="${def.strokeColor || '#555'}" stroke-width="1.5"/>`;
        }
    } else {
        // Fallback to bounding box
        const rx = ox + p.x * ps, ry = oy + p.y * ps, rw = p.w * ps, rd = p.d * ps;
        if (def.isOpening) {
          s += _r(rx, ry, rw, rd, '#cde6f7', def.strokeColor || '#2471a3', 1.5, 'stroke-dasharray="4,2"');
          s += _l(rx, ry, rx + rw, ry + rd, '#aed6f1', 1);
          s += _l(rx + rw, ry, rx, ry + rd, '#aed6f1', 1);
        } else {
          s += _r(rx, ry, rw, rd, def.color, def.strokeColor || '#555', 1.5);
        }
    }

    // Labels
    const debugInfo = variant._debug && variant._debug[floor];
    const cells = debugInfo && debugInfo.grid && debugInfo.grid.roomData[id];
    const rw = p.w * ps, rd = p.d * ps;

    if (rw > 30 && rd > 20) {
      let cx = ox + (p.x + p.w / 2) * ps;
      let cy = oy + (p.y + p.d / 2) * ps;

      if (cells) {
        const labelPos = calculateLabelPosition(cells);
        cx = ox + labelPos.x * p.gridSize * ps;
        cy = oy + labelPos.y * p.gridSize * ps;
      }

      const maxChars = Math.floor(rw / 7)
      const shortLabel = def.label.length > maxChars ? def.label.slice(0, maxChars - 1) + '…' : def.label
      const labelSz = Math.max(8, Math.min(11, rw / (def.label.length * 0.65)))
      const dimSz   = Math.max(7, Math.min(9, rw / 14))

      s += _t(cx, cy - (rd > 30 ? 5 : 0), shortLabel, labelSz, '#2c3e50')
      if (rd > 30) {
        s += _t(cx, cy + 9, `${(p.w / 1000).toFixed(1)}×${(p.d / 1000).toFixed(1)}m`, dimSz, '#666')
      }
    }
  }

  // Doors
  if (variant.doors) {
    for (const door of variant.doors) {
      const doorW = door.w === 0 ? 4 : door.w * ps;
      const doorH = door.d === 0 ? 4 : door.d * ps;
      const doorX = ox + (door.x * ps) - (doorW/2);
      const doorY = oy + (door.y * ps) - (doorH/2);
      s += _r(doorX, doorY, doorW, doorH, '#e67e22', 'none');
    }
  }

  // Overall dimension annotations
  if (showDims) {
    const bx1 = ox, bx2 = ox + buildingW * ps
    const by1 = oy, by2 = oy + buildingD * ps

    s += _dh(bx1, bx2, by2 + 30,
      `总宽 ${(buildingW / 1000).toFixed(1)} m`, '#1a3a5c')
    s += _dv(bx1 - 36, by1, by2,
      `总深 ${(buildingD / 1000).toFixed(1)} m`, '#1a3a5c')
  }

  // Floor label
  const floorLabel = floor === 'level1' ? '一层平面' : '地面层平面'
  s += _t(vw / 2, MARGIN.top - 14, floorLabel, 13, '#1a5276', 'middle', 'bold')

  // Scale bar (1 m)
  const barLen = ps * 1000  // 1000 mm = 1 m
  const barX = ox, barY = oy + buildingD * ps + 14
  s += _l(barX, barY, barX + barLen, barY, '#333', 2)
  s += _l(barX, barY - 4, barX, barY + 4, '#333', 1.5)
  s += _l(barX + barLen, barY - 4, barX + barLen, barY + 4, '#333', 1.5)
  s += _t(barX + barLen / 2, barY - 5, '1 m', 10, '#333')

  return s
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

    for (const [id, p] of Object.entries(placements || {})) {
        const def = ROOM_DEFS[id];
        if (!def) continue;

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
