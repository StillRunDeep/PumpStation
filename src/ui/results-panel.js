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

// 渲染几何模式计算行（带公式显示）
function renderGeoModeRow(r) {
  // 从 rows 中找到几何模式那一条
  const geoRow = r.rows?.find(row => row.includes('几何模式'))
  if (!geoRow) return ''

  // stepRow 格式：<tr><td>几何模式</td><td class="formula">已知 D，推算 A_base</td><td class="value">D = 16.00 m，A_base = V_design / D = 75000 / 16.00 =&nbsp;<small>m²</small></td></tr>
  // 提取 formula 和 value 部分
  const formulaMatch = geoRow.match(/<td class="formula">([^<]*)<\/td>/)
  const valueMatch = geoRow.match(/<td class="value">([^<]*)<\/td>/)
  const formula = formulaMatch ? formulaMatch[1] : ''
  const valueHtml = valueMatch ? valueMatch[1] : ''

  // 解析 valueHtml 中的数值和单位（格式：数值&nbsp;<small>单位</small>）
  const valMatch = valueHtml.match(/^(.*?)(?:&nbsp;<small>(.*?)<\/small>)?$/)
  const valPart = valMatch ? valMatch[1].trim() : ''
  const valUnit = valMatch ? (valMatch[2] || '') : ''

  // 判断是已知 D 模式还是已知 A_base 模式
  const modeD = formula.includes('已知 D')

  // 从 valueHtml 中提取 "数值 = 结果" 部分
  // D模式 valueHtml: "D = 16.00 m，A_base = V_design / D = 75000 / 16.00 =&nbsp;<small>m²</small>"
  // A_base模式 valueHtml: "A_base = 4687.5 m²，D = V_design / A_base = 75000 / 4687.5 =&nbsp;<small>m</small>"
  let resultNum, resultUnit, calcFormula
  if (modeD) {
    // 已知 D → 计算 A_base
    // 提取最后的 "= 数字" 部分作为结果
    const lastEqMatch = valPart.match(/=\s*([\d.]+)\s*$/)
    resultNum = lastEqMatch ? lastEqMatch[1] : ''
    resultUnit = valUnit
    // 提取完整的计算式
    const parts = valPart.split(',')
    calcFormula = parts.length > 1 ? parts[1].trim().replace(/\s*=\s*[\d.]+\s*$/, '') : valPart
  } else {
    // 已知 A_base → 计算 D
    const lastEqMatch = valPart.match(/=\s*([\d.]+)\s*$/)
    resultNum = lastEqMatch ? lastEqMatch[1] : ''
    resultUnit = valUnit
    // 提取完整的计算式
    const parts = valPart.split(',')
    calcFormula = parts.length > 1 ? parts[1].trim().replace(/\s*=\s*[\d.]+\s*$/, '') : valPart
  }

  if (modeD) {
    // 已知 D → 显示池底面积
    return `<div style="margin:4px 0">
      <div style="font-weight:600;font-size:12px;color:#333">几何模式</div>
      <div style="font-size:11px;color:#555;margin-left:8px">池底面积</div>
      <div style="font-size:11px;font-family:monospace;color:#666;margin-left:16px">${calcFormula}</div>
      <div style="font-size:13px;font-weight:600;color:#222;margin-left:16px">${resultNum}&nbsp;<small>${resultUnit}</small></div>
    </div>`
  } else {
    // 已知 A_base → 显示总池深
    return `<div style="margin:4px 0">
      <div style="font-weight:600;font-size:12px;color:#333">几何模式</div>
      <div style="font-size:11px;color:#555;margin-left:8px">总池深</div>
      <div style="font-size:11px;font-family:monospace;color:#666;margin-left:16px">${calcFormula}</div>
      <div style="font-size:13px;font-weight:600;color:#222;margin-left:16px">${resultNum}&nbsp;<small>${resultUnit}</small></div>
    </div>`
  }
}

// ── 已知条件只读摘要表格（各模块通用）────────────────────────────

