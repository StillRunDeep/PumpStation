import { renderLayoutSVG, renderLayoutSVGDual } from '../render/layout-svg.js'
import { renderDebugGrid } from '../render/svg-helpers.js'
import {
  SCORER_PARAMS, DEFAULT_SCORER_PARAMS, PARAM_LABELS, PARAM_GROUPS, PARAM_STEPS,
  saveScorerParams,
} from '../layout/evaluation/scorer-params.js'
import { scoreLayout } from '../layout/evaluation/scorer.js'
import { rescoreVariants } from '../agents/layout-eval.js'
import { ROOM_DEFS } from '../layout/model/room-defs.js'
import { sendToRevit } from '../layout/export/revit-exporter.js'

// Module-level state
let _variants = []
let _eliminatedVariants = []
let _expandedIds = new Set()   // Set of variant IDs currently expanded
let _showDrawingInList = true; // Our new state variable
const VW = 1080, VH = 560
const COL_COUNT = 8

// ── Sorted variants ───────────────────────────────────────────────────

function _sortedVariants() {
  return [..._variants].sort((a, b) => b.score - a.score)
}

// ── Scorer params panel ───────────────────────────────────────────────

export function renderScorerParamsPanel(params) {
  const renderGroup = group => {
    const inputs = group.keys.map(k => {
      const step = PARAM_STEPS[k] ?? 1;
      return `
        <td style="padding:2px 6px;white-space:nowrap;vertical-align:top">
          <label style="font-size:10px;color:#666;display:block;margin-bottom:1px">${PARAM_LABELS[k]}</label>
          <input type="number" data-pkey="${k}"
                 value="${params[k]}"
                 step="${step}" min="0"
                 style="width:58px;font-size:12px;padding:1px 4px;border:1px solid #bdc3c7;
                        border-radius:3px;text-align:right"
                 onchange="window._ag41UpdateParam('${k}', +this.value)">
        </td>`;
    });
    return `
      <tr>
        <td style="padding:2px 6px;white-space:nowrap;vertical-align:middle;font-size:10px;font-weight:700;color:#1a3a5c;min-width:60px">${group.label}</td>
        ${inputs.join('')}
      </tr>`;
  }

  const renderPenaltyInputs = (group) => {
    return group.keys.map(k => {
      const step = PARAM_STEPS[k] ?? 1;
      return `
        <div style="margin-bottom: 8px;">
          <label style="font-size:10px;color:#666;display:block;margin-bottom:1px">${PARAM_LABELS[k]}</label>
          <input type="number" data-pkey="${k}"
                 value="${params[k]}"
                 step="${step}" min="0"
                 style="width:80px;font-size:12px;padding:1px 4px;border:1px solid #bdc3c7;
                        border-radius:3px;text-align:right"
                 onchange="window._ag41UpdateParam('${k}', +this.value)">
        </div>`;
    }).join('');
  }

  const penaltyGroup = PARAM_GROUPS.find(g => g.label === '违反惩罚');
  const otherGroups = PARAM_GROUPS.filter(g => g.label !== '违反惩罚');
  const mid = Math.ceil(otherGroups.length / 2);
  const col1 = otherGroups.slice(0, mid).map(renderGroup).join('');
  const col2 = otherGroups.slice(mid).map(renderGroup).join('');
  const penaltyInputs = penaltyGroup ? renderPenaltyInputs(penaltyGroup) : '';

  return `
    <div id="scorer-params-panel" style="background:#f0f4f8;border:1px solid #d5dde5;
         border-radius:4px;padding:8px 12px;margin-bottom:8px">
      <div style="display:flex;align-items:center;margin-bottom:6px">
        <span style="font-size:12px;font-weight:600;color:#1a3a5c">评分参数</span>
        <span style="font-size:11px;color:#888;margin-left:8px">修改后立即重新评分并重排名，自动缓存</span>
        <button onclick="window._ag41ResetParams()"
                style="margin-left:auto;font-size:11px;padding:3px 10px;
                       background:#fff;border:1px solid #bdc3c7;border-radius:3px;
                       cursor:pointer;color:#555">重置参数</button>
      </div>
      <div style="display:flex;gap:16px;align-items:flex-start">
        <table style="border-collapse:collapse;flex:1">${col1}</table>
        <div style="width:1px;background:#c8d6e5;align-self:stretch"></div>
        <table style="border-collapse:collapse;flex:1">${col2}</table>
      </div>
      <div style="border-top: 1px solid #c8d6e5; margin: 12px 0;"></div>
      <div>
        <h4 style="font-size:10px;font-weight:700;color:#1a3a5c;margin-bottom:8px;">${penaltyGroup.label}</h4>
        <div style="display:flex; flex-wrap:wrap; gap: 12px;">
          ${penaltyInputs}
        </div>
      </div>
    </div>`;
}

