import { ROOM_DEFS } from './room-defs.js';

const GRID_SIZE = 500; // 500mm per grid cell
const MAX_EXPANSION_ITERATIONS = 5000;

class Grid {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.grid = Array(height).fill(null).map(() => Array(width).fill(0)); // 0 for empty
    this.roomData = {}; // Stores cells occupied by each room
  }

  clone() {
    const newGrid = new Grid(this.width, this.height);
    // Deep copy the grid array
    newGrid.grid = this.grid.map(row => [...row]);

    // Perform a robust, manual deep copy of the roomData object
    const newRoomData = {};
    for (const roomId in this.roomData) {
        if (Object.prototype.hasOwnProperty.call(this.roomData, roomId)) {
            // Create a new array for the cells and a new object for each cell
            newRoomData[roomId] = this.roomData[roomId].map(cell => ({ ...cell }));
        }
    }
    newGrid.roomData = newRoomData;

    return newGrid;
  }

  setCell(x, y, roomId) {
    if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
      this.grid[y][x] = roomId;
    }
  }

  getCell(x, y) {
    if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
      return this.grid[y][x];
    }
    return -1; // -1 for out of bounds
  }

  addRoomCell(roomId, x, y) {
    if (!this.roomData[roomId]) {
      this.roomData[roomId] = [];
    }
    this.roomData[roomId].push({x, y});
    this.setCell(x, y, roomId);
  }

  getBoundingBox(roomId) {
    const cells = this.roomData[roomId];
    if (!cells || cells.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const cell of cells) {
      if (cell.x < minX) minX = cell.x;
      if (cell.y < minY) minY = cell.y;
      if (cell.x > maxX) maxX = cell.x;
      if (cell.y > maxY) maxY = cell.y;
    }
    return { minX, minY, maxX, maxY };
  }
}

function createWeightMap(grid, rooms) {
  const weightMap = new Grid(grid.width, grid.height);
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      let weight = 1;
      if (x < 2 || x > grid.width - 3 || y < 2 || y > grid.height - 3) {
        weight = 0.5;
      }
      weightMap.setCell(x, y, weight);
    }
  }
  return weightMap;
}

function placeRoomSeeds(grid, rooms, rng) {
    const weightMap = createWeightMap(grid, rooms);
    const placedSeeds = {};

    for (const room of rooms) {
        let bestPos = null;
        let maxWeight = -1;

        for (let i = 0; i < 100; i++) {
            const x = Math.floor(rng() * grid.width);
            const y = Math.floor(rng() * grid.height);

            if (grid.getCell(x, y) === 0) {
                const weight = weightMap.getCell(x, y);
                if (weight > maxWeight) {
                    maxWeight = weight;
                    bestPos = { x, y };
                }
            }
        }

        if (bestPos) {
            grid.addRoomCell(room.id, bestPos.x, bestPos.y);
            placedSeeds[room.id] = bestPos;
        } else {
            console.warn(`Could not find a placement seed for room ${room.id}`);
        }
    }
    return placedSeeds;
}

