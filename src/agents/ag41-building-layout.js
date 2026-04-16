import { generateConstrainedLayout, buildPartialResult, GRID_SIZE } from '../layout/layout-generator.js'
import { getDefaultUserParams, getUserConfirmedParams } from '../layout/user-params.js'
import { centerX, centerY, evaluateTemplate } from '../layout/placer.js'
import { scoreHardRedlines, scoreSpatialQuality } from '../layout/scorer.js'

// 每生成一个方案后 yield，让浏览器处理积压的事件（点击等）
const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * 检查点 A：对矩形扩展阶段（Phase 1）结束后的快照进行硬性功能红线评价。
 * @returns {{ passes: boolean, missingRoomCount: number, doorAccessCount: number, violationCount: number }}
 */
function checkCheckpointA(layout, buildingW, buildingD) {
  const snapshot = buildPartialResult(
    layout._debug.ground.gridAfterRect,
    layout._debug.level1.gridAfterRect,
    buildingW, buildingD
  )
  const evaluated = evaluateTemplate(snapshot)
  const { passes, missingRoomCount, doorAccessCount, violationCount } = scoreHardRedlines(evaluated)
  return { passes, missingRoomCount, doorAccessCount, violationCount }
}

/**
 * 检查点 B：对 L/U 形扩展阶段（Phase 2）结束后的快照进行第一+第二梯队评价，
 * 将 `_checkpointBScore` 字段写入各方案并按分数降序排序（原地修改）。
 */
function applyCheckpointB(layouts, buildingW, buildingD) {
  for (const layout of layouts) {
    const snapshot = buildPartialResult(
      layout._debug.ground.gridBeforeGaps,
      layout._debug.level1.gridBeforeGaps,
      buildingW, buildingD
    )
    const evaluated = evaluateTemplate(snapshot)
    layout._checkpointBScore = scoreSpatialQuality(evaluated).partialScore
  }
  layouts.sort((a, b) => b._checkpointBScore - a._checkpointBScore)
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
  const numToGenerate = 9;
  const MAX_ATTEMPTS = 50; // 防止无限循环
  const passing = []; // 通过检查点 A 的方案
  let pCount = 0;
  let rCount = 0;
  let attempts = 0;
  let lastFailure = null; // 最后一次检查点 A 失败的诊断信息

  // 优先尝试生成遗传算法方案（最多 2 个，防止第一名影响过大）
  // 组A: 第1名 + 第5名；组B: 第5名 + 第9名
  if (sortedExisting.length >= 5) {
    const rank9 = sortedExisting[8] || sortedExisting[0];
    const parentPairs = [
      [sortedExisting[0], sortedExisting[4]],
      [sortedExisting[4], rank9],
    ];

    for (let i = 0; i < 2 && passing.length < numToGenerate; i++) {
      if (isCancelled()) return passing
      const [parentA, parentB] = parentPairs[i];
      const seed = Math.floor(Math.random() * 100000) + pCount;
      const t = generateHybridLayout(parentA, parentB, seed, buildingW, buildingD, roomTargetAreas, 'S', pCount + 1);
      attempts++;
      const checkA = checkCheckpointA(t, buildingW, buildingD);
      if (checkA.passes) {
        passing.push(t);
        pCount++;
      } else {
        lastFailure = checkA;
      }
      await yieldToEventLoop()
    }
  }

  // 用纯随机方案补足至 9 个（含检查点 A 过滤）
  while (passing.length < numToGenerate && attempts < MAX_ATTEMPTS) {
    if (isCancelled()) return passing
    const seed = Math.floor(Math.random() * 100000) + rCount;
    const t = generateConstrainedLayout(seed, buildingW, buildingD, roomTargetAreas, 'S', rCount + 1, 'R');
    attempts++;
    const checkA = checkCheckpointA(t, buildingW, buildingD);
    if (checkA.passes) {
      passing.push(t);
      rCount++;
    } else {
      lastFailure = checkA;
    }
    await yieldToEventLoop()
  }

  // 将诊断信息附加到返回数组，供调用方展示提示
  passing._checkpointADiagnostic = lastFailure;
  passing._attemptCount = attempts;

  // 检查点 B：对 9 个通过方案按第一+第二梯队得分排序
  applyCheckpointB(passing, buildingW, buildingD)

  return passing;
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
