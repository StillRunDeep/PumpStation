import { fmt, stepRow, validateParams } from '../utils.js'
import IDF_ZONES from '../config/idf-zones.json'

// ── IDF 常数表（从配置文件加载）──────────────────────────────────────────

// 转换为旧代码兼容格式：{ zoneKey: { T: { a, b, c } } }
export const IDF_CONSTANTS = Object.fromEntries(
  Object.entries(IDF_ZONES.zones).map(([key, zone]) => [
    key,
    Object.fromEntries(
      Object.entries(zone.constants).map(([T, vals]) => [Number(T), vals])
    )
  ])
)

// 暴雨分区选项列表（供 UI 下拉使用）
export const IDF_ZONE_LIST = Object.entries(IDF_ZONES.zones).map(([key, zone]) => ({
  value: key,
  label: zone.label,
  zoneNumber: zone.zoneNumber,
}))

// 保留对配置原文的引用（供下游如 UI 面板使用）
export { IDF_ZONES }

// ── 参数范围定义 ─────────────────────────────────────────────────────────

/**
 * AG0-0 参数范围定义
 * 依据：香港渠务署《雨水排水手册（第五版）》
 */
export const USER_PARAMS_LIMITS = {
  // 暴雨分区选项
  zone: {
    options: ['tungkl', 'tai-mo-shan', 'west-lantau', 'north'],
    labels: { 'tungkl': '香港天文台总部', 'tai-mo-shan': '大帽山', 'west-lantau': '西部大屿山', 'north': '北区' },
    label: '暴雨分区', ref: '手册第4.3.2节'
  },
  // 设计重现期选项
  T: {
    options: [10, 50, 200],
    label: '设计重现期', ref: '手册第14.6.2节'
  },
  // 直接输入模式参数
  Q_total:    { min: 0.1,  max: 100,  unit: 'm³/s', label: '水泵最高总排水量' },
  V_design:   { min: 100, max: 500000, unit: 'm³', label: '设计水缸容量' },
  D:          { min: 5,   max: 30,  unit: 'm',   label: '设计水缸深度' },
  Z:          { min: 4,   max: 12,  unit: '次/小时', label: '每小时允许启动次数', ref: '手册第14.6.1节' },
  Z_discharge: { min: -10, max: 50,  unit: 'mPD', label: '排放口标高' },
  // 暴雨分析模式参数
  t_d:      { min: 10,   max: 240,  unit: 'min', label: '暴雨历时', ref: '手册第4.3.4节' },
  A:        { min: 0.001, max: 100, unit: 'km²', label: '集水区面积', ref: '手册第7.5.2节' },
  C:        { min: 0.05, max: 1.0,  unit: '',    label: '径流系数', ref: '手册表7.5.2' },
  // 气候变化参数
  delta_i:  { min: 0,    max: 30,   unit: '%',   label: '气候变化降雨增加量', ref: '手册第6.8节' },
  // 集流时间参数
  H:        { min: 0.1,  max: 100,  unit: 'm/100m', label: '平均坡降' },
  L:        { min: 10,   max: 10000, unit: 'm',    label: '最长流径水平距离' },
  // 集水池几何参数
  Z_sump:   { min: -50, max: 10,   unit: 'mPD', label: '集水坑底标高', ref: '手册第14.6.3节' },
  // 保留参数（用于兼容）
  N:        { min: 1,    max: 6,    unit: '台',  label: '工作泵台数', ref: '手册第14.6.2节', integer: true },
  N_spare:  { min: 0,    max: 3,    unit: '台',  label: '备用泵台数', ref: '手册第14.6.2节', integer: true },
  Z_bottom: { min: -50, max: 10,   unit: 'mPD', label: '池底标高' },
}

// 径流系数参考表
export const C_REFERENCE_TABLE = [
  { type: '城市沥青/混凝土', C_min: 0.85, C_max: 0.95, ref: '手册表7.5.2' },
  { type: '公园/草地', C_min: 0.05, C_max: 0.35, ref: '手册表7.5.2' },
  { type: '乡村/农业', C_min: 0.20, C_max: 0.50, ref: '手册表7.5.2' },
]

