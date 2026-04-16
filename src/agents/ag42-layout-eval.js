import { scoreLayout } from '../layout/scorer.js'
import { evaluateTemplate, centerX, centerY } from '../layout/placer.js'
import { GRID_SIZE } from '../layout/layout-generator.js'
import { SCORER_PARAMS } from '../layout/scorer-params.js'

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
 */
function applyDiversityPenalty(variants) {
  const threshold = SCORER_PARAMS.diversityThreshold ?? 5.0
  const penaltyPts = SCORER_PARAMS.diversityPenalty ?? 200

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

  // Unified scoring: just sort by score descending
  evaluatedAndScored.sort((a, b) => b.score - a.score)

  // Apply diversity penalty to the pool
  applyDiversityPenalty(evaluatedAndScored)

  // Re-sort after penalty to ensure final order is correct
  evaluatedAndScored.sort((a, b) => b.score - a.score)

  return evaluatedAndScored.slice(0, 9)
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

  // Combine all candidates into one pool
  const combined = [...existingVariants, ...newScored]

  // Unified ranking: no more feasible/unfeasible buckets
  combined.sort((a, b) => b.score - a.score)

  // Apply diversity penalty to a larger pool to ensure top 9 are diverse and the best
  const poolSize = Math.min(combined.length, 18)
  const topCandidates = combined.slice(0, poolSize)
  applyDiversityPenalty(topCandidates)

  // Final sort and select top 9
  topCandidates.sort((a, b) => b.score - a.score)
  const top9 = topCandidates.slice(0, 9)

  const improved = top9.some(v => v._isNew)
  top9.forEach(v => delete v._isNew)

  return { variants: top9, improved, newScored }
}
