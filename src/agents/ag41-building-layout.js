import { generateConstrainedLayout } from '../layout/layout-generator.js'
import { getDefaultUserParams, getUserConfirmedParams } from '../layout/user-params.js'

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
  const topVariants = [...existingVariants].sort((a, b) => b.score - a.score).slice(0, 3);
  const numToGenerate = 9;
  let pCount = 0;
  let rCount = 0;

  // 每生成一个方案后 yield，让浏览器处理积压的事件（点击等）
  const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0))

  // 生成遗传算法方案
  if (topVariants.length >= 2) {
    const parentPairs = [
      [topVariants[0], topVariants[1]],
      [topVariants[0], topVariants[topVariants.length > 2 ? 2 : 1]],
      [topVariants[1], topVariants[topVariants.length > 2 ? 2 : 1]],
    ];
    for (let i = 0; i < 3; i++) {
      if (isCancelled()) return variants
      const [parentA, parentB] = parentPairs[i];
      const seed = Math.floor(Math.random() * 100000) + pCount;
      const t = generateHybridLayout(parentA, parentB, seed, buildingW, buildingD, roomTargetAreas, 'S', pCount + 1);
      variants.push(t);
      pCount++;
      await yieldToEventLoop()
    }
  }

  // 生成纯随机方案
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

function generateHybridLayout(parentA, parentB, seed, bW, bD, roomAreas, groupId, variantIdx) {
  const rng = () => (seed % 10000) / 10000; // Simple RNG from seed

  const childSeeds = { ground: {}, level1: {} };

  const allRoomIds = new Set([
      ...Object.keys(parentA._debug.ground.seeds),
      ...Object.keys(parentB._debug.ground.seeds),
      ...Object.keys(parentA._debug.level1.seeds),
      ...Object.keys(parentB._debug.level1.seeds)
  ]);

  for (const roomId of allRoomIds) {
      const seedA_ground = parentA._debug.ground.seeds[roomId];
      const seedB_ground = parentB._debug.ground.seeds[roomId];
      const seedA_level1 = parentA._debug.level1.seeds[roomId];
      const seedB_level1 = parentB._debug.level1.seeds[roomId];

      // Ground floor crossover and mutation
      if (seedA_ground || seedB_ground) {
          const parentSeed = rng() < 0.5 ? (seedA_ground || seedB_ground) : (seedB_ground || seedA_ground);
          if (parentSeed) {
              childSeeds.ground[roomId] = {
                  x: parentSeed.x + Math.floor(Math.random() * 5) - 2, // Mutate x by +/- 2
                  y: parentSeed.y + Math.floor(Math.random() * 5) - 2  // Mutate y by +/- 2
              };
          }
      }

      // Level 1 crossover and mutation
      if (seedA_level1 || seedB_level1) {
          const parentSeed = rng() < 0.5 ? (seedA_level1 || seedB_level1) : (seedB_level1 || seedA_level1);
          if (parentSeed) {
              childSeeds.level1[roomId] = {
                  x: parentSeed.x + Math.floor(Math.random() * 5) - 2, // Mutate x by +/- 2
                  y: parentSeed.y + Math.floor(Math.random() * 5) - 2  // Mutate y by +/- 2
              };
          }
      }
  }

  return generateConstrainedLayout(seed, bW, bD, roomAreas, groupId, variantIdx, 'P', childSeeds);
}
