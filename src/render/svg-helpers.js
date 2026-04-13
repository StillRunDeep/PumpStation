import { ROOM_DEFS } from '../layout/room-defs.js';

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

  const { grid, seeds } = debugData;
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

  // Draw seeds on top
  if (seeds) {
    for (const [id, pos] of Object.entries(seeds)) {
      const cx = ox + (pos.x + 0.5) * cellSize;
      const cy = oy + (pos.y + 0.5) * cellSize;
      s += _c(cx, cy, cellSize * 0.3, FgColors[id] || '#c0392b');
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
