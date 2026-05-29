import { ROOM_DEFS } from '../layout/model/room-defs.js';

// SVG string-building helpers (coordinate-system agnostic)

export function _r(x, y, w, h, fill, stroke, sw = 1, extra = '') {
  const safeH = Math.max(0, h)
  return `<rect x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" width="${(+w).toFixed(1)}" height="${safeH.toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" ${extra}/>`
}

export function _l(x1, y1, x2, y2, stroke, sw = 1, dash = '') {
  return `<line x1="${(+x1).toFixed(1)}" y1="${(+y1).toFixed(1)}" x2="${(+x2).toFixed(1)}" y2="${(+y2).toFixed(1)}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
}

export function _t(x, y, txt, sz, fill, anchor = 'middle', weight = 'normal') {
  return `<text x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" font-size="${sz}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}" font-family="Microsoft YaHei,sans-serif">${txt}</text>`
}

export function _poly(pts, fill) {
  return `<polygon points="${pts}" fill="${fill}"/>`
}

// Horizontal dimension line with arrows and label
export function _dh(x1, x2, y, label, clr) {
  const tk = 8, as = 6
  x1 = +x1; x2 = +x2; y = +y
  const mid = (x1 + x2) / 2
  return [
    _l(x1, y - tk, x1, y + tk, clr),
    _l(x2, y - tk, x2, y + tk, clr),
    _l(x1, y, x2, y, clr),
    _poly(`${x1},${y} ${x1 + as},${y - as / 2} ${x1 + as},${y + as / 2}`, clr),
    _poly(`${x2},${y} ${x2 - as},${y - as / 2} ${x2 - as},${y + as / 2}`, clr),
    _t(mid, y - 6, label, 11, clr),
  ].join('')
}

function _c(cx, cy, r, fill) {
  return `<circle cx="${(+cx).toFixed(1)}" cy="${(+cy).toFixed(1)}" r="${r}" fill="${fill}"/>`
}

export function renderDebugGrid(debugData, width, height) {
  if (!debugData) return '';

  const { grid, seeds, seedsMeta, movementHints } = debugData;
  const gridW = grid.width;
  const gridH = grid.height;

  // Fit grid into the container
  const cellSize = Math.min(width / gridW, height / gridH);
  const ox = (width - gridW * cellSize) / 2;
  const oy = (height - gridH * cellSize) / 2;

  let s = `<svg width="${width}" height="${height}" style="font-family: monospace; font-size: 10px;">`;
  s += _r(0, 0, width, height, '#f9f9f9', 'none');

  // Cell colors based on room ID
  const colors = {};
  const FgColors = {};
  const roomIds = Object.keys(grid.roomData);
  roomIds.forEach((id, i) => {
    // Simple hashing for stable colors
    let hash = 0;
    for (let j = 0; j < id.length; j++) {
      hash = id.charCodeAt(j) + ((hash << 5) - hash);
    }
    const hue = hash % 360;
    colors[id] = ROOM_DEFS[id]?.color || `hsl(${hue}, 70%, 85%)`;
    FgColors[id] = `hsl(${hue}, 70%, 35%)`;
  });

  // Draw grid cells
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const roomId = grid.getCell(x, y);
      const fill = roomId ? colors[roomId] : '#fff';
      s += _r(ox + x * cellSize, oy + y * cellSize, cellSize, cellSize, fill, '#e0e0e0', 0.5);
    }
  }

  // Draw bold room outlines
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const roomId = grid.getCell(x, y);
      if (!roomId) continue;

      const top    = grid.getCell(x, y - 1);
      const bottom = grid.getCell(x, y + 1);
      const left   = grid.getCell(x - 1, y);
      const right  = grid.getCell(x + 1, y);

      const strokeColor = FgColors[roomId] || '#555';
      const sw = 0.5;

      const x1 = ox + x * cellSize, x2 = x1 + cellSize;
      const y1 = oy + y * cellSize, y2 = y1 + cellSize;

      if (top !== roomId)    s += _l(x1, y1, x2, y1, strokeColor, sw);
      if (bottom !== roomId) s += _l(x1, y2, x2, y2, strokeColor, sw);
      if (left !== roomId)   s += _l(x1, y1, x1, y2, strokeColor, sw);
      if (right !== roomId)  s += _l(x2, y1, x2, y2, strokeColor, sw);
    }
  }

  // Draw seeds on top
  if (seeds) {
    // seedsMeta layer: grey parent dot + red arrow for actually-replaced seeds (temporarily disabled)
    // if (seedsMeta) { ... }
    // movementHints layer: orange arrow showing potential movement targets
    if (movementHints) {
      for (const [id, hint] of Object.entries(movementHints)) {
        if (!hint.from || !hint.to) continue;
        const fx = ox + (hint.from.x + 0.5) * cellSize;
        const fy = oy + (hint.from.y + 0.5) * cellSize;
        const tx = ox + (hint.to.x + 0.5) * cellSize;
        const ty = oy + (hint.to.y + 0.5) * cellSize;
        s += _l(fx, fy, tx, ty, '#e67e22', 1.5, '4 2');
        s += _c(tx, ty, cellSize * 0.25, '#e67e22');
      }
    }
    // Child seed circles
    for (const [id, pos] of Object.entries(seeds)) {
      const cx = ox + (pos.x + 0.5) * cellSize;
      const cy = oy + (pos.y + 0.5) * cellSize;
      const replaced = seedsMeta?.[id]?.replaced;
      const fill = replaced ? '#e74c3c' : (FgColors[id] || '#c0392b');
      s += _c(cx, cy, cellSize * 0.3, fill);
      s += _t(cx, cy + 2, id.slice(0,3), 8, '#fff');
    }
  }

  s += '</svg>';
  return s;
}

