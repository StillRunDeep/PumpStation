/**
 * AG0-1: 交互式拓扑编辑器
 * 原生 SVG DOM 操作（不依赖 SVG.js），事件委托。
 */

import {
  generateDefaultTopology, cloneTopology,
  addDevice, removeDevice, moveDevice, moveDeviceToRoom,
  addPipe, removePipe,
  ROOMS,
} from '../agents/topology.js'

// ── 模块状态 ─────────────────────────────────────────────────────────
let _topology     = null
let _svgEl        = null
let _selected     = null    // node id, device id, 或 pipe id
let _connectMode  = false
let _connectFrom  = null
let _dragging     = null    // { nodeId, offsetX, offsetY }
let _ghostLine    = null    // SVG line element for connect preview
let _onConfirm    = () => {}
let _outletWall   = 'E'     // 出水口朝向：'N'|'S'|'E'|'W'

// 画布 viewBox 尺寸
const VW = 800, VH = 400

// ── 节点形状尺寸 ─────────────────────────────────────────────────────────
const NODE_SHAPES = {
  pump:       { w: 52, h: 34 },
  check_valve:{ r: 14 },        // 菱形半径
  gate_valve: { s: 18 },        // 正方形边长
  source:     { r: 18 },        // 圆
  discharge:  { r: 18 },
  junction:   { r: 10 },        // 汇流点小圆
  flowmeter:  { r: 18 },        // 电磁流量计圆
}

function nodeHalfSize(node) {
  const sh = NODE_SHAPES[node.type]
  if (!sh) return { hw: 18, hh: 18 }
  if (sh.w) return { hw: sh.w / 2, hh: sh.h / 2 }
  const r = sh.r || sh.s / 2 || 10
  return { hw: r, hh: r }
}

// ── SVG 坐标转换 ──────────────────────────────────────────────────────
function svgPoint(e) {
  const pt = _svgEl.createSVGPoint()
  pt.x = e.clientX
  pt.y = e.clientY
  return pt.matrixTransform(_svgEl.getScreenCTM().inverse())
}

// ── 公开 API ──────────────────────────────────────────────────────────

export function initTopologyEditor(containerId, onConfirmCallback) {
  _onConfirm = onConfirmCallback || (() => {})
  const wrap = document.getElementById(containerId)
  if (!wrap) return

  wrap.innerHTML = `
    <div class="topo-toolbar" id="topo-toolbar">
      <button class="topo-btn" data-action="add-cv">＋ 止回阀</button>
      <button class="topo-btn" data-action="add-gv">＋ 电动闸阀</button>
      <button class="topo-btn" data-action="add-fm">＋ 电磁流量计</button>
      <button class="topo-btn" data-action="add-node">＋ 节点</button>
      <button class="topo-btn danger" data-action="delete-selected">删除选中</button>
      <button class="topo-btn" id="btn-connect-mode" data-action="toggle-connect">连线模式</button>
      <button class="topo-btn" data-action="reset">↺ 重置</button>
      <span style="margin-left:12px;font-size:11px;color:#666;vertical-align:middle">出水口方向：</span>
      <span id="outlet-dir-btns" style="display:inline-flex;gap:3px;vertical-align:middle">
        <button class="topo-btn outlet-dir-btn ${_outletWall === 'N' ? 'active' : ''}" data-outlet-dir="N" title="北墙出水">↑ 北</button>
        <button class="topo-btn outlet-dir-btn ${_outletWall === 'S' ? 'active' : ''}" data-outlet-dir="S" title="南墙出水">↓ 南</button>
        <button class="topo-btn outlet-dir-btn ${_outletWall === 'E' ? 'active' : ''}" data-outlet-dir="E" title="东墙出水（默认）">→ 东</button>
        <button class="topo-btn outlet-dir-btn ${_outletWall === 'W' ? 'active' : ''}" data-outlet-dir="W" title="西墙出水">← 西</button>
      </span>
    </div>
    <svg id="svg-ag01" viewBox="0 0 ${VW} ${VH}" xmlns="http://www.w3.org/2000/svg"></svg>
    <p style="font-size:11px;color:#999;margin-top:6px">点击「开始计算」即可应用当前拓扑</p>
  `

  _svgEl = document.getElementById('svg-ag01')

  // 添加 arrowhead marker
  _svgEl.insertAdjacentHTML('afterbegin', `
    <defs>
      <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="#95a5a6"/>
      </marker>
      <marker id="arrow-sel" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="#e74c3c"/>
      </marker>
      <marker id="arrow-ghost" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="#3498db"/>
      </marker>
    </defs>
  `)

  _bindToolbar()
  _bindSvgEvents()
  _render()
}

