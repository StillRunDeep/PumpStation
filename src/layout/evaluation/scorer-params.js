/**
 * Tunable scoring constants for scorer.js.
 *
 * All magic numbers live here so they can be edited from the UI without
 * touching source code.  scorer.js reads SCORER_PARAMS by reference each
 * call, so mutations made by the UI take effect immediately on the next
 * scoreLayout() invocation.
 *
 * Parameter Change History (b803908, Apr 2026):
 * - aspectRatioThreshold: 4 → 3 (stricter shape constraints)
 * - aspectRatioPenalty: 500 → 2000 (4x penalty increase)
 *   ⚠️  Review impact: single room violations can now exceed 2000 points
 *   Validation: ensure ≥60% of layouts pass Checkpoint A after this change
 */

export const PARAM_GROUPS = [
  {
    label: '生长顺利度',
    keys: ['growthSuccessMaxBonus'],
  },
  {
    label: '变压器布置',
    keys: ['trafoExteriorBonus', 'trafoSameSideBonus'],
  },
  {
    label: '风机房距离',
    keys: ['fanRoomMaxBonus', 'fanRoomDistDivisor'],
  },
  {
    label: '临近关系',
    keys: ['mustAdjacencyBonus', 'shouldAdjacencyBonus'],
  },
  {
    label: '走廊完整',
    keys: ['corridorHitsThreshold', 'corridorBonus'],
  },
  {
    label: '空间效率',
    keys: ['efficiencyBase', 'efficiencyRange', 'efficiencyMaxBonus'],
  },
  {
    label: '便捷性',
    keys: ['convenienceIdealGrids', 'convenienceRange', 'convenienceMaxBonus'],
  },
  {
    label: '多样性',
    keys: ['diversityThreshold', 'diversityPenalty'],
  },
  {
    label: '违反惩罚',
    keys: ['mustViolationPenalty', 'doorAccessPenalty', 'missingRoomPenalty', 'aspectRatioThreshold', 'aspectRatioPenalty', 'utilizationThreshold', 'utilizationStep', 'vertexThreshold', 'vertexStep'],
  },
]

export const PARAM_LABELS = {
  growthSuccessMaxBonus:  '生长顺利度最大奖励',
  trafoExteriorBonus:     '变压器外墙奖励',
  trafoSameSideBonus:     '变压器同侧奖励',
  fanRoomMaxBonus:        '风机房最大奖励',
  fanRoomDistDivisor:     '距离除数(mm/pt)',
  mustAdjacencyBonus:     'MUST临近奖励',
  shouldAdjacencyBonus:   'SHOULD临近奖励',
  corridorHitsThreshold:  '走廊触发条数',
  corridorBonus:          '走廊完整奖励',
  efficiencyBase:         '效率奖励起始值',
  efficiencyRange:        '效率奖励范围宽度',
  efficiencyMaxBonus:     '效率最大奖励',
  convenienceIdealGrids:  '便捷性理想格数',
  convenienceRange:       '便捷性映射范围',
  convenienceMaxBonus:    '便捷性最大奖励',
  diversityThreshold:     '多样性判定阈值(格)',
  diversityPenalty:       '重复方案扣分',
  mustViolationPenalty:   'MUST违反扣分',
  doorAccessPenalty:      '可达性违反扣分',
  missingRoomPenalty:     '房间缺失扣分',
  aspectRatioThreshold:   '长宽比超标阈值',
  aspectRatioPenalty:     '形状/比例违反扣分',
  utilizationThreshold:   '利用率达标阈值',
  utilizationStep:        '利用率惩罚步长',
  vertexThreshold:        '顶点数达标阈值',
  vertexStep:             '顶点惩罚步长',
}

export const PARAM_STEPS = {
  efficiencyBase:  0.01,
  efficiencyRange: 0.01,
  utilizationThreshold: 0.01,
  utilizationStep: 0.01,
}

export const DEFAULT_SCORER_PARAMS = {
  growthSuccessMaxBonus:  3000,
  trafoExteriorBonus:     20,
  trafoSameSideBonus:     20,
  fanRoomMaxBonus:        30,
  fanRoomDistDivisor:     500,
  mustAdjacencyBonus:     40,
  shouldAdjacencyBonus:   15,
  corridorHitsThreshold:  2,
  corridorBonus:          20,
  efficiencyBase:         0.60,
  efficiencyRange:        0.30,
  efficiencyMaxBonus:     50,
  convenienceIdealGrids:  150,
  convenienceRange:       100,
  convenienceMaxBonus:    30,
  diversityThreshold:     5.0,
  diversityPenalty:       200,
  mustViolationPenalty:   3000,
  doorAccessPenalty:      3000,
  missingRoomPenalty:     3000,
  aspectRatioThreshold:   2.5,
  aspectRatioPenalty:     2000,
  utilizationThreshold:   0.70,
  utilizationStep:        0.15,
  vertexThreshold:        6,
  vertexStep:             2,
}

const STORAGE_KEY = 'pumpstation_scorer_params'

export function saveScorerParams(params) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(params))
  } catch (_) { /* storage quota or private mode */ }
}

export function loadScorerParams() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return { ...DEFAULT_SCORER_PARAMS, ...saved }
  } catch (_) {
    return { ...DEFAULT_SCORER_PARAMS }
  }
}

/**
 * Mutable singleton shared between scorer.js and the UI.
 * scorer.js reads this object by reference on every scoreLayout() call,
 * so in-place mutations by the UI take effect immediately.
 */
export const SCORER_PARAMS = loadScorerParams()