// Vertical dimension line with arrows and label
export function _dv(x, y1, y2, label, clr) {
  const tk = 8, as = 6
  x = +x; y1 = +y1; y2 = +y2
  const mid = (y1 + y2) / 2, lx = x + 20
  return [
    _l(x - tk, y1, x + tk, y1, clr),
    _l(x - tk, y2, x + tk, y2, clr),
    _l(x, y1, x, y2, clr),
    _poly(`${x},${y1} ${x - as / 2},${y1 + as} ${x + as / 2},${y1 + as}`, clr),
    _poly(`${x},${y2} ${x - as / 2},${y2 - as} ${x + as / 2},${y2 - as}`, clr),
    `<text transform="translate(${lx.toFixed(1)},${mid.toFixed(1)}) rotate(-90)" font-size="11" fill="${clr}" text-anchor="middle" font-family="Microsoft YaHei,sans-serif">${label}</text>`,
  ].join('')
}

export function decomposeRoomIntoRects(cells) {
    if (!cells || cells.length === 0) return [];

    const cellSet = new Set(cells.map(c => `${c.x},${c.y}`));
    const rects = [];

    while (cellSet.size > 0) {
        const startCell = [...cellSet].reduce((a, b) => {
            const [ax, ay] = a.split(',').map(Number);
            const [bx, by] = b.split(',').map(Number);
            return (ay < by || (ay === by && ax < bx)) ? a : b;
        });

        const [startX, startY] = startCell.split(',').map(Number);

        let width = 1;
        while (cellSet.has(`${startX + width},${startY}`)) {
            width++;
        }

        let height = 1;
        let canExtend = true;
        while (canExtend) {
            for (let i = 0; i < width; i++) {
                if (!cellSet.has(`${startX + i},${startY + height}`)) {
                    canExtend = false;
                    break;
                }
            }
            if (canExtend) {
                height++;
            }
        }

        rects.push({ x: startX, y: startY, w: width, h: height });

        for (let i = 0; i < width; i++) {
            for (let j = 0; j < height; j++) {
                cellSet.delete(`${startX + i},${startY + j}`);
            }
        }
    }

    return rects;
}

