import { fmt, stepRow, validateParams } from '../utils.js'
import { findMatchingPumps, diagnosePumpMisses } from '../data/pump-catalog.js'

/**
 * AG1-2：水泵选型计算
 *
 * 依据：香港渠务署《雨水排水手册（第五版）》第14章
 *
 * 步骤4：水泵选型
 *   Q_pump = Q_single / 3600  (m³/s)
 *   H_static = Z_discharge - Z_stop
 *   H_total = H_static + H_pipe_loss  (H_pipe_loss 由用户直接输入)
 *   P_shaft = ρ × g × Q_pump × H_total / (η_hyd × η_mot)
 *   P_motor = P_shaft × K
 *
 * ── 参数说明 ──────────────────────────────────────────────────────────────
 * 输入参数（来自AG0-0或AG1-1）：
 *   Q_single      单泵设计流量（m³/h）
 *   Z_stop        停泵水位（mPD），来自AG1-1
 *   Z_discharge   排放口标高（mPD），用户输入
 *
 * 设计参数（带默认值，依据手册或工程惯例）：
 *   η_hyd         水力效率，默认0.82，手册第14.6节
 *   η_mot         电机效率，默认0.93，手册第14.6节
 *   NPSH_r        必需汽蚀余量（m），默认3.0，工程惯例
 *   H_pipe_loss   出水管阻力（m），含沿程和局部损失，默认5.0
 * ─────────────────────────────────────────────────────────────────────────
 */

// 参数范围定义
export const PUMP_SPEC_LIMITS = {
  // 输入参数范围
  Q_single:    { min: 0.1,   max: 10000,  unit: 'm³/h', label: '单泵设计流量' },
  Z_stop:       { min: -50,  max: 10,    unit: 'mPD',  label: '停泵水位' },
  Z_discharge:  { min: -10,  max: 50,    unit: 'mPD',  label: '排放口标高' },
  // 设计参数范围
  η_hyd:        { min: 0.75, max: 0.95,  unit: '',     label: '水力效率', ref: '手册第14.6节≥0.75' },
  η_mot:        { min: 0.85, max: 0.98,  unit: '',     label: '电机效率', ref: '手册第14.6节≥0.85' },
  NPSH_r:       { min: 1.0,  max: 8.0,   unit: 'm',    label: '必需汽蚀余量', ref: '工程惯例2-5m' },
  H_pipe_loss:  { min: 0,    max: 50,    unit: 'm',    label: '出水管阻力', ref: '含沿程+局部损失' },
}

/**
 * 校验AG1-2参数是否在有效范围内
 * @returns {Array} 错误信息数组
 */
export function validatePumpSpecParams(params) {
  return validateParams(params, PUMP_SPEC_LIMITS)
}