function knownTable(rows) {
  return `<table class="known-table">${rows.map(([label, val, unit]) =>
    `<tr><td class="kt-label">${label}</td><td class="kt-val">${val}${unit ? ' <span class="kt-unit">' + unit + '</span>' : ''}</td></tr>`
  ).join('')}</table>`
}

// ── 计算过程（折叠）──────────────────────────────────────────────

function calcDetails(label, rows) {
  return `<details style="margin-bottom:14px"><summary style="cursor:pointer;color:#555;font-size:12px;margin-bottom:6px">${label}（点击展开）</summary>${stepsTable(rows)}</details>`
}

// ── 状态栏 ───────────────────────────────────────────────────────

function statusBar(r) {
  const hasErrors = r.errors && r.errors.length > 0
  const hasWarnings = r.warnings && r.warnings.length > 0
  const status = hasErrors ? 'error' : hasWarnings ? 'warn' : 'pass'
  const icon = status === 'pass' ? '✔' : status === 'warn' ? '⚠' : '✘'
  const label = status === 'pass' ? '计算完成' : status === 'warn' ? '完成（有警告）' : '计算失败'
  let msgs = ''
  if (hasErrors) r.errors.forEach(e => { msgs += `<li><span class="icon err">✘</span> <span class="err">${e}</span></li>` })
  if (hasWarnings) r.warnings.forEach(w => { msgs += `<li><span class="icon wrn">⚠</span> <span class="wrn">${w}</span></li>` })
  return { status, html: `<div style="margin-bottom:8px"><span style="font-weight:700;color:var(--color-${status})">${icon} ${label}</span></div>${msgs ? `<ul class="msg-list">${msgs}</ul>` : ''}` }
}

