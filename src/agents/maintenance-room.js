import { ceilTo01, fmt, stepRow } from '../utils.js'
import {
  GATE_VALVE_FF, CHECK_VALVE_FF,
  elbowCTF, reducerL, flowmeterBodyL, lookupFF,
  SPACE_RULES_DEFAULT,
} from '../data/fitting-dims.js'

/**
 * 从汇合点(junction)出发，追踪所有到达房间边界的路径
 * 用于计算管道数量和最长路径的阀门数量
 *
 * @param {string} junctionId - 汇合点ID
 * @param {Array} edges - 拓扑边列表
 * @param {Array} pumpRoomDevices - 泵房维护间内的设备列表
 * @returns {Array} 所有路径（每条路径是一个设备ID数组）
 */
function findPathsFromJunction(junctionId, edges, pumpRoomDevices) {
  const pumpRoomDeviceIds = new Set(pumpRoomDevices.map(d => d.id))
  const pumpRoomRightBoundary = 770  // 泵房右边界（editorX）

  // 构建邻接表
  const adj = {}
  for (const edge of edges) {
    if (!adj[edge.fromId]) adj[edge.fromId] = []
    adj[edge.fromId].push(edge.toId)
  }

  const paths = []
  const visited = new Set()

  function dfs(currentId, path) {
    if (visited.has(currentId)) return
    visited.add(currentId)
    path.push(currentId)

    // 检查是否到达房间边界（设备在边界外或为外部节点）
    const device = pumpRoomDevices.find(d => d.id === currentId)
    const isExternalNode = !pumpRoomDeviceIds.has(currentId) && currentId !== junctionId
    const isOutOfBounds = device && device.editorX >= pumpRoomRightBoundary

    if (isExternalNode || isOutOfBounds) {
      // 到达边界，记录路径
      paths.push([...path])
      path.pop()
      visited.delete(currentId)
      return
    }

    // 继续追踪
    const neighbors = adj[currentId] || []
    for (const nextId of neighbors) {
      if (!visited.has(nextId)) {
        dfs(nextId, path)
      }
    }

    path.pop()
    visited.delete(currentId)
  }

  dfs(junctionId, [])
  return paths
}

/**
 * AG2-1：泵房维护间尺寸计算
 *
 * 可选接收 catalogPump（含 dimensions_mm）以使用实际泵尺寸；
 * 否则使用固定默认值（0.6×0.8 m）。
 *
 * @param {number} N - 工作泵台数
 * @param {number} N_spare - 备用泵台数，默认 0
 * @param {object} options - { catalogPump, DN_branch, DN_main, d_spacing, e_wall, spaceRules, h_room, topology, topoDevices }
 * @param {number} options.d_spacing - 泵间净距（m），直接输入（默认 1.0 m）
 * @param {number} options.e_wall - 端部距墙净距（m），直接输入（默认 0.8 m）
 * @param {number} options.h_room - 维护间净高（m），默认 max(3.5, d_pump + 2.0)
 * @param {object} options.spaceRules - { pipeToWall_mm, pipeToPipe_mm, minStraight_mm }
 * @param {object} options.topology - 拓扑数据（用于计算阀门数量）
 * @param {object} options.topoDevices - pump_room内的设备列表（已过滤）
 *
 * **间距规则说明**：本项目遵循 DSD 渠务署香港规范。d_spacing/e_wall 由调用侧直接提供，
 * GB 50265-2022 §7 功率→间距规则仅作技术参考。
 */