export function setTopologyFromN(N, N_spare = 0) {
  _topology  = generateDefaultTopology(N, N_spare)
  _selected  = null
  _connectMode = false
  _connectFrom = null
  if (_svgEl) _render()
}

export function getCurrentTopology() {
  return _topology ? cloneTopology(_topology) : null
}

export function getOutletWall() {
  return _outletWall
}

export function setOutletWall(wall) {
  _outletWall = wall
  _updateOutletDirButtons()
}

function _updateOutletDirButtons() {
  document.querySelectorAll('.outlet-dir-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.outletDir === _outletWall)
  })
}

// ── Toolbar ───────────────────────────────────────────────────────────
function _bindToolbar() {
  document.getElementById('topo-toolbar').addEventListener('click', e => {
    // 出水方向按钮
    const dirBtn = e.target.closest('[data-outlet-dir]')
    if (dirBtn) {
      _outletWall = dirBtn.dataset.outletDir
      _updateOutletDirButtons()
      _onConfirm()
      return
    }

    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const action = btn.dataset.action
    if (action === 'add-cv')       { _topology = addDevice(_topology, 'check_valve', 'pump_room'); _render() }
    if (action === 'add-gv')       { _topology = addDevice(_topology, 'gate_valve', 'pump_room'); _render() }
    if (action === 'add-fm')       { _topology = addDevice(_topology, 'flowmeter', 'pump_room'); _render() }
    if (action === 'add-node')     { _topology = _addJunctionNode(_topology); _render() }
    if (action === 'delete-selected') _deleteSelected()
    if (action === 'toggle-connect')  _toggleConnectMode()
    if (action === 'reset') {
      const N = _topology.devices.filter(d => d.type === 'pump' && !d.isSpare).length || 2
      setTopologyFromN(N)
    }
  })
}

// 添加独立节点（汇流节点等）
function _addJunctionNode(topology) {
  const room = topology.rooms.find(r => r.id === 'pump_room')
  const existingNodes = topology.nodes
  const offsetX = (existingNodes.length % 5) * 50
  const offsetY = Math.floor(existingNodes.length / 5) * 60
  const nodeId = `node_${Date.now()}`
  const newNode = {
    id: nodeId,
    label: '汇',
    canvasX: room.canvasX + 200 + offsetX,
    canvasY: room.canvasY + 100 + offsetY,
  }
  return { ...topology, nodes: [...topology.nodes, newNode] }
}

function _deleteSelected() {
  if (!_selected) return
  // pipe
  if (_topology.pipes.find(p => p.id === _selected)) {
    _topology = removePipe(_topology, _selected)
  }
  // node
  else if (_topology.nodes.find(n => n.id === _selected)) {
    // 删除节点时同时删除关联的 pipes
    const pipesToRemove = _topology.pipes.filter(p => p.node1 === _selected || p.node2 === _selected)
    let t = _topology
    for (const p of pipesToRemove) {
      t = removePipe(t, p.id)
    }
    t = { ...t, nodes: t.nodes.filter(n => n.id !== _selected) }
    // 同时删除以该节点关联的设备（如果有）
    const deviceWithNode = t.devices.find(d => d.nodeIds && d.nodeIds.includes(_selected))
    if (deviceWithNode) {
      const newNodeIds = deviceWithNode.nodeIds.filter(id => id !== _selected)
      t = {
        ...t,
        devices: t.devices.map(d =>
          d.id === deviceWithNode.id ? { ...d, nodeIds: newNodeIds } : d
        ),
      }
    }
    _topology = t
  }
  // device
  else if (_topology.devices.find(d => d.id === _selected)) {
    _topology = removeDevice(_topology, _selected)
  }
  _selected = null
  _render()
}

function _toggleConnectMode() {
  _connectMode = !_connectMode
  _connectFrom = null
  _ghostLine   = null
  const btn = document.getElementById('btn-connect-mode')
  if (btn) {
    btn.classList.toggle('active', _connectMode)
    btn.textContent = _connectMode ? '✕ 取消连线' : '连线模式'
  }
  _svgEl.style.cursor = _connectMode ? 'crosshair' : 'default'
  _render()
}