// ── AG1-1：污水池计算 ─────────────────────────────────────────────
export function renderPoolDepth(r) {
  if (!r) return '<p style="color:#999;padding:8px">尚未计算。</p>'
  const { status, html: statusHtml } = statusBar(r)

  if (r.valid === false) return statusHtml + '<p style="color:#c0392b;padding:4px 0;font-size:13px">计算失败，请检查输入参数。</p>'

  // 计算过程（过滤掉汇总类行）
  const calcRows = r.rows.filter(row => {
    const n = row.name || ''
    return !['═══════════', '容积校验', '水位关系', '超高校验', '多泵启动水位', '监控水位', '控制水位', '几何参数', '水位关系校验'].some(k => n.includes(k))
  })
  const cSection = `<div class="calc-section">${calcDetails('计算过程', calcRows)}</div>`

  // 输出结果：三个绿卡片
  const waterCard = `<div class="result-summary pass">
    ${kvRow('低水位报警 Z_alarm_low', fmt(r.Z_alarm_low, 2) + ' mPD')}
    ${kvRow('高水位报警 Z_alarm_high', fmt(r.Z_alarm_high, 2) + ' mPD')}
    ${kvRow('最高水位 Z_max', fmt(r.Z_max, 2) + ' mPD')}
  </div>`
  const pumpCard = `<div class="result-summary pass">
    ${kvRow('1#泵启动水位 Z_start1', fmt(r.Z_start1, 2) + ' mPD')}
    ${kvRow('2#泵启动水位 Z_start2', fmt(r.Z_start2, 2) + ' mPD')}
    ${kvRow('停泵水位 Z_stop', fmt(r.Z_stop, 2) + ' mPD')}
  </div>`
  const volCard = `<div class="result-summary pass">
    ${kvRow('最小调节容积 V_min', fmt(r.V_min, 1) + ' m³')}
    ${kvRow('有效调蓄容积 V_effective', fmt(r.V_effective, 1) + ' m³')}
    ${kvRow('容积校验', r.V_ok ? '✓ 满足' : '✘ 不满足', '')}
  </div>`
  const oSection = `<div class="result-section"><div class="section-title">输出结果</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${waterCard}
      ${pumpCard}
      ${volCard}
    </div>
  </div>`

  return statusHtml + cSection + oSection
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

// ── AG1-2：水泵计算及选型 ─────────────────────────────────────────
export function renderPumpSpec(r) {
  if (!r) return '<p style="color:#999;padding:8px">尚未计算。</p>'
  const { status, html: statusHtml } = statusBar(r)

  if (r.valid === false) return statusHtml + '<p style="color:#c0392b;padding:4px 0;font-size:13px">计算失败，请检查输入参数。</p>'

  const dp = r.designParams || {}

  // 已知条件（已移至 card-inputs 输入区域）

  // 计算过程
  const cSection = `<div class="calc-section">${calcDetails('计算过程', r.rows)}</div>`

  // NPSH 校验行
  const effClass = r.NPSH_ok ? 'pass' : 'fail'
  const effMsg = r.NPSH_ok
    ? `NPSH_a=${fmt(r.NPSH_a)} ≥ NPSH_r+0.5=${fmt(r.NPSH_r+0.5)}，满足`
    : `NPSH_a=${fmt(r.NPSH_a)} < NPSH_r+0.5=${fmt(r.NPSH_r+0.5)}，不满足`

  // 输出结果
  const oSection = `<div class="result-section"><div class="section-title">输出结果</div>
    <div class="result-summary pass">
      ${kvRow('系统总扬程 H_total', fmt(r.H_total, 2) + ' m')}
      ${kvRow('静扬程 H_static', fmt(r.H_static, 2) + ' m')}
      ${kvRow('总水头损失 H_loss', fmt(r.H_loss, 3) + ' m')}
      ${kvRow('轴功率 P_shaft', fmt(r.P_shaft, 2) + ' kW')}
      ${kvRow('电机功率 P_motor', fmt(r.P_motor, 2) + ' kW')}
      ${kvRow('进水管公称直径 DN_inlet', 'DN ' + r.DN_inlet)}
      ${kvRow('出水管公称直径 DN_outlet', 'DN ' + r.DN_outlet)}
    </div>
    <div class="result-summary ${effClass}" style="margin-top:6px;font-size:12px">
      <strong>NPSH校验：</strong>${effMsg}
    </div>
    ${renderCatalogMatch(r)}
  </div>`

  return statusHtml + cSection + oSection
}

// ── AG1-3：管道尺寸计算 ───────────────────────────────────────────
export function renderPipeSizing(r) {
  if (!r) return '<p style="color:#999;padding:8px">尚未计算。</p>'
  const { status, html: statusHtml } = statusBar(r)

  if (r.valid === false) return statusHtml + '<p style="color:#c0392b;padding:4px 0;font-size:13px">计算失败，请检查输入参数。</p>'

  const dp = r.designParams || {}

  // 已知条件（已移至 card-inputs 输入区域）

  // 计算过程
  const cSection = `<div class="calc-section">${calcDetails('计算过程', r.rows)}</div>`

  // 输出结果
  const oSection = `<div class="result-section"><div class="section-title">输出结果</div>
    <div class="result-summary pass">
      ${kvRow('泵进水管公称直径 DN_pumpIn', 'DN ' + r.DN_pumpIn)}
      ${kvRow('泵出水管公称直径 DN_pumpOut', 'DN ' + r.DN_pumpOut)}
      ${kvRow('总出水管公称直径 DN_mainOutlet', 'DN ' + r.DN_mainOutlet)}
      ${kvRow('沿程损失 H_f', fmt(r.H_f, 3) + ' m')}
      ${kvRow('局部损失 H_local', fmt(r.H_local, 3) + ' m')}
      ${kvRow('总水头损失 H_loss', fmt(r.H_loss, 3) + ' m')}
    </div>
    <div class="result-summary ${r.NPSH_ok ? 'pass' : 'fail'}" style="margin-top:6px;font-size:12px">
      <strong>NPSH校验：</strong>${r.NPSH_ok ? '✓ 满足' : '✘ 不满足'}
    </div>
  </div>`

  return statusHtml + cSection + oSection
}
