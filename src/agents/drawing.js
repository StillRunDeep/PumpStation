import { fmt } from '../utils.js'
import {
  _r, _l, _t, _poly, _dh, _dv,
  _elbow, _checkValve, _gateValve, _flowmeter, _tee, _leader,
  _reducer,
} from '../render/svg-helpers.js'
import { initSvgZoomPan } from '../render/zoom-pan.js'
import {
  GATE_VALVE_FF, CHECK_VALVE_FF,
  elbowCTF, flowmeterBodyL, lookupFF,
} from '../data/fitting-dims.js'

/**
 * AG3-1：设备流线二维示意
 *
 * @param {number} N - 工作泵台数
 * @param {Object} ag21 - AG2-1 输出 { L, W, d_spacing, e_wall, w_pump, d_pump, N_total, hasCatalogDims, DN_branch, DN_main, c_wall_m, L_elbow_m, DN_label }
 * @param {Object} params - AG1-1 输出 { h_pool, h_active, Z_stop, Z_start1, Z_alarm_high }
 * @param {number} S - 集水坑面积（m²）
 * @param {Object|null} topology - AG0-1 拓扑
 * @param {Object} extraInfo - 扩展信息 { Q_single, H_design, P_motor, catalogPump, Z_sump }
 */

// ═══════════════════════════════════════════════════════════════════════════
// ── 1. 输入参数解析 ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

