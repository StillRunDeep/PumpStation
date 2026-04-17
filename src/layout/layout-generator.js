import { ROOM_DEFS } from './room-defs.js';
import { checkAdjacency } from './adjacency.js';
import { placeDoors } from './door-placer.js';
import { SCORER_PARAMS } from './scorer-params.js';
import { evaluateCheckpointA, scoreSpatialQuality, GROUND_MUST_EXT, LEVEL1_MUST_FACE_CORRIDOR } from './scorer.js';
import { adjacent, centerX, centerY, touchesExteriorNonSouth, CONSTRAINT_CHECKS, evaluateTemplate } from './placer.js';

export const GRID_SIZE = 500; // 500mm per grid cell — single source of truth, imported by ag41/ag42
const MAX_EXPANSION_ITERATIONS = 5000;

// ── Geometry helpers (used internally) ───────────────────────────────────────

/** Normalised aspect ratio: always ≥ 1. */
function aspectRatio(w, d) {
  return Math.max(w / d, d / w);
}

const DEBUG_LAYOUT = false; // set true locally for fill-gap tracing

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

const weightMapCache = new Map();

function createWeightMap(gridW, gridH) {
  const cacheKey = `${gridW}x${gridH}`;
  if (weightMapCache.has(cacheKey)) return weightMapCache.get(cacheKey);

  const weightMap = Array(gridH).fill(null).map(() => Array(gridW).fill(1));
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      if (x < 2 || x > gridW - 3 || y < 2 || y > gridH - 3) {
        weightMap[y][x] = 0.5;
      }
    }
  }
  weightMapCache.set(cacheKey, weightMap);
  return weightMap;
}

