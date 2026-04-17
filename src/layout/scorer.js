import { adjacent, centerX, centerY, touchesExteriorNonSouth } from './placer.js'
import { SCORER_PARAMS } from './scorer-params.js'

// ── Room ID constants ────────────────────────────────────────────────────────

// Rooms excluded from space efficiency numerator (non-functional spaces)
const NON_FUNCTIONAL = new Set(['corridor_l1', 'dock1', 'dock2'])

// Ground-floor rooms: single source for expected rooms & convenience scoring.
// CONVENIENCE_ROOMS and EXPECTED_GROUND were previously duplicated identically.
export const GROUND_ROOMS = ['trafo1', 'trafo2', 'meter_main', 'meter_sub', 'fire_equip', 'parking', 'repair_zone']

export const EXPECTED_LEVEL1 = ['fan_room', 'clean_pump', 'rainwater', 'lv_control', 'corridor_l1']

// Level-1 rooms that must be adjacent to corridor_l1 (§3.4 door-access check)
export const LEVEL1_MUST_FACE_CORRIDOR = ['fan_room', 'clean_pump', 'rainwater', 'lv_control']

// Ground-floor rooms that must touch exterior wall (non-south) — §3.4
export const GROUND_MUST_EXT = ['trafo1', 'trafo2', 'meter_main', 'meter_sub', 'fire_equip']

// ── Utility functions ────────────────────────────────────────────────────────

/**
 * Linear-interpolate a value into [0, maxBonus], clamp to range.
 * value ∈ [base, base+range] → bonus ∈ [0, maxBonus]
 */
function linearScore(value, base, range, maxBonus) {
  return Math.round(Math.max(0, Math.min(1, (value - base) / range)) * maxBonus)
}

/** Normalised aspect ratio: always ≥ 1. Consistent with layout-generator.js. */
function aspectRatio(w, d) {
  return Math.max(w / d, d / w)
}

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
  for (const roomId of GROUND_ROOMS) {
    const p = (groundPlacements || {})[roomId]
    if (!p) continue
    const dx = centerX(p) - entranceX
    const dy = centerY(p) - entranceY
    distances.push(Math.hypot(dx, dy) / 100) // mm → grid units
  }

  if (distances.length === 0) return 0
  const avgGrids = distances.reduce((s, d) => s + d, 0) / distances.length
  return linearScore(convenienceIdealGrids - avgGrids, 0, convenienceRange, convenienceMaxBonus)
}

/**
 * Compute door-access penalty (≤0) — §3.4.
 * @returns {{penalty: number, ids: string[]}}
 */
export function computeDoorAccessPenalty(result) {
  const { buildingW, buildingD, groundPlacements = {}, level1Placements = {} } = result
  const { doorAccessPenalty } = SCORER_PARAMS
  let ids = []

  for (const id of GROUND_MUST_EXT) {
    const p = groundPlacements[id]
    if (!p) continue
    if (!touchesExteriorNonSouth(p, buildingW, buildingD)) ids.push(id)
  }

  const parking    = groundPlacements['parking']
  const repairZone = groundPlacements['repair_zone']
  if (parking && repairZone) {
    const parkingOk = adjacent(parking, repairZone) || touchesExteriorNonSouth(parking, buildingW, buildingD)
    const repairOk  = adjacent(parking, repairZone) || touchesExteriorNonSouth(repairZone, buildingW, buildingD)
    if (!parkingOk) ids.push('parking')
    if (!repairOk)  ids.push('repair_zone')
  }

  const corridor = level1Placements['corridor_l1']
  for (const id of LEVEL1_MUST_FACE_CORRIDOR) {
    const p = level1Placements[id]
    if (!p) continue
    if (!corridor || !adjacent(p, corridor)) ids.push(id)
  }

  return { penalty: -doorAccessPenalty * ids.length, ids }
}

/**
 * Compute missing-room penalty (≤0) — §3.5.
 * @returns {{penalty: number, ids: string[]}}
 */