// ── SVG 事件 ──────────────────────────────────────────────────────────
function _bindSvgEvents() {
  _svgEl.addEventListener('mousedown', _onMouseDown)
  _svgEl.addEventListener('mousemove', _onMouseMove)
  _svgEl.addEventListener('mouseup',   _onMouseUp)
  _svgEl.addEventListener('mouseleave',_onMouseUp)
  document.addEventListener('keydown', e => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && _selected) {
      _deleteSelected()
    }
    if (e.key === 'Escape' && _connectMode) _toggleConnectMode()
  })
}

function _onMouseDown(e) {
  const pt = svgPoint(e)

  // 连线模式：点击设备（使用设备的第一个 nodeId）
  if (_connectMode) {
    const deviceId = _hitTestDevice(pt.x, pt.y)
    if (deviceId) {
      const device = _topology.devices.find(d => d.id === deviceId)
      if (device && device.nodeIds && device.nodeIds.length > 0) {
        const nodeId = device.nodeIds[0]  // 使用设备的第一个节点
        if (!_connectFrom) {
          _connectFrom = nodeId
        } else if (_connectFrom !== nodeId) {
          _topology = addPipe(_topology, _connectFrom, nodeId)
          _connectFrom = null
          _ghostLine   = null
          _toggleConnectMode()
        }
      }
    }
    return
  }

  // 普通模式：选中 device、labeled node 或 pipe
  const deviceId = _hitTestDevice(pt.x, pt.y)
  if (deviceId) {
    const device = _topology.devices.find(d => d.id === deviceId)
    if (device) {
      _selected = deviceId
      // 记录拖拽起始状态和所有节点的偏移量
      const nodeOffsets = (device.nodeIds || []).map(nid => {
        const node = _topology.nodes.find(n => n.id === nid)
        return { nodeId: nid, ox: node.canvasX, oy: node.canvasY }
      })
      _dragging = {
        deviceId,
        offsetX: pt.x - device.canvasX,
        offsetY: pt.y - device.canvasY,
        originX: device.canvasX,
        originY: device.canvasY,
        nodeOffsets,
      }
      _render()
    }
    return
  }

  const nodeId = _hitTestNode(pt.x, pt.y)
  if (nodeId) {
    const node = _topology.nodes.find(n => n.id === nodeId)
    if (node && node.label) {
      _selected = nodeId
      _dragging = { nodeId, offsetX: pt.x - node.canvasX, offsetY: pt.y - node.canvasY }
      _render()
    }
    return
  }

  const pipeId = _hitTestPipe(pt.x, pt.y)
  if (pipeId) {
    _selected = pipeId
    _dragging = null
    _render()
    return
  }

  // 点击空白：取消选中
  _selected = null
  _dragging = null
  _render()
}

function _onMouseMove(e) {
  const pt = svgPoint(e)

  // 连线预览
  if (_connectMode && _connectFrom) {
    const ghost = _svgEl.getElementById('ghost-line')
    const fromNode = _allNodes().find(n => n.id === _connectFrom)
    if (fromNode) {
      if (ghost) {
        ghost.setAttribute('x1', fromNode.canvasX)
        ghost.setAttribute('y1', fromNode.canvasY)
        ghost.setAttribute('x2', pt.x)
        ghost.setAttribute('y2', pt.y)
      } else {
        const line = _makeSvgEl('line', {
          id: 'ghost-line',
          x1: fromNode.canvasX, y1: fromNode.canvasY, x2: pt.x, y2: pt.y,
          stroke: '#3498db', 'stroke-width': 1.5, 'stroke-dasharray': '5,3',
          'marker-end': 'url(#arrow-ghost)',
        })
        _svgEl.appendChild(line)
      }
    }
    return
  }

  // 拖拽设备：只更新视觉 transform，不动数据
  if (_dragging && _dragging.deviceId) {
    const { deviceId, offsetX, offsetY, originX, originY, nodeOffsets } = _dragging
    let nx = pt.x - offsetX
    let ny = pt.y - offsetY
    nx = Math.max(10, Math.min(VW - 10, nx))
    ny = Math.max(10, Math.min(VH - 10, ny))

    const dx = nx - originX
    const dy = ny - originY

    // 设备 transform
    const g = _svgEl.querySelector(`[data-device-id="${deviceId}"]`)
    if (g) {
      g.setAttribute('transform', `translate(${dx},${dy})`)
    }

    // 更新关联的 pipes
    if (nodeOffsets) {
      for (const { nodeId, ox, oy } of nodeOffsets) {
        _updatePipePositions(nodeId, ox + dx, oy + dy)
      }
    }
  }

  // 拖拽节点（包括汇流节点）：只更新视觉 transform
  if (_dragging && _dragging.nodeId) {
    const { nodeId, offsetX, offsetY, originX, originY } = _dragging
    let nx = pt.x - offsetX
    let ny = pt.y - offsetY
    nx = Math.max(10, Math.min(VW - 10, nx))
    ny = Math.max(10, Math.min(VH - 10, ny))

    const dx = nx - originX
    const dy = ny - originY

    // 节点 transform
    const g = _svgEl.querySelector(`[data-device-id="${nodeId}"]`)
    if (g) {
      g.setAttribute('transform', `translate(${dx},${dy})`)
    }

    // 更新关联的 pipes
    _updatePipePositions(nodeId, nx, ny)
  }
}

