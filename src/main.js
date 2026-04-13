import './style.css'

import { runUserParams } from './agents/user-params.js'
import { runTopology } from './agents/topology.js'
import { runPoolDepth } from './agents/pool-depth.js'
import { runMaintenanceRoom } from './agents/maintenance-room.js'
import { runPumpSpec } from './agents/pump-spec.js'
import { runPipeSizing, PIPE_SCHEMES } from './agents/pipe-sizing.js'
import { runDrawing } from './agents/drawing.js'
import { runAG41 } from './agents/ag41-building-layout.js'
import { runAG42, mergeVariants } from './agents/ag42-layout-eval.js'
import { renderAG00, renderAG01, renderPoolDepth, renderPipeSizing, renderMaintenanceRoom, renderPumpSpec, renderRainfallCard, renderSchemeOptions } from './ui/results-panel.js'
import { renderLayoutPanel, getVariants, showAg41Notify } from './ui/layout-panel.js'
import { renderBuildingParamsPanel } from './ui/building-params-panel.js'
import { getDefaultUserParams } from './layout/user-params.js'
import { initTopologyEditor, setTopologyFromN, getCurrentTopology } from './ui/topology-editor.js'

let _lastTopoN     = null
let _lastTopoSpare = 0

// ── 模块缓存与卡片预填 ────────────────────────────────────────────

const moduleCache = { ag00: null, ag01: null, ag11: null, ag12: null, ag13: null, ag21: null }

let currentSchemeId = 2  // 默认"稳健节能型"

const getVal = id => document.getElementById(id)?.value ?? ''
const setVal = (id, v) => { const el = document.getElementById(id); if (el && v !== '') el.value = v }

function prefillCardInputs() {
  // AG1-1 预填
  setVal('pool-V-design',   getVal('inp-V-design'))
  setVal('pool-D',          getVal('inp-D'))
  setVal('pool-A-base',    getVal('inp-A-base'))
  setVal('pool-N',         getVal('inp-N'))
  setVal('pool-Z',         getVal('inp-Z'))
  setVal('pool-Z-bottom',  getVal('inp-z-bottom'))
  setVal('pool-Fb',        getVal('inp-Fb'))
  setVal('pool-Fs',        getVal('inp-Fs'))
  setVal('pool-Z-sump',    getVal('inp-Z-sump'))
  setVal('pool-S-wall',    getVal('inp-S-wall'))

  // AG1-2 预填
  setVal('pump-Z-discharge', getVal('inp-z-discharge'))
  setVal('pump-eta-hyd',   getVal('inp-eta-hyd'))
  setVal('pump-eta-mot',   getVal('inp-eta-mot'))
  setVal('pump-npsh-r',    getVal('inp-npsh-r'))

  // AG1-3 预填（流速由方案滑块控制，不再用 inp-v-out）
  setVal('pipe-N',         getVal('inp-N'))
  setVal('pipe-n',         getVal('inp-n'))
  setVal('pipe-len',       getVal('inp-pipe-len'))
  setVal('pipe-npsh-r',    getVal('inp-npsh-r'))

  // AG2-1 预填
  setVal('room-N',      getVal('inp-N'))
  setVal('room-N-spare', getVal('inp-N-spare'))

  // 暴雨分析卡片预填（从高级设置 Tab2 复制）
  setVal('rainfall-zone',        getVal('inp-zone'))
  setVal('rainfall-td',          getVal('inp-td'))
  setVal('rainfall-area',        getVal('inp-A'))
  setVal('rainfall-runoff-c',    getVal('inp-C'))
  setVal('rainfall-climate-adj', getVal('inp-delta-i'))
  setVal('rainfall-slope',       getVal('inp-H'))
  setVal('rainfall-flow-path',   getVal('inp-L'))
}

// ── 独立模块重算函数 ──────────────────────────────────────────────