export function computeMissingRoomsPenalty(result) {
  const { groundPlacements = {}, level1Placements = {} } = result
  const { missingRoomPenalty } = SCORER_PARAMS
  let ids = []
  for (const id of GROUND_ROOMS) { if (!groundPlacements[id]) ids.push(id) }
  for (const id of EXPECTED_LEVEL1) { if (!level1Placements[id]) ids.push(id) }
  return { penalty: -missingRoomPenalty * ids.length, ids }
}

/**
 * Compute aspect-ratio and shape penalty (≤0) — §3.6.
 * Includes:
 * 1. Traditional aspect ratio (max/min > threshold)
 * 2. Room utilization (actualArea / boundingBoxArea < threshold)
 * 3. Corner count (vertices > threshold)
 * @returns {{penalty: number, ids: string[], violationCount: number, maxAspectRatio: number}}
 */
export function computeAspectRatioPenalty(result) {
  const { groundPlacements = {}, level1Placements = {} } = result
  const {
    aspectRatioThreshold, aspectRatioPenalty,
    utilizationThreshold, utilizationStep,
    vertexThreshold, vertexStep
  } = SCORER_PARAMS
  const allPlacements = { ...groundPlacements, ...level1Placements }
  let ids = []
  let totalViolations = 0
  let maxAspectRatio = 1

  for (const [id, p] of Object.entries(allPlacements)) {
    if (id === 'corridor_l1') continue
    if (!p.w || !p.d) continue
    
    const ratio = aspectRatio(p.w, p.d)
    if (ratio > maxAspectRatio) maxAspectRatio = ratio

    let roomViolations = 0
    
    // 1. Aspect Ratio
    if (ratio > aspectRatioThreshold) {
      roomViolations++
    }
    
    // 2. Room Utilization
    if (p.actualArea) {
      const bboxArea = p.w * p.d
      const utilization = p.actualArea / bboxArea
      if (utilization < utilizationThreshold) {
        // Every utilizationStep deficit = 1 violation, at least 1 if below threshold
        const deficit = utilizationThreshold - utilization
        roomViolations += 1 + Math.floor(deficit / utilizationStep)
      }
    }
    
    // 3. Corner Count
    if (p.vertices > vertexThreshold) {
      // Every vertexStep extra vertices over threshold = 1 violation
      roomViolations += (p.vertices - vertexThreshold) / vertexStep
    }

    if (roomViolations > 0) {
      ids.push(id)
      totalViolations += roomViolations
    }
  }

  return {
    penalty: -aspectRatioPenalty * totalViolations,
    ids,
    violationCount: totalViolations,
    maxAspectRatio
  }
}

/**
 * Checkpoint A — Tier 1 (Hard Redlines) partial score.
 * Evaluates only the three hard-redline metrics used to gate Phase 1 → Phase 2 progression.
 * Input must have already been processed by evaluateTemplate() so that result.violations is populated.
 *
 * @returns {{ partialScore: number, passes: boolean, missingRooms: number, doorAccess: number, violations: number, missingRoomCount: number, doorAccessCount: number, violationCount: number }}
 */
export function scoreHardRedlines(result, doorAccessOverride = null) {
  const { mustViolationPenalty } = SCORER_PARAMS
  const missingRoomsRes = computeMissingRoomsPenalty(result)
  const doorAccessRes   = doorAccessOverride ?? computeDoorAccessPenalty(result)
  const violationCount  = result.violations?.length || 0
  const violationsPenalty = -(violationCount * mustViolationPenalty)
  const partialScore = missingRoomsRes.penalty + doorAccessRes.penalty + violationsPenalty
  return {
    partialScore,
    passes: partialScore === 0,
    missingRooms: missingRoomsRes.penalty,
    missingRoomCount: missingRoomsRes.ids.length,
    doorAccess: doorAccessRes.penalty,
    doorAccessCount: doorAccessRes.ids.length,
    violations: violationsPenalty,
    violationCount,
  }
}

