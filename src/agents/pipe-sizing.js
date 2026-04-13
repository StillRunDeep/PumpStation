import { selectDN, fmt, stepRow, validateParams } from '../utils.js'

/**
 * AG1-3：管道尺寸计算与水力校核
 *
 * 依据：香港渠务署《雨水排水手册（第五版）》第8章、第14章
 *
 * 步骤6a：管道尺寸计算
 *   D_calc = sqrt(4 × Q_vol / (π × v)) × 1000  (mm)
 *   DN = ceil_to_DN_series(D_calc)
 *
 * 步骤6b：水力校核
 *   H_f = 10.29 × n² × L × Q² / D^5.33  (m)
 *   NPSH_a ≥ NPSH_r + 0.5  (m)
 *
 * ── 参数说明 ──────────────────────────────────────────────────────────────
 * 输入参数（来自AG1-2或AG0-0）：
 *   Q_pump        单泵设计流量（m³/s），来自AG1-2
 *   H_total       总扬程（m），来自AG1-2
 *   Q             泵站总流量（m³/h），来自AG0-0
 *   N             工作泵台数，来自AG0-0
 *
 * 设计参数（带默认值，依据手册或工程惯例）：
 *   v_pumpOut     泵出水管设计流速（m/s），默认2.0
 *   v_mainOut     总出水干管设计流速（m/s），默认2.1
 *   n             曼宁粗糙系数，默认0.013（混凝土管），手册第8.3节
 *   k_local       局部损失系数，默认0.15，沿程损失的15%
 *   NPSH_r        必需汽蚀余量（m），默认3.0，工程惯例
 *   L             管长（m），默认50，工程惯例
 * ─────────────────────────────────────────────────────────────────────────
 */

// 方案常量：存储流速设计目标，DN 由 D = √(4Q/πv) × 1000 → selectDN() 动态推算
export const PIPE_SCHEMES = [
  {
    id: 1,
    name: '经济紧凑型',
    nameFull: 'Compact / Standard HK Design',
    v_pumpOut: 2.0,    // m/s —— 出口阀门段正常范围上端（1.5~2.4）
    v_mainOut: 2.7,    // m/s —— 总管警告区间（>2.2，<3.0），以高流速换小管径
    badge: '空间优先',
    notes: '需配置双孔空气阀 + 缓闭止回阀，建议进行水锤分析（Surge Analysis）',
    surgeRisk: 'high',
  },
  {
    id: 2,
    name: '稳健节能型',
    nameFull: 'Robust / Energy Saving',
    v_pumpOut: 2.0,    // m/s —— 出口阀门段正常范围上端
    v_mainOut: 2.1,    // m/s —— 总管正常范围上端（≤2.2）
    badge: '推荐',
    notes: '常规配置空气阀，水锤风险显著降低，运行能耗居中',
    surgeRisk: 'low',
  },
  {
    id: 3,
    name: '保守安全型',
    nameFull: 'Conservative',
    v_pumpOut: 1.5,    // m/s —— 出口阀门段正常范围下端
    v_mainOut: 1.5,    // m/s —— 总管正常范围下端
    badge: '安全优先',
    notes: '基本无水锤风险，管材及阀门造价较高',
    surgeRisk: 'none',
  },
]

// 参数范围定义
export const PIPE_SIZING_LIMITS = {
  // 输入参数范围
  Q_pump:      { min: 0.001, max: 100,   unit: 'm³/s', label: '单泵设计流量' },
  H_total:     { min: 1,     max: 50,    unit: 'm',    label: '总扬程' },
  Q:           { min: 1,     max: 100000, unit: 'm³/h', label: '泵站总流量' },
  N:           { min: 1,     max: 6,     unit: '台',   label: '工作泵台数', integer: true },
  // 设计参数范围
  v_pumpOut:   { min: 0.6,   max: 3.0,   unit: 'm/s',  label: '泵出水管设计流速', ref: '正常 1.5~2.4，警告 >2.4，上限 3.0' },
  v_mainOut:   { min: 0.6,   max: 3.0,   unit: 'm/s',  label: '总出水干管设计流速', ref: '正常 1.5~2.2，警告 >2.2，上限 3.0' },
  n:           { min: 0.010, max: 0.020, unit: 's/m^(1/3)', label: '曼宁粗糙系数', ref: '手册第8.3节' },
  k_local:     { min: 0.05,  max: 0.30,  unit: '',     label: '局部损失系数', ref: '工程惯例' },
  NPSH_r:      { min: 1.0,   max: 8.0,   unit: 'm',    label: '必需汽蚀余量', ref: '工程惯例' },
  L:           { min: 5,     max: 500,   unit: 'm',    label: '管长', ref: '工程惯例' },
}

