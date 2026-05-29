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

function parseInputs(N, ag21, params, S, topology, extraInfo) {
  const {
    L, W, d_spacing = 1.0, e_wall = 0.8, w_pump, d_pump, N_total, h_room,
    hasCatalogDims, DN_branch = 150, DN_main = 300, DN_label = DN_main,
    c_wall_m = 0, L_elbow_m = 0,
    valvesAfterJunction = [],
  } = ag21
  const { h_pool, h_active, Z_stop: stopLevel, Z_start1: startLevel, Z_start2, Z_alarm_high: alarmLevel, Z_alarm_low, Z_max } = params
  const { Q_single, H_design, P_motor, catalogPump, Z_sump, Z_discharge } = extraInfo

  const L_pool = Math.max(L, Math.sqrt(S * 1.5))
  const D_pool = S / L_pool
  const room_H = h_room || Math.max(3.5, d_pump + 2.0)

  // Z_top = 顶板标高 = 停泵水位 + 池深
  const Z_top = stopLevel + h_pool
  const pumpsInOrder = getPumpsInOrder(topology)

  return {
    N, L, W, d_spacing, e_wall, w_pump, d_pump, N_total, h_room,
    hasCatalogDims, DN_branch, DN_main, DN_label, c_wall_m, L_elbow_m,
    valvesAfterJunction,
    h_pool, h_active, stopLevel, startLevel, Z_start2, alarmLevel, Z_alarm_low, Z_max,
    Q_single, H_design, P_motor, catalogPump, Z_sump, Z_discharge,
    L_pool, D_pool, room_H, Z_top, pumpsInOrder,
  }
}

function getPumpsInOrder(topology) {
  return (topology?.devices || [])
    .filter(d => d.type === 'pump' && d.roomId === 'wet_well')
    .sort((a, b) => (a.canvasX || 0) - (b.canvasX || 0))
}

function _t2(x, y, line1, line2, sz, fill, anchor = 'middle', weight = 'normal', gap = 10) {
  return _t(x, y, line1, sz, fill, anchor, weight) +
    _t(x, y + gap, line2, sz, fill, anchor, weight)
}

function _tag(x, y, line1, line2, color, anchor = 'start') {
  const w = tagWidth(line1, line2)
  const h = TAG_H
  const boxX = anchor === 'end' ? x - w : x
  const textX = anchor === 'end' ? x - 6 : x + 6
  const textAnchor = anchor === 'end' ? 'end' : 'start'
  return _r(boxX, y, w, h, '#fff', color, 0.8, 'rx="3" opacity="0.96"') +
    _t(textX, y + 11, line1, 9, color, textAnchor, 'bold') +
    _t(textX, y + 23, line2, 9, color, textAnchor)
}

function tagWidth(line1, line2) {
  const textLen = Math.max(String(line1).length, String(line2).length)
  return Math.max(62, Math.min(84, textLen * 7 + 12))
}

const TAG_H = 28
const TAG_GAP = 5

function placeLevelTags(items) {
  const sorted = [...items].sort((a, b) => a.lineY - b.lineY)
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]
    const next = sorted[i + 1]
    const tooCloseToNext = next && (next.lineY - cur.lineY) < (TAG_H + TAG_GAP * 2)
    const above = cur.prefer === 'above' || tooCloseToNext
    cur.tagY = above ? cur.lineY - TAG_H - TAG_GAP : cur.lineY + TAG_GAP
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    if (cur.tagY < prev.tagY + TAG_H + TAG_GAP) {
      cur.tagY = cur.lineY + TAG_GAP
    }
  }
  return sorted
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

  // ─── 三列画布：信息列 + 平面图 + 剖面图 ───
  const INFO_W = 170, GAP = 20, PW = 470, SW = 480, PH = 560
  const INFO_X = 0
  const PLAN_X = INFO_W + GAP
  const SX0 = PLAN_X + PW + GAP
  const CANVAS_W = SX0 + SW
  const PML = 50, PMR = 30, PMT = 60, PMB = 40

  // SCALE_MAIN：只聚焦机房(L,W)，加 1m 余量防止贴边
  const SCALE_MAIN = Math.min((PW - PML - PMR) / (L + 1), (PH - PMT - PMB) / (W + 1))

  // 机房坐标（居中对齐）
  const room_ox = PLAN_X + PML + (PW - PML - PMR - L * SCALE_MAIN) / 2
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
    SCALE_MAIN, SCALE_MINI, SCALE_SEC, PW, PH, INFO_X, INFO_W, PLAN_X, GAP, CANVAS_W,
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
  const { SCALE_MINI, MINI_SIZE, MINI_MARGIN, INFO_X, INFO_W } = geo;

  let s = '';

  // 缩略图容器起点（左上角）
  const mini_ox = INFO_X + (INFO_W - MINI_SIZE) / 2;
  const mini_oy = 40;

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
  const start_x = mini_ox + MINI_MARGIN + (MINI_SIZE - 2 * MINI_MARGIN - total_w) / 2;
  const start_y = mini_oy + MINI_MARGIN + (MINI_SIZE - 2 * MINI_MARGIN - total_h) / 2;

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

