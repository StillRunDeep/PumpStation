/**
 * AG0-1: 连接关系配置器 — 纯数据模型
 * 无 DOM 依赖，可在 Worker 或 SSR 环境中运行
 *
 * 坐标说明：
 * - canvasX/canvasY: 拓扑编辑器中的视觉坐标（仅用于编辑器渲染）
 * - 物理坐标（physicalX/Y/Z）由空间排布引擎在生成平面图时另行计算
 */

// ═══════════════════════════════════════════════════════════════
// 一、图形元素常量
// ═══════════════════════════════════════════════════════════════

const ROOMS = [
  { id: 'wet_well',  label: '集水坑',    canvasX: 20,  canvasY: 40, editorW: 170, editorH: 320 },
  { id: 'pump_room', label: '泵房维护间', canvasX: 210, canvasY: 40, editorW: 560, editorH: 320 },
]

const DEVICE_LABELS = {
  pump: 'P', check_valve: '止', gate_valve: '闸', flowmeter: 'FM', junction: '汇',
}

const SHAPE = {
  pump:        { r: 26 },
  check_valve: { r: 14 },
  gate_valve:  { halfW: 9 },
  flowmeter:   { r: 18 },
  junction:    { r: 10 },
}

// ═══════════════════════════════════════════════════════════════
// 二、工具函数
// ═══════════════════════════════════════════════════════════════

export function createUidGenerator(start = 1) {
  let _counter = start
  return (prefix) => `${prefix}_${_counter++}`
}

function getNodeRoomId(nodeId, devices, nodes) {
  const device = devices.find(d => d.nodeIds && d.nodeIds.includes(nodeId))
  if (device) return device.roomId
  const node = nodes.find(n => n.id === nodeId)
  if (node) {
    if (node.label === '进水') return 'wet_well'
    if (node.label === '出水') return null
  }
  return null
}

export function cloneTopology(t) {
  return JSON.parse(JSON.stringify(t))
}

// ═══════════════════════════════════════════════════════════════
// 三、拓扑声明式描述
// ═══════════════════════════════════════════════════════════════

/**
 * 泵支路描述（一条支路 = 泵 + 止回阀 + 闸阀）
 * id 前缀相同，节点用 _out/_1/_2 后缀区分
 */
function makeBranchDecl(index, isSpare, N_spare) {
  const prefix = isSpare ? `spare_${index}` : `pump_${index}`
  const spareIdx = index + 1
  const spareLabel = N_spare > 1 ? `${spareIdx}` : ''

  return {
    devices: [
      { id: prefix,             type: 'pump',        label: isSpare ? (N_spare > 1 ? `备${spareIdx}` : '备') : `P${index + 1}`,  roomId: 'wet_well',  isSpare, nodeOffset: SHAPE.pump.r },
      { id: `cv_${index}`,      type: 'check_valve', label: isSpare ? `止备${spareLabel}` : `止${index + 1}`, roomId: 'pump_room', isSpare, nodeOffset: SHAPE.check_valve.r },
      { id: `gv_${index}`,      type: 'gate_valve',  label: isSpare ? `闸备${spareLabel}` : `闸${index + 1}`, roomId: 'pump_room', isSpare, nodeOffset: SHAPE.gate_valve.halfW },
    ],
    pipes: [
      // 进水 → 泵
      { from: 'source',  to: `${prefix}_out` },
      // 泵 → 止回阀
      { from: `${prefix}_out`, to: `cv_${index}_1` },
      // 止回阀 → 闸阀
      { from: `cv_${index}_2`,  to: `gv_${index}_1` },
      // 闸阀 → 汇流
      { from: `gv_${index}_2`,  to: 'junction_1' },
    ],
  }
}

// ═══════════════════════════════════════════════════════════════
// 四、布局参数
// ═══════════════════════════════════════════════════════════════

