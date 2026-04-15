import { generateConstrainedLayout, GRID_SIZE } from '../layout/layout-generator.js'
import { getDefaultUserParams, getUserConfirmedParams } from '../layout/user-params.js'
import { centerX, centerY } from '../layout/placer.js'

/**
 * AG4-2: Building Space Layout Generator
 *
 * Scoring and ranking is handled by AG4-3 (ag42-layout-eval.js).
 *
 * @returns {Promise<Array>} unsorted layout variants
 */
export async function runAG41(existingVariants = [], isCancelled = () => false) {
  // 1. 获取用户确认的参数
  const defaultUserParams = getDefaultUserParams();
  const userParams = await getUserConfirmedParams(defaultUserParams);
  const { buildingW, buildingD, roomTargetAreas } = userParams;

  const variants = [];
  const sortedExisting = [...existingVariants].sort((a, b) => b.score - a.score);
  const numToGenerate = 9;
  let pCount = 0;
  let rCount = 0;

  // 每生成一个方案后 yield，让浏览器处理积压的事件（点击等）
  const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0))

  // 生成遗传算法方案（2 个，防止第一名影响过大）
  // 组A: 第1名 + 第5名
  // 组B: 第5名 + 第9名
  if (sortedExisting.length >= 5) {
    const parentPairs = [];
    
    // Pair 1: Rank 1 + Rank 5
    parentPairs.push([sortedExisting[0], sortedExisting[4]]);
    
    // Pair 2: Rank 5 + Rank 9 (if exists) or Rank 5 + Rank 1 (if less than 9)
    const rank9 = sortedExisting[8] || sortedExisting[0];
    parentPairs.push([sortedExisting[4], rank9]);

    for (let i = 0; i < 2; i++) {
      if (isCancelled()) return variants
      const [parentA, parentB] = parentPairs[i];
      const seed = Math.floor(Math.random() * 100000) + pCount;
      const t = generateHybridLayout(parentA, parentB, seed, buildingW, buildingD, roomTargetAreas, 'S', pCount + 1);
      variants.push(t);
      pCount++;
      await yieldToEventLoop()
    }
  }

  // 生成纯随机方案（补足 9 个）
  const numRandom = numToGenerate - pCount;
  for (let i = 0; i < numRandom; i++) {
    if (isCancelled()) return variants
    const seed = Math.floor(Math.random() * 100000) + i;
    const t = generateConstrainedLayout(seed, buildingW, buildingD, roomTargetAreas, 'S', rCount + 1, 'R');
    variants.push(t);
    rCount++;
    await yieldToEventLoop()
  }

  return variants;
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

function generateHybridLayout(parentA, parentB, seed, bW, bD, roomAreas, groupId, variantIdx) {
  // Use seed to determine which parent dominates for each room
  const rng = () => (seed % 10000) / 10000;

  const childSeeds = { ground: {}, level1: {} };

  const allRoomIds = new Set([
      ...Object.keys(parentA._debug.ground.seeds),
      ...Object.keys(parentB._debug.ground.seeds),
      ...Object.keys(parentA._debug.level1.seeds),
      ...Object.keys(parentB._debug.level1.seeds)
  ]);

  for (const roomId of allRoomIds) {
      const hasGroundA = parentA._debug.ground.seeds[roomId];
      const hasGroundB = parentB._debug.ground.seeds[roomId];
      const hasLevel1A = parentA._debug.level1.seeds[roomId];
      const hasLevel1B = parentB._debug.level1.seeds[roomId];

      // Ground floor crossover: use bounding-box center of chosen parent's actual room placement
      if (hasGroundA || hasGroundB) {
          const chosenParent = rng() < 0.5 ? parentA : parentB;
          const fallbackParent = chosenParent === parentA ? parentB : parentA;
          const placement = (chosenParent.groundPlacements || {})[roomId]
                         || (fallbackParent.groundPlacements || {})[roomId];
          if (placement) {
              childSeeds.ground[roomId] = placementToGridCenter(placement);
          }
      }

      // Level 1 crossover: same strategy
      if (hasLevel1A || hasLevel1B) {
          const chosenParent = rng() < 0.5 ? parentA : parentB;
          const fallbackParent = chosenParent === parentA ? parentB : parentA;
          const placement = (chosenParent.level1Placements || {})[roomId]
                         || (fallbackParent.level1Placements || {})[roomId];
          if (placement) {
              childSeeds.level1[roomId] = placementToGridCenter(placement);
          }
      }
  }

  return generateConstrainedLayout(seed, bW, bD, roomAreas, groupId, variantIdx, 'P', childSeeds);
}
