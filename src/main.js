import './style.css'

import { runUserParams } from './agents/user-params.js'
import { runTopology } from './agents/topology.js'
import { runPoolDepth } from './agents/pool-depth.js'
import { runMaintenanceRoom } from './agents/maintenance-room.js'
import { runPumpSpec } from './agents/pump-spec.js'
import { runPipeSizing } from './agents/pipe-sizing.js'
import { runDrawing } from './agents/drawing.js'
import { runAG41 } from './agents/ag41-building-layout.js'
import { runAG42, mergeVariants } from './agents/ag42-layout-eval.js'
import { renderAG00, renderAG01, renderPoolDepth, renderPipeSizing, renderMaintenanceRoom, renderPumpSpec } from './ui/results-panel.js'
import { renderLayoutPanel, getVariants, showAg41Notify } from './ui/layout-panel.js'
import { renderBuildingParamsPanel } from './ui/building-params-panel.js'
import { getDefaultUserParams } from './layout/user-params.js'
import { initTopologyEditor, setTopologyFromN, getCurrentTopology } from './ui/topology-editor.js'

let _lastTopoN     = null
let _lastTopoSpare = 0

// ── AG4-1 parameter helpers ───────────────────────────────────────────


/**
 * Auto-fill the repair_zone area hint from AG1-2 output.
 * The repair zone should be at least L × W from the maintenance-room calc.
 */
function updateRepairZoneHint(ag21) {
  const noteEl = document.getElementById('ra-repair-note')
  const inputEl = document.getElementById('ra-repair')
  if (!noteEl || !inputEl) return

  const area = Math.ceil(ag21.L * ag21.W)  // m²
  noteEl.innerHTML =
    `继承自 AG2-1：维护间净长 <strong>${ag21.L.toFixed(1)} m</strong> × ` +
    `净宽 <strong>${ag21.W.toFixed(1)} m</strong> ≈ <strong>${area} m²</strong>。` +
    `当前输入值为用户指定值；留空则使用比例算法默认值。`

  // Only auto-fill if the user hasn't entered a value
  if (!inputEl.value) {
    inputEl.placeholder = `≈ ${area}（AG2-1）`
  }
}

// ── Main calculation controller ───────────────────────────────────────