// ── 参数校验 ─────────────────────────────────────────────────────────────

/**
 * 标准参数范围校验（使用 validateParams 工具）
 */
export function validateUserParams(params) {
  return validateParams(params, USER_PARAMS_LIMITS)
}

/**
 * 跨字段校验（水位关系）
 */
function validateCrossFields({ Z_bottom, Z_discharge, Z_sump }) {
  const errors = []
  if (!isNaN(Z_bottom) && !isNaN(Z_discharge) && Z_bottom >= Z_discharge)
    errors.push(`池底标高 Z_bottom (${Z_bottom}) 应小于排放口标高 Z_discharge (${Z_discharge})`)
  if (Z_sump !== undefined && Z_sump !== null && !isNaN(Z_sump) && !isNaN(Z_bottom) && Z_sump >= Z_bottom)
    errors.push(`集水坑底标高 Z_sump (${Z_sump}) 应小于池底标高 Z_bottom (${Z_bottom})`)
  return errors
}

/**
 * 模式特定必填参数校验
 */
function validateModePresence(params, mode) {
  const errors = []
  if (mode === 'direct') {
    if (params.Q_total === undefined || isNaN(params.Q_total))
      errors.push('直接输入模式需要提供 Q_total')
  } else {
    if (!params.zone) errors.push('暴雨分析模式需要提供 zone')
    if (!params.T)   errors.push('暴雨分析模式需要提供 T')
    if (isNaN(params.t_d)) errors.push('暴雨分析模式需要提供 t_d')
    if (isNaN(params.A))   errors.push('暴雨分析模式需要提供 A')
    if (isNaN(params.C))   errors.push('暴雨分析模式需要提供 C')
  }
  return errors
}

// ── 纯计算函数 ───────────────────────────────────────────────────────────

/**
 * 几何参数计算
 */
function calcGeometric(Z_bottom, D) {
  return { Z_top: Z_bottom + D }
}

/**
 * 直接输入模式流量计算
 */
function calcFlow_direct(Q_total, N) {
  const Q_pump   = Q_total / N        // 单泵流量（m³/s）
  const Q_single = Q_pump * 3600      // 单泵流量（m³/h）
  return { Q_pump, Q_single }
}

/**
 * 暴雨分析模式流量计算
 * 公式依据：香港渠务署《雨水排水手册（第五版）》
 */
function calcFlow_rainfall({ zone, T, t_d, A, C, delta_i = 0, H = 1.0, L = 500, N }) {
  const constants  = IDF_CONSTANTS[zone]?.[T]
  if (!constants) return null

  // 步骤1：暴雨分析（IDF公式）
  const i = constants.a / Math.pow(t_d + constants.b, constants.c)  // mm/h

  // 气候变化修正
  const i_adjusted = i * (1 + delta_i / 100)  // mm/h

  // 步骤2：径流估算（推理法）
  const ARF  = A <= 25 ? 1.0 : 1.547 / (A + 280.11)
  const Q_p = 0.278 * C * i_adjusted * A * ARF  // 峰值流量（m³/s）
  const Q   = Q_p * 3600                          // 总设计流量（m³/h）

  // 步骤2b：集流时间计算（布兰兹贝-威廉公式）
  const t_c = 0.14465 * L / (Math.pow(H, 0.2) * Math.pow(A * 1000000, 0.1))  // min

  return {
    i, i_adjusted, ARF, Q_p, Q,
    Q_pump: Q_p,                     // 单泵流量（m³/s）
    Q_single: Q / N,                 // 单泵流量（m³/h）
    t_c,
  }
}

// ── 输出行构建 ───────────────────────────────────────────────────────────

function buildGeometricRows({ Z_bottom, Z_sump, D, Z_top, Z_discharge }) {
  const rows = []
  rows.push(stepRow('═══════════ 几何参数 ═══════════', '', '', ''))
  rows.push(stepRow('池底标高 Z_bottom', '用户输入', Z_bottom, 'mPD', ''))
  if (Z_sump !== undefined && Z_sump !== null && !isNaN(Z_sump))
    rows.push(stepRow('集水坑底标高 Z_sump', '来自高级设置', Z_sump, 'mPD', '应小于Z_bottom'))
  rows.push(stepRow('设计水缸深度 D', '用户输入', D, 'm', ''))
  rows.push(stepRow('池顶标高 Z_top', `Z_bottom + D = ${Z_bottom} + ${D}`, Z_top, 'mPD', '计算值'))
  rows.push(stepRow('排放口标高 Z_discharge', '用户输入', Z_discharge, 'mPD', ''))
  return rows
}