const PUMP_X   = 130
const CV_X     = 290
const GV_X     = 375
const JUNC_X   = 460
const MAINGV_X = 545
const FM_X     = 630
// 泵房维护间边界（基于ROOMS定义）
const PUMP_ROOM_TOP = ROOMS[1].canvasY                    // 40
const PUMP_ROOM_BOTTOM = PUMP_ROOM_TOP + ROOMS[1].editorH // 360
const PUMP_ROOM_MID = PUMP_ROOM_TOP + ROOMS[1].editorH / 2 // 200
const WET_WELL_Y = 200

// 动态计算泵的行Y坐标，确保所有行都在泵房维护间范围内
function calcRowY(index, totalRows) {
  // 可用高度和边距
  const availableHeight = PUMP_ROOM_BOTTOM - PUMP_ROOM_TOP
  const margin = 20  // 上下边距，确保设备图形不超出边界
  const usableHeight = availableHeight - 2 * margin

  // 计算最大允许行高：确保所有行中心点都在边距范围内
  // 条件：startY + totalRows * ROW_H ≤ PUMP_ROOM_BOTTOM - margin
  // 其中 startY = PUMP_ROOM_TOP + margin + ROW_H/2
  // 推导：ROW_H ≤ usableHeight / (totalRows + 0.5)
  const maxRowHeight = usableHeight / (totalRows + 0.5)

  // 最小行高限制为60px，确保布局不过于紧凑
  const ROW_H = Math.max(60, maxRowHeight)

  // 如果ROW_H仍然超过maxRowHeight（可能发生在泵数量很多时），调整边距
  let actualMargin = margin
  if (ROW_H > maxRowHeight) {
    // 需要减小边距以满足布局
    // 根据 ROW_H ≤ (availableHeight - 2*actualMargin) / (totalRows + 0.5)
    // 解得 actualMargin ≥ (availableHeight - ROW_H * (totalRows + 0.5)) / 2
    const requiredMargin = (availableHeight - ROW_H * (totalRows + 0.5)) / 2
    actualMargin = Math.max(10, requiredMargin) // 最小边距10px
  }

  // 计算起始Y坐标（第一行泵的位置）
  const startY = PUMP_ROOM_TOP + actualMargin + ROW_H / 2

  return startY + index * ROW_H
}

// 计算回流路径（旁通）的Y坐标
function calcReturnY(totalRows) {
  return calcRowY(totalRows, totalRows)
}

// ═══════════════════════════════════════════════════════════════
// 五、拓扑生成
// ═══════════════════════════════════════════════════════════════

/**
 * 生成默认拓扑
 * @param {number} N       工作泵数量
 * @param {number} N_spare 备用泵数量（默认 0）
 * @returns {Topology}
 */
