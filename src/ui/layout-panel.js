import { renderLayoutSVGDual } from '../render/layout-svg.js'
import { renderDebugGrid } from '../render/svg-helpers.js'
import { initSvgZoomPan } from '../render/zoom-pan.js'
import {
  WEIGHT_KEYS, WEIGHT_LABELS, DEFAULT_WEIGHTS,
  saveWeights, loadWeights, computeWeightedScore,
} from '../layout/weights.js'

// Module-level state
let _variants = []
let _selectedIdx = 0          // current selected row index (in sorted order)
let _detailOpen = false       // whether the detail inline row is visible
let _weights = loadWeights()  // per-key score weights, persisted to localStorage
const VW = 1080, VH = 560
const COL_COUNT = 9           // number of table columns

// ── Weight helpers ────────────────────────────────────────────────────

/** Return a sorted copy of _variants using current weights. */
function _sortedVariants() {
  return [..._variants].sort((a, b) =>
    computeWeightedScore(b.breakdown, _weights) - computeWeightedScore(a.breakdown, _weights)
  )
}

// ── Weights panel ─────────────────────────────────────────────────────

function renderWeightsPanel(weights) {
  // Render 12 weight inputs in a 2-row × 6-col compact grid
  const keys = WEIGHT_KEYS
  const half = Math.ceil(keys.length / 2)
  const row1 = keys.slice(0, half)
  const row2 = keys.slice(half)

  const cell = (k) => `
    <td style="padding:3px 8px;white-space:nowrap">
      <label style="font-size:11px;color:#555;display:block;margin-bottom:2px">${WEIGHT_LABELS[k]}</label>
      <input type="number" data-wkey="${k}"
             value="${weights[k] ?? 1}"
             min="0" max="10" step="0.1"
             style="width:56px;font-size:12px;padding:2px 4px;border:1px solid #bdc3c7;
                    border-radius:3px;text-align:right"
             onchange="window._ag41UpdateWeight('${k}', +this.value)">
    </td>`

  return `
    <div id="weights-panel" style="background:#f0f4f8;border:1px solid #d5dde5;
         border-radius:4px;padding:8px 12px;margin-bottom:8px">
      <div style="display:flex;align-items:center;margin-bottom:6px">
        <span style="font-size:12px;font-weight:600;color:#1a3a5c">权重参数</span>
        <span style="font-size:11px;color:#888;margin-left:8px">调整各评分项影响系数（初始值均为 1）</span>
        <button onclick="window._ag41ResetWeights()"
                style="margin-left:auto;font-size:11px;padding:3px 10px;
                       background:#fff;border:1px solid #bdc3c7;border-radius:3px;
                       cursor:pointer;color:#555">重置权重</button>
      </div>
      <table style="border-collapse:collapse;width:100%">
        <tr>${row1.map(cell).join('')}</tr>
        <tr>${row2.map(cell).join('')}</tr>
      </table>
    </div>`
}

// ── Comparison table ──────────────────────────────────────────────────