export function runPumpSpec({
  Q_single,      // 单泵设计流量（m³/h）
  Z_stop,         // 停泵水位（mPD）
  Z_discharge,   // 排放口标高（mPD）
  η_hyd = 0.75,  // 水力效率，默认值依据手册第14.6节≥0.75
  η_mot = 0.85,  // 电机效率，默认值依据手册第14.6节≥0.85
  NPSH_r = 3.0,  // 必需汽蚀余量（m），默认值依据工程惯例
  H_pipe_loss = 0, // 出水管阻力（mH2O），含沿程和局部损失
}, overrideMotor = null) {
  const rows = []
  const warnings = []

  // ── 参数校验 ──────────────────────────────────────────────
  const validationErrors = validatePumpSpecParams({
    Q_single, Z_stop, Z_discharge, η_hyd, η_mot, NPSH_r, H_pipe_loss
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
  rows.push(stepRow('水力效率 η_hyd', '高级设置，手册规定 ≥0.82', η_hyd, ''))
  rows.push(stepRow('电机效率 η_mot', '高级设置，手册规定 ≥0.93', η_mot, ''))
  rows.push(stepRow('必需汽蚀余量 NPSH_r', '高级设置，惯例 3~5 m', NPSH_r, 'm'))
  rows.push(stepRow('出水管阻力 H_pipe_loss', '用户输入（含沿程+局部损失）', H_pipe_loss, 'm'))

  // ── 步骤4：水泵选型计算 ───────────────────────────────────

  // 4.1 单泵设计流量
  const Q_pump = Q_single / 3600  // m³/s

  rows.push(stepRow('═══════════ 步骤4：水泵选型 ═══════════', '', '', ''))
  rows.push(stepRow('单泵设计流量 Q_pump', `Q_single / 3600 = ${fmt(Q_single)} / 3600 =`, fmt(Q_pump, 4), 'm³/s'))

  // 4.2 静扬程计算
  const H_static = Z_discharge - Z_stop

  rows.push(stepRow('静扬程 H_static', `Z_discharge - Z_stop = ${fmt(Z_discharge)} - ${fmt(Z_stop)} =`, fmt(H_static, 2), 'm'))

  // ── 总扬程（H_pipe_loss 由用户直接输入）──────────────────

  const H_total = H_static + H_pipe_loss

  rows.push(stepRow('系统总扬程 H_total', `H_static + H_pipe_loss = ${fmt(H_static)} + ${fmt(H_pipe_loss)} =`, fmt(H_total, 2), 'm', '手册第14.6.2节'))

  // ── 轴功率（手册公式）─────────────────────────────────────

  // P_shaft = ρ × g × Q_pump × H_total / (η_hyd × η_mot)
  // ρ = 1000 kg/m³, g = 9.81 m/s²
  const ρ = 1000
  const g = 9.81
  const η_combined = η_hyd * η_mot

  const P_shaft = (ρ * g * Q_pump * H_total) / (η_hyd * η_mot) / 1000  // kW

  rows.push(stepRow('═══════════ 轴功率计算 ═══════════', '', '', ''))
  rows.push(stepRow('水密度 ρ', '常数', ρ, 'kg/m³'))
  rows.push(stepRow('重力加速度 g', '常数', g, 'm/s²'))
  rows.push(stepRow('综合效率 η_combined', `η_hyd × η_mot = ${η_hyd} × ${η_mot} =`, fmt(η_combined, 3), ''))
  rows.push(stepRow('轴功率 P_shaft', `ρ×g×Q×H / (η_hyd×η_mot) =`, fmt(P_shaft, 2), 'kW', '手册第14.6.2节'))

  // ── 电机安全系数 ──────────────────────────────────────────

  let K
  if (P_shaft < 15) {
    K = 1.25
  } else if (P_shaft < 55) {
    K = 1.15
  } else {
    K = 1.10
  }

  const P_motor = overrideMotor || P_shaft * K

  rows.push(stepRow('═══════════ 电机功率 ═══════════', '', '', ''))
  rows.push(stepRow('电机安全系数 K', P_shaft < 15 ? 'P<15kW→1.25' : P_shaft < 55 ? '15≤P<55kW→1.15' : 'P≥55kW→1.10', K, '', '手册第14.6.2节'))
  rows.push(stepRow('电机功率 P_motor', overrideMotor ? `覆盖值 = ${overrideMotor}` : `P_shaft × K = ${fmt(P_shaft)} × ${K} =`, fmt(P_motor, 2), 'kW'))

  // ── 效率验证 ──────────────────────────────────────────────
  rows.push(stepRow('═══════════ 效率验证 ═══════════', '', '', ''))
  const η_hyd_ok = η_hyd >= 0.75
  const η_mot_ok = η_mot >= 0.85
  const η_combined_ok = η_combined >= 0.64

  rows.push(stepRow('水力效率验证', `η_hyd = ${η_hyd} ≥ 0.75`, η_hyd_ok ? '✓ 满足' : '✗ 不满足', '', '手册第14.6节'))
  rows.push(stepRow('电机效率验证', `η_mot = ${η_mot} ≥ 0.85`, η_mot_ok ? '✓ 满足' : '✗ 不满足', '', '手册第14.6节'))
  rows.push(stepRow('综合效率验证', `η_combined = ${fmt(η_combined)} ≥ 0.76`, η_combined_ok ? '✓ 满足' : '✗ 不满足', '', '手册第14.6节'))

  // ── NPSH 校验 ─────────────────────────────────────────────

  const H_s = 2.0  // 典型淹没深度（m），大型轴流泵通常需要≥2m
  const NPSH_a = 10.33 - 0.5 + H_s - 0.2  // 简化计算
  const NPSH_ok = NPSH_a >= NPSH_r + 0.5

  rows.push(stepRow('═══════════ NPSH校验 ═══════════', '', '', ''))
  rows.push(stepRow('必需汽蚀余量 NPSH_r', '高级设置，惯例 3~5 m', NPSH_r, 'm'))
  rows.push(stepRow('有效汽蚀余量 NPSH_a', `10.33-0.5+H_s-0.2 =`, fmt(NPSH_a, 2), 'm', '手册第14.2.3节'))
  rows.push(stepRow('NPSH安全余量要求', 'NPSH_a ≥ NPSH_r + 0.5', NPSH_ok ? '✓ 满足' : '✗ 不满足', ''))

  if (!NPSH_ok) warnings.push(`NPSH校验不通过：NPSH_a(${fmt(NPSH_a)}) < NPSH_r+0.5(${fmt(NPSH_r+0.5)})`)

  // ── 泵型目录匹配 ──────────────────────────────────────────
  const Q_pump_ls = Q_pump * 1000
  const catalogMatches = findMatchingPumps(Q_pump_ls, H_total)
  const catalogMatchesTolerant = catalogMatches.length === 0
    ? findMatchingPumps(Q_pump_ls, H_total, 0.03)
    : []
  const catalogIsTolerant = catalogMatches.length === 0 && catalogMatchesTolerant.length > 0

  // ── 泵安装尺寸（a×b×h）及泵出口 DN────────────────────
  const displayMatches = catalogMatches.length > 0 ? catalogMatches : catalogMatchesTolerant

  // ── 诊断：列出所有泵的未匹配原因 ────────────────────────
  const catalogDiagnosis = displayMatches.length === 0
    ? diagnosePumpMisses(Q_pump_ls, H_total)
    : []
  if (displayMatches.length > 0) {
    rows.push(stepRow('═══════════ 泵安装尺寸 ═══════════', '', '', ''))
    for (const match of displayMatches) {
      const { pump } = match
      const { dimensions_mm } = pump
      const h_total = (dimensions_mm.h1 || 0) + (dimensions_mm.h2 || 0)
      rows.push(stepRow(
        `${pump.series} ${pump.model.split(' ').pop()}`,
        `a×b×h`,
        `${dimensions_mm.a}×${dimensions_mm.b}×${h_total}`,
        'mm'
      ))
    }
  }

  // ── 泵出水弯头 DN（来自资料库）──────────────────────────
  const DN_pump_outlet = displayMatches.length > 0
    ? (displayMatches[0].pump.dimensions_mm?.outletBend_DN ?? null)
    : null
  if (DN_pump_outlet != null) {
    rows.push(stepRow('泵出水弯头公称直径', '来自泵资料库', `DN${DN_pump_outlet}`, 'mm'))
  }

  // ── 输出结果 ──────────────────────────────────────────────

  return {
    // 计算状态
    valid: true,
    errors: [],
    warnings,
    // 流量参数
    Q_pump,
    // 扬程参数
    H_static, H_pipe_loss, H_total,
    // 功率参数
    η_hyd, η_mot, η_combined, P_shaft, K, P_motor,
    // 校验
    NPSH_r, NPSH_a, NPSH_ok, H_s,
    // 设计参数（带依据标注）
    designParams: {
      Z_discharge: { value: Z_discharge, unit: 'mPD',   ref: '排放口标高' },
      η_hyd:       { value: η_hyd,       unit: '',      ref: '手册第14.6节≥0.82' },
      η_mot:       { value: η_mot,       unit: '',      ref: '手册第14.6节≥0.93' },
      NPSH_r:      { value: NPSH_r,      unit: 'm',     ref: '工程惯例' },
      H_pipe_loss: { value: H_pipe_loss, unit: 'm',     ref: '含沿程+局部损失' },
    },
    // 泵型目录匹配结果
    Q_pump_ls,
    catalogMatches,
    catalogMatchesTolerant,
    catalogIsTolerant,
    displayMatches,
    catalogDiagnosis,
    // 泵出口 DN（来自资料库）
    DN_pump_outlet,
    // 输出给下游
    rows,
  }
}