function recalcRainfall() {
  const zone       = document.getElementById('rainfall-zone')?.value || ''
  const t_d        = parseFloat(document.getElementById('rainfall-td').value)
  const catchArea  = parseFloat(document.getElementById('rainfall-area').value)
  const runoffC    = parseFloat(document.getElementById('rainfall-runoff-c').value)
  const climateAdj = parseFloat(document.getElementById('rainfall-climate-adj').value) || 0
  const slope      = parseFloat(document.getElementById('rainfall-slope').value) || 1.0
  const flowPath   = parseFloat(document.getElementById('rainfall-flow-path').value) || 500

  // 公共结构参数（从基础参数表单读取，用于 runUserParams 校验）
  const N          = parseInt(getVal('inp-N'), 10) || 2
  const N_spare    = parseInt(getVal('inp-N-spare'), 10) || 0
  const Z          = parseInt(getVal('inp-Z'), 10) || 8
  const Z_bottom   = parseFloat(getVal('inp-z-bottom'))
  const D          = parseFloat(getVal('inp-D'))
  const Z_discharge= parseFloat(getVal('inp-z-discharge'))
  const Z_sump     = parseFloat(getVal('inp-Z-sump'))

  const baseParams = {
    N, N_spare, Z, Z_bottom, D, Z_discharge, Z_sump,
    zone, t_d, A: catchArea, C: runoffC,
    delta_i: climateAdj, H: slope, L: flowPath
  }

  // 计算 T=10 / 50 / 200 三个标准重现期
  const duty10Year   = runUserParams({ ...baseParams, T: 10 })
  const capacity50   = runUserParams({ ...baseParams, T: 50 })
  const floodCheck200= runUserParams({ ...baseParams, T: 200 })

  // 拓扑解析（保持现有功能不变）
  const topoResult = runTopology(getCurrentTopology())

  const rainfallResult = {
    duty10Year, capacity50, floodCheck200,
    topo: topoResult,
    valid: duty10Year.valid && topoResult.valid
  }
  moduleCache.ag01 = rainfallResult

  document.getElementById('card-rainfall').innerHTML =
    renderRainfallCard({ duty10Year, capacity50, floodCheck200 })

  // 将 T=10 年值班泵流量写入水池计算卡片的已知条件
  if (duty10Year.valid && duty10Year.Q_pump != null) {
    setVal('pool-Q-pump', duty10Year.Q_pump)
  }

  return rainfallResult
}

function runFromRainfall() {
  recalcRainfall()
  const ag01Topo = runTopology(getCurrentTopology())
  document.getElementById('card-ag01').innerHTML = renderAG01(ag01Topo)
  recalcAG11()
  recalcAG12()
  recalcAG13()
  recalcAG21()
}

function recalcAG11() {
  const Q_pump   = parseFloat(document.getElementById('pool-Q-pump').value)
  const V_design = parseFloat(document.getElementById('pool-V-design').value)
  const D        = (() => { const v = parseFloat(document.getElementById('pool-D').value); return isNaN(v) ? null : v; })()
  const A_base   = (() => { const v = parseFloat(document.getElementById('pool-A-base').value); return isNaN(v) ? null : v; })()
  const N        = parseInt(document.getElementById('pool-N').value, 10)
  const Z        = parseInt(document.getElementById('pool-Z').value, 10)
  const Z_bottom = parseFloat(document.getElementById('pool-Z-bottom').value)
  const F_b      = parseFloat(document.getElementById('pool-Fb').value) || 1.3
  const F_s      = parseFloat(document.getElementById('pool-Fs').value) || 0.5

  if (isNaN(Q_pump)) {
    document.getElementById('card-ag11').innerHTML =
      '<p class="msg-error">⚠ 缺少 Q_pump：请填写或先运行 AG0-0。</p>'
    return null
  }
  const result = runPoolDepth({ V_design, Z_bottom, D, A_base, N, Z, Q_pump, F_b, F_s })
  moduleCache.ag11 = result
  document.getElementById('card-ag11').innerHTML = renderPoolDepth(result)
  // 自动写入下游卡片字段
  if (result.valid) {
    setVal('pump-Z-stop', result.Z_stop)
    setVal('pump-Q-pump', Q_pump)
  }
  return result
}

