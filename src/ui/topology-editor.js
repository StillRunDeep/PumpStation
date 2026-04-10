/**
 * AG0-1: 交互式拓扑编辑器
 * 原生 SVG DOM 操作（不依赖 SVG.js），事件委托。
 */

import {
  generateDefaultTopology, cloneTopology,
  addDevice, removeDevice, moveDevice, moveDeviceToRoom,
  addEdge, removeEdge,
  FIXED_NODES,
} from '../agents/topology.js'

// ── 模块状态 ─────────────────────────────────────────────────────────
let _topology     = null
let _svgEl        = null
let _selected     = null    // device id 或 edge id
let _connectMode  = false
let _connectFrom  = null
let _dragging     = null    // { deviceId, offsetX, offsetY }
let _ghostLine    = null    // SVG line element for connect preview
let _onConfirm    = () => {}

// 画布 viewBox 尺寸
const VW = 800, VH = 400

// ── 节点尺寸 ─────────────────────────────────────────────────────────
const NODE_SHAPES = {
  pump:       { w: 52, h: 34 },
  check_valve:{ r: 14 },        // 菱形半径
  gate_valve: { s: 18 },        // 正方形边长
  source:     { r: 18 },        // 圆
  discharge:  { r: 18 },
  junction:   { r: 10 },        // 汇流点小圆
  flowmeter:  { r: 18 },        // 电磁流量计圆
}

function nodeCenter(node) {
  return { x: node.editorX, y: node.editorY }
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
      <button class="topo-btn" data-action="add-junc">＋ 汇流节点</button>
      <button class="topo-btn danger" data-action="delete-selected">删除选中</button>
      <button class="topo-btn" id="btn-connect-mode" data-action="toggle-connect">连线模式</button>
      <button class="topo-btn" data-action="reset">↺ 重置</button>
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

// ── Toolbar ───────────────────────────────────────────────────────────
function _bindToolbar() {
  document.getElementById('topo-toolbar').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const action = btn.dataset.action
    if (action === 'add-cv')       { _topology = addDevice(_topology, 'check_valve', 'pump_room'); _render() }
    if (action === 'add-gv')       { _topology = addDevice(_topology, 'gate_valve', 'pump_room'); _render() }
    if (action === 'add-fm')       { _topology = addDevice(_topology, 'flowmeter', 'pump_room'); _render() }
    if (action === 'add-junc')     { _topology = addDevice(_topology, 'junction', 'pump_room'); _render() }
    if (action === 'delete-selected') _deleteSelected()
    if (action === 'toggle-connect')  _toggleConnectMode()
    if (action === 'reset') {
      const N = _topology.devices.filter(d => d.type === 'pump' && !d.isSpare).length || 3
      setTopologyFromN(N)
    }
  })
}