/**
 * 校验AG1-3参数是否在有效范围内
 * @returns {Array} 错误信息数组
 */
export function validatePipeSizingParams(params) {
  return validateParams(params, PIPE_SIZING_LIMITS)
}

/**
 * AG1-3：管道尺寸计算与水力校核
 *
 * @param {Object} params - 输入参数
 * @param {number} params.Q_pump - 单泵设计流量（m³/s）
 * @param {number} params.Q - 泵站总流量（m³/h）
 * @param {number} params.N - 工作泵台数
 * @param {number} params.H_total - 总扬程（m），来自AG1-2
 * @param {number} params.Z_stop - 停泵水位（mPD），用于NPSH计算
 * @param {number} params.H_s - 淹没深度（m），主泵进口以上水柱高度，取固定值2.0m
 * @param {number} [params.v_pumpOut=2.0] - 泵出水管设计流速（m/s）
 * @param {number} [params.v_mainOut=2.1] - 总出水干管设计流速（m/s）
 * @param {number} [params.n=0.013] - 曼宁粗糙系数
 * @param {number} [params.k_local=0.15] - 局部损失系数
 * @param {number} [params.NPSH_r=3.0] - 必需汽蚀余量（m）
 * @param {number} [params.L=50] - 管长（m）
 * @param {number} [params.schemeId=2] - 当前方案编号（仅用于结果标注）
 * @returns {Object} 计算结果
 */