function recalcAG12() {
  const Z_stop  = parseFloat(document.getElementById('pump-Z-stop').value)
  const Q_pump  = parseFloat(document.getElementById('pump-Q-pump').value)
  const motor_o = parseFloat(document.getElementById('pump-motor').value)
  const Z_discharge = parseFloat(document.getElementById('pump-Z-discharge').value)
  const η_hyd   = parseFloat(document.getElementById('pump-eta-hyd').value) ?? 0.75
  const η_mot   = parseFloat(document.getElementById('pump-eta-mot').value) ?? 0.85
  const NPSH_r  = parseFloat(document.getElementById('pump-npsh-r').value) ?? 3.0
  const H_pipe_loss = parseFloat(document.getElementById('pump-H-pipe-loss').value) ?? 0

  if (isNaN(Z_stop) || isNaN(Q_pump)) {
    document.getElementById('card-ag12').innerHTML =
      '<p class="msg-error">⚠ 缺少必要参数：请填写 Z_stop 和 Q_pump，或先运行上游模块。</p>'
    return null
  }
  // Q_single = Q_pump (m³/s) × 3600 = m³/h
  const Q_single = Q_pump * 3600
  const result = runPumpSpec({ Q_single, Z_stop, Z_discharge, η_hyd, η_mot, NPSH_r, H_pipe_loss }, isNaN(motor_o) ? null : motor_o)
  moduleCache.ag12 = result
  document.getElementById('card-ag12').innerHTML = renderPumpSpec(result)
  // 自动写入下游卡片字段
  if (result.valid) {
    setVal('pipe-H-total', result.H_total)
    setVal('pipe-Q-pump',  Q_pump)
    setVal('pipe-Z-stop',  Z_stop)
    setVal('room-motor',   result.P_motor)
    setVal('pipe-pump-outlet-dn', result.DN_pump_outlet ?? '')
  }
  return result
}

function recalcAG13() {
  const H_total = parseFloat(document.getElementById('pipe-H-total').value)
  const Q_pump  = parseFloat(document.getElementById('pipe-Q-pump').value)
  const Q_total = parseFloat(document.getElementById('pipe-Q-total').value)
  const N       = parseInt(document.getElementById('pipe-N').value, 10)
  const Z_stop  = parseFloat(document.getElementById('pipe-Z-stop').value)
  const n       = parseFloat(document.getElementById('pipe-n').value) || 0.013
  const k_local = parseFloat(document.getElementById('pipe-k-local').value) || 0.15
  const NPSH_r  = parseFloat(document.getElementById('pipe-npsh-r').value) || 3.0
  const L       = parseFloat(document.getElementById('pipe-len').value) || 50
  const DN_pump_outlet_raw = parseFloat(document.getElementById('pipe-pump-outlet-dn').value)
  const DN_pump_outlet = isNaN(DN_pump_outlet_raw) ? null : DN_pump_outlet_raw

  if (isNaN(H_total) || isNaN(Q_pump)) {
    document.getElementById('card-ag13').innerHTML =
      '<p class="msg-error">⚠ 缺少必要参数：请填写 H_total 和 Q_pump，或先运行上游模块。</p>'
    return null
  }
  // 从方案常量取流速覆盖值
  const scheme = PIPE_SCHEMES.find(s => s.id === currentSchemeId) ?? PIPE_SCHEMES[1]

  // H_s 来自 AG1-2，固定值 2.0m
  const result = runPipeSizing({
    Q_pump, Q: Q_total || Q_pump * 3600, N: N || 2,
    H_total, Z_stop: Z_stop || 0, H_s: 2.0,
    v_pumpOut: scheme.v_pumpOut,
    v_mainOut: scheme.v_mainOut,
    n, k_local, NPSH_r, L,
    schemeId: currentSchemeId,
  })
  moduleCache.ag13 = result
  document.getElementById('card-ag13').innerHTML = renderPipeSizing(result)
  return result
}