export function calculateLabelPosition(cells) {
    if (!cells || cells.length === 0) {
        return { x: 0, y: 0, w: 0, d: 0 };
    }

    const minX = Math.min(...cells.map(c => c.x));
    const minY = Math.min(...cells.map(c => c.y));
    const maxX = Math.max(...cells.map(c => c.x));
    const maxY = Math.max(...cells.map(c => c.y));

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const localGrid = Array.from({ length: height }, () => Array(width).fill(false));

    for (const cell of cells) {
        localGrid[cell.y - minY][cell.x - minX] = true;
    }

    const maxWidths = Array.from({ length: height }, () => Array(width).fill(0));
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (localGrid[y][x]) {
                maxWidths[y][x] = (x > 0) ? maxWidths[y][x - 1] + 1 : 1;
            }
        }
    }

    let maxArea = 0;
    let bestRect = { x: 0, y: 0, w: 0, h: 0 };

    for (let x = 0; x < width; x++) {
        const stack = []; // Stores { height, index }
        for (let y = 0; y < height; y++) {
            const h = maxWidths[y][x];
            let start = y;
            while (stack.length > 0 && stack[stack.length - 1].height >= h) {
                const { height: prevH, index: prevY } = stack.pop();
                const w = y - prevY;
                const area = prevH * w;
                if (area > maxArea) {
                    maxArea = area;
                    bestRect = { x: x - prevH + 1, y: prevY, w: prevH, h: w };
                }
                start = prevY;
            }
            stack.push({ height: h, index: start });
        }

        for (const { height: h, index: y } of stack) {
            const w = height - y;
            const area = h * w;
            if (area > maxArea) {
                maxArea = area;
                bestRect = { x: x - h + 1, y: y, w: h, h: w };
            }
        }
    }

    return {
        x: (bestRect.x + minX + bestRect.w / 2),
        y: (bestRect.y + minY + bestRect.h / 2),
    };
}

// ── 管件 SVG helpers（全部返回 SVG 字符串，不含 DOM 操作）───────────────────────

/**
 * 90° 长半径弯头
 * @param {number} x      - 圆心 x
 * @param {number} y      - 圆心 y
 * @param {number} r      - 弯头中心线半径
 * @param {string} fromDir - 入口方向：'right'|'left'|'top'|'bottom'
 * @param {string} toDir   - 出口方向
 * @param {string} stroke  - 颜色（填充模式为 fill 色，线模式为 stroke 色）
 * @param {number} sw      - 线宽（仅 dn_px=0 时使用）
 * @param {number} dn_px   - 管径像素值；>0 时绘制填充 L 形管件体，默认 0（仅画弧线）
 */
export function _elbow(x, y, r, fromDir, toDir, stroke = '#5d6d7e', sw = 2, dn_px = 0) {
  const toRad = a => a * Math.PI / 180
  const sA = { right: 0, top: 90, left: 180, bottom: 270 }[fromDir] ?? 0
  const eA = { right: 0, top: 90, left: 180, bottom: 270 }[toDir]   ?? 90

  if (dn_px > 0) {
    // 单线图模式：穿越视图平面（in/out）时画截面小圆；平面内转角走弧线
    const isPerp = (d) => d === 'in' || d === 'out'
    if (isPerp(fromDir) || isPerp(toDir)) {
      // 穿楼板/穿墙：只在中心处画实心截面圆（单线图符号）
      const r2 = Math.max(3, dn_px * 0.18)
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r2.toFixed(1)}" fill="${stroke}" opacity="0.9"/>`
    }
    // 平面内转角：与 dn_px=0 相同，使用弧线
  }

  // 细弧线（平面内转角 / 示意图 / 剖面图）
  const dx = r * Math.cos(toRad(sA))
  const dy = -r * Math.sin(toRad(sA))
  return `<path d="M${(x + dx).toFixed(1)},${(y + dy).toFixed(1)} A${r},${r} 0 0 0 ${(x + r * Math.cos(toRad(eA))).toFixed(1)},${(y - r * Math.sin(toRad(eA))).toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`
}

/**
 * 旋启式止回阀（菱形符号含两端法兰线）
 * @param {number} cx - 中心 x
 * @param {number} cy - 中心 y
 * @param {number} halfLen - 半长（不含法兰）
 * @param {boolean} horiz - 水平布置
 * @param {string} color - 颜色
 */
