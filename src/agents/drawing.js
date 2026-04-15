import { fmt } from '../utils.js'
import {
  _r, _l, _t, _poly, _dh, _dv,
  _elbow, _checkValve, _gateValve, _flowmeter, _tee, _reducer, _leader,
  _sectionLineBS,
} from '../render/svg-helpers.js'
import { initSvgZoomPan } from '../render/zoom-pan.js'
import { topologyToAG31Params } from './topology.js'
import {
  GATE_VALVE_FF, CHECK_VALVE_FF,
  elbowCTF, reducerL, flowmeterBodyL, lookupFF,
} from '../data/fitting-dims.js'

/**
 * AG3-1：设备流线二维示意
 *
 * @param {number} N - 工作泵台数
 * @param {Object} ag21 - AG2-1 输出 { L, W, d_spacing, e_wall, w_pump, d_pump, N_total, hasCatalogDims, DN_branch, DN_main, c_wall_m, L_elbow_m, DN_label }
 * @param {Object} params - AG1-1 输出 { h_active: h_pool, Z_stop: stopLevel, Z_start1: startLevel, Z_alarm_high: alarmLevel }
 * @param {number} S - 集水坑面积（m²）
 * @param {Object|null} topology - AG0-1 拓扑
 * @param {Object} extraInfo - 扩展信息 { Q_single, H_design, P_motor, catalogPump }
 */
