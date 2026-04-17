import { ceilTo01, fmt, stepRow } from '../utils.js'
import {
  GATE_VALVE_FF, CHECK_VALVE_FF,
  GATE_VALVE_BODY, CHECK_VALVE_BODY,
  elbowCTF, reducerL, flowmeterBodyL, lookupFF,
  SPACE_RULES_DEFAULT,
} from '../data/fitting-dims.js'

// ═══════════════════════════════════════════════════════════════════════════
// 第一章：输入条件
// ═══════════════════════════════════════════════════════════════════════════

// 集水坑右边界（canvasX），用于拓扑路径分析
const WET_WELL_RIGHT_BOUNDARY = 190  // mm

// 泵外形默认尺寸（当无目录尺寸时使用）
const PUMP_DIMS_DEFAULT = { w: 0.6, d: 0.8 }  // m（沿排列方向 × 沿通道方向）

/**
 * 从汇合点(junction)出发，追踪所有到达集水坑房间的路径
 * 计入所有穿越边界的管道（泵支路 + 回流旁通），用于维护间尺寸计算
 *
 * @param {string} junctionId - 汇合点起始节点ID（泵侧节点）
 * @param {Array} pipes - 拓扑 pipes 列表（node1/node2，无向）
 * @param {Array} devices - 设备列表（用于添加设备内部节点连接）
 * @param {Array} allNodes - 所有节点列表（用于判断边界）
 * @returns {Array} 所有路径（每条路径是一个 nodeId 数组）
 */
function findPathsFromJunction(junctionId, pipes, devices, allNodes) {
  const adj = {}
  // 管道连接（双向）
  for (const pipe of pipes) {
    if (!adj[pipe.node1]) adj[pipe.node1] = []
    if (!adj[pipe.node2]) adj[pipe.node2] = []
    adj[pipe.node1].push(pipe.node2)
    adj[pipe.node2].push(pipe.node1)
  }
  // 设备内部节点连接（双向）——同一设备的两个端口互通
  for (const device of devices) {
    const { nodeIds } = device
    if (nodeIds && nodeIds.length > 1) {
      for (let i = 0; i < nodeIds.length; i++) {
        for (let j = i + 1; j < nodeIds.length; j++) {
          const a = nodeIds[i], b = nodeIds[j]
          if (!adj[a]) adj[a] = []
          if (!adj[b]) adj[b] = []
          adj[a].push(b)
          adj[b].push(a)
        }
      }
    }
  }

  const paths = []
  const queue = [{ nodeId: junctionId, path: [junctionId] }]

  while (queue.length > 0) {
    const { nodeId, path } = queue.shift()

    const currentNode = allNodes.find(n => n.id === nodeId)
    const isInWetWell = currentNode && currentNode.canvasX < WET_WELL_RIGHT_BOUNDARY

    if (isInWetWell) {
      // 所有到达集水坑的路径都计入（泵支路 + 回流旁通）
      paths.push(path)
      continue
    }

    const neighbors = adj[nodeId] || []
    for (const nextId of neighbors) {
      if (!path.includes(nextId)) {
        queue.push({ nodeId: nextId, path: [...path, nextId] })
      }
    }
  }

  return paths
}

/**
 * 从拓扑数据中提取维护间相关参数
 */