function buildInfoColumn(geo) {
  const { INFO_X, INFO_W, PH } = geo
  let s = ''
  s += _r(INFO_X, 0, INFO_W, PH, '#fafafa', 'none')
  s += _t(INFO_X + INFO_W / 2, 25, '总览', 12, '#1a5276', 'middle', 'bold')

  const legItems = [['#2471a3', '水泵'], ['#2980b9', '管道'], ['#c0392b', '阀门'], ['#dbeeff', '集水坑']]
  const legX = INFO_X + 20
  const legY = 235
  const legW = INFO_W - 40
  s += _t(INFO_X + INFO_W / 2, legY - 12, '图例', 11, '#1a5276', 'middle', 'bold')
  s += _r(legX, legY, legW, legItems.length * 18 + 12, '#fff', '#ccc', 0.8, 'rx="3" opacity="0.95"')
  let y = legY + 10
  for (const [c, lbl] of legItems) {
    s += _r(legX + 10, y, 10, 10, c, '#666', 0.5)
    s += _t(legX + 28, y + 9, lbl, 9, '#333', 'start')
    y += 18
  }
  return s
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 4. 拓扑驱动的梳齿布局 ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

const SUMP_PARTITION_M = 0.2

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
  const { DN_branch, DN_main, e_wall, w_pump } = inputs

  // 建立邻接表（管道连接 + 设备内部两端口连通）
  const adj = {}
  for (const n of nodes) adj[n.id] = []
  for (const p of pipes) {
    adj[p.node1]?.push(p.node2)
    adj[p.node2]?.push(p.node1)
  }
  // 设备两端口之间没有显式管道，补充内部连通
  for (const d of devices) {
    if (d.nodeIds?.length === 2) {
      adj[d.nodeIds[0]] = adj[d.nodeIds[0]] || []
      adj[d.nodeIds[1]] = adj[d.nodeIds[1]] || []
      if (!adj[d.nodeIds[0]].includes(d.nodeIds[1])) adj[d.nodeIds[0]].push(d.nodeIds[1])
      if (!adj[d.nodeIds[1]].includes(d.nodeIds[0])) adj[d.nodeIds[1]].push(d.nodeIds[0])
    }
  }

  // 找关键设备
  const pumps = getPumpsInOrder(topology)

  const junction = devices.find(d => d.type === 'junction')
  const sourceNode = nodes.find(n => n.label === '进水')
  const sinkNode = nodes.find(n => n.label === '出水')
  const spineStartX = room_ox + e_wall * SCALE_MAIN
  const spineEndX = room_x2 - e_wall * SCALE_MAIN
  const sumpLayout = buildSumpLayout(pumps, geo, inputs)

  // 水泵 X 坐标按集水坑分格布置：泵宽 + 200mm 隔墙
  const pumpXs = sumpLayout.pumpCenters.map(p => p.x)

  // 最小直管段
  const minStr_px = Math.max(2 * DN_branch, 300) / 1000 * SCALE_MAIN

  // ── 主分支（每泵一个梳齿）──────────────────────────────────────────
  const branches = pumps.map((pump, i) =>
    buildBranchFromTopology(pump, pumpXs[i], junction, devices, adj, geo, inputs)
  )

  // ── 回流支路（junction_in → source，竖向穿楼板）────────────────────────
  const junctionInNodeId = junction?.nodeIds?.[0]
  const returnPath = sourceNode ? tracePath(junctionInNodeId, [sourceNode.id], adj) : []
  const seenRet = new Set()
  const returnDevices = returnPath
    .map(nodeId => devices.find(d => d.nodeIds?.includes(nodeId)))
    .filter(dev => {
      if (!dev || dev.type === 'junction' || dev.type === 'pump') return false
      if (seenRet.has(dev.id)) return false
      seenRet.add(dev.id)
      return true
    })

  // ── 主管阀门链（汇流点出口 → 出水口）─────────────────────────────────
  const junctionOutNodeId = junction?.nodeIds?.[junction.nodeIds.length - 1]
  const mainPath = sinkNode ? tracePath(junctionOutNodeId, [sinkNode.id], adj) : []
  const seenMain = new Set()
  const mainDevices = mainPath
    .map(nodeId => devices.find(d => d.nodeIds?.includes(nodeId)))
    .filter(dev => {
      if (!dev || dev.type === 'junction') return false
      if (seenMain.has(dev.id)) return false
      seenMain.add(dev.id)
      return true
    })

  const lastPumpX = pumpXs.length ? Math.max(...pumpXs) : spineStartX
  const mainStartX = Math.min(lastPumpX + w_pump * SCALE_MAIN / 2 + e_wall * SCALE_MAIN, spineEndX)
  const mainAvail = spineEndX - mainStartX

  // 主管阀门：预算全宽（含两侧法兰）后均分，避免截断造成堆叠
  const devInfo = mainDevices.map(dev => {
    const hl = deviceHalfLen(dev, DN_main, SCALE_MAIN)
    const fl = Math.min(hl * 0.3, 6)
    return { device: dev, hl, fl }
  })
  const totalFullW = devInfo.reduce((s, d) => s + 2 * (d.hl + d.fl), 0)
  const MIN_GAP = 4
  const n = devInfo.length
  // 空间不足时允许设备超出 spineEndX（优于全部叠在同一点）
  const gapPx = n > 0 ? Math.max(MIN_GAP, (mainAvail - totalFullW) / (n + 1)) : 0
  let mainCurX = mainStartX
  const mainChain = devInfo.map(({ device, hl, fl }) => {
    mainCurX += gapPx + fl
    const planX = mainCurX + hl
    mainCurX = planX + hl + fl
    return { device, planX, planY: hdr_y, halfLen: hl }
  })

  // 回流管 X 坐标：优先贴集水坑左外壁，退而满足与第一台泵支管的最小间距
  const firstPumpX = pumpXs.length > 0 ? Math.min(...pumpXs) : spineStartX + 50
  const pipeToPipe_m = (inputs.spaceRules?.pipeToPipe_mm ?? 800) / 1000
  const minCenterDist = (inputs.DN_branch / 1000 + pipeToPipe_m) * SCALE_MAIN
  const retX_bySpacing = firstPumpX - minCenterDist
  const retX = Math.min(sumpLayout.x, retX_bySpacing)
  const elbowR_ret = elbowCTF(DN_branch) / 1000 * SCALE_MAIN * 0.5
  let retCurY = hdr_y + elbowR_ret * 2
  const returnChain = returnDevices.map(dev => {
    const hl = deviceHalfLen(dev, DN_branch, SCALE_MAIN)
    retCurY += minStr_px + hl
    const item = { device: dev, planX: retX, planY: retCurY, halfLen: hl }
    retCurY += hl
    return item
  })

  const mainEndX = spineEndX
  return {
    pumpsInOrder: pumps,
    branches,
    returnChain,
    retX,
    mainChain,
    pumpXs,
    teeXs: pumpXs,
    spineStartX,
    spineEndX,
    mainEndX,
    hdr_y,
    sumpLayout,
    representativeBranch: branches[0] || null,
  }
}

