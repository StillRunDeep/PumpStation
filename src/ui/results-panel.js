import { fmt, stepsTable, kvRow } from '../utils.js'

export function renderAG01(r) {
  if (!r) return '<p style="color:#999;padding:8px">未找到拓扑数据。</p>'

  const status = r.valid ? (r.warnings.length > 0 ? 'warn' : 'pass') : 'error'
  const icon   = status === 'pass' ? '✔' : status === 'warn' ? '⚠' : '✘'
  const label  = status === 'pass' ? '拓扑有效' : status === 'warn' ? '有效（有警告）' : '拓扑有误'

  let msgs = ''
  r.errors.forEach(e   => { msgs += `<li><span class="icon err">✘</span> <span class="err">${e}</span></li>` })
  r.warnings.forEach(w => { msgs += `<li><span class="icon wrn">⚠</span> <span class="wrn">${w}</span></li>` })
  if (r.errors.length === 0 && r.warnings.length === 0)
    msgs = '<li><span class="icon ok">✔</span> <span class="ok">拓扑连通，所有设备已接入</span></li>'

  // 设备统计
  const { N_working, N_spare, N_checkValve, N_gateValve } = r.stats || {}
  const statsRows = `
    ${kvRow('工作泵', N_working + ' 台')}
    ${kvRow('备用泵', N_spare + ' 台')}
    ${kvRow('止回阀', N_checkValve + ' 个')}
    ${kvRow('电动闸阀', N_gateValve + ' 个')}
  `

  // 房间归属
  let roomRows = ''
  for (const [roomId, info] of Object.entries(r.byRoom || {})) {
    const count = info.devices.length
    roomRows += kvRow(info.label, count + ' 台设备')
  }

  return `
    <div style="margin-bottom:12px">
      <span style="font-weight:700;color:var(--color-${status})">${icon} ${label}</span>
    </div>
    <ul class="msg-list">${msgs}</ul>
    <div class="result-summary ${status}" style="margin-top:12px">
      <div style="font-weight:600;margin-bottom:6px;font-size:12px;color:#666">设备统计</div>
      ${statsRows}
      <div style="font-weight:600;margin:10px 0 6px;font-size:12px;color:#666">房间归属</div>
      ${roomRows}
    </div>
  `
}

export function renderAG00(r) {
  const status = r.valid ? (r.warnings.length > 0 ? 'warn' : 'pass') : 'error'
  const icon   = status === 'pass' ? '✔' : status === 'warn' ? '⚠' : '✘'
  const label  = status === 'pass' ? '验证通过' : status === 'warn' ? '通过（有警告）' : '验证失败'

  let msgs = ''
  r.errors.forEach(e   => { msgs += `<li><span class="icon err">✘</span> <span class="err">${e}</span></li>` })
  r.warnings.forEach(w => { msgs += `<li><span class="icon wrn">⚠</span> <span class="wrn">${w}</span></li>` })
  if (r.errors.length === 0 && r.warnings.length === 0)
    msgs = '<li><span class="icon ok">✔</span> <span class="ok">所有参数合法，可继续计算</span></li>'

  return `
    <div style="margin-bottom:12px">
      <span style="font-weight:700;color:var(--color-${status})">${icon} ${label}</span>
    </div>
    <ul class="msg-list">${msgs}</ul>
    ${r.valid ? `<details style="margin-bottom:14px"><summary style="cursor:pointer;color:#555;font-size:12px;margin-bottom:6px">计算过程（点击展开）</summary>${stepsTable(r.rows)}</details>` : ''}
  `
}

// AG1-1：污水池计算 → 渲染 V_required, Z_stop, startLevels 等
export function renderPoolDepth(r) {
  const hasErrors = r.errors && r.errors.length > 0
  const hasWarnings = r.warnings && r.warnings.length > 0
  const status = hasErrors ? 'error' : hasWarnings ? 'warn' : 'pass'
  const icon = status === 'pass' ? '✔' : status === 'warn' ? '⚠' : '✘'
  const label = status === 'pass' ? '计算完成' : status === 'warn' ? '完成（有警告）' : '计算失败'

  let msgs = ''
  if (hasErrors) {
    r.errors.forEach(e => { msgs += `<li><span class="icon err">✘</span> <span class="err">${e}</span></li>` })
  }
  if (hasWarnings) {
    r.warnings.forEach(w => { msgs += `<li><span class="icon wrn">⚠</span> <span class="wrn">${w}</span></li>` })
  }

  const lvlRows = (r.startLevels || []).map((lv) =>
    `<tr><td>水泵 ${lv.pump}</td><td>${fmt(lv.level, 2)} mPD</td></tr>`
  ).join('')

  const staggerTable = `
    <p style="font-size:12px;font-weight:600;color:#555;margin:10px 0 4px">梯级启泵水位（R-CL-01）</p>
    <table class="steps-table">
      <thead><tr><th>水泵</th><th>启泵水位</th></tr></thead>
      <tbody>
        ${lvlRows}
        <tr><td>统一停泵水位</td><td>${fmt(r.Z_stop, 2)} mPD</td></tr>
        <tr><td>高水位报警</td><td>${fmt(r.Z_alarm_high, 2)} mPD</td></tr>
      </tbody>
    </table>
  `

  return `
    <div style="margin-bottom:12px">
      <span style="font-weight:700;color:var(--color-${status})">${icon} ${label}</span>
    </div>
    ${msgs ? `<ul class="msg-list">${msgs}</ul>` : ''}
    ${r.valid !== false ? `<details style="margin-bottom:14px"><summary style="cursor:pointer;color:#555;font-size:12px;margin-bottom:6px">计算过程（点击展开）</summary>${stepsTable(r.rows)}</details>` : ''}
    ${r.valid !== false ? `
    <div class="result-summary pass">
      ${kvRow('最小调节容积 V_min', fmt(r.V_min, 1) + ' m³')}
      ${kvRow('有效调蓄容积 V_effective', fmt(r.V_effective, 1) + ' m³')}
      ${kvRow('推算面积 S', fmt(r.S, 1) + ' m²')}
      ${kvRow('总池深 D', fmt(r.D, 1) + ' m')}
      ${kvRow('最高水位 Z_max', fmt(r.Z_max, 2) + ' mPD')}
    </div>
    ${staggerTable}
    ` : ''}
  `
}