// ── Comparison table ──────────────────────────────────────────────────

function renderComparisonTable(variants) {
  const rows = variants.map((v, i) => {
    const mustSat = (v.adjacency?.satisfied || []).filter(a => a.type === 'must').length
    const mustTot = mustSat + (v.adjacency?.violated || []).filter(a => a.type === 'must').length
    const uniqueViolations = (v.violations || []).filter(err => err.constraint !== 'must_adjacent' && err.constraint !== 'ext_access')
    const violCount = uniqueViolations.length
    const violCell = violCount === 0 ? `<span style="color:#27ae60">✓</span>` : `<span style="color:#c0392b">⚠ ${violCount}</span>`
    const daCount = v.breakdown?.doorAccessCount ?? 0
    const daCell = daCount === 0 ? `<span style="color:#27ae60">✓</span>` : `<span style="color:#c0392b;font-weight:700">⚠ ${daCount}</span>`
    const eff  = v.spaceEfficiency != null ? (v.spaceEfficiency * 100).toFixed(1) + '%' : '—'
    const rowBg = i % 2 === 0 ? '#f8fafc' : '#fff'

    const solutionCellContent = _showDrawingInList
      ? `<svg viewBox="0 0 480 180" style="width: 160px; height: 60px; background: #f4f6f8; vertical-align: middle;">
           <g transform="translate(0, 0)">${renderLayoutSVG(v, 'ground', 240, 180, { showDims: false, forList: true })}</g>
           <g transform="translate(240, 0)">${renderLayoutSVG(v, 'level1', 240, 180, { showDims: false, forList: true })}</g>
         </svg>`
      : `<strong>${v.id}</strong><br><span style="font-size:11px;color:#555">${v.label}</span>`;

    return `
      <tr class="variant-row" data-idx="${i}" data-vid="${v.id}"
          style="cursor:pointer;background:${rowBg}"
          onclick="window._ag41SelectVariant(${i})"
          oncontextmenu="window._ag41CollapseAll(event)">
        <td class="vr-rank" style="text-align:center;font-weight:600;">${i + 1}</td>
        <td style="padding:7px 8px;">${solutionCellContent}</td>
        <td style="text-align:right;font-weight:700;color:#1a5276;">${v.score}</td>
        <td style="text-align:right;">${eff}</td>
        <td style="text-align:center;">${mustSat} / ${mustTot}</td>
        <td style="text-align:center;">${daCell}</td>
      </tr>`
  }).join('')

  return `
    <div id="comparison-table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:13px; table-layout: fixed;">
        <colgroup>
          <col style="width: 8%;">
          <col style="width: 32%;">
          <col style="width: 15%;">
          <col style="width: 15%;">
          <col style="width: 15%;">
          <col style="width: 15%;">
        </colgroup>
        <thead>
          <tr style="background:#1a3a5c;color:#fff;font-size:12px">
            <th class="th-tip" data-tip="按综合得分降序排列" style="padding:7px 8px; text-align: center;">排名</th>
            <th class="th-tip" data-tip="方案编号与描述" style="padding:7px 8px;text-align:left;display:flex;align-items:center;justify-content:space-between">
              <span>方案</span>
              <div class="toggle-switch" onclick="window._toggleSolutionView()">
                <span class="${!_showDrawingInList ? 'active' : ''}">名称</span>
                <span class="${_showDrawingInList ? 'active' : ''}">图纸</span>
              </div>
            </th>
            <th class="th-tip" data-tip="三梯队全量评分总分（越高越好）" style="padding:7px 8px;text-align:right">综合得分</th>
            <th class="th-tip" data-tip="功能房间面积/楼层面积（Phase 1快照）" style="padding:7px 8px;text-align:right">空间效率</th>
            <th class="th-tip" data-tip="强邻近要求满足度 (Phase 1快照)" style="padding:7px 8px; text-align: center;">强邻近</th>
            <th class="th-tip" data-tip="未满足的可达性/门禁要求（Phase 1快照）" style="padding:7px 8px; text-align: center;">可达性/出口</th>
          </tr>
        </thead>
        <tbody id="variant-tbody">
          ${rows}
        </tbody>
      </table>
    </div>`
}

// ── Eliminated variants section (debug) ──────────────────────────────

let _selectedElimIdx = -1

