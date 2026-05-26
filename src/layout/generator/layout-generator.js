/**
 * CONSTRAINT GROWTH ALGORITHM (AG4-1: 建筑平面布局生成)
 *
 * This module implements a three-phase room layout generation algorithm:
 * - Phase 1: Seed placement (初始种子放置)
 * - Phase 2: Polygon expansion (L/U 扩展)
 * - Phase 3: Gap filling (空隙填充)
 *
 * IMPORTANT: See ALGORITHM_CONSTRAINT_GROWTH.md for detailed algorithm documentation,
 * pseudocode, weight map definitions, Checkpoint A/B/C integration, and debugging guide.
 *
 * Key data structures:
 * - Grid class: 2D grid with room occupancy tracking + bbox caching (O(1) lookups)
 * - ADJACENCY_MUST: Hard constraints (parking↔repair_zone, trafo1↔trafo2, etc.)
 * - Weight maps: Per-room priority maps for Phase 1 & 2 expansion
 * - targetGridCount: Area targets per room (defined in room-defs.js)
 *
 * Performance targets (with Web Worker optimization):
 * - Phase 1: 100ms (200ms currently)
 * - Phase 2: 10s (25s currently) — bottleneck
 * - Phase 3: 1s (3s currently)
 * Total: 11s per variant × 9 variants = ~2 minutes for full generation
 */

import { ROOM_DEFS } from '../model/room-defs.js';
import { checkAdjacency, ADJACENCY_MUST } from '../topology/adjacency.js';
import { placeDoors } from '../topology/door-placer.js';
import { SCORER_PARAMS } from '../evaluation/scorer-params.js';
import { evaluateCheckpointA, scoreSpatialQuality, GROUND_MUST_EXT, LEVEL1_MUST_FACE_CORRIDOR } from '../evaluation/scorer.js';
import { adjacent, centerX, centerY, touchesExteriorNonSouth, CONSTRAINT_CHECKS, evaluateTemplate } from './placer.js';

export const GRID_SIZE = 500; // 500mm per grid cell — single source of truth, imported by ag41/ag42
const MAX_EXPANSION_ITERATIONS = 5000;

// ── Geometry helpers (used internally) ───────────────────────────────────────

/** Normalised aspect ratio: always ≥ 1. */
function aspectRatio(w, d) {
  return Math.max(w / d, d / w);
}

const DEBUG_LAYOUT = false; // set true locally for fill-gap tracing & cooperative growth debugging

// ── Debug Logging System ──────────────────────────────────────────
/**
 * Centralized debug logging for Phase 2 & 3 algorithm inspection.
 * Respects DEBUG_LAYOUT and environment variable controls.
 */
function debugLog(phase, message, data = {}) {
  const isEnabled = (phase === 2 && window.debugLayoutPhase2) ||
                    (phase === 3 && window.debugLayoutPhase3) ||
                    DEBUG_LAYOUT;

  if (!isEnabled) return;

  const logEntry = {
    timestamp: Date.now(),
    phase,
    message,
    ...data
  };

  if (!window.layoutDebugLog) window.layoutDebugLog = [];
  window.layoutDebugLog.push(logEntry);

  // Also print to console if in Node.js environment
  if (typeof console !== 'undefined') {
    console.log(`[Phase${phase}] ${message}`, Object.keys(data).length > 0 ? data : '');
  }
}

class Grid {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.grid = Array(height).fill(null).map(() => Array(width).fill(0)); // 0 for empty
    this.roomData = {}; // Stores cells occupied by each room
    this.bboxes = {};   // Cache for getBoundingBox
  }

  clone() {
    const newGrid = new Grid(this.width, this.height);
    // Deep copy the grid array
    newGrid.grid = this.grid.map(row => [...row]);

    // Perform a robust, manual deep copy of the roomData and bboxes
    const newRoomData = {};
    for (const roomId in this.roomData) {
      if (Object.prototype.hasOwnProperty.call(this.roomData, roomId)) {
        newRoomData[roomId] = this.roomData[roomId].map(cell => ({ ...cell }));
      }
    }
    newGrid.roomData = newRoomData;
    
    const newBboxes = {};
    for (const roomId in this.bboxes) {
      if (Object.prototype.hasOwnProperty.call(this.bboxes, roomId)) {
        newBboxes[roomId] = { ...this.bboxes[roomId] };
      }
    }
    newGrid.bboxes = newBboxes;

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
    
    // Incremental BBox update (O(1))
    if (!this.bboxes[roomId]) {
      this.bboxes[roomId] = { minX: x, minY: y, maxX: x, maxY: y };
    } else {
      const b = this.bboxes[roomId];
      if (x < b.minX) b.minX = x;
      if (y < b.minY) b.minY = y;
      if (x > b.maxX) b.maxX = x;
      if (y > b.maxY) b.maxY = y;
    }
    
    this.setCell(x, y, roomId);
  }

  getBoundingBox(roomId) {
    return this.bboxes[roomId] || null;
  }
}

const ADJACENCY_PAIRS = ADJACENCY_MUST.map(item => item.pair);

/**
 * Generates a weight map for a specific room based on its constraints.
 */
export function generateWeightMapForRoom(grid, room, placedSeeds, parentPlacements = null) {
  const { width, height } = grid;
  const weightMap = Array(height).fill(null).map(() => Array(width).fill(1));
  const roomDef = ROOM_DEFS[room.id];
  // For super-rooms, use inherited constraints; otherwise use room-def constraints
  const constraints = roomDef?.constraints ?? room.constraints ?? [];
  const GRID_SIZE = 100; // 假设网格大小为 100mm

  // Rule 1: Exterior wall constraint
  if (constraints.includes('ext_access')) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // 500mm is 5 grid cells if GRID_SIZE=100. Check existing convention.
        // Based on original code, x===0, y===0, x===width-1 were used as "500mm".
        if (x === 0 || y === 0 || x === width - 1) {
          weightMap[y][x] = 10;
        }
      }
    }
  }

  // Rule 2: Adjacency constraint
  for (const pair of ADJACENCY_PAIRS) {
    let partnerId = null;
    if (pair[0] === room.id) partnerId = pair[1];
    if (pair[1] === room.id) partnerId = pair[0];

    if (partnerId) {
      const p = parentPlacements?.[partnerId];
      if (p) {
        // 基于真实轮廓外发光 (基于 GRID_SIZE=100)
        const x0 = Math.floor(p.x / GRID_SIZE);
        const y0 = Math.floor(p.y / GRID_SIZE);
        const x1 = Math.ceil((p.x + p.w) / GRID_SIZE);
        const y1 = Math.ceil((p.y + p.d) / GRID_SIZE);

        const expand = 3; // 向外扩展 3 格 (300mm)
        for (let y = y0 - expand; y <= y1 + expand; y++) {
          for (let x = x0 - expand; x <= x1 + expand; x++) {
            if (x >= 0 && x < width && y >= 0 && y < height) {
              // 排除掉 partner 内部格子，只提升边缘权重
              if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
              weightMap[y][x] *= 50;
            }
          }
        }
      } else if (placedSeeds[partnerId]) {
        // 兜底：若无真实轮廓，退回到中心点扩散
        const partnerSeed = placedSeeds[partnerId];
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const nx = partnerSeed.x + dx;
            const ny = partnerSeed.y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              weightMap[ny][nx] *= 50;
            }
          }
        }
      }
    }
  }

  return weightMap;
}


/**
 * Merge MUST-adjacent room pairs into super-rooms for cooperative growth.
 * Prevents fragmentation during expansion by treating paired rooms as a single unit.
 *
 * @param {Array} rooms - Room array for a single floor
 * @returns {{ mergedRooms, superRoomMap }}
 *   - mergedRooms: rooms array with pairs replaced by super-rooms
 *   - superRoomMap: Map<superId, {roomA, roomB}>
 */
function mergeMustPairsForFloor(rooms) {
  const roomMap = new Map(rooms.map(r => [r.id, r]));
  const merged = [];
  const superRoomMap = new Map();
  const pairedIds = new Set();

  const floor = rooms.length > 0 ? rooms[0].floor : 'unknown';
  console.error(`[CoGrow] mergeMustPairsForFloor floor=${floor}: input rooms=${rooms.map(r => r.id).join(',')}`);

  // Process each MUST pair
  for (const { pair: [aId, bId] } of ADJACENCY_MUST) {
    const roomA = roomMap.get(aId);
    const roomB = roomMap.get(bId);
    if (!roomA || !roomB) {
      console.error(`[CoGrow]   pair (${aId}, ${bId}): roomA=${roomA?.id}(${roomA ? 'found' : 'MISSING'}), roomB=${roomB?.id}(${roomB ? 'found' : 'MISSING'}), skipping`);
      continue;
    }
    if (roomA.floor !== roomB.floor) {
      console.error(`[CoGrow]   pair (${aId}, ${bId}): different floors (${roomA.floor} vs ${roomB.floor}), skipping`);
      continue;
    }

    const superId = `__super__${aId}+${bId}`;
    console.error(`[CoGrow] merging pair (${aId}, ${bId}) → ${superId}`);

    // Inherit constraints from both rooms (union)
    const constraintsA = ROOM_DEFS[aId]?.constraints ?? [];
    const constraintsB = ROOM_DEFS[bId]?.constraints ?? [];
    const mergedConstraints = [...new Set([...constraintsA, ...constraintsB])];

    const superRoom = {
      id: superId,
      label: `${roomA.label}+${roomB.label}`,
      floor: roomA.floor,
      targetGridCount: roomA.targetGridCount + roomB.targetGridCount,
      constraints: mergedConstraints,
      _isSuperRoom: true,
      _roomA: roomA,
      _roomB: roomB,
    };

    merged.push(superRoom);
    superRoomMap.set(superId, { roomA, roomB });
    pairedIds.add(aId);
    pairedIds.add(bId);
  }

  // Add unpaired rooms
  for (const room of rooms) {
    if (!pairedIds.has(room.id)) {
      console.error(`[CoGrow]   adding unpaired room: ${room.id}`);
      merged.push(room);
    }
  }

  console.error(`[CoGrow] mergeMustPairsForFloor result: merged=${merged.map(r => r.id).join(',')}, superRoomMap.size=${superRoomMap.size}`);
  return { mergedRooms: merged, superRoomMap };
}

/**
 * Build accessibility metadata for super-rooms.
 * Used by isAccessibilityMet and getPreferredDirection.
 *
 * @param {Map} superRoomMap - From mergeMustPairsForFloor
 * @returns {Map} superId → {mustExt, mustCorridor}
 */
function buildSuperRoomMeta(superRoomMap) {
  const meta = new Map();

  for (const [superId, { roomA, roomB }] of superRoomMap) {
    const mustExt = GROUND_MUST_EXT.includes(roomA.id) || GROUND_MUST_EXT.includes(roomB.id);
    const mustCorridor = LEVEL1_MUST_FACE_CORRIDOR.includes(roomA.id) || LEVEL1_MUST_FACE_CORRIDOR.includes(roomB.id);

    meta.set(superId, { mustExt, mustCorridor });
  }

  return meta;
}

/**
 * Split a super-room back into its constituent rooms along the short axis.
 * Creates a clean shared wall boundary.
 *
 * @param {Grid} grid
 * @param {string} superId
 * @param {Object} roomA - Original room A
 * @param {Object} roomB - Original room B
 */
function splitSuperRoom(grid, superId, roomA, roomB) {
  const cells = grid.roomData[superId];
  if (!cells || cells.length === 0) return;

  const totalCells = cells.length;
  const totalTarget = roomA.targetGridCount + roomB.targetGridCount;
  const ratioA = totalTarget > 0 ? roomA.targetGridCount / totalTarget : 0.5;
  let countA = Math.round(totalCells * ratioA);

  // Ensure at least 1 cell for each room if total > 0
  if (totalCells > 1) {
    countA = Math.max(1, Math.min(countA, totalCells - 1));
  }

  const bbox = grid.getBoundingBox(superId);
  const bboxW = bbox.maxX - bbox.minX + 1;
  const bboxH = bbox.maxY - bbox.minY + 1;

  let cellsA = [];
  let cellsB = [];

  if (bboxW >= bboxH) {
    // Vertical split: divide by column (x-coordinate)
    const byCol = new Map();
    for (const cell of cells) {
      if (!byCol.has(cell.x)) byCol.set(cell.x, []);
      byCol.get(cell.x).push(cell);
    }

    const cols = [...byCol.keys()].sort((a, b) => a - b);
    let accumulated = 0;

    for (const col of cols) {
      const colCells = byCol.get(col);
      if (accumulated < countA) {
        cellsA.push(...colCells);
        accumulated += colCells.length;
      } else {
        cellsB.push(...colCells);
      }
    }
  } else {
    // Horizontal split: divide by row (y-coordinate)
    const byRow = new Map();
    for (const cell of cells) {
      if (!byRow.has(cell.y)) byRow.set(cell.y, []);
      byRow.get(cell.y).push(cell);
    }

    const rows = [...byRow.keys()].sort((a, b) => a - b);
    let accumulated = 0;

    for (const row of rows) {
      const rowCells = byRow.get(row);
      if (accumulated < countA) {
        cellsA.push(...rowCells);
        accumulated += rowCells.length;
      } else {
        cellsB.push(...rowCells);
      }
    }
  }

  // Safeguard: ensure at least one cell for each room if any cells exist
  if (cellsA.length === 0 && cellsB.length > 0) {
    cellsA.push(cellsB.shift());
  } else if (cellsB.length === 0 && cellsA.length > 0) {
    cellsB.push(cellsA.pop());
  }

  console.error(`[CoGrow] splitSuperRoom ${superId}: total=${totalCells}, ratioA=${ratioA.toFixed(3)}, countA=${countA}, cellsA=${cellsA.length}, cellsB=${cellsB.length}`);

  // Clear super-room from grid
  for (const cell of cells) {
    grid.setCell(cell.x, cell.y, 0);
  }
  delete grid.roomData[superId];
  delete grid.bboxes[superId];

  // Assign cells to original rooms
  for (const cell of cellsA) {
    grid.addRoomCell(roomA.id, cell.x, cell.y);
  }
  for (const cell of cellsB) {
    grid.addRoomCell(roomB.id, cell.x, cell.y);
  }
  console.error(`[CoGrow] splitSuperRoom ${superId} complete: ${roomA.id}=${grid.roomData[roomA.id]?.length || 0}, ${roomB.id}=${grid.roomData[roomB.id]?.length || 0}`);
}

/**
 * Split all super-rooms in a grid back into their constituent rooms.
 *
 * @param {Grid} grid
 * @param {Map} superRoomMap - From mergeMustPairsForFloor
 */