export function runPipeSizing({
  Q_pump,      // 单泵设计流量（m³/s）
  Q,           // 泵站总流量（m³/h）
  N,           // 工作泵台数
  H_total,     // 总扬程（m）
  Z_stop,      // 停泵水位（mPD）
  H_s = 2.0,   // 淹没深度（m），主泵进口以上水柱高度
  v_pumpOut = 2.0,  // 泵出水管设计流速（m/s）
  v_mainOut = 2.1,  // 总出水干管设计流速（m/s）
  n = 0.013,   // 曼宁粗糙系数（混凝土管），默认值依据手册第8.3节
  k_local = 0.15, // 局部损失系数，默认值依据工程惯例
  NPSH_r = 3.0, // 必需汽蚀余量（m），默认值依据工程惯例
  L = 50,      // 管长（m），默认值依据工程惯例
  DN_pump_outlet = null, // 来自泵资料库的出水弯头 DN（mm），可为 null
  schemeId = 2, // 当前方案编号（仅用于结果标注）
}) {
  const rows = []
  const warnings = []

  // ── 参数校验 ──────────────────────────────────────────────
  const validationErrors = validatePipeSizingParams({
    Q_pump, Q, N, H_total, v_pumpOut, v_mainOut, n, k_local, NPSH_r, L
  })

  if (validationErrors.length > 0) {
    return {
      valid: false,
      errors: validationErrors,
      warnings,
      rows: validationErrors.map(e => stepRow('错误', '', e, '')),
    }
  }

  // ── 设计参数标注 ──────────────────────────────────────────
  rows.push(stepRow('═══════════ 设计参数 ═══════════', '', '', ''))
  rows.push(stepRow('泵出水管设计流速 v_pumpOut', '方案参数', v_pumpOut, 'm/s'))
  rows.push(stepRow('总出水干管设计流速 v_mainOut', '方案参数', v_mainOut, 'm/s'))
  rows.push(stepRow('曼宁粗糙系数 n', '高级设置，手册规定 0.010~0.020 s/m^(1/3)', n, 's/m^(1/3)'))
  rows.push(stepRow('局部损失系数 k_local', '高级设置，惯例 0.15', k_local, ''))
  rows.push(stepRow('必需汽蚀余量 NPSH_r', '高级设置，惯例 3~5 m', NPSH_r, 'm'))
  rows.push(stepRow('管长 L', '工程惯例默认值', L, 'm'))

  // ── 步骤6a：管道尺寸计算 ─────────────────────────────────

  rows.push(stepRow('═══════════ 步骤6a：管道尺寸 ═══════════', '', '', ''))

  // 6.1 PumpOutlet 管径（压水管，每台泵独立）
  const D_pumpOut_calc = Math.sqrt(4 * Q_pump / (Math.PI * v_pumpOut)) * 1000
  const DN_pumpOut = selectDN(D_pumpOut_calc, warnings)

  rows.push(stepRow('泵出水管计算内径 D_pumpOut', `√(4×Q_pump/π×v_pumpOut)×1000 =`, fmt(D_pumpOut_calc, 1), 'mm'))
  rows.push(stepRow('泵出水管公称直径 DN_pumpOut', '向上取标准系列', `DN${DN_pumpOut}`, 'mm'))

  // 6.2 变径判断（泵出口 vs 设计管道 DN）
  let reducerType = null
  let reducerDesc = null

  if (DN_pump_outlet != null) {
    if (DN_pumpOut > DN_pump_outlet) {
      reducerType = 'expand'
      reducerDesc = `渐扩管 DN${DN_pump_outlet}×DN${DN_pumpOut}`
    } else if (DN_pumpOut < DN_pump_outlet) {
      reducerType = 'reduce'
      reducerDesc = `渐缩管 DN${DN_pump_outlet}×DN${DN_pumpOut}`
    }
    rows.push(stepRow('泵出口 DN（资料库）', '来自 AG1-2 泵选型', `DN${DN_pump_outlet}`, 'mm'))
    const txt = reducerDesc ?? '无需变径（管径一致）'
    rows.push(stepRow('变径构件', '泵出口拓扑', txt, ''))
  }

  // 6.3 MainOutlet 管径（总出水干管）
  const q_total = Q / 3600  // 总流量 m³/s
  const D_mainOutlet_calc = Math.sqrt(4 * q_total / (Math.PI * v_mainOut)) * 1000
  const DN_mainOutlet = selectDN(D_mainOutlet_calc, warnings)

  rows.push(stepRow('总出水管计算流量 q_total', `Q / 3600 = ${Q} / 3600 =`, fmt(q_total, 3), 'm³/s'))
  rows.push(stepRow('总出水管计算内径 D_mainOutlet', `√(4×q_total/π×v_mainOut)×1000 =`, fmt(D_mainOutlet_calc, 1), 'mm'))
  rows.push(stepRow('总出水管公称直径 DN_mainOutlet', '向上取标准系列', `DN${DN_mainOutlet}`, 'mm'))

  // ── 步骤6b：水力校核 ─────────────────────────────────────

  rows.push(stepRow('═══════════ 步骤6b：水力校核 ═══════════', '', '', ''))

  // 6.4 沿程损失校验（曼宁公式）
  // H_f = 10.29 × n² × L × Q_pump² / D^5.33
  // 使用压水管管径计算
  const D_actual_m = DN_pumpOut / 1000  // m
  const H_f = 10.29 * Math.pow(n, 2) * L * Math.pow(Q_pump, 2) / Math.pow(D_actual_m, 5.33)

  rows.push(stepRow('沿程损失 H_f', `10.29×n²×L×Q²/D^5.33 =`, fmt(H_f, 3), 'm', '手册第8.3节'))

  // 6.5 局部损失
  const H_local = k_local * H_f
  rows.push(stepRow('局部损失 H_local', `k_local × H_f = ${k_local} × ${fmt(H_f, 3)} =`, fmt(H_local, 3), 'm'))

  // 6.6 总水头损失
  const H_loss = H_f + H_local
  rows.push(stepRow('总水头损失 H_loss', `H_f + H_local =`, fmt(H_loss, 3), 'm'))

  // 6.7 流速校验
  // 出口阀门段：正常 1.5~2.4 m/s，警告 >2.4，上限 3.0
  // 总管段：正常 1.5~2.2 m/s，警告 >2.2，上限 3.0
  const v_pumpOut_actual = Q_pump / (Math.PI * Math.pow(D_actual_m / 2, 2))
  const D_mainOutlet_m = DN_mainOutlet / 1000
  const v_mainOut_actual = q_total / (Math.PI * Math.pow(D_mainOutlet_m / 2, 2))

  const v_pumpOut_ok = v_pumpOut_actual >= 0.6 && v_pumpOut_actual <= 2.4
  const v_pumpOut_warn = v_pumpOut_actual > 2.4 && v_pumpOut_actual <= 3.0
  const v_mainOut_ok = v_mainOut_actual >= 0.6 && v_mainOut_actual <= 2.2
  const v_mainOut_warn = v_mainOut_actual > 2.2 && v_mainOut_actual <= 3.0

  rows.push(stepRow('泵出水流速 v_pumpOut_actual', `Q_pump/(π×(DN/2)²) =`, fmt(v_pumpOut_actual, 3), 'm/s'))
  rows.push(stepRow('泵出水流速范围校验', '0.6 ≤ v ≤ 2.4 m/s（正常），>2.4 警告', v_pumpOut_warn ? '⚠ 警告' : v_pumpOut_ok ? '✓ 满足' : '✗ 超出', '', '手册第8.3节'))
  rows.push(stepRow('总管流速 v_mainOut_actual', `q_total/(π×(DN/2)²) =`, fmt(v_mainOut_actual, 3), 'm/s'))
  rows.push(stepRow('总管流速范围校验', '0.6 ≤ v ≤ 2.2 m/s（正常），>2.2 警告', v_mainOut_warn ? '⚠ 警告' : v_mainOut_ok ? '✓ 满足' : '✗ 超出', '', '手册第8.3节'))

  if (v_pumpOut_warn) warnings.push(`泵出水流速 ${fmt(v_pumpOut_actual)} m/s 超出正常范围（>2.4 m/s），需水锤分析`)
  if (!v_pumpOut_ok && !v_pumpOut_warn) warnings.push(`泵出水流速 ${fmt(v_pumpOut_actual)} m/s 超出上限（3.0 m/s）`)
  if (v_mainOut_warn) warnings.push(`总管流速 ${fmt(v_mainOut_actual)} m/s 超出正常范围（>2.2 m/s），需水锤分析`)
  if (!v_mainOut_ok && !v_mainOut_warn) warnings.push(`总管流速 ${fmt(v_mainOut_actual)} m/s 超出上限（3.0 m/s）`)

  // 6.8 NPSH 校验
  // NPSH_a = (P_atm - P_v) / (ρg) + H_s - H_suction_loss
  // 简化：NPSH_a = 10.33 - 0.5 + H_s - 0.2
  // H_s 由调用方传入（AG1-2 已计算为固定值2.0m），不再依赖 Z_sump
  const NPSH_a = 10.33 - 0.5 + H_s - 0.2
  const NPSH_ok = NPSH_a >= NPSH_r + 0.5

  rows.push(stepRow('═══════════ NPSH校验 ═══════════', '', '', ''))
  rows.push(stepRow('淹没深度 H_s', '固定值（大型轴流泵典型要求）', fmt(H_s, 2), 'm'))
  rows.push(stepRow('必需汽蚀余量 NPSH_r', '高级设置，惯例 3~5 m', NPSH_r, 'm'))
  rows.push(stepRow('有效汽蚀余量 NPSH_a', `10.33-0.5+H_s-0.2 =`, fmt(NPSH_a, 2), 'm', '手册第14.2.3节'))
  rows.push(stepRow('NPSH安全余量', 'NPSH_a ≥ NPSH_r + 0.5', NPSH_ok ? '✓ 满足' : '✗ 不满足', '', '手册第14.2.3节'))

  if (!NPSH_ok) {
    warnings.push(`NPSH校验不通过：NPSH_a(${fmt(NPSH_a)}) < NPSH_r+0.5(${fmt(NPSH_r + 0.5)})`)
  }

  // ── 校验结果汇总 ──────────────────────────────────────────

  rows.push(stepRow('═══════════ 校验结果汇总 ═══════════', '', '', ''))
  rows.push(stepRow('流速校验', 'v_pumpOut 范围 AND v_mainOut 范围', `${v_pumpOut_ok && v_mainOut_ok ? '✓ 全部通过' : v_pumpOut_warn || v_mainOut_warn ? '⚠ 部分警告' : '✗ 超出'}`))
  rows.push(stepRow('NPSH校验', 'NPSH_a ≥ NPSH_r + 0.5', `${NPSH_ok ? '✓ 满足' : '⚠ 不满足'}`, ''))

  // ── 输出结果 ──────────────────────────────────────────────

  return {
    // 计算状态
    valid: true,
    errors: [],
    warnings,
    // 管道尺寸
    DN_pumpOut,
    DN_mainOutlet,
    // 水力参数
    H_f,
    H_local,
    H_loss,
    // 流速
    v_pumpOut_actual,
    v_mainOut_actual,
    v_pumpOut_ok,
    v_mainOut_ok,
    // NPSH
    NPSH_r,
    NPSH_a,
    NPSH_ok,
    // 设计参数（带依据标注）
    designParams: {
      Q_pump:    { value: Q_pump,    unit: 'm³/s',      ref: '单泵设计流量' },
      Q:         { value: Q,         unit: 'm³/h',      ref: '泵站总流量' },
      N:         { value: N,         unit: '台',        ref: '工作泵台数' },
      H_total:   { value: H_total,   unit: 'm',        ref: '总扬程' },
      Z_stop:    { value: Z_stop,    unit: 'mPD',       ref: '停泵水位' },
      v_pumpOut: { value: v_pumpOut, unit: 'm/s',      ref: '方案参数' },
      v_mainOut: { value: v_mainOut, unit: 'm/s',      ref: '方案参数' },
      n:         { value: n,         unit: 's/m^(1/3)', ref: '手册第8.3节' },
      k_local:   { value: k_local,   unit: '',         ref: '工程惯例' },
      NPSH_r:    { value: NPSH_r,    unit: 'm',        ref: '工程惯例' },
      L:         { value: L,         unit: 'm',         ref: '工程惯例' },
    },
    // 方案编号（供结果面板展示方案标注）
    schemeId,
    // 输出给下游
    DN_pump_outlet,  // 透传，供 main.js 富化拓扑使用
    reducerType,     // null | 'expand' | 'reduce'
    reducerDesc,     // 描述字符串 | null
    rows,
  }
}