function analyzeTopology(topology) {
  let numPipes = 1
  let valvesAfterJunction = []

  if (!topology?.nodes || !topology?.pipes || !topology?.devices) {
    return { numPipes, valvesAfterJunction }
  }

  const pumpRoomDevices = topology.devices.filter(d => d.roomId === 'pump_room')
  const junctionDevice = topology.devices.find(d => d.type === 'junction')
  const junctionNodeIds = junctionDevice?.nodeIds || []

  if (junctionNodeIds.length === 0 || topology.pipes.length === 0) {
    return { numPipes, valvesAfterJunction }
  }

  // 仅从汇合点的泵侧节点（canvasX 最小，靠近集水坑一侧）出发，避免重复计路径
  const junctionNodes = junctionNodeIds
    .map(id => topology.nodes.find(n => n.id === id))
    .filter(Boolean)
  const pumpSideNode = junctionNodes.reduce(
    (min, n) => n.canvasX < min.canvasX ? n : min,
    junctionNodes[0]
  )

  const allPaths = findPathsFromJunction(
    pumpSideNode.id, topology.pipes, topology.devices, topology.nodes
  )

  numPipes = allPaths.length || 1

  // 找最长路径及其阀门（按设备去重后统计）
  let maxValveCount = 0
  let longestPath = []

  for (const path of allPaths) {
    const valveCount = new Set(
      path
        .map(id => pumpRoomDevices.find(d => d.nodeIds && d.nodeIds.includes(id)))
        .filter(d => d && (d.type === 'gate_valve' || d.type === 'check_valve'))
        .map(d => d.id)
    ).size

    if (valveCount > maxValveCount) {
      maxValveCount = valveCount
      longestPath = path
    }
  }

  valvesAfterJunction = [...new Set(
    longestPath
      .map(id => pumpRoomDevices.find(d => d.nodeIds && d.nodeIds.includes(id)))
      .filter(d => d && (d.type === 'gate_valve' || d.type === 'check_valve'))
      .map(d => d.id)
  )]

  return { numPipes, valvesAfterJunction }
}

/**
 * 从 catalogPump 提取泵外形尺寸（输入条件）
 */
