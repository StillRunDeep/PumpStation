import { fmt } from '../utils.js'
import {
  _r, _l, _t, _poly, _dh, _dv,
  _elbow, _checkValve, _gateValve, _flowmeter, _tee, _leader,
  _sectionLineBS,
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
export function runDrawing(N, ag21, params, S, topology, extraInfo = {}) {
  const {
    L, W, d_spacing = 1.0, e_wall = 0.8, w_pump, d_pump, N_total, h_room,
    hasCatalogDims, DN_branch = 150, DN_main = 300,
    c_wall_m = 0, L_elbow_m = 0,
  } = ag21
  const { h_pool, h_active, Z_stop: stopLevel, Z_start1: startLevel, Z_start2, Z_alarm_high: alarmLevel, Z_alarm_low, Z_max } = params
  const { Q_single, H_design, P_motor, catalogPump, Z_sump } = extraInfo

  const L_pool = Math.max(L, Math.sqrt(S * 1.5))
  const D_pool = S / L_pool
  // 使用 AG2-1 计算的 h_room，替代旧启发式公式
  const room_H = h_room || Math.max(3.5, d_pump + 2.0)

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

  s += _r(pool_ox, room_y2, L_pool * ps, D_pool * ps, '#f8fbff', '#2980b9', 2)
  const pcx = (pool_ox + pool_x2) / 2, pcy = room_y2 + D_pool * ps / 2
  s += _t(pcx, pcy - 8, '集 水 池', 13, '#2980b9', 'middle', 'bold')
  s += _t(pcx, pcy + 8, `S=${fmt(S, 1)}m²  h=${fmt(h_pool, 1)}m`, 10, '#2980b9')
  s += _t(pcx, pcy + 21, '水位见右侧剖面图', 9, '#888')
  s += _l(room_ox, room_y2, room_x2, room_y2, '#2980b9', 1.5, '4,3')

  s += _r(room_ox, room_oy, L * ps, W * ps, '#f8fbff', '#2980b9', 2.5)

  // 总管（DN_main，2.5px 粗线）
  s += _l(room_ox + e_wall * ps, hdr_y, room_x2 - e_wall * ps, hdr_y, '#2980b9', 2.5)
  s += _t(room_ox + e_wall * ps + 3, hdr_y - 6, 'DN' + ag21.DN_label + ' 出水总管', 10, '#2980b9', 'start')

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

  // ── 潜污泵（集水坑内，靠维护间一侧/集水坑墙）───────────────
  const pumpsInOrder = null
  const pumpXPositions = []  // 记录每台泵的 X 坐标（用于竖向管道）

  // Bug B 修复：泵位置应靠集水坑墙（room_y2 侧）
  const firstX = room_ox + e_wall * ps + w_pump * ps / 2

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
    const pumpFill   = '#2471a3'  // 泵统一颜色
    const pumpStroke = '#1a5276'

    // Bug B 修复：泵位置靠集水坑墙（room_y2 + 偏移）
    const wx = firstX + i * (w_pump + d_spacing) * ps
    const wy = room_y2 + d_pump * ps / 2 + 6  // 靠共享墙
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
    s += _l(floorHoleX, wy + ph / 2, floorHoleX, floorHoleY, '#2980b9', 1.5)

    // ── 分支管路（Y 方向梳齿状竖支管）────────────────────────────
    // 每台泵一条独立竖支管：楼板穿孔 → 90°弯头 → 水平管 → CV → 直管 → GV → T接总管
    // Y 方向延伸（从 floorHoleY 向 hdr_y 方向，即负 Y 方向）
    const cv_cy = room_y2 - (L_elb_px + L_str_px + L_cv_px / 2)  // 止回阀中心 Y
    const gv_cy = room_y2 - (L_elb_px + L_str_px + L_cv_px + L_str_px + L_gv_px / 2)  // 闸阀中心 Y
    const horizEndY = room_y2 - (L_elb_px + L_str_px + L_cv_px + L_str_px + L_gv_px)  // 水平管末端 Y

    // 弯头（90°）：从竖向转为水平
    const elbow_r = L_elb_px * 0.5
    s += _elbow(floorHoleX + elbow_r, floorHoleY, elbow_r, 'top', 'right', '#2980b9', 1.5)

    // 水平支管段（从弯头到 T 接总管，Y 方向）
    s += _l(floorHoleX, horizEndY, floorHoleX, cv_cy, '#2980b9', 1.5)
    s += _l(floorHoleX, cv_cy, floorHoleX, gv_cy, '#2980b9', 1.5)
    s += _l(floorHoleX, gv_cy, floorHoleX, hdr_y, '#2980b9', 1.5)

    // DN 标注（垂直引线）
    const dnMidY = (horizEndY + hdr_y) / 2
    s += _leader(floorHoleX + 8, dnMidY, floorHoleX + 28, dnMidY, `DN${DN_branch}`, 9, '#555')

    // 止回阀（竖向 horiz=false）
    s += `<g class="valve-group" data-type="止回阀" data-dn="${DN_branch}" data-ff="${lookupFF(CHECK_VALVE_FF, DN_branch)}" data-std="GB/T 12221">`
    s += _checkValve(floorHoleX, cv_cy, L_cv_px / 2, false, '#c0392b')
    s += '</g>'

    // 闸阀（竖向 horiz=false）
    s += `<g class="valve-group" data-type="闸阀" data-dn="${DN_branch}" data-ff="${lookupFF(GATE_VALVE_FF, DN_branch)}" data-std="GB/T 12221">`
    s += _gateValve(floorHoleX, gv_cy, L_gv_px / 2, false, '#c0392b')
    s += '</g>'
  }

  // ── BS EN ISO 128 剖面切割线（沿L方向切割，显示侧面）─────────
  // 切割线沿L方向（垂直于泵排列方向），可拖动调整位置
  const aaDragX = room_ox + L * ps / 2  // 初始在维护间X方向中间
  // 包在 section-block 组内，透明 rect 作为点击区域
  s += `<g id="section-block" class="section-block">`
  // 透明点击区（覆盖维护间水平范围，上方+下方延伸部分）
  s += _r(room_ox - 20, 0, room_x2 - room_ox + 40, room_oy - 4, 'transparent', 'none')
  s += _r(room_ox - 20, room_y2 + 4, room_x2 - room_ox + 40, PH - room_y2 - 4, 'transparent', 'none')
  // 切割线本身（垂直线，沿L方向）
  s += _sectionLineBS(aaDragX, room_oy - 6, 4, 'A', '#555')
  s += _sectionLineBS(aaDragX, room_y2 + 6, PW - 4, 'A', '#555')
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

  // ── 图例（左上角，简化颜色）────────────────────────
  // 颜色方案：泵 #2471a3，管道 #2980b9，阀门 #c0392b
  const legItems = [
    ['#2471a3', '水泵'],
    ['#2980b9', '管道'],
    ['#c0392b', '阀门'],
    ['#f8fbff', '集水池'],
  ]
  const legX = 10, legY = PMT
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
  // 池深16m在可见范围内；room在±0.00上方，窄长条；两者分开定比例尺
  // 为room预留空间：room_H*ss_room ≈ room_H * ((SMT-10)/room_H) = SMT-10 ≈ 45px
  const ss_pool = (savh - (SMT - 10) - 30) / h_pool   // 减去room高度和边距（pool_bot_y调整后）
  const ss_room = (SMT - 10) / room_H        // room只占顶部一小段

  const sec_cx = SX0 + SML + savw / 2

  // 剖面图沿L方向（泵排列方向）切割，显示维护间侧面
  // 剖面图宽度用 L（维护间长度）
  const sec_wx = L * ss_pool
  // 维护间宽度（显示W方向厚度，即通道方向）
  const room_wx = W * ss_room
  // 集水坑宽度（与平面图 D_pool 成比例）
  const sump_wx = room_wx / 2  // 集水坑宽度 = 维护间宽的一半

  const sec_x1 = sec_cx - sec_wx / 2, sec_x2 = sec_cx + sec_wx / 2
  const sump_x1 = sec_cx - sump_wx / 2, sump_x2 = sec_cx + sump_wx / 2

  // Y 坐标层次（从上到下）：
  // 1. 维护间（room）：Z_top 以上，room_top_y ~ room_bot_y
  // 2. 水池（pool）：Z_bottom ~ Z_top，pool_top_y ~ pool_bot_y
  // 3. 集水坑（sump）：Z_sump ~ Z_bottom，pool_bot_y ~ sump_bot_y
  const Z_bottom = stopLevel   // 0.0 mPD（池底）
  const Z_top    = Z_bottom + h_pool  // 池顶标高 = Z_bottom + h_pool
  const Z_sumpVal = (Z_sump != null && !isNaN(Z_sump)) ? Z_sump : Z_bottom

  // 以池顶标高 Z_top 作为绘制参考点（维护间的底）
  const pool_top_y = SMT + 10                        // 池顶（维护间底）
  const pool_bot_y = pool_top_y + h_pool * ss_pool   // 池底，向下画
  const sump_bot_y = pool_bot_y + (Z_bottom - Z_sumpVal) * ss_pool  // 集水坑底

  // 维护间底 = 池顶标高，向上画维护间
  const room_bot_y = pool_top_y
  const room_top_y = room_bot_y - room_H * ss_room  // 维护间顶

  // 水位 Y（相对于 pool_bot_y=0.0mPD）
  // 注意：水位是 mPD 值，>0 表示在 pool_bot_y 上方（Y更小），<0 表示下方（Y更大）

  // 剖面图管道尺寸（使用 ss_pool 比例尺）
  const L_cv_px_ss  = lookupFF(CHECK_VALVE_FF, DN_branch) / 1000 * ss_pool
  const L_gv_px_ss  = lookupFF(GATE_VALVE_FF, DN_branch) / 1000 * ss_pool
  const L_str_px_ss = Math.max(2 * DN_branch, 300) / 1000 * ss_pool

  // Bug C 修复：水位 Y 坐标使用相对深度 (Z - Z_bottom) * ss_pool
  // Z_bottom = Z_stop（池底设计水位），stopLevel/startLevel/alarmLevel 是绝对 mPD 值
  const stop_y       = pool_bot_y - (stopLevel - Z_bottom) * ss_pool
  const start_y      = pool_bot_y - (startLevel - Z_bottom) * ss_pool
  const start2_y     = pool_bot_y - ((Z_start2 != null ? Z_start2 : alarmLevel) - Z_bottom) * ss_pool
  const alarm_y      = pool_bot_y - (alarmLevel - Z_bottom) * ss_pool
  const max_y        = pool_bot_y - ((Z_max != null ? Z_max : alarmLevel) - Z_bottom) * ss_pool
  const alarm_low_y  = pool_bot_y - ((Z_alarm_low != null ? Z_alarm_low : Z_bottom) - Z_bottom) * ss_pool

  // section panel 组（可拖动）
  const sectionPanelId = 'section-panel'
  s += `<g id="${sectionPanelId}">`

  s += _t(SX0 + SW / 2, SMT - 14, 'A-A 剖 面 图（沿 泵 轴）', 13, '#1a5276', 'middle', 'bold')

  // ── 维护间（维护间底 = 池顶标高，泵从维护间穿楼板进入水池）─────────
  const room_x1 = sec_cx - room_wx / 2
  s += _r(room_x1, room_top_y, room_wx, room_H * ss_room, '#f8fbff', '#2980b9', 2.5)

  // ── 水池（从池顶到池底）────────────────────────────────────────────
  // 左右边线从池顶到池底
  s += _l(sec_x1, pool_top_y, sec_x1, pool_bot_y, '#2980b9', 2)
  s += _l(sec_x2, pool_top_y, sec_x2, pool_bot_y, '#2980b9', 2)
  // 池底线
  s += _l(sec_x1, pool_bot_y, sec_x2, pool_bot_y, '#2980b9', 2)
  // 池顶线（结构边界）
  s += _l(sec_x1, pool_top_y, sec_x2, pool_top_y, '#2980b9', 1)

  // ── 水池水深填充（从最高水位到池底）────────────────────────────────
  // 水面从 Z_max (1.2 mPD) 向下填充到池底 Z_bottom (-13 mPD)，深度 = h_active (14.2 m)
  // 池顶 Z_top (3 mPD) 到最高水位 Z_max (1.2 mPD) 之间是无水空间
  const water_fill_top = max_y  // 直接用最高水位作为水面（不用Math.min）
  if (water_fill_top < pool_bot_y) {
    s += _r(sec_x1, water_fill_top, sec_wx, pool_bot_y - water_fill_top, '#d6eaf8', 'none')
  }
  // 各水位之间分层（注意：Y值越小表示越高）
  if (alarm_y < max_y) s += _r(sec_x1, alarm_y, sec_wx, max_y - alarm_y, '#aed6f1', 'none')
  if (alarm_low_y < alarm_y) s += _r(sec_x1, alarm_low_y, sec_wx, alarm_y - alarm_low_y, '#85c1e9', 'none')

  // ── 集水坑示意块（窄，宽=维护间一半，底部=Z_sump）─────────────────
  // 集水坑只是池底的一个凹槽，只画底部区域
  if (Z_sump != null && !isNaN(Z_sump) && Z_sump < Z_bottom) {
    const sump_cy = (pool_bot_y + sump_bot_y) / 2
    // 集水坑底部三边（不延伸到池顶）
    s += _l(sump_x1, sump_bot_y, sump_x2, sump_bot_y, '#2980b9', 1.5)
    s += _l(sump_x1, sump_bot_y, sump_x1, pool_bot_y, '#2980b9', 1.5)
    s += _l(sump_x2, sump_bot_y, sump_x2, pool_bot_y, '#2980b9', 1.5)
    s += _t(sec_cx, sump_cy, '集水坑', 10, '#2980b9', 'middle', 'bold')
  }

  // ── 池底标高线（Z_bottom = 0.0 mPD）──────────────────────────────────
  s += _l(SX0 + 4, pool_bot_y, SX0 + SW - 4, pool_bot_y, '#2980b9', 2)
  s += _t(sec_x1 - 5, pool_bot_y + 4, `池底 ${fmt(Z_bottom, 2)}m`, 9, '#555', 'end')

  // ── 池顶标高线（Z_top）────────────────────────────────────────────
  s += _l(SX0 + 4, pool_top_y, SX0 + SW - 4, pool_top_y, '#2980b9', 2)
  s += _t(sec_x1 - 5, pool_top_y + 4, `池顶 ${fmt(Z_top, 2)}m`, 9, '#2980b9', 'end')

  const elev_stop     = stopLevel
  const elev_start    = startLevel
  const elev_start2   = Z_start2 != null ? Z_start2 : alarmLevel
  const elev_alarm    = alarmLevel
  const elev_alarm_lo = Z_alarm_low != null ? Z_alarm_low : Z_bottom
  const elev_max      = Z_max != null ? Z_max : alarmLevel
  const elev_bot      = Z_bottom
  const elev_sump     = Z_sumpVal

  // 水位线短横线（从池边往里一条短线，标签在池外）
  const wl_line_len = Math.min(25, sec_wx * 0.1)
  const wl_lx_left  = sec_x1 - 8   // 左侧标签在池外（anchor='end'）
  const wl_lx_right = sec_x2 + 8   // 右侧标签在池外（anchor='start'）

  // 左侧：低水位报警、高水位报警、最高水位（均为红色）
  // 线从左池边往里
  s += _l(sec_x1, alarm_low_y, sec_x1 + wl_line_len, alarm_low_y, '#c0392b', 1.5, '5,3')
  s += _t(wl_lx_left, alarm_low_y + 4, '低水位报警 ' + fmt(elev_alarm_lo, 2) + 'm', 10, '#c0392b', 'end')

  s += _l(sec_x1, alarm_y, sec_x1 + wl_line_len, alarm_y, '#c0392b', 1.5, '5,3')
  s += _t(wl_lx_left, alarm_y + 4, '高水位报警 ' + fmt(elev_alarm, 2) + 'm', 10, '#c0392b', 'end')

  s += _l(sec_x1, max_y, sec_x1 + wl_line_len, max_y, '#c0392b', 1.5, '5,3')
  s += _t(wl_lx_left, max_y + 4, '最高水位 ' + fmt(elev_max, 2) + 'm', 10, '#c0392b', 'end')

  // 右侧：1#泵启动、2#泵启动（绿色）、停泵（红色）
  // 线从右池边往里
  s += _l(sec_x2 - wl_line_len, start_y, sec_x2, start_y, '#27ae60', 1.5, '5,3')
  s += _t(wl_lx_right, start_y + 4, '1#泵启动 ' + fmt(elev_start, 2) + 'm', 10, '#27ae60', 'start')

  s += _l(sec_x2 - wl_line_len, start2_y, sec_x2, start2_y, '#27ae60', 1.5, '5,3')
  s += _t(wl_lx_right, start2_y + 4, '2#泵启动 ' + fmt(elev_start2, 2) + 'm', 10, '#27ae60', 'start')

  s += _l(sec_x2 - wl_line_len, stop_y, sec_x2, stop_y, '#c0392b', 1.5, '5,3')
  s += _t(wl_lx_right, stop_y + 4, '停泵 ' + fmt(elev_stop, 2) + 'm', 10, '#c0392b', 'start')

  // 池底标注
  s += _t(wl_lx_right, pool_bot_y + 4, '池底 ' + fmt(elev_bot, 2) + 'm', 10, '#555', 'start')
  // 集水坑底标注（仅当与池底不同时）
  if (elev_sump < elev_bot - 0.01) {
    s += _t(wl_lx_right, sump_bot_y + 4, '坑底 ' + fmt(elev_sump, 2) + 'm', 10, '#5d6d7e', 'start')
  }

  // ── 剖面管道圆截面（根据 aaDragX 位置在三段中切换）────────────────
  // aaDragX 是切割线 X 坐标（px），沿L方向切割
  // L 方向分为三段：0~25%（靠左侧墙）、25%~75%（中间）、75%~100%（靠右侧墙）
  const relX = (aaDragX - room_ox) / (room_x2 - room_ox)  // 0=room_ox, 1=room_x2
  const relW = relX  // 切割线在 L 方向的相对位置（0=左侧，1=右侧）

  // DN → 圆形截面半径（m → px）
  const dn2r = (dn) => (dn / 1000) * ss_pool
  const r_branch = dn2r(DN_branch)
  const r_main    = dn2r(DN_main)

  s += `<g id="section-pipe-xsection">`
  // 管道截面显示在池顶标高（维护间底 = 穿楼板位置）
  const xsection_y = pool_top_y
  // 基于真实物理尺寸计算阀门和设备尺寸（mm → px）
  const valve_cv_half = lookupFF(CHECK_VALVE_FF, DN_branch) / 1000 * ss_room / 2
  const valve_gv_half = lookupFF(GATE_VALVE_FF, DN_branch) / 1000 * ss_room / 2
  const fm_half = Math.max(300, 4 * DN_main) / 1000 * ss_room / 2

  if (relW <= 0.25) {
    // 靠集水坑墙：泵出口竖管截面 + 弯头
    s += `<ellipse cx="${sec_cx.toFixed(1)}" cy="${xsection_y.toFixed(1)}" rx="${r_branch.toFixed(1)}" ry="${(r_branch * 0.3).toFixed(1)}" fill="none" stroke="#2980b9" stroke-width="2"/>`
    s += _t(sec_cx, xsection_y - r_branch - 8, `DN${DN_branch}`, 9, '#2980b9', 'middle')
  } else if (relW <= 0.75) {
    // 中间管道区：支路管道圆形截面 + 止回阀/闸阀（基于真实尺寸）
    s += `<circle cx="${sec_cx.toFixed(1)}" cy="${xsection_y.toFixed(1)}" r="${r_branch.toFixed(1)}" fill="none" stroke="#2980b9" stroke-width="2"/>`
    s += _t(sec_cx, xsection_y - r_branch - 8, `DN${DN_branch}`, 9, '#2980b9', 'middle')
    s += _checkValve(sec_cx - sec_wx * 0.12, xsection_y, valve_cv_half, true, '#c0392b')
    s += _gateValve(sec_cx + sec_wx * 0.12, xsection_y, valve_gv_half, true, '#c0392b')
  } else {
    // 靠远侧墙：总管圆形截面 + 流量计（基于真实尺寸）
    s += `<circle cx="${sec_cx.toFixed(1)}" cy="${xsection_y.toFixed(1)}" r="${r_main.toFixed(1)}" fill="none" stroke="#2980b9" stroke-width="2"/>`
    s += _t(sec_cx, xsection_y - r_main - 8, `DN${DN_main}`, 9, '#2980b9', 'middle')
    s += _flowmeter(sec_cx, xsection_y, fm_half, r_main, true, '#c0392b')
    const upLabel = `上游${5}D`, dnLabel = `下游${2}D`
    s += _leader(sec_cx - fm_half - 15, xsection_y - r_main - 8, sec_cx - fm_half - 50, xsection_y - r_main - 18, upLabel, 9, '#c0392b')
    s += _leader(sec_cx + fm_half + 15, xsection_y + r_main + 8, sec_cx + fm_half + 50, xsection_y + r_main + 18, dnLabel, 9, '#c0392b')
  }
  s += `</g>`

  // Bug D 修复：泵在集水坑内，管道和阀门在维护间内
  // 泵：放在集水坑里（靠近池底）
  const pump_w = Math.min(sump_wx * 0.4, 25), pump_h = Math.min(sump_wx * 0.3, 18)
  const pump_x = sec_cx - pump_w / 2
  const pump_y = sump_bot_y - pump_h - 3  // 泵底在集水坑底部上方
  s += _r(pump_x, pump_y, pump_w, pump_h, '#2471a3', '#1a5276', 1.5)
  // 泵体两段：底座（深色）+ 电机罩（浅色）
  s += _r(pump_x, pump_y + pump_h * 0.6, pump_w, pump_h * 0.4, '#1a5276', 'none', 0)
  s += _t(pump_x + pump_w / 2, pump_y + pump_h / 2 + 3, 'P', 9, '#fff', 'middle', 'bold')

  // 竖向管道（从泵顶向上穿楼板到维护间）
  const riser_x = pump_x + pump_w / 2
  const riser_top_y = pool_top_y - 5  // 竖管顶端在池顶标高以上一点点
  s += _l(riser_x, pump_y, riser_x, riser_top_y, '#2980b9', 1.5)

  // 楼板穿孔标记（圆形虚线标记，在池顶标高）
  s += `<circle cx="${riser_x.toFixed(1)}" cy="${pool_top_y.toFixed(1)}" r="5" fill="none" stroke="#2980b9" stroke-width="1.5" stroke-dasharray="3,2"/>`

  // 管道和阀门尺寸（基于AG2-1计算的真实物理尺寸，单位m → px）
  const pipe_w = DN_branch / 1000 * ss_room  // 管道直径 = DN(mm)转米 * 比例尺
  // 阀门实际长度（m → px）
  const valve_cv_len = lookupFF(CHECK_VALVE_FF, DN_branch) / 1000 * ss_room
  const valve_gv_len = lookupFF(GATE_VALVE_FF, DN_branch) / 1000 * ss_room
  // 弯头中心到端面 = 1.5×DN（m → px）
  const elbow_ctf = elbowCTF(DN_branch) / 1000 * ss_room
  const elbow_r = elbow_ctf / 2  // 弯头半径（半长）
  // 阀件间直管段（m → px）
  const minStraight_px = Math.max(2 * DN_branch, 300) / 1000 * ss_room

  // 90°弯头（在维护间内，池顶标高以上）
  const elbow_y = pool_top_y - elbow_r  // 弯头在池顶以上
  s += _elbow(riser_x, elbow_y, elbow_r, 'top', 'right', '#2980b9', pipe_w)

  // 水平管段（在维护间内，池顶以上）
  const horiz_y = elbow_y - elbow_r  // 水平管Y坐标
  // 止回阀中心位置
  const cv_center_x = riser_x + elbow_ctf + minStraight_px + valve_cv_len / 2
  // 闸阀中心位置
  const gv_center_x = cv_center_x + valve_cv_len / 2 + minStraight_px + valve_gv_len / 2
  // T节点位置
  const header_x = gv_center_x + valve_gv_len / 2 + minStraight_px + DN_main / 1000 * ss_room

  s += _l(riser_x + elbow_ctf, horiz_y, cv_center_x - valve_cv_len / 2, horiz_y, '#2980b9', pipe_w)

  // 止回阀 CV（水平，在维护间内）
  s += `<g class="valve-group" data-type="止回阀" data-dn="${DN_branch}" data-ff="${lookupFF(CHECK_VALVE_FF, DN_branch)}" data-std="GB/T 12221">`
  s += _checkValve(cv_center_x, horiz_y, valve_cv_len / 2, true, '#c0392b')
  s += '</g>'

  // 闸阀 GV（水平，在维护间内）
  s += `<g class="valve-group" data-type="闸阀" data-dn="${DN_branch}" data-ff="${lookupFF(GATE_VALVE_FF, DN_branch)}" data-std="GB/T 12221">`
  s += _gateValve(gv_center_x, horiz_y, valve_gv_len / 2, true, '#c0392b')
  s += '</g>'

  // 水平管段继续到 T 节点
  s += _l(cv_center_x + valve_cv_len / 2, horiz_y, gv_center_x - valve_gv_len / 2, horiz_y, '#2980b9', pipe_w)

  // T 节点（总管连接）- 节点大小基于DN
  const tee_r = DN_main / 1000 * ss_room * 0.8
  s += _tee(header_x, horiz_y, tee_r, '#2980b9', '#2980b9', 1.5)

  // 总管（右侧）- 基于DN_main，画到边界
  s += _l(header_x + tee_r, horiz_y, sec_x2, horiz_y, '#2980b9', DN_main / 1000 * ss_room)

  const sec_dvx = sec_x1 - 32
  s += _dv(sec_dvx, room_top_y, room_bot_y, '室高 ' + fmt(room_H, 1) + 'm', '#2980b9')
  s += _dv(sec_dvx, pool_top_y, pool_bot_y, 'h_pool=' + fmt(h_pool, 1) + 'm', '#2980b9')
  if (sump_bot_y > pool_bot_y + 2) {
    s += _dv(sec_dvx, pool_bot_y, sump_bot_y, '坑深', '#2980b9')
  }
  s += _dh(sec_x1, sec_x2, sump_bot_y + 20, 'W=' + fmt(W, 1) + 'm', '#2980b9')

  s += `</g>`  // end section-panel

  const el = document.getElementById('svg-ag31')
  el.setAttribute('viewBox', `0 0 ${VW} ${VH}`)
  el.innerHTML = s

  // ── 剖面符号块交互（独立于画布 zoom/pan）──────────────────────────
  let aaCurrentX = aaDragX  // 沿L方向拖动
  let sectionSelected = false   // 选中状态
  let sectionDragging = false   // 拖动状态
  let lastSectionX = 0

  function constrainAAX(x) {
    return Math.max(room_ox + 10, Math.min(room_x2 - 10, x))
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
      lastSectionX = e.clientX
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
    const dx = e.clientX - lastSectionX
    lastSectionX = e.clientX
    aaCurrentX = constrainAAX(aaCurrentX + dx)
    redrawSectionLines(aaCurrentX)
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
  function redrawSectionLines(x) {
    const color = sectionSelected ? '#e74c3c' : '#555'
    let html = ''
    // 透明点击区（覆盖维护间水平范围）
    html += _r(room_ox - 20, 0, room_x2 - room_ox + 40, room_oy - 4, 'transparent', 'none')
    html += _r(room_ox - 20, room_y2 + 4, room_x2 - room_ox + 40, PH - room_y2 - 4, 'transparent', 'none')
    // 切割线（垂直线，沿L方向）
    html += _sectionLineBS(x, room_oy - 6, 4, 'A', color)
    html += _sectionLineBS(x, room_y2 + 6, PW - 4, 'A', color)
    const block = el.querySelector('#section-block')
    if (block) block.innerHTML = html
    // 同步更新剖面截面
    redrawSectionPanel(x)
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
    aaCurrentX = aaDragX
    secDx = 0; secDy = 0
    secPanel?.setAttribute('transform', '')
  }

  // ── 初始化 zoom/pan（带最小缩放限制）────────────────────────────────
  initSvgZoomPan(el, VW, VH,
    { zIn: 'btn-ag31-zin', zOut: 'btn-ag31-zout', zRst: 'btn-ag31-rst' },
    { minScale: 1.0, maxScale: 6, onReset: onResetCb })

  // ── 辅助：重绘剖面截面（根据切割线 X 位置，沿L方向）────────────────
  function redrawSectionPanel(aaX) {
    // 切割线在L方向的位置
    const relX = (aaX - room_ox) / (room_x2 - room_ox)
    const dn2r = (dn) => (dn / 1000) * ss_pool
    const r_branch = dn2r(DN_branch)
    const r_main   = dn2r(DN_main)
    // 管道截面在池顶标高（维护间底 = 穿楼板位置）
    const xsection_y = pool_top_y

    // 基于真实物理尺寸计算阀门和设备尺寸（mm → px）
    const valve_cv_half = lookupFF(CHECK_VALVE_FF, DN_branch) / 1000 * ss_room / 2
    const valve_gv_half = lookupFF(GATE_VALVE_FF, DN_branch) / 1000 * ss_room / 2
    const fm_half = flowmeterBodyL(DN_main) / 1000 * ss_room / 2

    let html = ''
    if (relX <= 0.25) {
      // 左侧区域：泵出口竖管截面
      html += `<ellipse cx="${sec_cx.toFixed(1)}" cy="${xsection_y.toFixed(1)}" rx="${r_branch.toFixed(1)}" ry="${(r_branch * 0.3).toFixed(1)}" fill="none" stroke="#2980b9" stroke-width="2"/>`
      html += `<text x="${sec_cx}" y="${(xsection_y - r_branch - 8).toFixed(1)}" text-anchor="middle" font-size="9" fill="#2980b9">DN${DN_branch}</text>`
    } else if (relX <= 0.75) {
      // 中间区域：支路管道圆形截面 + 止回阀/闸阀
      html += `<circle cx="${sec_cx.toFixed(1)}" cy="${xsection_y.toFixed(1)}" r="${r_branch.toFixed(1)}" fill="none" stroke="#2980b9" stroke-width="2"/>`
      html += `<text x="${sec_cx}" y="${(xsection_y - r_branch - 8).toFixed(1)}" text-anchor="middle" font-size="9" fill="#2980b9">DN${DN_branch}</text>`
      // 止回阀/闸阀符号（基于真实尺寸）
      html += _checkValve(sec_cx - sec_wx * 0.12, xsection_y, valve_cv_half, true, '#c0392b')
      html += _gateValve(sec_cx + sec_wx * 0.12, xsection_y, valve_gv_half, true, '#c0392b')
    } else {
      // 右侧区域：总管圆形截面 + 流量计
      html += `<circle cx="${sec_cx.toFixed(1)}" cy="${xsection_y.toFixed(1)}" r="${r_main.toFixed(1)}" fill="none" stroke="#2980b9" stroke-width="2"/>`
      html += `<text x="${sec_cx}" y="${(xsection_y - r_main - 8).toFixed(1)}" text-anchor="middle" font-size="9" fill="#2980b9">DN${DN_main}</text>`
      // 流量计（基于真实尺寸）
      html += _flowmeter(sec_cx, xsection_y, fm_half, r_main, true, '#c0392b')
    }

    const xsection = el.querySelector('#section-pipe-xsection')
    if (xsection) xsection.innerHTML = html
  }
}