function getPumpDimM(pump, inputs, key, fallback) {
  const dim = pump?.pump?.dimensions_mm || inputs.catalogPump?.pump?.dimensions_mm
  if (inputs.hasCatalogDims && dim?.[key] != null) return dim[key] / 1000
  return fallback
}

function buildSumpLayout(pumps, geo, inputs) {
  const { SCALE_MAIN, room_ox, room_x2, room_y2 } = geo
  const count = Math.max(pumps?.length || 0, inputs.N_total || inputs.N || 1)
  const pumpRefs = Array.from({ length: count }, (_, i) => pumps?.[i] || null)
  const widthsM = pumpRefs.map(p => getPumpDimM(p, inputs, 'b', inputs.w_pump))
  const lengthsM = pumpRefs.map(p => getPumpDimM(p, inputs, 'a', inputs.d_pump))
  const widthM = widthsM.reduce((sum, w) => sum + w, 0) + Math.max(0, count - 1) * SUMP_PARTITION_M
  const lengthM = Math.max(...lengthsM, inputs.d_pump)
  const widthPx = widthM * SCALE_MAIN
  const heightPx = lengthM * SCALE_MAIN
  const x = room_ox + ((room_x2 - room_ox) - widthPx) / 2
  const y = room_y2

  let curX = x
  const pumpCenters = widthsM.map((widthMItem, i) => {
    const widthPxItem = widthMItem * SCALE_MAIN
    const cx = curX + widthPxItem / 2
    const center = {
      x: cx,
      y: y + heightPx / 2,
      widthPx: widthPxItem,
      heightPx: lengthsM[i] * SCALE_MAIN,
    }
    curX += widthPxItem + SUMP_PARTITION_M * SCALE_MAIN
    return center
  })

  return {
    x,
    y,
    widthM,
    lengthM,
    widthPx,
    heightPx,
    partitionPx: SUMP_PARTITION_M * SCALE_MAIN,
    pumpCenters,
  }
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
  if (device.type === 'check_valve') return Math.max(8, lookupFF(CHECK_VALVE_FF, dn) / 1000 * scale / 2)
  if (device.type === 'gate_valve') return Math.max(8, lookupFF(GATE_VALVE_FF, dn) / 1000 * scale / 2)
  if (device.type === 'flowmeter') return Math.max(12, flowmeterBodyL(dn) / 1000 * scale / 2)
  if (device.type === 'pump') return 0
  if (device.type === 'junction') return 0
  return 0
}

/**
 * 从拓扑路径构建单根支管的设备布局（泵出口 → 汇流点）
 * 从穿楼板处（底部）向梳脊（上方）逆推 Y 坐标。
 * @returns {{ pump, items, teeX, elbowR }}
 */
function buildBranchFromTopology(pump, pumpX, junction, devices, adj, geo, inputs) {
  const { SCALE_MAIN, room_y2, hdr_y } = geo
  const { DN_branch } = inputs

  const pumpOutNodeId = pump.nodeIds?.[0]
  const junctionInNodeId = junction?.nodeIds?.[0]
  const path = tracePath(pumpOutNodeId, [junctionInNodeId], adj)
  const seen = new Set()
  const chainDevices = path
    .map(nodeId => devices.find(d => d.nodeIds?.includes(nodeId)))
    .filter(dev => {
      if (!dev || dev.id === junction?.id || dev.type === 'pump') return false
      if (seen.has(dev.id)) return false
      seen.add(dev.id)
      return true
    })

  const minStr_px = Math.max(2 * DN_branch, 300) / 1000 * SCALE_MAIN

  // 计算可用空间（底部直管段到主管之间），等比缩放防止设备链溢出主管
  const available = room_y2 - hdr_y - minStr_px
  const rawTotal = chainDevices.reduce((sum, dev) => {
    const hl = deviceHalfLen(dev, DN_branch, SCALE_MAIN)
    return sum + minStr_px + hl * 2
  }, 0)
  const scale = rawTotal > 0 && rawTotal > available ? available / rawTotal : 1

  let curY = room_y2 - minStr_px
  const items = []

  chainDevices.forEach(dev => {
    const hl = deviceHalfLen(dev, DN_branch, SCALE_MAIN)
    curY -= (minStr_px + hl) * scale
    items.push({
      kind:    toKind(dev.type),
      device:  dev,
      planX:   pumpX,
      planY:   curY,
      halfLen: hl,
      faces: {
        from: { x: pumpX, y: curY - hl },
        to:   { x: pumpX, y: curY + hl },
      },
    })
    curY -= hl * scale
  })

  // 穿楼板节点：单线图圆点符号，管道线延伸到 room_y2
  const r_floor = elbowCTF(DN_branch) / 1000 * SCALE_MAIN * 0.5
  items.push({
    kind:    'floor_penetration',
    device:  null,
    planX:   pumpX,
    planY:   room_y2,
    halfLen: 0,
    r:       r_floor,
    fromDir: 'top',
    toDir:   'in',
    faces: {
      from: { x: pumpX, y: room_y2 },   // 管道线终止于楼板线
      to:   { x: pumpX, y: room_y2 },
    },
  })

  items.push({ device: pump, planX: pumpX, planY: room_y2 + 10, halfLen: 0, isPump: true })

  return { pump, items, teeX: pumpX, elbowR: 0 }
}