function findBestRectangleExpansion(grid, roomId) {
  const bbox = grid.getBoundingBox(roomId);
  if (!bbox) return null;

  const potentialExpansions = [];

  // Try to expand in each of the 4 directions
  const directions = [
    { dir: 'W', dx: -1, dy: 0 },
    { dir: 'E', dx: 1, dy: 0 },
    { dir: 'N', dx: 0, dy: -1 },
    { dir: 'S', dx: 0, dy: 1 }
  ];

  for (const { dir, dx, dy } of directions) {
    let canExpand = true;
    let expansionLine = [];
    if (dx !== 0) { // Horizontal expansion (W or E)
      const newX = (dx > 0) ? bbox.maxX + 1 : bbox.minX - 1;
      for (let y = bbox.minY; y <= bbox.maxY; y++) {
        if (grid.getCell(newX, y) !== 0) {
          canExpand = false;
          break;
        }
        expansionLine.push({ x: newX, y });
      }
    } else { // Vertical expansion (N or S)
      const newY = (dy > 0) ? bbox.maxY + 1 : bbox.minY - 1;
      for (let x = bbox.minX; x <= bbox.maxX; x++) {
        if (grid.getCell(x, newY) !== 0) {
          canExpand = false;
          break;
        }
        expansionLine.push({ x, y: newY });
      }
    }

    if (canExpand && expansionLine.length > 0) {
      potentialExpansions.push({
        cells: expansionLine,
        size: expansionLine.length,
        dir: dir
      });
    }
  }

  if (potentialExpansions.length === 0) return null;

  // Prioritize expansions that result in a more square-like room
  const currentW = bbox.maxX - bbox.minX + 1;
  const currentD = bbox.maxY - bbox.minY + 1;

  potentialExpansions.forEach(exp => {
    const newW = exp.dir === 'W' || exp.dir === 'E' ? currentW + 1 : currentW;
    const newD = exp.dir === 'N' || exp.dir === 'S' ? currentD + 1 : currentD;
    const aspectRatio = Math.max(newW / newD, newD / newW);
    // Lower score is better (closer to 1.0)
    exp.aspectScore = aspectRatio;
  });

  // Sort by aspect ratio score (ascending), then by size (descending)
  potentialExpansions.sort((a, b) => {
    if (a.aspectScore < b.aspectScore) return -1;
    if (a.aspectScore > b.aspectScore) return 1;
    return b.size - a.size;
  });

  return potentialExpansions[0].cells;
}

function findBestFillExpansion(grid, roomId) {
    const occupiedCells = grid.roomData[roomId] || [];
    if (occupiedCells.length === 0) return null;

    const boundaryCells = new Map();

    // 1. Identify all unique, empty boundary cells
    for (const cell of occupiedCells) {
        const neighbors = [
            { x: cell.x + 1, y: cell.y }, { x: cell.x - 1, y: cell.y },
            { x: cell.x, y: cell.y + 1 }, { x: cell.x, y: cell.y - 1 }
        ];

        for (const n of neighbors) {
            const key = `${n.x},${n.y}`;
            if (grid.getCell(n.x, n.y) === 0 && !boundaryCells.has(key)) {
                boundaryCells.set(key, { pos: n, connections: 0 });
            }
        }
    }

    if (boundaryCells.size === 0) return null;

    // 2. Calculate connectivity for each boundary cell
    let bestCell = null;
    let maxConnections = 0;

    for (const [key, cellInfo] of boundaryCells.entries()) {
        const { pos } = cellInfo;
        const neighbors = [
            { x: pos.x + 1, y: pos.y }, { x: pos.x - 1, y: pos.y },
            { x: pos.x, y: pos.y + 1 }, { x: pos.x, y: pos.y - 1 }
        ];

        for (const n of neighbors) {
            if (grid.getCell(n.x, n.y) === roomId) {
                cellInfo.connections++;
            }
        }

        // 3. Find the cell with the highest connectivity
        if (cellInfo.connections > maxConnections) {
            maxConnections = cellInfo.connections;
            bestCell = cellInfo.pos;
        }
    }

    // Only consider this a "fill" expansion if it's filling a corner or gap (connectivity > 1)
    if (maxConnections > 1 && bestCell) {
        return [bestCell];
    }

    return null;
}

