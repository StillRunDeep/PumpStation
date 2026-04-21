import { ROOM_DEFS } from '../model/room-defs.js'
import { GRID_SIZE } from './layout-generator.js';
import { checkAdjacency } from '../topology/adjacency.js'
import { placeDoors } from '../topology/door-placer.js'

// ── Geometry helpers ──────────────────────────────────────────────

export function centerX(p) { return p.x + p.w / 2 }
export function centerY(p) { return p.y + p.d / 2 }

export function contains(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.d <= outer.y + outer.d
  )
}

export function adjacent(a, b, tol = 200) {
  // Containment counts as adjacency (e.g., a floor hatch inside a room)
  if (contains(a, b) || contains(b, a)) return true
  // Rooms share an edge within tolerance (mm)
  const xOverlap = a.x < b.x + b.w && a.x + a.w > b.x
  const yOverlap = a.y < b.y + b.d && a.y + a.d > b.y
  const touchH   = Math.abs(a.x + a.w - b.x) <= tol || Math.abs(b.x + b.w - a.x) <= tol
  const touchV   = Math.abs(a.y + a.d - b.y) <= tol || Math.abs(b.y + b.d - a.y) <= tol
  return (touchH && yOverlap) || (touchV && xOverlap)
}

export function touchesExteriorNonSouth(p, buildingW, buildingD, tol = 10) {
  return (
    p.x <= tol ||                        // west wall
    p.y <= tol ||                        // north wall
    p.x + p.w >= buildingW - tol         // east wall
    // south wall excluded (no doors on south)
  )
}

// ── Constraint checkers ───────────────────────────────────────────

export const CONSTRAINT_CHECKS = {
  ext_access: (id, placements, template) => {
    const p = placements[id]
    if (!p) return false
    return touchesExteriorNonSouth(p, template.buildingW, template.buildingD)
  },

  crane15_cover: (id, placements, template) => {
    const p = placements[id]
    if (!p || !template.crane15) return true // If crane zone isn't defined, constraint is trivially satisfied
    return contains(template.crane15, p)
  },

  crane5_cover: (id, placements, template) => {
    const p = placements[id]
    if (!p || !template.crane5) return true // If crane zone isn't defined, constraint is trivially satisfied
    return contains(template.crane5, p)
  },

  near_dock2: (id, placements) => {
    const fan  = placements[id]
    const dock = placements['dock2']
    if (!fan || !dock) return true  // skip if dock2 not yet placed
    const dist = Math.hypot(centerX(fan) - centerX(dock), centerY(fan) - centerY(dock))
    return dist <= 10000  // 10 m tolerance
  },
}

// ── Main placement validator ──────────────────────────────────────

/**
 * Evaluate a template: check all constraints for all placed rooms.
 * Returns { feasible, placements, violations }.
 */
export function evaluateTemplate(template, options = {}) {
  const { skipDoors = false } = options;
  const allPlacements = { ...template.groundPlacements, ...template.level1Placements }
  const violations = []

  for (const [id, placement] of Object.entries(allPlacements)) {
    const def = ROOM_DEFS[id]
    if (!def) continue

    for (const key of def.constraints) {
      const checkFn = CONSTRAINT_CHECKS[key]
      if (!checkFn) continue
      const ok = checkFn(id, allPlacements, template)
      if (!ok) violations.push({ room: id, constraint: key })
    }
  }

  // Adjacency constraint check
  const adjacency = checkAdjacency(allPlacements)
  for (const v of adjacency.violated) {
    if (v.type === 'must') {
      violations.push({ room: v.pair.join('↔'), constraint: 'must_adjacent' })
    }
  }

  // Place doors (skipped if requested for performance, e.g. at Checkpoint A)
  const doors = skipDoors ? [] : placeDoors(allPlacements);

  const result = {
    ...template, // Spread the original template properties
    feasible: violations.length === 0,
    violations,
    adjacency,
    doors, // Add doors to the returned object
  };

  return result;
}