function buildPumpConfigRows({ N, N_spare, Z }) {
  const rows = []
  rows.push(stepRow('═══════════ 水泵配置 ═══════════', '', '', ''))
  rows.push(stepRow('工作泵台数 N', '高级设置，手册规定 1~6 台', N, '台'))
  rows.push(stepRow('备用泵台数 N_spare', '高级设置，惯例 0~3 台', N_spare, '台'))
  rows.push(stepRow('每小时允许启动次数 Z', '高级设置，手册规定 4~12 次/小时', Z, '次/小时'))
  return rows
}

function buildDirectModeRows({ Q_total, V_design, N }, { Q_pump }) {
  const rows = []
  rows.push(stepRow('═══════════ 流量参数（直接输入） ═══════════', '', '', ''))
  rows.push(stepRow('水泵最高总排水量 Q_total', '用户输入', Q_total, 'm³/s', ''))
  rows.push(stepRow('设计水缸容量 V_design', '用户输入', V_design, 'm³', ''))
  rows.push(stepRow('单泵设计流量 Q_pump', `Q_total / N = ${fmt(Q_total)} / ${N}`, Q_pump, 'm³/s', ''))
  return rows
}

function buildRainfallModeRows({ zone, T, t_d, A, C, delta_i, H, L, N }, { i, i_adjusted, ARF, Q_p, Q, Q_pump, Q_single, t_c }) {
  const rows = []
  const constants = IDF_CONSTANTS[zone][T]

  rows.push(stepRow('═══════════ 暴雨分析参数 ═══════════', '', '', ''))
  rows.push(stepRow('暴雨分区 zone', `手册第4.3.2节`, zone, '', `选项：${Object.entries(USER_PARAMS_LIMITS.zone.labels).map(([k, v]) => `${k}=${v}`).join(', ')}`))
  rows.push(stepRow('设计重现期 T', `手册第14.6.2节`, Number(T), '年', '选项：10/50/200年'))
  rows.push(stepRow('暴雨历时 t_d', `手册第4.3.4节`, t_d, 'min', `范围：${USER_PARAMS_LIMITS.t_d.min}-${USER_PARAMS_LIMITS.t_d.max}`))
  rows.push(stepRow('集水区面积 A', `手册第7.5.2节`, A, 'km²', `范围：${USER_PARAMS_LIMITS.A.min}-${USER_PARAMS_LIMITS.A.max}`))
  rows.push(stepRow('径流系数 C', `手册表7.5.2`, C, '', `城市：0.85-0.95；乡村：0.20-0.50`))
  rows.push(stepRow('气候变化降雨增加量 Δi', `手册第6.8节`, delta_i, '%', delta_i === 0 ? '当前气候' : '21世纪中叶/末'))
  rows.push(stepRow('平均坡降 H', `用于集流时间`, H, 'm/100m', ''))
  rows.push(stepRow('最长流径水平距离 L', `用于集流时间`, L, 'm', ''))
  rows.push(stepRow('═══════════ 步骤1：暴雨分析 ═══════════', '', '', ''))
  rows.push(stepRow('IDF常数 a', `查表（${USER_PARAMS_LIMITS.zone.labels[zone]}）`, constants.a.toFixed(3), ''))
  rows.push(stepRow('IDF常数 b', `查表（${USER_PARAMS_LIMITS.zone.labels[zone]}）`, constants.b.toFixed(3), ''))
  rows.push(stepRow('IDF常数 c', `查表（${USER_PARAMS_LIMITS.zone.labels[zone]}）`, constants.c.toFixed(3), ''))
  rows.push(stepRow('降雨强度 i（未修正）', `a/(t_d+b)^c = ${constants.a}/(${(t_d + constants.b).toFixed(1)})^${constants.c}`, i, 'mm/h'))
  if (delta_i > 0)
    rows.push(stepRow('气候变化修正后 i', `i × (1 + Δi/100) = ${i.toFixed(2)} × ${(1 + delta_i / 100).toFixed(2)} = ${i_adjusted.toFixed(2)}`, i_adjusted, 'mm/h', '手册第6.8节'))
  rows.push(stepRow('═══════════ 步骤2：径流估算 ═══════════', '', '', ''))
  rows.push(stepRow('面积折减系数 ARF', A <= 25 ? 'A≤25km²→1.0' : '公式：1.547/(A+280.11)', ARF.toFixed(4), '', '手册第4.3.6节'))
  rows.push(stepRow('峰值流量 Q_p', `0.278×C×i×A×ARF =`, Q_p, 'm³/s', '手册第7.5.2节'))
  rows.push(stepRow('总设计流量 Q', `Q_p × 3600 =`, Q, 'm³/h'))
  rows.push(stepRow('单泵设计流量 Q_pump', `Q_p =`, Q_pump, 'm³/s', '用于调蓄演算'))
  rows.push(stepRow('单泵设计流量 Q_single', `Q / N = ${fmt(Q)} / ${N} =`, Q_single, 'm³/h', ''))
  rows.push(stepRow('═══════════ 步骤2b：集流时间 ═══════════', '', '', ''))
  rows.push(stepRow('集流时间 t_c', `0.14465×L/(H^0.2×A^0.1) = 0.14465×${L}/(${H}^0.2×${(A * 1000000).toFixed(0)}^0.1) =`, t_c.toFixed(2), 'min', '布兰兹贝-威廉公式'))
  return rows
}

