import { generateConstrainedLayout, buildPartialResult, computeRelaxedDoorAccess, GRID_SIZE, generateWeightMapForRoom } from '../layout/layout-generator.js'
import { ROOM_DEFS } from '../layout/room-defs.js';
import { getDefaultUserParams, getUserConfirmedParams } from '../layout/user-params.js'
import { centerX, centerY, evaluateTemplate } from '../layout/placer.js'
import { scoreSpatialQuality } from '../layout/scorer.js'

// 每生成一个方案后 yield，让浏览器处理积压的事件（点击等）
const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * 检查点 B：对 L/U 形扩展阶段（Phase 2）结束后的快照进行第一+第二梯队评价，
 * 将 `_checkpointBScore` 字段写入各方案并按分数降序排序（原地修改）。
 */
function applyCheckpointB(layouts, buildingW, buildingD) {
  for (const layout of layouts) {
    try {
      const groundGrid = layout?._debug?.ground?.gridBeforeGaps;
      const level1Grid = layout?._debug?.level1?.gridBeforeGaps;
      if (!groundGrid || !level1Grid) {
        console.warn('applyCheckpointB: layout missing gridBeforeGaps, skipping score', layout);
        layout._checkpointBScore = -Infinity;
        continue;
      }
      const snapshot = buildPartialResult(groundGrid, level1Grid, buildingW, buildingD)
      const relaxed = computeRelaxedDoorAccess(groundGrid, level1Grid)
      const evaluated = { ...evaluateTemplate(snapshot), _relaxedDoorAccess: relaxed }
      layout._checkpointBScore = scoreSpatialQuality(evaluated).partialScore ?? -Infinity
      layout._relaxedDoorAccess = relaxed
    } catch (e) {
      console.error('applyCheckpointB failed for layout:', e);
      layout._checkpointBScore = -Infinity;
    }
  }
  layouts.sort((a, b) => (b._checkpointBScore ?? -Infinity) - (a._checkpointBScore ?? -Infinity))
}

/**
 * AG4-2: Building Space Layout Generator
 *
 * 分阶段生成逻辑：
 * 1. 矩形扩展（Phase 1）结束后执行检查点 A（硬性功能红线）过滤，
 *    凑齐 9 个通过方案后进入第二阶段。
 * 2. L/U 形扩展（Phase 2）结束后执行检查点 B（第一+第二梯队）排序。
 * 3. 全量评分由 AG4-3（ag42-layout-eval.js）在正式视图阶段执行。
 *
 * @returns {Promise<Array>} 经检查点 A 过滤、检查点 B 排序的 9 个方案
 */
