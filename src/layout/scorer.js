import { adjacent, centerX, centerY } from './placer.js'

// Rooms excluded from space efficiency numerator (non-functional spaces)
const NON_FUNCTIONAL = new Set(['corridor_l1', 'dock1', 'dock2'])

// Ground-floor rooms considered for accessibility scoring
const ACCESSIBILITY_ROOMS = ['trafo1', 'trafo2', 'meter_main', 'meter_sub', 'fire_equip', 'parking', 'repair_zone']

function floorFunctionalArea(placements) {
  const seen = new Set()
  return Object.values(placements || {})
    .filter(p => !NON_FUNCTIONAL.has(p.id))
    .filter(p => {
      // Skip exact duplicates (safety guard for any rooms sharing identical footprint)
      const key = `${p.x},${p.y},${p.w},${p.d}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .reduce((sum, p) => sum + p.w * p.d, 0)
}

/**
 * Compute space efficiency: average of per-floor (functional area / floor area).
 * Computed separately per floor to avoid double-counting across floors.
 * @returns {number} 0~1
 */
export function computeSpaceEfficiency(result) {
  const { buildingW, buildingD, groundPlacements, level1Placements } = result
  const floorArea = buildingW * buildingD
  const groundEff  = floorFunctionalArea(groundPlacements)  / floorArea
  const level1Eff  = floorFunctionalArea(level1Placements)  / floorArea
  return (groundEff + level1Eff) / 2
}

/**
 * Compute accessibility score (0~30).
 *
 * Proxy approach: use Euclidean distance from the nominal main entrance
 * (south-wall midpoint of ground floor) to each functional room's centroid,
 * converted to grid units (100 mm each).  Full BFS can replace this once
 * door positions are finalised.
 *
 * Formula (from spec §3.3):
 *   accessibilityScore = clamp((150 − avgGrids) / 100, 0, 1) × 30
 *
 * @returns {number} integer 0~30
 */
export function computeAccessibilityScore(result) {
  const { buildingW, buildingD, groundPlacements } = result

  // Nominal main entrance: south-wall midpoint (y = buildingD, x = buildingW/2)
  const entranceX = buildingW / 2
  const entranceY = buildingD

  const distances = []
  for (const roomId of ACCESSIBILITY_ROOMS) {
    const p = (groundPlacements || {})[roomId]
    if (!p) continue
    const dx = centerX(p) - entranceX
    const dy = centerY(p) - entranceY
    const distMm = Math.hypot(dx, dy)
    distances.push(distMm / 100) // convert mm → grid units
  }

  if (distances.length === 0) return 0

  const avgGrids = distances.reduce((s, d) => s + d, 0) / distances.length
  return Math.round(Math.max(0, Math.min(1, (150 - avgGrids) / 100)) * 30)
}

/**
 * Score a layout result (higher = better).
 * Returns { score, spaceEfficiency, efficiencyScore, accessibilityScore, diversityPenalty, breakdown }.
 */
export function scoreLayout(result) {
  const { buildingW, buildingD, groundPlacements, level1Placements } = result
  const allPlacements = { ...groundPlacements, ...level1Placements };
  const breakdown = {
    base: 10000,
    footprint: 0,
    adjacency: 0,
    corridor: 0,
    trafo: 0,
    fanRoom: 0,
    efficiency: 0,
    accessibility: 0,
    violations: 0,
  }
  let score = breakdown.base

  // 1. Footprint penalty (per m²)
  const areaMm2 = buildingW * buildingD
  breakdown.footprint = -Math.round((areaMm2 / 1e6) * 8)
  score += breakdown.footprint

  // 2. Trafo touching east or west exterior wall → +20 each
  const bW = buildingW
  ;['trafo1', 'trafo2'].forEach(id => {
    const p = allPlacements[id]
    if (!p) return
    if (p.x <= 100 || p.x + p.w >= bW - 100) {
      breakdown.trafo += 20
      score += 20
    }
  })

  // 3. Both trafos on same exterior wall side → +20
  //    Checks that both touch the same wall (west or east), not just proximity.
  if (allPlacements.trafo1 && allPlacements.trafo2) {
    const t1 = allPlacements.trafo1
    const t2 = allPlacements.trafo2
    const t1West = t1.x <= 100
    const t1East = t1.x + t1.w >= bW - 100
    const t2West = t2.x <= 100
    const t2East = t2.x + t2.w >= bW - 100
    if ((t1West && t2West) || (t1East && t2East)) {
      breakdown.trafo += 20
      score += 20
    }
  }

  // 4. Fan room near dock2 → up to +30
  if (allPlacements.fan_room && allPlacements.dock2) {
    const dist = Math.hypot(
      centerX(allPlacements.fan_room) - centerX(allPlacements.dock2),
      centerY(allPlacements.fan_room) - centerY(allPlacements.dock2)
    )
    const bonus = Math.round(Math.max(0, 30 - dist / 500))
    breakdown.fanRoom = bonus
    score += bonus
  }

  // 5. Adjacency satisfaction bonus
  const adj = result.adjacency
  if (adj) {
    adj.satisfied.forEach(v => {
      const pts = v.type === 'must' ? 40 : 15
      breakdown.adjacency += pts
      score += pts
    })
    const corridorHits = adj.satisfied.filter(v => v.pair.includes('corridor_l1')).length
    if (corridorHits >= 2) {
      breakdown.corridor = 20
      score += 20
    }
  }

  // 6. Space efficiency bonus (0~+50)
  const spaceEfficiency = computeSpaceEfficiency(result)
  const efficiencyScore = Math.round(Math.max(0, Math.min(1, (spaceEfficiency - 0.60) / 0.30)) * 50)
  breakdown.efficiency = efficiencyScore
  score += efficiencyScore

  // 7. Accessibility bonus (0~+30)
  //    Proxy: average Euclidean distance from nominal entrance to ground-floor room centroids.
  //    TODO: replace with full BFS path once door positions are stable.
  const accessibilityScore = computeAccessibilityScore(result)
  breakdown.accessibility = accessibilityScore
  score += accessibilityScore

  // 8. Constraint violation penalty
  breakdown.violations = -(result.violations.length * 50)
  score += breakdown.violations

  return {
    score: Math.round(score),
    spaceEfficiency,
    efficiencyScore,
    accessibilityScore,
    diversityPenalty: 0, // placeholder — similarity-based penalty is not yet implemented
    breakdown,
  }
}