function _renderEliminatedSection() {
  const container = document.getElementById('eliminated-section')
  if (!container) return

  const show = window.debugModeEnabled && _eliminatedVariants.length > 0
  if (!show) { container.innerHTML = ''; _selectedElimIdx = -1; return }

  const rows = _eliminatedVariants.map((v, i) => {
    const mustSat = 0
    const mustTot = 0
    const daCount = v.breakdown?.doorAccessCount ?? 0
    const daCell = daCount === 0
      ? `<span style="color:#27ae60">✓</span>`
      : `<span style="color:#c0392b;font-weight:700">⚠ ${daCount}</span>`
    const eff = v.spaceEfficiency != null ? (v.spaceEfficiency * 100).toFixed(1) + '%' : '—'
    const isSelected = i === _selectedElimIdx
    const rowBg = isSelected ? '#e8f4f8' : (i % 2 === 0 ? '#f8fafc' : '#fff')
    const borderLeft = isSelected ? 'border-left:4px solid #5d6d7e' : 'border-left:4px solid transparent'
    return `
      <tr class="elim-row" data-elim-idx="${i}"
          style="cursor:pointer;background:${rowBg};${borderLeft}"
          onclick="window._ag41SelectEliminated(${i})">
        <td style="text-align:center;font-weight:600;padding:6px 8px;color:#888">${i + 10}</td>
        <td style="padding:6px 8px"><strong style="color:#888">${v.id}</strong><br>
          <span style="font-size:11px;color:#aaa">${v.label}</span></td>
        <td style="text-align:right;font-weight:700;color:#888;padding:6px 8px">${v.score}</td>
        <td style="text-align:right;padding:6px 8px;color:#888">${eff}</td>
        <td style="text-align:center;padding:6px 8px;color:#888">${mustSat} / ${mustTot}</td>
        <td style="text-align:center;padding:6px 8px">${daCell}</td>
      </tr>`
  }).join('')

  container.innerHTML = `
    <div style="margin-top:8px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#5d6d7e;color:#fff;font-size:12px">
            <th style="padding:6px 8px">排名</th>
            <th style="padding:6px 8px;text-align:left">淘汰方案（调试）</th>
            <th style="padding:6px 8px;text-align:right">综合得分</th>
            <th style="padding:6px 8px;text-align:right">空间效率</th>
            <th style="padding:6px 8px">强邻近</th>
            <th style="padding:6px 8px">可达性</th>
          </tr>
        </thead>
        <tbody id="elim-tbody">${rows}</tbody>
      </table>
    </div>`
}

function insertEliminatedDetailRow(idx) {
  removeDetailRow()

  const v = _eliminatedVariants[idx]
  if (!v) return

  _revitVariant = v

  const breakdownHtml = buildBreakdownHtml(v)
  const title = `方案 ${v.id}：${v.label}  —  得分 ${v.score}`

  const detailedDisabled = !v._debug?.ground?.gridBeforeGaps && !v._debug?.level1?.gridBeforeGaps
  const renderFloorRow = (floor) => {
    const debugData = v._debug?.[floor] ?? {}
    const movementHints = window.debugModeEnabled ? (v._debug?.[floor]?.movementHints ?? null) : null
    const finalView = `<svg viewBox="0 0 240 180" style="background:#f4f6f8">${renderLayoutSVG(v, floor, 240, 180, { showDims: false })}</svg>`
    const stage3 = detailedDisabled ? '<span class="pending-text">尚未执行</span>'
      : (debugData.gridAfterGaps ? renderDebugGrid({ grid: debugData.gridAfterGaps, seeds: debugData.seeds, movementHints }, 200, 150) : '无数据')
    const stage2 = detailedDisabled ? '<span class="pending-text">尚未执行</span>'
      : (debugData.gridBeforeGaps ? renderDebugGrid({ grid: debugData.gridBeforeGaps, seeds: debugData.seeds, movementHints }, 200, 150) : '无数据')
    const stage1 = debugData.gridAfterRect ? renderDebugGrid({ grid: debugData.gridAfterRect, seeds: debugData.seeds, movementHints }, 200, 150) : '无数据'
    return `
      <div class="grid-cell final-view">${finalView}</div>
      <div class="grid-cell debug-view">${stage3}</div>
      <div class="grid-cell debug-view">${stage2}</div>
      <div class="grid-cell debug-view">${stage1}</div>`
  }

  const headers = `
    <div class="grid-header">正式视图 ${_revitButtonHtml()}</div>
    <div class="grid-header">阶段3 (FillGaps)</div>
    <div class="grid-header">阶段2 (L/U形生长)</div>
    <div class="grid-header">阶段1 (矩形生长)</div>`

  const detailHtml = `
    <tr class="detail-inline-row" style="background:#f0f7ff">
      <td colspan="6" style="padding:0;border-top:2px solid #5d6d7e;border-bottom:2px solid #5d6d7e">
        <div style="width:100%">
          <div style="overflow-x:auto;border-bottom:1px solid #ccc;padding-bottom:8px;margin-bottom:8px">
            <div id="detail-grid-container" style="display:grid;grid-template-columns:repeat(4,25%);grid-template-rows:auto repeat(2,150px);gap:1px;background-color:#aed6f1;padding:1px;box-sizing:border-box">
              ${headers}
              ${renderFloorRow('ground')}
              ${renderFloorRow('level1')}
            </div>
          </div>
          <div id="breakdown-container" style="padding:12px;box-sizing:border-box;background:#fafbfc">
            ${breakdownHtml}
          </div>
        </div>
        <style>
          .grid-cell { background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative; }
          .grid-header { font-size:11px;font-weight:600;color:#1a3a5c;background:#eaf2f8;text-align:center;padding:4px; }
          .grid-cell.final-view { background:#f4f6f8; }
          .grid-cell.debug-view svg { width:100%;height:100%; }
          .skipped-text { font-size:11px;color:#95a5a6;font-style:italic; }
          .pending-text { font-size:11px;color:#b0b0b0;font-style:italic; }
        </style>
      </td>
    </tr>`

  const tbody = document.getElementById('elim-tbody')
  if (!tbody) return
  const targetRow = tbody.querySelector(`.elim-row[data-elim-idx="${idx}"]`)
  if (targetRow) {
    targetRow.insertAdjacentHTML('afterend', detailHtml)
  } else {
    tbody.insertAdjacentHTML('beforeend', detailHtml)
  }
}