// AG2-1：泵房维护间尺寸计算 → 渲染 d_spacing, e_wall, L, W
export function renderMaintenanceRoom(r) {
  return `
    <details style="margin-bottom:14px"><summary style="cursor:pointer;color:#555;font-size:12px;margin-bottom:6px">计算过程（点击展开）</summary>${stepsTable(r.rows)}</details>
    <div class="result-summary pass">
      ${kvRow('泵间净距', fmt(r.d_spacing, 1) + ' m')}
      ${kvRow('端部距墙净距', fmt(r.e_wall, 1) + ' m')}
      ${kvRow('维护间净长 L', fmt(r.L, 1) + ' m')}
      ${kvRow('维护间净宽 W', fmt(r.W, 1) + ' m')}
    </div>
  `
}

// 泵型目录选型结果区块
function renderCatalogMatch(r) {
  const matches = r.catalogMatches?.length > 0 ? r.catalogMatches : r.catalogMatchesTolerant
  const isTolerant = r.catalogIsTolerant

  if (!matches || matches.length === 0) {
    return `
    <div class="result-summary error" style="margin-top:8px">
      <div style="font-weight:700;margin-bottom:6px">✘ 目录中无匹配泵型</div>
      ${kvRow('设计流量 Q', fmt(r.Q_pump_ls, 1) + ' l/s (' + fmt(r.Q_pump_ls * 3.6, 0) + ' m³/h)')}
      ${kvRow('所需扬程 H', fmt(r.H_total, 2) + ' m')}
      <div style="font-size:11px;color:#999;margin-top:4px">请联系厂商确认或调整设计参数</div>
    </div>`
  }

  const m = matches[0]
  const p = m.pump
  const cls = isTolerant ? 'warn' : 'pass'
  const icon = isTolerant ? '⚠' : '✔'
  const title = isTolerant ? '选型结果（扬程偏差在 ISO 9906 2B ±3% 范围内）' : '选型结果'

  const dm = p.dimensions_mm
  const h_total = (dm.h1 || 0) + (dm.h2 || 0)

  return `
    <div class="result-summary ${cls}" style="margin-top:8px">
      <div style="font-weight:700;margin-bottom:8px">${icon} ${title}</div>
      <div style="font-weight:600;font-size:11px;color:#666;margin-bottom:4px">设计参数</div>
      ${kvRow('单泵设计流量 Q', fmt(r.Q_pump_ls, 1) + ' l/s (' + fmt(r.Q_pump_ls * 3.6, 0) + ' m³/h)')}
      ${kvRow('系统总扬程 H', fmt(r.H_total, 2) + ' m')}
      <div style="font-weight:600;font-size:11px;color:#666;margin:8px 0 4px">选型实际参数</div>
      ${kvRow('制造商 / 系列', p.manufacturer + ' · ' + p.series)}
      ${kvRow('型号', p.model)}
      ${kvRow('安装尺寸 a×b×h', dm.a + '×' + dm.b + '×' + h_total + ' mm')}
      ${kvRow('曲线扬程 H', fmt(m.H_m, 2) + ' m')}
      ${kvRow('实际效率 η', fmt(m.eta_pct, 1) + ' %')}
      ${kvRow('实际轴功率 P', fmt(m.P_kW, 1) + ' kW')}
      ${m.NPSH_m !== null ? kvRow('NPSH₃%', fmt(m.NPSH_m, 2) + ' m') : ''}
      <div style="font-weight:600;font-size:11px;color:#666;margin:8px 0 4px">电机</div>
      ${kvRow('目录电机功率', p.motor.power_kW + ' kW')}
      ${kvRow('电机型号', p.motor.manufacturer + ' ' + p.motor.modelNo + ' · ' + p.motor.poles + ' 极')}
      ${kvRow('转速', p.motor.speed_rpm + ' rpm')}
    </div>`
}