function renderComparisonTable(variants, weights) {
  const bdSign = v => v >= 0 ? `+${v}` : `${v}`

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
    const weightedScore = computeWeightedScore(bd, weights)

    const bdDetail = `
      <details onclick="event.stopPropagation()">
        <summary style="cursor:pointer;font-size:11px;color:#666">明细</summary>
        <table style="font-size:11px;margin-top:4px;border-collapse:collapse">
          <tr><td style="padding:1px 6px">基础分</td><td style="text-align:right">${bdSign(bd.base ?? 10000)}</td></tr>
          <tr><td style="padding:1px 6px">占地面积</td><td style="text-align:right;color:#c0392b">${bdSign(bd.footprint ?? 0)}</td></tr>
          <tr><td style="padding:1px 6px">临近关系</td><td style="text-align:right;color:#27ae60">${bdSign(bd.adjacency ?? 0)}</td></tr>
          <tr><td style="padding:1px 6px">走廊完整</td><td style="text-align:right;color:#27ae60">${bdSign(bd.corridor ?? 0)}</td></tr>
          <tr><td style="padding:1px 6px">变压器布置</td><td style="text-align:right;color:#27ae60">${bdSign(bd.trafo ?? 0)}</td></tr>
          <tr><td style="padding:1px 6px">风机房距离</td><td style="text-align:right;color:#27ae60">${bdSign(bd.fanRoom ?? 0)}</td></tr>
          <tr><td style="padding:1px 6px">空间有效率</td><td style="text-align:right;color:#27ae60">${bdSign(bd.efficiency ?? 0)}</td></tr>
          <tr><td style="padding:1px 6px">便捷性</td><td style="text-align:right;color:#27ae60">${bdSign(bd.accessibility ?? 0)}</td></tr>
          <tr><td style="padding:1px 6px">约束违反</td><td style="text-align:right;color:#c0392b">${bdSign(bd.violations ?? 0)}</td></tr>
          ${bd.doorAccess   ? `<tr><td style="padding:1px 6px">可达性违反</td><td style="text-align:right;color:#c0392b">${bdSign(bd.doorAccess)}</td></tr>` : ''}
          ${bd.missingRooms ? `<tr><td style="padding:1px 6px">房间缺失</td><td style="text-align:right;color:#c0392b">${bdSign(bd.missingRooms)}</td></tr>` : ''}
          ${bd.aspectRatio  ? `<tr><td style="padding:1px 6px">长宽比违反</td><td style="text-align:right;color:#c0392b">${bdSign(bd.aspectRatio)}</td></tr>` : ''}
        </table>
      </details>`

    // Row base bg (overridden when selected via DOM update)
    const rowBg = i % 2 === 0 ? '#f8fafc' : '#fff'

    return `
      <tr class="variant-row" data-idx="${i}" data-vid="${v.id}"
          style="cursor:pointer;background:${rowBg}"
          onclick="window._ag41SelectVariant(${i})">
        <td class="vr-rank" style="text-align:center;font-weight:600;padding:7px 8px;
            border-left:4px solid transparent;transition:border-color .15s">${i + 1}</td>
        <td style="padding:7px 8px"><strong>${v.id}</strong><br>
          <span style="font-size:11px;color:#555">${v.label}</span></td>
        <td style="text-align:center;font-size:11px;padding:7px 8px">${ar}</td>
        <td style="text-align:right;font-weight:700;color:#1a5276;padding:7px 8px">${weightedScore}</td>
        <td style="text-align:right;padding:7px 8px">${area}</td>
        <td style="text-align:right;padding:7px 8px">${eff}</td>
        <td style="text-align:center;padding:7px 8px">${mustSat} / ${mustTot}</td>
        <td style="text-align:center;padding:7px 8px">${violCell}</td>
        <td style="padding:7px 8px">${bdDetail}</td>
      </tr>`
  }).join('')

  return `
    <div id="comparison-table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#1a3a5c;color:#fff;font-size:12px">
            <th style="padding:7px 8px">排名</th>
            <th style="padding:7px 8px;text-align:left">方案</th>
            <th style="padding:7px 8px">长宽比</th>
            <th style="padding:7px 8px;text-align:right">加权得分</th>
            <th style="padding:7px 8px;text-align:right">占地 m²</th>
            <th style="padding:7px 8px;text-align:right">空间有效率</th>
            <th style="padding:7px 8px">必须临近</th>
            <th style="padding:7px 8px">约束违反</th>
            <th style="padding:7px 8px">得分明细</th>
          </tr>
        </thead>
        <tbody id="variant-tbody">
          ${rows}
        </tbody>
      </table>
    </div>`
}

// ── Inline detail row ─────────────────────────────────────────────────

function buildDebugHtml(v) {
  if (v._debug && v._debug.ground?.gridBeforeGaps && v._debug.level1?.gridBeforeGaps) {
    return (
      '<h4 style="margin-top:0;margin-bottom:8px;font-size:12px;color:#555">地面层（填充前）</h4>' +
      renderDebugGrid({ grid: v._debug.ground.gridBeforeGaps, seeds: v._debug.ground.seeds }, 380, 260) +
      '<h4 style="margin-top:10px;margin-bottom:8px;font-size:12px;color:#555">一层（填充前）</h4>' +
      renderDebugGrid({ grid: v._debug.level1.gridBeforeGaps, seeds: v._debug.level1.seeds }, 380, 260)
    )
  }
  return '<p style="color:#888;font-size:12px;text-align:center;margin-top:20px">无调试数据</p>'
}