export function generateDefaultTopology(N, N_spare = 0) {
  const uid  = createUidGenerator()
  const total = N + N_spare
  const nodes   = []
  const devices = []
  const pipes   = []
  const nodeIdMap = {}

  function mapId(declId) {
    if (!nodeIdMap[declId]) nodeIdMap[declId] = uid('node')
    return nodeIdMap[declId]
  }

  function addNode(declId, canvasX, canvasY) {
    const id = mapId(declId)
    if (!nodes.find(n => n.id === id)) {
      nodes.push({ id, canvasX, canvasY })
    }
    return id
  }

  function addDevice(decl, canvasX, canvasY) {
    const deviceId = uid(decl.type)
    const nc = decl.type === 'pump' ? 1 : 2
    const nodeIds = []

    for (let k = 0; k < nc; k++) {
      let nodeId, nodeX
      if (decl.type === 'pump') {
        nodeId = mapId(`${decl.id}_out`)
        nodeX = canvasX + SHAPE.pump.r
      } else {
        const suffix = k === 0 ? '_1' : '_2'
        nodeId = mapId(`${decl.id}${suffix}`)
        const sign = k === 0 ? -1 : 1
        nodeX = canvasX + sign * decl.nodeOffset
      }
      if (!nodes.find(n => n.id === nodeId)) {
        nodes.push({ id: nodeId, canvasX: nodeX, canvasY })
      }
      nodeIds.push(nodeId)
    }

    devices.push({
      id: deviceId, type: decl.type, label: decl.label, roomId: decl.roomId,
      canvasX, canvasY, isSpare: decl.isSpare, nodeIds,
    })
  }

  // ── 固定节点：进水、出水 ─────────────────────────────────
  addNode('source',    60, WET_WELL_Y)
  addNode('discharge', 775, WET_WELL_Y)
  const sourceNode = nodes.find(n => n.id === nodeIdMap['source'])
  const dischargeNode = nodes.find(n => n.id === nodeIdMap['discharge'])
  console.log('标签设置前:', { sourceNode, dischargeNode, nodeIdMap })
  if (sourceNode) sourceNode.label = '进水'
  else console.error('未找到进水节点', nodeIdMap['source'], nodes)
  if (dischargeNode) dischargeNode.label = '出水'
  else console.error('未找到出水节点', nodeIdMap['discharge'], nodes)

  // ── 固定设备 ─────────────────────────────────────────────
  const junctionY = calcRowY((total - 1) / 2, total)
  addDevice({ id: 'junction', type: 'junction',  label: '汇',    roomId: 'pump_room', isSpare: false, nodeOffset: SHAPE.junction.r }, JUNC_X, junctionY)
  addDevice({ id: 'mainGv',   type: 'gate_valve', label: '闸4',  roomId: 'pump_room', isSpare: false, nodeOffset: SHAPE.gate_valve.halfW }, MAINGV_X, junctionY)
  addDevice({ id: 'fm',       type: 'flowmeter',  label: '流量计', roomId: 'pump_room', isSpare: false, nodeOffset: SHAPE.flowmeter.r }, FM_X, junctionY)

  // ── 回流路径（旁通）─────────────────────────────────────
  const returnY = calcReturnY(total)
  addDevice({ id: 'returnGv', type: 'gate_valve', label: '闸3', roomId: 'pump_room', isSpare: false, nodeOffset: SHAPE.gate_valve.halfW }, GV_X, returnY)
  addDevice({ id: 'returnCv', type: 'check_valve', label: '止3', roomId: 'pump_room', isSpare: false, nodeOffset: SHAPE.check_valve.r }, CV_X, returnY)

  // ── 泵支路 ──────────────────────────────────────────────
  for (let i = 0; i < N + N_spare; i++) {
    const isSpare = i >= N
    const by = calcRowY(i, total)
    const decl = makeBranchDecl(i, isSpare, N_spare)

    for (const d of decl.devices) {
      let x
      if (d.type === 'pump')      x = PUMP_X
      else if (d.type === 'check_valve') x = CV_X
      else if (d.type === 'gate_valve')  x = GV_X
      addDevice(d, x, by)
    }
  }

  // ── 构建 pipes ──────────────────────────────────────────
  const fixedPipes = [
    // 公共路径
    { from: 'junction_2', to: 'mainGv_1' },
    { from: 'mainGv_2',   to: 'fm_1' },
    { from: 'fm_2',       to: 'discharge' },
    // 回流路径
    { from: 'junction_1', to: 'returnGv_1' },
    { from: 'returnGv_2', to: 'returnCv_1' },
    { from: 'returnCv_2', to: 'source' },
  ]

  const allPipeDescs = [...fixedPipes]

  // 支路 pipes
  for (let i = 0; i < N + N_spare; i++) {
    const isSpare = i >= N
    const decl = makeBranchDecl(i, isSpare, N_spare)
    allPipeDescs.push(...decl.pipes)
  }

  for (const { from, to } of allPipeDescs) {
    const node1 = nodeIdMap[from]
    const node2 = nodeIdMap[to]
    if (!node1 || !node2) {
      console.warn('拓扑生成：管道缺失节点映射', { from, to, node1, node2, nodeIdMap })
      continue
    }

    const r1 = getNodeRoomId(node1, devices, nodes)
    const r2 = getNodeRoomId(node2, devices, nodes)
    const roomIds = [...new Set([r1, r2].filter(r => r != null))]

    pipes.push({ id: uid('pipe'), node1, node2, roomIds })
  }

  return {
    rooms:   ROOMS.map(r => ({ ...r })),
    nodes,
    devices,
    pipes,
    outletWall: 'E',
  }
}