// ── Inline detail row ─────────────────────────────────────────────────

function buildBreakdownHtml(v) {
  const bd = v.breakdown || {}
  const bdSign = x => x >= 0 ? `+${x}` : `${x}`
  const posColor = '#27ae60'
  const negColor = '#c0392b'
  const color = x => x >= 0 ? posColor : negColor

  const getLabel = id => ROOM_DEFS[id]?.label || id;
  const fmtDetails = details => {
    if (!details || details.length === 0) return '';

    // Group violations by room ID to handle multiple violations per room
    const groupedDetails = details.reduce((acc, detail) => {
      const id = detail.id || 'unknown';
      if (!acc[id]) {
        acc[id] = {
          label: getLabel(id),
          sources: new Set(),
          debug: ''
        };
      }
      if (detail.source) {
        // For aspectRatio, sources might be a comma-separated string
        if (typeof detail.source === 'string') {
          detail.source.split(',').forEach(s => acc[id].sources.add(s));
        } else {
           acc[id].sources.add(detail.source);
        }
      } else if (detail.sources) { // Handle AspectRatioPenalty format
        detail.sources.split(',').forEach(s => acc[id].sources.add(s));
      }
      if (detail.debug) {
        // HACK: Format the complex debug object into a string for display
        if (typeof detail.debug === 'object' && detail.debug.sequences) {
          const seqs = detail.debug.sequences.map(s => `[${s.join('↔')}]`).join(', ');
          const reason = detail.debug.failureReason ? ` (${detail.debug.failureReason})` : '';
          acc[id].debug = `接触区域: ${seqs}${reason}`;
        } else {
          acc[id].debug = detail.debug;
        }
      }
      return acc;
    }, {});

    const detailsHtml = Object.values(groupedDetails).map(item => {
      const roomName = item.label;
      const sources = Array.from(item.sources);
      const sourceStr = sources.length > 0
        ? ` <span style="color:#c0392b">[${sources.join(', ')}]</span>`
        : '';
      const debugStr = item.debug
        ? ` <span style="color:#e67e22;font-style:italic">(${item.debug})</span>`
        : '';
      return `${roomName}${sourceStr}${debugStr}`;
    }).join(', ');

    return `<div style="font-size:10px;color:#999;font-weight:normal;line-height:1.2;margin-top:2px">${detailsHtml}</div>`;
  };

  // Ordered according to PARAM_GROUPS in scorer-params.js
  const items = [
    { label: '基础分',    val: bd.base ?? 10000, always: true },
    { label: '占地面积',  val: bd.footprint ?? 0 },
    { label: '变压器布置',val: bd.trafo ?? 0 },
    { label: '风机房距离',val: bd.fanRoom ?? 0 },
    {
      label: '临近关系' + (bd.adjMustCount || bd.adjShouldCount ? ` <small style="color:#999;font-weight:normal">(M:${bd.adjMustCount || 0}, S:${bd.adjShouldCount || 0})</small>` : ''),
      val: bd.adjacency ?? 0
    },
    { label: '走廊完整',  val: bd.corridor ?? 0 },
    { label: '空间效率',val: bd.efficiency ?? 0 },
    { label: '便捷性',   val: bd.accessibility ?? 0 },
    {
      label: '约束违反' + (bd.violationCount ? ` <small style="color:#999;font-weight:normal">(${bd.violationCount}项)</small>` : '') + fmtDetails(bd.violationDetails),
      val: bd.violations ?? 0
    },
    {
      label: '可达性违反' + (bd.doorAccessCount ? ` <small style="color:#999;font-weight:normal">(${bd.doorAccessCount}处)</small>` : '') + fmtDetails(bd.doorAccessDetails),
      val: bd.doorAccess ?? 0
    },
    {
      label: '房间缺失' + (bd.missingRoomCount ? ` <small style="color:#999;font-weight:normal">(${bd.missingRoomCount}间)</small>` : '') + fmtDetails(bd.missingRoomDetails),
      val: bd.missingRooms ?? 0
    },
    {
      label: '长宽比惩罚' + (bd.aspectRatioCount ? ` <small style="color:#999;font-weight:normal">(${bd.aspectRatioCount}项)</small>` : '') + fmtDetails(bd.aspectRatioDetails),
      val: bd.aspectRatio ?? 0
    },
  ]

  const activeItems = items.filter(item => item.always || item.val !== 0)
  const rows = []

  for (let i = 0; i < activeItems.length; i += 2) {
    const it1 = activeItems[i]
    const it2 = activeItems[i + 1]
    rows.push(`
      <tr>
        <td style="padding:2px 8px;color:#777;width:25%">${it1.label}</td>
        <td style="padding:2px 8px;text-align:right;font-weight:600;color:${color(it1.val)};width:25%;border-right:1px solid #eee">${bdSign(it1.val)}</td>
        ${it2 ? `
          <td style="padding:2px 8px;color:#777;width:25%;padding-left:15px">${it2.label}</td>
          <td style="padding:2px 8px;text-align:right;font-weight:600;color:${color(it2.val)};width:25%">${bdSign(it2.val)}</td>
        ` : '<td colspan="2"></td>'}
      </tr>
    `)
  }

  return `
    <h4 style="margin:0 0 8px;font-size:12px;color:#555">得分明细</h4>
    <table style="border-collapse:collapse;width:100%;font-size:11px;background:#fff;border:1px solid #eee">
      ${rows.join('')}
      <tr style="background:#f8f9f9;border-top:1px solid #ddd">
        <td colspan="3" style="padding:4px 8px;font-weight:700;color:#1a3a5c;text-align:right">合计总分</td>
        <td style="padding:4px 8px;text-align:right;font-weight:700;font-size:13px;color:#1a5276">${v.score}</td>
      </tr>
    </table>`
}