function findSmartLineExpansion(grid, roomId) {
    const emptyNeighbors = new Set();
    const roomCells = grid.roomData[roomId] || [];
    for (const cell of roomCells) {
        const neighbors = [
            { x: cell.x + 1, y: cell.y }, { x: cell.x - 1, y: cell.y },
            { x: cell.x, y: cell.y + 1 }, { x: cell.x, y: cell.y - 1 }
        ];
        for (const n of neighbors) {
            if (grid.getCell(n.x, n.y) === 0) {
                emptyNeighbors.add(`${n.x},${n.y}`);
            }
        }
    }
    if (emptyNeighbors.size === 0) return null;

    const segments = findCandidateSegments(grid, emptyNeighbors, roomId);
    let bestSegment = null;
    let bestScore = -Infinity;

    for (const seg of segments) {
        const concaveScore = calculateConcaveScore(grid, seg, roomId);
        if (concaveScore > 0) {
            const score = 10000 + concaveScore + seg.cells.length;
            if (score > bestScore) {
                bestScore = score;
                bestSegment = seg;
            }
            continue;
        }

        const simplificationScore = calculateSimplificationScore(grid, seg, roomId);
        const score = simplificationScore * 100 + seg.cells.length;
        if (score > bestScore) {
            bestScore = score;
            bestSegment = seg;
        }
    }

    return bestSegment ? bestSegment.cells : null;
}

function expandRooms(grid, rooms, rng, onRegularExpansionComplete = null) {
    let iterations = 0;
    let regularExpansionStalled = false;
    // currentArea is now in grid cell counts
    let growingRooms = rooms.map(r => ({ ...r, currentArea: r.id in grid.roomData ? 1 : 0 }));

    while (iterations < MAX_EXPANSION_ITERATIONS) {
        let activeRooms = growingRooms.filter(room => room.currentArea < room.targetGridCount);
        if (activeRooms.length === 0) break;

        // Sort by completion ratio
        activeRooms.sort((a, b) => (a.currentArea / a.targetGridCount) - (b.currentArea / b.targetGridCount));

        let growthHappenedThisCycle = false;

        for (const roomToGrow of activeRooms) {
            let expansionCells = findBestRectangleExpansion(grid, roomToGrow.id);

            if (!expansionCells) {
                expansionCells = findBestFillExpansion(grid, roomToGrow.id);
            }

            if (!expansionCells && !regularExpansionStalled) {
                // This is the moment regular expansion has finished for all rooms.
                // Trigger the callback to capture this state.
                if (onRegularExpansionComplete) {
                    onRegularExpansionComplete(grid);
                }
                regularExpansionStalled = true; // Ensure this only fires once
            }

            if (!expansionCells) {
                expansionCells = findSmartLineExpansion(grid, roomToGrow.id);
            }

            if (expansionCells && expansionCells.length > 0) {
                for (const cell of expansionCells) {
                    if (roomToGrow.currentArea < roomToGrow.targetGridCount) {
                        grid.addRoomCell(roomToGrow.id, cell.x, cell.y);
                        roomToGrow.currentArea++; // Increment by 1 grid cell
                    } else {
                        break;
                    }
                }
                growthHappenedThisCycle = true;
                break;
            }
        }


        if (!growthHappenedThisCycle) {
            console.warn("Expansion stuck. No rooms could grow.");
            break;
        }

        iterations++;
    }

    if (iterations === MAX_EXPANSION_ITERATIONS) {
        console.warn("Expansion reached max iterations.");
    }
}