function handleSchemeChange(id) {
  currentSchemeId = id
  document.getElementById('scheme-slider').value = id
  recalcAG13()
  // AG2-1 和 AG3-1 的重绘（不重跑泵选型）
  recalcAG21()
  const ag00Result = moduleCache.ag00
  const ag1Result  = moduleCache.ag11
  const ag2Result  = moduleCache.ag12
  if (ag00Result?.valid && ag2Result?.valid && ag1Result) {
    const ag21 = runMaintenanceRoom(ag00Result.N, ag2Result.P_motor, ag00Result.N_spare)
    ag21.DN_label = ag2Result.DN_outlet
    document.getElementById('card-ag21').innerHTML = renderMaintenanceRoom(ag21)
    const ag31Params = {
      h_active:    ag1Result.Z_max - ag1Result.Z_stop,
      Z_stop:      ag1Result.Z_stop,
      Z_start1:    ag1Result.Z_start1,
      Z_alarm_high: ag1Result.Z_alarm_high,
    }
    const ag13 = moduleCache.ag13
    const baseTopo = ag00Result.topo?.topology
    const enrichedTopo = (baseTopo && ag2Result != null) ? {
      ...baseTopo,
      devices: baseTopo.devices.map(d => {
        if (d.type !== 'pump') return d
        const outletReducer = ag13?.reducerType !== undefined
          ? (ag13.reducerType === null
              ? null
              : { type: ag13.reducerType, fromDN: ag2Result.DN_pump_outlet, toDN: ag13.DN_pumpOut })
          : undefined
        return { ...d, outletReducer }
      })
    } : baseTopo
    runDrawing(ag00Result.N, ag21, ag31Params, ag1Result.S, enrichedTopo)
  }
  // 同步更新方案卡 UI
  document.getElementById('scheme-options').innerHTML = renderSchemeOptions(currentSchemeId)
}

// 暴露到全局作用域，供 HTML 内联事件处理器调用
window.handleSchemeChange = handleSchemeChange

function recalcAG21() {
  const N         = parseInt(document.getElementById('room-N').value, 10)
  const motorPower = parseFloat(document.getElementById('room-motor').value)
  const N_spare  = parseInt(document.getElementById('room-N-spare').value, 10) || 0

  if (isNaN(N) || isNaN(motorPower)) {
    document.getElementById('card-ag21').innerHTML =
      '<p class="msg-error">⚠ 缺少必要参数：请填写工作泵台数和电机功率。</p>'
    return null
  }
  const result = runMaintenanceRoom(N, motorPower, N_spare)
  moduleCache.ag21 = result
  document.getElementById('card-ag21').innerHTML = renderMaintenanceRoom(result)
  return result
}

// ── 下游链式函数 ──────────────────────────────────────────────────

function runFromAG11() { recalcAG11(); recalcAG12(); recalcAG13(); recalcAG21(); }
function runFromAG12() { recalcAG12(); recalcAG13(); recalcAG21(); }
function runFromAG13() { recalcAG13(); recalcAG21(); }
function runFromAG21() { recalcAG21(); }

// ── AG4-1 parameter helpers ───────────────────────────────────────────


/**
 * Auto-fill the repair_zone area hint from AG1-2 output.
 * The repair zone should be at least L × W from the maintenance-room calc.
 */
function updateRepairZoneHint(ag21) {
  const noteEl = document.getElementById('ra-repair-note')
  const inputEl = document.getElementById('ra-repair')
  if (!noteEl || !inputEl) return

  const area = Math.ceil(ag21.L * ag21.W)  // m²
  noteEl.innerHTML =
    `继承自 AG2-1：维护间净长 <strong>${ag21.L.toFixed(1)} m</strong> × ` +
    `净宽 <strong>${ag21.W.toFixed(1)} m</strong> ≈ <strong>${area} m²</strong>。` +
    `当前输入值为用户指定值；留空则使用比例算法默认值。`

  // Only auto-fill if the user hasn't entered a value
  if (!inputEl.value) {
    inputEl.placeholder = `≈ ${area}（AG2-1）`
  }
}