function parseInputs(N, ag21, params, S, _topology, extraInfo) {
  const {
    L, W, d_spacing = 1.0, e_wall = 0.8, w_pump, d_pump, N_total, h_room,
    hasCatalogDims, DN_branch = 150, DN_main = 300, DN_label = DN_main,
    c_wall_m = 0, L_elbow_m = 0,
    valvesAfterJunction = [],
  } = ag21
  const { h_pool, h_active, Z_stop: stopLevel, Z_start1: startLevel, Z_start2, Z_alarm_high: alarmLevel, Z_alarm_low, Z_max } = params
  const { Q_single, H_design, P_motor, catalogPump, Z_sump } = extraInfo

  const L_pool = Math.max(L, Math.sqrt(S * 1.5))
  const D_pool = S / L_pool
  const room_H = h_room || Math.max(3.5, d_pump + 2.0)

  // Z_top = 顶板标高 = 停泵水位 + 池深
  const Z_top = stopLevel + h_pool

  return {
    N, L, W, d_spacing, e_wall, w_pump, d_pump, N_total, h_room,
    hasCatalogDims, DN_branch, DN_main, DN_label, c_wall_m, L_elbow_m,
    valvesAfterJunction,
    h_pool, h_active, stopLevel, startLevel, Z_start2, alarmLevel, Z_alarm_low, Z_max,
    Q_single, H_design, P_motor, catalogPump, Z_sump,
    L_pool, D_pool, room_H, Z_top,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 2. 几何计算（SCALE 系统）────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} Geo
 * @property {number} SCALE_MAIN  - 主平面图比例（像素/米）
 * @property {number} SCALE_MINI  - 鹰眼缩略图比例（像素/米）
 * @property {number} PW          - 平面图宽度
 * @property {number} PH          - 平面图高度
 * @property {number} pool_ox     - 集水池左上角 X
 * @property {number} pool_oy     - 集水池左上角 Y
 * @property {number} pool_x2     - 集水池右下角 X
 * @property {number} pool_y2     - 集水池右下角 Y
 * @property {number} room_ox    - 机房左上角 X
 * @property {number} room_oy    - 机房左上角 Y
 * @property {number} room_x2    - 机房右下角 X
 * @property {number} room_y2    - 机房右下角 Y
 * @property {number} hdr_y      - 主管（梳脊）Y 坐标
 * @property {number} SX0        - 剖面图起始 X
 * @property {number} SW          - 剖面图宽度
 * @property {number} sec_cx     - 剖面图中心 X
 * @property {number} Z_top_px - 池顶 Y（剖面图）
 * @property {number} pool_bot_y - 池底 Y（剖面图）
 * @property {number} ss         - 剖面图比例（像素/米）
 * @property {number} SCALE_SEC    - 维护间比例（像素/米）
 * @property {number} Z_top_px   - Z_top 对应的像素 Y
 */

/**
 * @param {Object} inputs
 * @returns {Geo}
 */
function computeGeometry(inputs) {
  const { L, W, D_pool, L_pool, h_pool, room_H, Z_top, stopLevel } = inputs

  // ─── 主平面图尺寸与比例尺 ───
  const PW = 500, PH = 560
  const PML = 50, PMR = 30, PMT = 60, PMB = 40

  // SCALE_MAIN：只聚焦机房(L,W)，加 1m 余量防止贴边
  const SCALE_MAIN = Math.min((PW - PML - PMR) / (L + 1), (PH - PMT - PMB) / (W + 1))

  // 机房坐标（居中对齐）
  const room_ox = PML + (PW - PML - PMR - L * SCALE_MAIN) / 2
  const room_oy = PMT
  const room_x2 = room_ox + L * SCALE_MAIN
  const room_y2 = room_oy + W * SCALE_MAIN

  // 梳脊（主管）Y 坐标：画在机房内部，靠近顶部，预留 0.8m 物理距离
  const hdr_y = room_oy + (0.8 * SCALE_MAIN)

  // 集水池坐标（水池在机房下方 Y 轴正方向相接）
  const pool_ox = room_ox - (L_pool - L) / 2 * SCALE_MAIN
  const pool_oy = room_y2
  const pool_x2 = pool_ox + L_pool * SCALE_MAIN
  const pool_y2 = pool_oy + D_pool * SCALE_MAIN

  // ─── 鹰眼缩略图比例尺 ───
  const MINI_SIZE = 150
  const MINI_MARGIN = 10
  const max_physical_width = Math.max(L, L_pool)
  const total_physical_depth = W + D_pool
  const SCALE_MINI = Math.min(
    (MINI_SIZE - 2 * MINI_MARGIN) / max_physical_width,
    (MINI_SIZE - 2 * MINI_MARGIN) / total_physical_depth
  )

  // ─── 剖面图（Z 轴统一比例尺）───
  const SX0 = 540, SW = 450
  const SML = 50, SMR = 40, SMT = 40, SMB = 50
  const sec_cx = SX0 + SML + (SW - SML - SMR) / 2

  // 物理总高度 = 地上机房净高 + 地下池深
  const total_physical_height = room_H + h_pool
  const available_screen_height = PH - SMT - SMB
  const SCALE_SEC = available_screen_height / (total_physical_height + 1)

  // Z_top 基准线像素坐标（屏幕 Y 轴朝下，所以 Z-top 线 = 顶部留白 + 机房高度）
  const Z_top_px = SMT + (room_H * SCALE_SEC)

  // 池底像素坐标 = Z_top 基准线向下走（地下深度 × 比例尺）
  const pool_bot_y = Z_top_px + (h_pool * SCALE_SEC)

  // 剖面图水平范围（独立坐标系，不复用平面图 room_ox/room_x2）
  // 使用与 Z 轴一致的比例尺，限定在可用宽度内
  const sec_avail_w = SW - SML - SMR  // 可用水平像素 ≈ 360
  const sec_pool_w_px = Math.min(L * SCALE_SEC, sec_avail_w)
  const sec_left = sec_cx - sec_pool_w_px / 2
  const sec_right = sec_cx + sec_pool_w_px / 2

  return {
    SCALE_MAIN, SCALE_MINI, SCALE_SEC, PW, PH,
    pool_ox, pool_oy, pool_x2, pool_y2,
    room_ox, room_oy, room_x2, room_y2,
    hdr_y, MINI_SIZE, MINI_MARGIN,
    SX0, SW, sec_cx, Z_top_px, pool_bot_y,
    Z_top, stopLevel,
    sec_left, sec_right,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 3. 鹰眼缩略图 (完美空间对齐版) ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {Object} inputs
 * @param {Geo} geo
 * @returns {string} SVG string
 */
function buildMinimap(inputs, geo) {
  const { L, W, D_pool, L_pool } = inputs;
  const { SCALE_MINI, MINI_SIZE, MINI_MARGIN } = geo;

  let s = '';

  // 缩略图容器起点（左上角）
  const mini_ox = MINI_MARGIN;
  const mini_oy = MINI_MARGIN;

  // 1. 转换所有组件的微缩物理尺寸
  const mini_room_w = L * SCALE_MINI;
  const mini_room_h = W * SCALE_MINI;
  const mini_pool_w = L_pool * SCALE_MINI;
  const mini_pool_h = D_pool * SCALE_MINI;

  // 2. 计算整个建筑群（机房+水池）的总包络盒尺寸
  // 宽度取机房和水池中最宽的一个，高度是两者上下拼接之和
  const total_w = Math.max(mini_room_w, mini_pool_w);
  const total_h = mini_room_h + mini_pool_h; 

  // 3. 将【总包络盒】在 150x150 的缩略图容器内绝对居中
  const start_x = MINI_MARGIN + (MINI_SIZE - 2 * MINI_MARGIN - total_w) / 2;
  const start_y = MINI_MARGIN + (MINI_SIZE - 2 * MINI_MARGIN - total_h) / 2;

  // 4. 根据总包络盒的起点，计算各自的绝对坐标 (保持 X轴居中对齐，Y轴上下拼接)
  const mini_room_x = start_x + (total_w - mini_room_w) / 2;
  const mini_room_y = start_y; // 机房在上方

  const mini_pool_x = start_x + (total_w - mini_pool_w) / 2;
  const mini_pool_y = start_y + mini_room_h; // 水池紧贴在机房正下方

  // 5. 绘制图形
  // 白色实心底板（防止被下方管线穿透干扰）
  s += _r(mini_ox - 2, mini_oy - 2, MINI_SIZE + 4, MINI_SIZE + 4, '#fff', '#ccc', 0.5);

  // 画水池 (浅蓝色填充)
  s += _r(mini_pool_x, mini_pool_y, mini_pool_w, mini_pool_h, '#f8fbff', '#2980b9', 1);
  // 画机房 (透明底，深色虚线框，避免挡住重叠部分)
  s += _r(mini_room_x, mini_room_y, mini_room_w, mini_room_h, 'rgba(255,255,255,0.7)', '#2471a3', 1.5, 'stroke-dasharray="3,2"');

  // 6. 极简文字标注 (字号调小，颜色调淡，避免喧宾夺主)
  // 水池标注
  const pool_center_x = mini_pool_x + mini_pool_w / 2;
  const pool_center_y = mini_pool_y + mini_pool_h / 2;
  s += _t(pool_center_x, pool_center_y, '集水池', 10, '#2980b9', 'middle', 'bold');
  s += _t(pool_center_x, mini_pool_y + mini_pool_h + 10, `${fmt(L_pool, 1)} x ${fmt(D_pool, 1)}m`, 8, '#7f8c8d', 'middle');

  // 机房标注 (如果机房太小就不写字了，防重叠)
  if (mini_room_h > 15) {
    const room_center_x = mini_room_x + mini_room_w / 2;
    const room_center_y = mini_room_y + mini_room_h / 2;
    s += _t(room_center_x, room_center_y + 3, '机房', 9, '#2471a3', 'middle');
  }

  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 4. 拓扑驱动的梳齿布局 ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {Object} topology
 * @param {Geo} geo
 * @param {Object} inputs
 * @returns {Object|null} layoutMap
 */
function buildLayoutMap(topology, geo, inputs) {
  if (!topology) return null

  const { devices, nodes, pipes } = topology
  const { SCALE_MAIN, room_ox, room_x2, room_y2, hdr_y } = geo
  const { DN_branch, DN_main, e_wall, w_pump, d_spacing, N_total } = inputs

  // 建立邻接表
  const adj = {}
  for (const n of nodes) adj[n.id] = []
  for (const p of pipes) {
    adj[p.node1]?.push(p.node2)
    adj[p.node2]?.push(p.node1)
  }

  // 找关键设备
  const pumps = devices.filter(d => d.type === 'pump' && d.roomId === 'wet_well')
    .sort((a, b) => (a.canvasX || 0) - (b.canvasX || 0))

  const junction = devices.find(d => d.type === 'junction')
  const sourceNode = nodes.find(n => n.label === '进水')
  const sinkNode = nodes.find(n => n.label === '出水')

  // 水泵 X 坐标（沿 X 轴等距排列）
  const firstPumpX = room_ox + e_wall * SCALE_MAIN + w_pump * SCALE_MAIN / 2
  const pumpXs = pumps.map((_, i) => firstPumpX + i * (w_pump + d_spacing) * SCALE_MAIN)

  // 最小直管段
  const minStr_px = Math.max(2 * DN_branch, 300) / 1000 * SCALE_MAIN

  // ── 主分支（每泵一个梳齿）──────────────────────────────────────────
  const branches = pumps.map((pump, i) => {
    const pumpOutNodeId = pump.nodeIds?.[0]
    const junctionInNodeId = junction?.nodeIds?.[0]

    // BFS 找到从泵出口到汇流点入口的路径 (顺序: 止回阀 -> 闸阀)
    const path = tracePath(pumpOutNodeId, [junctionInNodeId], adj)
    const chainDevices = path
      .map(nodeId => devices.find(d => d.nodeIds?.includes(nodeId)))
      .filter(Boolean)

    const items = []
    
    // 【核心修复】：从穿楼板处(底部)开始，向梳脊(上方)逆推 Y 坐标！
    let curY = room_y2 
    
    // 弯头（水泵穿上来后的第一个转向件）
    const elbow_r = elbowCTF(DN_branch) / 1000 * SCALE_MAIN * 0.5
    curY -= elbow_r * 2  // 向上移动，越过弯头占据的空间

    chainDevices.forEach(dev => {
      const hl = deviceHalfLen(dev, DN_branch, SCALE_MAIN)
      curY -= minStr_px + hl // 向上移动：跨过直管段和阀门的下半部分
      items.push({ device: dev, planX: pumpXs[i], planY: curY, halfLen: hl })
      curY -= hl // 向上移动：跨过阀门的上半部分，准备迎接下一个设备
    })

    // 泵本身依然记在坑底
    const pump_y = room_y2 + 10
    items.push({ device: pump, planX: pumpXs[i], planY: pump_y, halfLen: 0, isPump: true })

    return items
  })

  // ── 旁通分支 ─────────────────────────────────────────────────────────
  const bypass_y = hdr_y + 40  // 旁通管在主梳脊下方
  const junctionInNodeId = junction?.nodeIds?.[0]
  const bypassPath = sourceNode ? tracePath(sourceNode.id, [junctionInNodeId], adj) : []
  const bypassDevices = bypassPath
    .map(nodeId => devices.find(d => d.nodeIds?.includes(nodeId)))
    .filter(Boolean)

  let bypass_x = room_ox + e_wall * SCALE_MAIN
  const bypassChain = bypassDevices.map(dev => {
    const hl = deviceHalfLen(dev, DN_branch, SCALE_MAIN)
    bypass_x += minStr_px + hl
    const item = { device: dev, planX: bypass_x, planY: bypass_y, halfLen: hl }
    bypass_x += hl
    return item
  })

  // ── 主管阀门链（汇流点出口 → 出水口）─────────────────────────────────
  const junctionOutNodeId = junction?.nodeIds?.[junction.nodeIds.length - 1]
  const mainPath = sinkNode ? tracePath(junctionOutNodeId, [sinkNode.id], adj) : []
  const mainDevices = mainPath
    .map(nodeId => devices.find(d => d.nodeIds?.includes(nodeId)))
    .filter(Boolean)

  const minStr_main = Math.max(2 * DN_main, 300) / 1000 * SCALE_MAIN
  const mainStartX = Math.max(...pumpXs) + w_pump * SCALE_MAIN / 2 + e_wall * SCALE_MAIN
  let mainCurX = mainStartX
  const mainChain = mainDevices.map(dev => {
    const hl = deviceHalfLen(dev, DN_main, SCALE_MAIN)
    mainCurX += minStr_main + hl
    const item = { device: dev, planX: mainCurX, planY: hdr_y, halfLen: hl }
    mainCurX += hl
    return item
  })

  return { branches, bypassChain, mainChain, pumpXs, hdr_y, bypass_y }
}

/**
 * BFS 路径追踪
 */
function tracePath(startNodeId, endNodeIds, adj) {
  if (!startNodeId) return []
  const endSet = new Set(endNodeIds?.filter(Boolean) || [])
  if (endSet.size === 0) return []

  const visited = new Set()
  const queue = [[startNodeId, []]]

  while (queue.length) {
    const [cur, path] = queue.shift()
    if (visited.has(cur)) continue
    visited.add(cur)

    if (endSet.has(cur)) return path

    for (const next of (adj[cur] || [])) {
      if (!visited.has(next)) queue.push([next, [...path, next]])
    }
  }
  return []
}

/**
 * 计算设备半长（像素）
 */
function deviceHalfLen(device, dn, scale) {
  if (!device) return 0
  if (device.type === 'check_valve') return lookupFF(CHECK_VALVE_FF, dn) / 1000 * scale / 2
  if (device.type === 'gate_valve') return lookupFF(GATE_VALVE_FF, dn) / 1000 * scale / 2
  if (device.type === 'flowmeter') return flowmeterBodyL(dn) / 1000 * scale / 2
  if (device.type === 'pump') return 0
  if (device.type === 'junction') return 0
  return 0
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 5. 主平面图 ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {Object} inputs
 * @param {Geo} geo
 * @param {Object|null} layoutMap
 * @returns {{ s: string }}
 */
function buildPlanView(inputs, geo, layoutMap) {
  const {
    L, W, d_spacing, e_wall, w_pump, d_pump, N_total,
    hasCatalogDims, DN_branch, DN_label,
    L_pool, D_pool,
    Q_single, H_design, P_motor,
    pumpsInOrder,
  } = inputs

  const { SCALE_MAIN, PW, PH, pool_ox, pool_x2, pool_oy, pool_y2,
          room_ox, room_oy, room_x2, room_y2, hdr_y } = geo
  // bypass_y 来自 layoutMap（不在 geo 中）
  const bypass_y = layoutMap?.bypass_y ?? (hdr_y + 40)

  let s = ''

  // 背景
  s += _r(0, 0, PW, PH, '#fafafa', 'none')

  // 标题
  s += _t(PW / 2, 25, '平 面 图', 12, '#1a5276', 'middle', 'bold')

  // ── 集水池 ──────────────────────────────────────────────────────────
  s += _r(pool_ox, pool_oy, L_pool * SCALE_MAIN, D_pool * SCALE_MAIN, '#f8fbff', '#2980b9', 2)
  const pcx = (pool_ox + pool_x2) / 2
  const pcy = pool_oy + D_pool * SCALE_MAIN / 2
  s += _t(pcx, pcy, '集水池', 11, '#2980b9', 'middle', 'bold')

  // ── 集水坑（坑口范围示意）─────────────────────────────────────────────
  // 平面图中只标注机房正下方的坑口轮廓，高度约为水泵深度 + 1m 余量，不覆盖整个集水池
  const sump_h = Math.max(d_pump + 1.0, 3.0) * SCALE_MAIN
  s += _r(room_ox, room_y2, room_x2 - room_ox, sump_h, '#dbeeff', '#2471a3', 1.5, 'stroke-dasharray="4,2"')
  const scx = (room_ox + room_x2) / 2
  s += _t(scx, room_y2 + sump_h / 2 + 3, '集水坑', 9, '#2471a3', 'middle')

  // ── 机房虚线框 ──────────────────────────────────────────────────────
  s += _r(room_ox, room_oy, L * SCALE_MAIN, W * SCALE_MAIN, 'none', '#2980b9', 1.5, 'stroke-dasharray="6,3"')

  // ── 梳脊（主管）────────────────────────────────────────────────────
  s += _l(room_ox + e_wall * SCALE_MAIN, hdr_y, room_x2 - e_wall * SCALE_MAIN, hdr_y, '#2980b9', 2.5)
  s += _t(room_ox + e_wall * SCALE_MAIN + 5, hdr_y - 5, `DN${DN_label} 出水总管`, 9, '#2980b9', 'start')

  // ── 主管阀门（汇流点右侧）──────────────────────────────────────────
  if (layoutMap?.mainChain?.length) {
    for (const { device, planX, planY, halfLen } of layoutMap.mainChain) {
      const hl = halfLen
      if (device.type === 'gate_valve') {
        s += `<g class="valve-group" data-type="总闸阀" data-dn="${DN_branch}">`
        s += _gateValve(planX, planY, hl, true, '#c0392b')
        s += '</g>'
      } else if (device.type === 'check_valve') {
        s += `<g class="valve-group" data-type="总止回阀" data-dn="${DN_branch}">`
        s += _checkValve(planX, planY, hl, true, '#c0392b')
        s += '</g>'
      } else if (device.type === 'flowmeter') {
        const r_main = DN_main / 1000 * SCALE_MAIN
        s += `<g class="valve-group" data-type="流量计" data-dn="${DN_branch}">`
        s += _flowmeter(planX, planY, hl, r_main / 2, true, '#c0392b')
        s += '</g>'
      }
    }
  }

  // ── 梳齿（分支管路）─────────────────────────────────────────────────
  const L_elb_px = elbowCTF(DN_branch) / 1000 * SCALE_MAIN

  for (let i = 0; i < N_total; i++) {
    const topoP = pumpsInOrder?.[i]
    const isSpare = topoP ? !!topoP.isSpare : (i === N_total - 1)
    const label = topoP ? topoP.label : (isSpare ? '备' : 'P' + (i + 1))

    // 水泵
    const pw = (hasCatalogDims && topoP
      ? (topoP.pump?.dimensions_mm?.b || w_pump) / 1000
      : w_pump) * SCALE_MAIN
    const ph = (hasCatalogDims && topoP
      ? (topoP.pump?.dimensions_mm?.a || d_pump) / 1000
      : d_pump) * SCALE_MAIN

    const pumpX = layoutMap?.pumpXs?.[i] || (room_ox + e_wall * SCALE_MAIN + w_pump * SCALE_MAIN / 2 + i * (w_pump + d_spacing) * SCALE_MAIN)
    const pumpY = room_y2 + ph / 2 + 6

    s += `<g class="pump-group" data-pump="${label}" data-q="${Q_single || ''}" data-h="${H_design || ''}" data-kw="${P_motor || ''}">`
    s += _r(pumpX - pw / 2, pumpY - ph / 2, pw, ph, '#2471a3', '#1a5276', 1.5)
    s += _t(pumpX, pumpY + 3, label, Math.max(8, pw * 0.4), '#fff', 'middle', 'bold')
    s += '</g>'

    // 穿层孔洞
    s += `<circle cx="${pumpX.toFixed(1)}" cy="${room_y2.toFixed(1)}" r="5" fill="none" stroke="#2980b9" stroke-width="1.5" stroke-dasharray="3,2"/>`

    // 支管（如果 layoutMap 有数据，用动态布局）
    const branch = layoutMap?.branches?.[i]
    if (branch && branch.length > 0) {
      // 从楼板孔洞开始画
      let lastY = room_y2

      // 画第一个弯头（90°转向）
      const elbow_r = L_elb_px * 0.5
      s += _elbow(pumpX, lastY, elbow_r, 'bottom', 'right', '#2980b9', 1.5)
      lastY -= elbow_r * 2 // 更新画笔位置到了弯头上边缘

      for (const { device, planX, planY, halfLen } of branch) {
        if (device.isPump) continue  // 泵已在上方绘制

        // 画连接上一个点到当前阀门中心的直线
        s += _l(planX, lastY, planX, planY, '#2980b9', 1.5)

        // 画阀门符号
        if (device.type === 'check_valve') {
          s += `<g class="valve-group" data-type="止回阀" data-dn="${DN_branch}">`
          s += _checkValve(planX, planY, halfLen, false, '#c0392b')
          s += '</g>'
        } else if (device.type === 'gate_valve') {
          s += `<g class="valve-group" data-type="闸阀" data-dn="${DN_branch}">`
          s += _gateValve(planX, planY, halfLen, false, '#c0392b')
          s += '</g>'
        }

        // 更新画笔位置为当前阀门的中心（下一条线会从这里继续往上画）
        lastY = planY
      }

      // 所有的阀门画完后，把最后一点线头连到上方的梳脊总管
      s += _l(pumpX, lastY, pumpX, hdr_y, '#2980b9', 1.5)
    }
  }

  // ── 旁通管 ──────────────────────────────────────────────────────────
  if (layoutMap?.bypassChain?.length) {
    const bp_left = room_ox + e_wall * SCALE_MAIN
    const bp_right = room_x2 - e_wall * SCALE_MAIN
    s += _l(bp_left, bypass_y, bp_right, bypass_y, '#2980b9', 1.5)
    s += _l(bp_right, hdr_y, bp_right, bypass_y, '#2980b9', 1.5)
    s += _l(bp_left, hdr_y, bp_left, bypass_y, '#2980b9', 1.5)
    s += _t((bp_left + bp_right) / 2, bypass_y - 6, '旁通管', 9, '#2980b9', 'middle')

    for (const { device, planX, planY, halfLen } of layoutMap.bypassChain) {
      if (device.type === 'gate_valve') {
        s += `<g class="valve-group" data-type="旁通闸阀" data-dn="${DN_branch}">`
        s += _gateValve(planX, planY, halfLen, true, '#c0392b')
        s += '</g>'
      } else if (device.type === 'check_valve') {
        s += `<g class="valve-group" data-type="旁通止回阀" data-dn="${DN_branch}">`
        s += _checkValve(planX, planY, halfLen, true, '#c0392b')
        s += '</g>'
      }
    }
  }

  // ── 尺寸标注 ────────────────────────────────────────────────────────
  const dim_by = pool_y2 + 20
  s += _dh(room_ox, room_x2, dim_by, 'L=' + fmt(L, 1) + 'm', '#1a3a5c')
  if (Math.abs(L_pool - L) > 0.05) {
    s += _dh(pool_ox, pool_x2, dim_by + 18, 'L_pool=' + fmt(L_pool, 1) + 'm', '#2471a3')
  }
  const dim_rx = pool_x2 + 20
  s += _dv(dim_rx, room_oy, room_y2, 'W=' + fmt(W, 1) + 'm', '#1a3a5c')

  // ── 图例（左下角，左上角留给鹰眼缩略图）──────────────────────────────────
  const legItems = [['#2471a3', '水泵'], ['#2980b9', '管道'], ['#c0392b', '阀门'], ['#f8fbff', '集水池']]
  const legX = 8, legY = PH - 80
  s += _r(legX, legY, 90, legItems.length * 14 + 6, '#fff', '#ccc', 0.8, 'rx="3" opacity="0.9"')
  let lyi = legY + 4
  for (const [c, lbl] of legItems) {
    s += _r(legX + 4, lyi, 8, 8, c, '#666', 0.5)
    s += _t(legX + 15, lyi + 7, lbl, 8, '#333', 'start')
    lyi += 14
  }

  // 比例尺
  const bar_len = SCALE_MAIN
  const bx = room_ox
  const by_bar = pool_y2 + 8
  s += _l(bx, by_bar, bx + bar_len, by_bar, '#333', 2)
  s += _l(bx, by_bar - 3, bx, by_bar + 3, '#333', 1.5)
  s += _l(bx + bar_len, by_bar - 3, bx + bar_len, by_bar + 3, '#333', 1.5)
  s += _t(bx + bar_len / 2, by_bar - 5, '1m', 9, '#333')

  return { s, SCALE_MAIN, PW, PH }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 6. 剖面图 ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {Object} inputs
 * @param {Geo} geo
 * @param {Object} planData
 * @returns {{ s: string }}
 */
function buildSectionView(inputs, geo) {
  const {
    L, h_pool, stopLevel, startLevel, Z_start2, alarmLevel, Z_alarm_low, Z_max,
    DN_branch, DN_main, room_H, Z_sump,
    pumpsInOrder,
  } = inputs

  // 剖面图使用独立水平坐标 sec_left/sec_right，不复用平面图坐标
  const { SX0, SW, sec_cx, Z_top_px, pool_bot_y, SCALE_SEC, Z_top,
          sec_left, sec_right } = geo
  const SMT = 40  // 剖面图顶部留白（与 computeGeometry 保持一致）

  let s = ''

  // 背景
  s += _r(SX0, 0, SW, 560, '#fafafa', 'none')

  // 标题
  s += _t(SX0 + SW / 2, 25, 'A-A 剖 面 图', 12, '#1a5276', 'middle', 'bold')

  // ── 维护间 ──────────────────────────────────────────────────────────
  s += _r(sec_left, SMT, sec_right - sec_left, room_H * SCALE_SEC, '#f8fbff', '#2980b9', 2.5)

  // ── Z_top 分割线 ───────────────────────────────────────────────────
  const z_top_y = Z_top_px  // Z_top = 池顶
  s += _l(SX0 + 4, z_top_y, SX0 + SW - 4, z_top_y, '#1a5276', 3)  // 粗线
  s += _t(SX0 + SW / 2, z_top_y - 8, `Z_top = ${fmt(Z_top, 2)}m`, 10, '#1a5276', 'middle', 'bold')

  // ── 水池 ──────────────────────────────────────────────────────────
  s += _l(sec_left, Z_top_px, sec_left, pool_bot_y, '#2980b9', 2)
  s += _l(sec_right, Z_top_px, sec_right, pool_bot_y, '#2980b9', 2)
  s += _l(sec_left, pool_bot_y, sec_right, pool_bot_y, '#2980b9', 2)
  s += _l(sec_left, Z_top_px, sec_right, Z_top_px, '#2980b9', 1)

  // 水位填充（以池底 stopLevel 为基准）
  const stop_y = pool_bot_y
  const start_y = pool_bot_y - (startLevel - stopLevel) * SCALE_SEC
  const start2_y = pool_bot_y - ((Z_start2 != null ? Z_start2 : alarmLevel) - stopLevel) * SCALE_SEC
  const alarm_y = pool_bot_y - (alarmLevel - stopLevel) * SCALE_SEC
  const max_y = pool_bot_y - ((Z_max != null ? Z_max : alarmLevel) - stopLevel) * SCALE_SEC
  const alarm_low_y = pool_bot_y - ((Z_alarm_low != null ? Z_alarm_low : stopLevel) - stopLevel) * SCALE_SEC

  const water_top = max_y
  if (water_top < pool_bot_y) {
    s += _r(sec_left, water_top, sec_right - sec_left, pool_bot_y - water_top, '#d6eaf8', 'none')
  }

  // ── 集水坑 ─────────────────────────────────────────────────────────
  const Z_sumpVal = (Z_sump != null && !isNaN(Z_sump)) ? Z_sump : stopLevel
  if (Z_sumpVal < stopLevel - 0.01) {
    const sump_bot_y = pool_bot_y + (stopLevel - Z_sumpVal) * SCALE_SEC
    s += _l(sec_cx - 30, sump_bot_y, sec_cx + 30, sump_bot_y, '#2980b9', 1.5)
    s += _l(sec_cx - 30, sump_bot_y, sec_cx - 30, pool_bot_y, '#2980b9', 1.5)
    s += _l(sec_cx + 30, sump_bot_y, sec_cx + 30, pool_bot_y, '#2980b9', 1.5)
    s += _t(sec_cx, (sump_bot_y + pool_bot_y) / 2, '集水坑', 9, '#2980b9', 'middle', 'bold')
  }

  // ── 水位线标注 ────────────────────────────────────────────────────
  const wl_len = (sec_right - sec_left) * 0.08
  const wl_lx_left = sec_left - 6
  const wl_lx_right = sec_right + 6

  function spreadWL(items) {
    const sorted = [...items].sort((a, b) => a.lineY - b.lineY)
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i]
      cur.lblY = Math.max(cur.lineY + 4, prev.lblY + 12)
    }
    return sorted
  }

  // 左侧水位
  const leftWL = [
    { lineY: alarm_low_y, text: '低报警 ' + fmt(Z_alarm_low ?? stopLevel, 2) + 'm', color: '#c0392b' },
    { lineY: alarm_y, text: '高报警 ' + fmt(alarmLevel, 2) + 'm', color: '#c0392b' },
    { lineY: max_y, text: '最高水位 ' + fmt(Z_max ?? alarmLevel, 2) + 'm', color: '#c0392b' },
  ].map(it => ({ ...it, lblY: it.lineY + 4 }))
  spreadWL(leftWL).forEach(it => {
    s += _l(sec_left, it.lineY, sec_left + wl_len, it.lineY, it.color, 1.5, '4,2')
    s += _t(wl_lx_left, it.lblY, it.text, 9, it.color, 'end')
  })

  // 右侧水位
  const rightWL = [
    { lineY: start_y, text: '1#启 ' + fmt(startLevel, 2) + 'm', color: '#27ae60' },
    { lineY: start2_y, text: '2#启 ' + fmt(Z_start2 ?? alarmLevel, 2) + 'm', color: '#27ae60' },
    { lineY: stop_y, text: '停泵 ' + fmt(stopLevel, 2) + 'm', color: '#555' },
    { lineY: pool_bot_y, text: '池底 ' + fmt(stopLevel, 2) + 'm', color: '#555' },
  ].map(it => ({ ...it, lblY: it.lineY + 4 }))
  spreadWL(rightWL).forEach(it => {
    if (it.lineY !== pool_bot_y) {
      s += _l(sec_right - wl_len, it.lineY, sec_right, it.lineY, it.color, 1.5, '4,2')
    }
    s += _t(wl_lx_right, it.lblY, it.text, 9, it.color, 'start')
  })

  // ── 管道截面 ───────────────────────────────────────────────────────
  const pipe_r = DN_branch / 1000 * SCALE_SEC / 2
  s += `<circle cx="${sec_cx.toFixed(1)}" cy="${Z_top_px.toFixed(1)}" r="${pipe_r.toFixed(1)}" fill="none" stroke="#2980b9" stroke-width="2"/>`
  s += _t(sec_cx, Z_top_px - pipe_r - 6, `DN${DN_branch}`, 9, '#2980b9', 'middle')

  // ── 阀门侧视图 ────────────────────────────────────────────────────
  const valve_cv_len = lookupFF(CHECK_VALVE_FF, DN_branch) / 1000 * SCALE_SEC
  const valve_gv_len = lookupFF(GATE_VALVE_FF, DN_branch) / 1000 * SCALE_SEC
  const horiz_y = Z_top_px - pipe_r * 2 - 10
  const cv_center_x = sec_cx - (sec_right - sec_left) * 0.25
  const gv_center_x = sec_cx + (sec_right - sec_left) * 0.25

  s += _checkValve(cv_center_x, horiz_y, valve_cv_len / 2, true, '#c0392b')
  s += _gateValve(gv_center_x, horiz_y, valve_gv_len / 2, true, '#c0392b')

  // ── 泵 ────────────────────────────────────────────────────────────
  const pump_w = Math.min((sec_right - sec_left) * 0.15, 25)
  const pump_h = pump_w * 0.6
  const pump_x = sec_cx - pump_w / 2
  const sump_bot_y_val = Z_sumpVal < stopLevel - 0.01 ? pool_bot_y + (stopLevel - Z_sumpVal) * SCALE_SEC : pool_bot_y
  const pump_y = sump_bot_y_val - pump_h - 5

  s += _r(pump_x, pump_y, pump_w, pump_h, '#2471a3', '#1a5276', 1.5)
  s += _t(sec_cx, pump_y + pump_h / 2 + 2, pumpsInOrder?.[0]?.label || 'P', 8, '#fff', 'middle', 'bold')

  // 压水管
  const riser_x = sec_cx
  s += _l(riser_x, pump_y, riser_x, Z_top_px, '#2980b9', 1.5)
  s += `<circle cx="${riser_x.toFixed(1)}" cy="${Z_top_px.toFixed(1)}" r="4" fill="none" stroke="#2980b9" stroke-width="1.5" stroke-dasharray="2,2"/>`

  // ── 尺寸标注 ──────────────────────────────────────────────────────
  s += _dv(sec_left - 25, SMT, Z_top_px, '净高 ' + fmt(room_H, 1) + 'm', '#2980b9')
  s += _dv(sec_left - 25, Z_top_px, pool_bot_y, 'h=' + fmt(h_pool, 1) + 'm', '#2980b9')

  // ▽ 标高符号（▽ 4.500 格式）
  const elev_y_pool_bot = pool_bot_y + 4
  s += _t(sec_left - 5, elev_y_pool_bot, '▽ ' + fmt(stopLevel, 2) + 'm', 9, '#2980b9', 'end')
  s += _t(sec_left - 5, Z_top_px + 4, '▽ ' + fmt(Z_top, 2) + 'm', 9, '#1a5276', 'end')

  return { s, SX0, SW, sec_cx, Z_top_px, SCALE_SEC, DN_branch, DN_main }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 7. SVG 组装与渲染 ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// ── 8. 交互逻辑 ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

function setupInteractions(el, planData) {
  const { PW, PH } = planData

  // Hover 卡片交互
  const tooltipPump = document.getElementById('pump-tooltip')
  const tooltipValve = document.getElementById('valve-tooltip')

  el.querySelectorAll('.pump-group').forEach(g => {
    g.addEventListener('mouseenter', (e) => {
      if (!tooltipPump) return
      const { pump, q, h, kw } = g.dataset
      tooltipPump.innerHTML = `<strong>${pump}</strong><br>Q=${q || '—'} m³/h<br>H=${h || '—'} m<br>P=${kw || '—'} kW`
      tooltipPump.style.display = 'block'
      const rect = el.getBoundingClientRect()
      tooltipPump.style.left = (e.clientX - rect.left + 10) + 'px'
      tooltipPump.style.top = (e.clientY - rect.top - 10) + 'px'
    })
    g.addEventListener('mouseleave', () => { if (tooltipPump) tooltipPump.style.display = 'none' })
    g.addEventListener('mousemove', (e) => {
      if (!tooltipPump) return
      const rect = el.getBoundingClientRect()
      tooltipPump.style.left = (e.clientX - rect.left + 10) + 'px'
      tooltipPump.style.top = (e.clientY - rect.top - 10) + 'px'
    })
  })

  el.querySelectorAll('.valve-group').forEach(g => {
    g.addEventListener('mouseenter', (e) => {
      if (!tooltipValve) return
      const { type, dn } = g.dataset
      tooltipValve.innerHTML = `<strong>${type}</strong><br>DN${dn}`
      tooltipValve.style.display = 'block'
      const rect = el.getBoundingClientRect()
      tooltipValve.style.left = (e.clientX - rect.left + 10) + 'px'
      tooltipValve.style.top = (e.clientY - rect.top - 10) + 'px'
    })
    g.addEventListener('mouseleave', () => { if (tooltipValve) tooltipValve.style.display = 'none' })
    g.addEventListener('mousemove', (e) => {
      if (!tooltipValve) return
      const rect = el.getBoundingClientRect()
      tooltipValve.style.left = (e.clientX - rect.left + 10) + 'px'
      tooltipValve.style.top = (e.clientY - rect.top - 10) + 'px'
    })
  })

  // zoom/pan
  initSvgZoomPan(el, PW + 520, PH,
    { zIn: 'btn-ag31-zin', zOut: 'btn-ag31-zout', zRst: 'btn-ag31-rst' },
    { minScale: 1.0, maxScale: 5 })
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 主入口 ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

export function runDrawing(N, ag21, params, S, topology, extraInfo = {}) {
  const inputs = parseInputs(N, ag21, params, S, topology, extraInfo)
  const geo = computeGeometry(inputs)
  const minimapSvg = buildMinimap(inputs, geo)
  const layoutMap = buildLayoutMap(topology, geo, inputs)
  const planData = buildPlanView(inputs, geo, layoutMap)
  const sectionData = buildSectionView(inputs, geo)

  // SVG 组装顺序：背景 → 平面图 → 剖面图 → 缩略图（最后画，防止被覆盖）
  const el = document.getElementById('svg-ag31')
  el.setAttribute('viewBox', `0 0 ${planData.PW + 520} ${planData.PH}`)
  el.innerHTML = planData.s + sectionData.s + minimapSvg

  setupInteractions(el, planData)
}
