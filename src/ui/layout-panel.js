import { renderLayoutSVG, renderLayoutSVGDual } from '../render/layout-svg.js'
import { renderDebugGrid } from '../render/svg-helpers.js'
import { initSvgZoomPan } from '../render/zoom-pan.js'

// Module-level state
let _variants = []
let _selectedIdx = 0
const VW = 1080, VH = 560

// ── Group metadata ────────────────────────────────────────────────────

const GROUP_LABELS = {
  'S':    { title: '方案库', subtitle: '', color: '#1a3a5c' },
  'R1.0': { title: '长宽比 1.0（方形）',           subtitle: '3 个方案', color: '#1a6535' },
  'R1.2': { title: '长宽比 1.2',                   subtitle: '3 个方案', color: '#1a6535' },
  'R1.5': { title: '长宽比 1.5',                   subtitle: '3 个方案', color: '#1a6535' },
  'R1.8': { title: '长宽比 1.8',                   subtitle: '3 个方案', color: '#1a6535' },
  'R2.0': { title: '长宽比 2.0',                   subtitle: '3 个方案', color: '#1a6535' },
  'R2.4': { title: '长宽比 2.4',                   subtitle: '3 个方案', color: '#1a6535' },
}

function groupLabel(t) {
  return GROUP_LABELS[t.groupId] || { title: t.groupId, subtitle: '', color: '#555' }
}

// ── Comparison table ──────────────────────────────────────────────────

function renderComparisonTable(variants) {
  const bdSign = v => v >= 0 ? `+${v}` : `${v}`

  let lastGroupId = null
  const rows = variants.map((v, i) => {
    const bd  = v.breakdown || {}
    const mustSat = (v.adjacency?.satisfied  || []).filter(a => a.type === 'must').length
    const mustTot = mustSat + (v.adjacency?.violated || []).filter(a => a.type === 'must').length
    const violCell = v.violations.length === 0
      ? `<span style="color:#27ae60">✓</span>`
      : `<span style="color:#c0392b">⚠ ${v.violations.length}</span>`
    const area = Math.round(v.buildingW * v.buildingD / 1e6)
    const eff  = v.spaceEfficiency != null ? (v.spaceEfficiency * 100).toFixed(1) + '%' : '—'
    const ar   = v.aspectRatio != null ? v.aspectRatio.toFixed(2) : '—'

    const bdDetail = `
      <details><summary style="cursor:pointer;font-size:11px;color:#666">明细</summary>
      <table style="font-size:11px;margin-top:4px;border-collapse:collapse">
        <tr><td style="padding:1px 6px">基础分</td><td style="text-align:right">${bdSign(bd.base ?? 10000)}</td></tr>
        <tr><td style="padding:1px 6px">占地面积</td><td style="text-align:right;color:#c0392b">${bdSign(bd.footprint ?? 0)}</td></tr>
        <tr><td style="padding:1px 6px">临近关系</td><td style="text-align:right;color:#27ae60">${bdSign(bd.adjacency ?? 0)}</td></tr>
        <tr><td style="padding:1px 6px">走廊完整</td><td style="text-align:right;color:#27ae60">${bdSign(bd.corridor ?? 0)}</td></tr>
        <tr><td style="padding:1px 6px">变压器布置</td><td style="text-align:right;color:#27ae60">${bdSign(bd.trafo ?? 0)}</td></tr>
        <tr><td style="padding:1px 6px">风机房距离</td><td style="text-align:right;color:#27ae60">${bdSign(bd.fanRoom ?? 0)}</td></tr>
        <tr><td style="padding:1px 6px">空间有效率</td><td style="text-align:right;color:#27ae60">${bdSign(bd.efficiency ?? 0)}</td></tr>
        <tr><td style="padding:1px 6px">约束违反</td><td style="text-align:right;color:#c0392b">${bdSign(bd.violations ?? 0)}</td></tr>
      </table></details>`

    // Insert a group-separator row when the groupId changes (REMOVED as requested)
    let groupRow = ''
    /*
    if (v.groupId !== lastGroupId) {
      lastGroupId = v.groupId
      const gl = groupLabel(v)
      const dims = `${(v.buildingW / 1000).toFixed(1)} m × ${(v.buildingD / 1000).toFixed(1)} m`
      groupRow = `
        <tr>
          <td colspan="9" style="background:${gl.color};color:#fff;padding:5px 10px;
              font-size:12px;font-weight:700;letter-spacing:.5px">
            ${gl.title}（${dims}）${gl.subtitle ? `&ensp;<span style="opacity:.75;font-weight:400">${gl.subtitle}</span>` : ''}
          </td>
        </tr>`
    }
    */

    return groupRow + `
      <tr style="cursor:pointer;background:${i % 2 === 0 ? '#f8fafc' : '#fff'}" onclick="window._ag41SelectVariant(${i})">
        <td style="text-align:center;font-weight:600">${i + 1}</td>
        <td><strong>${v.id}</strong><br><span style="font-size:11px;color:#555">${v.label}</span></td>
        <td style="text-align:center;font-size:11px">${ar}</td>
        <td style="text-align:right;font-weight:700;color:#1a5276">${v.score}</td>
        <td style="text-align:right">${area}</td>
        <td style="text-align:right">${eff}</td>
        <td style="text-align:center">${mustSat} / ${mustTot}</td>
        <td style="text-align:center">${violCell}</td>
        <td>${bdDetail}</td>
      </tr>`
  }).join('')

  return `
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
      <thead>
        <tr style="background:#1a3a5c;color:#fff;font-size:12px">
          <th style="padding:7px 8px">排名</th>
          <th style="padding:7px 8px;text-align:left">方案</th>
          <th style="padding:7px 8px">长宽比</th>
          <th style="padding:7px 8px;text-align:right">综合得分</th>
          <th style="padding:7px 8px;text-align:right">占地 m²</th>
          <th style="padding:7px 8px;text-align:right">空间有效率</th>
          <th style="padding:7px 8px">必须临近</th>
          <th style="padding:7px 8px">约束违反</th>
          <th style="padding:7px 8px">得分明细</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`
}