/**
 * 统一管件符号渲染（平面图）：根据设备类型调用对应绘制函数
 * @param {Object} device
 * @param {number} cx
 * @param {number} cy
 * @param {number} halfLen - 半长（px）
 * @param {boolean} horiz - 水平布置
 * @param {number} dnPx - DN 换算像素（用于流量计体宽）
 * @param {string} color
 * @returns {string} SVG string
 */
function drawFitting(device, cx, cy, halfLen, horiz, dnPx, color = '#c0392b') {
  const type = device?.type
  if (type === 'gate_valve') return _gateValve(cx, cy, halfLen, horiz, color)
  if (type === 'check_valve') return _checkValve(cx, cy, halfLen, horiz, color)
  if (type === 'flowmeter') return _flowmeter(cx, cy, halfLen, Math.max(4, dnPx / 2), horiz, color)
  return ''
}

function toKind(type) {
  if (type === 'gate_valve')  return 'gate_valve'
  if (type === 'check_valve') return 'check_valve'
  if (type === 'flowmeter')   return 'flowmeter'
  return 'fitting'
}

const PIPE_CLR = '#333'   // 管道线 / 管件颜色（单线图黑色）

/**
 * LayoutNode 纯分发渲染（§3.4 renderNode）
 * 只接受 kind 决定符号，不含任何布局逻辑。
 */