function _onMouseUp(e) {
  if (_dragging && _dragging.deviceId) {
    const { deviceId, originX, originY, nodeOffsets } = _dragging
    const g = _svgEl.querySelector(`[data-device-id="${deviceId}"]`)
    if (g) {
      const transform = g.getAttribute('transform')
      const match = transform?.match(/translate\(([^,]+),([^)]+)\)/)
      if (match) {
        const dx = parseFloat(match[1])
        const dy = parseFloat(match[2])
        const nx = originX + dx
        const ny = originY + dy
        _topology = {
          ..._topology,
          devices: _topology.devices.map(d =>
            d.id === deviceId ? { ...d, canvasX: nx, canvasY: ny } : d
          ),
          nodes: _topology.nodes.map(n => {
            const off = nodeOffsets?.find(o => o.nodeId === n.id)
            if (off) {
              return { ...n, canvasX: off.ox + dx, canvasY: off.oy + dy }
            }
            return n
          }),
        }
      }
    }
  }
  if (_dragging && _dragging.nodeId) {
    const { nodeId, originX, originY } = _dragging
    const g = _svgEl.querySelector(`[data-device-id="${nodeId}"]`)
    if (g) {
      const transform = g.getAttribute('transform')
      const match = transform?.match(/translate\(([^,]+),([^)]+)\)/)
      if (match) {
        const dx = parseFloat(match[1])
        const dy = parseFloat(match[2])
        _topology = {
          ..._topology,
          nodes: _topology.nodes.map(n =>
            n.id === nodeId ? { ...n, canvasX: originX + dx, canvasY: originY + dy } : n
          ),
        }
      }
    }
  }
  _dragging = null
  _render()
}

// ── 碰撞检测 ──────────────────────────────────────────────────────────
function _allNodes() {
  return _topology ? _topology.nodes : []
}

function _allDevices() {
  return _topology ? _topology.devices : []
}

function _hitTestDevice(x, y) {
  const devices = _allDevices()
  for (const d of devices) {
    if (d.type === 'pump') {
      const hw = 26, hh = 17
      if (Math.abs(x - d.canvasX) <= hw + 4 && Math.abs(y - d.canvasY) <= hh + 4) {
        return d.id
      }
    } else if (d.type === 'check_valve' || d.type === 'gate_valve') {
      const r = NODE_SHAPES[d.type]?.r || 14
      if (Math.abs(x - d.canvasX) <= r + 4 && Math.abs(y - d.canvasY) <= r + 4) {
        return d.id
      }
    } else if (d.type === 'flowmeter' || d.type === 'junction') {
      const r = NODE_SHAPES[d.type]?.r || 10
      const dist = Math.hypot(x - d.canvasX, y - d.canvasY)
      if (dist <= r + 4) {
        return d.id
      }
    }
  }
  return null
}

function _hitTestNode(x, y) {
  // 只检测有标签的节点
  const nodes = _allNodes().filter(n => n.label)
  for (const n of nodes) {
    const r = 10
    if (Math.abs(x - n.canvasX) <= r + 4 && Math.abs(y - n.canvasY) <= r + 4) {
      return n.id
    }
  }
  return null
}

function _hitTestPipe(x, y, thresh = 6) {
  if (!_topology) return null
  const nodes = _allNodes()
  for (const pipe of _topology.pipes) {
    const from = nodes.find(n => n.id === pipe.node1)
    const to   = nodes.find(n => n.id === pipe.node2)
    if (!from || !to) continue
    if (_pointToSegDist(x, y, from.canvasX, from.canvasY, to.canvasX, to.canvasY) < thresh) {
      return pipe.id
    }
  }
  return null
}

