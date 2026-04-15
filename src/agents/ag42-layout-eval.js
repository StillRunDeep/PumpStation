import { scoreLayout } from '../layout/scorer.js'
import { evaluateTemplate } from '../layout/placer.js'

/**
 * Classify each variant's type based on its characteristics relative to
 * the full set of evaluated variants.
 *
 * Priority order (a variant can only have one type):
 *   compact       – smallest building footprint (buildingW × buildingD)
 *   large-repair  – largest repair_zone actual area
 *   large-parking – largest parking actual area
 *   standard      – everything else
 *
 * @param {Array} variants  Already-scored variants (mutated in place)
 */
function assignVariantTypes(variants) {
  if (!variants.length) return

  const footprint = v => (v.buildingW ?? 0) * (v.buildingD ?? 0)
  const roomArea  = (v, id) => {
    const p = (v.groundPlacements || {})[id] || (v.level1Placements || {})[id]
    return p ? p.w * p.d : 0
  }

  const minFp       = Math.min(...variants.map(footprint))
  const maxRepair   = Math.max(...variants.map(v => roomArea(v, 'repair_zone')))
  const maxParking  = Math.max(...variants.map(v => roomArea(v, 'parking')))

  for (const v of variants) {
    if (footprint(v) <= minFp) {
      v.variantType = 'compact'
    } else if (roomArea(v, 'repair_zone') >= maxRepair && maxRepair > 0) {
      v.variantType = 'large-repair'
    } else if (roomArea(v, 'parking') >= maxParking && maxParking > 0) {
      v.variantType = 'large-parking'
    } else {
      v.variantType = 'standard'
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

  // Assign variant type labels across the full candidate pool
  assignVariantTypes(evaluatedAndScored)

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
  assignVariantTypes(combined)

  const feasible   = combined.filter(v => v.violations.length === 0).sort((a, b) => b.score - a.score)
  const unfeasible = combined.filter(v => v.violations.length > 0).sort((a, b) => b.score - a.score)

  const top9 = [...feasible, ...unfeasible.slice(0, Math.max(0, 9 - feasible.length))].slice(0, 9)
  top9.sort((a, b) => b.score - a.score)

  const improved = top9.some(v => v._isNew)
  top9.forEach(v => delete v._isNew)

  return { variants: top9, improved, newScored }
}