// ── Revit message builder ─────────────────────────────────────────────

let _revitVariant = null  // the variant whose detail row is currently open

function _revitButtonHtml() {
  return `<button onclick="window._ag41GenerateRevit()"
    style="margin-left:8px;padding:2px 8px;font-size:10px;font-weight:600;
           background:#1a5276;color:#fff;border:none;border-radius:3px;cursor:pointer;
           vertical-align:middle"
    title="发送 create-pump-room 消息到 Revit Host">生成 Revit 模型</button>`
}

// Build the inner HTML for a detail row. debugVariant may differ from v when
// showing a candidate (failed optimization) without replacing the stored variant.
function _buildDetailInnerHtml(v, message = null, debugVariant = null) {
  const dv = debugVariant || v
  const detailedDisabled = !dv._debug?.ground?.gridBeforeGaps && !dv._debug?.level1?.gridBeforeGaps
  const renderFloorRow = (floor) => {
    const debugData = dv._debug?.[floor] ?? {}
    const seedsMeta = dv._debug?.[floor]?.seedsMeta ?? null
    const movementHints = dv._debug?.[floor]?.movementHints ?? null
    const finalView = `<svg viewBox="0 0 240 180" style="background:#f4f6f8">${renderLayoutSVG(v, floor, 240, 180, { showDims: false })}</svg>`
    const stage3 = detailedDisabled ? '<span class="pending-text">尚未执行</span>'
      : (debugData.gridAfterGaps ? renderDebugGrid({ grid: debugData.gridAfterGaps, seeds: debugData.seeds, seedsMeta, movementHints }, 200, 150) : '无数据')
    const stage2 = detailedDisabled ? '<span class="pending-text">尚未执行</span>'
      : (debugData.gridBeforeGaps ? renderDebugGrid({ grid: debugData.gridBeforeGaps, seeds: debugData.seeds, seedsMeta, movementHints }, 200, 150) : '无数据')
    const stage1 = debugData.gridAfterRect ? renderDebugGrid({ grid: debugData.gridAfterRect, seeds: debugData.seeds, seedsMeta, movementHints }, 200, 150) : '无数据'
    return `
      <div class="grid-cell final-view">${finalView}</div>
      <div class="grid-cell debug-view">${stage3}</div>
      <div class="grid-cell debug-view">${stage2}</div>
      <div class="grid-cell debug-view">${stage1}</div>`
  }

  const headers = `
    <div class="grid-header">正式视图 ${_revitButtonHtml()}</div>
    <div class="grid-header">阶段3 (FillGaps)</div>
    <div class="grid-header">阶段2 (L/U形生长)</div>
    <div class="grid-header">阶段1 (矩形生长)</div>`

  const bannerHtml = message
    ? `<div class="detail-msg-banner ${message.isWarning ? 'banner-warn' : 'banner-ok'}">${message.text}</div>`
    : ''

  return `
    ${bannerHtml}
    <div style="overflow-x:auto;border-bottom:1px solid #ccc;padding-bottom:8px;margin-bottom:8px">
      <div style="display:grid;grid-template-columns:repeat(4,25%);grid-template-rows:auto repeat(2,150px);gap:1px;background-color:#aed6f1;padding:1px;box-sizing:border-box">
        ${headers}
        ${renderFloorRow('ground')}
        ${renderFloorRow('level1')}
      </div>
    </div>
    <div style="padding:12px;box-sizing:border-box;background:#fafbfc">
      ${buildBreakdownHtml(v)}
    </div>`
}