function splitAllSuperRooms(grid, superRoomMap) {
  console.error(`[CoGrow] splitAllSuperRooms: ${superRoomMap.size} super-rooms to split`);

  for (const [superId, { roomA, roomB }] of superRoomMap) {
    if (grid.roomData[superId]) {
      const cellCount = grid.roomData[superId].length;
      console.error(`[CoGrow] splitting ${superId}: ${cellCount} cells`);
      splitSuperRoom(grid, superId, roomA, roomB);
    } else {
      console.error(`[CoGrow] super-room ${superId} not found in grid`);
    }
  }
}

function placeRoomSeeds(grid, rooms, rng) {
  const floor = rooms.length > 0 ? rooms[0].floor : 'unknown';
  console.error(`[CoGrow] placeRoomSeeds floor=${floor}: placing ${rooms.map(r => r.id).join(',')}`);
  const placedSeeds = {};
  let roomsToPlace = [...rooms];
  const MAX_PLACEMENT_ROUNDS = rooms.length * 2;
  let rounds = 0;

  while (roomsToPlace.length > 0 && rounds < MAX_PLACEMENT_ROUNDS) {
    let placedInRound = false;
    const remainingRooms = [];

    for (const room of roomsToPlace) {
      // Check if all MUST neighbors are already placed
      const mustNeighbors = ADJACENCY_PAIRS
        .filter(p => p.includes(room.id))
        .map(p => p[0] === room.id ? p[1] : p[0]);

      const neighborsPlaced = mustNeighbors.every(id => placedSeeds[id]);

      if (neighborsPlaced) {
        // ── MUST 邻接对的"从"成员：直接随机选伙伴周边空格 ──────────────
        // pair[1] 是"从"，pair[0] 是"主"（主已放置，因为死锁解除时主先放）
        let bestPos = null;
        const mustPair = ADJACENCY_PAIRS.find(p => p[1] === room.id && placedSeeds[p[0]]);
        if (mustPair) {
          const primarySeed = placedSeeds[mustPair[0]];
          // 收集伙伴周边所有空格（±3 格范围），随机选一个
          const nearCandidates = [];
          for (let dy = -3; dy <= 3; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
              const nx = primarySeed.x + dx, ny = primarySeed.y + dy;
              if (nx >= 0 && nx < grid.width && ny >= 0 && ny < grid.height && grid.getCell(nx, ny) === 0) {
                nearCandidates.push({ x: nx, y: ny });
              }
            }
          }
          if (nearCandidates.length > 0) {
            bestPos = nearCandidates[Math.floor(rng() * nearCandidates.length)];
          }
        }

        // ── 无强约束的房间（或周边无空格时的退化）：200 次随机采样 ────
        if (!bestPos) {
          const weightMap = generateWeightMapForRoom(grid, room, placedSeeds);
          let maxWeight = -1;
          for (let i = 0; i < 200; i++) {
            const x = Math.floor(rng() * grid.width);
            const y = Math.floor(rng() * grid.height);
            if (grid.getCell(x, y) === 0) {
              const weight = weightMap[y][x];
              if (weight > maxWeight) { maxWeight = weight; bestPos = { x, y }; }
            }
          }
          // fallback：全网格扫描
          if (!bestPos) {
            for (let y = 0; y < grid.height; y++) {
              for (let x = 0; x < grid.width; x++) {
                if (grid.getCell(x, y) === 0) {
                  const weight = weightMap[y][x];
                  if (weight > maxWeight) { maxWeight = weight; bestPos = { x, y }; }
                }
              }
            }
          }
        }

        if (bestPos) {
          grid.addRoomCell(room.id, bestPos.x, bestPos.y);
          placedSeeds[room.id] = bestPos;
          placedInRound = true;
        } else {
          console.warn(`Could not find a placement seed for room ${room.id}`);
          remainingRooms.push(room); // Keep it for the next round
        }
      } else {
        remainingRooms.push(room);
      }
    }

    // If no room was placed in a full pass, there might be a circular dependency or no space.
    // To handle circular deps, we relax the constraint and place one room to break the cycle.
    if (!placedInRound && remainingRooms.length > 0) {
        console.warn("Deadlock in seed placement, placing one room randomly to break.", remainingRooms.map(r=>r.id));
        const roomToForcePlace = remainingRooms[0];
        const weightMap = generateWeightMapForRoom(grid, roomToForcePlace, placedSeeds);
        let bestPos = null;
        let maxWeight = -1;
         for (let y = 0; y < grid.height; y++) {
            for (let x = 0; x < grid.width; x++) {
                if (grid.getCell(x, y) === 0) {
                    const weight = weightMap[y][x];
                    if (weight > maxWeight) {
                        maxWeight = weight;
                        bestPos = { x, y };
                    }
                }
            }
        }
        if (bestPos) {
            grid.addRoomCell(roomToForcePlace.id, bestPos.x, bestPos.y);
            placedSeeds[roomToForcePlace.id] = bestPos;
            remainingRooms.shift(); // remove the forced-placed room
        }
    }

    roomsToPlace = remainingRooms;
    rounds++;
  }

  if (roomsToPlace.length > 0) {
      console.error("Failed to place all room seeds:", roomsToPlace.map(r => r.id));
  }

  console.error(`[CoGrow] placeRoomSeeds complete: placed=${Object.keys(placedSeeds).join(',')}`);
  return placedSeeds;
}

/**
 * Returns the minimum cross-sectional width of a room in either axis (in grid cells).
 * Used to enforce the corridor min-width guard.
 */
function getRoomMinCrossWidth(grid, roomId) {
  const bbox = grid.getBoundingBox(roomId);
  if (!bbox) return 0;
  let minW = Infinity;
  for (let y = bbox.minY; y <= bbox.maxY; y++) {
    let rowCount = 0;
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      if (grid.getCell(x, y) === roomId) rowCount++;
    }
    if (rowCount > 0) minW = Math.min(minW, rowCount);
  }
  for (let x = bbox.minX; x <= bbox.maxX; x++) {
    let colCount = 0;
    for (let y = bbox.minY; y <= bbox.maxY; y++) {
      if (grid.getCell(x, y) === roomId) colCount++;
    }
    if (colCount > 0) minW = Math.min(minW, colCount);
  }
  return minW === Infinity ? 0 : minW;
}

const CORRIDOR_MIN_WIDTH_CELLS = 5; // 5 × 500mm = 2500mm

function findBestRectangleExpansion(grid, roomId, preferElongated = false, preferredDir = null) {
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

  // If a preferred direction is set and has a valid expansion, return it immediately
  // (accessibility goal overrides aspect-ratio optimisation)
  if (preferredDir) {
    const preferred = potentialExpansions.find(exp => exp.dir === preferredDir);
    if (preferred) return preferred.cells;
  }

  const currentW = bbox.maxX - bbox.minX + 1;
  const currentD = bbox.maxY - bbox.minY + 1;

  potentialExpansions.forEach(exp => {
    const newW = exp.dir === 'W' || exp.dir === 'E' ? currentW + 1 : currentW;
    const newD = exp.dir === 'N' || exp.dir === 'S' ? currentD + 1 : currentD;
    exp.aspectScore = aspectRatio(newW, newD);
  });

  // For corridor: prefer elongated growth (higher aspect ratio keeps the corridor linear).
  // For regular rooms: prefer square-ish growth (lower aspect ratio).
  potentialExpansions.sort((a, b) => {
    if (preferElongated) {
      if (a.aspectScore > b.aspectScore) return -1;
      if (a.aspectScore < b.aspectScore) return 1;
    } else {
      if (a.aspectScore < b.aspectScore) return -1;
      if (a.aspectScore > b.aspectScore) return 1;
    }
    return b.size - a.size;
  });

  return potentialExpansions[0].cells;
}

function findBestFillExpansion(grid, roomId, preferredDir = null) {
  const bbox = grid.getBoundingBox(roomId);
  if (!bbox) return null;

  const potentialExpansions = [];

  const directions = [
    { dir: 'W', dx: -1, dy: 0, axis: 'y', start: bbox.minY, end: bbox.maxY },
    { dir: 'E', dx: 1, dy: 0, axis: 'y', start: bbox.minY, end: bbox.maxY },
    { dir: 'N', dx: 0, dy: -1, axis: 'x', start: bbox.minX, end: bbox.maxX },
    { dir: 'S', dx: 0, dy: 1, axis: 'x', start: bbox.minX, end: bbox.maxX }
  ];

  for (const { dir, dx, dy, axis, start, end } of directions) {
    const newXOrY = (dx !== 0) ? (dx > 0 ? bbox.maxX + 1 : bbox.minX - 1) : (dy > 0 ? bbox.maxY + 1 : bbox.minY - 1);

    let currentSegment = [];
    for (let i = start; i <= end; i++) {
      const x = (axis === 'x') ? i : newXOrY;
      const y = (axis === 'y') ? i : newXOrY;

      if (grid.getCell(x, y) === 0) {
        currentSegment.push({ x, y });
      } else {
        if (currentSegment.length > 1) {
          potentialExpansions.push({ cells: currentSegment, dir });
        }
        currentSegment = [];
      }
    }
    if (currentSegment.length > 1) {
      potentialExpansions.push({ cells: currentSegment, dir });
    }
  }

  if (potentialExpansions.length === 0) return null;

  potentialExpansions.forEach(exp => {
      let tempMinX = bbox.minX, tempMinY = bbox.minY, tempMaxX = bbox.maxX, tempMaxY = bbox.maxY;
      for(const cell of exp.cells) {
          tempMinX = Math.min(tempMinX, cell.x);
          tempMaxX = Math.max(tempMaxX, cell.x);
          tempMinY = Math.min(tempMinY, cell.y);
          tempMaxY = Math.max(tempMaxY, cell.y);
      }
      const newW = tempMaxX - tempMinX + 1;
      const newD = tempMaxY - tempMinY + 1;
      exp.aspectScore = aspectRatio(newW, newD);
      exp.size = exp.cells.length;
  });

  potentialExpansions.sort((a, b) => {
    // Preferred direction always ranks before non-preferred directions
    if (preferredDir) {
      const aPref = a.dir === preferredDir ? 1 : 0;
      const bPref = b.dir === preferredDir ? 1 : 0;
      if (aPref !== bPref) return bPref - aPref;
    }
    if (a.aspectScore < b.aspectScore) return -1;
    if (a.aspectScore > b.aspectScore) return 1;
    return b.size - a.size;
  });

  return potentialExpansions.length > 0 ? potentialExpansions[0].cells : null;
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

/**
 * Counts the number of vertices (corners) of a room's orthogonal polygon on the grid.
 * A rectangle has 4, L-shape has 6, U-shape has 8.
 */
function countRoomVertices(grid, roomId) {
    const bbox = grid.getBoundingBox(roomId);
    if (!bbox) return 0;

    let vertices = 0;
    // Check all intersection points in and around the bounding box
    for (let y = bbox.minY; y <= bbox.maxY + 1; y++) {
        for (let x = bbox.minX; x <= bbox.maxX + 1; x++) {
            let count = 0;
            if (grid.getCell(x - 1, y - 1) === roomId) count++;
            if (grid.getCell(x, y - 1) === roomId) count++;
            if (grid.getCell(x - 1, y) === roomId) count++;
            if (grid.getCell(x, y) === roomId) count++;

            if (count === 1 || count === 3) {
                vertices++;
            } else if (count === 2) {
                // Diagonal cells of the same room meeting at this vertex
                if ((grid.getCell(x - 1, y - 1) === roomId && grid.getCell(x, y) === roomId) ||
                    (grid.getCell(x, y - 1) === roomId && grid.getCell(x - 1, y) === roomId)) {
                    vertices += 2;
                }
            }
            if (vertices > 8) return vertices; // 早退：超限后无需继续
        }
    }
    return vertices;
}

// ── Checkpoint A Relaxed Door-Access helpers ─────────────────────────────────

/**
 * BFS over empty cells (value === 0) to extract connected empty regions.
 * Returns both metadata (id, cells) and a 2D grid of region IDs.
 */
function getConnectedEmptyRegions(grid) {
  const regionIdGrid = Array(grid.height).fill(null).map(() => Array(grid.width).fill(-1));
  const regions = []; 

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (!grid.getCell(x, y) && regionIdGrid[y][x] === -1) {
        const regionId = regions.length;
        const regionCells = [];
        const queue = [x, y];
        regionIdGrid[y][x] = regionId;
        let head = 0;

        while (head < queue.length) {
          const cx = queue[head++];
          const cy = queue[head++];
          regionCells.push({x: cx, y: cy});

          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && nx < grid.width && ny >= 0 && ny < grid.height) {
              if (!grid.getCell(nx, ny) && regionIdGrid[ny][nx] === -1) {
                regionIdGrid[ny][nx] = regionId;
                queue.push(nx, ny);
              }
            }
          }
        }
        regions.push({ id: regionId, cells: regionCells });
      }
    }
  }
  return { regions, regionIdGrid };
}

/**
 * Traces the boundary of an empty region clockwise and returns the circular sequence
 * of adjacent room IDs (or 'EXTERIOR').
 */
