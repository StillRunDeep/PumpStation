import { adjacent } from '../generator/placer.js'

/**
 * Adjacency graph for the pump station building.
 * MUST pairs: violations reduce feasibility score (−500 each per computeDoorAccessPenalty)
 * SHOULD pairs: satisfaction adds bonus points (+15 each)
 *
 * History:
 * - v1.1: trafo1/trafo2 upgraded SHOULD → MUST (shared wall, no internal door)
 * - v1.8 (b803908): parking/repair_zone upgraded SHOULD → MUST (equipment transfer convenience)
 *   This constrains parking and repair_zone to be mutually adjacent with no external wall escape.
 */
export const ADJACENCY_MUST = [
  { pair: ['meter_main', 'meter_sub'], reason: '水表房并排，共用外墙区段' },
  { pair: ['trafo1',     'trafo2'],    reason: '变压器房相邻布置，方便母线桥架连接（共享侧墙，无内门）' },
  { pair: ['parking',     'repair_zone'], reason: '临近，便于设备转运' },
]

export const ADJACENCY_SHOULD = [
  { pair: ['lv_control',  'corridor_l1'], reason: '控制室通过内走廊进入' },
  { pair: ['clean_pump',  'corridor_l1'], reason: '清洁泵房经走廊联系' },
  { pair: ['rainwater',   'corridor_l1'], reason: '雨水房经走廊联系' },
  { pair: ['fan_room',    'corridor_l1'], reason: '风机房通过走廊连通，避免孤立' },
  { pair: ['fan_room',    'dock2'],       reason: '设备经吊装口就近进出风机房，距离越近越便利' },
  { pair: ['fire_equip',  'meter_sub'],   reason: '小型服务用房宜集中布置，减少外墙开门分散' },
]

/**
 * Check all adjacency pairs against actual placements.
 * @param {object} placements  Combined ground + level1 placement map
 * @returns {{ satisfied: Array, violated: Array }}
 */
export function checkAdjacency(placements) {
  const satisfied = []
  const violated  = []

  for (const entry of ADJACENCY_MUST) {
    const [a, b] = entry.pair
    if (!placements[a] || !placements[b]) continue
    ;(adjacent(placements[a], placements[b]) ? satisfied : violated)
      .push({ ...entry, type: 'must' })
  }

  for (const entry of ADJACENCY_SHOULD) {
    const [a, b] = entry.pair
    if (!placements[a] || !placements[b]) continue
    ;(adjacent(placements[a], placements[b]) ? satisfied : violated)
      .push({ ...entry, type: 'should' })
  }

  return { satisfied, violated }
}