function buildRows(mode, params, results) {
  const rows = []
  rows.push(...buildGeometricRows(params))
  rows.push(...buildPumpConfigRows(params))
  if (mode === 'direct') {
    rows.push(...buildDirectModeRows(params, results))
  } else {
    rows.push(...buildRainfallModeRows(params, results))
  }
  return rows
}

// ── 空值字段 ─────────────────────────────────────────────────────────────

function nullFields() {
  return {
    Q_total: null, Q_pump: null, Q_single: null,
    N: null, N_spare: null, Z: null,
    V_design: null, Z_bottom: null, D: null, Z_discharge: null, Z_top: null,
    Q_p: null, i: null, ARF: null, Q: null,
    zone: null, T: null, t_d: null, A: null, C: null,
    delta_i: null, H: null, L: null, t_c: null,
    IDF_a: null, IDF_b: null, IDF_c: null,
  }
}

// ── 主函数 ────────────────────────────────────────────────────────────────

/**
 * AG0-0：暴雨分析与径流估算（或直接输入模式）
 *
 * 依据：香港渠务署《雨水排水手册（第五版）》第4章、第7章
 *
 * 支持两种输入模式：
 * 1. 直接输入模式：当 Q_total 提供时，跳过暴雨分析
 * 2. 暴雨分析模式：当 Q_total 未提供时，执行步骤1-2
 *
 * ── 参数说明 ──────────────────────────────────────────────────────────────
 * 直接输入模式参数：
 *   Q_total     水泵最高总排水量（m³/s）
 *   N           工作泵台数，手册第14.6.2节
 *   N_spare     备用泵台数，手册第14.6.2节
 *   Z           每小时允许启动次数（次/小时）
 *   V_design    设计水缸容量（m³）
 *   Z_bottom    池底标高（mPD）
 *   D           设计水缸深度（m）
 *   Z_discharge 排放口标高（mPD）
 *
 * 暴雨分析模式参数（Q_total 未提供时）：
 *   zone       暴雨分区（tungkl/tai-mo-shan/west-lantau/north）
 *   T          设计重现期（10/50/200年），手册第14.6.2节
 *   t_d        暴雨历时（min），手册第4.3.4节
 *   A          集水区面积（km²），手册第7.5.2节
 *   C          径流系数，手册表7.5.2
 * ─────────────────────────────────────────────────────────────────────────
 */