/**
 * Checkpoint A (enhanced) — Tier 1 plus UI-critical metrics.
 * Evaluates hard redlines, plus space efficiency and must-adjacency counts
 * needed for the comparison table. This ensures the UI always shows
 * metrics computed at the same (Phase 1) snapshot.
 */
export function evaluateCheckpointA(result, doorAccessOverride = null) {
  const redlines = scoreHardRedlines(result, doorAccessOverride)
  const spaceEfficiency = computeSpaceEfficiency(result)
  const mustSatisfied = result.adjacency?.satisfied?.filter(v => v.type === 'must').length || 0
  const mustTotal = mustSatisfied + (result.adjacency?.violated?.filter(v => v.type === 'must').length || 0)

  return {
    ...redlines,
    spaceEfficiency,
    mustAdjacency: {
      satisfied: mustSatisfied,
      total: mustTotal,
    },
  }
}

/**
 * Checkpoint B — Tier 1 + Tier 2 (Hard Redlines + Spatial Quality) partial score.
 * Used to rank the 9 schemes after Phase 2 (L/U expansion) completes.
 * Input must have already been processed by evaluateTemplate().
 *
 * @returns {{ partialScore: number, passes: boolean, aspectRatio: number, efficiency: number, spaceEfficiency: number, corridor: number, ...tier1 fields }}
 */
export function scoreSpatialQuality(result) {
  const { corridorHitsThreshold, corridorBonus, efficiencyBase, efficiencyRange, efficiencyMaxBonus } = SCORER_PARAMS
  const tier1 = scoreHardRedlines(result)
  const aspectRatioRes = computeAspectRatioPenalty(result)
  const spaceEfficiency = computeSpaceEfficiency(result)
  const efficiencyScore = linearScore(spaceEfficiency, efficiencyBase, efficiencyRange, efficiencyMaxBonus)
  const corridorHits = result.adjacency?.satisfied?.filter(v => v.pair.includes('corridor_l1')).length || 0
  const corridorScore = corridorHits === 0 ? 0
    : Math.min(corridorBonus, Math.round((corridorHits / corridorHitsThreshold) * corridorBonus))
  const partialScore = tier1.partialScore + aspectRatioRes.penalty + efficiencyScore + corridorScore
  return {
    partialScore,
    ...tier1,
    aspectRatio: aspectRatioRes.penalty,
    aspectRatioCount: aspectRatioRes.violationCount,
    efficiency: efficiencyScore,
    spaceEfficiency,
    corridor: corridorScore,
  }
}

/**
 * Score a layout result (higher = better).
 *
 * All numeric constants are read from SCORER_PARAMS at call time, so UI
 * mutations to that object take effect immediately on the next call.
 *
 * Returns { score, spaceEfficiency, efficiencyScore, accessibilityScore,
 *           aspectRatio, diversityPenalty, breakdown }.
 */
