import { adjacent, centerX, centerY, touchesExteriorNonSouth } from './placer.js'
import { SCORER_PARAMS } from './scorer-params.js'

// Rooms excluded from space efficiency numerator (non-functional spaces)
const NON_FUNCTIONAL = new Set(['corridor_l1', 'dock1', 'dock2'])

// Ground-floor rooms considered for convenience scoring (§3.3)
const CONVENIENCE_ROOMS = ['trafo1', 'trafo2', 'meter_main', 'meter_sub', 'fire_equip', 'parking', 'repair_zone']

// Required rooms per floor (§3.5 missing-room check)
const EXPECTED_GROUND = ['trafo1', 'trafo2', 'meter_main', 'meter_sub', 'fire_equip', 'parking', 'repair_zone', 'dock1']
const EXPECTED_LEVEL1 = ['fan_room', 'clean_pump', 'rainwater', 'lv_control', 'dock2', 'corridor_l1']

// Level-1 rooms that must be adjacent to corridor_l1 (§3.4 door-access check)
const LEVEL1_MUST_FACE_CORRIDOR = ['fan_room', 'clean_pump', 'rainwater', 'lv_control']

// Ground-floor rooms that must touch exterior wall (non-south) — §3.4
const GROUND_MUST_EXT = ['trafo1', 'trafo2', 'meter_main', 'meter_sub', 'fire_equip']

