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

function findFallbackExpansion(grid, roomId, rng) {
    const occupiedCells = grid.roomData[roomId];
    const validNeighbors = [];
    const seen = new Set();


    for (const cell of occupiedCells) {
        const neighbors = [{ x: cell.x + 1, y: cell.y }, { x: cell.x - 1, y: cell.y }, { x: cell.x, y: cell.y + 1 }, { x: cell.x, y: cell.y - 1 }];
        for (const n of neighbors) {
            const key = `${n.x},${n.y}`;
            if (!seen.has(key) && grid.getCell(n.x, n.y) === 0) {
                validNeighbors.push(n);
                seen.add(key);
            }
        }
    }

    if (validNeighbors.length > 0) {
        return [validNeighbors[Math.floor(rng() * validNeighbors.length)]];
    }
    return null;
}


function expandRooms(grid, rooms, rng) {
    let iterations = 0;
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

            if (!expansionCells) {
                expansionCells = findFallbackExpansion(grid, roomToGrow.id, rng);
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
    const emptyCells = [];
    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            if (grid.getCell(x, y) === 0) {
                emptyCells.push({ x, y });
            }
        }
    }

    if (emptyCells.length === 0) return;
    console.log(`Filling ${emptyCells.length} gap cells...`);

    const roomSizes = {};
    for (const room of rooms) {
        roomSizes[room.id] = (grid.roomData[room.id] || []).length;
    }

    for (const cell of emptyCells) {
        const neighbors = [
            { x: cell.x + 1, y: cell.y }, { x: cell.x - 1, y: cell.y },
            { x: cell.x, y: cell.y + 1 }, { x: cell.x, y: cell.y - 1 }
        ];

        let bestNeighborId = null;
        let maxNeighborSize = -1;

        for (const n of neighbors) {
            const neighborId = grid.getCell(n.x, n.y);
            if (neighborId && roomSizes[neighborId] > maxNeighborSize) {
                maxNeighborSize = roomSizes[neighborId];
                bestNeighborId = neighborId;
            }
        }

        if (bestNeighborId) {
            grid.addRoomCell(bestNeighborId, cell.x, cell.y);
            roomSizes[bestNeighborId]++;
        }
    }
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

export function generateConstrainedLayout(seed, bW, bD, roomAreas = {}, groupId = 'CG', variantIdx = 1) {
  const rng = makeRng(seed);

  const gridW = Math.floor(bW / GRID_SIZE);
  const gridH = Math.floor(bD / GRID_SIZE);

  // 1. Separate rooms by floor
  const allRooms = Object.values(ROOM_DEFS).map(r => {
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
  const groundGrid = new Grid(gridW, gridH);
  const groundSeeds = placeRoomSeeds(groundGrid, groundRooms, rng);
  expandRooms(groundGrid, groundRooms, rng);
  fillGaps(groundGrid, groundRooms);

  const level1Grid = new Grid(gridW, gridH);
  const level1Seeds = placeRoomSeeds(level1Grid, level1Rooms, rng);
  expandRooms(level1Grid, level1Rooms, rng);
  fillGaps(level1Grid, level1Rooms);

  // 3. Finalize layouts from both grids
  const finalLayout = {
    ground: finalizeLayout(groundGrid).ground,
    level1: finalizeLayout(level1Grid).level1,
  };

  return {
    id: `A-${groupId}-${variantIdx}`,
    label: `约束生长法`,
    desc: `建筑 ${(bW / 1000).toFixed(1)}m×${(bD / 1000).toFixed(1)}m`,
    groundPlacements: finalLayout.ground,
    level1Placements: finalLayout.level1,
    buildingW: bW,
    buildingD: bD,
    groupId,
    variantIdx,
    _debug: {
      ground: { grid: groundGrid, seeds: groundSeeds },
      level1: { grid: level1Grid, seeds: level1Seeds },
    }
  };
}