// ── Main calculation controller ───────────────────────────────────────

async function runCalculation() {
  // ── 预填卡片「已知条件」──────────────────────────────────────
  prefillCardInputs()

  // ── AG0-0: 参数解析与计算 ────────────────────────────────────
  const ag00Params = {
    // 直接输入模式参数
    Q_total:    parseFloat(document.getElementById('inp-Q-total').value),
    N:          parseInt(document.getElementById('inp-N').value, 10),
    N_spare:    parseInt(document.getElementById('inp-N-spare').value, 10) || 0,
    Z:          parseInt(document.getElementById('inp-Z').value, 10) || 8,
    V_design:   parseFloat(document.getElementById('inp-V-design').value),
    Z_bottom:   parseFloat(document.getElementById('inp-z-bottom').value),
    Z_sump:     parseFloat(document.getElementById('inp-Z-sump').value),
    D:          parseFloat(document.getElementById('inp-D').value),
    Z_discharge: parseFloat(document.getElementById('inp-z-discharge').value),
    // 暴雨分析模式参数（当Q_total为空时使用）
    zone:       document.getElementById('inp-zone').value,
    T:          parseInt(document.getElementById('inp-T').value, 10),
    t_d:        parseFloat(document.getElementById('inp-td').value),
    A:          parseFloat(document.getElementById('inp-A').value),
    C:          parseFloat(document.getElementById('inp-C').value),
    delta_i:    parseFloat(document.getElementById('inp-delta-i').value) || 0,
    H:          parseFloat(document.getElementById('inp-H').value) || 1.0,
    L:          parseFloat(document.getElementById('inp-L').value) || 500,
  }

  // AG0-0: 参数验证（保留，用于获取 mode、N 等下游参数）
  const ag00 = runUserParams(ag00Params)

  const panel = document.getElementById('results-panel')
  panel.hidden = false

  // AG0-1: 若 N 或 N_spare 变化则重置默认拓扑
  const N_spare = parseInt(document.getElementById('inp-N-spare').value, 10) || 0
  if (ag00Params.N !== _lastTopoN || N_spare !== _lastTopoSpare) {
    setTopologyFromN(ag00Params.N, N_spare)
    _lastTopoN     = ag00Params.N
    _lastTopoSpare = N_spare
  }

  // AG0-0: 暴雨计算（已知条件在卡片内，输出到 card-rainfall）
  const ag00Result = recalcRainfall()

  // AG0-1: 拓扑解析（单独调用，输出到 card-ag01）
  const ag01Topo = runTopology(getCurrentTopology())
  document.getElementById('card-ag01').innerHTML = renderAG01(ag01Topo)

  if (!ag00.valid) {
    ;['card-ag11', 'card-ag12', 'card-ag13', 'card-ag21'].forEach(id => {
      document.getElementById(id).innerHTML =
        '<p style="color:#999;padding:8px">参数验证未通过，无法计算。</p>'
    })
    document.getElementById('card-ag41-wrap').hidden = true
    panel.scrollIntoView({ behavior: 'smooth' })
    return
  }

  // ── 同步 AG0-0 结果到卡片字段 ────────────────────────────────
  // 将 Q_pump 写入 AG1-1 的已知条件（暴雨模式由 recalcRainfall 写入，此处仅直接模式）
  if (ag00.mode === 'direct') {
    setVal('pool-Q-pump', ag00.Q_pump)
  }
  // 同时填入 AG1-3 的总流量
  const totalFlow = ag00.mode === 'direct'
    ? (ag00.Q_total * 3600)
    : (ag00.Q || ag00.Q_total * 3600)
  setVal('pipe-Q-total', totalFlow)

  // ── AG1-1: 污水池计算（使用卡片字段重算）──────────────────────
  const ag1Result = recalcAG11()
  if (!ag1Result || !ag1Result.valid) {
    ;['card-ag12', 'card-ag13', 'card-ag21'].forEach(id => {
      document.getElementById(id).innerHTML =
        '<p style="color:#999;padding:8px">上游计算未通过，无法继续。</p>'
    })
    document.getElementById('card-ag41-wrap').hidden = true
    panel.scrollIntoView({ behavior: 'smooth' })
    return
  }

  // ── AG1-2: 水泵计算及选型（使用卡片字段重算）────────────────────
  // 处理顶部覆盖参数
  const Z_stop_override = (() => { const v = parseFloat(document.getElementById('inp-Z-stop-override').value); return isNaN(v) ? null : v; })()
  if (Z_stop_override !== null) {
    setVal('pump-Z-stop', Z_stop_override)
  }
  const motorOverride = parseFloat(document.getElementById('inp-motor').value)
  if (!isNaN(motorOverride)) {
    setVal('pump-motor', motorOverride)
  }
  const ag2Result = recalcAG12()
  if (!ag2Result || !ag2Result.valid) {
    ;['card-ag13', 'card-ag21'].forEach(id => {
      document.getElementById(id).innerHTML =
        '<p style="color:#999;padding:8px">上游计算未通过，无法继续。</p>'
    })
    document.getElementById('card-ag41-wrap').hidden = true
    panel.scrollIntoView({ behavior: 'smooth' })
    return
  }

  // ── AG1-3: 管道尺寸计算（使用卡片字段重算）─────────────────────
  const H_total_override = (() => { const v = parseFloat(document.getElementById('inp-H-total-override').value); return isNaN(v) ? null : v; })()
  if (H_total_override !== null) {
    setVal('pipe-H-total', H_total_override)
  }
  recalcAG13()

  // ── AG2-1: 泵房维护间尺寸计算 ─────────────────────────────────────────
  const effectiveMotor = isNaN(motorOverride) ? ag2Result.P_motor : motorOverride
  const ag21 = runMaintenanceRoom(ag00.N, effectiveMotor, N_spare)
  ag21.DN_label = (moduleCache.ag13 && moduleCache.ag13.DN_pumpOut) || ag2Result.DN_outlet
  document.getElementById('card-ag21').innerHTML = renderMaintenanceRoom(ag21)

  // ── AG3-1: SVG绘图 ───────────────────────────────────────────────
  // AG3-1 期望从第三个参数解构 h_active, Z_stop, Z_start1, Z_alarm_high
  // 这些全部来自 AG1-1（调蓄池计算），其中 h_active = Z_max - Z_stop
  const ag31Params = {
    h_active:   ag1Result.Z_max - ag1Result.Z_stop,  // 有效水深
    Z_stop:     ag1Result.Z_stop,
    Z_start1:   ag1Result.Z_start1,
    Z_alarm_high: ag1Result.Z_alarm_high,
  }
  // ── AG3-1: SVG绘图（拓扑数据富化）─────────────────────────────
  // 用 AG1-3 的变径结果富化拓扑中的 pump 节点
  const ag12 = moduleCache.ag12
  const ag13 = moduleCache.ag13
  const baseTopo = ag00Result.topo.topology

  const enrichedTopo = (baseTopo && ag12 != null) ? {
    ...baseTopo,
    devices: baseTopo.devices.map(d => {
      if (d.type !== 'pump') return d
      const outletReducer = ag13?.reducerType !== undefined
        ? (ag13.reducerType === null
            ? null
            : { type: ag13.reducerType, fromDN: ag12.DN_pump_outlet, toDN: ag13.DN_pumpOut })
        : undefined
      return { ...d, outletReducer }
    })
  } : baseTopo

  runDrawing(ag00.N, ag21, ag31Params, ag1Result.S, enrichedTopo)

  // Update repair_zone hint from AG2-1 before reading AG4-1 params
  updateRepairZoneHint(ag21)

  // ── AG4-1/AG4-2: 布局生成与评分 ─────────────────────────────────
  const ag41Variants = await runAG41()
  const ag42Variants = runAG42(ag41Variants)
  renderLayoutPanel(ag42Variants)

  panel.scrollIntoView({ behavior: 'smooth' })
}