export async function runAG41(existingVariants = [], isCancelled = () => false) {
  // 1. 获取用户确认的参数
  const defaultUserParams = getDefaultUserParams();
  const userParams = await getUserConfirmedParams(defaultUserParams);
  const { buildingW, buildingD, roomTargetAreas } = userParams;

  const sortedExisting = [...existingVariants].sort((a, b) => b.score - a.score);
  const results = [];
  let attempts = 0;

  // 调试开关：跳过 Checkpoint A（让所有方案直接进入阶段2/3）
  const bypassCheckpointA = !!(document.getElementById('chk-bypass-ckA')?.checked);

  // 1. 交叉进化 (2个方案)
  if (sortedExisting.length >= 5) {
    const rank9 = sortedExisting[8] || sortedExisting[0]; // Fallback for smaller populations
    const parentPairs = [
      { a: sortedExisting[0], b: sortedExisting[4], prefix: 'C15' },
      { a: sortedExisting[4], b: rank9, prefix: 'C59' },
    ];

    for (const { a, b, prefix } of parentPairs) {
      if (isCancelled()) break;
      const seed = Math.floor(Math.random() * 100000);
      const child = generateHybridLayout(a, b, seed, buildingW, buildingD, roomTargetAreas, 'Evo', results.length + 1, prefix, bypassCheckpointA);
      results.push(evaluateTemplate(child));
      attempts++;
      await yieldToEventLoop();
    }
  }

  // 2. 随机探索 (7个方案)
  const explorers = [
    // 组1: 对未验证房间进行智能优化 (3个)
    { parent: sortedExisting[0] || null, reRandomize: 'unverified_smart', count: 1, prefix: 'O1' },
    { parent: sortedExisting[1] || null, reRandomize: 'unverified_smart', count: 1, prefix: 'O2' },
    { parent: sortedExisting[2] || null, reRandomize: 'unverified_smart', count: 1, prefix: 'O3' },
    // 组2: 仅保留通过验证的房间 (2个)
    { parent: sortedExisting[3] || null, reRandomize: 'all_but_verified', count: 1, prefix: 'M4' },
    { parent: sortedExisting[4] || null, reRandomize: 'all_but_verified', count: 1, prefix: 'M5' },
    // 组3: 纯随机 (2个)
    { parent: null, reRandomize: 'all', count: 2, prefix: 'RND' },
  ];

  for (const { parent, reRandomize, count, prefix } of explorers) {
    for (let i = 0; i < count; i++) {
      if (isCancelled() || results.length >= 9) break;
      const seed = Math.floor(Math.random() * 100000);

      if (parent) {
        const child = generateMutatedLayout(parent, reRandomize, seed, buildingW, buildingD, roomTargetAreas, 'Exp', results.length + 1, prefix, bypassCheckpointA);
        results.push(evaluateTemplate(child));
      } else {
        const randomLayout = generateConstrainedLayout(seed, buildingW, buildingD, roomTargetAreas, { enableAreaSwap: true, bypassCheckpointA }, 'Exp', results.length + 1, prefix);
        results.push(evaluateTemplate(randomLayout));
      }
      attempts++;
      await yieldToEventLoop();
    }
    if (isCancelled() || results.length >= 9) break;
  }

  // 补足：如果交叉和变异没有生成足够方案，用纯随机补足
  while (results.length < 9 && attempts < 50 && !isCancelled()) {
    const seed = Math.floor(Math.random() * 100000);
    const randomLayout = generateConstrainedLayout(seed, buildingW, buildingD, roomTargetAreas, { enableAreaSwap: true, bypassCheckpointA }, 'Fill', results.length + 1, 'R');
    results.push(evaluateTemplate(randomLayout));
    attempts++;
    await yieldToEventLoop();
  }

  results._attemptCount = attempts;
  applyCheckpointB(results, buildingW, buildingD);
    return results;
}

function generateMutatedLayout(parent, reRandomize, seed, bW, bD, roomAreas, groupId, variantIdx, prefix, bypassCheckpointA = false) {
  const childSeeds = { ground: {}, level1: {} };
  const verifiedRooms = new Set();

  const allRoomIds = Object.keys(ROOM_DEFS);

  // A room is "verified" if it doesn't participate in any hard-redline violations.
  const violatingRooms = new Set();
  if (parent.violations) {
    parent.violations.forEach(v => {
      if (v.constraint === 'must_adjacent') {
        v.room.split('↔').forEach(r => violatingRooms.add(r));
      } else {
        violatingRooms.add(v.room);
      }
    });
  }
  if (parent._relaxedDoorAccess?.ids) {
    parent._relaxedDoorAccess.ids.forEach(id => violatingRooms.add(id));
  }

  ['ground', 'level1'].forEach(floor => {
    const roomsOnThisFloor = allRoomIds.filter(id => ROOM_DEFS[id].floor === floor && !ROOM_DEFS[id].isOpening);
    const gridW = Math.floor(bW / GRID_SIZE);
    const gridH = Math.floor(bD / GRID_SIZE);

    for (const roomId of roomsOnThisFloor) {
      const isVerified = !violatingRooms.has(roomId);
      let keepSeed = false;

      if (reRandomize === 'unverified' && isVerified) {
        keepSeed = true;
      } else if (reRandomize === 'all_but_verified' && isVerified) {
        keepSeed = true;
      }

      const parentPlacement = parent?.[`${floor}Placements`]?.[roomId];

      if (keepSeed && parentPlacement) {
        childSeeds[floor][roomId] = placementToGridCenter(parentPlacement);
      } else {
        // This room's seed is not kept, so it gets a new random one.
        if (reRandomize === 'unverified_smart') {
          // Smart randomization: use weight map to find a better spot.
          const roomDef = { id: roomId, ...ROOM_DEFS[roomId] };
          // Create a mock grid and a map of already placed seeds for the weight map function
          const mockGrid = { width: gridW, height: gridH, getCell: (x, y) => {
            for (const seed of Object.values(childSeeds[floor])) {
              if (seed.x === x && seed.y === y) return 1; // Occupied
            }
            return 0; // Empty
          }};
          const weightMap = generateWeightMapForRoom(mockGrid, roomDef, childSeeds[floor]);

          let bestPos = null;
          let maxWeight = -1;
          // Increased attempts to find a high-weight spot
          for (let i = 0; i < 500; i++) {
            const x = Math.floor(Math.random() * gridW);
            const y = Math.floor(Math.random() * gridH);
            if (mockGrid.getCell(x,y) === 0 && weightMap[y][x] > maxWeight) {
              maxWeight = weightMap[y][x];
              bestPos = { x, y };
            }
          }
          childSeeds[floor][roomId] = bestPos || { x: Math.floor(Math.random() * gridW), y: Math.floor(Math.random() * gridH) };
        } else {
          // Pure random placement
          childSeeds[floor][roomId] = {
            x: Math.floor(Math.random() * gridW),
            y: Math.floor(Math.random() * gridH),
          };
        }
      }
    }
  });

  return generateConstrainedLayout(seed, bW, bD, roomAreas, { enableAreaSwap: true, bypassCheckpointA }, groupId, variantIdx, prefix, childSeeds);
}