function fillGaps(grid, rooms) {
    let emptyCells = [];
    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            if (grid.getCell(x, y) === 0) {
                emptyCells.push({ x, y });
            }
        }
    }

    if (emptyCells.length === 0) return;
    console.log(`智能填充 ${emptyCells.length} 个间隙单元格...`);

    const emptyCellSet = new Set(emptyCells.map(c => `${c.x},${c.y}`));

    while (emptyCellSet.size > 0) {
        let bestSegment = null;
        let bestScore = -Infinity;
        let bestRoomId = null;

        // --- 1. 识别所有可填充线段 ---
        const segments = findCandidateSegments(grid, emptyCellSet);

        if (segments.length === 0) {
            console.warn("无法找到更多可填充线段，但仍有空隙。");
            break;
        }

        // --- 2. 评估每条线段 ---
        for (const seg of segments) {
            const neighbors = getSegmentNeighbors(grid, seg);
            if (neighbors.size === 0) continue;

            for (const roomId of neighbors) {
                // --- 2a. 阶段一：优先填充凹角 (方案C) ---
                const凹角Score = calculateConcaveScore(grid, seg, roomId);
                if (凹角Score > 0) {
                    const score = 10000 + 凹角Score + seg.cells.length;
                     if (score > bestScore) {
                        bestScore = score;
                        bestSegment = seg;
                        bestRoomId = roomId;
                    }
                    continue;
                }

                // --- 2b. 阶段二：边界简化评分 (方案B) ---
                const simplificationScore = calculateSimplificationScore(grid, seg, roomId);
                const score = simplificationScore * 100 + seg.cells.length;

                if (score > bestScore) {
                    bestScore = score;
                    bestSegment = seg;
                    bestRoomId = roomId;
                }
            }
        }

        // --- 3. 选择最优并填充 ---
        if (bestSegment) {
            for (const cell of bestSegment.cells) {
                grid.addRoomCell(bestRoomId, cell.x, cell.y);
                emptyCellSet.delete(`${cell.x},${cell.y}`);
            }
        } else {
             console.warn("没有找到合适的填充方案，终止填充。");
            break;
        }
    }
}

function findCandidateSegments(grid, emptyCellSet) {
    const segments = [];
    const visited = new Set();

    for (const cellStr of emptyCellSet) {
        if (visited.has(cellStr)) continue;

        const [x_str, y_str] = cellStr.split(',');
        const x = parseInt(x_str, 10);
        const y = parseInt(y_str, 10);

        // Horizontal segment
        let hSegment = [{ x, y }];
        visited.add(`${x},${y}`);
        for (let i = x + 1; i < grid.width && emptyCellSet.has(`${i},${y}`); i++) {
            hSegment.push({ x: i, y });
            visited.add(`${i},${y}`);
        }
         for (let i = x - 1; i >= 0 && emptyCellSet.has(`${i},${y}`); i--) {
            hSegment.unshift({ x: i, y });
            visited.add(`${i},${y}`);
        }
        segments.push({ cells: hSegment, dir: 'h' });


        // Vertical segment (reset visited for vertical pass from original cell)
        let vSegment = [{ x, y }];
        // Note: Re-visiting is ok here as we are building a different segment
        for (let j = y + 1; j < grid.height && emptyCellSet.has(`${x},${j}`); j++) {
            vSegment.push({ x, y: j });
        }
        for (let j = y - 1; j >= 0 && emptyCellSet.has(`${x},${j}`); j--) {
            vSegment.unshift({ x, y: j });
        }
        if (vSegment.length > 1) {
             segments.push({ cells: vSegment, dir: 'v' });
        }
    }
    return segments;
}

function getSegmentNeighbors(grid, segment) {
    const neighbors = new Set();
    const isHorizontal = segment.dir === 'h';
    for (const cell of segment.cells) {
        if (isHorizontal) {
            const n_up = grid.getCell(cell.x, cell.y - 1);
            const n_down = grid.getCell(cell.x, cell.y + 1);
            if (n_up > 0) neighbors.add(n_up);
            if (n_down > 0) neighbors.add(n_down);
        } else { // Vertical
            const n_left = grid.getCell(cell.x - 1, cell.y);
            const n_right = grid.getCell(cell.x + 1, cell.y);
            if (n_left > 0) neighbors.add(n_left);
            if (n_right > 0) neighbors.add(n_right);
        }
    }
    return neighbors;
}