function placeRoomSeeds(grid, rooms, rng) {
    const weightMap = createWeightMap(grid.width, grid.height);
    const placedSeeds = {};

    for (const room of rooms) {
        let bestPos = null;
        let maxWeight = -1;

        for (let i = 0; i < 100; i++) {
            const x = Math.floor(rng() * grid.width);
            const y = Math.floor(rng() * grid.height);

            if (grid.getCell(x, y) === 0) {
                const weight = weightMap[y][x];
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

const CORRIDOR_MIN_WIDTH_CELLS = 3; // 3 × 500mm = 1500mm

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
      if (grid.getCell(x, y) === 0 && regionIdGrid[y][x] === -1) {
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
              if (grid.getCell(nx, ny) === 0 && regionIdGrid[ny][nx] === -1) {
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
    return val === 0 ? null : val; // null if it's another empty cell (shouldn't happen on boundary)
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
      // Cannot move right, so turn left and stay in current cell
      curDir = (curDir + 3) % 4;
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
function computeRelaxedDoorAccess(groundGrid, level1Grid) {
  const { doorAccessPenalty } = SCORER_PARAMS;
  const ids = [];
  const bridgedIds = new Set();

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
        if (!ids.includes(req.room)) ids.push(req.room);
      }
    });
  }

  // Ground Floor: Exterior access for main rooms + Mutual access for parking/repair
  processFloor(groundGrid, GROUND_MUST_EXT, [['parking', 'repair_zone']]);
  
  // Level 1: Corridor access
  processFloor(level1Grid, [], LEVEL1_MUST_FACE_CORRIDOR.map(r => [r, 'corridor_l1']));

  return { penalty: -doorAccessPenalty * ids.length, ids, bridgedIds };
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
 */
function isAccessibilityMet(roomId, grid, buildingW, buildingD) {
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
  return true;
}

/**
 * Return the preferred expansion direction for a room that has not yet met
 * its accessibility requirement. Returns 'W'|'E'|'N'|'S'|null.
 */
function getPreferredDirection(roomId, grid, buildingW, buildingD) {
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
  return null;
}

function expandRooms(grid, rooms, rng, buildingW, buildingD, onRegularExpansionComplete = null, onRectExpansionComplete = null, stopAfterStage1 = false) {
    let iterations = 0;
    let stage = 1; // Stage 1: Rectangular only, Stage 2: All types allowed
    // currentArea is now in grid cell counts
    let growingRooms = rooms.map(r => ({ 
      ...r, 
      currentArea: grid.roomData[r.id] ? grid.roomData[r.id].length : 0 
    }));
    
    let needsSort = true;

    while (iterations < MAX_EXPANSION_ITERATIONS) {
        // Stage 2: also include rooms that haven't met accessibility, even if they've reached
        // their area target — they need to keep growing toward the exterior wall / corridor.
        let activeRooms;
        if (stage === 2) {
          activeRooms = growingRooms.filter(room =>
            room.currentArea < room.targetGridCount ||
            !isAccessibilityMet(room.id, grid, buildingW, buildingD)
          );
        } else {
          activeRooms = growingRooms.filter(room => room.currentArea < room.targetGridCount);
        }

        // If all rooms reached their target area (and accessibility in Stage 2)
        if (activeRooms.length === 0) {
            if (stage === 1) {
                // Stage 1 finished perfectly — capture rect snapshot before exiting.
                // onRegularExpansionComplete is called after the loop regardless.
                if (onRectExpansionComplete) onRectExpansionComplete(grid);
            }
            break;
        }

        // Sort rooms by priority:
        // Stage 1: area completion ratio only (lower ratio = higher priority)
        // Stage 2: accessibility-unmet rooms first, then by area completion ratio
        if (needsSort) {
          if (stage === 2) {
            activeRooms.sort((a, b) => {
              const aOk = isAccessibilityMet(a.id, grid, buildingW, buildingD);
              const bOk = isAccessibilityMet(b.id, grid, buildingW, buildingD);
              if (aOk !== bOk) return aOk ? 1 : -1; // unmet comes first
              return (a.currentArea / a.targetGridCount) - (b.currentArea / b.targetGridCount);
            });
          } else {
            activeRooms.sort((a, b) => (a.currentArea / a.targetGridCount) - (b.currentArea / b.targetGridCount));
          }
          needsSort = false;
        }

        let growthHappenedThisCycle = false;

        if (stage === 1) {
            // Stage 1: Try strictly rectangular expansion for ALL rooms
            for (const roomToGrow of activeRooms) {
                const isCorridor = roomToGrow.id === 'corridor_l1';
                let expansionCells = findBestRectangleExpansion(grid, roomToGrow.id, isCorridor);
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
                if (onRectExpansionComplete) {
                    onRectExpansionComplete(grid); // Take snapshot AFTER all possible rect growths are done
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
            for (const roomToGrow of activeRooms) {
                const isCorridor = roomToGrow.id === 'corridor_l1';

                // Compute accessibility direction bias for rooms that haven't met their requirement
                const accessOk = isAccessibilityMet(roomToGrow.id, grid, buildingW, buildingD);
                const prefDir = accessOk ? null : getPreferredDirection(roomToGrow.id, grid, buildingW, buildingD);

                let expansionCells = findBestRectangleExpansion(grid, roomToGrow.id, isCorridor, prefDir);

                if (!expansionCells) {
                    expansionCells = findBestFillExpansion(grid, roomToGrow.id, prefDir);
                }

                if (!expansionCells) {
                    // findSmartLineExpansion: concave-fill logic is self-converging; no dir bias needed
                    expansionCells = findSmartLineExpansion(grid, roomToGrow.id);
                }

                if (expansionCells && expansionCells.length > 0) {
                    // Build a lightweight dry-run test grid (shared by all guards below)
                    const originalCells = [...(grid.roomData[roomToGrow.id] || [])];
                    const testGrid = {
                        getCell: (x, y) => {
                            if (expansionCells.some(c => c.x === x && c.y === y)) return roomToGrow.id;
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
                    if (!isCorridor) {
                        if (countRoomVertices(testGrid, roomToGrow.id) > 8) {
                            // Expansion would make the room too complex, try next room
                            continue;
                        }
                    }

                    for (const cell of expansionCells) {
                        if (roomToGrow.currentArea < roomToGrow.targetGridCount) {
                            grid.addRoomCell(roomToGrow.id, cell.x, cell.y);
                            roomToGrow.currentArea++; // Increment by 1 grid cell
                        } else {
                            break;
                        }
                    }
                    growthHappenedThisCycle = true;
                    needsSort = true;
                    break;
                }
            }

            if (!growthHappenedThisCycle) {
                console.warn("Expansion stuck. No rooms could grow in Stage 2.");
                break;
            }
        }

        iterations++;
    }

    if (iterations === MAX_EXPANSION_ITERATIONS) {
        console.warn("Expansion reached max iterations.");
    }

    // Capture the final grid state (always fires regardless of exit path)
    if (onRegularExpansionComplete) onRegularExpansionComplete(grid);
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
    if (DEBUG_LAYOUT) console.log(`[Layout] fillGaps: ${emptyCells.length} empty cells`);

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
            if (DEBUG_LAYOUT) console.log(`[Layout] assign seg(${bestSegment.cells.length}) → ${bestRoomId} score=${bestScore.toFixed(2)}`);
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
 * Phase 3a: 无面积限制的 L/U 形继续生长。
 * 复用 Stage 2 的扩展逻辑，但移除 targetGridCount 限制，让所有房间持续生长直到无法再扩展。
 */
function runPhase3Growth(grid, rooms, rng) {
  let iterations = 0
  while (iterations < MAX_EXPANSION_ITERATIONS) {
    let grew = false
    // 按完成比例排序（面积最小的优先）
    const sorted = [...rooms].sort((a, b) => {
      const aA = grid.roomData[a.id]?.length || 0
      const bA = grid.roomData[b.id]?.length || 0
      return (aA / (a.targetGridCount || 1)) - (bA / (b.targetGridCount || 1))
    })

    for (const room of sorted) {
      const isCorridor = room.id === 'corridor_l1'
      let cells = findBestRectangleExpansion(grid, room.id, isCorridor)
      if (!cells) cells = findBestFillExpansion(grid, room.id)
      if (!cells) cells = findSmartLineExpansion(grid, room.id)
      if (!cells || cells.length === 0) continue

      // 走廊宽度守护
      if (isCorridor) {
        const currentMinWidth = getRoomMinCrossWidth(grid, room.id);

        // 创建一个 testGrid 来模拟生长后的状态
        const origCells = [...(grid.roomData[room.id] || [])];
        const testGrid = {
          getCell: (x, y) => cells.some(c => c.x === x && c.y === y) ? room.id : grid.getCell(x, y),
          getBoundingBox: (id) => {
            if (id !== room.id) return grid.getBoundingBox(id);
            const combined = [...origCells, ...cells];
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const c of combined) {
              if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
              if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y;
            }
            return { minX, minY, maxX, maxY };
          }
        };

        const newMinWidth = getRoomMinCrossWidth(testGrid, room.id);

        // 只有当宽度变得更窄，且仍低于标准时，才阻止
        if (newMinWidth < currentMinWidth && newMinWidth < CORRIDOR_MIN_WIDTH_CELLS) {
          continue;
        }
      }

      // 非走廊房间形态约束（最多 8 顶点）
      if (!isCorridor) {
        const origCells = [...(grid.roomData[room.id] || [])]
        const testGrid = {
          getCell: (x, y) => cells.some(c => c.x === x && c.y === y) ? room.id : grid.getCell(x, y),
          getBoundingBox: (id) => {
            if (id !== room.id) return grid.getBoundingBox(id)
            const combined = [...origCells, ...cells]
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
            for (const c of combined) {
              if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x
              if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y
            }
            return { minX, minY, maxX, maxY }
          }
        }
        if (countRoomVertices(testGrid, room.id) > 8) continue
      }

      cells.forEach(c => grid.addRoomCell(room.id, c.x, c.y))
      grew = true
      break
    }

    if (!grew) break
    iterations++
  }
}

/**
 * 单房间轻量质量评分（用于交换决策，不调用 evaluateTemplate）。
 * 综合：利用率 + 面积吻合度 - 形状惩罚
 */
function computeRoomQuality(grid, room) {
  const cellCount = grid.roomData[room.id]?.length || 0
  const bbox = grid.getBoundingBox(room.id)
  if (!cellCount || !bbox) return 0

  const bboxW = bbox.maxX - bbox.minX + 1
  const bboxH = bbox.maxY - bbox.minY + 1
  const ratio = Math.max(bboxW / bboxH, bboxH / bboxW)
  const util = cellCount / (bboxW * bboxH)
  const areaMatch = 1 - Math.abs(cellCount / (room.targetGridCount || 1) - 1)

  const shapePenalty = ratio > 4 ? (ratio - 4) * 30 : 0
  return Math.max(0, util * 100 + Math.max(0, areaMatch) * 80 - shapePenalty)
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
  const donors = [];
  const recipients = [];

  for (const room of rooms) {
    const currentArea = grid.roomData[room.id]?.length || 0;
    const targetArea = room.targetGridCount;
    if (targetArea === 0) continue;

    const deviation = (currentArea - targetArea) / targetArea;
    const data = { id: room.id, currentArea, targetArea, deviation };
    roomDataMap.set(room.id, data);

    if (deviation > 0) {
      donors.push(data);
    } else if (deviation < 0) {
      recipients.push(data);
    }
  }
  return { donors, recipients, roomDataMap };
}

/**
 * Finds geometrically significant chunks of cells on the boundary of a donor
 * that could be transferred to a recipient.
 * Implements "Boundary Push" and "Boundary Consolidation" strategies.
 * @returns {Array<Array<object>>} A list of cell chunks, where each chunk is an array of cells.
 */
function findCandidateChunks(grid, donorId, recipientId) {
    const chunks = [];

    const boundaryCells = (grid.roomData[donorId] || []).filter(cell => {
        return [[1,0],[-1,0],[0,1],[0,-1]].some(([dx, dy]) => grid.getCell(cell.x+dx, cell.y+dy) === recipientId);
    });
    if (boundaryCells.length === 0) return [];

    const boundarySet = new Set(boundaryCells.map(c => `${c.x},${c.y}`));
    const visited = new Set();

    // Strategy A: Boundary Push (finds contiguous boundary segments)
    for (const cell of boundaryCells) {
        const key = `${cell.x},${cell.y}`;
        if (visited.has(key)) continue;

        // Find all connected cells in this boundary segment using BFS
        const q = [cell];
        const currentSegment = [];
        visited.add(key);

        while(q.length > 0) {
            const current = q.shift();
            currentSegment.push(current);

            for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
                const neighborKey = `${current.x+dx},${current.y+dy}`;
                if (boundarySet.has(neighborKey) && !visited.has(neighborKey)) {
                    visited.add(neighborKey);
                    q.push({x: current.x+dx, y: current.y+dy});
                }
            }
        }

        // From a contiguous segment, create all possible sub-segments up to max size
        if (currentSegment.length > 0) {
            for (let i = 0; i < currentSegment.length; i++) {
                for (let j = i; j < currentSegment.length; j++) {
                    const subChunk = currentSegment.slice(i, j + 1);
                    if (subChunk.length > 0 && subChunk.length <= SWAP_MAX_CELLS) {
                        chunks.push(subChunk);
                    }
                }
            }
        }
    }

    // Strategy B: Boundary Consolidation (single-cell protrusions)
    const protrusions = boundaryCells.filter(cell => {
      const recipientNeighbors = [[1,0],[-1,0],[0,1],[0,-1]].filter(([dx, dy]) => grid.getCell(cell.x+dx, cell.y+dy) === recipientId).length;
      const donorNeighbors = [[1,0],[-1,0],[0,1],[-1,-1]].filter(([dx, dy]) => grid.getCell(cell.x+dx, cell.y+dy) === donorId).length;
      return (recipientNeighbors - donorNeighbors) > 0; // Cell is more "in" the recipient
    });

    chunks.push(...protrusions.map(p => [p])); // Add all protrusions as single-cell chunks

    // Deduplicate chunks to ensure we evaluate each unique chunk only once
    const uniqueChunks = [];
    const seenChunks = new Set();
    for (const chunk of chunks) {
        chunk.sort((a,b) => a.x - b.x || a.y - b.y);
        const chunkKey = chunk.map(c => `${c.x},${c.y}`).join(';');
        if (!seenChunks.has(chunkKey)) {
            uniqueChunks.push(chunk);
            seenChunks.add(chunkKey);
        }
    }

    return uniqueChunks;
}


/**
 * Evaluates all candidate chunks to find the one that maximizes quality improvement.
 * @returns {object|null} The best transfer found, or null if no improvement is possible.
 */
function findBestTransfer(grid, donors, roomDataMap, roomMap) {
  let bestTransfer = null;
  let maxQualityImprovement = 1e-6; // Minimum improvement to proceed

  for (const donor of donors) {
    const adjacentRecipients = findAdjacentRoomIds(grid, donor.id)
      .filter(id => roomDataMap.has(id) && roomDataMap.get(id).deviation < 0);

    for (const recipientId of adjacentRecipients) {
      const recipientRoom = roomMap.get(recipientId);
      if (!recipientRoom) continue;
      const donorRoom = roomMap.get(donor.id);

      const candidateChunks = findCandidateChunks(grid, donor.id, recipientId);

      for (const chunk of candidateChunks) {
        if (chunk.length === 0) continue;

        const qualityBefore = computeRoomQuality(grid, donorRoom) + computeRoomQuality(grid, recipientRoom);

        // Simulate transfer in a cloned grid to be safe
        const tempGrid = grid.clone();

        const donorCells = tempGrid.roomData[donor.id] || [];
        tempGrid.roomData[donor.id] = donorCells.filter(c => !chunk.some(t => t.x === c.x && t.y === c.y));
        chunk.forEach(c => tempGrid.addRoomCell(recipientId, c.x, c.y));

        if (isRoomConnected(tempGrid, donor.id)) {
          const qualityAfter = computeRoomQuality(tempGrid, donorRoom) + computeRoomQuality(tempGrid, recipientRoom);
          const improvement = qualityAfter - qualityBefore;

          if (improvement > maxQualityImprovement) {
            maxQualityImprovement = improvement;
            bestTransfer = {
              cells: chunk,
              donorId: donor.id,
              recipientId: recipientId,
              qualityImprovement: improvement,
            };
          }
        }
      }
    }
  }
  return bestTransfer;
}

/**
 * Phase 3b: Area-deviation driven space swap.
 * Iteratively transfers cell chunks from oversized rooms (donors) to
 * adjacent undersized rooms (recipients) to maximize a composite quality score.
 */
function runAreaSwap(grid, rooms) {
  const MAX_ITERATIONS = 50; // Fewer iterations as chunks are more impactful
  const roomMap = new Map(rooms.map(r => [r.id, r]));

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const { donors, recipients, roomDataMap } = categorizeRooms(grid, rooms);

    if (donors.length === 0 || recipients.length === 0) {
      if (DEBUG_LAYOUT) console.log(`[AreaSwap] Terminating: no more donors or recipients.`);
      break;
    }

    const bestTransfer = findBestTransfer(grid, donors, roomDataMap, roomMap);

    if (bestTransfer && bestTransfer.qualityImprovement > 0) {
      const { cells, donorId, recipientId } = bestTransfer;

      // Perform the actual transfer on the main grid
      grid.roomData[donorId] = grid.roomData[donorId].filter(c => !cells.some(t => t.x === c.x && t.y === c.y));
      cells.forEach(c => {
        grid.addRoomCell(recipientId, c.x, c.y);
      });

      if (DEBUG_LAYOUT) console.log(`[AreaSwap] Iter ${i}: Transferred chunk of ${cells.length} from ${donorId} -> ${recipientId}, quality gain ${bestTransfer.qualityImprovement.toFixed(2)}`);
    } else {
      if (DEBUG_LAYOUT) console.log(`[AreaSwap] Converged after ${i} iterations.`);
      break;
    }
    if (i === MAX_ITERATIONS - 1) {
        if (DEBUG_LAYOUT) console.log(`[AreaSwap] Reached max iterations.`);
    }
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
 * Used by ag41-building-layout.js to evaluate layouts at phase boundaries:
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




export function generateConstrainedLayout(seed, bW, bD, roomAreas = {}, runParams = {}, groupId = 'CG', variantIdx = 1, prefix = 'R', initialSeeds = null) {
  const { enableAreaSwap = false } = runParams;
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

  // 2. Create and process grids for each floor
  let groundGridBeforeGaps, groundGridAfterRect;
  const groundGrid = new Grid(gridW, gridH);
  let groundSeeds, groundGridAfterSeeds;
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
  groundGridAfterSeeds = groundGrid.clone();

  let level1GridBeforeGaps, level1GridAfterRect;
  const level1Grid = new Grid(gridW, gridH);
  let level1Seeds, level1GridAfterSeeds;
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
  level1GridAfterSeeds = level1Grid.clone();

  // --- Checkpoint A (Phase 1 snapshot evaluation) ---

  // 先用 stopAfterStage1=true 跑 Phase 1 来评估 Checkpoint A
  expandRooms(groundGrid, groundRooms, rng, bW, bD, (gridState) => {
    groundGridBeforeGaps = gridState.clone();
  }, (gridState) => {
    groundGridAfterRect = gridState.clone();
  }, true); // stopAfterStage1 = true
   if (!groundGridAfterRect) groundGridAfterRect = groundGrid.clone();
   if (!groundGridBeforeGaps) groundGridBeforeGaps = groundGrid.clone();

  expandRooms(level1Grid, level1Rooms, rng, bW, bD, (gridState) => {
    level1GridBeforeGaps = gridState.clone();
  }, (gridState) => {
    level1GridAfterRect = gridState.clone();
  }, true); // stopAfterStage1 = true
  if (!level1GridAfterRect) level1GridAfterRect = level1Grid.clone();
  if (!level1GridBeforeGaps) level1GridBeforeGaps = level1Grid.clone();

  const snapshot = buildPartialResult(groundGridAfterRect, level1GridAfterRect, bW, bD);
  const evaluated = evaluateTemplate(snapshot, { skipDoors: true });
  // Use relaxed door-access for Checkpoint A: rooms adjacent to an unclaimed empty region
  // that bridges to the exterior wall / corridor are considered virtually connected.
  // Strict door-access is still used in Checkpoint B and full scoring (Step 9).
  const relaxedDoorAccess = computeRelaxedDoorAccess(groundGridAfterRect, level1GridAfterRect);
  // Also filter out violations for rooms that passed via the bridging mechanism.
  // (evaluateTemplate adds ext_access violations independently of doorAccess, causing
  //  double-counting that would fail Checkpoint A even when doorAccess is relaxed.)
  const relaxedEvaluated = relaxedDoorAccess.bridgedIds.size > 0
    ? { ...evaluated, violations: evaluated.violations.filter(v => !relaxedDoorAccess.bridgedIds.has(v.room)) }
    : evaluated;
  const checkpointADiagnostic = evaluateCheckpointA(relaxedEvaluated, relaxedDoorAccess);

  // If the layout fails Checkpoint A, skip expensive Phase 2/3 growth
  if (!checkpointADiagnostic.passes) {
    const groundLayout = finalizeLayout(groundGridAfterRect).ground;
    const level1Layout = finalizeLayout(level1GridAfterRect).level1;
    return {
      id: `${prefix}-${groupId}-${variantIdx}`,
      label: `约束生长法 (未通过红线)`,
      desc: `建筑 ${(bW / 1000).toFixed(1)}m×${(bD / 1000).toFixed(1)}m`,
      groundPlacements: groundLayout,
      level1Placements: level1Layout,
      buildingW: bW,
      buildingD: bD,
      groupId,
      variantIdx,
      _debug: {
        roomTargets: allRooms,
        ground: { seeds: groundSeeds, gridAfterSeeds: groundGridAfterSeeds, gridAfterRect: groundGridAfterRect, gridBeforeGaps: groundGridAfterRect, gridAfterGaps: groundGridAfterRect },
        level1: { seeds: level1Seeds, gridAfterSeeds: level1GridAfterSeeds, gridAfterRect: level1GridAfterRect, gridBeforeGaps: level1GridAfterRect, gridAfterGaps: level1GridAfterRect },
      },
      checkpointADiagnostic,
    };
  }

  // ── Phase 2 (Step 6A): 对通过 Checkpoint A 的方案，继续跑有面积约束的 L/U 形扩展 ────────
  expandRooms(groundGrid, groundRooms, rng, bW, bD, (gridState) => {
    groundGridBeforeGaps = gridState.clone();
  }, null, false); // stopAfterStage1 = false，完整执行 Phase 2
  if (!groundGridBeforeGaps) groundGridBeforeGaps = groundGrid.clone();

  expandRooms(level1Grid, level1Rooms, rng, bW, bD, (gridState) => {
    level1GridBeforeGaps = gridState.clone();
  }, null, false); // stopAfterStage1 = false，完整执行 Phase 2
  if (!level1GridBeforeGaps) level1GridBeforeGaps = level1Grid.clone();

  // ▼ Checkpoint B（Step 6A 结束后）：第一梯队 + 第二梯队评价，分数 > -1000 才进入后续生长
  // 使用严格 doorAccess（无宽松），此时 Phase 2 已修正可达性
  const snapshotB = buildPartialResult(groundGridBeforeGaps, level1GridBeforeGaps, bW, bD);
  const evaluatedB = evaluateTemplate(snapshotB, { skipDoors: true });
  const checkpointBDiagnostic = scoreSpatialQuality(evaluatedB);
  const CHECKPOINT_B_THRESHOLD = -1000; // 总惩罚绝对值 < 1000 才通过

  if (checkpointBDiagnostic.partialScore < CHECKPOINT_B_THRESHOLD) {
    // 不通过 → 直接用 Phase 2 结果参与排名，跳过 Step 6B（无面积约束生长）与 Phase 3
    const groundLayout = finalizeLayout(groundGridBeforeGaps).ground;
    const level1Layout = finalizeLayout(level1GridBeforeGaps).level1;
    return {
      id: `${prefix}-${groupId}-${variantIdx}`,
      label: `约束生长法 (未通过检查点B)`,
      desc: `建筑 ${(bW / 1000).toFixed(1)}m×${(bD / 1000).toFixed(1)}m`,
      groundPlacements: groundLayout,
      level1Placements: level1Layout,
      buildingW: bW,
      buildingD: bD,
      groupId,
      variantIdx,
      _debug: {
        roomTargets: allRooms,
        ground: { seeds: groundSeeds, gridAfterSeeds: groundGridAfterSeeds, gridAfterRect: groundGridAfterRect, gridBeforeGaps: groundGridBeforeGaps, gridAfterGaps: groundGridBeforeGaps },
        level1: { seeds: level1Seeds, gridAfterSeeds: level1GridAfterSeeds, gridAfterRect: level1GridAfterRect, gridBeforeGaps: level1GridBeforeGaps, gridAfterGaps: level1GridBeforeGaps },
      },
      checkpointADiagnostic,
      checkpointBDiagnostic,
    };
  }

  // ── Step 6B: 无面积限制 L/U 生长 ──────────────────────────────────
  runPhase3Growth(groundGrid, groundRooms, rng)
  // ── Step 7a: 边界清理与空隙填充 ────────────────────────────────────
  if (enableAreaSwap) runAreaSwap(groundGrid, groundRooms)
  fillGaps(groundGrid, groundRooms);
  // ── Step 7b: 平滑房间交界线 ────────────────────────────────────────
  runSpaceSwap(groundGrid, groundRooms)

  // ── Step 6B: 无面积限制 L/U 生长 ──────────────────────────────────
  runPhase3Growth(level1Grid, level1Rooms, rng)
  // ── Step 7a: 边界清理与空隙填充 ────────────────────────────────────
  if (enableAreaSwap) runAreaSwap(level1Grid, level1Rooms)
  fillGaps(level1Grid, level1Rooms);
  // ── Step 7b: 平滑房间交界线 ────────────────────────────────────────
  runSpaceSwap(level1Grid, level1Rooms)

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
      roomTargets: allRooms,
      ground: { seeds: groundSeeds, gridAfterSeeds: groundGridAfterSeeds, gridAfterRect: groundGridAfterRect, gridBeforeGaps: groundGridBeforeGaps, gridAfterGaps: groundGrid },
      level1: { seeds: level1Seeds, gridAfterSeeds: level1GridAfterSeeds, gridAfterRect: level1GridAfterRect, gridBeforeGaps: level1GridBeforeGaps, gridAfterGaps: level1Grid },
    },
    checkpointADiagnostic,
    checkpointBDiagnostic,
  };
}