async function runCalculation() {
  // ── AG0-0: 参数解析与计算 ────────────────────────────────────
  const ag00Params = {
    // 直接输入模式参数
    Q_total:    parseFloat(document.getElementById('inp-Q-total').value),
    N:          parseInt(document.getElementById('inp-N').value, 10),
    N_spare:    parseInt(document.getElementById('inp-N-spare').value, 10) || 0,
    Z:          parseInt(document.getElementById('inp-Z').value, 10) || 8,
    V_design:   parseFloat(document.getElementById('inp-V-design').value),
    Z_bottom:   parseFloat(document.getElementById('inp-z-bottom').value),
    Z_sump:     parseFloat(document.getElementById('inp-Z-sump').value),
    D:          parseFloat(document.getElementById('inp-D').value),
    Z_discharge: parseFloat(document.getElementById('inp-z-discharge').value),
    // 暴雨分析模式参数（当Q_total为空时使用）
    zone:       document.getElementById('inp-zone').value,
    T:          parseInt(document.getElementById('inp-T').value, 10),
    t_d:        parseFloat(document.getElementById('inp-td').value),
    A:          parseFloat(document.getElementById('inp-A').value),
    C:          parseFloat(document.getElementById('inp-C').value),
    delta_i:    parseFloat(document.getElementById('inp-delta-i').value) || 0,
    H:          parseFloat(document.getElementById('inp-H').value) || 1.0,
    L:          parseFloat(document.getElementById('inp-L').value) || 500,
  }

  const ag00 = runUserParams(ag00Params)
  document.getElementById('card-ag00').innerHTML = renderAG00(ag00)

  const panel = document.getElementById('results-panel')
  panel.hidden = false

  // AG0-1: 若 N 或 N_spare 变化则重置默认拓扑
  const N_spare = parseInt(document.getElementById('inp-N-spare').value, 10) || 0
  if (ag00Params.N !== _lastTopoN || N_spare !== _lastTopoSpare) {
    setTopologyFromN(ag00Params.N, N_spare)
    _lastTopoN     = ag00Params.N
    _lastTopoSpare = N_spare
  }

  // AG0-1: 拓扑解析
  const ag01 = runTopology(getCurrentTopology())
  document.getElementById('card-ag01').innerHTML = renderAG01(ag01)

  if (!ag00.valid) {
    ;['card-ag11', 'card-ag12', 'card-ag13', 'card-ag21'].forEach(id => {
      document.getElementById(id).innerHTML =
        '<p style="color:#999;padding:8px">参数验证未通过，无法计算。</p>'
    })
    document.getElementById('card-ag41-wrap').hidden = true
    panel.scrollIntoView({ behavior: 'smooth' })
    return
  }

  // ── AG1-1: 污水池计算 ─────────────────────────────────────────────
  const ag1Params = {
    V_design: ag00.V_design,
    Z_bottom: ag00.Z_bottom,
    D:        ag00.D,
    N:        ag00.N,
    Z:        ag00.Z,
    Q_pump:   ag00.Q_pump,  // 单泵设计流量（m³/s）
    F_b:      parseFloat(document.getElementById('inp-Fb').value) || 0.8,
    F_s:      parseFloat(document.getElementById('inp-Fs').value) || 1.0,
  }
  const ag1Result = runPoolDepth(ag1Params)  // pool-depth.js = AG1-1 调蓄池计算
  document.getElementById('card-ag11').innerHTML = renderPoolDepth(ag1Result)

  // ── AG1-2: 水泵计算及选型 ───────────────────────────────────────────
  const ag2Params = {
    Q_single:    ag00.Q_single,
    Z_stop:      ag1Result.Z_stop,
    Z_discharge: ag00.Z_discharge,
    L:           parseFloat(document.getElementById('inp-pipe-len').value) || 50,
    n:           parseFloat(document.getElementById('inp-n').value) || 0.013,
    η_hyd:       parseFloat(document.getElementById('inp-eta-hyd').value) || 0.82,
    η_mot:       parseFloat(document.getElementById('inp-eta-mot').value) || 0.93,
    NPSH_r:      parseFloat(document.getElementById('inp-npsh-r').value) || 3.0,
  }
  const motorOverride = parseFloat(document.getElementById('inp-motor').value)
  const ag2Result = runPumpSpec(ag2Params, isNaN(motorOverride) ? null : motorOverride)  // AG1-2 水泵选型
  document.getElementById('card-ag12').innerHTML = renderPumpSpec(ag2Result)

  // ── AG1-3: 管道尺寸计算 ─────────────────────────────────────────────
  if (ag2Result.valid !== false) {
    // 总流量Q：在直接输入模式下使用Q_total×3600，否则使用ag00.Q
    const totalFlow = ag00.mode === 'direct'
      ? (ag00.Q_total * 3600)
      : (ag00.Q || ag00.Q_total * 3600)

    const ag13Params = {
      Q_pump:    ag2Result.Q_pump,        // 单泵设计流量（m³/s）
      Q:         totalFlow,                // 泵站总流量（m³/h）
      N:         ag00.N,                  // 工作泵台数
      H_total:   ag2Result.H_total,       // 总扬程（m）
      Z_stop:    ag1Result.Z_stop,        // 停泵水位（mPD）
      H_s:       ag2Result.H_s,           // 淹没深度（m），来自AG1-2
      v_in:      parseFloat(document.getElementById('inp-v-in').value) || 1.0,
      v_out:     parseFloat(document.getElementById('inp-v-out').value) || 1.5,
      n:         parseFloat(document.getElementById('inp-n').value) || 0.013,
      k_local:   0.15,                   // 局部损失系数，工程惯例
      NPSH_r:    parseFloat(document.getElementById('inp-npsh-r').value) || 3.0,
      L:         parseFloat(document.getElementById('inp-pipe-len').value) || 50,
    }
    const ag13Result = runPipeSizing(ag13Params)
    document.getElementById('card-ag13').innerHTML = renderPipeSizing(ag13Result)
  }

  // ── AG2-1: 泵房维护间尺寸计算 ─────────────────────────────────────────
  const effectiveMotor = isNaN(motorOverride) ? ag2Result.P_motor : motorOverride
  const ag21 = runMaintenanceRoom(ag00.N, effectiveMotor, N_spare)
  ag21.DN_label = ag2Result.DN_outlet
  document.getElementById('card-ag21').innerHTML = renderMaintenanceRoom(ag21)

  // ── AG3-1: SVG绘图 ───────────────────────────────────────────────
  // AG3-1 期望从第三个参数解构 h_active, Z_stop, Z_start1, Z_alarm_high
  // 这些全部来自 AG1-1（调蓄池计算），其中 h_active = Z_max - Z_stop
  const ag31Params = {
    h_active:   ag1Result.Z_max - ag1Result.Z_stop,  // 有效水深
    Z_stop:     ag1Result.Z_stop,
    Z_start1:   ag1Result.Z_start1,
    Z_alarm_high: ag1Result.Z_alarm_high,
  }
  runDrawing(ag00.N, ag21, ag31Params, ag1Result.S, ag01.topology)

  // Update repair_zone hint from AG2-1 before reading AG4-1 params
  updateRepairZoneHint(ag21)

  // ── AG4-1/AG4-2: 布局生成与评分 ─────────────────────────────────
  const ag41Variants = await runAG41()
  const ag42Variants = runAG42(ag41Variants)
  renderLayoutPanel(ag42Variants)

  panel.scrollIntoView({ behavior: 'smooth' })
}