function insertDetailRow(idx) {
  const sorted = _sortedVariants()
  const v = sorted[idx]
  if (!v) return
  if (_expandedIds.has(v.id)) return   // already open

  _revitVariant = v
  _expandedIds.add(v.id)

  const detailHtml = `
    <tr class="detail-inline-row" data-detail-vid="${v.id}" style="background:#f0f7ff">
      <td colspan="${COL_COUNT}" style="padding:0;border-top:2px solid #2471a3;border-bottom:2px solid #2471a3">
        <div style="width:100%;padding:0 0 4px">
          ${_buildDetailInnerHtml(v)}
        </div>
        <style>
          .grid-cell{background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative}
          .grid-header{font-size:11px;font-weight:600;color:#1a3a5c;background:#eaf2f8;text-align:center;padding:4px}
          .grid-cell.final-view{background:#f4f6f8}
          .grid-cell.debug-view svg{width:100%;height:100%}
          .skipped-text{font-size:11px;color:#95a5a6;font-style:italic}
          .detail-msg-banner{padding:6px 12px;font-size:12px;font-weight:600;border-bottom:1px solid #ccc}
          .banner-warn{background:#fff3cd;color:#856404}
          .banner-ok{background:#d4edda;color:#155724}
        </style>
      </td>
    </tr>`

  const tbody = document.getElementById('variant-tbody')
  if (!tbody) return
  const targetRow = tbody.querySelector(`.variant-row[data-idx="${idx}"]`)
  if (targetRow) {
    targetRow.insertAdjacentHTML('afterend', detailHtml)
  } else {
    tbody.insertAdjacentHTML('beforeend', detailHtml)
  }
  _syncButtonStates()
}

// Remove specific variant's detail row (by vid), or all main-variant detail rows (no arg).
function removeDetailRow(vid = null) {
  if (vid === null) {
    document.querySelectorAll('.detail-inline-row[data-detail-vid]').forEach(el => el.remove())
    _expandedIds.clear()
  } else {
    document.querySelector(`.detail-inline-row[data-detail-vid="${vid}"]`)?.remove()
    _expandedIds.delete(vid)
  }
  _syncButtonStates()
}

// Re-render an open detail row in place with optional override display data and message.
export function refreshDetailRow(variantId, displayVariant, message = null) {
  const row = document.querySelector(`.detail-inline-row[data-detail-vid="${variantId}"]`)
  if (!row) return
  const v = _variants.find(x => x.id === variantId) || displayVariant
  const inner = row.querySelector('div')
  if (inner) inner.innerHTML = _buildDetailInnerHtml(v, message, displayVariant !== v ? displayVariant : null)
}

// ── Button state sync ─────────────────────────────────────────────────

function _syncButtonStates() {
  const optimizeBtn = document.getElementById('btn-ag41-optimize')
  if (optimizeBtn) optimizeBtn.disabled = _variants.length === 0
  _syncFloatingBar()
}

function collapseAll() {
  removeDetailRow()   // no arg → removes all main-variant detail rows
  applyRowSelection()
}

// ── Row selection visual ──────────────────────────────────────────────