/**
 * Convert a room placement (mm coords) to grid-cell center.
 * Uses the parent layout's actual bounding-box center as the child seed,
 * so children inherit the spatial structure of their parents.
 */
function placementToGridCenter(placement) {
  return {
    x: Math.round(centerX(placement) / GRID_SIZE),
    y: Math.round(centerY(placement) / GRID_SIZE),
  }
}

function generateHybridLayout(parentA, parentB, seed, bW, bD, roomAreas, groupId, variantIdx, prefix, bypassCheckpointA = false) {
  // Use a simple pseudo-random generator based on the seed for deterministic crossover
  let rngState = seed;
  const rng = () => {
    rngState = (rngState * 9301 + 49297) % 233280;
    return rngState / 233280;
  };

  const childSeeds = { ground: {}, level1: {} };

  const allRoomIds = Object.keys(ROOM_DEFS);
  const gridW = Math.floor(bW / GRID_SIZE);
  const gridH = Math.floor(bD / GRID_SIZE);

  ['ground', 'level1'].forEach(floor => {
    const usedCoords = new Set();
    const roomsOnThisFloor = allRoomIds.filter(id => ROOM_DEFS[id].floor === floor && !ROOM_DEFS[id].isOpening);

    for (const roomId of roomsOnThisFloor) {
      const pA = parentA?.[`${floor}Placements`]?.[roomId];
      const pB = parentB?.[`${floor}Placements`]?.[roomId];

      let placement = null;
      if (pA && pB) {
        const chosenParent = rng() < 0.5 ? parentA : parentB;
        placement = chosenParent?.[`${floor}Placements`]?.[roomId] || pA || pB;
      } else {
        placement = pA || pB;
      }

      if (placement) {
        let seedPos = placementToGridCenter(placement);

        // Anti-collision
        let key = `${seedPos.x},${seedPos.y}`;
        let attempts = 0;
        while (usedCoords.has(key) && attempts < 20) {
          seedPos.x = (seedPos.x + (rng() < 0.5 ? 1 : -1) + gridW) % gridW;
          seedPos.y = (seedPos.y + (rng() < 0.5 ? 1 : -1) + gridH) % gridH;
          key = `${seedPos.x},${seedPos.y}`;
          attempts++;
        }
        childSeeds[floor][roomId] = seedPos;
        usedCoords.add(key);
      } else {
        // Spontaneous mutation: if a room is missing from both parents, give it a random seed.
        childSeeds[floor][roomId] = {
          x: Math.floor(rng() * gridW),
          y: Math.floor(rng() * gridH),
        };
      }
    }
  });

  return generateConstrainedLayout(seed, bW, bD, roomAreas, { enableAreaSwap: true, bypassCheckpointA }, groupId, variantIdx, prefix, childSeeds);
}