export function runUserParams({
  // 直接输入模式
  Q_total,
  N = 2,
  N_spare = 0,
  Z = 8,
  V_design,
  Z_bottom,
  Z_sump,
  D,
  Z_discharge,
  // 暴雨分析模式参数
  zone,
  T,
  t_d,
  A,
  C,
  delta_i = 0,
  H = 1.0,
  L = 500,
}) {
  const rows     = []
  const warnings = []
  const errors   = []

  // ── 模式判断 ──────────────────────────────────────────────
  const mode = (Q_total !== undefined && Q_total !== null && !isNaN(Q_total))
    ? 'direct'
    : 'rainfall'

  rows.push(stepRow('═══════════ 输入模式 ═══════════', '', '', ''))
  rows.push(stepRow('计算模式', '依据输入参数判断', mode === 'direct' ? '直接输入模式' : '暴雨分析模式', ''))

  // ── 校验 ──────────────────────────────────────────────────
  errors.push(...validateUserParams({ Q_total, N, N_spare, Z, V_design, Z_bottom, Z_sump, D, Z_discharge, zone, T, t_d, A, C, delta_i, H, L }))
  errors.push(...validateCrossFields({ Z_bottom, Z_discharge, Z_sump }))
  errors.push(...validateModePresence({ Q_total, zone, T, t_d, A, C }, mode))

  if (mode === 'direct') {
    if ((N ?? 2) > 6)
      warnings.push('工作泵台数超过 6 台，效率可能下降')
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings, rows, mode, ...nullFields() }
  }

  // ── 计算 ──────────────────────────────────────────────────
  const geo  = calcGeometric(Z_bottom, D)
  const flow = mode === 'direct'
    ? calcFlow_direct(Q_total, N)
    : calcFlow_rainfall({ zone, T, t_d, A, C, delta_i, H, L, N })

  if (mode === 'rainfall' && !flow) {
    errors.push('IDF 参数查询失败，请检查分区和重现期')
    return { valid: false, errors, warnings, rows, mode, ...nullFields() }
  }

  if (flow.Q_pump > 3)
    warnings.push(`单泵流量 ${fmt(flow.Q_single)} m³/h（${fmt(flow.Q_pump)} m³/s）偏大，请确认输入参数`)

  // ── 输出行 ───────────────────────────────────────────────
  rows.push(...buildRows(mode, { Z_bottom, Z_sump, D, Z_top: geo.Z_top, Z_discharge, N, N_spare, Z, Q_total, V_design, zone, T, t_d, A, C, delta_i, H, L }, flow))

  // ── 返回 ──────────────────────────────────────────────────
  return {
    valid: true,
    errors: [],
    warnings,
    mode,
    Z_bottom, Z_sump, D, Z_top: geo.Z_top, Z_discharge,
    N, N_spare, Z,
    Q_total: mode === 'direct' ? Q_total : null,
    V_design,
    Q_pump: flow.Q_pump,
    Q_single: flow.Q_single,
    Q_p: mode === 'rainfall' ? flow.Q_p : null,
    i: mode === 'rainfall' ? flow.i : null,
    i_adjusted: mode === 'rainfall' ? flow.i_adjusted : null,
    ARF: mode === 'rainfall' ? flow.ARF : null,
    Q: mode === 'rainfall' ? flow.Q : null,
    zone: mode === 'rainfall' ? zone : null,
    T: mode === 'rainfall' ? T : null,
    t_d: mode === 'rainfall' ? t_d : null,
    A: mode === 'rainfall' ? A : null,
    C: mode === 'rainfall' ? C : null,
    delta_i: mode === 'rainfall' ? delta_i : null,
    H: mode === 'rainfall' ? H : null,
    L: mode === 'rainfall' ? L : null,
    t_c: mode === 'rainfall' ? flow.t_c : null,
    IDF_a: mode === 'rainfall' ? IDF_CONSTANTS[zone][T].a : null,
    IDF_b: mode === 'rainfall' ? IDF_CONSTANTS[zone][T].b : null,
    IDF_c: mode === 'rainfall' ? IDF_CONSTANTS[zone][T].c : null,
    C_reference: C_REFERENCE_TABLE,
    rows,
  }
}