function applyRowSelection() {
  document.querySelectorAll('.variant-row').forEach(row => {
    const vid = row.dataset.vid
    const i = parseInt(row.dataset.idx, 10)
    const isExpanded = _expandedIds.has(vid)
    row.style.background = isExpanded ? '#dceefb' : (i % 2 === 0 ? '#f8fafc' : '#fff')
    const rankCell = row.querySelector('.vr-rank')
    if (rankCell) rankCell.style.borderLeft = isExpanded ? '4px solid #2471a3' : '4px solid transparent'
  })
}

// ── Core select logic ─────────────────────────────────────────────────

function selectVariant(idx, { scroll = false, toggle = false } = {}) {
  // Deselect any eliminated row when selecting from main leaderboard
  if (_selectedElimIdx !== -1) { _selectedElimIdx = -1; _renderEliminatedSection() }

  const sorted = _sortedVariants()
  const v = sorted[idx]
  if (!v) return
  const vid = v.id

  if (toggle && _expandedIds.has(vid)) {
    removeDetailRow(vid)
    applyRowSelection()
    return
  }

  // Clear other expanded variants before selecting this one
  if (toggle) removeDetailRow()

  insertDetailRow(idx)
  applyRowSelection()

  window.dispatchEvent(new CustomEvent('ag41-detail-opened'))

  if (scroll) {
    document.querySelector(`.detail-inline-row[data-detail-vid="${vid}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
}

// ── Selection restoration ─────────────────────────────────────────────

function _restoreSelection(prevExpandedIds) {
  _expandedIds.clear()
  document.querySelectorAll('.detail-inline-row[data-detail-vid]').forEach(el => el.remove())

  const sorted = _sortedVariants()
  prevExpandedIds.forEach(vid => {
    const idx = sorted.findIndex(v => v.id === vid)
    if (idx !== -1) insertDetailRow(idx)
  })

  applyRowSelection()
  _syncButtonStates()
}

// ── Re-score all variants, then re-render table ───────────────────────

function _rescoreAndRerender() {
  const prevExpandedIds = new Set(_expandedIds)
  _variants = rescoreVariants(_variants)

  const wrap = document.getElementById('comparison-table-wrap')
  if (wrap) {
    wrap.outerHTML = renderComparisonTable(_sortedVariants())
  } else {
    const cmp = document.getElementById('layout-comparison')
    if (cmp) cmp.innerHTML = renderComparisonTable(_sortedVariants())
  }

  _restoreSelection(prevExpandedIds)
}

// ── Public render function ────────────────────────────────────────────

/**
 * Render the AG4-1 panel: scorer params panel + comparison table with inline
 * expandable detail rows.  Preserves selected variant (by ID) and open/closed
 * state across re-renders.
 *
 * @param {Array} variants   Scored variants from runAG42()
 * @param {Array} eliminated Variants ranked 10–18, shown in debug mode
 */
export function renderLayoutPanel(variants, eliminated = []) {
  const prevExpandedIds = new Set(_expandedIds)

  _variants = variants
  _eliminatedVariants = eliminated

  const cmp = document.getElementById('layout-comparison')
  if (!cmp) return

  cmp.innerHTML = renderComparisonTable(_sortedVariants())

  // Ensure the eliminated section container exists right after the comparison table
  let elimSection = document.getElementById('eliminated-section')
  if (!elimSection) {
    elimSection = document.createElement('div')
    elimSection.id = 'eliminated-section'
    cmp.parentNode.insertBefore(elimSection, cmp.nextSibling)
  }
  _renderEliminatedSection()

  _restoreSelection(prevExpandedIds)

  // Update badge + controls
  const badge = document.getElementById('ag41-badge')
  if (badge) badge.style.display = 'none'
  document.getElementById('card-ag41-wrap').hidden = false
  ;['btn-ag41-more','btn-ag41-optimize','btn-ag41-reset'].forEach(id => {
    const btn = document.getElementById(id)
    if (btn) btn.hidden = false
  })

  _initFloatingBar()
  showAg41Notify('已生成初始方案。可点击"生成方案"持续优化。', true)
}

function _toggleSolutionView() {
  _showDrawingInList = !_showDrawingInList;
  _rescoreAndRerender();
}
window._toggleSolutionView = _toggleSolutionView;

// ── Global handlers ───────────────────────────────────────────────────

window._ag41SelectVariant = (idx) => selectVariant(idx, { toggle: true })

window._ag41SelectEliminated = (idx) => {
  const alreadySelected = _selectedElimIdx === idx
  _selectedElimIdx = alreadySelected ? -1 : idx
  _renderEliminatedSection()
  if (!alreadySelected) {
    insertEliminatedDetailRow(idx)
    document.querySelector(`#elim-tbody .elim-row[data-elim-idx="${idx}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  } else {
    removeDetailRow()
  }
}

window._ag41GenerateRevit = () => {
  sendToRevit(_revitVariant, showAg41Notify)
}

window._ag41CollapseAll = function(event) {
  if (event) event.preventDefault()
  collapseAll()
}

window._ag41ConfirmVariant = function(idx) {
  const sorted = _sortedVariants()
  window.dispatchEvent(new CustomEvent('ag41-layout-confirmed', {
    detail: { variant: sorted[idx] },
  }))
}

/** Called when a param input changes. Mutates SCORER_PARAMS, saves, rescores. */
window._ag41UpdateParam = function(key, value) {
  if (key in DEFAULT_SCORER_PARAMS) {
    SCORER_PARAMS[key] = isNaN(value) ? DEFAULT_SCORER_PARAMS[key] : Math.max(0, +value)
    saveScorerParams(SCORER_PARAMS)
    _rescoreAndRerender()
  }
}

/** Reset all params to defaults, save, rebuild full panel. */
window._ag41ResetParams = function() {
  Object.keys(SCORER_PARAMS).forEach(key => delete SCORER_PARAMS[key])
  Object.assign(SCORER_PARAMS, DEFAULT_SCORER_PARAMS)
  saveScorerParams(SCORER_PARAMS)

  const modalWrap = document.getElementById('modal-scorer-wrap')
  if (modalWrap) modalWrap.innerHTML = renderScorerParamsPanel(SCORER_PARAMS)

  const cmp = document.getElementById('layout-comparison')
  if (!cmp) return
  const prevExpandedIds = new Set(_expandedIds)

  _variants = rescoreVariants(_variants)

  cmp.innerHTML = renderComparisonTable(_sortedVariants())
  _restoreSelection(prevExpandedIds)
}

export function getSelectedVariant() {
  const sorted = _sortedVariants()
  return sorted.find(v => _expandedIds.has(v.id)) || null
}

export function getExpandedVariants() {
  const sorted = _sortedVariants()
  return sorted.filter(v => _expandedIds.has(v.id))
}

export function replaceVariant(oldId, newVariant) {
  const idx = _variants.findIndex(v => v.id === oldId)
  if (idx === -1) return
  _variants[idx] = newVariant
  const prevExpandedIds = new Set(_expandedIds)
  const cmp = document.getElementById('layout-comparison')
  if (cmp) cmp.innerHTML = renderComparisonTable(_sortedVariants())
  _restoreSelection(prevExpandedIds)
}

export function getVariants() {
  return _variants
}

export function showAg41Notify(msg, isImproved) {
  const el = document.getElementById('ag41-notify')
  if (!el) return
  el.textContent = msg
  
  const isDebug = window.debugModeEnabled
  const wrap = el.closest('.notify-bar-wrap')
  
  if (isDebug) {
    el.className = 'header-notify notify-debug'
    if (wrap) wrap.classList.add('notify-debug')
  } else {
    el.className = 'header-notify ' + (isImproved ? 'notify-ok' : 'notify-warn')
    if (wrap) wrap.classList.remove('notify-debug')
  }
}

export function rescoreAndRerender() {
  _rescoreAndRerender();
}

// ── Floating action bar ───────────────────────────────────────────────

const FLOAT_BUTTON_IDS = ['btn-ag41-more','btn-ag41-optimize','btn-ag41-reset']
let _floatBarObserver = null

function _syncFloatingBar() {
  const bar = document.getElementById('ag41-floating-bar')
  if (!bar || bar.style.display === 'none') return
  bar.innerHTML = FLOAT_BUTTON_IDS.map(id => {
    const real = document.getElementById(id)
    if (!real || real.hidden) return ''
    return `<button class="float-btn" ${real.disabled ? 'disabled' : ''}
      onclick="document.getElementById('${id}').click()">${real.textContent}</button>`
  }).join('')
}

function _initFloatingBar() {
  if (_floatBarObserver) return
  const sentinel = document.querySelector('#card-ag41-wrap summary.card-header')
  const bar = document.getElementById('ag41-floating-bar')
  if (!sentinel || !bar) return

  _floatBarObserver = new IntersectionObserver(([entry]) => {
    bar.style.display = entry.isIntersecting || entry.boundingClientRect.y >= 0 ? 'none' : 'flex'
    if (!entry.isIntersecting) _syncFloatingBar()
  }, { threshold: 0 })
  _floatBarObserver.observe(sentinel)

  // Auto-sync whenever real buttons change text or disabled state
  const headerBtns = document.querySelector('.card-header-buttons')
  if (headerBtns) {
    new MutationObserver(() => _syncFloatingBar()).observe(headerBtns, {
      subtree: true, attributes: true, characterData: true,
      attributeFilter: ['disabled', 'hidden'],
    })
  }
}