function getRegionBoundarySequence(grid, regionIdGrid, regionId) {
  const cells = new Set();
  let startX = Infinity, startY = Infinity;
  
  // Find all cells and the top-leftmost one to start
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (regionIdGrid[y][x] === regionId) {
        cells.add(`${x},${y}`);
        if (y < startY || (y === startY && x < startX)) {
          startX = x; startY = y;
        }
      }
    }
  }
  if (cells.size === 0) return [];

  const sequence = [];
  const visitedEdges = new Set();
  
  // Directions: 0:North, 1:East, 2:South, 3:West
  const dx = [0, 1, 0, -1];
  const dy = [-1, 0, 1, 0];

  function getNeighborId(x, y, dir) {
    const nx = x + dx[dir], ny = y + dy[dir];
    if (nx < 0 || nx >= grid.width || ny < 0 || ny >= grid.height) {
      return ny === grid.height ? -1 : 'EXTERIOR'; // South wall is not 'EXTERIOR' for access
    }
    const val = grid.getCell(nx, ny);
    return !val ? null : val; // null if it's another empty cell (0, null, undef)
  }

  // Find the first external edge (North edge of top-left cell is guaranteed to be an edge)
  let curX = startX, curY = startY, curDir = 0; 
  const startEdge = `${curX},${curY},${curDir}`;

  // Simple edge-following algorithm
  let safety = 0;
  while (safety++ < 2000) {
    const edgeKey = `${curX},${curY},${curDir}`;
    if (visitedEdges.has(edgeKey)) break;
    visitedEdges.add(edgeKey);

    const neighbor = getNeighborId(curX, curY, curDir);
    if (neighbor && neighbor !== -1) {
      sequence.push(neighbor);
    }

    // Try to turn "right" (clockwise)
    const rightDir = (curDir + 1) % 4;
    const rx = curX + dx[rightDir], ry = curY + dy[rightDir];

    if (cells.has(`${rx},${ry}`)) {
      // Can move into the right cell, so turn right and move
      curX = rx; curY = ry;
      curDir = (curDir + 3) % 4; // Face "left" relative to new cell to continue boundary
    } else {
      // Cannot move right. Check if we can move forward.
      const fx = curX + dx[curDir], fy = curY + dy[curDir];
      if (cells.has(`${fx},${fy}`)) {
        // Can move forward
        curX = fx; curY = fy;
        // Keep same direction
      } else {
        // Cannot move right or forward, so must turn left and stay.
        curDir = (curDir + 3) % 4;
      }
    }
  }

  // Simplify: collapse consecutive duplicates, and handle circular wrap
  const simplified = [];
  for (const id of sequence) {
    if (simplified.length === 0 || simplified[simplified.length - 1] !== id) {
      simplified.push(id);
    }
  }
  if (simplified.length > 1 && simplified[0] === simplified[simplified.length - 1]) {
    simplified.pop();
  }
  return simplified;
}

/**
 * Checks if a set of required connections (pairs) can be satisfied by non-crossing
 * chords within a circular sequence of IDs.
 */
function canSatisfyNonCrossing(sequence, pairs) {
  if (pairs.length === 0) return true;
  
  // Map each ID to its indices in the sequence
  const idToIndices = {};
  sequence.forEach((id, idx) => {
    if (!idToIndices[id]) idToIndices[id] = [];
    idToIndices[id].push(idx);
  });

  // Check if all needed IDs are even present
  for (const [a, b] of pairs) {
    if (!idToIndices[a] || !idToIndices[b]) return false;
  }

  const n = sequence.length;

  function crosses(chord1, chord2) {
    let [a, b] = chord1;
    let [c, d] = chord2;
    if (a > b) [a, b] = [b, a];
    if (c > d) [c, d] = [d, c];
    // Two chords (a,b) and (c,d) cross if one endpoint of (c,d) is inside (a,b) 
    // and the other is outside.
    const cIn = c > a && c < b;
    const dIn = d > a && d < b;
    return cIn !== dIn;
  }

  function solve(pairIdx, activeChords) {
    if (pairIdx === pairs.length) return true;
    
    const [idA, idB] = pairs[pairIdx];
    for (const i of idToIndices[idA]) {
      for (const j of idToIndices[idB]) {
        if (i === j) continue;
        const newChord = [i, j];
        
        let valid = true;
        for (const existing of activeChords) {
          if (crosses(newChord, existing)) {
            valid = false; break;
          }
        }
        
        if (valid) {
          if (solve(pairIdx + 1, [...activeChords, newChord])) return true;
        }
      }
    }
    return false;
  }

  return solve(0, []);
}

/**
 * Relaxed door-access check for Checkpoint A.
 * Multiple rooms can share an empty region if their topological paths don't cross.
 */
export function computeRelaxedDoorAccess(groundGrid, level1Grid) {
  const { doorAccessPenalty } = SCORER_PARAMS;
  const ids = [];
  const bridgedIds = new Set();
  const violationsWithDetails = [];

  function processFloor(grid, mustExt, extraPairs = []) {
    const { regions, regionIdGrid } = getConnectedEmptyRegions(grid);
    const unmet = [];
    
    // Initial strict check
    for (const roomId of mustExt) {
      if (!grid.roomData[roomId]) continue;
      const p = bboxToPlacement(grid.getBoundingBox(roomId));
      if (!touchesExteriorNonSouth(p, grid.width * GRID_SIZE, grid.height * GRID_SIZE)) {
        unmet.push({ room: roomId, target: 'EXTERIOR' });
      }
    }
    for (const [a, b] of extraPairs) {
      if (!grid.roomData[a] || !grid.roomData[b]) continue;
      const pA = bboxToPlacement(grid.getBoundingBox(a));
      const pB = bboxToPlacement(grid.getBoundingBox(b));
      const bW = grid.width * GRID_SIZE, bD = grid.height * GRID_SIZE;
      const directlyAdjacent = adjacent(pA, pB);
      const aExtOk = directlyAdjacent || touchesExteriorNonSouth(pA, bW, bD);
      const bExtOk = directlyAdjacent || touchesExteriorNonSouth(pB, bW, bD);
      if (!aExtOk) unmet.push({ room: a, target: b });
      if (!bExtOk) unmet.push({ room: b, target: a });
    }

    if (unmet.length === 0) return;

    // Try to satisfy unmet requirements through regions
    const satisfiedInFloor = new Set();

    for (const region of regions) {
      const sequence = getRegionBoundarySequence(grid, regionIdGrid, region.id);
      if (sequence.length === 0) continue;

      // Find all remaining requirements that this region *could* satisfy
      const possible = unmet.filter(req => !satisfiedInFloor.has(req.room) && 
                                           sequence.includes(req.room) && 
                                           sequence.includes(req.target));
      
      if (possible.length === 0) continue;

      // Try to satisfy as many as possible (Topological Non-Crossing)
      // Greedy approach: try largest subset, then smaller ones
      for (let size = possible.length; size >= 1; size--) {
        // Simple case: try all at once first
        const subset = possible.slice(0, size);
        const pairs = subset.map(r => [r.room, r.target]);
        if (canSatisfyNonCrossing(sequence, pairs)) {
          subset.forEach(s => {
            satisfiedInFloor.add(s.room);
            bridgedIds.add(s.room);
          });
          break;
        }
      }
    }

    // Add remaining truly unmet to global list
    unmet.forEach(req => {
      if (!satisfiedInFloor.has(req.room)) {
        if (!ids.includes(req.room)) {
          ids.push(req.room);

          const debugInfo = { sequences: [] };
          const source = req.target === 'EXTERIOR' ? 'touchesExteriorNonSouth' : 'parkingRepairAdjExt';

          let criticalSequence = null;
          let candidateRegions = [];

          for (const region of regions) {
            const sequence = getRegionBoundarySequence(grid, regionIdGrid, region.id);
            const touchesRoom = sequence.includes(req.room);
            const touchesTarget = sequence.includes(req.target);

            if (touchesRoom) {
                candidateRegions.push({id: region.id, sequence});
            }

            if (touchesRoom && touchesTarget) {
                criticalSequence = sequence;
                break; // Found the critical one
            }
          }

          if (criticalSequence) {
            debugInfo.sequences.push(criticalSequence);
            debugInfo.failureReason = '拓扑检查失败';
          } else {
            debugInfo.sequences = candidateRegions.map(r => r.sequence);
            debugInfo.failureReason = '无桥接区域';
          }

          violationsWithDetails.push({ id: req.room, source, debug: debugInfo });
        }
      }
    });
  }

  // Ground Floor: Exterior access for main rooms + Mutual access for parking/repair
  processFloor(groundGrid, GROUND_MUST_EXT, [['parking', 'repair_zone']]);

  // Level 1: Corridor access (custom one-way check)
  const { regions: l1Regions, regionIdGrid: l1RegionIdGrid } = getConnectedEmptyRegions(level1Grid);
  const corridorPlaced = !!level1Grid.roomData['corridor_l1'];
  for (const roomId of LEVEL1_MUST_FACE_CORRIDOR) {
    if (!level1Grid.roomData[roomId]) continue;

    const pRoom = bboxToPlacement(level1Grid.getBoundingBox(roomId));
    const pCorr = corridorPlaced ? bboxToPlacement(level1Grid.getBoundingBox('corridor_l1')) : null;

    if (pCorr && adjacent(pRoom, pCorr)) {
      continue; // Strictly adjacent, OK.
    }

    // Not strictly adjacent, try to find a bridge
    let bridgeFound = false;
    for (const region of l1Regions) {
      const sequence = getRegionBoundarySequence(level1Grid, l1RegionIdGrid, region.id);
      if (sequence.includes(roomId) && sequence.includes('corridor_l1') &&
          canSatisfyNonCrossing(sequence, [[roomId, 'corridor_l1']])) {
        bridgedIds.add(roomId);
        bridgeFound = true;
        break;
      }
    }

    if (!bridgeFound) {
      ids.push(roomId); // Truly unmet
      const debugInfo = { sequences: [] };
      let criticalSequence = null;
      let candidateRegions = [];

      for (const region of l1Regions) {
        const sequence = getRegionBoundarySequence(level1Grid, l1RegionIdGrid, region.id);
        const touchesRoom = sequence.includes(roomId);
        const touchesCorridor = sequence.includes('corridor_l1');

        if (touchesRoom) {
            candidateRegions.push({id: region.id, sequence});
        }

        if (touchesRoom && touchesCorridor) {
            criticalSequence = sequence;
            break;
        }
      }

      if (criticalSequence) {
        // We found the region that touches both, but it failed the topo check.
        debugInfo.sequences.push(criticalSequence);
        debugInfo.failureReason = '拓扑检查失败';
      } else {
        // No single region touches both. This is an isolation problem.
        debugInfo.sequences = candidateRegions.map(r => r.sequence);
        debugInfo.failureReason = '无桥接区域';
      }

      violationsWithDetails.push({ id: roomId, source: 'adjacentToCorridor', debug: debugInfo });
    }
  }

  // ── MUST adjacency bridging ───────────────────────────────────────────────
  // MUST 邻接对（meter_main↔meter_sub, trafo1↔trafo2）与可达性规则在算法层面
  // 完全一致：允许通过空白区域作为虚拟中间节点来满足 Phase 1 的宽松评价。
  // 通过桥接的对以 'a↔b' 形式记入 bridgedPairKeys，用于过滤 violations[]。
  const bridgedPairKeys = new Set();
  const bridgeDebugInfo = {};

  // 按楼层分组处理（当前 ADJACENCY_MUST 均为地面层房间）
  const groundMustPairs = ADJACENCY_MUST.filter(({ pair: [a, b] }) =>
    groundGrid.roomData[a] || groundGrid.roomData[b]
  );
  if (groundMustPairs.length > 0) {
    const { regions, regionIdGrid } = getConnectedEmptyRegions(groundGrid);
    for (const { pair: [a, b] } of groundMustPairs) {
      if (!groundGrid.roomData[a] || !groundGrid.roomData[b]) continue;
      const pA = bboxToPlacement(groundGrid.getBoundingBox(a));
      const pB = bboxToPlacement(groundGrid.getBoundingBox(b));
      if (adjacent(pA, pB)) continue; // 已直接相邻，无需桥接

      const debugTouches = { [a]: [], [b]: [] };
      let bridgeFound = false;

      // 尝试通过空白区域桥接：找到同时接触 a 和 b 的连通空白域
      for (const region of regions) {
        const sequence = getRegionBoundarySequence(groundGrid, regionIdGrid, region.id);
        const touchesA = sequence.includes(a);
        const touchesB = sequence.includes(b);
        if (touchesA) debugTouches[a].push(region.id);
        if (touchesB) debugTouches[b].push(region.id);

        if (touchesA && touchesB &&
            canSatisfyNonCrossing(sequence, [[a, b]])) {
          bridgedPairKeys.add(`${a}↔${b}`);
          bridgeFound = true;
          break;
        }
      }

      if (!bridgeFound) {
        let debugMsg = `${a} 接触区域[${debugTouches[a].join(',') || '无'}], ${b} 接触区域[${debugTouches[b].join(',') || '无'}].`;
        const common = debugTouches[a].filter(id => debugTouches[b].includes(id));
        if (common.length > 0) {
          debugMsg += ` 共同区域[${common.join(',')}]但拓扑检查失败。`;
        } else {
          debugMsg += ' 无共同区域。';
        }
        bridgeDebugInfo[`${a}↔${b}`] = debugMsg;
      }
      // 若未桥接：must_adjacent violation 保留在 violations[] 中，Checkpoint A 正常失败
    }
  }

  return { penalty: -doorAccessPenalty * ids.length, ids, bridgedIds, bridgedPairKeys, bridgeDebugInfo, violationsWithDetails };
}

// ── Phase 2 Accessibility helpers ────────────────────────────────────────────

/** Convert grid bounding box (cell units) to mm-based placement object. */
function bboxToPlacement(bbox) {
  return {
    x: bbox.minX * GRID_SIZE,
    y: bbox.minY * GRID_SIZE,
    w: (bbox.maxX - bbox.minX + 1) * GRID_SIZE,
    d: (bbox.maxY - bbox.minY + 1) * GRID_SIZE
  };
}

/**
 * Check whether a room's accessibility requirement is already satisfied
 * given the current grid state. Used by Phase 2 to determine growth priority.
 *
 * @param {string} roomId
 * @param {Grid} grid
 * @param {number} buildingW
 * @param {number} buildingD
 * @param {Map} superRoomMeta - Optional: Map from superId to {mustExt, mustCorridor}
 */
function isAccessibilityMet(roomId, grid, buildingW, buildingD, superRoomMeta = null) {
  const bbox = grid.getBoundingBox(roomId);
  if (!bbox) return true;
  const p = bboxToPlacement(bbox);

  if (GROUND_MUST_EXT.includes(roomId)) {
    return touchesExteriorNonSouth(p, buildingW, buildingD);
  }
  if (LEVEL1_MUST_FACE_CORRIDOR.includes(roomId)) {
    const corrBbox = grid.getBoundingBox('corridor_l1');
    if (!corrBbox) return false;
    return adjacent(p, bboxToPlacement(corrBbox));
  }
  if (roomId === 'repair_zone') {
    const parkBbox = grid.getBoundingBox('parking');
    if (!parkBbox) return false;
    return adjacent(p, bboxToPlacement(parkBbox)) || touchesExteriorNonSouth(p, buildingW, buildingD);
  }

  // Super-room accessibility check
  if (superRoomMeta?.has(roomId)) {
    const meta = superRoomMeta.get(roomId);
    if (meta.mustExt) return touchesExteriorNonSouth(p, buildingW, buildingD);
    if (meta.mustCorridor) {
      const corrBbox = grid.getBoundingBox('corridor_l1');
      if (!corrBbox) return false;
      return adjacent(p, bboxToPlacement(corrBbox));
    }
    return true; // No special accessibility requirement
  }

  // MUST 邻接：与可达性规则保持算法一致，未满足则视为"可达性未达标"
  for (const { pair: [a, b] } of ADJACENCY_MUST) {
    if (roomId !== a && roomId !== b) continue;
    const partnerId = roomId === a ? b : a;
    const partnerBbox = grid.getBoundingBox(partnerId);
    if (!partnerBbox) return false;
    if (!adjacent(p, bboxToPlacement(partnerBbox))) return false;
  }
  return true;
}