function renderNode(node, dnMainPx, dnBranchPx) {
  const { kind, planX, planY, halfLen, r, fromDir, toDir } = node
  switch (kind) {
    case 'pipe_segment':
      return _l(node.faces.from.x, node.faces.from.y,
                node.faces.to.x,   node.faces.to.y, PIPE_CLR, 1.5)
    case 'floor_penetration':
      return _elbow(planX, planY, r, fromDir || 'top', toDir || 'in',
                    PIPE_CLR, 1.5, dnBranchPx)
    case 'elbow':
      return _elbow(planX, planY, r, fromDir, toDir, PIPE_CLR, 1.5, dnBranchPx)
    case 'tee':
      return _tee(planX, planY, dnMainPx, dnBranchPx, PIPE_CLR)
    case 'gate_valve':
      return _gateValve(planX, planY, halfLen, false, '#c0392b')
    case 'check_valve':
      return _checkValve(planX, planY, halfLen, false, '#c0392b')
    case 'flowmeter':
      return _flowmeter(planX, planY, halfLen, Math.max(4, dnBranchPx / 2), false, '#c0392b')
    default:
      return ''
  }
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
    hasCatalogDims, DN_branch, DN_main, DN_label,
    Q_single, H_design, P_motor,
    pumpsInOrder,
  } = inputs

  const { SCALE_MAIN, PW, PH, PLAN_X, room_ox, room_oy, room_x2, room_y2, hdr_y } = geo
  // bypass_y 来自 layoutMap（不在 geo 中）
  const bypass_y = layoutMap?.bypass_y ?? (hdr_y + 40)
  const topoPumps = layoutMap?.pumpsInOrder?.length ? layoutMap.pumpsInOrder : pumpsInOrder
  const sumpLayout = layoutMap?.sumpLayout || buildSumpLayout(topoPumps, geo, inputs)
  const plan_bottom_y = sumpLayout.y + sumpLayout.heightPx

  let s = ''

  // 背景
  s += _r(PLAN_X, 0, PW, PH, '#fbfcfd', 'none')

  // 标题
  s += _t(PLAN_X + PW / 2, 25, '平 面 图', 12, '#1a5276', 'middle', 'bold')

  // ── 集水坑（坑口范围示意）─────────────────────────────────────────────
  s += _r(sumpLayout.x, sumpLayout.y, sumpLayout.widthPx, sumpLayout.heightPx, '#dcefff', '#2471a3', 2)
  s += _tag(sumpLayout.x + sumpLayout.widthPx + 8, sumpLayout.y + sumpLayout.heightPx / 2 - TAG_H / 2, '集水坑', `${fmt(sumpLayout.widthM, 1)} x ${fmt(sumpLayout.lengthM, 1)}m`, '#2471a3', 'start')
  for (let i = 1; i < sumpLayout.pumpCenters.length; i++) {
    const prev = sumpLayout.pumpCenters[i - 1]
    const wallX = prev.x + prev.widthPx / 2
    s += _r(wallX, sumpLayout.y, sumpLayout.partitionPx, sumpLayout.heightPx, '#ffffff', '#2471a3', 0.8)
  }

  // ── 机房边界 ──────────────────────────────────────────────────────
  s += _r(room_ox, room_oy, L * SCALE_MAIN, W * SCALE_MAIN, '#fcfeff', '#2980b9', 2)
  s += _t((room_ox + room_x2) / 2, room_oy - 10, '维护间', 10, '#2980b9', 'middle', 'bold')

  // ── 梳脊（主管）— 按管件拆段渲染 ─────────────────────────────────
  const spineStartX = layoutMap?.spineStartX ?? (room_ox + e_wall * SCALE_MAIN)
  const spineEndX = layoutMap?.mainEndX ?? (room_x2 - e_wall * SCALE_MAIN)
  const _retX_mp = layoutMap?.retX
  // 单线图弯头弧线：固定视觉半径，不随 DN 缩放
  const VIS_ELBOW_R = 10
  const _elbR_mp = _retX_mp != null ? VIS_ELBOW_R : 0
  const _firstPumpX = layoutMap?.pumpXs?.length ? Math.min(...layoutMap.pumpXs) : spineStartX
  const mainPipeLeft = _retX_mp != null ? _retX_mp + _elbR_mp : _firstPumpX

  // DN 换算像素
  const dnMainPx   = DN_main   / 1000 * SCALE_MAIN
  const dnBranchPx = DN_branch / 1000 * SCALE_MAIN

  // 单线图：三通是一个点，支管直接连到主管轴线（hdr_y）
  const teeBranchFaceY = hdr_y

  // 主管上仅阀门占位（三通为点，不产生缺口）
  const valveIntervals = (layoutMap?.mainChain ?? []).map(({ planX, halfLen }) => {
    const fl = Math.min(halfLen * 0.3, 6)
    return [planX - halfLen - fl, planX + halfLen + fl]
  })
  const allIntervals = [...valveIntervals].sort((a, b) => a[0] - b[0])

  // 按缺口绘制主管线段
  let mainCurX = mainPipeLeft
  for (const [iStart, iEnd] of allIntervals) {
    if (iStart > mainCurX) s += _l(mainCurX, hdr_y, iStart, hdr_y, PIPE_CLR, 3)
    mainCurX = Math.max(mainCurX, iEnd)
  }
  // 主管末端延伸到右侧房间边界（穿墙出室外）
  if (mainCurX < room_x2) s += _l(mainCurX, hdr_y, room_x2, hdr_y, PIPE_CLR, 3)
  s += _t(spineStartX + 5, hdr_y - 5, `DN${DN_label} 出水总管`, 9, '#2980b9', 'start')

  // ── 主管阀门（汇流点右侧）──────────────────────────────────────────
  if (layoutMap?.mainChain?.length) {
    for (const { device, planX, planY, halfLen } of layoutMap.mainChain) {
      s += `<g class="valve-group" data-type="${device.label || device.type}" data-dn="${DN_main}">`
      s += drawFitting(device, planX, planY, halfLen, true, dnMainPx, '#c0392b')
      s += '</g>'
    }
  }

  // ── 梳齿（分支管路）─────────────────────────────────────────────────

  const renderPumpCount = Math.max(topoPumps?.length || 0, N_total || 0)
  for (let i = 0; i < renderPumpCount; i++) {
    const topoP = topoPumps?.[i]
    const isSpare = topoP ? !!topoP.isSpare : (i === N_total - 1)
    const label = topoP ? topoP.label : (isSpare ? '备' : 'P' + (i + 1))

    // 水泵
    const pwRaw = (hasCatalogDims && topoP
      ? (topoP.pump?.dimensions_mm?.b || w_pump) / 1000
      : w_pump) * SCALE_MAIN
    const phRaw = (hasCatalogDims && topoP
      ? (topoP.pump?.dimensions_mm?.a || d_pump) / 1000
      : d_pump) * SCALE_MAIN
    const pw = Math.max(16, pwRaw)
    const ph = Math.max(20, phRaw)

    const pumpCenter = sumpLayout.pumpCenters[i]
    const pumpX = layoutMap?.pumpXs?.[i] || pumpCenter?.x || (room_ox + e_wall * SCALE_MAIN + w_pump * SCALE_MAIN / 2 + i * (w_pump + d_spacing) * SCALE_MAIN)
    const pumpY = pumpCenter?.y || (room_y2 + ph / 2)

    s += `<g class="pump-group" data-pump="${label}" data-q="${Q_single || ''}" data-h="${H_design || ''}" data-kw="${P_motor || ''}">`
    s += _r(pumpX - pw / 2, pumpY - ph / 2, pw, ph, 'none', '#1a5276', 1.5, 'rx="2"')
    s += _t(pumpX, pumpY + ph / 2 + 11, label, Math.max(8, Math.min(14, pw * 0.42)), '#2471a3', 'middle', 'bold')
    s += '</g>'

    // 支管（如果 layoutMap 有数据，用动态布局）
    const branch = layoutMap?.branches?.[i]
    if (branch?.items?.length > 0) {
      const fpNode     = branch.items.find(it => it.kind === 'floor_penetration')
      const valveItems = branch.items.filter(it => !it.isPump && it.kind !== 'floor_penetration')

      // 穿楼板点锁定到泵方块中心（pumpY），管道线从泵中心直穿楼板到阀件
      if (fpNode) {
        fpNode.planY        = pumpY
        fpNode.faces.from.y = pumpY
        fpNode.faces.to.y   = pumpY
      }

      // ── 第一遍：管道线段（underlay）─────────────────────────────────
      // 从泵中心（pumpY）向上穿楼板，经各阀件间隙，终止于主管
      let prevFaceY = fpNode ? fpNode.faces.from.y : pumpY
      for (const item of valveItems) {
        s += _l(pumpX, prevFaceY, pumpX, item.faces.to.y, PIPE_CLR, 1.5)
        prevFaceY = item.faces.from.y
      }
      s += _l(pumpX, prevFaceY, pumpX, teeBranchFaceY, PIPE_CLR, 1.8)

      // ── 第二遍：管件符号（overlay）──────────────────────────────────
      // 穿楼板弯头（L形+圆，替代旧虚线圆）
      if (fpNode) {
        s += renderNode(fpNode, dnMainPx, dnBranchPx)
      }
      for (const item of valveItems) {
        s += `<g class="valve-group" data-type="${item.device?.label || item.device?.type}" data-dn="${DN_branch}">`
        s += renderNode(item, dnMainPx, dnBranchPx)
        s += '</g>'
      }
      // 三通（主管处）
      s += _tee(pumpX, hdr_y, dnMainPx, dnBranchPx, PIPE_CLR)
      if (i === 0) {
        s += _t(pumpX + 6, (room_y2 + hdr_y) / 2, `DN${DN_branch}`, 8, '#2980b9', 'start')
      }
    } else {
      // 无拓扑时退回：简单虚线圆占位
      s += `<circle cx="${pumpX.toFixed(1)}" cy="${room_y2.toFixed(1)}" r="6" fill="#fff" stroke="#2980b9" stroke-width="1.7" stroke-dasharray="3,2"/>`
    }
  }


  // ── 回流管 ─────────────────────────────────────────────────────────
  const retChain = layoutMap?.returnChain
  const retX = layoutMap?.retX
  if (retX != null) {
    // 穿楼板圆点 Y = 第一台泵中心（与泵支管穿楼板点同一水平线）
    const retPumpY = sumpLayout.pumpCenters[0]?.y ?? room_y2

    // 阀门 Y 位置对齐第一条支管的阀件（相同水平线）
    const refValves = (layoutMap?.branches?.[0]?.items ?? [])
      .filter(it => !it.isPump && it.kind !== 'floor_penetration')

    // 弯头：单线图弧
    s += _elbow(retX, hdr_y, VIS_ELBOW_R, 'right', 'bottom', PIPE_CLR, 1.5, dnBranchPx)

    let lastY = hdr_y + VIS_ELBOW_R
    const dnPxRet = dnBranchPx
    if (retChain?.length > 0) {
      retChain.forEach((item, idx) => {
        const { device, halfLen } = item
        // 取同号支管阀件 Y，若无则保留原 Y
        const alignedY = refValves[idx]?.planY ?? item.planY
        s += _l(retX, lastY, retX, alignedY - halfLen, PIPE_CLR, 1.5)
        s += `<g class="valve-group" data-type="${device.label || device.type}" data-dn="${DN_branch}">`
        s += drawFitting(device, retX, alignedY, halfLen, false, dnPxRet, '#c0392b')
        s += '</g>'
        lastY = alignedY + halfLen
      })
    }
    // 延伸到泵中心（与泵穿楼板点同线）
    s += _l(retX, lastY, retX, retPumpY, PIPE_CLR, 1.5)
    s += `<circle cx="${retX.toFixed(1)}" cy="${retPumpY.toFixed(1)}" r="4" fill="${PIPE_CLR}" opacity="0.9"/>`
  }

  // ── 尺寸标注 ────────────────────────────────────────────────────────
  const dim_by = plan_bottom_y + 48
  s += _dh(room_ox, room_x2, dim_by, 'L=' + fmt(L, 1) + 'm', '#1a3a5c')
  const dim_rx = room_ox - 24
  s += _dv(dim_rx, room_oy, room_y2, 'W=' + fmt(W, 1) + 'm', '#1a3a5c')

  // 比例尺
  const bar_len = SCALE_MAIN
  const bx = room_ox
  const by_bar = plan_bottom_y + 38
  s += _l(bx, by_bar, bx + bar_len, by_bar, '#333', 2)
  s += _l(bx, by_bar - 3, bx, by_bar + 3, '#333', 1.5)
  s += _l(bx + bar_len, by_bar - 3, bx + bar_len, by_bar + 3, '#333', 1.5)
  s += _t(bx + bar_len / 2, by_bar - 5, '1m', 9, '#333')

  return { s, SCALE_MAIN, PW, PH, CANVAS_W: geo.CANVAS_W }
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
function buildSectionView(inputs, geo, layoutMap) {
  const {
    L, h_pool, stopLevel, startLevel, Z_start2, alarmLevel, Z_alarm_low, Z_max,
    DN_branch, DN_main, room_H, Z_sump, Z_discharge,
    pumpsInOrder,
  } = inputs

  // 剖面图使用独立水平坐标 sec_left/sec_right，不复用平面图坐标
  const { SX0, SW, sec_cx, Z_top_px, pool_bot_y, SCALE_SEC, Z_top,
          sec_left, sec_right } = geo
  const SMT = 40  // 剖面图顶部留白（与 computeGeometry 保持一致）

  let s = ''

  // 背景
  s += _r(SX0, 0, SW, 560, '#fbfcfd', 'none')

  // 标题
  s += _t(SX0 + SW / 2, 25, 'A-A 剖 面 图', 12, '#1a5276', 'middle', 'bold')

  // ── 维护间 ──────────────────────────────────────────────────────────
  // 弯头最低点（立管→水平弯头底部，含管道半径）
  const horiz_y = Math.max(SMT + 30, Z_top_px - Math.min(room_H * SCALE_SEC * 0.45, 80))
  const elbow_r = Math.max(8, elbowCTF(DN_branch) / 1000 * SCALE_SEC * 0.5)
  const pipe_r_sec = Math.max(3, DN_branch / 1000 * SCALE_SEC / 2)
  // 弯头最低点 = 水平管 y + 弯头半径 + 管道半径（弯头圆弧外缘最低处）
  const elbow_bottom = horiz_y + elbow_r + pipe_r_sec
  // 维护间下边框必须包裹弯头最低点（弯头可能伸到池顶以下）
  const room_bottom_px = Math.max(elbow_bottom + 6, SMT + room_H * SCALE_SEC)
  // 维护间宽度维持原范围，下边框延伸至包裹弯头最低点
  s += _r(sec_left, SMT, sec_right - sec_left, room_bottom_px - SMT, '#fcfeff', '#2980b9', 2)
  s += _t((sec_left + sec_right) / 2, SMT + 16, '维护间', 9, '#2980b9', 'middle', 'bold')

  // ── Z_top 分割线 ───────────────────────────────────────────────────
  const z_top_y = Z_top_px  // Z_top = 池顶
  s += _l(SX0 + 4, z_top_y, SX0 + SW - 4, z_top_y, '#1a5276', 3)  // 粗线

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
    s += _r(sec_left, water_top, sec_right - sec_left, pool_bot_y - water_top, '#dcefff', 'none', 1, 'opacity="0.78"')
    s += _l(sec_left, Z_top_px, sec_left, pool_bot_y, '#2980b9', 2)
    s += _l(sec_right, Z_top_px, sec_right, pool_bot_y, '#2980b9', 2)
    s += _l(sec_left, pool_bot_y, sec_right, pool_bot_y, '#2980b9', 2)
  }

  // ── 集水坑 ─────────────────────────────────────────────────────────
  const Z_sumpVal = (Z_sump != null && !isNaN(Z_sump)) ? Z_sump : stopLevel
  let sump_bot_y = pool_bot_y
  if (Z_sumpVal < stopLevel - 0.01) {
    sump_bot_y = pool_bot_y + (stopLevel - Z_sumpVal) * SCALE_SEC
    const sump_w = Math.min(sec_right - sec_left, 90)
    const sump_l = sec_cx - sump_w / 2
    const sump_r = sec_cx + sump_w / 2
    s += _l(sump_l, sump_bot_y, sump_r, sump_bot_y, '#2980b9', 1.5)
    s += _l(sump_l, sump_bot_y, sump_l, pool_bot_y, '#2980b9', 1.5)
    s += _l(sump_r, sump_bot_y, sump_r, pool_bot_y, '#2980b9', 1.5)
    s += _t(sump_l - 4, (sump_bot_y + pool_bot_y) / 2 + 3, '集水坑', 8, '#2980b9', 'end', 'bold')
    s += _dv(sump_r + 12, pool_bot_y, sump_bot_y, 'H=' + fmt(stopLevel - Z_sumpVal, 1) + 'm', '#2471a3')
  }

  // ── 水位线标注 ────────────────────────────────────────────────────
  const wl_len = Math.min((sec_right - sec_left) * 0.25, 110)
  const wl_lx_left = sec_left + 10
  const wl_lx_right = sec_right - 10

  // 左侧水位
  const leftWL = [
    { lineY: alarm_low_y, name: '低报警', value: fmt(Z_alarm_low ?? stopLevel, 2) + 'mPD', color: '#c0392b' },
    { lineY: alarm_y, name: '高报警', value: fmt(alarmLevel, 2) + 'mPD', color: '#c0392b' },
    { lineY: max_y, name: '最高水位', value: fmt(Z_max ?? alarmLevel, 2) + 'mPD', color: '#c0392b' },
  ]
  placeLevelTags(leftWL).forEach(it => {
    s += _l(sec_left, it.lineY, sec_left + wl_len, it.lineY, it.color, 1.5, '4,2')
    s += _tag(wl_lx_left, it.tagY, it.name, it.value, it.color, 'start')
  })

  // 右侧水位
  const rightWL = [
    { lineY: start_y, name: '1#启', value: fmt(startLevel, 2) + 'mPD', color: '#27ae60' },
    { lineY: start2_y, name: '2#启', value: fmt(Z_start2 ?? alarmLevel, 2) + 'mPD', color: '#27ae60' },
    { lineY: stop_y, name: '停泵', value: fmt(stopLevel, 2) + 'mPD', color: '#555' },
  ].map(it => it.lineY === stop_y ? { ...it, prefer: 'above' } : it)
  placeLevelTags(rightWL).forEach(it => {
    s += _l(sec_right - wl_len, it.lineY, sec_right, it.lineY, it.color, 1.5, '4,2')
    s += _tag(wl_lx_right, it.tagY, it.name, it.value, it.color, 'end')
  })

  // ── 泵 ────────────────────────────────────────────────────────────
  const pump_w = Math.max(28, Math.min((sec_right - sec_left) * 0.15, 34))
  const pump_h = Math.max(18, pump_w * 0.6)
  const pump_x = sec_cx - pump_w / 2
  const pump_y = sump_bot_y - pump_h - 5
  const sectionPump = layoutMap?.representativeBranch?.pump || pumpsInOrder?.[0]

  s += _r(pump_x, pump_y, pump_w, pump_h, '#2471a3', '#1a5276', 1.5, 'rx="2"')
  s += _t(sec_cx, pump_y + pump_h / 2 + 2, sectionPump?.label || 'P', 8, '#fff', 'middle', 'bold')

  // 压水管：泵 → 穿过 Z_top → 维护间内水平管 → 拓扑设备
  const riser_x = sec_cx
  const outlet_x = Math.min(sec_right + 24, SX0 + SW - 58)

  s += _l(riser_x, pump_y, riser_x, horiz_y + elbow_r, '#2980b9', 2)
  s += _elbow(riser_x + elbow_r, horiz_y + elbow_r, elbow_r, 'left', 'top', '#2980b9', 2)
  s += _l(riser_x + elbow_r, horiz_y, outlet_x, horiz_y, '#2980b9', 2)
  s += `<circle cx="${riser_x.toFixed(1)}" cy="${Z_top_px.toFixed(1)}" r="${pipe_r_sec.toFixed(1)}" fill="none" stroke="#2980b9" stroke-width="1.5" stroke-dasharray="2,2"/>`
  s += _t(riser_x + 14, horiz_y - 12, `DN${DN_branch}`, 8, '#2980b9', 'start')

  const sectionChain = (layoutMap?.representativeBranch?.items || [])
    .filter(({ device }) => device && !device.isPump && device.type !== 'junction')
  const chainCount = sectionChain.length || 2
  const startX = riser_x + elbow_r + 28
  const stepX = Math.max(34, Math.min(70, (outlet_x - startX - 30) / Math.max(chainCount, 1)))
  const fallbackDevices = [
    { type: 'check_valve', label: '止回阀' },
    { type: 'gate_valve', label: '闸阀' },
  ]
  const renderChain = sectionChain.length ? sectionChain : fallbackDevices.map(device => ({
    device,
    halfLen: deviceHalfLen(device, DN_branch, SCALE_SEC),
  }))

  renderChain.forEach(({ device, halfLen }, i) => {
    const x = startX + i * stepX
    const hl = halfLen || deviceHalfLen(device, DN_branch, SCALE_SEC)
    if (device.type === 'check_valve') {
      s += `<g class="valve-group" data-type="${device.label || '止回阀'}" data-dn="${DN_branch}">`
      s += _checkValve(x, horiz_y, hl, true, '#c0392b')
      s += '</g>'
    } else if (device.type === 'gate_valve') {
      s += `<g class="valve-group" data-type="${device.label || '闸阀'}" data-dn="${DN_branch}">`
      s += _gateValve(x, horiz_y, hl, true, '#c0392b')
      s += '</g>'
    } else if (device.type === 'flowmeter') {
      const r_main = DN_main / 1000 * SCALE_SEC
      s += `<g class="valve-group" data-type="${device.label || '流量计'}" data-dn="${DN_branch}">`
      s += _flowmeter(x, horiz_y, hl, r_main / 2, true, '#c0392b')
      s += '</g>'
    }
  })
  s += _t(outlet_x - 2, horiz_y - 6, '出水', 9, '#2980b9', 'end')
  s += `<polygon points="${outlet_x.toFixed(1)},${horiz_y.toFixed(1)} ${(outlet_x - 8).toFixed(1)},${(horiz_y - 4).toFixed(1)} ${(outlet_x - 8).toFixed(1)},${(horiz_y + 4).toFixed(1)}" fill="#2980b9"/>`
  s += _tag(outlet_x + 6, horiz_y - TAG_H / 2, '▽ 出水管', fmt(Z_discharge, 2) + 'mPD', '#2980b9', 'start')

  // ── 尺寸标注 ──────────────────────────────────────────────────────
  s += _dv(sec_left - 38, SMT, Z_top_px, '净高 ' + fmt(room_H, 1) + 'm', '#2980b9')
  s += _dv(sec_left - 38, Z_top_px, pool_bot_y, 'h=' + fmt(h_pool, 1) + 'm', '#2980b9')

  // ▽ 标高符号（▽ 4.500 格式）
  const elev_y_pool_bot = pool_bot_y + 4
  s += _tag(sec_left + 10, Math.max(pool_bot_y - TAG_H - TAG_GAP, water_top + 8), '▽ 池底', fmt(stopLevel, 2) + 'mPD', '#2980b9', 'start')
  s += _tag(sec_left + 10, Math.max(SMT + 4, Z_top_px - TAG_H - TAG_GAP), '▽ 顶板', fmt(Z_top, 2) + 'mPD', '#1a5276', 'start')

  return { s, SX0, SW, sec_cx, Z_top_px, SCALE_SEC, DN_branch, DN_main }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 7. SVG 组装与渲染 ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// ── 8. 交互逻辑 ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