// ── Variant card grid with group headers ──────────────────────────────

function renderVariantCards(variants) {
  const sections = []
  let currentGroup = null
  let currentCards = []

  const flush = () => {
    if (!currentGroup) return
    const gl = groupLabel({ groupId: currentGroup })
    const firstV = variants.find(v => v.groupId === currentGroup)
    const dims   = firstV
      ? `${(firstV.buildingW / 1000).toFixed(1)} m × ${(firstV.buildingD / 1000).toFixed(1)} m`
      : ''
    sections.push(`
      <div class="variant-group">
        <div class="variant-group-cards">
          ${currentCards.join('')}
        </div>
      </div>`)
    currentCards = []
  }

  variants.forEach((v, i) => {
    if (v.groupId !== currentGroup) {
      flush()
      currentGroup = v.groupId
    }

    const thumbSvg = renderLayoutSVG(v, 360, 200, { showDims: false, showCrane: true })
    currentCards.push(`
      <div class="variant-card ${i === 0 ? 'selected' : ''}" data-idx="${i}"
           onclick="window._ag41SelectVariant(${i})">
        <div class="vc-header">
          <span>方案 ${v.id}</span>
          <span class="vc-score">得分 ${v.score}</span>
        </div>
        <svg class="vc-thumb" viewBox="0 0 360 200">${thumbSvg}</svg>
        <div class="vc-desc">${v.desc}</div>
        <div class="vc-metrics">
          ${(v.buildingW / 1000).toFixed(1)} m × ${(v.buildingD / 1000).toFixed(1)} m
          &nbsp;|&nbsp; ${Math.round(v.buildingW * v.buildingD / 1e6)} m²
          &nbsp;|&nbsp; 有效率 ${v.spaceEfficiency != null ? Math.round(v.spaceEfficiency * 100) + '%' : '—'}
          ${v.violations.length > 0 ? `&nbsp;|&nbsp; <span style="color:#c0392b">⚠ ${v.violations.length} 项约束</span>` : ''}
        </div>
        <button class="vc-select-btn" onclick="event.stopPropagation();window._ag41ConfirmVariant(${i})">
          选用此方案 →
        </button>
      </div>
    `)
  })
  flush()

  return sections.join('')
}