/**
 * Return the preferred expansion direction for a room that has not yet met
 * its accessibility requirement. Returns 'W'|'E'|'N'|'S'|null.
 *
 * @param {string} roomId
 * @param {Grid} grid
 * @param {number} buildingW
 * @param {number} buildingD
 * @param {Map} superRoomMeta - Optional: Map from superId to {mustExt, mustCorridor}
 */
function getPreferredDirection(roomId, grid, buildingW, buildingD, superRoomMeta = null) {
  const bbox = grid.getBoundingBox(roomId);
  if (!bbox) return null;
  const cx = (bbox.minX + bbox.maxX + 1) / 2 * GRID_SIZE;
  const cy = (bbox.minY + bbox.maxY + 1) / 2 * GRID_SIZE;

  if (GROUND_MUST_EXT.includes(roomId)) {
    // Nearest of west / north / east exterior walls
    const distW = cx;
    const distN = cy;
    const distE = buildingW - cx;
    const minDist = Math.min(distW, distN, distE);
    if (minDist === distW) return 'W';
    if (minDist === distN) return 'N';
    return 'E';
  }
  if (LEVEL1_MUST_FACE_CORRIDOR.includes(roomId)) {
    const corrBbox = grid.getBoundingBox('corridor_l1');
    if (!corrBbox) return null;
    const corrCx = (corrBbox.minX + corrBbox.maxX + 1) / 2 * GRID_SIZE;
    const corrCy = (corrBbox.minY + corrBbox.maxY + 1) / 2 * GRID_SIZE;
    const dx = corrCx - cx;
    const dy = corrCy - cy;
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'E' : 'W';
    return dy > 0 ? 'S' : 'N';
  }
  if (roomId === 'repair_zone') {
    const parkBbox = grid.getBoundingBox('parking');
    if (!parkBbox) return null;
    const parkCx = (parkBbox.minX + parkBbox.maxX + 1) / 2 * GRID_SIZE;
    const parkCy = (parkBbox.minY + parkBbox.maxY + 1) / 2 * GRID_SIZE;
    const dx = parkCx - cx;
    const dy = parkCy - cy;
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'E' : 'W';
    return dy > 0 ? 'S' : 'N';
  }

  // Super-room preferred direction
  if (superRoomMeta?.has(roomId)) {
    const meta = superRoomMeta.get(roomId);
    if (meta.mustExt) {
      const distW = cx;
      const distN = cy;
      const distE = buildingW - cx;
      const minDist = Math.min(distW, distN, distE);
      if (minDist === distW) return 'W';
      if (minDist === distN) return 'N';
      return 'E';
    }
    if (meta.mustCorridor) {
      const corrBbox = grid.getBoundingBox('corridor_l1');
      if (!corrBbox) return null;
      const corrCx = (corrBbox.minX + corrBbox.maxX + 1) / 2 * GRID_SIZE;
      const corrCy = (corrBbox.minY + corrBbox.maxY + 1) / 2 * GRID_SIZE;
      const dx = corrCx - cx;
      const dy = corrCy - cy;
      if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'E' : 'W';
      return dy > 0 ? 'S' : 'N';
    }
    return null;
  }

  // MUST 邻接：朝向未满足的邻接伙伴中心方向
  for (const { pair: [a, b] } of ADJACENCY_MUST) {
    if (roomId !== a && roomId !== b) continue;
    const partnerId = roomId === a ? b : a;
    const partnerBbox = grid.getBoundingBox(partnerId);
    if (!partnerBbox) return null;
    const partnerCx = (partnerBbox.minX + partnerBbox.maxX + 1) / 2 * GRID_SIZE;
    const partnerCy = (partnerBbox.minY + partnerBbox.maxY + 1) / 2 * GRID_SIZE;
    const dx = partnerCx - cx;
    const dy = partnerCy - cy;
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'E' : 'W';
    return dy > 0 ? 'S' : 'N';
  }
  return null;
}