function getPumpDims(catalogPump) {
  const hasCatalogDims = catalogPump?.pump?.dimensions_mm != null

  if (hasCatalogDims) {
    const dim = catalogPump.pump.dimensions_mm
    return {
      w_pump: dim.b / 1000,  // b = 沿排列方向
      d_pump: dim.a / 1000,  // a = 沿通道方向
      hasCatalogDims: true,
    }
  }

  return {
    w_pump: PUMP_DIMS_DEFAULT.w,
    d_pump: PUMP_DIMS_DEFAULT.d,
    hasCatalogDims: false,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 第二章：计算过程
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 计算汇合点后管道长度（用于房间长度）
 */
function calcJunctionLength(DN_branch, DN_main, valvesAfterJunction, topology) {
  const L_gv  = lookupFF(GATE_VALVE_FF, DN_branch) / 1000
  const L_str = Math.max(SPACE_RULES_DEFAULT.minStraight_mm, 2 * DN_branch) / 1000
  const L_fm  = flowmeterBodyL(DN_main) / 1000
  const L_tee = DN_main / 1000

  let junction_length = L_gv + L_str + L_fm + L_tee  // 默认值

  if (valvesAfterJunction.length > 0 && topology?.devices) {
    const pumpRoomDevices = topology.devices.filter(d => d.roomId === 'pump_room')
    let totalValveLength = 0

    for (let i = 0; i < valvesAfterJunction.length; i++) {
      const device = pumpRoomDevices.find(d => d.id === valvesAfterJunction[i])
      if (device) {
        if (device.type === 'gate_valve') totalValveLength += lookupFF(GATE_VALVE_FF, DN_branch) / 1000
        else if (device.type === 'check_valve') totalValveLength += lookupFF(CHECK_VALVE_FF, DN_branch) / 1000
        if (i < valvesAfterJunction.length - 1) totalValveLength += L_str
      }
    }
    junction_length = totalValveLength + L_fm + L_tee
  }

  return junction_length
}

/**
 * 计算维护间净长 L
 */
function calcRoomLength(N_total, w_pump, d_spacing, e_wall, DN_branch, DN_main, spaceRules, numPipes, valvesAfterJunction, topology) {
  const s = spaceRules || SPACE_RULES_DEFAULT
  const pipeToWall_m = s.pipeToWall_mm / 1000
  const pipeToPipe_m = s.pipeToPipe_mm / 1000
  const DN_branch_m  = DN_branch / 1000

  const junction_length = calcJunctionLength(DN_branch, DN_main, valvesAfterJunction, topology)
  const L_pipe = pipeToWall_m + DN_branch_m + (pipeToPipe_m + DN_branch_m) * (numPipes - 1)
                  + Math.max(junction_length, pipeToWall_m)
  const L_pumpBased = N_total * w_pump + (N_total - 1) * d_spacing + 2 * e_wall
  const L_raw = Math.max(L_pipe, L_pumpBased)

  return { L: ceilTo01(L_raw), L_pipe, L_pumpBased, junction_length }
}

/**
 * 计算维护间净宽 W
 */
function calcRoomWidth(d_pump, DN_branch, DN_main, spaceRules) {
  const s = spaceRules || SPACE_RULES_DEFAULT
  const pipeToWall_m = s.pipeToWall_mm / 1000
  const L_str   = Math.max(s.minStraight_mm, 2 * DN_branch) / 1000
  const L_elbow = elbowCTF(DN_branch) / 1000
  const L_cv    = lookupFF(CHECK_VALVE_FF, DN_branch) / 1000
  const L_gv    = lookupFF(GATE_VALVE_FF, DN_branch) / 1000
  const L_tee   = DN_main / 1000

  const W_pipe = pipeToWall_m + L_elbow + L_str + L_cv + L_str + L_gv + L_tee + pipeToWall_m
  const W_equip = d_pump + 0.5
  const W_legacy = Math.max(1.2, W_equip) + 0.3

  return { W: Math.max(2.5, ceilTo01(Math.max(W_pipe, W_legacy))), W_pipe, W_equip }
}

/**
 * 计算维护间净高 H
 */
function calcRoomHeight(d_pump, h_room_input) {
  const h_room_default = Math.max(3.5, d_pump + 2.0)
  const h_room = h_room_input ?? h_room_default
  const h_room_source = h_room_input != null ? '用户输入' : '默认公式 max(3.5, d_pump+2.0)'
  return { h_room, h_room_source, h_room_default }
}

/**
 * 计算维护间尺寸（L, W, H），编排三个独立计算函数
 */
function calculateRoomDimensions(N, N_spare, options) {
  const {
    catalogPump = null,
    DN_branch = 150,
    DN_main = 300,
    d_spacing = 1.0,
    e_wall = 0.8,
    h_room: h_room_input = null,
    spaceRules = SPACE_RULES_DEFAULT,
    topology = null,
  } = options

  const N_total = N + N_spare
  const { w_pump, d_pump, hasCatalogDims } = getPumpDims(catalogPump)
  const { numPipes, valvesAfterJunction } = analyzeTopology(topology)

  const { L, L_pipe, L_pumpBased, junction_length } = calcRoomLength(
    N_total, w_pump, d_spacing, e_wall, DN_branch, DN_main, spaceRules, numPipes, valvesAfterJunction, topology)

  const { W, W_pipe, W_equip } = calcRoomWidth(d_pump, DN_branch, DN_main, spaceRules)

  const { h_room, h_room_source, h_room_default } = calcRoomHeight(d_pump, h_room_input)

  return {
    w_pump, d_pump, d_spacing, e_wall, N_total, hasCatalogDims,
    DN_branch, DN_main, numPipes, valvesAfterJunction,
    L_elbow_m: elbowCTF(DN_branch) / 1000,
    c_wall_m: (spaceRules.pipeToWall_mm || SPACE_RULES_DEFAULT.pipeToWall_mm) / 1000,
    L, W, h_room, h_room_source, h_room_default,
    L_pipe, L_pumpBased, junction_length, W_pipe, W_equip,
    catalogPump,
    h_room_input,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 第三章：输出结果
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 构建集水坑尺寸
 * - L_sump = 维护间净长 L
 * - W_sump = 所有泵的深度之和 (N_total × d_pump)
 * - H_sump = z_sump - z_bottom（用户输入的液位差）
 */
function buildSumpDimensions(L, N_total, d_pump, z_sump, z_bottom) {
  return {
    L_sump: L,
    W_sump: N_total * d_pump,
    H_sump: z_sump != null && z_bottom != null ? z_sump - z_bottom : null,
    z_sump,
    z_bottom,
  }
}

/**
 * 构建管件明细表（阀门长宽高）
 */
function buildValveDetails(valvesAfterJunction, topology, DN_branch) {
  if (!valvesAfterJunction || valvesAfterJunction.length === 0 || !topology?.devices) {
    return []
  }

  const pumpRoomDevices = topology.devices.filter(d => d.roomId === 'pump_room')
  const details = []

  for (const valveId of valvesAfterJunction) {
    const device = pumpRoomDevices.find(d => d.id === valveId)
    if (!device) continue

    let length_mm, width_mm, height_mm

    if (device.type === 'gate_valve') {
      length_mm = lookupFF(GATE_VALVE_FF, DN_branch)
      const body = GATE_VALVE_BODY[DN_branch] || { w: DN_branch * 1.8, h: DN_branch * 0.7 }
      width_mm = body.w
      height_mm = body.h
    } else if (device.type === 'check_valve') {
      length_mm = lookupFF(CHECK_VALVE_FF, DN_branch)
      const body = CHECK_VALVE_BODY[DN_branch] || { w: DN_branch * 1.2, h: DN_branch * 1.0 }
      width_mm = body.w
      height_mm = body.h
    }

    details.push({ id: device.id, type: device.type, length_mm, width_mm, height_mm })
  }

  return details
}

/**
 * 构建流量计直管段要求（前五后二）
 */
function buildFlowmeterRequirements(DN_main, spaceRules) {
  const fmUp = spaceRules?.fmUpstream_D ?? SPACE_RULES_DEFAULT.fmUpstream_D
  const fmDn = spaceRules?.fmDownstream_D ?? SPACE_RULES_DEFAULT.fmDownstream_D
  return { upstream_mm: fmUp * DN_main, downstream_mm: fmDn * DN_main, upstream_D: fmUp, downstream_D: fmDn }
}

/**
 * 构建集水坑管件说明
 */
function buildSumpFittings(DN_branch, DN_main, catalogPump, hasCatalogDims) {
  const hasReducer = DN_branch !== DN_main
  const notes = hasCatalogDims
    ? [`泵外形：${catalogPump.pump.dimensions_mm.a}×${catalogPump.pump.dimensions_mm.b} mm（实际目录值）`]
    : ['泵外形：0.6×0.8 m（通用估算值）']
  if (hasReducer) notes.push(`变径：DN${DN_main}→DN${DN_branch}，长度约 ${reducerL(DN_main, DN_branch)} mm`)
  return { elbow_vert_mm: elbowCTF(DN_branch), reducer_mm: hasReducer ? reducerL(DN_main, DN_branch) : 0, notes }
}

/**
 * 构建 W 逐项明细
 */
function buildWBreakdown(spaceRules, DN_branch, DN_main, numPipes) {
  const s = spaceRules || SPACE_RULES_DEFAULT
  return [
    { label: '管外壁到墙面净距', val: s.pipeToWall_mm, unit: 'mm' },
    { label: '管道宽度 DN_branch', val: DN_branch, unit: 'mm' },
    { label: '相邻管外壁间净距', val: s.pipeToPipe_mm, unit: 'mm' },
    { label: '汇合点后管道数量', val: numPipes, unit: '条' },
    { label: '汇合点后闸阀', val: lookupFF(GATE_VALVE_FF, DN_branch), unit: 'mm' },
    { label: '汇合点后直管段', val: Math.max(2 * DN_branch, s.minStraight_mm), unit: 'mm' },
    { label: '汇合点后流量计', val: flowmeterBodyL(DN_main), unit: 'mm' },
  ]
}

/**
 * 构建计算过程表格
 */
function buildRows(N, N_spare, params) {
  const { w_pump, d_pump, N_total, hasCatalogDims, catalogPump,
    DN_branch, DN_main, numPipes, valvesAfterJunction,
    L, L_pipe, L_pumpBased, W, W_pipe, W_equip,
    h_room, h_room_source, h_room_default, h_room_input } = params

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

  rows.push(stepRow('═══════════ 拓扑分析 ═══════════', '', '', ''))
  rows.push(stepRow('管道数量 numPipes', '从汇合点到房间边界的管道数量', `${numPipes}`, '条'))
  rows.push(stepRow('汇合点至出水点阀门数量', '按拓扑实际配置', `${valvesAfterJunction.length}`, '个'))
  rows.push(stepRow('汇合点后三通', '用DN_main尺寸', `${DN_main}`, 'mm'))

  rows.push(stepRow('═══════════ 维护间净长 ═══════════', '', '', ''))
  rows.push(stepRow('总布置台数（含备用泵）', `工作泵 ${N} 台 + 备用泵 ${N_spare} 台 =`, `${N_total} 台`, ''))
  rows.push(stepRow('L_pipe（管道占长）', `墙距 + DN + 间距×${numPipes - 1} + max(汇合点长度, 墙距) =`, fmt(L_pipe, 3), 'm'))
  rows.push(stepRow('L_pumpBased（泵排列）', `N_total×w + (N_total-1)×d + 2×e =`, fmt(L_pumpBased, 3), 'm'))
  rows.push(stepRow('维护间净长 L', `max(L_pipe, L_pumpBased) = max(${fmt(L_pipe, 2)}, ${fmt(L_pumpBased, 2)}) →`, fmt(L, 1), 'm'))

  rows.push(stepRow('═══════════ 维护间净宽 ═══════════', '', '', ''))
  rows.push(stepRow('支管 DN_branch', '', `${DN_branch}`, 'mm'))
  rows.push(stepRow('主管 DN_main', '', `${DN_main}`, 'mm'))
  rows.push(stepRow('W_pipe（管道占宽）', `墙距 + 弯头 + 直管 + 止回阀 + 直管 + 闸阀 + 三通 + 墙距 =`, fmt(W_pipe, 3), 'm'))
  rows.push(stepRow('通道净宽 W_equip', `d_pump + 0.5 = ${fmt(d_pump, 1)} + 0.5 =`, fmt(W_equip, 1), 'm'))
  rows.push(stepRow('维护间净宽 W', `max(2.5, max(W_pipe, W_legacy)) =`, fmt(W, 1), 'm'))

  rows.push(stepRow('═══════════ 维护间净高 ═══════════', '', '', ''))
  rows.push(stepRow('h_room 默认公式', 'max(3.5, d_pump + 2.0)', fmt(h_room_default, 1), 'm', h_room_source))
  rows.push(stepRow('维护间净高 h_room', h_room_input != null ? '用户输入' : '默认公式', fmt(h_room, 1), 'm', h_room_source))

  return rows
}

/**
 * 组装所有输出结果
 */
function buildAllOutputs(N, N_spare, params, options, spaceRules) {
  const { z_sump = null, z_bottom = null } = options

  return {
    // 维护间尺寸
    L: params.L,
    W: params.W,
    h_room: params.h_room,
    // 集水坑尺寸
    sumpDims: buildSumpDimensions(params.L, params.N_total, params.d_pump, z_sump, z_bottom),
    // 流量计直管段要求
    flowmeterReq: buildFlowmeterRequirements(params.DN_main, spaceRules),
    // 管件明细表
    valveDetails: buildValveDetails(params.valvesAfterJunction, options.topology, params.DN_branch),
    // 集水坑管件说明
    sumpFittings: buildSumpFittings(params.DN_branch, params.DN_main, options.catalogPump, params.hasCatalogDims),
    // W 逐项明细
    W_breakdown: buildWBreakdown(spaceRules, params.DN_branch, params.DN_main, params.numPipes),
    // 计算过程表格
    rows: buildRows(N, N_spare, params),
    // 泵参数
    w_pump: params.w_pump,
    d_pump: params.d_pump,
    d_spacing: params.d_spacing,
    e_wall: params.e_wall,
    N_total: params.N_total,
    hasCatalogDims: params.hasCatalogDims,
    DN_branch: params.DN_branch,
    DN_main: params.DN_main,
    // 管道参数
    W_pipe: params.W_pipe,
    c_wall_m: params.pipeToWall_m,
    L_elbow_m: params.L_elbow,
    numPipes: params.numPipes,
    junction_length: params.junction_length,
    valvesAfterJunction: params.valvesAfterJunction,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 主函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * AG2-1：泵房维护间尺寸计算
 *
 * @param {number} N - 工作泵台数
 * @param {number} N_spare - 备用泵台数，默认 0
 * @param {object} options
 * @param {number} options.z_sump - 集水坑最高液位（m）
 * @param {number} options.z_bottom - 集水坑底板标高（m）
 *
 * 其他 options：catalogPump, DN_branch, DN_main, d_spacing, e_wall,
 *              h_room, spaceRules, topology
 */
export function runMaintenanceRoom(N, N_spare = 0, options = {}) {
  const spaceRules = options.spaceRules || SPACE_RULES_DEFAULT
  const params = calculateRoomDimensions(N, N_spare, options)
  return buildAllOutputs(N, N_spare, params, options, spaceRules)
}
