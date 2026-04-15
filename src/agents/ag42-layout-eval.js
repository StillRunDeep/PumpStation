import { scoreLayout } from '../layout/scorer.js'
import { evaluateTemplate, centerX, centerY } from '../layout/placer.js'
import { GRID_SIZE } from '../layout/layout-generator.js'

/**
 * Compute average centroid distance (in grid cells) between two layouts.
 * Lower value = more similar layouts.
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
 * Apply diversity penalty to a ranked list (mutates in place).
 * A variant is penalised if it is too similar (avg centroid dist < threshold)
 * to any higher-ranked variant already in the list.
 *
 * @param {Array}  variants        Already sorted best-first
 * @param {number} threshold       Min avg centroid dist (grid cells) to be "different"
 * @param {number} penaltyPts      Score deduction per similar variant
 */
function applyDiversityPenalty(variants, threshold = 3.0, penaltyPts = 30) {
  for (let i = 1; i < variants.length; i++) {
    for (let j = 0; j < i; j++) {
      if (computeLayoutSimilarity(variants[j], variants[i]) < threshold) {
        variants[i].score -= penaltyPts
        variants[i].diversityPenalty = (variants[i].diversityPenalty || 0) - penaltyPts
        // Keep breakdown in sync so UI can show why score differs from raw scorer output
        if (variants[i].breakdown) {
          variants[i].breakdown.diversityPenalty = variants[i].diversityPenalty
        }
        break // penalise at most once per variant
      }
    }
  }
}

/** Score and enrich a single raw variant. */
function scoreVariant(template) {
  const evaluated = evaluateTemplate(template)
  const { score, spaceEfficiency, efficiencyScore, accessibilityScore, aspectRatio, diversityPenalty, breakdown } = scoreLayout(evaluated)
  return { ...evaluated, score, spaceEfficiency, efficiencyScore, accessibilityScore, aspectRatio, diversityPenalty, breakdown }
}

/**
 * AG4-3: Building Layout Evaluation
 *
 * Receives the raw layout variants from AG4-2, scores each one,
 * and returns them enriched with score, spaceEfficiency, accessibilityScore,
 * variantType, diversityPenalty and breakdown, sorted best-first.
 *
 * @param {Array} rawVariants  Raw output of generateConstrainedLayout() for each template
 * @returns {Array} Scored and sorted variants
 */
export function runAG42(rawVariants) {
  const evaluatedAndScored = rawVariants.map(scoreVariant)

  // 筛选规则：优先保留 violations = 0 的方案，按 score 降序排列
  const feasibleVariants   = evaluatedAndScored.filter(v => v.violations.length === 0)
  const unfeasibleVariants = evaluatedAndScored.filter(v => v.violations.length > 0)

  feasibleVariants.sort((a, b) => b.score - a.score)
  unfeasibleVariants.sort((a, b) => b.score - a.score)

  const targetCount = 9
  const finalVariants = [...feasibleVariants]

  // 如果可行方案不足目标数量，补充得分最高的无效方案
  if (finalVariants.length < targetCount) {
    finalVariants.push(...unfeasibleVariants.slice(0, targetCount - finalVariants.length))
  }

  finalVariants.sort((a, b) => b.score - a.score)
  applyDiversityPenalty(finalVariants)
  finalVariants.sort((a, b) => b.score - a.score)
  return finalVariants
}

/**
 * Merge existing scored variants with newly generated raw templates.
 * Combines all candidates, re-ranks, keeps top 9.
 *
 * @param {Array} existingVariants  Already-scored variants from a previous run
 * @param {Array} newRawTemplates   Raw template objects from runAG41()
 * @returns {{ variants: Array, improved: boolean, newScored: Array }}
 */
export function mergeVariants(existingVariants, newRawTemplates) {
  const newScored = newRawTemplates.map(t => ({ ...scoreVariant(t), _isNew: true }))

  const combined   = [...existingVariants, ...newScored]

  const feasible   = combined.filter(v => v.violations.length === 0).sort((a, b) => b.score - a.score)
  const unfeasible = combined.filter(v => v.violations.length > 0).sort((a, b) => b.score - a.score)

  const top9 = [...feasible, ...unfeasible.slice(0, Math.max(0, 9 - feasible.length))].slice(0, 9)
  top9.sort((a, b) => b.score - a.score)
  applyDiversityPenalty(top9)
  top9.sort((a, b) => b.score - a.score)

  const improved = top9.some(v => v._isNew)
  top9.forEach(v => delete v._isNew)

  return { variants: top9, improved, newScored }
}