function isCorner(grid, x, y, roomId) {
    const isSelf = (dx, dy) => grid.getCell(x + dx, y + dy) === roomId;
    const isBoundary = (dx, dy) => grid.getCell(x + dx, y + dy) !== roomId;

    // A corner must have exactly 2 adjacent same-room cells, and they must be orthogonal.
    const neighbors = [isSelf(0, 1), isSelf(0, -1), isSelf(1, 0), isSelf(-1, 0)];
    if (neighbors.filter(Boolean).length !== 2) return false;
    return (isSelf(0,1) && isSelf(1,0)) || (isSelf(0,1) && isSelf(-1,0)) ||
           (isSelf(0,-1) && isSelf(1,0)) || (isSelf(0,-1) && isSelf(-1,0));
}

function calculateSimplificationScore(grid, segment, roomId) {
    let score = 0;
    const isHorizontal = segment.dir === 'h';
    const first = segment.cells[0];
    const last = segment.cells[segment.cells.length - 1];

    const get = (x, y) => {
        // Temporarily treat segment cells as part of the room for calculation
        if (segment.cells.some(c => c.x === x && c.y === y)) return roomId;
        return grid.getCell(x,y);
    }

    const checkPoint = (x, y) => {
        const isNowCorner = isCorner({getCell: get}, x, y, roomId);
        const wasCorner = isCorner(grid, x, y, roomId);
        if (wasCorner && !isNowCorner) score++;
        if (!wasCorner && isNowCorner) score--;
    }

    // Check corners around the segment's endpoints
     if (isHorizontal) {
        checkPoint(first.x - 1, first.y);
        checkPoint(first.x, first.y - 1);
        checkPoint(first.x, first.y + 1);
        checkPoint(last.x + 1, last.y);
        checkPoint(last.x, last.y - 1);
        checkPoint(last.x, last.y + 1);
    } else {
        checkPoint(first.x, first.y - 1);
        checkPoint(first.x - 1, first.y);
        checkPoint(first.x + 1, first.y);
        checkPoint(last.x, last.y + 1);
        checkPoint(last.x - 1, last.y);
        checkPoint(last.x + 1, last.y);
    }
    return score;
}

function calculateConcaveScore(grid, segment, roomId) {
    const isHorizontal = segment.dir === 'h';
    let longSideContact = 0;
    let shortSideContact = 0;

    for (const cell of segment.cells) {
        if (isHorizontal) {
            if (grid.getCell(cell.x, cell.y - 1) === roomId) longSideContact++;
            if (grid.getCell(cell.x, cell.y + 1) === roomId) longSideContact++;
        } else {
            if (grid.getCell(cell.x - 1, cell.y) === roomId) longSideContact++;
            if (grid.getCell(cell.x + 1, cell.y) === roomId) longSideContact++;
        }
    }

    const first = segment.cells[0];
    const last = segment.cells[segment.cells.length - 1];

    if (isHorizontal) {
        if (grid.getCell(first.x - 1, first.y) === roomId) shortSideContact++;
        if (grid.getCell(last.x + 1, last.y) === roomId) shortSideContact++;
    } else {
        if (grid.getCell(first.x, first.y - 1) === roomId) shortSideContact++;
        if (grid.getCell(last.x, last.y + 1) === roomId) shortSideContact++;
    }

    // A strong concave "U" shape would have contact on both long sides and at least one short side.
    if (longSideContact >= segment.cells.length * 1.5 && shortSideContact > 0) {
        return longSideContact + shortSideContact * 2;
    }

    // A weaker "L" shape might have one long side and one short side.
    if (longSideContact >= segment.cells.length * 0.8 && shortSideContact > 0) {
        return (longSideContact/2 + shortSideContact);
    }

    return 0;
}