function floorFunctionalArea(placements) {
  const seen = new Set()
  return Object.values(placements || {})
    .filter(p => !NON_FUNCTIONAL.has(p.id))
    .filter(p => {
      const key = `${p.x},${p.y},${p.w},${p.d}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .reduce((sum, p) => sum + p.w * p.d, 0)
}

/**
 * Compute space efficiency: average of per-floor (functional area / floor area).
 * @returns {number} 0~1
 */
export function computeSpaceEfficiency(result) {
  const { buildingW, buildingD, groundPlacements, level1Placements } = result
  const floorArea = buildingW * buildingD
  const groundEff = floorFunctionalArea(groundPlacements) / floorArea
  const level1Eff = floorFunctionalArea(level1Placements) / floorArea
  return (groundEff + level1Eff) / 2
}

/**
 * Compute convenience score (0~convenienceMaxBonus) — §3.3.
 * Field name `accessibilityScore` is historical; this is the "convenience" score.
 */
export function computeAccessibilityScore(result) {
  const { buildingW, buildingD, groundPlacements } = result
  const { convenienceIdealGrids, convenienceRange, convenienceMaxBonus } = SCORER_PARAMS

  const entranceX = buildingW / 2
  const entranceY = buildingD

  const distances = []
  for (const roomId of CONVENIENCE_ROOMS) {
    const p = (groundPlacements || {})[roomId]
    if (!p) continue
    const dx = centerX(p) - entranceX
    const dy = centerY(p) - entranceY
    distances.push(Math.hypot(dx, dy) / 100) // mm → grid units
  }

  if (distances.length === 0) return 0
  const avgGrids = distances.reduce((s, d) => s + d, 0) / distances.length
  return Math.round(Math.max(0, Math.min(1, (convenienceIdealGrids - avgGrids) / convenienceRange)) * convenienceMaxBonus)
}

/**
 * Compute door-access penalty (≤0) — §3.4.
 * @returns {number} −doorAccessPenalty × violatingRoomCount
 */
export function computeDoorAccessPenalty(result) {
  const { buildingW, buildingD, groundPlacements = {}, level1Placements = {} } = result
  const { doorAccessPenalty } = SCORER_PARAMS
  let violations = 0

  for (const id of GROUND_MUST_EXT) {
    const p = groundPlacements[id]
    if (!p) continue
    if (!touchesExteriorNonSouth(p, buildingW, buildingD)) violations++
  }

  const parking    = groundPlacements['parking']
  const repairZone = groundPlacements['repair_zone']
  if (parking && repairZone) {
    const parkingOk = adjacent(parking, repairZone) || touchesExteriorNonSouth(parking, buildingW, buildingD)
    const repairOk  = adjacent(parking, repairZone) || touchesExteriorNonSouth(repairZone, buildingW, buildingD)
    if (!parkingOk) violations++
    if (!repairOk)  violations++
  }

  const corridor = level1Placements['corridor_l1']
  for (const id of LEVEL1_MUST_FACE_CORRIDOR) {
    const p = level1Placements[id]
    if (!p) continue
    if (!corridor || !adjacent(p, corridor)) violations++
  }

  return -doorAccessPenalty * violations
}

/**
 * Compute missing-room penalty (≤0) — §3.5.
 * @returns {number} −missingRoomPenalty × missingCount
 */
export function computeMissingRoomsPenalty(result) {
  const { groundPlacements = {}, level1Placements = {} } = result
  const { missingRoomPenalty } = SCORER_PARAMS
  let missing = 0
  for (const id of EXPECTED_GROUND) { if (!groundPlacements[id]) missing++ }
  for (const id of EXPECTED_LEVEL1) { if (!level1Placements[id]) missing++ }
  return -missingRoomPenalty * missing
}

/**
 * Compute aspect-ratio penalty (≤0) — §3.6.
 * @returns {number} −aspectRatioPenalty × violatingRoomCount
 */
export function computeAspectRatioPenalty(result) {
  const { groundPlacements = {}, level1Placements = {} } = result
  const { aspectRatioThreshold, aspectRatioPenalty } = SCORER_PARAMS
  const allPlacements = { ...groundPlacements, ...level1Placements }
  let violations = 0

  for (const [id, p] of Object.entries(allPlacements)) {
    if (id === 'corridor_l1') continue
    if (!p.w || !p.d) continue
    if (Math.max(p.w, p.d) / Math.min(p.w, p.d) > aspectRatioThreshold) violations++
  }

  return -aspectRatioPenalty * violations
}

/**
 * Score a layout result (higher = better).
 *
 * All numeric constants are read from SCORER_PARAMS at call time, so UI
 * mutations to that object take effect immediately on the next call.
 *
 * Returns { score, spaceEfficiency, efficiencyScore, accessibilityScore,
 *           diversityPenalty, breakdown }.
 */
export function scoreLayout(result) {
  const { buildingW, buildingD, groundPlacements, level1Placements } = result
  const allPlacements = { ...groundPlacements, ...level1Placements }
  const {
    footprintPenaltyPerM2,
    trafoExteriorBonus, trafoSameSideBonus,
    fanRoomMaxBonus, fanRoomDistDivisor,
    mustAdjacencyBonus, shouldAdjacencyBonus,
    corridorHitsThreshold, corridorBonus,
    efficiencyBase, efficiencyRange, efficiencyMaxBonus,
    mustViolationPenalty,
  } = SCORER_PARAMS

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
    doorAccess: 0,
    missingRooms: 0,
    aspectRatio: 0,
  }
  let score = breakdown.base

  // 1. Footprint penalty
  const areaMm2 = buildingW * buildingD
  breakdown.footprint = -Math.round((areaMm2 / 1e6) * footprintPenaltyPerM2)
  score += breakdown.footprint

  // 2. Trafo exterior wall bonus
  const bW = buildingW
  ;['trafo1', 'trafo2'].forEach(id => {
    const p = allPlacements[id]
    if (!p) return
    if (p.x <= 100 || p.x + p.w >= bW - 100) {
      breakdown.trafo += trafoExteriorBonus
      score += trafoExteriorBonus
    }
  })

  // 3. Both trafos same side bonus
  if (allPlacements.trafo1 && allPlacements.trafo2) {
    const t1 = allPlacements.trafo1, t2 = allPlacements.trafo2
    const t1West = t1.x <= 100,       t1East = t1.x + t1.w >= bW - 100
    const t2West = t2.x <= 100,       t2East = t2.x + t2.w >= bW - 100
    if ((t1West && t2West) || (t1East && t2East)) {
      breakdown.trafo += trafoSameSideBonus
      score += trafoSameSideBonus
    }
  }

  // 4. Fan room near dock2
  if (allPlacements.fan_room && allPlacements.dock2) {
    const dist = Math.hypot(
      centerX(allPlacements.fan_room) - centerX(allPlacements.dock2),
      centerY(allPlacements.fan_room) - centerY(allPlacements.dock2)
    )
    const bonus = Math.round(Math.max(0, fanRoomMaxBonus - dist / fanRoomDistDivisor))
    breakdown.fanRoom = bonus
    score += bonus
  }

  // 5. Adjacency satisfaction
  const adj = result.adjacency
  if (adj) {
    adj.satisfied.forEach(v => {
      const pts = v.type === 'must' ? mustAdjacencyBonus : shouldAdjacencyBonus
      breakdown.adjacency += pts
      score += pts
    })
    const corridorHits = adj.satisfied.filter(v => v.pair.includes('corridor_l1')).length
    if (corridorHits >= corridorHitsThreshold) {
      breakdown.corridor = corridorBonus
      score += corridorBonus
    }
  }

  // 6. Space efficiency bonus
  const spaceEfficiency = computeSpaceEfficiency(result)
  const efficiencyScore = Math.round(
    Math.max(0, Math.min(1, (spaceEfficiency - efficiencyBase) / efficiencyRange)) * efficiencyMaxBonus
  )
  breakdown.efficiency = efficiencyScore
  score += efficiencyScore

  // 7. Convenience bonus
  const accessibilityScore = computeAccessibilityScore(result)
  breakdown.accessibility = accessibilityScore
  score += accessibilityScore

  // 8. MUST violation penalty
  breakdown.violations = -(result.violations.length * mustViolationPenalty)
  score += breakdown.violations

  // 9. Door-access penalty
  breakdown.doorAccess = computeDoorAccessPenalty(result)
  score += breakdown.doorAccess

  // 10. Missing-room penalty
  breakdown.missingRooms = computeMissingRoomsPenalty(result)
  score += breakdown.missingRooms

  // 11. Aspect-ratio penalty
  breakdown.aspectRatio = computeAspectRatioPenalty(result)
  score += breakdown.aspectRatio

  return {
    score: Math.round(score),
    spaceEfficiency,
    efficiencyScore,
    accessibilityScore,
    diversityPenalty: 0,
    breakdown,
  }
}