// ── Public render function ────────────────────────────────────────────

/**
 * Render the AG4-1 panel: comparison table + grouped thumbnail cards + detail view.
 * @param {Array} variants  Sorted result from runAG42()
 */
export function renderLayoutPanel(variants) {
  _variants = variants
  _selectedIdx = 0

  const container = document.getElementById('layout-variants')
  if (!container) return

  const cmp = document.getElementById('layout-comparison')
  if (cmp) cmp.innerHTML = renderComparisonTable(variants)

  container.innerHTML = renderVariantCards(variants)

  // Update badge
  const badge  = document.getElementById('ag41-badge')
  if (badge) badge.textContent = '最优方案推荐'

  // Show first variant detail
  selectVariant(0)
  document.getElementById('card-ag41-wrap').hidden = false
  const moreBtn = document.getElementById('btn-ag41-more')
  if (moreBtn) moreBtn.hidden = false
  const resetBtn = document.getElementById('btn-ag41-reset')
  if (resetBtn) resetBtn.hidden = false

  showAg41Notify('已生成初始方案。可点击“生成方案”持续优化。', true);
}

// ── Detail view ───────────────────────────────────────────────────────

function selectVariant(idx) {
  _selectedIdx = idx
  document.querySelectorAll('.variant-card').forEach((el, i) =>
    el.classList.toggle('selected', i === idx)
  )

  const v = _variants[idx]
  const svg = document.getElementById('svg-ag41')
  if (!svg) return

  svg.setAttribute('viewBox', `0 0 ${VW} ${VH}`)
  svg.innerHTML = renderLayoutSVGDual(v, VW, VH)
  initSvgZoomPan(svg, VW, VH, { zIn: 'btn-ag41-zin', zOut: 'btn-ag41-zout', zRst: 'btn-ag41-rst' })

  // Update detail header
  const header = document.getElementById('layout-detail-title')
  if (header) {
    header.textContent =
      `方案 ${v.id}：${v.label}  —  ` +
      `${(v.buildingW / 1000).toFixed(1)} m × ${(v.buildingD / 1000).toFixed(1)} m  ` +
      `得分 ${v.score}`
  }

  // Update debug view
  const debugContainer = document.getElementById('debug-grid-container')
  if (debugContainer) {
    if (v._debug && v._debug.ground?.gridBeforeGaps && v._debug.level1?.gridBeforeGaps) {
      debugContainer.innerHTML =
        '<h4 style="margin-top:0; margin-bottom: 10px; font-size: 12px; color: #555;">调试视图：地面层 (填充前)</h4>' +
        renderDebugGrid({ grid: v._debug.ground.gridBeforeGaps, seeds: v._debug.ground.seeds }, 380, 265) +
        '<h4 style="margin-top:10px; margin-bottom: 10px; font-size: 12px; color: #555;">调试视图：一层 (填充前)</h4>' +
        renderDebugGrid({ grid: v._debug.level1.gridBeforeGaps, seeds: v._debug.level1.seeds }, 380, 265);
    } else {
      debugContainer.innerHTML = '<p style="color:#888;font-size:12px;text-align:center;margin-top:20px;">无调试数据</p>';
    }
  }

  document.getElementById('layout-detail-wrap').hidden = false
}

// ── Global handlers ───────────────────────────────────────────────────

window._ag41SelectVariant = selectVariant

window._ag41ConfirmVariant = function (idx) {
  _selectedIdx = idx
  selectVariant(idx)
  window.dispatchEvent(new CustomEvent('ag41-layout-confirmed', {
    detail: { variant: _variants[idx] },
  }))
}

export function getSelectedVariant() {
  return _variants[_selectedIdx] || null
}

export function getVariants() {
  return _variants
}

export function showAg41Notify(msg, isImproved) {
  const el = document.getElementById('ag41-notify')
  if (!el) return
  el.textContent = msg
  el.className = 'header-notify ' + (isImproved ? 'notify-ok' : 'notify-warn')
}