export function _checkValve(cx, cy, halfLen, horiz = true, color = '#c0392b') {
  const fl = Math.min(halfLen * 0.3, 6)  // 法兰宽度
  if (horiz) {
    const x1 = cx - halfLen - fl, x2 = cx - halfLen
    const x3 = cx + halfLen, x4 = cx + halfLen + fl
    const y0 = cy, s = halfLen * 0.5
    return _l(x1, y0, x2, y0, color, 2) +
      `<polygon points="${x2.toFixed(1)},${(y0 - s).toFixed(1)} ${x3.toFixed(1)},${y0.toFixed(1)} ${x2.toFixed(1)},${(y0 + s).toFixed(1)}" fill="${color}" opacity="0.85"/>` +
      _l(x3, y0, x4, y0, color, 2)
  } else {
    const y1 = cy - halfLen - fl, y2 = cy - halfLen
    const y3 = cy + halfLen, y4 = cy + halfLen + fl
    const s = halfLen * 0.5
    return _l(cx, y1, cx, y2, color, 2) +
      `<polygon points="${(cx - s).toFixed(1)},${y2.toFixed(1)} ${cx.toFixed(1)},${y3.toFixed(1)} ${(cx + s).toFixed(1)},${y2.toFixed(1)}" fill="${color}" opacity="0.85"/>` +
      _l(cx, y3, cx, y4, color, 2)
  }
}

/**
 * 闸阀（矩形符号）
 * @param {number} cx - 中心 x
 * @param {number} cy - 中心 y
 * @param {number} halfLen - 半长（不含法兰）
 * @param {boolean} horiz - 水平布置
 * @param {string} color - 颜色
 */
export function _gateValve(cx, cy, halfLen, horiz = true, color = '#922b21') {
  const fl = Math.min(halfLen * 0.3, 6)
  if (horiz) {
    const x1 = cx - halfLen - fl, x2 = cx - halfLen, x3 = cx + halfLen, x4 = cx + halfLen + fl
    return _l(x1, cy, x2, cy, color, 2) +
      `<rect x="${x2.toFixed(1)}" y="${(cy - halfLen * 0.4).toFixed(1)}" width="${(x3 - x2).toFixed(1)}" height="${(halfLen * 0.8).toFixed(1)}" fill="${color}" opacity="0.85" rx="2"/>` +
      _l(x3, cy, x4, cy, color, 2)
  } else {
    const y1 = cy - halfLen - fl, y2 = cy - halfLen, y3 = cy + halfLen, y4 = cy + halfLen + fl
    return _l(cx, y1, cx, y2, color, 2) +
      `<rect x="${(cx - halfLen * 0.4).toFixed(1)}" y="${y2.toFixed(1)}" width="${(halfLen * 0.8).toFixed(1)}" height="${(y3 - y2).toFixed(1)}" fill="${color}" opacity="0.85" rx="2"/>` +
      _l(cx, y3, cx, y4, color, 2)
  }
}

/**
 * 电磁流量计（矩形+圆形叠加）
 * @param {number} cx - 中心 x
 * @param {number} cy - 中心 y
 * @param {number} halfLen - 半长
 * @param {number} dn_px - DN 换算的像素半径
 * @param {boolean} horiz - 水平布置
 * @param {string} color - 颜色
 */
export function _flowmeter(cx, cy, halfLen, dn_px, horiz = true, color = '#1a5276') {
  const fl = Math.min(halfLen * 0.3, 6)
  const bodyH = Math.max(8, dn_px * 1.5)
  const bodyW = halfLen * 2
  if (horiz) {
    const x1 = cx - halfLen - fl, x2 = cx - halfLen, x3 = cx + halfLen, x4 = cx + halfLen + fl
    return _l(x1, cy, x2, cy, color, 2) +
      `<rect x="${x2.toFixed(1)}" y="${(cy - bodyH / 2).toFixed(1)}" width="${(x3 - x2).toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}" opacity="0.8" rx="3"/>` +
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(bodyH * 0.35).toFixed(1)}" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.6"/>` +
      _l(x3, cy, x4, cy, color, 2)
  } else {
    const y1 = cy - halfLen - fl, y2 = cy - halfLen, y3 = cy + halfLen, y4 = cy + halfLen + fl
    return _l(cx, y1, cx, y2, color, 2) +
      `<rect x="${(cx - bodyH / 2).toFixed(1)}" y="${y2.toFixed(1)}" width="${bodyH.toFixed(1)}" height="${(y3 - y2).toFixed(1)}" fill="${color}" opacity="0.8" rx="3"/>` +
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(bodyH * 0.35).toFixed(1)}" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.6"/>` +
      _l(cx, y3, cx, y4, color, 2)
  }
}