// ── Event wiring ──────────────────────────────────────────────────────

// ── 初始化 AG0-1 拓扑编辑器 ──────────────────────────────────────────
const _initN = parseInt(document.getElementById('inp-N').value, 10) || 2
initTopologyEditor('topology-editor-wrap', () => {})
setTopologyFromN(_initN)
_lastTopoN = _initN

// 初始化方案选项卡
document.getElementById('scheme-options').innerHTML = renderSchemeOptions(currentSchemeId)

function _updateTopo() {
  const N       = parseInt(document.getElementById('inp-N').value, 10)
  const N_spare = parseInt(document.getElementById('inp-N-spare').value, 10) || 0
  if (N >= 1 && N <= 6 && (N !== _lastTopoN || N_spare !== _lastTopoSpare)) {
    setTopologyFromN(N, N_spare)
    _lastTopoN     = N
    _lastTopoSpare = N_spare
  }
}

document.getElementById('inp-N').addEventListener('input', _updateTopo)
document.getElementById('inp-N-spare').addEventListener('input', _updateTopo)

document.getElementById('btn-calc').addEventListener('click', runCalculation)

let isGeneratingLayouts = false;
let generationReqId = null;

document.getElementById('btn-ag41-more').addEventListener('click', () => {
  const btn = document.getElementById('btn-ag41-more');

  if (isGeneratingLayouts) {
    // Stop generation
    isGeneratingLayouts = false;
    if (generationReqId) {
      cancelAnimationFrame(generationReqId);
      generationReqId = null;
    }
    btn.textContent = '生成方案';
    showAg41Notify('已停止持续生成', false);
  } else {
    // Start generation
    isGeneratingLayouts = true;
    btn.textContent = '停止';

    const generationLoop = async () => {
      if (!isGeneratingLayouts) return;

      try {
        const newRaw = await runAG41();
        const { variants, improved, newScored } = mergeVariants(getVariants(), newRaw);
        renderLayoutPanel(variants);

        const maxNewScore = Math.max(...newScored.map(v => v.score));
        const currentTopScore = variants[0]?.score || 0;

        if (improved) {
          showAg41Notify(`发现更优方案，排名已更新！新方案最高分: ${maxNewScore}`, true);
        } else {
          showAg41Notify(`未发现更优方案 (当前最高: ${currentTopScore} / 本轮最高: ${maxNewScore})`, false);
        }
      } catch (error) {
        console.error("Error during layout generation loop:", error);
        showAg41Notify('生成新方案时出错', false);
        // Stop the loop on error
        isGeneratingLayouts = false;
        btn.textContent = '生成方案';
        return;
      }

      // Continue the loop
      if (isGeneratingLayouts) {
        generationReqId = requestAnimationFrame(generationLoop);
      }
    };

    // Kick off the first iteration
    generationReqId = requestAnimationFrame(generationLoop);
  }
});

