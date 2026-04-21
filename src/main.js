import './style.css'
import { initTokenVerification } from './auth.js'

// 初始化token验证
const isTokenValid = initTokenVerification()

window.debugModeEnabled = false;
window.timeCostThreshold = 0.5; // seconds
window.timeCostLog = [];

import { runUserParams } from './agents/user-params.js'
import { runTopology } from './agents/topology.js'
import { runPoolDepth } from './agents/pool-depth.js'
import { runMaintenanceRoom } from './agents/maintenance-room.js'
import { SPACE_RULES_DEFAULT } from './data/fitting-dims.js'
import { runPumpSpec } from './agents/pump-spec.js'
import { runPipeSizing, PIPE_SCHEMES } from './agents/pipe-sizing.js'
import { runDrawing } from './agents/drawing.js'
import { initLayoutController, generateInitialLayouts } from './ui/layout-controller.js'

import { renderRainfall, renderTopology, renderPoolDepth, renderPipeSizing, renderMaintenanceRoom, renderPumpSpec, renderRainfallCard, renderSchemeOptions } from './ui/results-panel.js'
import { showAg41Notify } from './ui/layout-panel.js'
import { initTopologyEditor, setTopologyFromN, getCurrentTopology } from './ui/topology-editor.js'

let _lastTopoN     = null
let _lastTopoSpare = 0

initLayoutController()

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
  // 同步 AG1-3 的 DN 到 AG2-1 已知条件显示
  const ag13 = moduleCache.ag13
  if (ag13) {
    const dnBranch = ag13.DN_pumpOut
    const dnMain   = ag13.DN_mainOutlet
    if (dnBranch != null) document.getElementById('room-DN-branch').value = dnBranch
    if (dnMain   != null) document.getElementById('room-DN-main').value  = dnMain
  }
  // AG2-1 和 AG3-1 的重绘（不重跑泵选型）
  recalcAG21()
  const ag00Result = moduleCache.ag00
  const ag1Result  = moduleCache.ag11
  const ag2Result  = moduleCache.ag12
  if (ag00Result?.valid && ag2Result?.valid && ag1Result) {
    // 获取拓扑数据用于计算管道数量和阀门
    const currentTopology = getCurrentTopology()

    const d_spacing_hsc = parseFloat(document.getElementById('room-d-spacing').value) || 1.0
    const e_wall_hsc = parseFloat(document.getElementById('room-e-wall').value) || 0.8
    const pipeToWall_hsc = parseInt(document.getElementById('room-pipe-to-wall').value, 10) || 800
    const pipeToPipe_hsc = parseInt(document.getElementById('room-pipe-to-pipe').value, 10) || 800
    const minStraight_hsc = parseInt(document.getElementById('room-min-straight').value, 10) || 300
    const DN_branch_hsc = parseInt(document.getElementById('room-DN-branch').value, 10)
    const DN_main_hsc   = parseInt(document.getElementById('room-DN-main').value, 10)
    const h_room_hsc = parseFloat(document.getElementById('room-h-room').value)
    const ag21 = runMaintenanceRoom(ag00Result.N, ag00Result.N_spare, {
      catalogPump: moduleCache.ag12?.displayMatches?.[0] ?? null,
      DN_branch: DN_branch_hsc || (moduleCache.ag13?.DN_pumpOut ?? 150),
      DN_main:   DN_main_hsc   || (moduleCache.ag13?.DN_mainOutlet ?? 300),
      d_spacing: d_spacing_hsc,
      e_wall: e_wall_hsc,
      h_room: isNaN(h_room_hsc) ? null : h_room_hsc,
      spaceRules: { pipeToWall_mm: pipeToWall_hsc, pipeToPipe_mm: pipeToPipe_hsc, minStraight_mm: minStraight_hsc },
      topology: currentTopology,  // 拓扑数据用于计算管道数量和阀门
    })
    ag21.DN_label = ag2Result.DN_outlet
    document.getElementById('card-ag21').innerHTML = renderMaintenanceRoom(ag21)
    const ag31Params = {
      h_pool:      ag1Result.D,                    // 结构池深 = 16 m
      h_active:    ag1Result.Z_max - ag1Result.Z_stop,  // 有效水深 = 14.2 m
      Z_stop:      ag1Result.Z_stop,
      Z_start1:    ag1Result.Z_start1,
      Z_start2:    ag1Result.Z_start2,
      Z_alarm_high: ag1Result.Z_alarm_high,
      Z_alarm_low: ag1Result.Z_alarm_low,
      Z_max:       ag1Result.Z_max,
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
    runDrawing(ag00Result.N, ag21, ag31Params, ag1Result.S, enrichedTopo, {
      Q_single: ag00Result.Q_pump,
      H_design: ag2Result?.H_total,
      P_motor: ag2Result?.P_motor,
      catalogPump: moduleCache.ag12?.displayMatches?.[0] ?? null,
      Z_sump: ag00Result.Z_sump,
    })
  }
  // 同步更新方案卡 UI
  document.getElementById('scheme-options').innerHTML = renderSchemeOptions(currentSchemeId)
}