export function runMaintenanceRoom(N, N_spare = 0, options = {}) {
  const {
    catalogPump = null,
    DN_branch = 150,
    DN_main = 300,
    d_spacing = 1.0,
    e_wall = 0.8,
    h_room: h_room_input = null,  // 维护间净高输入值，默认 null
    spaceRules = SPACE_RULES_DEFAULT,
    topology = null,  // 拓扑数据
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

  // ── 维护间净高 h_room ──────────────────────────────────────────────
  // 默认值：max(3.5, d_pump + 2.0)，考虑检修 + 管道 + 起重余量
  const h_room_default = Math.max(3.5, d_pump + 2.0)
  const h_room = h_room_input ?? h_room_default  // 使用用户输入值或默认值
  const h_room_source = h_room_input != null ? '用户输入' : '默认公式 max(3.5, d_pump+2.0)'

  // ── 从拓扑分析计算管道数量和最长路径 ──────────────────────────
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
  const L_elbow_m = elbowCTF(DN_branch) / 1000                   // 弯头水平投影
  const L_fm = flowmeterBodyL(DN_main) / 1000                    // 流量计长度

  // 从拓扑分析管道和阀门
  let numPipes = 1  // 从汇合点到房间边界的管道数量
  let valvesAfterJunction = []  // 汇合点后的阀门列表
  if (topology?.devices) {
    const pumpRoomDevices = topology.devices.filter(d => d.roomId === 'pump_room')
    const junction = pumpRoomDevices.find(d => d.type === 'junction')

    if (junction && topology.edges) {
      // 找到从junction出发的所有路径
      const paths = findPathsFromJunction(junction.id, topology.edges, pumpRoomDevices)

      // numPipes = 路径数量（每个分支一条管道）
      numPipes = paths.length || 1

      // 计算最长路径的阀门数量
      let maxValveCount = 0
      for (const path of paths) {
        const valveCount = path.filter(id => {
          const device = pumpRoomDevices.find(d => d.id === id)
          return device && (device.type === 'gate_valve' || device.type === 'check_valve')
        }).length
        maxValveCount = Math.max(maxValveCount, valveCount)
      }
      // 存储最长路径的阀门
      for (const path of paths) {
        const valveCount = path.filter(id => {
          const device = pumpRoomDevices.find(d => d.id === id)
          return device && (device.type === 'gate_valve' || device.type === 'check_valve')
        }).length
        if (valveCount === maxValveCount) {
          valvesAfterJunction = path.filter(id => {
            const device = pumpRoomDevices.find(d => d.id === id)
            return device && (device.type === 'gate_valve' || device.type === 'check_valve')
          })
          break
        }
      }
    }
  }

  // W 计算公式（沿通道方向，垂直于泵排列）：
  // W = 墙距管道穿楼板洞的距离 + 弯头距离 + 最小直管段 + 止回阀 + 最小直管段 + 闸阀 + 弯头/三通长度 + 管道距墙的距离
  // 逐项：
  // - 墙距管道穿楼板洞的距离 = pipeToWall_mm
  // - 弯头距离 = L_elbow_m
  // - 最小直管段 = L_str
  // - 止回阀 = L_cv
  // - 最小直管段 = L_str
  // - 闸阀 = L_gv
  // - 弯头/三通长度（三通到总管）= DN_main（简化估算）
  // - 管道距墙的距离 = pipeToWall_mm
  const pipeToWall_m  = pipeToWall_mm  / 1000
  const pipeToPipe_m  = pipeToPipe_mm  / 1000
  const DN_branch_m    = DN_branch      / 1000
  const W_pipe = pipeToWall_m + L_elbow_m + L_str + L_cv + L_str + L_gv + DN_main / 1000 + pipeToWall_m

  // ── 房间净长 L（沿泵排列方向，管道从汇合点到房间边界）────────
  // L 计算公式：
  // L = 墙距管道穿楼板洞的距离 + 弯头距离 + 最小直管段 + 阀门（有几个阀门按实际算）
  //     + 三通长度（汇合到总管的，用DN_main计算）+ 管道距墙的距离
  // 其中 numPipes 表示从汇合点到房间边界的管道数量
  // 汇合点后管道长度 = 按最长路径的实际阀门计算 + 三通用DN_main

  // 计算最长路径的阀门总长度（根据实际阀门类型查表）
  // 三通用DN_main尺寸
  const L_tee_m = DN_main / 1000  // 三通尺寸按总管直径
  let junction_length = L_gv + L_str + L_fm + L_tee_m  // 默认值（含三通）
  if (valvesAfterJunction.length > 0 && topology?.devices) {
    const pumpRoomDevices = topology.devices.filter(d => d.roomId === 'pump_room')
    let totalValveLength = 0
    for (const valveId of valvesAfterJunction) {
      const device = pumpRoomDevices.find(d => d.id === valveId)
      if (device) {
        // 根据阀门类型查表获取尺寸
        if (device.type === 'gate_valve') {
          totalValveLength += lookupFF(GATE_VALVE_FF, DN_branch) / 1000
        } else if (device.type === 'check_valve') {
          totalValveLength += lookupFF(CHECK_VALVE_FF, DN_branch) / 1000
        }
        // 每个阀门后需要直管段（除了最后一个）
        if (valveId !== valvesAfterJunction[valvesAfterJunction.length - 1]) {
          totalValveLength += L_str
        }
      }
    }
    junction_length = totalValveLength + L_fm + L_tee_m  // 加上流量计和三通长度
  }

  // L_pipe = 左侧墙距 + 第一个管道的阀件 + (numPipes-1)个管道的间距 + max(汇合点后管道长度, 右侧墙距)
  const L_pipe = pipeToWall_m + DN_branch_m + (pipeToPipe_m + DN_branch_m) * (numPipes - 1)
                  + Math.max(junction_length, pipeToWall_m)

  // 取管道计算值和泵排列计算值中的较大者
  const L_pumpBased = N_total * w_pump + (N_total - 1) * d_spacing + 2 * e_wall
  const L_raw = Math.max(L_pipe, L_pumpBased)
  const L     = ceilTo01(L_raw)

  // W_pipe 计算（通道方向）
  // 传统 W 计算（下限）
  const W_equip = d_pump + 0.5
  const W_legacy = Math.max(1.2, W_equip) + 0.3

  const W = Math.max(2.5, ceilTo01(Math.max(W_pipe, W_legacy)))

  // ── W 逐项明细 ─────────────────────────────────────────────────
  const W_breakdown = [
    { label: '管外壁到墙面净距', val: pipeToWall_mm, unit: 'mm' },
    { label: '管道宽度 DN_branch', val: DN_branch, unit: 'mm' },
    { label: '相邻管外壁间净距', val: pipeToPipe_mm, unit: 'mm' },
    { label: '汇合点后管道数量', val: numPipes, unit: '条' },
    { label: '汇合点后闸阀', val: lookupFF(GATE_VALVE_FF, DN_branch), unit: 'mm' },
    { label: '汇合点后直管段', val: Math.max(2 * DN_branch, minStraight_mm), unit: 'mm' },
    { label: '汇合点后流量计', val: flowmeterBodyL(DN_main), unit: 'mm' },
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

  rows.push(stepRow('═══════════ 拓扑分析 ═══════════', '', '', ''))
  rows.push(stepRow('管道数量 numPipes', '从汇合点到房间边界的管道数量', `${numPipes}`, '条'))
  rows.push(stepRow('汇合点后阀门数量', '按拓扑实际配置', `${valvesAfterJunction.length}`, '个'))
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

  return {
    w_pump, d_pump, d_spacing, e_wall, L, W, N_total, h_room,
    // 扩展字段（Step 2 新增）
    W_pipe, W_breakdown, sumpFittings,
    hasCatalogDims, DN_branch, DN_main,
    c_wall_m: pipeToWall_m, L_elbow_m: L_elbow_m,
    numPipes,  // 从汇合点到房间边界的管道数量
    junction_length,  // 汇合点以后的管道长度（含阀门）
    valvesAfterJunction,  // 汇合点后的阀门列表（用于AG3-1绘制）
    rows,
  }
}