function setupInteractions(el, planData) {
  const { CANVAS_W, PH } = planData

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
  initSvgZoomPan(el, CANVAS_W, PH,
    { zIn: 'btn-ag31-zin', zOut: 'btn-ag31-zout', zRst: 'btn-ag31-rst' },
    { minScale: 1.0, maxScale: 5 })
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 主入口 ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 逐步预览：仅有 AG1-x 数据时渲染剖面图 + 平面图灰色占位
 * ag11 = runPoolDepth 结果，extra = { N, topology, Z_sump, Q_single, H_design, P_motor, catalogPump, DN_branch, DN_main }
 */
export function renderSectionPreview(ag11, extra = {}) {
  const el = document.getElementById('svg-ag31')
  if (!el || !ag11?.valid) return

  const {
    Z_sump = null, Q_single, H_design, P_motor, catalogPump,
    DN_branch = 150, DN_main = 300, topology = null, N = 2,
  } = extra

  const safeS = Math.min(ag11.S || 1, 100)

  const placeholderAg21 = {
    L: 6.0, W: 5.0, d_spacing: 1.0, e_wall: 0.8,
    w_pump: 0.6, d_pump: 0.8, N_total: Math.max(N, 2), h_room: null,
    hasCatalogDims: false, DN_branch, DN_main, DN_label: DN_main,
    c_wall_m: 0.8, L_elbow_m: 0.3,
    valvesAfterJunction: [],
  }
  const ag31Params = {
    h_pool: ag11.D,
    h_active: (ag11.Z_max ?? ag11.Z_alarm_high) - ag11.Z_stop,
    Z_stop: ag11.Z_stop, Z_start1: ag11.Z_start1, Z_start2: ag11.Z_start2,
    Z_alarm_high: ag11.Z_alarm_high, Z_alarm_low: ag11.Z_alarm_low, Z_max: ag11.Z_max,
  }

  const inputs = parseInputs(N, placeholderAg21, ag31Params, safeS, topology, {
    Z_sump, Q_single, H_design, P_motor, catalogPump,
  })
  const geo = computeGeometry(inputs)
  const layoutMap = topology ? buildLayoutMap(topology, geo, inputs) : null
  const sectionData = buildSectionView(inputs, geo, layoutMap)
  const infoSvg = buildInfoColumn(geo)
  const minimapSvg = buildMinimap(inputs, geo)

  const { PW, PH, PLAN_X } = geo
  const mid_y = PH / 2
  let planHolder = _r(PLAN_X, 0, PW, PH, '#f5f6f7', 'none')
  planHolder += _t(PLAN_X + PW / 2, mid_y - 10, '平面图', 13, '#bdc3c7', 'middle', 'bold')
  planHolder += _t(PLAN_X + PW / 2, mid_y + 12, '等待泵房维护间计算完成…', 10, '#bdc3c7', 'middle')

  el.setAttribute('viewBox', `0 0 ${geo.CANVAS_W} ${PH}`)
  el.innerHTML = infoSvg + planHolder + sectionData.s + minimapSvg
}

export function runDrawing(N, ag21, params, S, topology, extraInfo = {}) {
  const inputs = parseInputs(N, ag21, params, S, topology, extraInfo)
  const geo = computeGeometry(inputs)
  const infoSvg = buildInfoColumn(geo)
  const minimapSvg = buildMinimap(inputs, geo)
  const layoutMap = buildLayoutMap(topology, geo, inputs)
  const planData = buildPlanView(inputs, geo, layoutMap)
  const sectionData = buildSectionView(inputs, geo, layoutMap)

  // SVG 组装顺序：信息列 → 平面图 → 剖面图 → 缩略图（最后画，防止被覆盖）
  const el = document.getElementById('svg-ag31')
  el.setAttribute('viewBox', `0 0 ${geo.CANVAS_W} ${planData.PH}`)
  el.innerHTML = infoSvg + planData.s + sectionData.s + minimapSvg

  setupInteractions(el, planData)
}