// ═══════════════════════════════════════════════════════════════
// 六、交互动作（不可变，返回新拓扑）
// ═══════════════════════════════════════════════════════════════

export function addDevice(topology, type, roomId) {
  const uid  = createUidGenerator()
  const room = topology.rooms.find(r => r.id === roomId) || topology.rooms[1]
  const existingInRoom = topology.devices.filter(d => d.roomId === roomId)
  const offsetX = (existingInRoom.length % 5) * 50
  const offsetY = Math.floor(existingInRoom.length / 5) * 60

  const newId = uid(type)
  const label = DEVICE_LABELS[type] + newId.split('_').pop()

  const newDevice = {
    id: newId, type, label, nodeIds: [],
    roomId,
    canvasX: room.canvasX + 40 + offsetX,
    canvasY: room.canvasY + 80 + offsetY,
    isSpare: false,
  }

  return {
    ...topology,
    devices: [...topology.devices, newDevice],
  }
}

export function removeDevice(topology, deviceId) {
  const device = topology.devices.find(d => d.id === deviceId)
  if (!device) return topology

  const nodeIdsToRemove = device.nodeIds || []

  return {
    ...topology,
    devices: topology.devices.filter(d => d.id !== deviceId),
    pipes:   topology.pipes.filter(p => !nodeIdsToRemove.includes(p.node1) && !nodeIdsToRemove.includes(p.node2)),
  }
}

export function moveDevice(topology, deviceId, x, y) {
  return {
    ...topology,
    devices: topology.devices.map(d => d.id === deviceId ? { ...d, canvasX: x, canvasY: y } : d),
  }
}

export function moveDeviceToRoom(topology, deviceId, roomId) {
  return {
    ...topology,
    devices: topology.devices.map(d => d.id === deviceId ? { ...d, roomId } : d),
  }
}

export function addPipe(topology, node1Id, node2Id, nodePositions = {}) {
  const uid = createUidGenerator()

  const already = topology.pipes.some(p =>
    (p.node1 === node1Id && p.node2 === node2Id) ||
    (p.node1 === node2Id && p.node2 === node1Id)
  )
  if (already) return topology

  let newNodes = []
  const existingNodeIds = new Set(topology.nodes.map(n => n.id))

  if (!existingNodeIds.has(node1Id)) {
    const pos = nodePositions[node1Id] || { canvasX: 0, canvasY: 0 }
    newNodes.push({ id: node1Id, ...pos })
  }
  if (!existingNodeIds.has(node2Id)) {
    const pos = nodePositions[node2Id] || { canvasX: 0, canvasY: 0 }
    newNodes.push({ id: node2Id, ...pos })
  }

  const r1 = getNodeRoomId(node1Id, topology.devices, topology.nodes)
  const r2 = getNodeRoomId(node2Id, topology.devices, topology.nodes)
  const roomIds = [...new Set([r1, r2].filter(r => r != null))]

  return {
    ...topology,
    nodes: [...topology.nodes, ...newNodes],
    pipes: [...topology.pipes, { id: uid('pipe'), node1: node1Id, node2: node2Id, roomIds }],
  }
}

export function removePipe(topology, pipeId) {
  return { ...topology, pipes: topology.pipes.filter(p => p.id !== pipeId) }
}

export function addNodeToDevice(topology, deviceId, nodeId, canvasX, canvasY) {
  return {
    ...topology,
    nodes: [...topology.nodes, { id: nodeId, canvasX, canvasY }],
    devices: topology.devices.map(d =>
      d.id === deviceId ? { ...d, nodeIds: [...(d.nodeIds || []), nodeId] } : d
    ),
  }
}

// ═══════════════════════════════════════════════════════════════
// 七、输出结构
// ═══════════════════════════════════════════════════════════════