document.getElementById('btn-ag41-reset').addEventListener('click', async () => {
  const btn = document.getElementById('btn-ag41-reset')
  btn.disabled = true
  btn.textContent = '生成中…'
  try {
    const newRaw = await runAG41()
    const variants = runAG42(newRaw)
    renderLayoutPanel(variants)
    showAg41Notify('已重新生成 9 个方案', true)
  } finally {
    btn.disabled = false
    btn.textContent = '重制方案'
  }
})

// ── 建筑参数面板设置 ──
const btnParams = document.getElementById('btn-ag41-params')
const cardAg41Wrap = document.getElementById('card-ag41-wrap')
const modal = document.getElementById('modal-build-params')
const closeBtn = document.querySelector('#modal-build-params .modal-close')
const okBtn = document.getElementById('modal-build-params-ok')
const cancelBtn = document.getElementById('modal-build-params-cancel')
const modalOverlay = document.querySelector('#modal-build-params .modal-overlay')
const modalWrap = document.querySelector('#modal-build-params .modal-content')

btnParams.addEventListener('click', () => {
  const defaultParams = getDefaultUserParams()
  const panel = renderBuildingParamsPanel(defaultParams)
  if (panel) {
    // 清空现有内容
    document.getElementById('modal-params-wrap').innerHTML = ''
    // 插入参数面板
    document.getElementById('modal-params-wrap').insertAdjacentHTML('afterbegin', panel.innerHTML)
    // 显示 modal
    modal.hidden = false
    // 自动滚动到 modal
    modalWrap.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
})

// 关闭逻辑 - 关闭按钮和遮罩层
closeBtn.addEventListener('click', () => modal.hidden = true)
cancelBtn.addEventListener('click', () => modal.hidden = true)
modalOverlay.addEventListener('click', () => modal.hidden = true)

// 确认逻辑
okBtn.addEventListener('click', () => {
  const container = document.querySelector('#card-ag41-wrap .card-body')
  // 读取用户确认的参数
  const params = panel.readParams?.() || { buildingW: 18600, buildingD: 24000, roomTargetAreas: {} }
  // 可选：将 params 传给 runAG41() 生成新方案
  showAg41Notify('建筑参数已确认，将用于生成布局方案', true)
  // 关闭 modal
  modal.hidden = true
})

// ── 高级参数标签页切换 ─────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const panelId = btn.dataset.tab

    // deactivate all tabs
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.remove('active')
      b.setAttribute('aria-selected', 'false')
    })
    document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = true })

    // activate selected
    btn.classList.add('active')
    btn.setAttribute('aria-selected', 'true')
    document.getElementById(panelId).hidden = false
  })
})