// ── Event wiring ──────────────────────────────────────────────────────

// ── 初始化 AG0-1 拓扑编辑器 ──────────────────────────────────────────
const _initN = parseInt(document.getElementById('inp-N').value, 10) || 2
initTopologyEditor('topology-editor-wrap', () => {})
setTopologyFromN(_initN)
_lastTopoN = _initN

function _updateTopo() {
  const N       = parseInt(document.getElementById('inp-N').value, 10)
  const N_spare = parseInt(document.getElementById('inp-N-spare').value, 10) || 0
  if (N >= 1 && N <= 6 && (N !== _lastTopoN || N_spare !== _lastTopoSpare)) {
    setTopologyFromN(N, N_spare)
    _lastTopoN     = N
    _lastTopoSpare = N_spare
  }
}

document.getElementById('inp-N').addEventListener('input', _updateTopo)
document.getElementById('inp-N-spare').addEventListener('input', _updateTopo)

document.getElementById('btn-calc').addEventListener('click', runCalculation)

let isGeneratingLayouts = false;
let generationReqId = null;

document.getElementById('btn-ag41-more').addEventListener('click', () => {
  const btn = document.getElementById('btn-ag41-more');

  if (isGeneratingLayouts) {
    // Stop generation
    isGeneratingLayouts = false;
    if (generationReqId) {
      cancelAnimationFrame(generationReqId);
      generationReqId = null;
    }
    btn.textContent = '生成方案';
    showAg41Notify('已停止持续生成', false);
  } else {
    // Start generation
    isGeneratingLayouts = true;
    btn.textContent = '停止';

    const generationLoop = async () => {
      if (!isGeneratingLayouts) return;

      try {
        const newRaw = await runAG41();
        const { variants, improved, newScored } = mergeVariants(getVariants(), newRaw);
        renderLayoutPanel(variants);

        const maxNewScore = Math.max(...newScored.map(v => v.score));
        const currentTopScore = variants[0]?.score || 0;

        if (improved) {
          showAg41Notify(`发现更优方案，排名已更新！新方案最高分: ${maxNewScore}`, true);
        } else {
          showAg41Notify(`未发现更优方案 (当前最高: ${currentTopScore} / 本轮最高: ${maxNewScore})`, false);
        }
      } catch (error) {
        console.error("Error during layout generation loop:", error);
        showAg41Notify('生成新方案时出错', false);
        // Stop the loop on error
        isGeneratingLayouts = false;
        btn.textContent = '生成方案';
        return;
      }

      // Continue the loop
      if (isGeneratingLayouts) {
        generationReqId = requestAnimationFrame(generationLoop);
      }
    };

    // Kick off the first iteration
    generationReqId = requestAnimationFrame(generationLoop);
  }
});