export function topologyToAG31Params(topology) {
  const pumps       = topology.devices.filter(d => d.type === 'pump')
  const checkValves = topology.devices.filter(d => d.type === 'check_valve')
  const gateValves  = topology.devices.filter(d => d.type === 'gate_valve')

  const devicesByRoom = {}
  for (const room of topology.rooms) {
    devicesByRoom[room.id] = topology.devices.filter(d => d.roomId === room.id)
  }

  return {
    pumpsInOrder:  [...pumps].sort((a, b) => a.canvasX - b.canvasX),
    checkValves,
    gateValves,
    devicesByRoom,
    allNodes: [...topology.nodes],
    pipes:    topology.pipes,
  }
}

export function runTopology(topology) {
  if (!topology) {
    return {
      valid: false, errors: ['未找到拓扑数据'], warnings: [],
      stats: {}, byRoom: {}, isolated: [], dischargeReachable: false, topology: null,
    }
  }

  const { nodes, devices, pipes } = topology

  const workingPumps = devices.filter(d => d.type === 'pump' && !d.isSpare)
  const sparePumps   = devices.filter(d => d.type === 'pump' && d.isSpare)
  const checkValves  = devices.filter(d => d.type === 'check_valve')
  const gateValves   = devices.filter(d => d.type === 'gate_valve')

  const byRoom = {}
  for (const room of topology.rooms) {
    byRoom[room.id] = { label: room.label, devices: devices.filter(d => d.roomId === room.id) }
  }

  console.log('拓扑验证节点:', nodes.map(n => ({ id: n.id, label: n.label })))
  const sourceNode    = nodes.find(n => n.label === '进水')
  const dischargeNode = nodes.find(n => n.label === '出水')
  console.log('进水节点:', sourceNode, '出水节点:', dischargeNode)
  const sourceId      = sourceNode?.id
  const dischargeId   = dischargeNode?.id

  const allNodeIds = new Set(nodes.map(n => n.id))
  const adj = {}
  for (const id of allNodeIds) adj[id] = []

  // 设备内部连接：同一设备的节点之间互相连通
  for (const device of devices) {
    const { nodeIds } = device
    if (nodeIds && nodeIds.length > 1) {
      for (let i = 0; i < nodeIds.length; i++) {
        for (let j = i + 1; j < nodeIds.length; j++) {
          const a = nodeIds[i], b = nodeIds[j]
          if (adj[a] && adj[b]) {
            adj[a].push(b)
            adj[b].push(a)
          }
        }
      }
    }
  }

  for (const p of pipes) {
    if (adj[p.node1]) adj[p.node1].push(p.node2)
    if (adj[p.node2]) adj[p.node2].push(p.node1)
  }

  console.log('BFS起点 sourceId:', sourceId, 'dischargeId:', dischargeId)
  const reachable = new Set()
  const queue = [sourceId].filter(Boolean)
  while (queue.length) {
    const cur = queue.shift()
    if (reachable.has(cur)) continue
    reachable.add(cur)
    for (const next of (adj[cur] || [])) {
      if (!reachable.has(next)) queue.push(next)
    }
  }
  console.log('可达节点:', Array.from(reachable))

  const isolated           = devices.filter(d => !d.nodeIds.every(nid => reachable.has(nid)))
  const dischargeReachable = reachable.has(dischargeId)

  const errors   = []
  const warnings = []

  if (!dischargeReachable) errors.push('出水口不可达：存在断路，请检查连线')
  if (workingPumps.length === 0) errors.push('没有工作泵，请至少添加一台水泵')
  for (const d of isolated) {
    warnings.push(`设备「${d.label}」未连入拓扑（孤立节点）`)
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      N_working:    workingPumps.length,
      N_spare:      sparePumps.length,
      N_checkValve: checkValves.length,
      N_gateValve:  gateValves.length,
    },
    byRoom,
    isolated,
    dischargeReachable,
    topology,
  }
}

// ═══════════════════════════════════════════════════════════════
// 八、导出
// ═══════════════════════════════════════════════════════════════

export { ROOMS }
