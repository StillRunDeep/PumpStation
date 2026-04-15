import { ceilTo01, fmt, stepRow } from '../utils.js'
import {
  GATE_VALVE_FF, CHECK_VALVE_FF,
  elbowCTF, reducerL, flowmeterBodyL, lookupFF,
  SPACE_RULES_DEFAULT,
} from '../data/fitting-dims.js'

/**
 * AG2-1：泵房维护间尺寸计算
 *
 * 可选接收 catalogPump（含 dimensions_mm）以使用实际泵尺寸；
 * 否则使用固定默认值（0.6×0.8 m）。
 *
 * @param {number} N - 工作泵台数
 * @param {number} [motorPower] - **废弃参数**，仅保留以避免 break。电机功率不再用于推算间距
 * @param {number} N_spare - 备用泵台数，默认 0
 * @param {object} options - { catalogPump, DN_branch, DN_main, d_spacing, e_wall, spaceRules }
 * @param {number} options.d_spacing - 泵间净距（m），直接输入（默认 1.0 m）
 * @param {number} options.e_wall - 端部距墙净距（m），直接输入（默认 0.8 m）
 * @param {object} options.spaceRules - { pipeToWall_mm, pipeToPipe_mm, minStraight_mm }
 *
 * **间距规则说明**：本项目遵循 DSD 渠务署香港规范。d_spacing/e_wall 由调用侧直接提供，
 * GB 50265-2022 §7 功率→间距规则仅作技术参考。
 */