function finalizeLayout(grid) {
  const layout = { ground: {}, level1: {} };
  const roomIds = Object.keys(grid.roomData);

  for (const roomId of roomIds) {
    const bbox = grid.getBoundingBox(roomId);
    if (bbox) {
      const roomLayout = {
        x: bbox.minX * GRID_SIZE,
        y: bbox.minY * GRID_SIZE,
        w: (bbox.maxX - bbox.minX + 1) * GRID_SIZE,
        d: (bbox.maxY - bbox.minY + 1) * GRID_SIZE,
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

function makeRng(seed) {
  let s = ((seed * 0x6b37d369) ^ 0xdeadbeef) >>> 0;
  if (s === 0) s = 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

export function generateConstrainedLayout(seed, bW, bD, roomAreas = {}, groupId = 'CG', variantIdx = 1, prefix = 'R', initialSeeds = null) {
  const rng = makeRng(seed);

  const gridW = Math.floor(bW / GRID_SIZE);
  const gridH = Math.floor(bD / GRID_SIZE);

  // 1. Separate rooms by floor
  const allRooms = Object.values(ROOM_DEFS).filter(r => !r.isOpening).map(r => {
    const targetAreaMm2 = (roomAreas[r.id] * 1e6) || (r.w * r.d);
    return {
      id: r.id,
      label: r.label,
      floor: r.floor,
      targetGridCount: Math.round(targetAreaMm2 / (GRID_SIZE * GRID_SIZE)),
    };
  }).filter(r => r.targetGridCount >= 1);

  const groundRooms = allRooms.filter(r => r.floor === 'ground');
  const level1Rooms = allRooms.filter(r => r.floor === 'level1');

  // 2. Create and process grids for each floor
  let groundGridBeforeGaps;
  const groundGrid = new Grid(gridW, gridH);
  let groundSeeds;
  if (initialSeeds && initialSeeds.ground) {
    groundSeeds = initialSeeds.ground;
    for (const room of groundRooms) {
        if (groundSeeds[room.id]) {
            const { x, y } = groundSeeds[room.id];
            groundGrid.addRoomCell(room.id, x, y);
        }
    }
  } else {
    groundSeeds = placeRoomSeeds(groundGrid, groundRooms, rng);
  }
  expandRooms(groundGrid, groundRooms, rng, (gridState) => {
    groundGridBeforeGaps = gridState.clone();
  });
  if (!groundGridBeforeGaps) groundGridBeforeGaps = groundGrid.clone(); // Fallback if regular expansion never stalled
  fillGaps(groundGrid, groundRooms);

  let level1GridBeforeGaps;
  const level1Grid = new Grid(gridW, gridH);
  let level1Seeds;
  if (initialSeeds && initialSeeds.level1) {
    level1Seeds = initialSeeds.level1;
    for (const room of level1Rooms) {
        if (level1Seeds[room.id]) {
            const { x, y } = level1Seeds[room.id];
            level1Grid.addRoomCell(room.id, x, y);
        }
    }
  } else {
    level1Seeds = placeRoomSeeds(level1Grid, level1Rooms, rng);
  }
  expandRooms(level1Grid, level1Rooms, rng, (gridState) => {
    level1GridBeforeGaps = gridState.clone();
  });
  if (!level1GridBeforeGaps) level1GridBeforeGaps = level1Grid.clone(); // Fallback
  fillGaps(level1Grid, level1Rooms);

  // 3. Finalize layouts from both grids
  const finalLayout = {
    ground: finalizeLayout(groundGrid).ground,
    level1: finalizeLayout(level1Grid).level1,
  };

  return {
    id: `${prefix}-${groupId}-${variantIdx}`,
    label: `约束生长法`,
    desc: `建筑 ${(bW / 1000).toFixed(1)}m×${(bD / 1000).toFixed(1)}m`,
    groundPlacements: finalLayout.ground,
    level1Placements: finalLayout.level1,
    buildingW: bW,
    buildingD: bD,
    groupId,
    variantIdx,
    _debug: {
      ground: { grid: groundGrid, seeds: groundSeeds, gridBeforeGaps: groundGridBeforeGaps },
      level1: { grid: level1Grid, seeds: level1Seeds, gridBeforeGaps: level1GridBeforeGaps },
    }
  };
}