// 暴露到全局作用域，供 HTML 内联事件处理器调用
window.handleSchemeChange = handleSchemeChange

function recalcAG21() {
  const N          = parseInt(document.getElementById('room-N').value, 10)
  const N_spare    = parseInt(document.getElementById('room-N-spare').value, 10) || 0
  const d_spacing  = parseFloat(document.getElementById('room-d-spacing').value) || 1.0
  const e_wall     = parseFloat(document.getElementById('room-e-wall').value) || 0.8
  const h_room_in  = parseFloat(document.getElementById('room-h-room').value)
  const pipeToWall_mm   = parseInt(document.getElementById('room-pipe-to-wall').value, 10) || 800
  const pipeToPipe_mm   = parseInt(document.getElementById('room-pipe-to-pipe').value, 10) || 800
  const minStraight_mm  = parseInt(document.getElementById('room-min-straight').value, 10) || 300
  const DN_branch_in    = parseInt(document.getElementById('room-DN-branch').value, 10)
  const DN_main_in      = parseInt(document.getElementById('room-DN-main').value, 10)

  // 获取拓扑数据用于计算管道数量和阀门
  const currentTopology = getCurrentTopology()

  if (isNaN(N)) {
    document.getElementById('card-ag21').innerHTML =
      '<p class="msg-error">⚠ 缺少必要参数：请填写工作泵台数。</p>'
    return null
  }
  const result = runMaintenanceRoom(N, N_spare, {
    catalogPump: moduleCache.ag12?.displayMatches?.[0] ?? null,
    DN_branch: DN_branch_in || (moduleCache.ag13?.DN_pumpOut ?? 150),
    DN_main:   DN_main_in   || (moduleCache.ag13?.DN_mainOutlet ?? 300),
    d_spacing,
    e_wall,
    h_room: isNaN(h_room_in) ? null : h_room_in,
    spaceRules: { pipeToWall_mm, pipeToPipe_mm, minStraight_mm },
    topology: currentTopology,
  })
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
 * 计算从汇合点(junction)到泵房维护间边界的管道数量
 * 通过追踪从junction出发的边，统计进入泵房维护间(pump_room)范围的路径数量
 * 用于确定W方向需要布置的平行管道数量
 *
 * @param {Object} topoParams - topologyToAG31Params()的输出
 * @returns {number} 管道数量（默认1条）
 */
function countPipesFromJunction(topoParams) {
  if (!topoParams?.devicesByRoom?.pump_room) return 1

  const pumpRoomDevices = topoParams.devicesByRoom.pump_room
  const pipes = topoParams.pipes || []

  // 找到汇流节点（label === '汇'）
  const allNodes = topoParams.allNodes || []
  const junctionNode = allNodes.find(n => n.label === '汇')
  if (!junctionNode) return 1

  // 泵房维护间右边界（约在 canvasX=770 处）
  const pumpRoomRightBoundary = 770

  // 统计从junction出发，进入泵房维护间范围的管道数量
  // 沿 pipes 追踪：从junction出发，跟随 pipes 直到离开泵房维护间范围
  const visited = new Set()
  const queue = [junctionNode.id]

  // 构建双向邻接表
  const adj = {}
  for (const pipe of pipes) {
    if (!adj[pipe.node1]) adj[pipe.node1] = []
    if (!adj[pipe.node2]) adj[pipe.node2] = []
    adj[pipe.node1].push(pipe.node2)
    adj[pipe.node2].push(pipe.node1)
  }

  while (queue.length > 0) {
    const currentId = queue.shift()
    if (visited.has(currentId)) continue
    visited.add(currentId)

    // 查找所有从 currentId 出发的 pipe（双向邻接表）
    const neighbors = adj[currentId] || []
    for (const neighborId of neighbors) {
      // 检查目标节点是否在泵房维护间范围内
      const node = allNodes.find(n => n.id === neighborId)
      if (node && node.canvasX < pumpRoomRightBoundary) {
        if (!visited.has(neighborId)) {
          queue.push(neighborId)
        }
      }
    }
  }

  // 排除junction自身，返回实际管道数量
  // visited包含了junction和所有在泵房范围内的设备
  // 管道数量 = visited中非junction设备（这些设备代表了从junction发出的平行管道）
  const pipeCount = Math.max(1, visited.size - 1)
  return pipeCount
}

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

  // AG0-1: 参数验证（保留，用于获取 mode、N 等下游参数）
  const ag00 = runUserParams(ag00Params)

  const panel = document.getElementById('results-panel')
  panel.hidden = false

  // AG0-2: 若 N 或 N_spare 变化则重置默认拓扑
  const N_spare = parseInt(document.getElementById('inp-N-spare').value, 10) || 0
  if (ag00Params.N !== _lastTopoN || N_spare !== _lastTopoSpare) {
    setTopologyFromN(ag00Params.N, N_spare)
    _lastTopoN     = ag00Params.N
    _lastTopoSpare = N_spare
  }

  // AG0-1: 暴雨计算（已知条件在卡片内，输出到 card-rainfall）
  const ag00Result = recalcRainfall()

  // AG0-2: 拓扑解析（单独调用，输出到 card-topology）
  const ag01Topo = runTopology(getCurrentTopology())
  document.getElementById('card-topology').innerHTML = renderTopology(ag01Topo)

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

  // 同步 AG1-3 管径到 AG2-1 已知条件
  const ag13forSync = moduleCache.ag13
  if (ag13forSync) {
    const dnBranch = ag13forSync.DN_pumpOut
    const dnMain   = ag13forSync.DN_mainOutlet
    if (dnBranch != null) document.getElementById('room-DN-branch').value = dnBranch
    if (dnMain   != null) document.getElementById('room-DN-main').value  = dnMain
  }

  // ── AG2-1: 泵房维护间尺寸计算 ─────────────────────────────────────────
  // 获取拓扑数据用于计算管道数量和阀门
  const currentTopology = getCurrentTopology()

  const catalogPump = moduleCache.ag12?.displayMatches?.[0] ?? null
  const ag13 = moduleCache.ag13
  const pipesDN = { DN_branch: ag13?.DN_pumpOut ?? 150, DN_main: ag13?.DN_mainOutlet ?? 300 }
  const d_spacing_rc = parseFloat(document.getElementById('room-d-spacing').value) || 1.0
  const e_wall_rc = parseFloat(document.getElementById('room-e-wall').value) || 0.8
  const h_room_rc = parseFloat(document.getElementById('room-h-room').value)
  const pipeToWall_rc = parseInt(document.getElementById('room-pipe-to-wall').value, 10) || 800
  const pipeToPipe_rc = parseInt(document.getElementById('room-pipe-to-pipe').value, 10) || 800
  const minStraight_rc = parseInt(document.getElementById('room-min-straight').value, 10) || 300
  const DN_branch_rc = parseInt(document.getElementById('room-DN-branch').value, 10)
  const DN_main_rc   = parseInt(document.getElementById('room-DN-main').value, 10)
  const ag21 = runMaintenanceRoom(ag00.N, N_spare, {
    catalogPump,
    DN_branch: DN_branch_rc || (ag13?.DN_pumpOut ?? 150),
    DN_main:   DN_main_rc   || (ag13?.DN_mainOutlet ?? 300),
    d_spacing: d_spacing_rc,
    e_wall: e_wall_rc,
    h_room: isNaN(h_room_rc) ? null : h_room_rc,
    spaceRules: { pipeToWall_mm: pipeToWall_rc, pipeToPipe_mm: pipeToPipe_rc, minStraight_mm: minStraight_rc },
    topology: currentTopology,  // 拓扑数据用于计算管道数量和阀门
  })
  ag21.DN_label = (ag13 && ag13.DN_pumpOut) || ag2Result.DN_outlet
  document.getElementById('card-ag21').innerHTML = renderMaintenanceRoom(ag21)

  // ── AG3-1: SVG绘图 ───────────────────────────────────────────────
  // h_pool: 结构池深，h_active: 有效水深（Z_max - Z_stop）
  const ag31Params = {
    h_pool:     ag1Result.D,                          // 结构池深 = 16 m
    h_active:   ag1Result.Z_max - ag1Result.Z_stop,    // 有效水深 = 14.2 m
    Z_stop:     ag1Result.Z_stop,
    Z_start1:   ag1Result.Z_start1,
    Z_start2:   ag1Result.Z_start2,
    Z_alarm_high: ag1Result.Z_alarm_high,
    Z_alarm_low: ag1Result.Z_alarm_low,
    Z_max:      ag1Result.Z_max,
  }
  // ── AG3-1: SVG绘图（拓扑数据富化）─────────────────────────────
  // 用 AG1-3 的变径结果富化拓扑中的 pump 节点
  const ag12 = moduleCache.ag12
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

  runDrawing(ag00.N, ag21, ag31Params, ag1Result.S, enrichedTopo, {
    Q_single: ag00.Q_pump,
    H_design: ag12?.H_total,
    P_motor: ag12?.P_motor,
    catalogPump: moduleCache.ag12?.displayMatches?.[0] ?? null,
    Z_sump: ag00.Z_sump,
  })

  // Update repair_zone hint from AG2-1 before reading AG4-1 params
  updateRepairZoneHint(ag21)

  // ── AG4-1/AG4-2: 布局生成与评分 ─────────────────────────────────
  await generateInitialLayouts()

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
    '.agent-card, #topology-details, #advanced-params-details'
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
document.addEventListener('DOMContentLoaded', () => {
  persistCollapseState();
  initSummaryToggleLogic();
  initFocusMode();
  // 默认执行一次 AG0-0 及后续计算，确保初始参数可用
  runCalculation();
});

let isFocusMode = false;

/**
 * ── Focus Mode (Wizard UI) ──
 * 1. Single card open at a time.
 * 2. Non-open cards are hidden when in focus mode.
 */
function initFocusMode() {

  // Inject Navigation Bar
  const navBar = document.createElement('div');
  navBar.id = 'wizard-nav-bar';
  navBar.className = 'wizard-nav-bar';
  navBar.innerHTML = `
    <button id="btn-wizard-prev">上一步</button>
    <button id="btn-wizard-next">下一步</button>
  `;
  document.body.appendChild(navBar);

  const prevBtn = navBar.querySelector('#btn-wizard-prev');
  const nextBtn = navBar.querySelector('#btn-wizard-next');

  const updateNav = () => {
    if (!isFocusMode) {
      navBar.style.display = 'none';
      return;
    }
    navBar.style.display = 'flex';

    const allCards = Array.from(document.querySelectorAll('.agent-card'));
    const resultsPanel = document.getElementById('results-panel');
    const isResultsHidden = resultsPanel ? resultsPanel.hidden : true;

    // Filter visible cards based on parent section visibility
    const visibleCards = allCards.filter(c => {
      const parentSection = c.closest('section');
      if (parentSection && parentSection.id === 'results-panel' && isResultsHidden) return false;
      return true;
    });

    const activeCard = visibleCards.find(c => c.open);
    const currentIndex = activeCard ? visibleCards.indexOf(activeCard) : -1;
    
    // 维护 body 状态类，用于 CSS 控制卡片可见性
    const anyOpen = visibleCards.some(c => c.open);
    document.body.classList.toggle('has-open-card', anyOpen);

    prevBtn.disabled = currentIndex <= 0;
    
    const isEnd = currentIndex === -1 || currentIndex >= visibleCards.length - 1;
    const isInputCard = activeCard && activeCard.id === 'card-input-wrap';

    if (isEnd && (currentIndex === -1 || (isInputCard && isResultsHidden))) {
      nextBtn.disabled = false;
      nextBtn.textContent = '下一步';
      nextBtn.onclick = () => {
        document.getElementById('btn-calc').click();
        // Trigger move after calc unhides panel
        setTimeout(() => {
          const updatedVisible = Array.from(document.querySelectorAll('.agent-card')).filter(c => {
            const p = c.closest('section');
            return !p || !p.hidden;
          });
          if (updatedVisible.length > 1) {
            activeCard.removeAttribute('open');
            updatedVisible[1].setAttribute('open', '');
            updatedVisible[1].scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          updateNav();
        }, 350);
      };
    } else {
      nextBtn.disabled = isEnd;
      nextBtn.textContent = '下一步';
      nextBtn.onclick = () => {
        if (!isEnd) {
          activeCard.removeAttribute('open');
          visibleCards[currentIndex + 1].setAttribute('open', '');
          visibleCards[currentIndex + 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
          updateNav();
        }
      };
    }

    prevBtn.onclick = () => {
      if (currentIndex > 0) {
        activeCard.removeAttribute('open');
        visibleCards[currentIndex - 1].setAttribute('open', '');
        visibleCards[currentIndex - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
        updateNav();
      }
    };
  };

  // Global toggle listener (capture phase) to enforce single open and manage modes
  document.addEventListener('toggle', (e) => {
    if (e.target.classList.contains('agent-card')) {
      const allCards = document.querySelectorAll('.agent-card');
      const openCards = Array.from(allCards).filter(c => c.open);

      if (e.target.open) {
        // Just opened a card: Enter focus mode, hide others
        isFocusMode = true;
        document.body.classList.add('focus-mode');
        document.body.classList.add('has-open-card');
        
        allCards.forEach(c => {
          if (c !== e.target && c.open) c.removeAttribute('open');
        });
      } else {
        // Just closed a card: If no cards are left open, exit focus mode (show headers stack)
        if (openCards.length === 0) {
          isFocusMode = false;
          document.body.classList.remove('focus-mode');
          document.body.classList.remove('has-open-card');
        }
      }
      updateNav();
    }
  }, true);

  // Initial call
  updateNav();
}

// ── Summary Click Logic (Only triangle triggers toggle) ──
function initSummaryToggleLogic() {
  document.addEventListener('click', (e) => {
    const summary = e.target.closest('summary.card-header, summary.ag41-section-header');
    if (!summary) return;

    const rect = summary.getBoundingClientRect();
    const clickX = e.clientX - rect.left;

    // The triangle is within the first 35px. 
    // AG-Init is special: allow clicking anywhere on the header to toggle.
    const isInitCard = summary.closest('#card-input-wrap');
    if (clickX > 35 && !isInitCard) {
      const targetTag = e.target.tagName.toLowerCase();
      const isInteractive = ['input', 'button', 'label'].includes(targetTag) || e.target.closest('button, label');
      if (!isInteractive) {
        e.preventDefault();
      }
    }
  });
}

document.getElementById('btn-rainfall-recalc').addEventListener('click', recalcRainfall)
document.getElementById('btn-rainfall-downstream').addEventListener('click', runFromRainfall)

// Keyboard shortcut for bypassing Checkpoint A
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    window.debugModeEnabled = !window.debugModeEnabled;
    window.timeCostLog = [];
    const msg = `Debug模式: ${window.debugModeEnabled ? '已开启' : '已关闭'}`;
    showAg41Notify(msg, window.debugModeEnabled);
  }
});