/** Build and insert the inline detail <tr> after the selected variant row. */
function insertDetailRow(idx) {
  removeDetailRow()

  // idx refers to sorted order; look up the variant from the rendered rows
  const sorted = _sortedVariants()
  const v = sorted[idx]
  if (!v) return

  const svgContent  = renderLayoutSVGDual(v, VW, VH)
  const debugHtml   = buildDebugHtml(v)
  const title = `方案 ${v.id}：${v.label}  —  ` +
    `${(v.buildingW / 1000).toFixed(1)} m × ${(v.buildingD / 1000).toFixed(1)} m  加权得分 ${computeWeightedScore(v.breakdown, _weights)}`

  const detailHtml = `
    <tr class="detail-inline-row" style="background:#f0f7ff">
      <td colspan="${COL_COUNT}" style="padding:0;border-top:2px solid #2471a3;border-bottom:2px solid #2471a3">
        <div class="layout-detail-header" style="display:flex;align-items:center;padding:6px 12px;
             background:#dceefb;border-bottom:1px solid #aed6f1">
          <span id="layout-detail-title" style="font-weight:700;font-size:13px;color:#1a3a5c">${title}</span>
          <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
            <button class="svg-zoom-btn" id="btn-ag41-zin"  title="放大">＋</button>
            <button class="svg-zoom-btn" id="btn-ag41-rst"  title="复位">⊙</button>
            <button class="svg-zoom-btn" id="btn-ag41-zout" title="缩小">－</button>
            <button class="vc-select-btn"
                    onclick="event.stopPropagation();window._ag41ConfirmVariant(${idx})"
                    style="margin-left:10px">选用此方案 →</button>
          </div>
        </div>
        <div style="display:flex">
          <svg id="svg-ag41" viewBox="0 0 ${VW} ${VH}"
               style="display:block;flex:0 0 60%;height:${VH}px;cursor:grab;background:#f4f6f8">
            ${svgContent}
          </svg>
          <div id="debug-grid-container"
               style="flex:0 0 40%;height:${VH}px;border-left:1px solid #ccc;
                      padding:10px;box-sizing:border-box;overflow-y:auto">
            ${debugHtml}
          </div>
        </div>
      </td>
    </tr>`

  // Insert after the selected row in the tbody
  const tbody = document.getElementById('variant-tbody')
  if (!tbody) return
  const targetRow = tbody.querySelector(`.variant-row[data-idx="${idx}"]`)
  if (targetRow) {
    targetRow.insertAdjacentHTML('afterend', detailHtml)
  } else {
    tbody.insertAdjacentHTML('beforeend', detailHtml)
  }

  // Bind zoom controls
  const svg = document.getElementById('svg-ag41')
  if (svg) {
    initSvgZoomPan(svg, VW, VH, { zIn: 'btn-ag41-zin', zOut: 'btn-ag41-zout', zRst: 'btn-ag41-rst' })
  }
}

function removeDetailRow() {
  document.querySelectorAll('.detail-inline-row').forEach(el => el.remove())
}

// ── Row selection visual ──────────────────────────────────────────────

function applyRowSelection(idx) {
  document.querySelectorAll('.variant-row').forEach(row => {
    const i = parseInt(row.dataset.idx, 10)
    const isSelected = (i === idx)
    row.style.background = isSelected ? '#dceefb' : (i % 2 === 0 ? '#f8fafc' : '#fff')
    const rankCell = row.querySelector('.vr-rank')
    if (rankCell) rankCell.style.borderLeft = isSelected ? '4px solid #2471a3' : '4px solid transparent'
  })
}

// ── Core select logic ─────────────────────────────────────────────────

