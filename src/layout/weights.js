/**
 * Score weight utilities — allows UI-layer multiplication of each breakdown
 * component without touching scorer.js.
 *
 * Weights are persisted to localStorage so they survive page refreshes.
 */

export const WEIGHT_KEYS = [
  'base', 'footprint', 'adjacency', 'corridor',
  'trafo', 'fanRoom', 'efficiency', 'accessibility',
  'violations', 'doorAccess', 'missingRooms', 'aspectRatio',
]

export const WEIGHT_LABELS = {
  base:        '基础分',
  footprint:   '占地面积',
  adjacency:   '临近关系',
  corridor:    '走廊完整',
  trafo:       '变压器布置',
  fanRoom:     '风机房距离',
  efficiency:  '空间有效率',
  accessibility: '便捷性',
  violations:  '约束违反',
  doorAccess:  '可达性违反',
  missingRooms: '房间缺失',
  aspectRatio: '房间长宽比',
}

export const DEFAULT_WEIGHTS = Object.fromEntries(WEIGHT_KEYS.map(k => [k, 1]))

const STORAGE_KEY = 'pumpstation_score_weights'

export function saveWeights(weights) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(weights))
  } catch (_) { /* storage quota or private mode */ }
}

export function loadWeights() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return { ...DEFAULT_WEIGHTS, ...saved }
  } catch (_) {
    return { ...DEFAULT_WEIGHTS }
  }
}

/**
 * Apply per-key weights to a breakdown object.
 * Each breakdown value is multiplied by its corresponding weight.
 * Returns a rounded integer total score.
 *
 * @param {Object} breakdown  - e.g. { base: 10000, footprint: -144, ... }
 * @param {Object} weights    - e.g. { base: 1, footprint: 2, ... }
 * @returns {number}
 */
export function computeWeightedScore(breakdown, weights) {
  if (!breakdown) return 0
  let total = 0
  for (const k of WEIGHT_KEYS) {
    const val = breakdown[k] ?? 0
    const w   = weights[k]  ?? 1
    total += val * w
  }
  return Math.round(total)
}