export function runDrawing(N, ag21, params, S, topology = null, extraInfo = {}) {
  const {
    L, W, d_spacing = 1.0, e_wall = 0.8, w_pump, d_pump, N_total,
    hasCatalogDims, DN_branch = 150, DN_main = 300,
    c_wall_m = 0, L_elbow_m = 0,
  } = ag21
  const { h_active: h_pool, Z_stop: stopLevel, Z_start1: startLevel, Z_alarm_high: alarmLevel } = params
  const { Q_single, H_design, P_motor, catalogPump } = extraInfo

  const topoParams = topology ? topologyToAG31Params(topology) : null

  // 检测旁通管道
  let hasBypass = false
  if (topoParams) {
    const bypassGv = topoParams.devicesByRoom?.pump_room?.find(d => d.label?.startsWith('旁闸'))
    const bypassCv = topoParams.devicesByRoom?.pump_room?.find(d => d.label?.startsWith('旁止'))
    hasBypass = !!(bypassGv && bypassCv)
  }

  const L_pool = Math.max(L, Math.sqrt(S * 1.5))
  const D_pool = S / L_pool
  const room_H = Math.max(3.0, h_pool * 0.2 + 1.0)

  const VW = 1080, VH = 580
  let s = ''

  s += _r(0, 0, VW, VH, '#fafafa', 'none')
  s += _l(572, 15, 572, VH - 15, '#e8e8e8', 1, '5,3')

  // ── Plan view (left) ──────────────────────────────────────────────────────────
  const PML = 78, PMR = 48, PMT = 55, PMB = 62
  const PW = 572, PH = VH
  const pavw = PW - PML - PMR, pavh = PH - PMT - PMB
  const ps = Math.min(pavw / L_pool, pavh / (W + D_pool))
  const pool_ox = PML + (pavw - L_pool * ps) / 2
  const room_ox = pool_ox + (L_pool - L) / 2 * ps
  const room_oy = PMT + (pavh - (W + D_pool) * ps) / 2
  const room_x2 = room_ox + L * ps
  const room_y2 = room_oy + W * ps
  const pool_x2 = pool_ox + L_pool * ps
  const pool_y2 = room_y2 + D_pool * ps
  const hdr_y   = room_oy + Math.max(14, 0.2 * ps)

  s += _t(PW / 2, PMT - 14, '平 面 图（俯 视）', 13, '#1a5276', 'middle', 'bold')

  s += _r(pool_ox, room_y2, L_pool * ps, D_pool * ps, '#f8fbff', '#2471a3', 2)
  const pcx = (pool_ox + pool_x2) / 2, pcy = room_y2 + D_pool * ps / 2
  s += _t(pcx, pcy - 8, '集 水 池', 13, '#1a5276', 'middle', 'bold')
  s += _t(pcx, pcy + 8, `S=${fmt(S, 1)}m²  h=${fmt(h_pool, 1)}m`, 10, '#1a5276')
  s += _t(pcx, pcy + 21, '水位见右侧剖面图', 9, '#888')
  s += _l(room_ox, room_y2, room_x2, room_y2, '#5d6d7e', 1.5, '4,3')

  s += _r(room_ox, room_oy, L * ps, W * ps, '#f8fbff', '#2c3e50', 2.5)

  // 总管（DN_main，2.5px 粗线）
  s += _l(room_ox + e_wall * ps, hdr_y, room_x2 - e_wall * ps, hdr_y, '#922b21', 2.5)
  s += _t(room_ox + e_wall * ps + 3, hdr_y - 6, 'DN' + ag21.DN_label + ' 出水总管', 10, '#922b21', 'start')

  const cb_w = Math.min(45, e_wall * ps * 0.9), cb_h = Math.min(26, 0.3 * ps)
  const cb_x = room_x2 - e_wall * ps / 2 - cb_w / 2, cb_y = hdr_y + 6
  s += _r(cb_x, cb_y, cb_w, cb_h, '#e67e22', '#d35400')
  s += _t(cb_x + cb_w / 2, cb_y + cb_h / 2 + 4, '控制柜', 9, '#fff', 'middle', 'bold')

  // ── DN 换算 px ──────────────────────────────────────────────────
  const L_cv_px  = lookupFF(CHECK_VALVE_FF, DN_branch) / 1000 * ps
  const L_gv_px  = lookupFF(GATE_VALVE_FF, DN_branch) / 1000 * ps
  const L_str_px = Math.max(2 * DN_branch, 300) / 1000 * ps
  const L_elb_px = elbowCTF(DN_branch) / 1000 * ps
  const c_wall_px = c_wall_m * ps

  // DN 标注辅助函数（空间不足用引线）
  const dnLabel = (x, y, dn, horiz = true) => {
    const label = `DN${dn}`
    if (horiz) {
      if (y > 15) return _t(x, y - 10, label, 9, '#555', 'middle')
      return _leader(x, y + 8, x, y + 28, label, 9, '#555')
    } else {
      if (x > 15) return _t(x - 10, y, label, 9, '#555', 'end', 'normal')
      return _leader(x + 8, y, x + 28, y, label, 9, '#555')
    }
  }

  // ── 潜污泵（集水坑内）───────────────────────────────
  const pumpsInOrder = topoParams ? topoParams.pumpsInOrder : null
  const pumpXPositions = []  // 记录每台泵的 X 坐标（用于竖向管道）

  for (let i = 0; i < N_total; i++) {
    const topoP     = pumpsInOrder ? pumpsInOrder[i] : null
    const isSpare   = topoP ? !!topoP.isSpare : (i === N_total - 1)
    const label      = topoP ? topoP.label : (isSpare ? '备' : 'P' + (i + 1))

    // 泵外形：用 catalog 尺寸或默认值
    const pw = (hasCatalogDims && topoP
      ? (topoP.pump?.dimensions_mm?.b || w_pump) / 1000
      : w_pump) * ps
    const ph = (hasCatalogDims && topoP
      ? (topoP.pump?.dimensions_mm?.a || d_pump) / 1000
      : d_pump) * ps
    const pumpFill   = isSpare ? '#7f8c8d' : '#2471a3'
    const pumpStroke = isSpare ? '#566573' : '#1a5276'

    // 泵位置：集水坑内，沿 X 方向等间距排列
    const pumpSpacing = (L_pool * ps) / (N_total + 1)
    const wx = pool_ox + (i + 1) * pumpSpacing
    const wy = room_y2 + D_pool * ps * 0.4
    pumpXPositions.push(wx)

    // 泵矩形（hover 用 data-* 属性）
    const pumpModel = catalogPump?.pump?.model || ''
    s += `<g class="pump-group"
        data-pump="${label}"
        data-q="${Q_single || ''}"
        data-h="${H_design || ''}"
        data-kw="${P_motor || ''}"
        data-model="${pumpModel}">`
    s += _r(wx - pw / 2, wy - ph / 2, pw, ph, pumpFill, pumpStroke, 1.5)
    const fsz = Math.max(9, Math.min(12, pw * 0.4))
    s += _t(wx, wy + 4, label, fsz, '#fff', 'middle', 'bold')
    s += '</g>'

    // Q 标注（泵上方）
    if (Q_single) {
      s += _t(wx, wy - ph / 2 - 8, `Q=${fmt(Q_single, 0)} m³/h`, 9, '#444', 'middle')
    }

    // ── 压水管（竖向穿楼板）────────────────────────────
    // 穿楼板孔（圆形）
    const floorHoleX = wx
    const floorHoleY = room_y2
    s += `<circle cx="${floorHoleX.toFixed(1)}" cy="${floorHoleY.toFixed(1)}" r="6" fill="none" stroke="#2980b9" stroke-width="1.5" stroke-dasharray="3,2"/>`

    // 压水管竖向段（集水坑内 → 穿楼板孔）
    s += _l(floorHoleX, wy + ph / 2, floorHoleX, floorHoleY, '#2980b9', 1.5, '4,3')

    // ── 分支管路（维护间内，Y 方向水平）────────────────
    // 从穿楼板孔向总管方向（Y 减小方向）延伸
    const pipeY = floorHoleY - L_elb_px * 0.5  // 弯头中心线 Y
    const horizEndX = floorHoleX + L_elb_px + L_str_px + L_cv_px + L_str_px + L_gv_px

    // 水平支管段（单线 1.5px）
    s += _l(floorHoleX + L_elb_px, pipeY, horizEndX, pipeY, '#2980b9', 1.5)
    s += dnLabel(floorHoleX + L_elb_px + (horizEndX - floorHoleX - L_elb_px) / 2, pipeY + 10, DN_branch)

    // 弯头
    const elbow_r = L_elb_px * 0.5
    s += _elbow(floorHoleX + elbow_r, floorHoleY, elbow_r, 'top', 'right', '#2980b9', 1.5)

    // 止回阀（竖向 horiz=false，颜色红）
    const cv_cx = floorHoleX + L_elb_px + L_str_px + L_cv_px / 2
    s += `<g class="valve-group" data-type="止回阀" data-dn="${DN_branch}" data-ff="${lookupFF(CHECK_VALVE_FF, DN_branch)}" data-std="GB/T 12221">`
    s += _checkValve(cv_cx, pipeY, L_cv_px / 2, false, '#c0392b')
    s += '</g>'

    // 闸阀（竖向 horiz=false，颜色深红）
    const gv_cx = floorHoleX + L_elb_px + L_str_px + L_cv_px + L_str_px + L_gv_px / 2
    s += `<g class="valve-group" data-type="闸阀" data-dn="${DN_branch}" data-ff="${lookupFF(GATE_VALVE_FF, DN_branch)}" data-std="GB/T 12221">`
    s += _gateValve(gv_cx, pipeY, L_gv_px / 2, false, '#922b21')
    s += '</g>'

    // 连接到总管（竖向）
    s += _l(horizEndX, pipeY, horizEndX, hdr_y, '#c0392b', 1.5)
  }

  // ── 旁通管道（若有）───────────────────────────────
  if (hasBypass) {
    // 旁通：从总管引出，绕集水坑边缘回进水
    const bypassY = hdr_y + 20
    s += _l(room_x2 - e_wall * ps, bypassY, pool_x2 - 10, bypassY, '#7f8c8d', 1.5, '5,3')
    s += _l(pool_x2 - 10, bypassY, pool_x2 - 10, room_y2 + 10, '#7f8c8d', 1.5, '5,3')
    s += _l(pool_x2 - 10, room_y2 + 10, pool_ox + 10, room_y2 + 10, '#7f8c8d', 1.5, '5,3')
    s += _l(pool_ox + 10, room_y2 + 10, pool_ox + 10, pool_y2 - 10, '#7f8c8d', 1.5, '5,3')
    s += _t(pool_ox + 20, bypassY - 5, '旁通', 9, '#7f8c8d', 'start')
  }

  // ── BS EN ISO 128 剖面切割线（可点击拖动）──────────────────
  const aaDragY = room_oy + W * ps / 2  // 初始在维护间 Y 方向中间
  // 包在 section-block 组内，透明 rect 作为点击区域
  s += `<g id="section-block" class="section-block">`
  // 透明点击区（覆盖维护间垂直范围，左侧+右侧延伸部分）
  s += _r(0, room_oy - 20, room_ox - 4, room_y2 - room_oy + 40, 'transparent', 'none')
  s += _r(room_x2 + 4, room_oy - 20, PW - room_x2 - 4, room_y2 - room_oy + 40, 'transparent', 'none')
  // 切割线本身
  s += _sectionLineBS(4, room_ox - 6, aaDragY, 'A', '#555')
  s += _sectionLineBS(room_x2 + 6, PW - 4, aaDragY, 'A', '#555')
  s += `</g>`

  // ── 尺寸标注 ─────────────────────────────────────────────────
  const dim_by = pool_y2 + 28
  s += _dh(room_ox, room_x2, dim_by, 'L=' + fmt(L, 1) + 'm', '#1a3a5c')
  if (Math.abs(L_pool - L) > 0.05)
    s += _dh(pool_ox, pool_x2, dim_by + 22, 'L_pool=' + fmt(L_pool, 1) + 'm', '#2471a3')
  const dim_rx = pool_x2 + 32
  s += _dv(dim_rx, room_oy, room_y2, 'W=' + fmt(W, 1) + 'm', '#1a3a5c')
  s += _dv(dim_rx, room_y2, pool_y2, 'D=' + fmt(D_pool, 2) + 'm', '#2471a3')
  if (N >= 2) {
    const p0x = room_ox + (e_wall + w_pump) * ps, p1x = p0x + d_spacing * ps
    const sp_y = room_y2 - d_pump * ps * 0.5
    s += _dh(p0x, p1x, sp_y, 'd=' + fmt(d_spacing, 1) + 'm', '#27ae60')
  }
  s += _dh(room_ox, room_ox + e_wall * ps, room_oy + 18, 'e=' + fmt(e_wall, 1) + 'm', '#8e44ad')

  // ── 图例（右下角，更紧凑）──────────────────────────
  const legItems = [
    ['#2471a3', '工作水泵'], ['#7f8c8d', '备用水泵'], ['#f8fbff', '集水池'],
    ['#922b21', '出水总管'], ['#c0392b', '止回阀'], ['#922b21', '闸阀'],
    ['#7f8c8d', '旁通管道'], ['#e67e22', '控制柜'],
  ]
  const legX = PW - 110, legY = VH - 160
  s += _r(legX, legY, 100, legItems.length * 15 + 8, '#fff', '#ccc', 0.8, 'rx="3" opacity="0.92"')
  let lyi = legY + 6
  legItems.forEach(([c, lbl]) => {
    s += _r(legX + 6, lyi, 10, 10, c, '#666', 0.5)
    s += _t(legX + 19, lyi + 8, lbl, 9, '#333', 'start')
    lyi += 15
  })

  const bar_len = ps, bx = room_ox, by_bar = pool_y2 + 10
  s += _l(bx, by_bar, bx + bar_len, by_bar, '#333', 2)
  s += _l(bx, by_bar - 4, bx, by_bar + 4, '#333', 1.5)
  s += _l(bx + bar_len, by_bar - 4, bx + bar_len, by_bar + 4, '#333', 1.5)
  s += _t(bx + bar_len / 2, by_bar - 6, '1 m', 10, '#333')

  // ── Section view (right) —包裹在可拖动组内──────────────────────────────
  const SX0 = 580, SW = VW - SX0
  const SML = 65, SMR = 80, SMT = 55, SMB = 55
  const savw = SW - SML - SMR, savh = VH - SMT - SMB
  const ss = Math.min(savw / (W + 1.5), savh / (room_H + h_pool + 0.5))

  const sec_cx = SX0 + SML + savw / 2
  const sec_wx = W * ss
  const sec_x1 = sec_cx - sec_wx / 2, sec_x2 = sec_cx + sec_wx / 2
  const grade_y    = SMT + room_H * ss
  const room_top_y = SMT
  const pool_bot_y = grade_y + h_pool * ss

  const stop_y  = pool_bot_y - stopLevel * ss
  const start_y = pool_bot_y - startLevel * ss
  const alarm_y = pool_bot_y - alarmLevel * ss

  // section panel 组（可拖动）
  const sectionPanelId = 'section-panel'
  s += `<g id="${sectionPanelId}">`

  s += _t(SX0 + SW / 2, SMT - 14, 'A-A 剖 面 图（沿 泵 轴）', 13, '#1a5276', 'middle', 'bold')
  s += _r(sec_x1 - 6, grade_y, sec_wx + 12, h_pool * ss + 6, '#f8fbff', 'none')
  s += _r(sec_x1, alarm_y, sec_wx, pool_bot_y - alarm_y, '#d6eaf8', 'none')
  s += _r(sec_x1, grade_y, sec_wx, h_pool * ss, 'none', '#2471a3', 2)
  s += _r(sec_x1, room_top_y, sec_wx, room_H * ss, '#f8fbff', '#2c3e50', 2.5)
  s += _l(SX0 + 4, grade_y, SX0 + SW - 4, grade_y, '#2c3e50', 2)
  s += _t(sec_x1 - 5, grade_y + 4, '±0.00', 9, '#555', 'end')
  s += _l(sec_x1, stop_y, sec_x2, stop_y, '#27ae60', 1.5, '5,3')
  s += _l(sec_x1, start_y, sec_x2, start_y, '#e67e22', 1.5, '5,3')
  s += _l(sec_x1, alarm_y, sec_x2, alarm_y, '#c0392b', 1.5, '5,3')

  const elev_stop  = stopLevel  - h_pool
  const elev_start = startLevel - h_pool
  const elev_alarm = alarmLevel - h_pool
  const elev_bot   = -h_pool

  // 水位标注分组：停泵/报警在左侧，启泵在右侧
  const wl_lx_left = sec_x1 - 6   // 左侧标注（anchor='end'）
  const wl_lx_right = sec_x2 + 6  // 右侧标注（anchor='start'）
  s += _t(wl_lx_left, stop_y + 4, '停泵 ' + fmt(elev_stop, 2) + 'm', 10, '#27ae60', 'end')
  s += _t(wl_lx_right, start_y + 4, '启泵 ' + fmt(elev_start, 2) + 'm', 10, '#e67e22', 'start')
  s += _t(wl_lx_left, alarm_y - 3, '报警 ' + fmt(elev_alarm, 2) + 'm', 10, '#c0392b', 'end')
  s += _t(wl_lx_right, pool_bot_y + 4, '池底 ' + fmt(elev_bot, 2) + 'm', 10, '#555', 'start')

  // ── 剖面管道圆截面（根据 aaDragY 位置在三段中切换）────────────────
  // aaDragY 是切割线 Y 坐标（px），相对于 room_y2（维护间下边线）
  // W 方向分为三段：0~25%（靠集水坑墙）、25%~75%（中间）、75%~100%（靠远侧墙）
  const relY = (aaDragY - room_oy) / (room_y2 - room_oy)  // 0=room_oy, 1=room_y2
  const relW = 1 - relY  // 切割线在 W 方向的相对位置（0=近墙，1=远墙）

  // DN → 圆形截面半径（m → px）
  const dn2r = (dn) => (dn / 1000) * ss
  const r_branch = dn2r(DN_branch)
  const r_main    = dn2r(DN_main)

  s += `<g id="section-pipe-xsection">`
  if (relW <= 0.25) {
    // 靠集水坑墙：泵出口竖管截面 + 弯头 + 大小头
    s += `<ellipse cx="${sec_cx.toFixed(1)}" cy="${grade_y.toFixed(1)}" rx="${r_branch.toFixed(1)}" ry="${(r_branch * 0.3).toFixed(1)}" fill="none" stroke="#2980b9" stroke-width="2"/>`
    s += _t(sec_cx, grade_y - r_branch - 8, `DN${DN_branch}`, 9, '#2980b9', 'middle')
  } else if (relW <= 0.75) {
    // 中间管道区：支路管道圆形截面 + 止回阀/闸阀
    s += `<circle cx="${sec_cx.toFixed(1)}" cy="${grade_y.toFixed(1)}" r="${r_branch.toFixed(1)}" fill="none" stroke="#2980b9" stroke-width="2"/>`
    s += _t(sec_cx, grade_y - r_branch - 8, `DN${DN_branch}`, 9, '#2980b9', 'middle')
    s += _checkValve(sec_cx - sec_wx * 0.15, grade_y, r_branch * 2, true, '#c0392b')
    s += _gateValve(sec_cx + sec_wx * 0.15, grade_y, r_branch * 2, true, '#922b21')
  } else {
    // 靠远侧墙：总管圆形截面 + 流量计
    s += `<circle cx="${sec_cx.toFixed(1)}" cy="${grade_y.toFixed(1)}" r="${r_main.toFixed(1)}" fill="none" stroke="#922b21" stroke-width="2"/>`
    s += _t(sec_cx, grade_y - r_main - 8, `DN${DN_main}`, 9, '#922b21', 'middle')
    s += _flowmeter(sec_cx, grade_y, r_main * 3, r_main, true, '#1a5276')
    const upLabel = `上游${5}D`, dnLabel = `下游${2}D`
    s += _leader(sec_cx - r_main * 3 - 20, grade_y - r_main - 10, sec_cx - r_main * 3 - 80, grade_y - r_main - 25, upLabel, 9, '#1a5276')
    s += _leader(sec_cx + r_main * 3 + 20, grade_y + r_main + 10, sec_cx + r_main * 3 + 80, grade_y + r_main + 25, dnLabel, 9, '#1a5276')
  }
  s += `</g>`

  const pump_w = Math.min(sec_wx * 0.35, 30), pump_h = Math.min(room_H * ss * 0.25, 28)
  const pump_x = sec_cx - pump_w / 2, pump_y = grade_y - pump_h - 4
  s += _r(pump_x, pump_y, pump_w, pump_h, '#2471a3', '#1a5276', 1.5)
  s += _t(pump_x + pump_w / 2, pump_y + pump_h / 2 + 4, 'P', 10, '#fff', 'middle', 'bold')

  const pcx_s = pump_x + pump_w / 2
  s += _l(pcx_s, pump_y + pump_h, pcx_s, pool_bot_y - 6, '#2980b9', 2)
  s += _poly(`${pcx_s},${pool_bot_y - 6} ${pcx_s - 4},${pool_bot_y - 14} ${pcx_s + 4},${pool_bot_y - 14}`, '#2980b9')

  const out_x = pcx_s + pump_w * 0.35
  s += _l(out_x, pump_y, out_x, room_top_y + 4, '#c0392b', 2)
  s += _poly(`${out_x},${room_top_y + 4} ${out_x - 4},${room_top_y + 12} ${out_x + 4},${room_top_y + 12}`, '#c0392b')

  const sec_dvx = sec_x1 - 32
  s += _dv(sec_dvx, room_top_y, grade_y, '室高 ' + fmt(room_H, 1) + 'm', '#1a3a5c')
  s += _dv(sec_dvx, grade_y, pool_bot_y, 'h_pool=' + fmt(h_pool, 1) + 'm', '#2471a3')
  s += _dh(sec_x1, sec_x2, pool_bot_y + 28, 'W=' + fmt(W, 1) + 'm', '#1a3a5c')

  s += `</g>`  // end section-panel

  const el = document.getElementById('svg-ag31')
  el.setAttribute('viewBox', `0 0 ${VW} ${VH}`)
  el.innerHTML = s

  // ── 剖面符号块交互（独立于画布 zoom/pan）──────────────────────────
  let aaCurrentY = aaDragY
  let sectionSelected = false   // 选中状态
  let sectionDragging = false   // 拖动状态
  let lastSectionY = 0

  function constrainAAY(y) {
    return Math.max(room_oy + 10, Math.min(room_y2 - 10, y))
  }

  function setSectionSelected(val) {
    sectionSelected = val
    el.querySelector('#section-block')?.classList.toggle('section-selected', val)
    // 选中时：画布 zoom 暂停（通过在 svg 上加 class）
    el.classList.toggle('section-drag-active', val)
  }

  // 点击 section-block → 选中（capture phase 先于 zoom-pan 的 bubble listener）
  el.addEventListener('mousedown', (e) => {
    const block = el.querySelector('#section-block')
    if (!block) return
    if (block.contains(e.target) || e.target === block) {
      if (!sectionSelected) setSectionSelected(true)
      sectionDragging = true
      lastSectionY = e.clientY
      e.preventDefault()
      e.stopPropagation()  // 阻止 zoom-pan 的 bubble listener
    }
  }, { capture: true })

  // 全局移动/抬起（拖动用）
  window.addEventListener('mousemove', onSectionMove)
  window.addEventListener('mouseup', onSectionUp)

  function onSectionMove(e) {
    if (!sectionDragging) return
    e.preventDefault()  // 阻止拖动时选中文本
    const dy = e.clientY - lastSectionY
    lastSectionY = e.clientY
    aaCurrentY = constrainAAY(aaCurrentY + dy)
    redrawSectionLines(aaCurrentY)
  }

  function onSectionUp() {
    sectionDragging = false
  }

  // 点击空白处 → 取消选中
  el.addEventListener('mousedown', (e) => {
    const block = el.querySelector('#section-block')
    if (sectionSelected && block && !block.contains(e.target) && e.target !== block) {
      setSectionSelected(false)
    }
  })

  // ESC → 取消选中
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sectionSelected) {
      setSectionSelected(false)
    }
  })

  // 重绘切割线位置（完整重建 section-block SVG 内容）
  function redrawSectionLines(y) {
    const color = sectionSelected ? '#e74c3c' : '#555'
    let html = ''
    // 透明点击区
    html += _r(0, room_oy - 20, room_ox - 4, room_y2 - room_oy + 40, 'transparent', 'none')
    html += _r(room_x2 + 4, room_oy - 20, PW - room_x2 - 4, room_y2 - room_oy + 40, 'transparent', 'none')
    // 切割线
    html += _sectionLineBS(4, room_ox - 6, y, 'A', color)
    html += _sectionLineBS(room_x2 + 6, PW - 4, y, 'A', color)
    const block = el.querySelector('#section-block')
    if (block) block.innerHTML = html
    // 同步更新剖面截面
    redrawSectionPanel(y)
  }

  // ── Hover 卡片交互 ─────────────────────────────────────────────────
  const tooltipPump = document.getElementById('pump-tooltip')
  const tooltipValve = document.getElementById('valve-tooltip')

  el.querySelectorAll('.pump-group').forEach(g => {
    g.addEventListener('mouseenter', (e) => {
      if (!tooltipPump) return
      const { pump, q, h, kw, model } = g.dataset
      tooltipPump.innerHTML = `<strong>${pump}</strong><br>Q=${q || '—'} m³/h<br>H=${h || '—'} m<br>P=${kw || '—'} kW<br>${model ? `<small>${model}</small>` : ''}`
      tooltipPump.style.display = 'block'
      const rect = el.getBoundingClientRect()
      tooltipPump.style.left = (e.clientX - rect.left + 10) + 'px'
      tooltipPump.style.top = (e.clientY - rect.top - 10) + 'px'
    })
    g.addEventListener('mouseleave', () => {
      if (tooltipPump) tooltipPump.style.display = 'none'
    })
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
      const { type, dn, ff, std } = g.dataset
      tooltipValve.innerHTML = `<strong>${type}</strong><br>DN${dn}<br>FF=${ff} mm<br>${std}`
      tooltipValve.style.display = 'block'
      const rect = el.getBoundingClientRect()
      tooltipValve.style.left = (e.clientX - rect.left + 10) + 'px'
      tooltipValve.style.top = (e.clientY - rect.top - 10) + 'px'
    })
    g.addEventListener('mouseleave', () => {
      if (tooltipValve) tooltipValve.style.display = 'none'
    })
    g.addEventListener('mousemove', (e) => {
      if (!tooltipValve) return
      const rect = el.getBoundingClientRect()
      tooltipValve.style.left = (e.clientX - rect.left + 10) + 'px'
      tooltipValve.style.top = (e.clientY - rect.top - 10) + 'px'
    })
  })

  // ── 剖面组拖动交互 ─────────────────────────────────────────────────
  let secDragging = false, secLast = { x: 0, y: 0 }
  let secDx = 0, secDy = 0
  const secPanel = document.getElementById(sectionPanelId)

  secPanel?.addEventListener('mousedown', (e) => {
    // 只在 section 区域内部响应，避免与整体 SVG pan 冲突
    const rect = el.getBoundingClientRect()
    const sx = (e.clientX - rect.left) / rect.width * VW
    const sy = (e.clientY - rect.top) / rect.height * VH
    if (sx >= SX0) {  // 仅在右侧剖面区响应
      secDragging = true
      secLast = { x: e.clientX, y: e.clientY }
      e.stopPropagation()
      e.preventDefault()
    }
  })

  function onSecUp() { secDragging = false }
  function onSecMove(e) {
    if (!secDragging) return
    const dx = e.clientX - secLast.x
    const dy = e.clientY - secLast.y
    secLast = { x: e.clientX, y: e.clientY }
    secDx += dx; secDy += dy
    secPanel?.setAttribute('transform', `translate(${secDx.toFixed(1)},${secDy.toFixed(1)})`)
  }

  window.addEventListener('mouseup', onSecUp)
  window.addEventListener('mousemove', onSecMove)

  // ── 重置回调 ──────────────────────────────────────────────────────
  const onResetCb = () => {
    aaCurrentY = aaDragY
    secDx = 0; secDy = 0
    secPanel?.setAttribute('transform', '')
  }

  // ── 初始化 zoom/pan（带最小缩放限制）────────────────────────────────
  initSvgZoomPan(el, VW, VH,
    { zIn: 'btn-ag31-zin', zOut: 'btn-ag31-zout', zRst: 'btn-ag31-rst' },
    { minScale: 1.0, maxScale: 6, onReset: onResetCb })

  // ── 辅助：重绘剖面截面（根据切割线 Y 位置）────────────────────────
  function redrawSectionPanel(aaY) {
    const relY = (aaY - room_oy) / (room_y2 - room_oy)
    const relW = 1 - relY
    const dn2r = (dn) => (dn / 1000) * ss
    const r_branch = dn2r(DN_branch)
    const r_main   = dn2r(DN_main)

    let html = ''
    if (relW <= 0.25) {
      html += `<ellipse cx="${sec_cx.toFixed(1)}" cy="${grade_y.toFixed(1)}" rx="${r_branch.toFixed(1)}" ry="${(r_branch * 0.3).toFixed(1)}" fill="none" stroke="#2980b9" stroke-width="2"/>`
      html += `<text x="${sec_cx}" y="${(grade_y - r_branch - 8).toFixed(1)}" text-anchor="middle" font-size="9" fill="#2980b9">DN${DN_branch}</text>`
    } else if (relW <= 0.75) {
      html += `<circle cx="${sec_cx.toFixed(1)}" cy="${grade_y.toFixed(1)}" r="${r_branch.toFixed(1)}" fill="none" stroke="#2980b9" stroke-width="2"/>`
      html += `<text x="${sec_cx}" y="${(grade_y - r_branch - 8).toFixed(1)}" text-anchor="middle" font-size="9" fill="#2980b9">DN${DN_branch}</text>`
      // 止回阀/闸阀符号（简化：矩形表示）
      html += `<rect x="${(sec_cx - sec_wx * 0.15 - r_branch).toFixed(1)}" y="${(grade_y - r_branch).toFixed(1)}" width="${(r_branch * 2).toFixed(1)}" height="${(r_branch * 2).toFixed(1)}" fill="none" stroke="#c0392b" stroke-width="1.5" transform="rotate(45,${sec_cx.toFixed(1)},${grade_y.toFixed(1)})"/>`
      html += `<rect x="${(sec_cx + sec_wx * 0.15 - r_branch).toFixed(1)}" y="${(grade_y - r_branch).toFixed(1)}" width="${(r_branch * 2).toFixed(1)}" height="${(r_branch * 2).toFixed(1)}" fill="none" stroke="#922b21" stroke-width="1.5"/>`
    } else {
      html += `<circle cx="${sec_cx.toFixed(1)}" cy="${grade_y.toFixed(1)}" r="${r_main.toFixed(1)}" fill="none" stroke="#922b21" stroke-width="2"/>`
      html += `<text x="${sec_cx}" y="${(grade_y - r_main - 8).toFixed(1)}" text-anchor="middle" font-size="9" fill="#922b21">DN${DN_main}</text>`
      // 流量计（简化矩形）
      html += `<rect x="${(sec_cx - r_main * 3).toFixed(1)}" y="${(grade_y - r_main).toFixed(1)}" width="${(r_main * 6).toFixed(1)}" height="${(r_main * 2).toFixed(1)}" fill="none" stroke="#1a5276" stroke-width="1.5"/>`
      html += `<text x="${sec_cx}" y="${(grade_y + r_main * 2 + 14).toFixed(1)}" text-anchor="middle" font-size="9" fill="#1a5276">流量计</text>`
    }

    const xsection = el.querySelector('#section-pipe-xsection')
    if (xsection) xsection.innerHTML = html
  }
}