document.getElementById('btn-ag41-reset').addEventListener('click', async () => {
  const btn = document.getElementById('btn-ag41-reset')
  btn.disabled = true
  btn.textContent = '生成中…'
  try {
    const newRaw = await runAG41()
    const variants = runAG42(newRaw)
    renderLayoutPanel(variants)
    showAg41Notify('已重新生成 9 个方案', true)
  } finally {
    btn.disabled = false
    btn.textContent = '重制方案'
  }
})

// ── 建筑参数面板设置 ──
const btnParams = document.getElementById('btn-ag41-params')
const cardAg41Wrap = document.getElementById('card-ag41-wrap')
const modal = document.getElementById('modal-build-params')
const closeBtn = document.querySelector('#modal-build-params .modal-close')
const okBtn = document.getElementById('modal-build-params-ok')
const cancelBtn = document.getElementById('modal-build-params-cancel')
const modalOverlay = document.querySelector('#modal-build-params .modal-overlay')
const modalWrap = document.querySelector('#modal-build-params .modal-content')

btnParams.addEventListener('click', () => {
  const defaultParams = getDefaultUserParams()
  const panel = renderBuildingParamsPanel(defaultParams)
  if (panel) {
    // 清空现有内容
    document.getElementById('modal-params-wrap').innerHTML = ''
    // 插入参数面板
    document.getElementById('modal-params-wrap').insertAdjacentHTML('afterbegin', panel.innerHTML)
    // 显示 modal
    modal.hidden = false
    // 自动滚动到 modal
    modalWrap.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
})

// 关闭逻辑 - 关闭按钮和遮罩层
closeBtn.addEventListener('click', () => modal.hidden = true)
cancelBtn.addEventListener('click', () => modal.hidden = true)
modalOverlay.addEventListener('click', () => modal.hidden = true)

// 确认逻辑
okBtn.addEventListener('click', () => {
  const container = document.querySelector('#card-ag41-wrap .card-body')
  // 读取用户确认的参数
  const params = panel.readParams?.() || { buildingW: 18600, buildingD: 24000, roomTargetAreas: {} }
  // 可选：将 params 传给 runAG41() 生成新方案
  showAg41Notify('建筑参数已确认，将用于生成布局方案', true)
  // 关闭 modal
  modal.hidden = true
})

// ── 高级参数标签页切换 ─────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const panelId = btn.dataset.tab

    // deactivate all tabs
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.remove('active')
      b.setAttribute('aria-selected', 'false')
    })
    document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = true })

    // activate selected
    btn.classList.add('active')
    btn.setAttribute('aria-selected', 'true')
    document.getElementById(panelId).hidden = false
  })
})

// ── 折叠状态持久化 ─────────────────────────────────────────────
function persistCollapseState() {
  const collapsibleSections = document.querySelectorAll(
    '.agent-card, #topology-details, #advanced-params-details, #ag41-comparison-details, #ag41-variants-details, #ag41-detail-details'
  );
  const collapseState = JSON.parse(localStorage.getItem('collapseState')) || {};

  collapsibleSections.forEach(section => {
    // Use a more robust way to get a unique ID for each section
    const sectionId = section.id || section.classList[1]; // e.g., 'topology-details' or 'card-ag00'
    if (!sectionId) return;

    // Apply stored state on load
    if (collapseState[sectionId] === false) { // false means collapsed
      section.removeAttribute('open');
    } else if (collapseState[sectionId] === true) { // true means open
      section.setAttribute('open', '');
    }

    // Listen for changes and update storage
    section.addEventListener('toggle', () => {
      collapseState[sectionId] = section.hasAttribute('open');
      localStorage.setItem('collapseState', JSON.stringify(collapseState));
    });
  });
}

// Initialize persistence on page load
document.addEventListener('DOMContentLoaded', persistCollapseState);