export function runMaintenanceRoom(N, motorPower, N_spare = 0, options = {}) {
  const {
    catalogPump = null,
    DN_branch = 150,
    DN_main = 300,
    d_spacing = 1.0,
    e_wall = 0.8,
    spaceRules = SPACE_RULES_DEFAULT,
  } = options

  const N_total   = N + N_spare

  // ── 泵外形尺寸 ─────────────────────────────────────────────────
  const hasCatalogDims = catalogPump?.pump?.dimensions_mm != null
  let w_pump, d_pump  // m，沿排列方向 / 沿通道方向
  if (hasCatalogDims) {
    const dim = catalogPump.pump.dimensions_mm
    w_pump = dim.b / 1000  // b = 沿排列方向
    d_pump = dim.a / 1000  // a = 沿通道方向
  } else {
    w_pump = 0.6
    d_pump = 0.8
  }

  // ── 房间净长 L（与原逻辑一致）────────────────────────────────
  const L_raw = N_total * w_pump + (N_total - 1) * d_spacing + 2 * e_wall
  const L     = ceilTo01(L_raw)

  // ── 房间净宽 W（新方法：沿通道方向逐项累加）────────────────
  // 解析 spaceRules（单位：mm → m）
  const {
    pipeToWall_mm = SPACE_RULES_DEFAULT.pipeToWall_mm,
    pipeToPipe_mm = SPACE_RULES_DEFAULT.pipeToPipe_mm,
    minStraight_mm = SPACE_RULES_DEFAULT.minStraight_mm,
  } = spaceRules

  // 管件面对面长度（m）
  const L_cv  = lookupFF(CHECK_VALVE_FF, DN_branch) / 1000
  const L_gv  = lookupFF(GATE_VALVE_FF, DN_branch) / 1000
  const L_str = Math.max(minStraight_mm, 2 * DN_branch) / 1000  // 阀件间直管段，取 2D 与配置值中的大值
  const c_wall_m = (pipeToWall_mm + DN_branch / 2) / 1000       // 管中心离集水坑墙
  const L_elbow_m = elbowCTF(DN_branch) / 1000                   // 弯头水平投影

  // 支路管道总长度：从集水坑墙内壁到总管中心
  const W_pipe = c_wall_m + L_elbow_m + L_str + L_cv + L_str + L_gv
    + (pipeToPipe_mm + DN_branch / 2 + DN_main / 2) / 1000  // 至总管中心
    + (pipeToWall_mm + DN_main / 2) / 1000                    // 总管到远侧墙

  // 传统 W 计算（下限）
  const W_equip = d_pump + 0.5
  const W_legacy = Math.max(1.2, W_equip) + 0.3

  const W = Math.max(2.5, ceilTo01(Math.max(W_pipe, W_legacy)))

  // ── W 逐项明细 ─────────────────────────────────────────────────
  const W_breakdown = [
    { label: '管外壁到墙面净距', val: pipeToWall_mm, unit: 'mm' },
    { label: '弯头（1.5×DN）', val: elbowCTF(DN_branch), unit: 'mm' },
    { label: '阀件间直管段（max(2D,minStraight)）', val: Math.max(2 * DN_branch, minStraight_mm), unit: 'mm' },
    { label: '止回阀面对面', val: lookupFF(CHECK_VALVE_FF, DN_branch), unit: 'mm' },
    { label: '闸阀面对面', val: lookupFF(GATE_VALVE_FF, DN_branch), unit: 'mm' },
    { label: '相邻管外壁间净距', val: pipeToPipe_mm, unit: 'mm' },
    { label: '总管外壁到远侧墙', val: pipeToWall_mm + DN_main, unit: 'mm' },
  ]

  // ── 集水坑管件说明（不影响 W，影响集水坑深度）───────────────
  const hasReducer = DN_branch !== DN_main
  const sumpFittings = {
    elbow_vert_mm: elbowCTF(DN_branch),  // 弯头竖向占位
    reducer_mm: hasReducer ? reducerL(DN_main, DN_branch) : 0,
    notes: hasCatalogDims
      ? [`泵外形：${catalogPump.pump.dimensions_mm.a}×${catalogPump.pump.dimensions_mm.b} mm（实际目录值）`]
      : ['泵外形：0.6×0.8 m（通用估算值）'],
  }
  if (hasReducer) {
    sumpFittings.notes.push(`变径：DN${DN_main}→DN${DN_branch}，长度约 ${reducerL(DN_main, DN_branch)} mm`)
  }

  // ── 构建 rows（计算过程）──────────────────────────────────────
  const rows = []
  rows.push(stepRow('═══════════ 泵外形尺寸 ═══════════', '', '', ''))
  if (hasCatalogDims) {
    const dim = catalogPump.pump.dimensions_mm
    rows.push(stepRow('单泵外形宽度 w_pump', 'catalogPump.dimensions_mm.b / 1000', fmt(dim.b / 1000, 2), 'm', '来自泵目录'))
    rows.push(stepRow('单泵外形深度 d_pump', 'catalogPump.dimensions_mm.a / 1000', fmt(dim.a / 1000, 2), 'm', '来自泵目录'))
  } else {
    rows.push(stepRow('单泵外形宽度 w_pump', '通用默认值', fmt(w_pump, 1), 'm'))
    rows.push(stepRow('单泵外形深度 d_pump', '通用默认值', fmt(d_pump, 1), 'm'))
  }

  rows.push(stepRow('═══════════ 维护间净长 ═══════════', '', '', ''))
  rows.push(stepRow('总布置台数（含备用泵）', `工作泵 ${N} 台 + 备用泵 ${N_spare} 台 =`, `${N_total} 台`, ''))
  rows.push(stepRow('维护间净长 L', `N_total×w + (N_total-1)×d + 2×e = ${N_total}×${fmt(w_pump, 1)}+${N_total - 1}×${fmt(d_spacing, 1)}+2×${fmt(e_wall, 1)} =`, `${fmt(L_raw, 2)} → ${fmt(L, 1)}`, 'm'))

  rows.push(stepRow('═══════════ 维护间净宽 ═══════════', '', '', ''))
  rows.push(stepRow('支管 DN_branch', '', `${DN_branch}`, 'mm'))
  rows.push(stepRow('主管 DN_main', '', `${DN_main}`, 'mm'))
  rows.push(stepRow('阀件间最小直管段', 'max(2×DN, minStraight)', `${Math.max(2 * DN_branch, minStraight_mm)}`, 'mm'))
  rows.push(stepRow('W_pipe（管件空间累加）', `c_wall + L_elbow + L_str + L_cv + L_str + L_gv + 间隔 + 总管余量 =`, fmt(W_pipe, 3), 'm'))
  rows.push(stepRow('通道净宽 W_equip', `d_pump + 0.5 = ${fmt(d_pump, 1)} + 0.5 =`, fmt(W_equip, 1), 'm'))
  rows.push(stepRow('维护间净宽 W', `max(2.5, max(W_pipe, W_legacy)) =`, fmt(W, 1), 'm'))

  return {
    w_pump, d_pump, d_spacing, e_wall, L, W, N_total,
    // 扩展字段（Step 2 新增）
    W_pipe, W_breakdown, sumpFittings,
    hasCatalogDims, DN_branch, DN_main,
    c_wall_m: c_wall_m, L_elbow_m: L_elbow_m,
    rows,
  }
}