// ── 卡片「已知条件」按钮绑定 ───────────────────────────────────────
document.getElementById('btn-pool-recalc').addEventListener('click', recalcAG11)
document.getElementById('btn-pool-downstream').addEventListener('click', runFromAG11)
document.getElementById('btn-pump-recalc').addEventListener('click', recalcAG12)
document.getElementById('btn-pump-downstream').addEventListener('click', runFromAG12)
document.getElementById('btn-pipe-recalc').addEventListener('click', recalcAG13)
document.getElementById('btn-pipe-downstream').addEventListener('click', runFromAG13)
document.getElementById('btn-room-recalc').addEventListener('click', recalcAG21)
document.getElementById('btn-room-downstream').addEventListener('click', runFromAG21)

// ── 折叠状态持久化 ─────────────────────────────────────────────
function persistCollapseState() {
  const collapsibleSections = document.querySelectorAll(
    '.agent-card, #topology-details, #advanced-params-details, #ag41-comparison-details, #ag41-variants-details, #ag41-detail-details'
  );
  const collapseState = JSON.parse(localStorage.getItem('collapseState')) || {};

  collapsibleSections.forEach(section => {
    // Use a more robust way to get a unique ID for each section
    const sectionId = section.id || section.classList[1]; // e.g., 'topology-details' or 'card-ag00'
    if (!sectionId) return;

    // Apply stored state on load
    if (collapseState[sectionId] === false) { // false means collapsed
      section.removeAttribute('open');
    } else if (collapseState[sectionId] === true) { // true means open
      section.setAttribute('open', '');
    }

    // Listen for changes and update storage
    section.addEventListener('toggle', () => {
      collapseState[sectionId] = section.hasAttribute('open');
      localStorage.setItem('collapseState', JSON.stringify(collapseState));
    });
  });
}

// Initialize persistence on page load
document.addEventListener('DOMContentLoaded', persistCollapseState);
document.getElementById('btn-rainfall-recalc').addEventListener('click', recalcRainfall)
document.getElementById('btn-rainfall-downstream').addEventListener('click', runFromRainfall)