/**
 * 三通管件几何尺寸（不含 SVG，供调用方计算管道截断点）
 * @param {number} dnMain_px   - 主管 DN 换算像素
 * @param {number} dnBranch_px - 支管 DN 换算像素
 * @returns {{ mhl, mhh, bw, bl }}
 *   mhl = 主管方向半长, mhh = 主管方向半高,
 *   bw = 支管半宽, bl = 支管短节长（从主管中心线向下）
 */
export function _teeGeom(dnMain_px, dnBranch_px) {
  return {
    mhl: Math.max(dnMain_px * 0.7, 5),
    mhh: Math.max(dnMain_px * 0.35, 3),
    bw:  Math.max(dnBranch_px * 0.35, 2),
    bl:  Math.max(dnBranch_px * 0.4, 4),
  }
}

/**
 * T 形三通管件（支管向下），返回 SVG 字符串
 * @param {number} cx        - 三通中心 x（主管轴线上）
 * @param {number} cy        - 三通中心 y（主管轴线）
 * @param {number} dnMain_px - 主管 DN 换算像素（管径宽度）
 * @param {number} dnBranch_px - 支管 DN 换算像素
 * @param {string} color
 */
export function _tee(cx, cy, dnMain_px, dnBranch_px, color = '#2980b9') {
  // 单线图三通：交叉点处画一个实心圆点
  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3" fill="${color}" opacity="0.9"/>`
}

/**
 * 偏心大小头（梯形）
 * @param {number} x1 - 起点 x（左侧端面中心）
 * @param {number} y1 - 起点 y
 * @param {number} dn1_px - 大端 DN 换算半径（px）
 * @param {number} dn2_px - 小端 DN 换算半径（px）
 * @param {number} len_px - 长度（px）
 * @param {boolean} horiz - 水平布置
 * @param {string} color - 颜色
 */
export function _reducer(x1, y1, dn1_px, dn2_px, len_px, horiz = true, color = '#27ae60') {
  if (horiz) {
    const x2 = x1 + len_px
    const ytop1 = y1 - dn1_px, ybot1 = y1 + dn1_px
    const ytop2 = y1 - dn2_px, ybot2 = y1 + dn2_px
    return `<polygon points="${x1.toFixed(1)},${ytop1.toFixed(1)} ${x2.toFixed(1)},${ytop2.toFixed(1)} ${x2.toFixed(1)},${ybot2.toFixed(1)} ${x1.toFixed(1)},${ybot1.toFixed(1)}" fill="${color}" opacity="0.7"/>`
  } else {
    const y2 = y1 - len_px
    return `<polygon points="${(x1 - dn1_px).toFixed(1)},${y1.toFixed(1)} ${(x1 + dn1_px).toFixed(1)},${y1.toFixed(1)} ${(x1 + dn2_px).toFixed(1)},${y2.toFixed(1)} ${(x1 - dn2_px).toFixed(1)},${y2.toFixed(1)}" fill="${color}" opacity="0.7"/>`
  }
}

/**
 * 引线标注（斜线 + 水平横线 + 文字）
 * @param {number} x1 - 引出点 x
 * @param {number} y1 - 引出点 y
 * @param {number} x2 - 标注文字位置 x
 * @param {number} y2 - 标注文字位置 y
 * @param {string} label - 标注文字
 * @param {number} size - 字号
 * @param {string} color - 颜色
 */