function _deleteSelected() {
  if (!_selected) return
  // 判断是 edge 还是 device
  if (_topology.edges.find(e => e.id === _selected)) {
    _topology = removeEdge(_topology, _selected)
  } else if (_topology.devices.find(d => d.id === _selected)) {
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

  // 连线模式：点击节点
  if (_connectMode) {
    const nodeId = _hitTestNode(pt.x, pt.y)
    if (nodeId) {
      if (!_connectFrom) {
        _connectFrom = nodeId
      } else if (_connectFrom !== nodeId) {
        _topology = addEdge(_topology, _connectFrom, nodeId)
        _connectFrom = null
        _ghostLine   = null
        _toggleConnectMode()
      }
    }
    return
  }

  // 普通模式：选中 device 或 edge
  const deviceId = _hitTestNode(pt.x, pt.y)
  if (deviceId) {
    const device = _allNodes().find(n => n.id === deviceId)
    if (device && !device.fixed) {
      _selected = deviceId
      _dragging = { deviceId, offsetX: pt.x - device.editorX, offsetY: pt.y - device.editorY }
      _render()
    }
    return
  }
  const edgeId = _hitTestEdge(pt.x, pt.y)
  if (edgeId) {
    _selected = edgeId
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
    const from = _allNodes().find(n => n.id === _connectFrom)
    if (from) {
      if (ghost) {
        ghost.setAttribute('x1', from.editorX)
        ghost.setAttribute('y1', from.editorY)
        ghost.setAttribute('x2', pt.x)
        ghost.setAttribute('y2', pt.y)
      } else {
        const line = _makeSvgEl('line', {
          id: 'ghost-line',
          x1: from.editorX, y1: from.editorY, x2: pt.x, y2: pt.y,
          stroke: '#3498db', 'stroke-width': 1.5, 'stroke-dasharray': '5,3',
          'marker-end': 'url(#arrow-ghost)',
        })
        _svgEl.appendChild(line)
      }
    }
    return
  }

  // 拖拽：只更新被拖节点的位移（轻量，不全量重渲）
  if (_dragging) {
    const { deviceId, offsetX, offsetY } = _dragging
    let nx = pt.x - offsetX
    let ny = pt.y - offsetY
    // 限制在画布内
    nx = Math.max(10, Math.min(VW - 10, nx))
    ny = Math.max(10, Math.min(VH - 10, ny))
    // 找到对应 <g> 元素直接移动
    const g = _svgEl.querySelector(`[data-device-id="${deviceId}"]`)
    if (g) {
      // 更新 data 属性以便 mouseup 时读取
      g.dataset.liveX = nx
      g.dataset.liveY = ny
      g.setAttribute('transform', `translate(${nx - _topology.devices.find(d => d.id === deviceId).editorX}, ${ny - _topology.devices.find(d => d.id === deviceId).editorY})`)
      // 同步更新 edge 位置
      _updateEdgePositions(deviceId, nx, ny)
    }
  }
}

function _onMouseUp(e) {
  if (_dragging) {
    const { deviceId } = _dragging
    const g = _svgEl.querySelector(`[data-device-id="${deviceId}"]`)
    let nx = parseFloat(g?.dataset.liveX)
    let ny = parseFloat(g?.dataset.liveY)
    if (!isNaN(nx) && !isNaN(ny)) {
      // 检测落入哪个房间
      const newRoom = _detectRoom(nx, ny)
      _topology = moveDevice(_topology, deviceId, nx, ny)
      if (newRoom) _topology = moveDeviceToRoom(_topology, deviceId, newRoom)
    }
    _dragging = null
    _render()
  }
}

// ── 碰撞检测 ──────────────────────────────────────────────────────────
function _allNodes() {
  return [...FIXED_NODES, ...(_topology ? _topology.devices : [])]
}

function _hitTestNode(x, y) {
  const nodes = _allNodes()
  for (const n of nodes) {
    const { hw, hh } = nodeHalfSize(n)
    if (Math.abs(x - n.editorX) <= hw + 4 && Math.abs(y - n.editorY) <= hh + 4) {
      return n.id
    }
  }
  return null
}

function _hitTestEdge(x, y, thresh = 6) {
  if (!_topology) return null
  const nodes = _allNodes()
  for (const edge of _topology.edges) {
    const from = nodes.find(n => n.id === edge.fromId)
    const to   = nodes.find(n => n.id === edge.toId)
    if (!from || !to) continue
    if (_pointToSegDist(x, y, from.editorX, from.editorY, to.editorX, to.editorY) < thresh) {
      return edge.id
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
  for (const room of _topology.rooms) {
    if (x >= room.editorX && x <= room.editorX + room.editorW &&
        y >= room.editorY && y <= room.editorY + room.editorH) {
      return room.id
    }
  }
  return null
}

// ── 边位置更新（拖拽中轻量更新）────────────────────────────────────────
function _updateEdgePositions(deviceId, nx, ny) {
  if (!_topology) return
  for (const edge of _topology.edges) {
    let line
    if (edge.fromId === deviceId) {
      line = _svgEl.querySelector(`[data-edge-id="${edge.id}"]`)
      if (line) { line.setAttribute('x1', nx); line.setAttribute('y1', ny) }
    }
    if (edge.toId === deviceId) {
      line = _svgEl.querySelector(`[data-edge-id="${edge.id}"]`)
      if (line) { line.setAttribute('x2', nx); line.setAttribute('y2', ny) }
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

  // 2. 边
  const allNodes = _allNodes()
  for (const edge of _topology.edges) {
    const from = allNodes.find(n => n.id === edge.fromId)
    const to   = allNodes.find(n => n.id === edge.toId)
    if (!from || !to) continue
    const isSel = _selected === edge.id
    const line = _makeSvgEl('line', {
      'data-edge-id': edge.id,
      x1: from.editorX, y1: from.editorY,
      x2: to.editorX,   y2: to.editorY,
      stroke: isSel ? '#e74c3c' : '#95a5a6',
      'stroke-width': isSel ? 2.5 : 1.5,
      'marker-end': `url(#${isSel ? 'arrow-sel' : 'arrow'})`,
      style: 'cursor:pointer',
    })
    _svgEl.appendChild(line)
  }

  // 3. 固定节点
  for (const node of FIXED_NODES) {
    _svgEl.appendChild(_makeNode(node))
  }

  // 4. 设备节点
  for (const device of _topology.devices) {
    _svgEl.appendChild(_makeNode(device))
  }

  // 5. 连线预览残留清理（会被重渲覆盖）
}

function _makeRoom(room) {
  const g = _makeSvgEl('g', {})
  const isWetWell = room.id === 'wet_well'
  const rect = _makeSvgEl('rect', {
    x: room.editorX, y: room.editorY, width: room.editorW, height: room.editorH,
    fill: isWetWell ? '#d6eaf8' : '#eaf2fb',
    stroke: isWetWell ? '#2471a3' : '#2c3e50',
    'stroke-width': 1.5,
    'stroke-dasharray': isWetWell ? '6,3' : 'none',
    rx: 4,
  })
  const label = _makeSvgEl('text', {
    x: room.editorX + 8,
    y: room.editorY + 20,
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

function _makeNode(node) {
  const g = _makeSvgEl('g', {
    'data-device-id': node.id,
    style: node.fixed ? 'cursor:default' : 'cursor:move',
  })
  const isSel = _selected === node.id
  const selStroke = isSel ? '#2980b9' : null

  if (node.type === 'pump') {
    const sh = NODE_SHAPES.pump
    const fill = node.isSpare ? '#7f8c8d' : '#2471a3'
    const stroke = node.isSpare ? '#566573' : '#1a5276'
    g.appendChild(_makeSvgEl('rect', {
      x: node.editorX - sh.w / 2, y: node.editorY - sh.h / 2,
      width: sh.w, height: sh.h,
      fill, stroke, 'stroke-width': isSel ? 2.5 : 1.5,
      rx: 3,
    }))
    if (isSel) {
      g.appendChild(_makeSvgEl('rect', {
        x: node.editorX - sh.w / 2 - 3, y: node.editorY - sh.h / 2 - 3,
        width: sh.w + 6, height: sh.h + 6,
        fill: 'none', stroke: selStroke, 'stroke-width': 2,
        'stroke-dasharray': '3,2', rx: 5,
      }))
    }
    g.appendChild(_makeLabel(node.editorX, node.editorY + 5, node.label, '#fff', 12))
  }

  else if (node.type === 'check_valve') {
    const r = NODE_SHAPES.check_valve.r
    const pts = `${node.editorX},${node.editorY - r} ${node.editorX + r},${node.editorY} ${node.editorX},${node.editorY + r} ${node.editorX - r},${node.editorY}`
    g.appendChild(_makeSvgEl('polygon', {
      points: pts, fill: '#e74c3c', stroke: '#c0392b',
      'stroke-width': isSel ? 2.5 : 1,
    }))
    g.appendChild(_makeLabel(node.editorX, node.editorY + r + 13, node.label, '#555', 11))
  }

  else if (node.type === 'gate_valve') {
    const s = NODE_SHAPES.gate_valve.s
    g.appendChild(_makeSvgEl('rect', {
      x: node.editorX - s / 2, y: node.editorY - s / 2,
      width: s, height: s,
      fill: '#e74c3c', stroke: '#c0392b',
      'stroke-width': isSel ? 2.5 : 1,
    }))
    g.appendChild(_makeLabel(node.editorX, node.editorY + s / 2 + 13, node.label, '#555', 11))
  }

  else if (node.type === 'junction') {
    const r = NODE_SHAPES.junction.r
    g.appendChild(_makeSvgEl('circle', {
      cx: node.editorX, cy: node.editorY, r,
      fill: isSel ? '#2980b9' : '#2c3e50', stroke: '#1a252f', 'stroke-width': 1.5,
    }))
  }

  else if (node.type === 'flowmeter') {
    const r = NODE_SHAPES.flowmeter.r
    g.appendChild(_makeSvgEl('circle', {
      cx: node.editorX, cy: node.editorY, r,
      fill: '#8e44ad', stroke: '#6c3483',
      'stroke-width': isSel ? 2.5 : 1.5,
    }))
    g.appendChild(_makeLabel(node.editorX, node.editorY + 5, 'FM', '#fff', 11))
    g.appendChild(_makeLabel(node.editorX, node.editorY + r + 13, node.label, '#555', 11))
  }

  else if (node.type === 'source' || node.type === 'discharge') {
    const r = NODE_SHAPES.source.r
    g.appendChild(_makeSvgEl('circle', {
      cx: node.editorX, cy: node.editorY, r,
      fill: '#117a65', stroke: '#0e6655', 'stroke-width': 1.5,
    }))
    g.appendChild(_makeLabel(node.editorX, node.editorY + 5, node.label, '#fff', 11))
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
