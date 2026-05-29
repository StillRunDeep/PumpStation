import { fmt, stepsTable, kvRow } from '../utils.js'
import { PIPE_SCHEMES } from '../agents/pipe-sizing.js'

// 拓扑验证结果（从 renderAG01 提取为独立函数）
function renderTopologyResult(r) {
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

// 向后兼容：renderTopology 调用 renderTopologyResult
export function renderTopology(r) {
  return renderTopologyResult(r)
}

// 暴雨分析渲染（仅暴雨结果，无拓扑）
export function renderRainfallCard({ duty10Year, capacity50, floodCheck200 }) {
  // 提取各重现期的关键值用于对比表
  const r10 = duty10Year
  const r50 = capacity50
  const r200 = floodCheck200

  // ── 计算过程（三重现期并列）──────────────────────────────
  const stepsRows = `
    <tr><td colspan="4" style="background:#f5f5f5;font-weight:700;color:#555;padding:4px 8px">───────── 暴雨强度（IDF公式） ─────────</td></tr>
    <tr><td>IDF常数 a</td><td>${r10.IDF_a || '—'}</td><td>${r50.IDF_a || '—'}</td><td>${r200.IDF_a || '—'}</td></tr>
    <tr><td>IDF常数 b</td><td>${r10.IDF_b || '—'}</td><td>${r50.IDF_b || '—'}</td><td>${r200.IDF_b || '—'}</td></tr>
    <tr><td>IDF常数 c</td><td>${r10.IDF_c || '—'}</td><td>${r50.IDF_c || '—'}</td><td>${r200.IDF_c || '—'}</td></tr>
    <tr><td>降雨强度 i（mm/h）</td><td>${fmt(r10.i)}</td><td>${fmt(r50.i)}</td><td>${fmt(r200.i)}</td></tr>

    <tr><td colspan="4" style="background:#f5f5f5;font-weight:700;color:#555;padding:4px 8px">───────── 径流估算（推理法） ─────────</td></tr>
    <tr><td>面积折减系数 ARF</td><td>${fmt(r10.ARF)}</td><td>${fmt(r50.ARF)}</td><td>${fmt(r200.ARF)}</td></tr>
    <tr><td>峰值流量 Q_p（m³/s）</td><td>${fmt(r10.Q_p)}</td><td>${fmt(r50.Q_p)}</td><td>${fmt(r200.Q_p)}</td></tr>
    <tr><td>总设计流量 Q（m³/h）</td><td>${fmt(r10.Q)}</td><td>${fmt(r50.Q)}</td><td>${fmt(r200.Q)}</td></tr>
    <tr><td>单泵设计流量 Q_pump（m³/s）</td><td>${fmt(r10.Q_pump)}</td><td>${fmt(r50.Q_pump)}</td><td>${fmt(r200.Q_pump)}</td></tr>

    <tr><td colspan="4" style="background:#f5f5f5;font-weight:700;color:#555;padding:4px 8px">───────── 集流时间（Bransby-Williams） ─────────</td></tr>
    <tr><td>集流时间 t_c（min）</td><td>${fmt(r10.t_c)}</td><td>${fmt(r50.t_c)}</td><td>${fmt(r200.t_c)}</td></tr>
  `

  return `
    <details open style="margin-bottom:14px"><summary style="cursor:pointer;color:#555;font-size:12px;margin-bottom:6px">计算过程</summary>
      <table class="step-table" style="font-size:12px;margin-top:0">
        <thead>
          <tr><th style="width:40%">参数</th><th style="text-align:center">T=10年（值班）</th><th style="text-align:center">T=50年（容量校核）</th><th style="text-align:center">T=200年（洪水检验）</th></tr>
        </thead>
        <tbody>
          ${stepsRows}
        </tbody>
      </table>
    </details>
    <div class="result-section" style="margin-top:12px">
      <div class="section-title">输出结果</div>
      <div class="result-summary pass">
        ${kvRow('T=10年 总设计流量 Q', fmt(r10.Q) + ' m³/h')}
        ${kvRow('T=10年 单泵设计流量 Q_pump', fmt(r10.Q_pump) + ' m³/s', '')}
        ${kvRow('T=50年 总设计流量 Q', fmt(r50.Q) + ' m³/h')}
        ${kvRow('T=200年 总设计流量 Q', fmt(r200.Q) + ' m³/h')}
      </div>
    </div>
`
}

/**
 * AG0-1: 暴雨计算结果卡片
 */
export function renderRainfall(r) {
  const status = r.valid ? (r.warnings.length > 0 ? 'warn' : 'pass') : 'error'
  const icon   = status === 'pass' ? '✔' : status === 'warn' ? '⚠' : '✘'
  const label  = status === 'pass' ? '验证通过' : status === 'warn' ? '通过（有警告）' : '验证失败'

  let msgs = ''
  r.errors.forEach(e   => { msgs += `<li><span class="icon err">✘</span> <span class="err">${e}</span></li>` })
  r.warnings.forEach(w => { msgs += `<li><span class="icon wrn">⚠</span> <span class="wrn">${w}</span></li>` })
  if (r.errors.length === 0 && r.warnings.length === 0)
    msgs = '<li><span class="icon ok">✔</span> <span class="ok">所有参数合法，可继续计算</span></li>'

  // 过滤掉已知条件（输入参数回显）和最终结果，保留中间计算步骤
  const inputLabels = [
    '池底标高', '集水坑底标高', '设计水缸深度', '池顶标高', '排放口标高',
    '工作泵台数', '备用泵台数', '每小时允许启动次数',
    '水泵最高总排水量', '设计水缸容量', '单泵设计流量（m³/s）',
    '暴雨分区', '设计重现期', '暴雨历时', '集水区面积', '径流系数',
    '气候变化', '平均坡降', '最长流径',
    '池底面积', '设计水缸深度',
    '单泵设计流量 Q_pump（m³/s）',
    '═',
  ]
  const calcRows = r.rows.filter(row => {
    for (const lbl of inputLabels) {
      if (row.includes(`<td>${lbl}</td>`) || row.includes(`<td>${lbl} `)) return false
    }
    return true
  })

  return `
    <div style="margin-bottom:12px">
      <span style="font-weight:700;color:var(--color-${status})">${icon} ${label}</span>
    </div>
    <ul class="msg-list">${msgs}</ul>
    ${r.valid ? `<details open style="margin-bottom:14px"><summary style="cursor:pointer;color:#555;font-size:12px;margin-bottom:6px">计算过程</summary>${stepsTable(calcRows)}</details>` : ''}
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
  return `<details open style="margin-bottom:14px"><summary style="cursor:pointer;color:#555;font-size:12px;margin-bottom:6px">${label}</summary>${stepsTable(rows)}</details>`
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

  // 计算过程（过滤掉：输入值回显、高级设置回显、输出结果、多余标题行）
  // 中间结果（带公式计算的）全部保留
  const excludeLabels = [
    '═', '几何模式',
    '1#泵启动水位系数', '2#泵启动水位系数',
    '超高', '安全余量', '低水位报警偏移', '每小时允许启动次数',
    '设计水缸容量', '设计水缸深度', '池底面积', '池底标高', '池顶标高', '集水坑底标高',
    '监控水位', '控制水位', '多泵启动水位',
    '单泵流量', '最小调节容积', '有效调蓄容积', '容积校验',
    '水位关系', '超高校验',
  ]
  const calcRows = r.rows.filter(row => {
    for (const lbl of excludeLabels) {
      if (row.includes(`<td>${lbl}</td>`) || row.includes(`<td>${lbl} `)) return false
    }
    return true
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
  if (!r) return '<p style="color:#999;padding:8px">尚未计算。</p>'

  // 过滤掉典型值/设计参数行（w_pump, d_pump），保留中间计算步骤
  const excludeLabels = ['单泵外形宽度 w_pump', '单泵外形深度 d_pump', '支管 DN_branch', '主管 DN_main']
  const calcRows = r.rows.filter(row => {
    for (const lbl of excludeLabels) {
      if (row.includes(`<td>${lbl}</td>`) || row.includes(`<td>${lbl} `)) return false
    }
    return true
  })

  // 管件尺寸来源
  const dimSource = r.hasCatalogDims
    ? '<span style="color:#27ae60">● 来自泵目录（catalog）</span>'
    : '<span style="color:#e67e22">● 通用估算值（0.6×0.8 m）</span>'

  // W 逐项明细表
  let breakdownHtml = ''
  if (r.W_breakdown && r.W_breakdown.length > 0) {
    const rows = r.W_breakdown.map(item =>
      `<tr><td style="padding:3px 8px;font-size:11px">${item.label}</td>
       <td style="padding:3px 8px;font-size:11px;text-align:right;color:#1a3a5c;font-family:monospace">${item.val}</td>
       <td style="padding:3px 8px;font-size:11px;color:#888">${item.unit}</td></tr>`
    ).join('')
    breakdownHtml = `
      <table style="font-size:12px;border-collapse:collapse;margin-top:6px;width:auto">
        <tr style="background:#f5f5f5"><th style="text-align:left;padding:3px 8px">项目</th><th style="padding:3px 8px;text-align:right">数值</th><th style="padding:3px 8px">单位</th></tr>
        ${rows}
        <tr style="background:#eaf2fb;font-weight:600"><td style="padding:3px 8px">W_pipe（管件空间合计）</td><td style="padding:3px 8px;text-align:right;font-family:monospace">${fmt(r.W_pipe ?? 0, 3)}</td><td style="padding:3px 8px">m</td></tr>
      </table>`
  }

  // 集水坑管件说明
  let sumpHtml = ''
  if (r.sumpFittings?.notes?.length > 0) {
    sumpHtml = `
      <div style="margin-top:8px;font-size:11px;color:#555;background:#f9f9f9;padding:6px 8px;border-radius:4px">
        <strong>集水坑管件：</strong>${r.sumpFittings.notes.join('；')}
      </div>`
  }

  return `
    <div style="margin-bottom:4px;font-size:12px">${dimSource}</div>
    <details open style="margin-bottom:6px"><summary style="cursor:pointer;color:#555;font-size:12px;margin-bottom:4px">计算过程</summary>
      ${stepsTable(calcRows)}
      ${sumpHtml}
    </details>
    ${breakdownHtml ? `<details style="margin-bottom:14px"><summary style="cursor:pointer;color:#555;font-size:12px;margin-bottom:4px">管件明细</summary>${breakdownHtml}</details>` : ''}
    <div class="result-section"><div class="section-title">输出结果</div>
    <div class="result-summary pass">
      ${kvRow('维护间净长 L', fmt(r.L, 1) + ' m')}
      ${kvRow('维护间净宽 W', fmt(r.W, 1) + ' m')}
      ${kvRow('维护间面积', fmt(r.L * r.W, 1) + ' m²')}
      ${kvRow('泵间净距 d_spacing', fmt(r.d_spacing, 1) + ' m')}
      ${kvRow('端部距墙净距 e_wall', fmt(r.e_wall, 1) + ' m')}
    </div></div>
  `
}

// 泵型目录选型结果区块
function renderCatalogMatch(r) {
  const matches = r.catalogMatches?.length > 0 ? r.catalogMatches : r.catalogMatchesTolerant
  const isTolerant = r.catalogIsTolerant

  if (!matches || matches.length === 0) {
    const diagRows = (r.catalogDiagnosis || []).map(d =>
      `<tr><td style="font-weight:600">${d.pump.model.split(' ').pop()}</td>
       <td style="color:#c0392b">${d.detail}</td></tr>`
    ).join('')

    return `
    <div class="result-summary error" style="margin-top:8px">
      <div style="font-weight:700;margin-bottom:6px">✘ 目录中无匹配泵型</div>
      ${kvRow('设计流量 Q', fmt(r.Q_pump_ls, 1) + ' l/s (' + fmt(r.Q_pump_ls * 3.6, 0) + ' m³/h)')}
      ${kvRow('所需扬程 H', fmt(r.H_total, 2) + ' m（静扬程 ' + fmt(r.H_static, 2) + ' m + 损失 ' + fmt(r.H_loss, 2) + ' m）')}
      ${diagRows ? `<table style="margin-top:8px;font-size:11px;border-collapse:collapse;width:100%">
        <tr><th style="text-align:left">泵型</th><th style="text-align:left">排除原因</th></tr>
        ${diagRows}
      </table>` : ''}
      <div style="font-size:11px;color:#999;margin-top:6px">提示：降低流量或减小静扬程可能找到匹配泵型。</div>
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

  // 计算过程（过滤掉：设计参数回显、输入参数回显、泵安装尺寸）
  const excludeLabels = [
    '═', '设计参数',
    '水力效率 η_hyd', '电机效率 η_mot', '必需汽蚀余量 NPSH_r', '出水管阻力 H_pipe_loss',
    '单泵设计流量 Q_pump',
    '泵安装尺寸', '泵出水弯头',
  ]
  const calcRows = r.rows.filter(row => {
    for (const lbl of excludeLabels) {
      if (row.includes(`<td>${lbl}</td>`) || row.includes(`<td>${lbl} `)) return false
    }
    return true
  })
  const cSection = `<div class="calc-section">${calcDetails('计算过程', calcRows)}</div>`

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
      ${kvRow('出水管阻力 H_pipe_loss', fmt(r.H_pipe_loss, 2) + ' m')}
      ${kvRow('轴功率 P_shaft', fmt(r.P_shaft, 2) + ' kW')}
      ${kvRow('电机功率 P_motor', fmt(r.P_motor, 2) + ' kW')}
      ${r.DN_pump_outlet != null ? kvRow('泵出水弯头 DN（资料库）', 'DN ' + r.DN_pump_outlet) : ''}
    </div>
    <div class="result-summary ${effClass}" style="margin-top:6px;font-size:12px">
      <strong>NPSH校验：</strong>${effMsg}
    </div>
    ${renderCatalogMatch(r)}
  </div>`

  return statusHtml + cSection + oSection
}

// ── 方案摘要渲染 ─────────────────────────────────────────────────
function renderSchemeSummary(schemeId) {
  const scheme = PIPE_SCHEMES.find(s => s.id === schemeId)
  if (!scheme) return ''

  const riskColor = scheme.surgeRisk === 'high' ? '#c0392b' : scheme.surgeRisk === 'low' ? '#e67e22' : '#27ae60'
  const riskDot = scheme.surgeRisk === 'high' ? '●' : scheme.surgeRisk === 'low' ? '◐' : '○'

  return `
    <div class="scheme-summary">
      <span class="badge ${scheme.surgeRisk}">${scheme.badge}</span>
      <strong>${scheme.name}</strong>
      <span class="scheme-vel">v=${scheme.v_pumpOut}/${scheme.v_mainOut} m/s</span>
      <span style="color:${riskColor};margin-left:auto">${riskDot}</span>
    </div>
  `
}

// ── 方案选项卡渲染 ────────────────────────────────────────────────
export function renderSchemeOptions(activeId) {
  return PIPE_SCHEMES.map(s => `
    <div class="scheme-card ${s.id === activeId ? 'active' : ''}"
         onclick="handleSchemeChange(${s.id})">
      <div class="scheme-badge ${s.surgeRisk}">${s.badge}</div>
      <div class="scheme-name">${s.name}</div>
    </div>
  `).join('')
}

// ── AG1-3：管道尺寸计算 ───────────────────────────────────────────
export function renderPipeSizing(r) {
  if (!r) return '<p style="color:#999;padding:8px">尚未计算。</p>'
  const { status, html: statusHtml } = statusBar(r)

  if (r.valid === false) return statusHtml + '<p style="color:#c0392b;padding:4px 0;font-size:13px">计算失败，请检查输入参数。</p>'

  const dp = r.designParams || {}

  // 方案摘要
  const schemeSummaryHtml = r.schemeId ? renderSchemeSummary(r.schemeId) : ''

  // 已知条件（已移至 card-inputs 输入区域）

  // 计算过程（过滤掉已知条件输入、方案标题行、泵安装尺寸、输出结果）
  const excludeLabels = [
    '═',
    '泵出水管设计流速', '总出水干管设计流速',
    '曼宁粗糙系数', '局部损失系数', '必需汽蚀余量 NPSH_r', '管长 L',
    '泵出水管公称直径', '泵进水管公称直径',
    '总出水管公称直径',
    '沿程损失 H_f', '局部损失 H_local', '总水头损失 H_loss',
    'NPSH校验',
    '泵安装尺寸', '泵出水弯头',
  ]
  const calcRows = r.rows.filter(row => {
    for (const lbl of excludeLabels) {
      if (row.includes(`<td>${lbl}</td>`) || row.includes(`<td>${lbl} `)) return false
    }
    return true
  })
  const cSection = `<div class="calc-section">${calcDetails('计算过程', calcRows)}</div>`

  // 输出结果
  const oSection = `<div class="result-section"><div class="section-title">输出结果</div>
    <div class="result-summary pass">
      ${kvRow('泵出水管公称直径 DN_pumpOut', 'DN ' + r.DN_pumpOut)}
      ${r.DN_pump_outlet != null
        ? kvRow('泵出口变径构件', r.reducerDesc ?? '无需变径（管径一致）')
        : ''}
      ${kvRow('总出水管公称直径 DN_mainOutlet', 'DN ' + r.DN_mainOutlet)}
      ${kvRow('沿程损失 H_f', fmt(r.H_f, 3) + ' m')}
      ${kvRow('局部损失 H_local', fmt(r.H_local, 3) + ' m')}
      ${kvRow('总水头损失 H_loss', fmt(r.H_loss, 3) + ' m')}
    </div>
    <div class="result-summary ${r.NPSH_ok ? 'pass' : 'fail'}" style="margin-top:6px;font-size:12px">
      <strong>NPSH校验：</strong>${r.NPSH_ok ? '✓ 满足' : '✘ 不满足'}
    </div>
  </div>`

  return statusHtml + schemeSummaryHtml + cSection + oSection
}