export function _leader(x1, y1, x2, y2, label, size = 10, color = '#555') {
  const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2
  return _l(x1, y1, midX, midY, color, 1) + _l(midX, midY, x2, y2, color, 1) +
    `<line x1="${midX.toFixed(1)}" y1="${(midY - 4).toFixed(1)}" x2="${(midX + 6).toFixed(1)}" y2="${(midY - 4).toFixed(1)}" stroke="${color}" stroke-width="1"/>` +
    _t(x2 + 5, midY + 4, label, size, color, 'start')
}

/**
 * BS EN ISO 128 剖面切割线符号
 * 两端 L 形粗线 + 箭头（等边三角形）+ 中间细虚线 + 字母标注
 * @param {number} x1 - 切割线起点 x
 * @param {number} x2 - 切割线终点 x
 * @param {number} y - 切割线 y 坐标
 * @param {string} label - 标注字母，默认 'A'
 * @param {string} color - 颜色，默认 #555
 */
export function _sectionLineBS(x1, x2, y, label = 'A', color = '#555') {
  const arrowSize = 8
  const lLen = 12  // L 形端线长度
  // 左端 L 形 + 箭头
  const leftL = [
    _l(x1, y - lLen, x1, y + lLen, color, 3),  // L 形垂直段
    _l(x1 - arrowSize, y, x1, y - arrowSize, color, 2),  // 上箭头斜边
    _l(x1 - arrowSize, y, x1, y + arrowSize, color, 2),  // 下箭头斜边
  ].join('')
  // 右端 L 形 + 箭头（与左端同向，均指向左←，表示从右侧看剖面）
  const rightL = [
    _l(x2, y - lLen, x2, y + lLen, color, 3),  // L 形垂直段
    _l(x2 - arrowSize, y, x2, y - arrowSize, color, 2),  // 上箭头斜边
    _l(x2 - arrowSize, y, x2, y + arrowSize, color, 2),  // 下箭头斜边
  ].join('')
  // 中间细虚线
  const centerDash = _l(x1 + arrowSize, y, x2 - arrowSize, y, color, 1, '6,3')
  // 字母 A（两端各一个）
  const leftA = _t(x1 - arrowSize - 6, y + 4, label, 10, color, 'end', 'bold')
  const rightA = _t(x2 - arrowSize - 6, y + 4, label, 10, color, 'end', 'bold')
  return leftL + centerDash + rightL + leftA + rightA
}

/**
 * BS EN ISO 128 竖向剖面切割线符号（沿 Y 方向贯穿机房）
 * 两端 L 形粗线 + 箭头（等边三角形）+ 中间细虚线 + 字母标注
 * @param {number} x - 切割线 X 坐标
 * @param {number} y1 - 切割线起点 Y
 * @param {number} y2 - 切割线终点 Y
 * @param {string} label - 标注字母，默认 'A'
 * @param {string} color - 颜色，默认 #555
 */
export function _sectionLineV(x, y1, y2, label = 'A', color = '#555') {
  const arrowSize = 8, lLen = 12
  // 上端 L 形 + 向右箭头
  const topTick = _l(x - lLen, y1, x + lLen, y1, color, 3) +
    _l(x, y1 - arrowSize, x + arrowSize, y1, color, 2) +
    _l(x, y1 + arrowSize, x + arrowSize, y1, color, 2)
  // 下端 L 形 + 向右箭头
  const botTick = _l(x - lLen, y2, x + lLen, y2, color, 3) +
    _l(x, y2 - arrowSize, x + arrowSize, y2, color, 2) +
    _l(x, y2 + arrowSize, x + arrowSize, y2, color, 2)
  // 中间细虚线
  const dash = _l(x, y1 + arrowSize, x, y2 - arrowSize, color, 1, '8,3,2,3')
  // 字母 A（两端各一个）
  const topA = _t(x + arrowSize + 6, y1 + 4, label, 10, color, 'start', 'bold')
  const botA = _t(x + arrowSize + 6, y2 + 4, label, 10, color, 'start', 'bold')
  return topTick + botTick + dash + topA + botA
}