export function scoreLayout(result) {
  const { buildingW, buildingD, groundPlacements, level1Placements } = result
  const allPlacements = { ...groundPlacements, ...level1Placements }
  const {
    growthSuccessMaxBonus,
    trafoExteriorBonus, trafoSameSideBonus,
    fanRoomMaxBonus, fanRoomDistDivisor,
    mustAdjacencyBonus, shouldAdjacencyBonus,
    corridorHitsThreshold, corridorBonus,
    efficiencyBase, efficiencyRange, efficiencyMaxBonus,
    mustViolationPenalty,
    doorAccessPenalty,
    missingRoomPenalty,
    aspectRatioPenalty,
  } = SCORER_PARAMS

  const breakdown = {
    base: 10000,
    growthSuccess: 0,
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
    diversityPenalty: 0, // filled in by applyDiversityPenalty (ag42) after ranking
  }
  let score = breakdown.base

  // 1. Growth Success Bonus
  let totalActualArea = 0;
  for (const p of Object.values(allPlacements)) {
    if (p.actualArea) {
      totalActualArea += p.actualArea;
    } else {
      totalActualArea += p.w * p.d;
    }
  }

  let totalTargetArea = 0;
  if (result._debug && result._debug.roomTargets) {
    totalTargetArea = result._debug.roomTargets.reduce((sum, room) => {
      // room.targetGridCount is in grid cells, convert to mm^2
      return sum + (room.targetGridCount * 500 * 500);
    }, 0);
  }

  if (totalTargetArea > 0) {
    const growthRatio = Math.min(1, totalActualArea / totalTargetArea);
    breakdown.growthSuccess = Math.round(growthRatio * growthSuccessMaxBonus);
  } else {
    breakdown.growthSuccess = 0;
  }
  score += breakdown.growthSuccess;

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
    const mustHits = adj.satisfied.filter(v => v.type === 'must').length
    const shouldHits = adj.satisfied.filter(v => v.type === 'should').length
    breakdown.adjMustCount = mustHits
    breakdown.adjShouldCount = shouldHits

    adj.satisfied.forEach(v => {
      const pts = v.type === 'must' ? mustAdjacencyBonus : shouldAdjacencyBonus
      breakdown.adjacency += pts
      score += pts
    })
    // Linear corridor score: proportional to how many rooms corridor touches.
    // corridorHitsThreshold is the "full bonus" baseline — more hits still cap at corridorBonus.
    const corridorHits = adj.satisfied.filter(v => v.pair.includes('corridor_l1')).length
    const corridorScore = corridorHits === 0 ? 0
      : Math.min(corridorBonus, Math.round((corridorHits / corridorHitsThreshold) * corridorBonus))
    breakdown.corridor = corridorScore
    score += corridorScore
  }

  // 6. Space efficiency bonus
  const spaceEfficiency = computeSpaceEfficiency(result)
  const efficiencyScore = linearScore(spaceEfficiency, efficiencyBase, efficiencyRange, efficiencyMaxBonus)
  breakdown.efficiency = efficiencyScore
  score += efficiencyScore

  // 7. Convenience bonus
  const accessibilityScore = computeAccessibilityScore(result)
  breakdown.accessibility = accessibilityScore
  score += accessibilityScore

  // 8. MUST violation penalty
  const violationCount = result.violations?.length || 0
  breakdown.violations = -(violationCount * mustViolationPenalty)
  breakdown.violationCount = violationCount
  // Safety check: handle violations that might not have a 'pair' or use 'room' property instead
  breakdown.violationDetails = result.violations?.map(v => v.room || 'unknown') || []
  score += breakdown.violations

  // 9. Door-access penalty
  const doorAccessRes = computeDoorAccessPenalty(result)
  breakdown.doorAccess = doorAccessRes.penalty
  breakdown.doorAccessCount = doorAccessRes.ids.length
  breakdown.doorAccessDetails = doorAccessRes.ids
  score += breakdown.doorAccess

  // 10. Missing-room penalty
  const missingRoomsRes = computeMissingRoomsPenalty(result)
  breakdown.missingRooms = missingRoomsRes.penalty
  breakdown.missingRoomCount = missingRoomsRes.ids.length
  breakdown.missingRoomDetails = missingRoomsRes.ids
  score += breakdown.missingRooms

  // 11. Aspect-ratio penalty
  const aspectRatioRes = computeAspectRatioPenalty(result)
  breakdown.aspectRatio = aspectRatioRes.penalty
  breakdown.aspectRatioCount = aspectRatioRes.violationCount
  breakdown.aspectRatioDetails = aspectRatioRes.ids
  score += breakdown.aspectRatio

  return {
    score: Math.round(score),
    spaceEfficiency,
    efficiencyScore,
    accessibilityScore,
    aspectRatio: aspectRatioRes.maxAspectRatio,
    diversityPenalty: 0, // Applied externally by mergeVariants after ranking
    breakdown,
  }
}
