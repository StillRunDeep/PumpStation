import { adjacent, centerX, centerY, touchesExteriorNonSouth } from './placer.js'

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
 * Compute convenience score (0~30) — §3.3.
 *
 * Proxy: Euclidean distance from the nominal main entrance
 * (south-wall midpoint of ground floor) to each functional room's centroid,
 * converted to grid units (100 mm each).
 *
 * Formula: clamp((150 − avgGrids) / 100, 0, 1) × 30
 * Field name `accessibilityScore` is a historical alias; conceptually this is
 * the "convenience" score, not the door-access penalty (see §3.4).
 *
 * @returns {number} integer 0~30
 */
export function computeAccessibilityScore(result) {
  const { buildingW, buildingD, groundPlacements } = result

  // Nominal main entrance: south-wall midpoint (y = buildingD, x = buildingW/2)
  const entranceX = buildingW / 2
  const entranceY = buildingD

  const distances = []
  for (const roomId of CONVENIENCE_ROOMS) {
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
 * Compute door-access penalty (≤0) — §3.4.
 *
 * Rules:
 *   - Ground floor rooms in GROUND_MUST_EXT: must touch a non-south exterior wall.
 *   - parking ↔ repair_zone: must be mutually adjacent (treated as connected).
 *   - Level-1 rooms in LEVEL1_MUST_FACE_CORRIDOR: must be adjacent to corridor_l1.
 *
 * @returns {number} −100 × violatingRoomCount
 */
export function computeDoorAccessPenalty(result) {
  const { buildingW, buildingD, groundPlacements = {}, level1Placements = {} } = result
  let violations = 0

  // Ground-floor rooms that must touch exterior wall
  for (const id of GROUND_MUST_EXT) {
    const p = groundPlacements[id]
    if (!p) continue  // missing rooms are penalised separately in §3.5
    if (!touchesExteriorNonSouth(p, buildingW, buildingD)) violations++
  }

  // parking ↔ repair_zone connectivity (either one adjacent to the other, or both touch ext wall)
  const parking     = groundPlacements['parking']
  const repairZone  = groundPlacements['repair_zone']
  if (parking && repairZone) {
    const parkingOk = adjacent(parking, repairZone) || touchesExteriorNonSouth(parking, buildingW, buildingD)
    const repairOk  = adjacent(parking, repairZone) || touchesExteriorNonSouth(repairZone, buildingW, buildingD)
    if (!parkingOk)  violations++
    if (!repairOk)   violations++
  }

  // Level-1 rooms must be adjacent to corridor_l1
  const corridor = level1Placements['corridor_l1']
  for (const id of LEVEL1_MUST_FACE_CORRIDOR) {
    const p = level1Placements[id]
    if (!p) continue  // missing rooms are penalised separately in §3.5
    if (!corridor || !adjacent(p, corridor)) violations++
  }

  return -100 * violations
}

/**
 * Compute missing-room penalty (≤0) — §3.5.
 *
 * Each room absent from its expected floor is penalised −200.
 *
 * @returns {number} −200 × missingCount
 */
export function computeMissingRoomsPenalty(result) {
  const { groundPlacements = {}, level1Placements = {} } = result
  let missing = 0

  for (const id of EXPECTED_GROUND) {
    if (!groundPlacements[id]) missing++
  }
  for (const id of EXPECTED_LEVEL1) {
    if (!level1Placements[id]) missing++
  }

  return -200 * missing
}

/**
 * Compute aspect-ratio penalty (≤0) — §3.6.
 *
 * For every placed room (excluding corridor_l1), if max(w,d)/min(w,d) > 4 the
 * room is non-compliant.  Each non-compliant room is penalised −200.
 *
 * @returns {number} −200 × violatingRoomCount
 */
export function computeAspectRatioPenalty(result) {
  const { groundPlacements = {}, level1Placements = {} } = result
  const allPlacements = { ...groundPlacements, ...level1Placements }
  let violations = 0

  for (const [id, p] of Object.entries(allPlacements)) {
    if (id === 'corridor_l1') continue  // corridor is exempt
    if (!p.w || !p.d) continue         // skip rooms with no valid dimensions
    const ratio = Math.max(p.w, p.d) / Math.min(p.w, p.d)
    if (ratio > 4) violations++
  }

  return -200 * violations
}

/**
 * Score a layout result (higher = better).
 * Returns { score, spaceEfficiency, efficiencyScore, accessibilityScore,
 *           diversityPenalty, breakdown }.
 *
 * breakdown field names:
 *   accessibility  → convenience bonus (§3.3); historical name kept for compatibility
 *   doorAccess     → door-access penalty (§3.4)
 *   missingRooms   → missing-room penalty (§3.5)
 *   aspectRatio    → aspect-ratio penalty (§3.6)
 */
export function scoreLayout(result) {
  const { buildingW, buildingD, groundPlacements, level1Placements } = result
  const allPlacements = { ...groundPlacements, ...level1Placements }
  const breakdown = {
    base: 10000,
    footprint: 0,
    adjacency: 0,
    corridor: 0,
    trafo: 0,
    fanRoom: 0,
    efficiency: 0,
    accessibility: 0,   // convenience bonus — see §3.3 (field name is historical)
    violations: 0,      // MUST adjacency violations — §3.1
    doorAccess: 0,      // door-access penalty — §3.4
    missingRooms: 0,    // missing-room penalty — §3.5
    aspectRatio: 0,     // aspect-ratio penalty — §3.6
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

  // 7. Convenience bonus (0~+30) — named accessibilityScore for historical reasons
  const accessibilityScore = computeAccessibilityScore(result)
  breakdown.accessibility = accessibilityScore
  score += accessibilityScore

  // 8. MUST constraint violation penalty (−50/item)
  breakdown.violations = -(result.violations.length * 50)
  score += breakdown.violations

  // 9. Door-access penalty (−100/room) — §3.4
  breakdown.doorAccess = computeDoorAccessPenalty(result)
  score += breakdown.doorAccess

  // 10. Missing-room penalty (−200/room) — §3.5
  breakdown.missingRooms = computeMissingRoomsPenalty(result)
  score += breakdown.missingRooms

  // 11. Aspect-ratio penalty (−200/room) — §3.6
  breakdown.aspectRatio = computeAspectRatioPenalty(result)
  score += breakdown.aspectRatio

  return {
    score: Math.round(score),
    spaceEfficiency,
    efficiencyScore,
    accessibilityScore,
    diversityPenalty: 0, // placeholder — §3.7 not yet implemented
    breakdown,
  }
}