function _pointToSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - x1, py - y1)
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function _detectRoom(x, y) {
  if (!_topology) return null
  for (const room of _topology.rooms) {
    if (x >= room.canvasX && x <= room.canvasX + room.editorW &&
        y >= room.canvasY && y <= room.canvasY + room.editorH) {
      return room.id
    }
  }
  return null
}

// ── Pipe 位置更新（拖拽中轻量更新）────────────────────────────────────────
function _updatePipePositions(nodeId, nx, ny) {
  if (!_topology) return
  for (const pipe of _topology.pipes) {
    const line = _svgEl.querySelector(`[data-pipe-id="${pipe.id}"]`)
    if (!line) continue
    if (pipe.node1 === nodeId) {
      line.setAttribute('x1', nx); line.setAttribute('y1', ny)
    }
    if (pipe.node2 === nodeId) {
      line.setAttribute('x2', nx); line.setAttribute('y2', ny)
    }
  }
}

// ── 全量渲染 ──────────────────────────────────────────────────────────
function _render() {
  if (!_svgEl || !_topology) return

  // 保留 defs
  const defs = _svgEl.querySelector('defs')
  _svgEl.innerHTML = ''
  if (defs) _svgEl.appendChild(defs)

  // 1. 房间背景
  for (const room of _topology.rooms) {
    _svgEl.appendChild(_makeRoom(room))
  }

  // 2. Pipes（线）- 直接从设备边缘的节点位置画出
  const allNodes = _allNodes()
  for (const pipe of _topology.pipes) {
    const from = allNodes.find(n => n.id === pipe.node1)
    const to   = allNodes.find(n => n.id === pipe.node2)
    if (!from || !to) continue
    const isSel = _selected === pipe.id
    const line = _makeSvgEl('line', {
      'data-pipe-id': pipe.id,
      x1: from.canvasX, y1: from.canvasY,
      x2: to.canvasX,   y2: to.canvasY,
      stroke: isSel ? '#e74c3c' : '#95a5a6',
      'stroke-width': isSel ? 2.5 : 1.5,
      style: 'cursor:pointer',
    })
    _svgEl.appendChild(line)
  }

  // 3. 有标签的节点（进水、出水、汇）显示小圆点
  for (const node of _topology.nodes) {
    if (node.label) {
      _svgEl.appendChild(_makeNode(node))
    }
  }

  // 4. 设备（形状）- 拖拽时用 transform 跟随
  for (const device of _topology.devices) {
    const g = _makeDevice(device)
    // 如果设备正在被拖拽，用 liveX/liveY 计算 transform
    if (_dragging && _dragging.deviceId === device.id && _dragging.liveX !== undefined) {
      const dx = _dragging.liveX - device.canvasX
      const dy = _dragging.liveY - device.canvasY
      g.setAttribute('transform', `translate(${dx},${dy})`)
    }
    _svgEl.appendChild(g)
  }
}

function _makeRoom(room) {
  const g = _makeSvgEl('g', {})
  const isWetWell = room.id === 'wet_well'
  const rect = _makeSvgEl('rect', {
    x: room.canvasX, y: room.canvasY, width: room.editorW, height: room.editorH,
    fill: isWetWell ? '#d6eaf8' : '#eaf2fb',
    stroke: isWetWell ? '#2471a3' : '#2c3e50',
    'stroke-width': 1.5,
    'stroke-dasharray': isWetWell ? '6,3' : 'none',
    rx: 4,
  })
  const label = _makeSvgEl('text', {
    x: room.canvasX + 8,
    y: room.canvasY + 20,
    'font-size': 14,
    fill: isWetWell ? '#2471a3' : '#2c3e50',
    'font-weight': 'bold',
    'pointer-events': 'none',
  })
  label.textContent = room.label
  g.appendChild(rect)
  g.appendChild(label)
  return g
}