function selectVariant(idx, { scroll = false, toggle = false } = {}) {
  const alreadySelected = _selectedIdx === idx
  _selectedIdx = idx

  applyRowSelection(idx)

  if (toggle && alreadySelected && _detailOpen) {
    // Same row re-clicked: collapse
    removeDetailRow()
    _detailOpen = false
    return
  }

  insertDetailRow(idx)
  _detailOpen = true

  // Notify main to pause continuous generation so the main thread stays responsive
  window.dispatchEvent(new CustomEvent('ag41-detail-opened'))

  if (scroll) {
    const detailRow = document.querySelector('.detail-inline-row')
    detailRow?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
}

// ── Selection restoration helper ──────────────────────────────────────

function _restoreSelection(prevId, wasOpen) {
  const sorted = _sortedVariants()
  let newIdx = 0
  if (prevId) {
    const found = sorted.findIndex(v => v.id === prevId)
    if (found !== -1) newIdx = found
  }
  _selectedIdx = newIdx
  _detailOpen  = false

  applyRowSelection(newIdx)

  if (wasOpen) {
    insertDetailRow(newIdx)
    _detailOpen = true
  }
}

// ── Table-only re-render (keeps weight panel intact) ──────────────────

function _rerenderTable() {
  const prevId  = _variants[_selectedIdx] ? _sortedVariants()[_selectedIdx]?.id : null
  const wasOpen = _detailOpen

  const wrap = document.getElementById('comparison-table-wrap')
  if (wrap) {
    wrap.outerHTML = renderComparisonTable(_sortedVariants(), _weights)
  } else {
    // Fallback: rebuild everything
    const cmp = document.getElementById('layout-comparison')
    if (cmp) {
      cmp.innerHTML = renderWeightsPanel(_weights) + renderComparisonTable(_sortedVariants(), _weights)
    }
  }

  _restoreSelection(prevId, wasOpen)
}

// ── Public render function ────────────────────────────────────────────

/**
 * Render the AG4-1 panel: weights panel + comparison table with inline
 * expandable detail rows.  Preserves the previously selected variant (by ID)
 * and open/closed state across re-renders.
 * @param {Array} variants  Raw result from runAG42() (unsorted)
 */
export function renderLayoutPanel(variants) {
  // Remember state before re-render
  const prevId  = _sortedVariants()[_selectedIdx]?.id
  const wasOpen = _detailOpen

  _variants = variants

  const cmp = document.getElementById('layout-comparison')
  if (!cmp) return

  cmp.innerHTML = renderWeightsPanel(_weights) + renderComparisonTable(_sortedVariants(), _weights)

  _restoreSelection(prevId, wasOpen)

  // Update badge + controls
  const badge = document.getElementById('ag41-badge')
  if (badge) badge.textContent = '最优方案推荐'
  document.getElementById('card-ag41-wrap').hidden = false
  const moreBtn = document.getElementById('btn-ag41-more')
  if (moreBtn) moreBtn.hidden = false
  const resetBtn = document.getElementById('btn-ag41-reset')
  if (resetBtn) resetBtn.hidden = false

  showAg41Notify('已生成初始方案。可点击"生成方案"持续优化。', true)
}

// ── Global handlers ───────────────────────────────────────────────────

/** Row click: toggle detail (same row collapses, different row switches). */
window._ag41SelectVariant = (idx) => selectVariant(idx, { toggle: true })

window._ag41ConfirmVariant = function(idx) {
  _selectedIdx = idx
  const sorted = _sortedVariants()
  window.dispatchEvent(new CustomEvent('ag41-layout-confirmed', {
    detail: { variant: sorted[idx] },
  }))
}

/** Called by weight input onchange. */
window._ag41UpdateWeight = function(key, value) {
  _weights[key] = isNaN(value) ? 1 : Math.max(0, value)
  saveWeights(_weights)
  _rerenderTable()
}

/** Called by reset button. */
window._ag41ResetWeights = function() {
  _weights = { ...DEFAULT_WEIGHTS }
  saveWeights(_weights)

  const cmp = document.getElementById('layout-comparison')
  if (!cmp) return
  const prevId  = _sortedVariants()[_selectedIdx]?.id
  const wasOpen = _detailOpen

  cmp.innerHTML = renderWeightsPanel(_weights) + renderComparisonTable(_sortedVariants(), _weights)
  _restoreSelection(prevId, wasOpen)
}

export function getSelectedVariant() {
  return _sortedVariants()[_selectedIdx] || null
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
