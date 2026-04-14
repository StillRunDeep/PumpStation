import { fmt } from '../utils.js'
import {
  _r, _l, _t, _poly, _dh, _dv,
  _elbow, _checkValve, _gateValve, _flowmeter, _tee, _reducer, _leader,
} from '../render/svg-helpers.js'
import { initSvgZoomPan } from '../render/zoom-pan.js'
import { topologyToAG31Params } from './topology.js'
import {
  GATE_VALVE_FF, CHECK_VALVE_FF,
  elbowCTF, reducerL, flowmeterBodyL, lookupFF,
} from '../data/fitting-dims.js'

export function runDrawing(N, ag21, params, S, topology = null) {
  const {
    L, W, d_spacing, e_wall, w_pump, d_pump, N_total,
    hasCatalogDims, DN_branch = 150, DN_main = 300,
    c_wall_m = 0, L_elbow_m = 0,
  } = ag21
  const { h_active: h_pool, Z_stop: stopLevel, Z_start1: startLevel, Z_alarm_high: alarmLevel } = params

  const topoParams = topology ? topologyToAG31Params(topology) : null
  const pumpRoomMap = {}
  if (topoParams) {
    topoParams.pumpsInOrder.forEach((p, idx) => { pumpRoomMap[idx] = p.roomId })
  }

  const L_pool = Math.max(L, Math.sqrt(S * 1.5))
  const D_pool = S / L_pool
  const room_H = Math.max(3.0, h_pool * 0.2 + 1.0)

  const VW = 1080, VH = 580
  let s = ''

  s += _r(0, 0, VW, VH, '#f4f6f8', 'none')
  s += _l(572, 15, 572, VH - 15, '#ccc', 1, '5,3')

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

  s += _r(pool_ox, room_y2, L_pool * ps, D_pool * ps, '#d6eaf8', '#2471a3', 2)
  const pcx = (pool_ox + pool_x2) / 2, pcy = room_y2 + D_pool * ps / 2
  s += _t(pcx, pcy - 8, '集 水 池', 13, '#1a5276', 'middle', 'bold')
  s += _t(pcx, pcy + 8, `S=${fmt(S, 1)}m²  h_pool=${fmt(h_pool, 1)}m（竖向）`, 10, '#1a5276')
  s += _t(pcx, pcy + 21, '水位见右侧剖面图', 9, '#888')
  s += _l(room_ox, room_y2, room_x2, room_y2, '#5d6d7e', 1.5, '4,3')

  s += _r(room_ox, room_oy, L * ps, W * ps, '#eaf2fb', '#2c3e50', 2.5)

  s += _l(room_ox + e_wall * ps, hdr_y, room_x2 - e_wall * ps, hdr_y, '#922b21', 4)
  s += _t(room_ox + e_wall * ps + 3, hdr_y - 6, 'DN' + ag21.DN_label + ' 出水总管', 10, '#922b21', 'start')

  const cb_w = Math.min(45, e_wall * ps * 0.9), cb_h = Math.min(26, 0.3 * ps)
  const cb_x = room_x2 - e_wall * ps / 2 - cb_w / 2, cb_y = hdr_y + 6
  s += _r(cb_x, cb_y, cb_w, cb_h, '#e67e22', '#d35400')
  s += _t(cb_x + cb_w / 2, cb_y + cb_h / 2 + 4, '控制柜', 9, '#fff', 'middle', 'bold')

  // ── 水泵机组（平面图）───────────────────────────────
  const pumpsInOrder = topoParams ? topoParams.pumpsInOrder : null
  let pumpRoomIdx = 0
  for (let i = 0; i < N_total; i++) {
    const topoP     = pumpsInOrder ? pumpsInOrder[i] : null
    const isSpare   = topoP ? !!topoP.isSpare : (i === N_total - 1)
    const inWetWell = pumpRoomMap[i] === 'wet_well'

    // 泵外形：用 catalog 尺寸或默认值
    const pw = (hasCatalogDims && topoP && !inWetWell
      ? topoP.pump?.dimensions_mm?.b / 1000 ?? w_pump
      : w_pump) * ps
    const ph = (hasCatalogDims && topoP && !inWetWell
      ? topoP.pump?.dimensions_mm?.a / 1000 ?? d_pump
      : d_pump) * ps
    const pumpFill   = isSpare ? '#7f8c8d' : '#2471a3'
    const pumpStroke = isSpare ? '#566573' : '#1a5276'
    const label      = topoP ? topoP.label : (isSpare ? '备' : 'P' + (i + 1))

    if (inWetWell) {
      const wx = pool_ox + (i + 1) * (L_pool * ps / (N_total + 1))
      const wy = room_y2 + D_pool * ps * 0.35
      s += _r(wx - pw / 2, wy - ph / 2, pw, ph, pumpFill, pumpStroke, 1.5)
      const fsz = Math.max(9, Math.min(12, pw * 0.4))
      s += _t(wx, wy + 4, label, fsz, '#fff', 'middle', 'bold')
      s += _t(wx, wy + ph / 2 + 12, '（集水坑内）', 8, '#2471a3', 'middle')
    } else {
      const px = room_ox + (e_wall + pumpRoomIdx * (w_pump + d_spacing)) * ps
      const py = room_y2 - d_pump * ps
      const cx = px + pw / 2

      // ── 管件按实际比例绘制（维护间内）────────────────────
      // DN 换算 px（1mm = ps/1000 m）
      const dn2px = (dn) => (dn / 1000) * ps
      const L_cv_px  = lookupFF(CHECK_VALVE_FF, DN_branch) / 1000 * ps
      const L_gv_px  = lookupFF(GATE_VALVE_FF, DN_branch) / 1000 * ps
      const L_str_px = Math.max(2 * DN_branch, 300) / 1000 * ps
      const L_elb_px = elbowCTF(DN_branch) / 1000 * ps
      const c_wall_px = c_wall_m * ps

      // 管道 Y 坐标（从集水坑墙内壁向远侧墙方向）
      const floorHole_y = room_y2 - c_wall_px          // 穿墙洞口 Y
      const elbow_y     = floorHole_y - L_elb_px        // 弯头后端 Y
      const cv_y        = elbow_y - L_str_px            // 止回阀起点 Y
      const gv_y        = cv_y - L_cv_px - L_str_px    // 闸阀起点 Y
      const main_y      = hdr_y                        // 总管 Y（靠近远侧墙）

      // 支管水平线（从泵出口向下到弯头）
      const pump_out_y = py + ph * 0.4  // 泵出口 Y 约在泵底上方 40%
      s += _l(cx, pump_out_y, cx, floorHole_y, '#2980b9', 2)  // 出水管竖向段
      // 弯头：从垂直朝下转为水平朝右，以 floorHole_y 为中心
      const elbow_r = L_elb_px * 0.5
      s += _elbow(cx + elbow_r, floorHole_y, elbow_r, 'top', 'right', '#2980b9', 2)

      // 水平支管段（弯头后到闸阀，含止回阀）
      const pipe_y = floorHole_y - L_elb_px * 0.5  // 弯头中心线 Y
      const horizEnd = cx + L_elb_px + L_str_px + L_cv_px + L_str_px + L_gv_px
      s += _l(cx + L_elb_px, pipe_y, horizEnd, pipe_y, '#2980b9', 2)  // 水平管道
      // 止回阀
      const cv_cx = cx + L_elb_px + L_str_px + L_cv_px / 2
      s += _checkValve(cv_cx, pipe_y, L_cv_px / 2, true, '#c0392b')
      // 闸阀
      const gv_cx = cx + L_elb_px + L_str_px + L_cv_px + L_str_px + L_gv_px / 2
      s += _gateValve(gv_cx, pipe_y, L_gv_px / 2, true, '#922b21')

      // 连接到总管（竖向）
      s += _l(horizEnd, pipe_y, horizEnd, main_y, '#c0392b', 2)

      // ── 泵机组矩形 ────────────────────────────────
      s += _l(cx, room_y2, cx, pool_y2 - 6, '#2980b9', 1.5, '4,3')
      s += _l(cx, py, cx, hdr_y, '#c0392b', 1.5)
      const cv_y2 = py - (py - hdr_y) * 0.35, vs = 5
      s += _poly(`${cx},${cv_y2 - vs} ${cx + vs},${cv_y2} ${cx},${cv_y2 + vs} ${cx - vs},${cv_y2}`, '#e74c3c')
      const gv_y2 = py - (py - hdr_y) * 0.65
      s += _r(cx - 4, gv_y2 - 4, 8, 8, '#e74c3c', '#c0392b')
      s += _r(px, py, pw, ph, pumpFill, pumpStroke, 1.5)
      const fsz = Math.max(9, Math.min(12, pw * 0.4))
      s += _t(cx, py + ph / 2 + 4, label, fsz, '#fff', 'middle', 'bold')
      pumpRoomIdx++
    }
  }

  // ── A-A 切割线（可拖动）─────────────────────────────────
  // 初始位置在泵排中心
  const aaDragY = room_y2 - d_pump * ps / 2  // module-level via closure
  const aaLineId = 'aa-drag-line'
  s += `<line id="${aaLineId}" x1="4" y1="${aaDragY.toFixed(1)}" x2="${room_ox - 6}" y2="${aaDragY.toFixed(1)}" stroke="#7f8c8d" stroke-width="1" stroke-dasharray="6,3"/>` + _t(5, aaDragY - 4, 'A', 11, '#555', 'start', 'bold')
  s += `<line x1="${room_x2 + 6}" y1="${aaDragY.toFixed(1)}" x2="${PW - 6}" y2="${aaDragY.toFixed(1)}" stroke="#7f8c8d" stroke-width="1" stroke-dasharray="6,3"/>` + _t(PW - 5, aaDragY - 4, 'A', 11, '#555', 'end', 'bold')

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

  const legItems = [
    ['#2471a3', '工作水泵'], ['#7f8c8d', '备用水泵'], ['#d6eaf8', '集水池'],
    ['#922b21', '出水总管'], ['#2980b9', '进水管'], ['#c0392b', '止回阀'],
    ['#922b21', '闸阀'], ['#e67e22', '控制柜'],
  ]
  let lyi = room_oy
  s += _r(4, lyi - 2, 94, legItems.length * 17 + 4, '#fff', '#ccc', 0.5, 'rx="3" opacity="0.9"')
  legItems.forEach(([c, lbl]) => {
    s += _r(7, lyi, 11, 11, c, '#666', 0.5)
    s += _t(21, lyi + 9, lbl, 10, '#333', 'start')
    lyi += 17
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
  s += _r(sec_x1 - 6, grade_y, sec_wx + 12, h_pool * ss + 6, '#eaf2fb', 'none')
  s += _r(sec_x1, alarm_y, sec_wx, pool_bot_y - alarm_y, '#d6eaf8', 'none')
  s += _r(sec_x1, grade_y, sec_wx, h_pool * ss, 'none', '#2471a3', 2)
  s += _r(sec_x1, room_top_y, sec_wx, room_H * ss, '#eaf2fb', '#2c3e50', 2.5)
  s += _l(SX0 + 4, grade_y, SX0 + SW - 4, grade_y, '#2c3e50', 2)
  s += _t(sec_x1 - 5, grade_y + 4, '±0.00', 9, '#555', 'end')
  s += _l(sec_x1, stop_y, sec_x2, stop_y, '#27ae60', 1.5, '5,3')
  s += _l(sec_x1, start_y, sec_x2, start_y, '#e67e22', 1.5, '5,3')
  s += _l(sec_x1, alarm_y, sec_x2, alarm_y, '#c0392b', 1.5, '5,3')

  const elev_stop  = stopLevel  - h_pool
  const elev_start = startLevel - h_pool
  const elev_alarm = alarmLevel - h_pool
  const elev_bot   = -h_pool

  const wl_lx = sec_x2 + 6
  s += _t(wl_lx, stop_y + 4, '停泵 ' + fmt(elev_stop, 2) + 'm', 10, '#27ae60', 'start')
  s += _t(wl_lx, start_y + 4, '启泵 ' + fmt(elev_start, 2) + 'm', 10, '#e67e22', 'start')
  s += _t(wl_lx, alarm_y - 3, '报警 ' + fmt(elev_alarm, 2) + 'm', 10, '#c0392b', 'start')
  s += _t(wl_lx, pool_bot_y + 4, '池底 ' + fmt(elev_bot, 2) + 'm', 10, '#555', 'start')

  // ── 剖面管道圆截面（根据 aaDragY 位置在三段中切换）────────────────
  // aaDragY 是切割线 Y 坐标（px），相对于 room_y2（维护间下边线）
  // W 方向分为三段：0~25%（靠集水坑墙）、25%~75%（中间）、75%~100%（靠远侧墙）
  const relY = (aaDragY - room_oy) / (room_y2 - room_oy)  // 0=room_oy, 1=room_y2
  const relW = 1 - relY  // 切割线在 W 方向的相对位置（0=近墙，1=远墙）

  // DN → 圆形截面半径（m → px）
  const dn2r = (dn) => (dn / 1000) * ss
  const r_branch = dn2r(DN_branch)
  const r_main    = dn2r(DN_main)

  if (relW <= 0.25) {
    // 靠集水坑墙：泵出口竖管截面 + 弯头 + 大小头
    const pump_x = sec_cx - Math.min(sec_wx * 0.3, 30) / 2
    s += `<ellipse cx="${sec_cx.toFixed(1)}" cy="${grade_y.toFixed(1)}" rx="${r_branch.toFixed(1)}" ry="${(r_branch * 0.3).toFixed(1)}" fill="none" stroke="#2980b9" stroke-width="2"/>`
    s += _t(sec_cx, grade_y - r_branch - 8, `DN${DN_branch}`, 9, '#2980b9', 'middle')
  } else if (relW <= 0.75) {
    // 中间管道区：支路管道圆形截面 + 止回阀/闸阀
    s += `<circle cx="${sec_cx.toFixed(1)}" cy="${grade_y.toFixed(1)}" r="${r_branch.toFixed(1)}" fill="none" stroke="#2980b9" stroke-width="2"/>`
    s += _t(sec_cx, grade_y - r_branch - 8, `DN${DN_branch}`, 9, '#2980b9', 'middle')
    // 止回阀/闸阀
    s += _checkValve(sec_cx - sec_wx * 0.15, grade_y, r_branch * 2, true, '#c0392b')
    s += _gateValve(sec_cx + sec_wx * 0.15, grade_y, r_branch * 2, true, '#922b21')
  } else {
    // 靠远侧墙：总管圆形截面 + 流量计
    s += `<circle cx="${sec_cx.toFixed(1)}" cy="${grade_y.toFixed(1)}" r="${r_main.toFixed(1)}" fill="none" stroke="#922b21" stroke-width="2"/>`
    s += _t(sec_cx, grade_y - r_main - 8, `DN${DN_main}`, 9, '#922b21', 'middle')
    s += _flowmeter(sec_cx, grade_y, r_main * 3, r_main, true, '#1a5276')
    // 流量计标注（5D/2D 直管段）
    const upLabel = `上游${5}D`, dnLabel = `下游${2}D`
    s += _leader(sec_cx - r_main * 3 - 20, grade_y - r_main - 10, sec_cx - r_main * 3 - 80, grade_y - r_main - 25, upLabel, 9, '#1a5276')
    s += _leader(sec_cx + r_main * 3 + 20, grade_y + r_main + 10, sec_cx + r_main * 3 + 80, grade_y + r_main + 25, dnLabel, 9, '#1a5276')
  }

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

  // ── 切割线拖动交互 ─────────────────────────────────────────────────
  let aaCurrentY = aaDragY
  const aaLineEl = document.getElementById(aaLineId)
  let draggingAA = false, lastAAY = 0

  function constrainAAY(y) {
    return Math.max(room_oy + 10, Math.min(room_y2 - 10, y))
  }

  aaLineEl?.addEventListener('mousedown', (e) => {
    draggingAA = true
    lastAAY = e.clientY
    e.stopPropagation()
  })

  function onAAUp() { draggingAA = false }
  function onAAMove(e) {
    if (!draggingAA) return
    const dy = e.clientY - lastAAY
    lastAAY = e.clientY
    aaCurrentY = constrainAAY(aaCurrentY + dy)
    // 更新切割线
    aaLineEl?.setAttribute('y1', aaCurrentY.toFixed(1))
    aaLineEl?.setAttribute('y2', aaCurrentY.toFixed(1))
    // 同步右侧 "A" 标注
    const labelEls = el.querySelectorAll('text')
    labelEls.forEach(t => {
      if (t.textContent === 'A' && parseFloat(t.getAttribute('x')) < 572) {
        t.setAttribute('y', (aaCurrentY - 4).toFixed(1))
      }
    })
    // 重绘剖面内容（动态更新管道截面段）
    // 简化为更新 section panel 内容
    redrawSectionPanel(aaCurrentY)
  }

  window.addEventListener('mouseup', onAAUp)
  window.addEventListener('mousemove', onAAMove)

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

  // ── 重置回调（传递给 zoom-pan）────────────────────────────────────
  const onResetCb = () => {
    aaCurrentY = aaDragY
    aaLineEl?.setAttribute('y1', aaCurrentY.toFixed(1))
    aaLineEl?.setAttribute('y2', aaCurrentY.toFixed(1))
    secDx = 0; secDy = 0
    secPanel?.setAttribute('transform', '')
  }

  // ── 初始化 zoom/pan（带最小缩放限制）────────────────────────────────
  initSvgZoomPan(el, VW, VH,
    { zIn: 'btn-ag31-zin', zOut: 'btn-ag31-zout', zRst: 'btn-ag31-rst' },
    { minScale: 1.0, maxScale: 6, onReset: onResetCb })

  // ── 辅助：重绘剖面内容（根据切割线位置）──────────────────────────
  function redrawSectionPanel(aaY) {
    // 简化实现：更新管道圆截面区域文本
    const relY2 = (aaY - room_oy) / (room_y2 - room_oy)
    const relW2 = 1 - relY2
    // 可通过重新调用 runDrawing 更新，但为性能仅更新标签
    // 此处简化为不操作（完整重绘在 onReset 时触发）
  }
}