// 渲染节点（小圆/连接点）
function _makeNode(node) {
  // 推断 type
  const type = node.type ||
    (node.label === '进水' ? 'source' :
     node.label === '出水' ? 'discharge' :
     node.label === '汇' ? 'junction' : 'junction')

  const g = _makeSvgEl('g', {
    'data-device-id': node.id,
    style: 'cursor:move',
  })
  const isSel = _selected === node.id

  if (type === 'source' || type === 'discharge') {
    const r = NODE_SHAPES[type].r
    g.appendChild(_makeSvgEl('circle', {
      cx: node.canvasX, cy: node.canvasY, r,
      fill: '#117a65', stroke: '#0e6655', 'stroke-width': 1.5,
    }))
    g.appendChild(_makeLabel(node.canvasX, node.canvasY + 5, node.label, '#fff', 11))
  } else {
    // junction 或其他节点
    const r = NODE_SHAPES.junction.r
    g.appendChild(_makeSvgEl('circle', {
      cx: node.canvasX, cy: node.canvasY, r,
      fill: isSel ? '#2980b9' : '#2c3e50', stroke: '#1a252f', 'stroke-width': 1.5,
    }))
    if (node.label) {
      g.appendChild(_makeLabel(node.canvasX, node.canvasY + r + 13, node.label, '#555', 11))
    }
  }

  return g
}

// 渲染设备（形状）
function _makeDevice(device) {
  const g = _makeSvgEl('g', {
    'data-device-id': device.id,
    style: 'cursor:move',
  })
  const isSel = _selected === device.id

  if (device.type === 'pump') {
    const sh = NODE_SHAPES.pump
    const fill = device.isSpare ? '#7f8c8d' : '#2471a3'
    const stroke = device.isSpare ? '#566573' : '#1a5276'
    g.appendChild(_makeSvgEl('rect', {
      x: device.canvasX - sh.w / 2, y: device.canvasY - sh.h / 2,
      width: sh.w, height: sh.h,
      fill, stroke, 'stroke-width': isSel ? 2.5 : 1.5,
      rx: 3,
    }))
    if (isSel) {
      g.appendChild(_makeSvgEl('rect', {
        x: device.canvasX - sh.w / 2 - 3, y: device.canvasY - sh.h / 2 - 3,
        width: sh.w + 6, height: sh.h + 6,
        fill: 'none', stroke: '#2980b9', 'stroke-width': 2,
        'stroke-dasharray': '3,2', rx: 5,
      }))
    }
    g.appendChild(_makeLabel(device.canvasX, device.canvasY + 5, device.label, '#fff', 12))
  }

  else if (device.type === 'check_valve') {
    const r = NODE_SHAPES.check_valve.r
    const pts = `${device.canvasX},${device.canvasY - r} ${device.canvasX + r},${device.canvasY} ${device.canvasX},${device.canvasY + r} ${device.canvasX - r},${device.canvasY}`
    g.appendChild(_makeSvgEl('polygon', {
      points: pts, fill: '#e74c3c', stroke: '#c0392b',
      'stroke-width': isSel ? 2.5 : 1,
    }))
    g.appendChild(_makeLabel(device.canvasX, device.canvasY + r + 13, device.label, '#555', 11))
  }

  else if (device.type === 'gate_valve') {
    const s = NODE_SHAPES.gate_valve.s
    g.appendChild(_makeSvgEl('rect', {
      x: device.canvasX - s / 2, y: device.canvasY - s / 2,
      width: s, height: s,
      fill: '#e74c3c', stroke: '#c0392b',
      'stroke-width': isSel ? 2.5 : 1,
    }))
    g.appendChild(_makeLabel(device.canvasX, device.canvasY + s / 2 + 13, device.label, '#555', 11))
  }

  else if (device.type === 'flowmeter') {
    const r = NODE_SHAPES.flowmeter.r
    g.appendChild(_makeSvgEl('circle', {
      cx: device.canvasX, cy: device.canvasY, r,
      fill: '#8e44ad', stroke: '#6c3483',
      'stroke-width': isSel ? 2.5 : 1.5,
    }))
    g.appendChild(_makeLabel(device.canvasX, device.canvasY + 5, 'FM', '#fff', 11))
    g.appendChild(_makeLabel(device.canvasX, device.canvasY + r + 13, device.label, '#555', 11))
  }

  else if (device.type === 'junction') {
    const r = NODE_SHAPES.junction.r
    g.appendChild(_makeSvgEl('circle', {
      cx: device.canvasX, cy: device.canvasY, r,
      fill: '#f39c12', stroke: '#d68910',
      'stroke-width': isSel ? 2.5 : 1.5,
    }))
    g.appendChild(_makeLabel(device.canvasX, device.canvasY + r + 13, device.label, '#555', 11))
  }

  return g
}

function _makeLabel(x, y, text, fill, fontSize) {
  const t = _makeSvgEl('text', {
    x, y, 'font-size': fontSize, fill,
    'text-anchor': 'middle', 'pointer-events': 'none',
  })
  t.textContent = text
  return t
}

function _makeSvgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}
