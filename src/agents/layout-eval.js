import { scoreLayout } from '../layout/evaluation/scorer.js'
import { evaluateTemplate, centerX, centerY } from '../layout/generator/placer.js'
import { GRID_SIZE } from '../layout/generator/layout-generator.js'
import { SCORER_PARAMS } from '../layout/evaluation/scorer-params.js'

/**
 * 计算两个方案之间房间重心的平均欧几里得距离（以网格为单位）。
 * 值越小表示方案越相似。
 */
function computeLayoutSimilarity(varA, varB) {
  const allA = { ...(varA.groundPlacements || {}), ...(varA.level1Placements || {}) }
  const allB = { ...(varB.groundPlacements || {}), ...(varB.level1Placements || {}) }

  let totalDist = 0
  let count = 0
  for (const roomId of Object.keys(allA)) {
    if (!allB[roomId]) continue
    const pA = allA[roomId], pB = allB[roomId]
    totalDist += Math.hypot(
      (centerX(pA) - centerX(pB)) / GRID_SIZE,
      (centerY(pA) - centerY(pB)) / GRID_SIZE
    )
    count++
  }
  return count > 0 ? totalDist / count : Infinity
}

/**
 * 对排序后的列表应用多样性惩罚（原地修改）。
 * 如果一个方案与排名更高的方案过于相似，则扣分。
 */
export function applyDiversityPenalty(variants) {
  const threshold = SCORER_PARAMS.diversityThreshold ?? 5.0
  const penaltyPts = SCORER_PARAMS.diversityPenalty ?? 200

  for (let i = 1; i < variants.length; i++) {
    for (let j = 0; j < i; j++) {
      if (computeLayoutSimilarity(variants[j], variants[i]) < threshold) {
        variants[i].score -= penaltyPts
        variants[i].diversityPenalty = (variants[i].diversityPenalty || 0) - penaltyPts
        if (variants[i].breakdown) {
          variants[i].breakdown.diversityPenalty = variants[i].diversityPenalty
        }
        break // 每个方案最多惩罚一次
      }
    }
  }
}

/** 评分并丰富单个原始方案 */
function scoreVariant(template) {
  const evaluated = evaluateTemplate(template)
  return { ...evaluated, ...scoreLayout(evaluated) }
}

/**
 * 重新评分一组已生成的方案，并应用多样性惩罚。
 * 常用于用户调整评分参数后。
 */
export function rescoreVariants(variants) {
  const scored = variants.map(v => ({ ...v, ...scoreLayout(v) }))
  scored.sort((a, b) => b.score - a.score)
  applyDiversityPenalty(scored)
  scored.sort((a, b) => b.score - a.score)
  return scored
}

/**
 * 将现有的已评分方案与新生成的原始模板合并。
 * 1. 对存量方案重评分（清除旧的多样性惩罚）。
 * 2. 对新方案评分。
 * 3. 统一排序并应用多样性惩罚。
 * 4. 返回前 9 名。
 */
export function mergeVariants(existingVariants, newRawTemplates) {
  // 1. 重评分存量方案，确保没有遗留的旧惩罚分
  const reScoredExisting = existingVariants.map(v => ({ ...v, ...scoreLayout(v) }))

  // 2. 评分新生成的模板
  const newScored = newRawTemplates.map(t => ({ ...scoreVariant(t), _isNew: true }))

  // 3. 合并池
  const combined = [...reScoredExisting, ...newScored]
  combined.sort((a, b) => b.score - a.score)

  // 4. 对前 18 名应用多样性惩罚
  const poolSize = Math.min(combined.length, 18)
  const topCandidates = combined.slice(0, poolSize)
  applyDiversityPenalty(topCandidates)

  // 5. 最终排序并取 Top 9
  topCandidates.sort((a, b) => b.score - a.score)
  const top9 = topCandidates.slice(0, 9)
  const eliminated = topCandidates.slice(9)

  const improved = top9.some(v => v._isNew)
  top9.forEach(v => delete v._isNew)
  eliminated.forEach(v => delete v._isNew)

  return { variants: top9, improved, newScored, eliminated }
}