// AG12：水泵计算及选型 → 渲染 Q_pump, H_total, P_shaft, NPSH 等
export function renderPumpSpec(r) {
  const hasErrors = r.errors && r.errors.length > 0
  const hasWarnings = r.warnings && r.warnings.length > 0
  const status = hasErrors ? 'error' : hasWarnings ? 'warn' : 'pass'
  const icon = status === 'pass' ? '✔' : status === 'warn' ? '⚠' : '✘'
  const label = status === 'pass' ? '计算完成' : status === 'warn' ? '完成（有警告）' : '计算失败'

  let msgs = ''
  if (hasErrors) {
    r.errors.forEach(e => { msgs += `<li><span class="icon err">✘</span> <span class="err">${e}</span></li>` })
  }
  if (hasWarnings) {
    r.warnings.forEach(w => { msgs += `<li><span class="icon wrn">⚠</span> <span class="wrn">${w}</span></li>` })
  }

  const effClass = r.NPSH_ok ? 'pass' : 'fail'
  const effMsg = r.NPSH_ok
    ? `NPSH_a=${fmt(r.NPSH_a)} ≥ NPSH_r+0.5=${fmt(r.NPSH_r+0.5)}，满足 R-NPSH-01`
    : `NPSH_a=${fmt(r.NPSH_a)} < NPSH_r+0.5=${fmt(r.NPSH_r+0.5)}，不满足 R-NPSH-01`

  return `
    <div style="margin-bottom:12px">
      <span style="font-weight:700;color:var(--color-${status})">${icon} ${label}</span>
    </div>
    ${msgs ? `<ul class="msg-list">${msgs}</ul>` : ''}
    ${r.valid !== false ? `<details style="margin-bottom:14px"><summary style="cursor:pointer;color:#555;font-size:12px;margin-bottom:6px">计算过程（点击展开）</summary>${stepsTable(r.rows)}</details>` : ''}
    ${r.valid !== false ? `
    <div class="result-summary pass">
      ${kvRow('单泵设计流量 Q_pump', fmt(r.Q_pump, 4) + ' m³/s')}
      ${kvRow('系统总扬程 H_total', fmt(r.H_total, 2) + ' m')}
      ${kvRow('轴功率 P_shaft', fmt(r.P_shaft, 2) + ' kW')}
      ${kvRow('电机功率 P_motor', fmt(r.P_motor, 2) + ' kW')}
      ${kvRow('进水管 DN_inlet', 'DN ' + r.DN_inlet)}
      ${kvRow('出水管 DN_outlet', 'DN ' + r.DN_outlet)}
    </div>
    <div class="result-summary ${effClass}" style="margin-top:8px;font-size:12px">
      <strong>NPSH校验（R-NPSH-01）：</strong>${effMsg}
    </div>
    ${renderCatalogMatch(r)}
    ` : ''}
  `
}

// AG1-3：管道尺寸计算
export function renderPipeSizing(r) {
  const hasErrors = r.errors && r.errors.length > 0
  const hasWarnings = r.warnings && r.warnings.length > 0
  const status = hasErrors ? 'error' : hasWarnings ? 'warn' : 'pass'
  const icon = status === 'pass' ? '✔' : status === 'warn' ? '⚠' : '✘'
  const label = status === 'pass' ? '计算完成' : status === 'warn' ? '完成（有警告）' : '计算失败'

  let msgs = ''
  if (hasErrors) {
    r.errors.forEach(e => { msgs += `<li><span class="icon err">✘</span> <span class="err">${e}</span></li>` })
  }
  if (hasWarnings) {
    r.warnings.forEach(w => { msgs += `<li><span class="icon wrn">⚠</span> <span class="wrn">${w}</span></li>` })
  }

  return `
    <div style="margin-bottom:12px">
      <span style="font-weight:700;color:var(--color-${status})">${icon} ${label}</span>
    </div>
    ${msgs ? `<ul class="msg-list">${msgs}</ul>` : ''}
    ${r.valid !== false ? `<details style="margin-bottom:14px"><summary style="cursor:pointer;color:#555;font-size:12px;margin-bottom:6px">计算过程（点击展开）</summary>${stepsTable(r.rows)}</details>` : ''}
    ${r.valid !== false ? `
    <div class="result-summary pass">
      ${kvRow('泵进水管公称直径 DN_pumpIn', 'DN ' + r.DN_pumpIn)}
      ${kvRow('泵出水管公称直径 DN_pumpOut', 'DN ' + r.DN_pumpOut)}
      ${kvRow('总出水管公称直径 DN_mainOutlet', 'DN ' + r.DN_mainOutlet)}
      ${kvRow('沿程损失 H_f', fmt(r.H_f, 3) + ' m')}
      ${kvRow('局部损失 H_local', fmt(r.H_local, 3) + ' m')}
      ${kvRow('总水头损失 H_loss', fmt(r.H_loss, 3) + ' m')}
    </div>
    <div class="result-summary ${r.NPSH_ok ? 'pass' : 'fail'}" style="margin-top:8px;font-size:12px">
      <strong>NPSH校验：</strong>${r.NPSH_ok ? '✓ 满足' : '✘ 不满足'}
    </div>
    ` : ''}
  `
}