function expandRooms(grid, rooms, rng, { buildingW, buildingD, superRoomMeta }, stopAfterStage1 = false, ignoreAreaLimit = false) {
    let iterations = 0;
    let stage = 1; // Stage 1: Rectangular only, Stage 2: All types allowed
    // currentArea is now in grid cell counts
    let growingRooms = rooms.map(r => ({
      ...r,
      currentArea: grid.roomData[r.id] ? grid.roomData[r.id].length : 0
    }));

    if (ignoreAreaLimit) {
      console.log('[expandRooms] ignoreAreaLimit=true 模式', { stage, roomCount: growingRooms.length, stopAfterStage1 });
      growingRooms.forEach(r => {
        if (!r.targetGridCount) console.warn(`[expandRooms] 房间${r.id}缺少targetGridCount`, r);
      });
    }

    let needsSort = true;

    // 性能累计计时（仅 debugModeEnabled 时启用）
    const _t = window.debugModeEnabled ? {
      isAccessibilityMet: 0, findBestRect: 0, findBestFill: 0,
      findSmartLine: 0, expansionCellsSome: 0, countVertices: 0,
    } : null;
    const _label = stopAfterStage1 ? 'phase1' : 'phase2';
    const _floor = rooms[0]?.floor ?? 'unknown';

    while (iterations < MAX_EXPANSION_ITERATIONS) {
        // Stage 2: also include rooms that haven't met accessibility, even if they've reached
        // their area target — they need to keep growing toward the exterior wall / corridor.
        let activeRooms;
        if (ignoreAreaLimit) {
          activeRooms = growingRooms; // Grow all rooms regardless of area
        } else if (stage === 2) {
          activeRooms = growingRooms.filter(room => {
            if (room.currentArea < room.targetGridCount) return true;
            const t0 = _t ? performance.now() : 0;
            const r = !isAccessibilityMet(room.id, grid, buildingW, buildingD, superRoomMeta);
            if (_t) _t.isAccessibilityMet += performance.now() - t0;
            return r;
          });
        } else {
          activeRooms = growingRooms.filter(room => room.currentArea < room.targetGridCount);
        }

        // If all rooms reached their target area (and accessibility in Stage 2)
        if (activeRooms.length === 0) {
            if (stage === 1) {
                            }
            break;
        }

        // Sort rooms by priority:
        // Stage 1: area completion ratio only (lower ratio = higher priority)
        // Stage 2: accessibility-unmet rooms first, then by area completion ratio
        if (needsSort) {
          if (stage === 2) {
            activeRooms.sort((a, b) => {
              const t0 = _t ? performance.now() : 0;
              const aOk = isAccessibilityMet(a.id, grid, buildingW, buildingD, superRoomMeta);
              const bOk = isAccessibilityMet(b.id, grid, buildingW, buildingD, superRoomMeta);
              if (_t) _t.isAccessibilityMet += performance.now() - t0;
              if (aOk !== bOk) return aOk ? 1 : -1;
              return (a.currentArea / a.targetGridCount) - (b.currentArea / b.targetGridCount);
            });
            // Log Stage 2 priority order
            if (window.debugLayoutPhase2) {
              activeRooms.forEach((room, idx) => {
                const pct = Math.round(room.currentArea / room.targetGridCount * 100);
                const ok = isAccessibilityMet(room.id, grid, buildingW, buildingD, superRoomMeta);
                debugLog(2, `Priority ${idx + 1}: ${room.id} (${pct}% area, accessibility=${ok})`, {
                  roomId: room.id,
                  areaPercent: pct,
                  accessibility: ok,
                  order: idx
                });
              });
            }
          } else {
            activeRooms.sort((a, b) => {
              const t0 = _t ? performance.now() : 0;
              const aOk = isAccessibilityMet(a.id, grid, buildingW, buildingD, superRoomMeta);
              const bOk = isAccessibilityMet(b.id, grid, buildingW, buildingD, superRoomMeta);
              if (_t) _t.isAccessibilityMet += performance.now() - t0;
              if (aOk !== bOk) return aOk ? 1 : -1;
              return (a.currentArea / a.targetGridCount) - (b.currentArea / b.targetGridCount);
            });
          }
          needsSort = false;
        }

        let growthHappenedThisCycle = false;

        if (stage === 1) {
            // Stage 1: Try strictly rectangular expansion for ALL rooms
            for (const roomToGrow of activeRooms) {
                const isCorridor = roomToGrow.id === 'corridor_l1';
                // 若 MUST 邻接未满足，加方向偏置朝向伙伴
                const mustOk = isAccessibilityMet(roomToGrow.id, grid, buildingW, buildingD, superRoomMeta);
                const prefDir = mustOk ? null : getPreferredDirection(roomToGrow.id, grid, buildingW, buildingD, superRoomMeta);
                const _t1 = _t ? performance.now() : 0;
                let expansionCells = findBestRectangleExpansion(grid, roomToGrow.id, isCorridor, prefDir);
                if (_t) _t.findBestRect += performance.now() - _t1;
                if (expansionCells && expansionCells.length > 0) {
                    // To keep it a rectangle, we MUST add the entire line.
                    // If adding the entire line makes us overgrow significantly, 
                    // we could stop, but usually adding one more edge is better than a jagged L-shape.
                    // However, to be most balanced: we only grow if the current area is still below target.
                    for (const cell of expansionCells) {
                        grid.addRoomCell(roomToGrow.id, cell.x, cell.y);
                        roomToGrow.currentArea++;
                    }
                    growthHappenedThisCycle = true;
                    needsSort = true;
                    break; // Only grow one room per cycle to re-evaluate sorting
                }
            }

            // If no room could grow rectangularly, Stage 1 is complete
            if (!growthHappenedThisCycle) {
                if (ignoreAreaLimit) {
                  console.log('[expandRooms] Stage1无矩形扩展，进入Stage2进行L/U形扩展', { iterations, activeRoomsCount: activeRooms.length });
                }
                // If stopAfterStage1 is enabled, stop here; otherwise proceed to Phase 2
                if (!stopAfterStage1) {
                    stage = 2; // Proceed to L/U shape phase
                    continue; // Restart the while loop for Stage 2
                } else {
                    break; // Stop completely for Checkpoint A evaluation
                }
            }
        } else if (stage === 2) {
            // Stage 2: Allow all types of expansion
            if (ignoreAreaLimit && iterations === 0) {
              console.log('[expandRooms] Stage2开始，activeRooms数量:', activeRooms.map(r => r.id).join(','));
            }
            for (const roomToGrow of activeRooms) {
                const isCorridor = roomToGrow.id === 'corridor_l1';

                // Compute accessibility direction bias for rooms that haven't met their requirement
                const accessOk = isAccessibilityMet(roomToGrow.id, grid, buildingW, buildingD, superRoomMeta);
                const prefDir = accessOk ? null : getPreferredDirection(roomToGrow.id, grid, buildingW, buildingD, superRoomMeta);

                let _t2 = _t ? performance.now() : 0;
                let expansionCells = findBestRectangleExpansion(grid, roomToGrow.id, isCorridor, prefDir);
                const expansionIsRect = !!expansionCells;
                if (_t) { _t.findBestRect += performance.now() - _t2; _t2 = performance.now(); }

                if (!expansionCells) {
                    expansionCells = findBestFillExpansion(grid, roomToGrow.id, prefDir);
                    if (_t) { _t.findBestFill += performance.now() - _t2; _t2 = performance.now(); }
                    // Log L/U form expansion attempt
                    if (window.debugLayoutPhase2) {
                      debugLog(2, `${roomToGrow.id} L/U fill expansion: ${expansionCells ? expansionCells.length : 0} cells`, {
                        roomId: roomToGrow.id,
                        type: 'fillExpansion',
                        cellsAdded: expansionCells ? expansionCells.length : 0,
                        prefDir
                      });
                    }
                }

                if (!expansionCells) {
                    // findSmartLineExpansion: concave-fill logic is self-converging; no dir bias needed
                    expansionCells = findSmartLineExpansion(grid, roomToGrow.id);
                    if (_t) _t.findSmartLine += performance.now() - _t2;
                    // Log smart line expansion attempt
                    if (window.debugLayoutPhase2) {
                      debugLog(2, `${roomToGrow.id} smart line expansion: ${expansionCells ? expansionCells.length : 0} cells`, {
                        roomId: roomToGrow.id,
                        type: 'smartLineExpansion',
                        cellsAdded: expansionCells ? expansionCells.length : 0
                      });
                    }
                }

                if (ignoreAreaLimit && expansionCells && expansionCells.length > 0) {
                  console.log(`[expandRooms] ${roomToGrow.id}找到${expansionIsRect ? '矩形' : 'L/U'}扩展:${expansionCells.length}个格子`);
                }

                if (expansionCells && expansionCells.length > 0) {
                    // Build a lightweight dry-run test grid (shared by all guards below)
                    const originalCells = [...(grid.roomData[roomToGrow.id] || [])];
                    const expansionSet = new Set(expansionCells.map(c => c.x * 100000 + c.y));
                    const testGrid = {
                        getCell: (x, y) => {
                            if (expansionSet.has(x * 100000 + y)) return roomToGrow.id;
                            return grid.getCell(x, y);
                        },
                        getBoundingBox: (id) => {
                            if (id !== roomToGrow.id) return grid.getBoundingBox(id);
                            const combined = [...originalCells, ...expansionCells];
                            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                            for (const c of combined) {
                                if (c.x < minX) minX = c.x;
                                if (c.x > maxX) maxX = c.x;
                                if (c.y < minY) minY = c.y;
                                if (c.y > maxY) maxY = c.y;
                            }
                            return { minX, minY, maxX, maxY };
                        }
                    };

                    // 走廊最小宽度守护：只有当生长会使走廊比当前更窄且仍低于最小宽度时才阻止
                    if (isCorridor) {
                        const currentMinWidth = getRoomMinCrossWidth(grid, roomToGrow.id);
                        const newMinWidth = getRoomMinCrossWidth(testGrid, roomToGrow.id);
                        if (newMinWidth < currentMinWidth && newMinWidth < CORRIDOR_MIN_WIDTH_CELLS) {
                            continue;
                        }
                    }

                    // Morphological constraint: limit non-corridor rooms to 8 vertices (U-shape)
                    // 始终在 testGrid 上重新计算：矩形扩展对已是非矩形的房间同样可能增加顶点数。
                    if (!isCorridor) {
                        const _tv = _t ? performance.now() : 0;
                        const vcount = countRoomVertices(testGrid, roomToGrow.id);
                        if (_t) _t.countVertices += performance.now() - _tv;
                        if (vcount > 8) {
                            continue;
                        }
                    }

                    const cellsToAdd = ignoreAreaLimit
                        ? expansionCells
                        : expansionCells.slice(0, roomToGrow.targetGridCount - roomToGrow.currentArea);
                    if (cellsToAdd.length === 0) continue;

                    // 若截断改变了扩展形状，需对截断子集重新验证顶点约束
                    if (!isCorridor && !expansionIsRect && cellsToAdd.length < expansionCells.length) {
                        const truncSet = new Set(cellsToAdd.map(c => c.x * 100000 + c.y));
                        const truncGrid = {
                            getCell: (x, y) => truncSet.has(x * 100000 + y) ? roomToGrow.id : grid.getCell(x, y),
                            getBoundingBox: (id) => {
                                if (id !== roomToGrow.id) return grid.getBoundingBox(id);
                                const combined = [...originalCells, ...cellsToAdd];
                                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                                for (const c of combined) {
                                    if (c.x < minX) minX = c.x;
                                    if (c.x > maxX) maxX = c.x;
                                    if (c.y < minY) minY = c.y;
                                    if (c.y > maxY) maxY = c.y;
                                }
                                return { minX, minY, maxX, maxY };
                            }
                        };
                        const _tv2 = _t ? performance.now() : 0;
                        const truncV = countRoomVertices(truncGrid, roomToGrow.id);
                        if (_t) _t.countVertices += performance.now() - _tv2;
                        if (truncV > 8) continue;
                    }

                    for (const cell of cellsToAdd) {
                        grid.addRoomCell(roomToGrow.id, cell.x, cell.y);
                        roomToGrow.currentArea++;
                    }
                    growthHappenedThisCycle = true;
                    needsSort = true;
                    break;
                }
            }

            if (!growthHappenedThisCycle) {
                if (ignoreAreaLimit) {
                  console.warn(`[expandRooms] Stage2卡住，无法继续扩展。迭代次数:${iterations}`);
                } else {
                  console.warn("Expansion stuck. No rooms could grow in Stage 2.");
                }
                break;
            }
        }

        iterations++;
    }

    if (iterations === MAX_EXPANSION_ITERATIONS) {
        const msg = `Expansion reached max iterations (${MAX_EXPANSION_ITERATIONS}).`;
        if (ignoreAreaLimit) {
          console.warn(`[expandRooms] ${msg}`);
        } else {
          console.warn(msg);
        }
    }

    if (ignoreAreaLimit) {
      console.log('[expandRooms] 完成，最终迭代次数:', iterations);
    }

    // Capture the final grid state (always fires regardless of exit path)
    
    if (_t) {
      if (!window.timeCostLog) window.timeCostLog = [];
      for (const [k, v] of Object.entries(_t)) {
        window.timeCostLog.push({ fn: `expandRooms/${_label}_${_floor}/${k}`, duration: v / 1000 });
      }
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

    if (emptyCells.length === 0) {
      if (window.debugLayoutPhase3) {
        debugLog(3, 'fillGaps: no empty cells to fill', {});
      }
      return;
    }
    if (DEBUG_LAYOUT) console.log(`[Layout] fillGaps: ${emptyCells.length} empty cells`);
    if (window.debugLayoutPhase3) {
      debugLog(3, `fillGaps started: ${emptyCells.length} empty cells`, {
        totalEmptyCells: emptyCells.length,
        rooms: rooms.map(r => r.id)
      });
    }

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
                // --- 走廊宽度守护 ---
                // If corridor_l1 is present but still narrower than the minimum width,
                // skip assigning this segment to a non-corridor room so corridor can
                // still claim these cells in a later iteration.
                if (roomId !== 'corridor_l1' && grid.roomData['corridor_l1']) {
                    const isAdjacentToCorridor = seg.cells.some(cell => {
                        const deltas = [{dx:1,dy:0},{dx:-1,dy:0},{dx:0,dy:1},{dx:0,dy:-1}];
                        return deltas.some(({dx,dy}) => grid.getCell(cell.x+dx, cell.y+dy) === 'corridor_l1');
                    });
                    if (isAdjacentToCorridor && getRoomMinCrossWidth(grid, 'corridor_l1') < CORRIDOR_MIN_WIDTH_CELLS) {
                        continue;
                    }
                }

                // --- 2a. 阶段一：优先填充凹角 (方案C) ---
                const reflexAngleScore = calculateConcaveScore(grid, seg, roomId);
                if (reflexAngleScore > 0) {
                    const score = 10000 + reflexAngleScore + seg.cells.length;
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
            if (DEBUG_LAYOUT) console.log(`[Layout] assign seg(${bestSegment.cells.length}) → ${bestRoomId} score=${bestScore.toFixed(2)}`);
            if (window.debugLayoutPhase3) {
              debugLog(3, `Assign segment to ${bestRoomId}`, {
                roomId: bestRoomId,
                cellsAdded: bestSegment.cells.length,
                score: bestScore,
                remainingEmpty: emptyCellSet.size - bestSegment.cells.length
              });
            }
            for (const cell of bestSegment.cells) {
                grid.addRoomCell(bestRoomId, cell.x, cell.y);
                emptyCellSet.delete(`${cell.x},${cell.y}`);
            }
        } else {
             console.warn("没有找到合适的填充方案，终止填充。");
            if (window.debugLayoutPhase3) {
              debugLog(3, 'No more filling candidates found', {
                remainingEmptyCells: emptyCellSet.size
              });
            }
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
            if (n_up && n_up !== 0) neighbors.add(n_up);
            if (n_down && n_down !== 0) neighbors.add(n_down);
        } else { // Vertical
            const n_left = grid.getCell(cell.x - 1, cell.y);
            const n_right = grid.getCell(cell.x + 1, cell.y);
            if (n_left && n_left !== 0) neighbors.add(n_left);
            if (n_right && n_right !== 0) neighbors.add(n_right);
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
        actualArea: grid.roomData[roomId].length * GRID_SIZE * GRID_SIZE,
        vertices: countRoomVertices(grid, roomId)
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

// ── Phase 3 Algorithm Optimization ───────────────────────────────────────────

const PHASE3_AREA_DEVIATION = 0.15  // 面积偏差阈值：超过 15% 视为候选
const SWAP_MAX_CELLS = 4            // 单次转让的最大格子数
const MAX_SWAP_ROUNDS = 30          // 空间交换最大协商轮数


/**
 * 单房间轻量质量评分（用于 areaSwap 交换决策）。
 * 主项：顶点数越少越好（矩形=+200，L形=+100，U形=0）。
 * 次项：bbox 利用率。
 * 约束：面积偏差超过 PHASE3_AREA_DEVIATION 后以大系数惩罚，确保面积不被牺牲。
 */
function computeRoomQuality(grid, room) {
  const cellCount = grid.roomData[room.id]?.length || 0
  const bbox = grid.getBoundingBox(room.id)
  if (!cellCount || !bbox) return 0

  const vertices = countRoomVertices(grid, room.id)
  const cornerScore = (8 - vertices) * 50

  const bboxW = bbox.maxX - bbox.minX + 1
  const bboxH = bbox.maxY - bbox.minY + 1
  const util = cellCount / (bboxW * bboxH)
  const utilScore = util * 30

  const areaDeviation = Math.abs(cellCount / (room.targetGridCount || 1) - 1)
  const areaConstraintPenalty = areaDeviation > PHASE3_AREA_DEVIATION
    ? (areaDeviation - PHASE3_AREA_DEVIATION) * 1000
    : 0

  return cornerScore + utilScore - areaConstraintPenalty
}

/**
 * 验证房间的格子是否仍然连通（BFS）。防止转让操作将房间切断。
 */
function isRoomConnected(grid, roomId) {
  const cells = grid.roomData[roomId]
  if (!cells || cells.length <= 1) return true

  const cellSet = new Set(cells.map(c => `${c.x},${c.y}`))
  const visited = new Set()
  const queue = [cells[0]]
  visited.add(`${cells[0].x},${cells[0].y}`)

  while (queue.length > 0) {
    const { x, y } = queue.shift()
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const key = `${x+dx},${y+dy}`
      if (cellSet.has(key) && !visited.has(key)) {
        visited.add(key)
        queue.push({ x: x+dx, y: y+dy })
      }
    }
  }
  return visited.size === cells.length
}

/**
 * 返回与 roomId 相邻的所有其他房间 ID（去重）。
 */
function findAdjacentRoomIds(grid, roomId) {
  const adjacent = new Set()
  for (const { x, y } of (grid.roomData[roomId] || [])) {
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const neighbor = grid.getCell(x+dx, y+dy)
      if (neighbor && neighbor !== 0 && neighbor !== roomId) adjacent.add(neighbor)
    }
  }
  return [...adjacent]
}


// ── Phase 3b: Area-deviation driven space swap ──────────────────────────────

/**
 * Categorizes rooms into donors (oversized) and recipients (undersized) based on
 * deviation from their target area.
 * @returns {{donors: Array, recipients: Array, roomDataMap: Map<string, object>}}
 */
function categorizeRooms(grid, rooms) {
  const roomDataMap = new Map();

  for (const room of rooms) {
    const currentArea = grid.roomData[room.id]?.length || 0;
    const targetArea = room.targetGridCount;
    if (!targetArea || !currentArea) continue;

    const deviation = (currentArea - targetArea) / targetArea;
    roomDataMap.set(room.id, { id: room.id, currentArea, targetArea, deviation });
  }

  // All rooms are eligible donors and recipients; area constraint is enforced by computeRoomQuality penalty.
  const allRooms = [...roomDataMap.values()];
  return { donors: allRooms, recipients: allRooms, roomDataMap };
}

/**
 * 找到房间的所有凹角（concave corners）所对应的缺口格子。
 * 凹角格点：在该格点的 2×2 邻域中，恰好有 1 或 3 个格子属于 roomId（count=1 或 count=3）。
 * 缺口格子：凹角格点的 2×2 邻域中，不属于 roomId 且属于某邻居房间的格子。
 * @returns {Array<{notchCells: Array<{x,y,roomId}>, corner: {x,y}}>}
 */
/**
 * 找到房间所有 count=3 的凹角格点，返回每个格点及其缺口格子信息。
 * count=3 格点 P=(px,py)：2×2 邻域中恰好 3 格属于 roomId，1 格（缺口）属于邻居。
 * @returns {Array<{px,py,mx,my,ownerId}>}
 */
function findConcaveCorners(grid, roomId) {
  const bbox = grid.getBoundingBox(roomId);
  if (!bbox) return [];

  const corners = [];
  // 格点 (px,py) 对应四个格子：(px-1,py-1),(px,py-1),(px-1,py),(px,py)
  for (let py = bbox.minY; py <= bbox.maxY + 1; py++) {
    for (let px = bbox.minX; px <= bbox.maxX + 1; px++) {
      const quad = [
        { x: px-1, y: py-1 }, { x: px, y: py-1 },
        { x: px-1, y: py   }, { x: px, y: py    },
      ];
      const owned = quad.filter(c => grid.getCell(c.x, c.y) === roomId);
      if (owned.length !== 3) continue; // 只处理 count=3（内凹角）

      // 找唯一缺口格子
      const missing = quad.find(c => grid.getCell(c.x, c.y) !== roomId);
      const ownerId = grid.getCell(missing.x, missing.y);
      // 缺口必须属于真实房间（不是 0/null/-1）
      if (!ownerId || ownerId === 0 || ownerId === -1) continue;

      corners.push({ px, py, mx: missing.x, my: missing.y, ownerId });
    }
  }
  return corners;
}

/**
 * 找到 roomId 中可以让出的回退格子（A→任意邻居），数量等于 count。
 * 优先选择突出的边缘格子（只与一侧 room 相邻，删除后不产生新凹角）。
 * retreatTargetId: 回退格子需与该房间相邻（面积中性的接受方）。
 * @returns {Array<{x,y,targetId}>} 回退格子列表（含目标房间 id）
 */
function findRetreatCells(grid, roomId, excludeIds, count) {
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  // 找所有 roomId 的边界格子（与其他房间相邻）
  const candidates = (grid.roomData[roomId] || []).map(cell => {
    const neighborIds = dirs
      .map(([dx, dy]) => grid.getCell(cell.x+dx, cell.y+dy))
      .filter(v => v && v !== 0 && v !== -1 && v !== roomId && !excludeIds.has(v));
    return neighborIds.length > 0 ? { cell, neighborIds } : null;
  }).filter(Boolean);

  if (candidates.length === 0) return [];

  // 优先选与最多不同邻居相邻的格子（突出格子），按邻居数升序（取最孤立的）
  candidates.sort((a, b) => a.neighborIds.length - b.neighborIds.length);

  const result = [];
  for (const { cell, neighborIds } of candidates) {
    if (result.length >= count) break;
    result.push({ x: cell.x, y: cell.y, targetId: neighborIds[0] });
  }
  return result;
}

/**
 * 在 tempGrid 上执行凹边平直化操作（原子操作，支持多房间 fill）：
 * fillCells: [{x,y,ownerId}]  各格子从对应 ownerId 移入 roomId
 * retreatCells: [{x,y,targetId}]  各格子从 roomId 移入对应 targetId
 */
function applyEdgeStraightening(tempGrid, roomId, fillCells, retreatCells) {
  // 填入：各 owner → roomId
  const fillByOwner = new Map();
  for (const c of fillCells) {
    if (!fillByOwner.has(c.ownerId)) fillByOwner.set(c.ownerId, []);
    fillByOwner.get(c.ownerId).push(c);
  }
  for (const [ownerId, cells] of fillByOwner) {
    const ownerSet = new Set(cells.map(c => `${c.x},${c.y}`));
    tempGrid.roomData[ownerId] = (tempGrid.roomData[ownerId] || []).filter(c => !ownerSet.has(`${c.x},${c.y}`));
    cells.forEach(c => tempGrid.addRoomCell(roomId, c.x, c.y));
  }

  // 回退：roomId → 各 target
  const retreatSet = new Set(retreatCells.map(c => `${c.x},${c.y}`));
  tempGrid.roomData[roomId] = (tempGrid.roomData[roomId] || []).filter(c => !retreatSet.has(`${c.x},${c.y}`));
  for (const c of retreatCells) {
    tempGrid.addRoomCell(c.targetId, c.x, c.y);
  }
}

/**
 * 凹边段整体平移策略：找凹角对应的连续非-A 格段（行/列方向）。
 * 对每个 count=3 凹角，在缺失格所在行和列分别向两端延伸，
 * 收集以 A 格（或 bbox 边界）为界的全部连续非 A 格，形成一条段。
 * 统一处理双凹角（凹口，段在两凹角之间闭合）和单凹角（L形边，段延伸到 A 边界）。
 * @returns {Array<{fillCells: Array<{x,y,ownerId}>}>}
 */
/**
 * 找凹角矩形填充区（替代 1D 段）。
 * 对每个 count=3 凹角的缺失格 (mx,my)，以 A 的 bbox 为界枚举 4 个象限矩形，
 * 收集其中全部非-A 格作为候选填充集合。
 * 正确处理 L 形（2D 矩形凹陷）和 U 形（凹口）。
 */
/** 辅助：按 key 函数分组为 Map */
function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/**
 * 为房间 A 生成所有形状操作候选（ShapeFill + ShapeTrim）。
 * 每个凹角的4个象限矩形，各生成一个 fill 候选和一个 trim 候选。
 * fill: A 吸收象限内的非 A 格；trim: A 让出对侧（同列/行另一边）的 A 格。
 * @returns {Array<{type:'fill'|'trim', cells:Array}>}
 */
function findShapeOperations(grid, roomId) {
  const corners = findConcaveCorners(grid, roomId);
  const bbox = grid.getBoundingBox(roomId);
  if (!bbox || corners.length === 0) return [];

  const DIRS = [[1,0],[-1,0],[0,1],[0,-1]];
  const results = [];
  const seenFill = new Set();
  const seenTrim = new Set();

  for (const { mx, my } of corners) {
    const quadrants = [
      { fx1: mx, fy1: my, fx2: bbox.maxX, fy2: bbox.maxY,  tx1: mx, ty1: bbox.minY, tx2: bbox.maxX, ty2: my - 1 },
      { fx1: mx, fy1: bbox.minY, fx2: bbox.maxX, fy2: my,  tx1: mx, ty1: my + 1, tx2: bbox.maxX, ty2: bbox.maxY },
      { fx1: bbox.minX, fy1: my, fx2: mx, fy2: bbox.maxY,  tx1: bbox.minX, ty1: bbox.minY, tx2: mx, ty2: my - 1 },
      { fx1: bbox.minX, fy1: bbox.minY, fx2: mx, fy2: my,  tx1: bbox.minX, ty1: my + 1, tx2: mx, ty2: bbox.maxY },
    ];

    for (const { fx1, fy1, fx2, fy2, tx1, ty1, tx2, ty2 } of quadrants) {
      // ShapeFill: 象限内非 A 格
      if (fx2 >= fx1 && fy2 >= fy1) {
        const fKey = `${fx1}:${fy1}:${fx2}:${fy2}`;
        if (!seenFill.has(fKey)) {
          seenFill.add(fKey);
          const cells = [];
          for (let y = fy1; y <= fy2; y++) {
            for (let x = fx1; x <= fx2; x++) {
              const owner = grid.getCell(x, y);
              if (owner && owner !== 0 && owner !== -1 && owner !== roomId) {
                cells.push({ x, y, ownerId: owner });
              }
            }
          }
          if (cells.length > 0) results.push({ type: 'fill', cells });
        }
      }

      // ShapeTrim: 互补矩形内全部 A 格整体让给接触面积最大的邻居
      if (tx2 >= tx1 && ty2 >= ty1) {
        const tKey = `${tx1}:${ty1}:${tx2}:${ty2}`;
        if (!seenTrim.has(tKey)) {
          seenTrim.add(tKey);
          // 收集矩形内全部 A 格
          const aCells = [];
          for (let y = ty1; y <= ty2; y++) {
            for (let x = tx1; x <= tx2; x++) {
              if (grid.getCell(x, y) === roomId) aCells.push({ x, y });
            }
          }
          if (aCells.length === 0) continue;
          // 统计矩形边界与各邻居的接触格数，选接触最多的作为整体接收方
          const contactCount = new Map();
          for (const { x, y } of aCells) {
            for (const [dx, dy] of DIRS) {
              const nb = grid.getCell(x + dx, y + dy);
              if (nb && nb !== 0 && nb !== -1 && nb !== roomId) {
                contactCount.set(nb, (contactCount.get(nb) || 0) + 1);
              }
            }
          }
          if (contactCount.size === 0) continue;
          // 对每个候选接收方各生成一个 trim 候选，由 findBestShapeOperation 统一评估
          for (const receiver of contactCount.keys()) {
            const cells = aCells.map(c => ({ ...c, receiverId: receiver }));
            results.push({ type: 'trim', cells });
          }
        }
      }
    }
  }

  return results;
}

/**
 * ShapeOp：找使 A 自身顶点严格减少 ≥ 2 的最优形状操作（Fill 或 Trim）。
 * Fill 约束：来源房间连通 + 面积偏差 ≤ 30%。
 * Trim 约束：接收房间连通 + 面积偏差 ≤ 30%；A 自身连通。
 * @returns {object|null} { roomId, type, cells, aVertexReduction }
 */
function findBestShapeOperation(grid, rooms, roomMap) {
  let best = null;
  let maxAReduction = 1;

  for (const room of rooms) {
    const ops = findShapeOperations(grid, room.id);
    console.log(`  [ShapeOp] ${room.id}: ${countRoomVertices(grid, room.id)}顶点, ${ops.length}候选`);
    if (ops.length === 0) continue;

    const vBefore = countRoomVertices(grid, room.id);

    for (const op of ops) {
      const tempGrid = grid.clone();
      let affectedIds;

      if (op.type === 'fill') {
        // A 吸收 cells
        for (const [ownerId, cells] of groupBy(op.cells, c => c.ownerId)) {
          const ks = new Set(cells.map(c => `${c.x},${c.y}`));
          tempGrid.roomData[ownerId] = (tempGrid.roomData[ownerId] || []).filter(c => !ks.has(`${c.x},${c.y}`));
          cells.forEach(c => tempGrid.addRoomCell(room.id, c.x, c.y));
        }
        affectedIds = [...new Set(op.cells.map(c => c.ownerId))];
      } else {
        // A 让出 cells
        const ks = new Set(op.cells.map(c => `${c.x},${c.y}`));
        tempGrid.roomData[room.id] = (tempGrid.roomData[room.id] || []).filter(c => !ks.has(`${c.x},${c.y}`));
        for (const [rid, cells] of groupBy(op.cells, c => c.receiverId)) {
          cells.forEach(c => tempGrid.addRoomCell(rid, c.x, c.y));
        }
        affectedIds = [...new Set(op.cells.map(c => c.receiverId))];
      }

      const vAfter = countRoomVertices(tempGrid, room.id);
      const aReduction = vBefore - vAfter;

      // 计算邻居顶点变化（用于次要排序和日志）
      let neighborVBefore = 0, neighborVAfter = 0;
      for (const nid of affectedIds) {
        neighborVBefore += countRoomVertices(grid, nid);
        neighborVAfter  += countRoomVertices(tempGrid, nid);
      }
      const globalReduction = aReduction - (neighborVAfter - neighborVBefore);

      let ok = true; let rejectReason = '';

      // A 连通检查（trim 时 A 可能被切断）
      if (!isRoomConnected(tempGrid, room.id)) { ok = false; rejectReason = `${room.id}不连通`; }

      if (ok) {
        for (const nid of affectedIds) {
          if (!isRoomConnected(tempGrid, nid)) { ok = false; rejectReason = `${nid}不连通`; break; }
          const r = roomMap.get(nid);
          if (r) {
            const dev = Math.abs((tempGrid.roomData[nid]?.length || 0) / (r.targetGridCount || 1) - 1);
            if (dev > PHASE3_AREA_DEVIATION * 2) { ok = false; rejectReason = `${nid}面积偏差${(dev*100).toFixed(0)}%`; break; }
          }
        }
      }

      console.log(`    [${op.type}] 格数${op.cells.length} [${affectedIds.join(',')}↔${room.id}]: A顶点${vBefore}→${vAfter}(减${aReduction}) 全局净减${globalReduction} ${aReduction>=2?(ok?'✓':'✗ '+rejectReason):'✗ 顶点减少不足'}`);
      if (aReduction < 2 || !ok) continue;

      // 主排序：A顶点减少量；次排序：全局净减少量（邻居顶点尽量不增加）
      if (aReduction > maxAReduction || (aReduction === maxAReduction && best && globalReduction > best.globalReduction)) {
        maxAReduction = aReduction;
        best = { roomId: room.id, type: op.type, cells: op.cells, aVertexReduction: aReduction, globalReduction };
      }
    }
  }
  return best;
}

/** 执行 ShapeFill：将 cells 从各来源移入 roomId */
function applyShapeFill(grid, roomId, cells) {
  for (const [ownerId, cs] of groupBy(cells, c => c.ownerId)) {
    const ks = new Set(cs.map(c => `${c.x},${c.y}`));
    grid.roomData[ownerId] = (grid.roomData[ownerId] || []).filter(c => !ks.has(`${c.x},${c.y}`));
    cs.forEach(c => grid.addRoomCell(roomId, c.x, c.y));
  }
}

/** 执行 ShapeTrim：将 cells 从 roomId 移出给各接收邻居 */
function applyShapeTrim(grid, roomId, cells) {
  const ks = new Set(cells.map(c => `${c.x},${c.y}`));
  grid.roomData[roomId] = (grid.roomData[roomId] || []).filter(c => !ks.has(`${c.x},${c.y}`));
  for (const [rid, cs] of groupBy(cells, c => c.receiverId)) {
    cs.forEach(c => grid.addRoomCell(rid, c.x, c.y));
  }
}

/**
 * AreaCorrect：对面积超标房间，将其边界格让给邻居，要求全局顶点（A+邻居）不增加。
 * 优先让给面积最亏空的房间。
 * @returns {boolean} 是否执行了至少一次有效让出
 */
function runAreaCorrect(grid, rooms, roomMap) {
  const DIRS = [[1,0],[-1,0],[0,1],[0,-1]];
  let anyMoved = false;

  const overRooms = rooms
    .map(r => ({ r, excess: (grid.roomData[r.id]?.length || 0) - (r.targetGridCount || 1) * (1 + PHASE3_AREA_DEVIATION) }))
    .filter(({ excess }) => excess > 0)
    .sort((a, b) => b.excess - a.excess);

  for (const { r: room } of overRooms) {
    const cells = grid.roomData[room.id] || [];
    let bestMove = null;
    let bestScore = -Infinity;

    for (const cell of cells) {
      const neighborSet = new Set(
        DIRS.map(([dx, dy]) => grid.getCell(cell.x + dx, cell.y + dy))
            .filter(id => id && id !== 0 && id !== -1 && id !== room.id)
      );
      for (const neighborId of neighborSet) {
        const tempGrid = grid.clone();
        tempGrid.roomData[room.id] = tempGrid.roomData[room.id].filter(c => !(c.x === cell.x && c.y === cell.y));
        tempGrid.addRoomCell(neighborId, cell.x, cell.y);

        if (!isRoomConnected(tempGrid, room.id)) continue;
        if (!isRoomConnected(tempGrid, neighborId)) continue;

        // 全局顶点（A + 邻居）不增加
        const vBefore = countRoomVertices(grid, room.id) + countRoomVertices(grid, neighborId);
        const vAfter  = countRoomVertices(tempGrid, room.id) + countRoomVertices(tempGrid, neighborId);
        const globalReduction = vBefore - vAfter;
        if (globalReduction < 0) continue;

        // 优先让给最亏空的邻居
        const neighborActual = tempGrid.roomData[neighborId]?.length || 0;
        const neighborTarget = roomMap.get(neighborId)?.targetGridCount || 1;
        const neighborDev = neighborActual / neighborTarget - 1; // 负数 = 亏空
        const score = globalReduction * 1000 - neighborDev;

        if (score > bestScore) {
          bestScore = score;
          bestMove = { cell, neighborId, globalReduction };
        }
      }
    }

    if (bestMove) {
      const { cell, neighborId, globalReduction } = bestMove;
      grid.roomData[room.id] = grid.roomData[room.id].filter(c => !(c.x === cell.x && c.y === cell.y));
      grid.addRoomCell(neighborId, cell.x, cell.y);
      console.log(`[AreaCorrect] ${room.id}→${neighborId} 让出 (${cell.x},${cell.y})，全局顶点净减 ${globalReduction}`);
      anyMoved = true;
    }
  }

  return anyMoved;
}

/**
 * Phase 3c: ShapeFill + AreaCorrect 解耦迭代。
 * ShapeFill 优先：A 自身顶点严格减少 ≥ 2，不回退，允许面积临时偏大。
 * AreaCorrect 兜底：面积超标房间让出格子，全局顶点（A+邻居）不增加。
 * 两者均无效时收敛。
 */
function runAreaSwap(grid, rooms) {
  const MAX_ITERATIONS = 50;
  const roomMap = new Map(rooms.map(r => [r.id, r]));

  const initialVertices = rooms.reduce((sum, r) => sum + countRoomVertices(grid, r.id), 0);
  console.log(`[AreaSwap] 开始：${rooms.length} 个房间，总顶点数 ${initialVertices}`);
  for (const r of rooms) {
    const v = countRoomVertices(grid, r.id);
    if (v > 4) console.log(`  ${r.id}: ${v} 顶点`);
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const op = findBestShapeOperation(grid, rooms, roomMap);
    if (op) {
      const { roomId, type, cells, aVertexReduction } = op;
      if (type === 'fill') {
        applyShapeFill(grid, roomId, cells);
        const owners = [...new Set(cells.map(c => c.ownerId))].join(',');
        console.log(`[AreaSwap] Iter ${i+1} ShapeFill: [${owners}]→${roomId} 填入 ${cells.length} 格，${roomId} 顶点 -${aVertexReduction}`);
      } else {
        applyShapeTrim(grid, roomId, cells);
        const receivers = [...new Set(cells.map(c => c.receiverId))].join(',');
        console.log(`[AreaSwap] Iter ${i+1} ShapeTrim: ${roomId}→[${receivers}] 让出 ${cells.length} 格，${roomId} 顶点 -${aVertexReduction}`);
      }
      continue;
    }

    const corrected = runAreaCorrect(grid, rooms, roomMap);
    if (corrected) continue;

    console.log(`[AreaSwap] 收敛，共迭代 ${i} 次`);
    break;
  }

  const finalVertices = rooms.reduce((sum, r) => sum + countRoomVertices(grid, r.id), 0);
  console.log(`[AreaSwap] 结束：总顶点数 ${initialVertices} → ${finalVertices}`);
  for (const r of rooms) {
    const actual = grid.roomData[r.id]?.length || 0;
    const dev = Math.abs(actual / (r.targetGridCount || 1) - 1);
    if (dev > PHASE3_AREA_DEVIATION) console.log(`  [面积偏差] ${r.id}: 实际${actual} 目标${r.targetGridCount} 偏差${(dev*100).toFixed(1)}%`);
  }
}

/**
 * Phase 3b: 空间交换协商。
 * 对质量差或面积偏差大的候选房间，与相邻房间协商边界格子的转让。
 * 若转让后两房间综合评分提升则保留，否则回退。
 */
function runSpaceSwap(grid, rooms) {
  const roomMap = Object.fromEntries(rooms.map(r => [r.id, r]))

  // 识别候选房间
  function isCandidateRoom(room) {
    if (room.id === 'corridor_l1') return false
    const cellCount = grid.roomData[room.id]?.length || 0
    const bbox = grid.getBoundingBox(room.id)
    if (!cellCount || !bbox) return false
    const bboxW = bbox.maxX - bbox.minX + 1
    const bboxH = bbox.maxY - bbox.minY + 1
    const ratio = Math.max(bboxW / bboxH, bboxH / bboxW)
    const util = cellCount / (bboxW * bboxH)
    const areaDeviation = Math.abs(cellCount / (room.targetGridCount || 1) - 1)
    return ratio > 4 || util < 0.70 || areaDeviation > PHASE3_AREA_DEVIATION
  }

  // 取 fromRoom 紧贴 toRoom 的边界格子（最多 SWAP_MAX_CELLS 个）
  function getBoundaryCells(fromId, toId, maxCount) {
    const result = []
    for (const { x, y } of (grid.roomData[fromId] || [])) {
      if (result.length >= maxCount) break
      const touches = [[1,0],[-1,0],[0,1],[0,-1]].some(([dx, dy]) => grid.getCell(x+dx, y+dy) === toId)
      if (touches) result.push({ x, y })
    }
    return result
  }

  // 将 cells 从 fromId 转让给 toId，返回是否成功
  function transfer(fromId, toId, cells) {
    if (cells.length === 0) return false
    // 从 fromId 移除
    grid.roomData[fromId] = grid.roomData[fromId].filter(c => !cells.some(t => t.x === c.x && t.y === c.y))
    cells.forEach(c => grid.grid[c.y][c.x] = 0)
    // 连通性检查
    if (!isRoomConnected(grid, fromId)) {
      // 回退
      cells.forEach(c => { grid.roomData[fromId].push(c); grid.grid[c.y][c.x] = fromId })
      return false
    }
    // 加入 toId
    cells.forEach(c => { grid.roomData[toId].push(c); grid.grid[c.y][c.x] = toId })
    return true
  }

  function revert(fromId, toId, cells) {
    grid.roomData[toId] = grid.roomData[toId].filter(c => !cells.some(t => t.x === c.x && t.y === c.y))
    cells.forEach(c => { grid.roomData[fromId].push(c); grid.grid[c.y][c.x] = fromId })
  }

  for (let round = 0; round < MAX_SWAP_ROUNDS; round++) {
    let anyImproved = false

    const candidates = rooms.filter(isCandidateRoom)
    if (candidates.length === 0) break

    for (const roomA of candidates) {
      const adjIds = findAdjacentRoomIds(grid, roomA.id)
      let improved = false

      for (const adjId of adjIds) {
        const roomB = roomMap[adjId]
        if (!roomB) continue

        const preQ = computeRoomQuality(grid, roomA) + computeRoomQuality(grid, roomB)

        // 尝试 A → B（A 给出边界格子）
        const cellsAtoB = getBoundaryCells(roomA.id, adjId, SWAP_MAX_CELLS)
        if (cellsAtoB.length > 0 && transfer(roomA.id, adjId, cellsAtoB)) {
          const postQ = computeRoomQuality(grid, roomA) + computeRoomQuality(grid, roomB)
          if (postQ > preQ) {
            improved = true; anyImproved = true; break
          }
          revert(adjId, roomA.id, cellsAtoB)
        }

        // 尝试 B → A（B 给出边界格子）
        const cellsBtoA = getBoundaryCells(adjId, roomA.id, SWAP_MAX_CELLS)
        if (cellsBtoA.length > 0 && transfer(adjId, roomA.id, cellsBtoA)) {
          const postQ = computeRoomQuality(grid, roomA) + computeRoomQuality(grid, roomB)
          if (postQ > preQ) {
            improved = true; anyImproved = true; break
          }
          revert(roomA.id, adjId, cellsBtoA)
        }

        if (improved) break
      }
    }

    if (!anyImproved) break
  }
}

function extractGridCells(grid) {
  const cells = {};
  for (const [roomId, roomCells] of Object.entries(grid.roomData)) {
    cells[roomId] = roomCells.map(c => ({ x: c.x, y: c.y }));
  }
  return cells;
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

/**
 * Build a partial layout result from intermediate grid snapshots, for checkpoint evaluation.
 * Used by layout-build.js to evaluate layouts at phase boundaries:
 * - Checkpoint A: pass gridAfterRect snapshots (after Phase 1 rectangle expansion)
 * - Checkpoint B: pass gridBeforeGaps snapshots (after Phase 2 L/U expansion)
 *
 * The returned object is compatible with evaluateTemplate() → scoreHardRedlines() / scoreSpatialQuality().
 *
 * @param {Grid} groundGrid - Ground floor grid snapshot
 * @param {Grid} level1Grid - Level 1 grid snapshot
 * @param {number} buildingW - Building width in mm
 * @param {number} buildingD - Building depth in mm
 * @returns {object} Partial layout result with groundPlacements and level1Placements
 */
export function buildPartialResult(groundGrid, level1Grid, buildingW, buildingD) {
  const groundLayout = groundGrid ? finalizeLayout(groundGrid) : { ground: {}, level1: {} }
  const level1Layout = level1Grid ? finalizeLayout(level1Grid) : { ground: {}, level1: {} }
  return {
    buildingW,
    buildingD,
    groundPlacements: groundLayout.ground || {},
    level1Placements: level1Layout.level1 || {},
  }
}




function timedGen(name, fn) {
  if (!window.debugModeEnabled) return fn();
  const t0 = performance.now();
  const result = fn();
  const duration = (performance.now() - t0) / 1000;
  if (!window.timeCostLog) window.timeCostLog = [];
  window.timeCostLog.push({ fn: `generateConstrainedLayout/${name}`, duration });
  return result;
}

export function generateConstrainedLayout(seed, bW, bD, roomAreas = {}, runParams = {}, groupId = 'CG', variantIdx = 1, prefix = 'R', initialSeeds = null) {
  const { bypassCheckpointA = false, runPhase2And3 = false, initialGrid = null, stopPhase = 3 } = runParams;
  // 向后兼容：如果提供了 detailedLayout 但没提供 runPhase2And3，使用 detailedLayout 的值
  const actualRunPhase2And3 = runParams.hasOwnProperty('runPhase2And3') ? runPhase2And3 : (runParams.detailedLayout === true);
  const rng = makeRng(seed);

  if (actualRunPhase2And3 && initialGrid) {
    // --- 终极防御性检查 ---
    // initialGrid 可能是 variant 对象（包含_debug），或直接是_debug对象
    const debugInfo = initialGrid._debug || initialGrid;
    if (!debugInfo) throw new Error('detailedLayout: initialGrid._debug或initialGrid不存在');

    const groundGrid = (debugInfo.ground?.gridBeforeGaps || debugInfo.ground?.gridAfterRect).clone();
    const level1Grid = (debugInfo.level1?.gridBeforeGaps || debugInfo.level1?.gridAfterRect).clone();

    const allRooms = debugInfo.roomTargets || [];
    let alignedBW, alignedBD;

    if (debugInfo.alignedBW) {
      alignedBW = debugInfo.alignedBW;
      alignedBD = debugInfo.alignedBD;
    } else {
      // 回退：重新计算
      const gridW = Math.floor(bW / GRID_SIZE);
      const gridH = Math.floor(bD / GRID_SIZE);
      alignedBW = gridW * GRID_SIZE;
      alignedBD = gridH * GRID_SIZE;
    }
    // --- 检查结束 ---


    const groundRooms = allRooms.filter(r => r.floor === 'ground');
    const level1Rooms = allRooms.filter(r => r.floor === 'level1');
    const { mergedRooms: mergedGroundRooms, superRoomMap: groundSuperRoomMap } = mergeMustPairsForFloor(groundRooms);
    const { mergedRooms: mergedLevel1Rooms, superRoomMap: level1SuperRoomMap } = mergeMustPairsForFloor(level1Rooms);

    // Phase 2: area-constrained L/U expansion
    const groundCtx2 = { buildingW: alignedBW, buildingD: alignedBD, superRoomMeta: buildSuperRoomMeta(groundSuperRoomMap) };
    expandRooms(groundGrid, mergedGroundRooms, rng, groundCtx2, false);
    const groundGridBeforeGaps = groundGrid.clone();

    const level1Ctx2 = { buildingW: alignedBW, buildingD: alignedBD, superRoomMeta: buildSuperRoomMeta(level1SuperRoomMap) };
    expandRooms(level1Grid, mergedLevel1Rooms, rng, level1Ctx2, false);
    const level1GridBeforeGaps = level1Grid.clone();

    // Phase 3: unlimited expansion + fillGaps + areaSwap
    const groundCtx3 = { buildingW: alignedBW, buildingD: alignedBD, superRoomMeta: buildSuperRoomMeta(groundSuperRoomMap) };
    expandRooms(groundGrid, mergedGroundRooms, rng, groundCtx3, false, true);
    const level1Ctx3 = { buildingW: alignedBW, buildingD: alignedBD, superRoomMeta: buildSuperRoomMeta(level1SuperRoomMap) };
    expandRooms(level1Grid, mergedLevel1Rooms, rng, level1Ctx3, false, true);

    fillGaps(groundGrid, mergedGroundRooms);
    fillGaps(level1Grid, mergedLevel1Rooms);
    runAreaSwap(groundGrid, mergedGroundRooms);
    runAreaSwap(level1Grid, mergedLevel1Rooms);

    splitAllSuperRooms(groundGrid, groundSuperRoomMap);
    splitAllSuperRooms(level1Grid, level1SuperRoomMap);
    runAreaSwap(groundGrid, groundRooms);
    runAreaSwap(level1Grid, level1Rooms);

    const finalLayout = {
      ground: timedGen('finalizeLayout_ground', () => finalizeLayout(groundGrid).ground),
      level1: timedGen('finalizeLayout_level1', () => finalizeLayout(level1Grid).level1),
    };

    return {
      id: `${prefix}-${groupId}-${variantIdx}`,
      label: `约束生长法`,
      desc: `建筑 ${(alignedBW / 1000).toFixed(1)}m×${(alignedBD / 1000).toFixed(1)}m`,
      groundPlacements: finalLayout.ground,
      level1Placements: finalLayout.level1,
      buildingW: alignedBW,
      buildingD: alignedBD,
      groupId,
      variantIdx,
      _debug: {
        ...debugInfo,
        ground: { ...debugInfo.ground, gridBeforeGaps: groundGridBeforeGaps, gridAfterGaps: groundGrid },
        level1: { ...debugInfo.level1, gridBeforeGaps: level1GridBeforeGaps, gridAfterGaps: level1Grid },
      },
      _relaxedDoorAccess: initialGrid._relaxedDoorAccess,
    };
  }


  const gridW = Math.floor(bW / GRID_SIZE);
  const gridH = Math.floor(bD / GRID_SIZE);
  const alignedBW = gridW * GRID_SIZE;
  const alignedBD = gridH * GRID_SIZE;

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

  // --- Auto-scale room areas to meet target utilization (prevents rooms from being too small in a large building) ---
  const TARGET_UTILIZATION = 0.9;
  const totalGridArea = gridW * gridH;

  const autoscaleFloor = (rooms) => {
    const currentTotalTarget = rooms.reduce((sum, r) => sum + r.targetGridCount, 0);
    if (currentTotalTarget > 0 && (currentTotalTarget / totalGridArea) < TARGET_UTILIZATION) {
      const scaleFactor = (totalGridArea * TARGET_UTILIZATION) / currentTotalTarget;
      if (DEBUG_LAYOUT) console.log(`[Layout] autoscale ${rooms[0]?.floor}: ×${scaleFactor.toFixed(2)}`);
      rooms.forEach(r => {
        r.targetGridCount = Math.round(r.targetGridCount * scaleFactor);
      });
    }
  };

  if (groundRooms.length > 0) autoscaleFloor(groundRooms);
  if (level1Rooms.length > 0) autoscaleFloor(level1Rooms);
  // --- End auto-scale ---

  // ── Cooperative growth preprocessing (Phase 0) ──────────────────────────────────────
  // Merge MUST-adjacent room pairs into super-rooms to prevent fragmentation during growth
  const { mergedRooms: mergedGroundRooms, superRoomMap: groundSuperRoomMap } = mergeMustPairsForFloor(groundRooms);
  const { mergedRooms: mergedLevel1Rooms, superRoomMap: level1SuperRoomMap } = mergeMustPairsForFloor(level1Rooms);
  const groundSuperMeta = buildSuperRoomMeta(groundSuperRoomMap);
  const level1SuperMeta = buildSuperRoomMeta(level1SuperRoomMap);

  // 2. Create and process grids for each floor
  let groundGridBeforeGaps, groundGridAfterRect;
  const groundGrid = new Grid(gridW, gridH);
  let groundSeeds, groundGridAfterSeeds;
  if (initialSeeds && initialSeeds.ground) {
    groundSeeds = initialSeeds.ground;
    for (const room of mergedGroundRooms) {
        if (groundSeeds[room.id]) {
            const { x, y } = groundSeeds[room.id];
            groundGrid.addRoomCell(room.id, x, y);
        }
    }
  } else {
    groundSeeds = placeRoomSeeds(groundGrid, mergedGroundRooms, rng);
  }
  groundGridAfterSeeds = groundGrid.clone();

  let level1GridBeforeGaps, level1GridAfterRect;
  const level1Grid = new Grid(gridW, gridH);
  let level1Seeds, level1GridAfterSeeds;
  if (initialSeeds && initialSeeds.level1) {
    level1Seeds = initialSeeds.level1;
    for (const room of mergedLevel1Rooms) {
        if (level1Seeds[room.id]) {
            const { x, y } = level1Seeds[room.id];
            level1Grid.addRoomCell(room.id, x, y);
        }
    }
  } else {
    level1Seeds = placeRoomSeeds(level1Grid, mergedLevel1Rooms, rng);
  }
  level1GridAfterSeeds = level1Grid.clone();

  const debugData = {
    roomTargets: allRooms,
    alignedBW,
    alignedBD,
    ground: { seeds: groundSeeds, gridAfterSeeds: groundGridAfterSeeds },
    level1: { seeds: level1Seeds, gridAfterSeeds: level1GridAfterSeeds },
  };

  // --- Checkpoint A (Phase 1 snapshot evaluation) ---
  const groundCtx = { buildingW: alignedBW, buildingD: alignedBD, superRoomMeta: groundSuperMeta };
  timedGen('phase1_expandRooms_ground', () => expandRooms(groundGrid, mergedGroundRooms, rng, groundCtx, stopPhase === 1));
  groundGridAfterRect = groundGrid.clone();
  debugData.ground.gridAfterRect = groundGridAfterRect;

  const level1Ctx = { buildingW: alignedBW, buildingD: alignedBD, superRoomMeta: level1SuperMeta };
  timedGen('phase1_expandRooms_level1', () => expandRooms(level1Grid, mergedLevel1Rooms, rng, level1Ctx, stopPhase === 1));
  level1GridAfterRect = level1Grid.clone();
  debugData.level1.gridAfterRect = level1GridAfterRect;


  // Split super-rooms in snapshots before Checkpoint A evaluation
  const groundAfterRectForEval = groundGridAfterRect.clone();
  splitAllSuperRooms(groundAfterRectForEval, groundSuperRoomMap);
  const level1AfterRectForEval = level1GridAfterRect.clone();
  splitAllSuperRooms(level1AfterRectForEval, level1SuperRoomMap);

  const snapshot = timedGen('checkpointA_buildPartialResult', () => buildPartialResult(groundAfterRectForEval, level1AfterRectForEval, alignedBW, alignedBD));
  const evaluated = timedGen('checkpointA_evaluateTemplate', () => evaluateTemplate(snapshot, { skipDoors: true }));
  // Use relaxed door-access for Checkpoint A: rooms adjacent to an unclaimed empty region
  // that bridges to the exterior wall / corridor are considered virtually connected.
  // Strict door-access is still used in Checkpoint B and full scoring (Step 9).
  const relaxedDoorAccess = timedGen('checkpointA_relaxedDoorAccess', () => computeRelaxedDoorAccess(groundAfterRectForEval, level1AfterRectForEval));

  // 在过滤前，将桥接调试信息附加到 must_adjacent 违规项上
  const violationsWithDebug = evaluated.violations.map(v => {
    if (v.constraint === 'must_adjacent' && relaxedDoorAccess.bridgeDebugInfo?.[v.room]) {
      return { ...v, debug: relaxedDoorAccess.bridgeDebugInfo[v.room] };
    }
    return v;
  });

  // Also filter out violations for rooms that passed via the bridging mechanism.
  // (evaluateTemplate adds ext_access violations independently of doorAccess, causing
  //  double-counting that would fail Checkpoint A even when doorAccess is relaxed.)
  // 过滤通过桥接机制放行的违规：
  //   bridgedIds      → ext_access 类（v.room = 单个 room ID）
  //   bridgedPairKeys → must_adjacent 类（v.room = 'a↔b' 拼接字符串）
  const hasBridged = relaxedDoorAccess.bridgedIds.size > 0 || relaxedDoorAccess.bridgedPairKeys.size > 0;
  const relaxedEvaluated = hasBridged
    ? { ...evaluated, violations: violationsWithDebug.filter(v =>
        !relaxedDoorAccess.bridgedIds.has(v.room) &&
        !relaxedDoorAccess.bridgedPairKeys.has(v.room)
      )}
    : { ...evaluated, violations: violationsWithDebug };
  let checkpointADiagnostic = evaluateCheckpointA(relaxedEvaluated, relaxedDoorAccess);

  // ── Early return for Phase 1 (stopPhase = 1) ──
  if (stopPhase === 1) {
    // Clone before splitting so debugData.ground.gridAfterRect keeps merged IDs (needed by initialGrid path)
    const groundGridForFinalize = groundGridAfterRect.clone();
    const level1GridForFinalize = level1GridAfterRect.clone();
    splitAllSuperRooms(groundGridForFinalize, groundSuperRoomMap);
    splitAllSuperRooms(level1GridForFinalize, level1SuperRoomMap);
    const groundLayout = finalizeLayout(groundGridForFinalize).ground;
    const level1Layout = finalizeLayout(level1GridForFinalize).level1;
    return {
      id: `${prefix}-${groupId}-${variantIdx}`,
      label: `约束生长法 (Phase 1)`,
      desc: `建筑 ${(alignedBW / 1000).toFixed(1)}m×${(alignedBD / 1000).toFixed(1)}m [Phase 1]`,
      groundPlacements: groundLayout,
      level1Placements: level1Layout,
      groundCells: extractGridCells(groundGridForFinalize),
      level1Cells: extractGridCells(level1GridForFinalize),
      buildingW: alignedBW,
      buildingD: alignedBD,
      groupId,
      variantIdx,

      stopPhase: 1,
      _debug: debugData,
    };
  }

  // Phase 2+3 execution control: skipped if runPhase2And3 is false
  const skipPhase2And3 = !actualRunPhase2And3;

  if (skipPhase2And3) {
    // Clone before splitting so debugData.ground.gridAfterRect keeps merged IDs (needed by initialGrid path)
    const groundGridForFinalize = groundGridAfterRect.clone();
    const level1GridForFinalize = level1GridAfterRect.clone();
    splitAllSuperRooms(groundGridForFinalize, groundSuperRoomMap);
    splitAllSuperRooms(level1GridForFinalize, level1SuperRoomMap);
    const groundLayout = finalizeLayout(groundGridForFinalize).ground;
    const level1Layout = finalizeLayout(level1GridForFinalize).level1;
    return {
      id: `${prefix}-${groupId}-${variantIdx}`,
      label: `约束生长法`,
      desc: `建筑 ${(alignedBW / 1000).toFixed(1)}m×${(alignedBD / 1000).toFixed(1)}m`,
      groundPlacements: groundLayout,
      level1Placements: level1Layout,
      buildingW: alignedBW,
      buildingD: alignedBD,
      groupId,
      variantIdx,
      _debug: debugData,

      _relaxedDoorAccess: relaxedDoorAccess,
    };
  }

  // ── Phase 2 (Step 6A): 对通过 Checkpoint A 的方案，继续跑有面积约束的 L/U 形扩展 ────────
  if (actualRunPhase2And3) {
    const groundCtx = { buildingW: alignedBW, buildingD: alignedBD, superRoomMeta: groundSuperMeta };
    timedGen('phase2_expandRooms_ground', () => expandRooms(groundGrid, mergedGroundRooms, rng, groundCtx, false));
    groundGridBeforeGaps = groundGrid.clone();
    debugData.ground.gridBeforeGaps = groundGridBeforeGaps;

    const level1Ctx = { buildingW: alignedBW, buildingD: alignedBD, superRoomMeta: level1SuperMeta };
    timedGen('phase2_expandRooms_level1', () => expandRooms(level1Grid, mergedLevel1Rooms, rng, level1Ctx, false));
    level1GridBeforeGaps = level1Grid.clone();
    debugData.level1.gridBeforeGaps = level1GridBeforeGaps;
  }

  // Split super-rooms before Checkpoint B evaluation
  const groundBeforeGapsForEval = groundGridBeforeGaps.clone();
  splitAllSuperRooms(groundBeforeGapsForEval, groundSuperRoomMap);
  const level1BeforeGapsForEval = level1GridBeforeGaps.clone();
  splitAllSuperRooms(level1BeforeGapsForEval, level1SuperRoomMap);

  // ▼ Checkpoint B（Step 6A 结束后）：第一梯队 + 第二梯队评价，分数 > -1000 才进入后续生长
  // 与 Checkpoint A 一致，使用宽松可达性检查（_relaxedDoorAccess）
  const relaxedB = timedGen('checkpointB_relaxedDoorAccess', () => computeRelaxedDoorAccess(groundBeforeGapsForEval, level1BeforeGapsForEval));
  const snapshotB = timedGen('checkpointB_buildPartialResult', () => buildPartialResult(groundBeforeGapsForEval, level1BeforeGapsForEval, alignedBW, alignedBD));
  const evaluatedB = { ...timedGen('checkpointB_evaluateTemplate', () => evaluateTemplate(snapshotB, { skipDoors: true })), _relaxedDoorAccess: relaxedB };
  const checkpointBDiagnostic = scoreSpatialQuality(evaluatedB);
  const CHECKPOINT_B_THRESHOLD = -1000; // 总惩罚绝对值 < 1000 才通过

  // ── Early return for Phase 2 (stopPhase = 2) ──
  if (stopPhase === 2) {
    // Split super-rooms before finalizing
    splitAllSuperRooms(groundGridBeforeGaps, groundSuperRoomMap);
    splitAllSuperRooms(level1GridBeforeGaps, level1SuperRoomMap);
    const groundLayout = finalizeLayout(groundGridBeforeGaps).ground;
    const level1Layout = finalizeLayout(level1GridBeforeGaps).level1;
    return {
      id: `${prefix}-${groupId}-${variantIdx}`,
      label: `约束生长法 (Phase 2)`,
      desc: `建筑 ${(alignedBW / 1000).toFixed(1)}m×${(alignedBD / 1000).toFixed(1)}m [Phase 2]`,
      groundPlacements: groundLayout,
      level1Placements: level1Layout,
      groundCells: extractGridCells(groundGridBeforeGaps),
      level1Cells: extractGridCells(level1GridBeforeGaps),
      buildingW: alignedBW,
      buildingD: alignedBD,
      groupId,
      variantIdx,

      stopPhase: 2,
    };
  }

  // Phase 3 execution control: skipped if runPhase2And3 is false
  const skipPhase3 = !actualRunPhase2And3;

  if (skipPhase3) {
    // 不通过 → 直接用 Phase 2 结果参与排名，跳过 Step 6B（无面积约束生长）与 Phase 3
    // Split super-rooms before finalizing
    splitAllSuperRooms(groundGridBeforeGaps, groundSuperRoomMap);
    splitAllSuperRooms(level1GridBeforeGaps, level1SuperRoomMap);
    const groundLayout = finalizeLayout(groundGridBeforeGaps).ground;
    const level1Layout = finalizeLayout(level1GridBeforeGaps).level1;
    return {
      id: `${prefix}-${groupId}-${variantIdx}`,
      label: `约束生长法`,
      desc: `建筑 ${(alignedBW / 1000).toFixed(1)}m×${(alignedBD / 1000).toFixed(1)}m`,
      groundPlacements: groundLayout,
      level1Placements: level1Layout,
      buildingW: alignedBW,
      buildingD: alignedBD,
      groupId,
      variantIdx,
      _debug: debugData,

      _relaxedDoorAccess: relaxedB,
    };
  }
  // ── Phase 3: 无面积限制 L/U 扩展 → 空隙填充 → 面积偏差调整 ──
  if (actualRunPhase2And3) {
    const groundCtx3 = { buildingW: alignedBW, buildingD: alignedBD, superRoomMeta: groundSuperMeta };
    timedGen('phase3_expandRooms_ground', () => expandRooms(groundGrid, mergedGroundRooms, rng, groundCtx3, false, true));

    const level1Ctx3 = { buildingW: alignedBW, buildingD: alignedBD, superRoomMeta: level1SuperMeta };
    timedGen('phase3_expandRooms_level1', () => expandRooms(level1Grid, mergedLevel1Rooms, rng, level1Ctx3, false, true));

    timedGen('phase3_fillGaps_ground', () => fillGaps(groundGrid, mergedGroundRooms));
    timedGen('phase3_fillGaps_level1', () => fillGaps(level1Grid, mergedLevel1Rooms));

    timedGen('phase3_areaSwap_ground', () => runAreaSwap(groundGrid, mergedGroundRooms));
    timedGen('phase3_areaSwap_level1', () => runAreaSwap(level1Grid, mergedLevel1Rooms));
  }

  // ── Super-room splitting: convert super-rooms back to constituent rooms ──
  // This must happen before finalization to ensure all room IDs in output are original
  console.error(`[CoGrow] Before split - ground roomData keys: ${Object.keys(groundGrid.roomData).join(',')}`);
  console.error(`[CoGrow] Before split - level1 roomData keys: ${Object.keys(level1Grid.roomData).join(',')}`);
  splitAllSuperRooms(groundGrid, groundSuperRoomMap);
  splitAllSuperRooms(level1Grid, level1SuperRoomMap);
  debugData.ground.gridAfterGaps = groundGrid;
  debugData.level1.gridAfterGaps = level1Grid;
  console.error(`[CoGrow] After split - ground roomData keys: ${Object.keys(groundGrid.roomData).join(',')}`);
  console.error(`[CoGrow] After split - level1 roomData keys: ${Object.keys(level1Grid.roomData).join(',')}`);

  // ── Phase 3 post-split AreaSwap: re-run corner reduction on original rooms ──
  if (actualRunPhase2And3) {
    timedGen('phase3_areaSwap_postSplit_ground', () => runAreaSwap(groundGrid, groundRooms));
    timedGen('phase3_areaSwap_postSplit_level1', () => runAreaSwap(level1Grid, level1Rooms));
  }

  // 3. Finalize layouts from both grids
  const finalLayout = {
    ground: timedGen('finalizeLayout_ground', () => finalizeLayout(groundGrid).ground),
    level1: timedGen('finalizeLayout_level1', () => finalizeLayout(level1Grid).level1),
  };

  // 计算 Phase 3 完成后的宽松可达性（供全量评分使用）
  const relaxedFinal = timedGen('final_relaxedDoorAccess', () => computeRelaxedDoorAccess(groundGrid, level1Grid));

  return {
    id: `${prefix}-${groupId}-${variantIdx}`,
    label: `约束生长法`,
    desc: `建筑 ${(alignedBW / 1000).toFixed(1)}m×${(alignedBD / 1000).toFixed(1)}m`,
    groundPlacements: finalLayout.ground,
    level1Placements: finalLayout.level1,
    groundCells: extractGridCells(groundGrid),
    level1Cells: extractGridCells(level1Grid),
    buildingW: alignedBW,
    buildingD: alignedBD,
    groupId,
    variantIdx,
    _debug: debugData,
    _relaxedDoorAccess: relaxedFinal,
  };
}
