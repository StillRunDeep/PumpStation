import { runAG41, optimizeVariant, generateMergedLayout, computeMutatedLayout } from '../agents/layout-build.js'
import { mergeVariants } from '../agents/layout-eval.js'
import {
  renderLayoutPanel, getVariants, getSelectedVariant, getExpandedVariants,
  replaceVariant, refreshDetailRow, showAg41Notify, rescoreAndRerender,
  renderScorerParamsPanel
} from './layout-panel.js'
import { renderBuildingParamsPanel } from './building-params-panel.js'
import { getDefaultUserParams } from '../layout/model/user-params.js'
import { SCORER_PARAMS } from '../layout/evaluation/scorer-params.js'

let isGeneratingLayouts = false;
let generationReqId = null;

/**
 * 统一的布局生成结果处理：
 * - 所有方案均参与评分展示，返回 { variants, improved, newScored }
 */
function applyLayoutResult(newRaw, existing, isReset = false) {
  if (newRaw.length > 0) {
    const { variants, improved, newScored, eliminated } = mergeVariants(existing, newRaw)
    renderLayoutPanel(variants, eliminated)
    if (isReset) {
      showAg41Notify('已生成初始方案', true)
    } else {
      const maxNewScore    = Math.max(...newScored.map(v => v.score))
      const currentTopScore = variants[0]?.score || 0
      if (improved) {
        showAg41Notify(`发现更优方案！新方案最高分: ${maxNewScore}`, true)
      } else {
        showAg41Notify(`未发现更优方案 (当前最高: ${currentTopScore} / 本轮最高: ${maxNewScore})`, false)
      }
    }
  }
}

export async function generateInitialLayouts() {
  const ag41Variants = await runAG41()
  applyLayoutResult(ag41Variants, [], true)
}

export function initLayoutController() {
  // 用户展开方案详图时自动暂停持续生成
  window.addEventListener('ag41-detail-opened', () => {
    if (!isGeneratingLayouts) return;
    isGeneratingLayouts = false;
    if (generationReqId) {
      cancelAnimationFrame(generationReqId);
      generationReqId = null;
    }
    const btn = document.getElementById('btn-ag41-more');
    if (btn) btn.textContent = '生成更多方案';
    showAg41Notify('已暂停生成（展开详图）', false);
  });

  document.getElementById('btn-ag41-more')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-ag41-more')

    if (isGeneratingLayouts) {
      isGeneratingLayouts = false
      if (generationReqId) { cancelAnimationFrame(generationReqId); generationReqId = null }
      btn.textContent = '生成方案'
      showAg41Notify('已停止生成', false)
    } else {
      isGeneratingLayouts = true
      btn.textContent = '停止生成'

      const generationLoop = async () => {
        if (!isGeneratingLayouts) { btn.textContent = '生成方案'; return }
        try {
          const existing = getVariants()
          const newRaw = await runAG41(existing, () => !isGeneratingLayouts, { randomOnly: false })
          if (newRaw === null) { isGeneratingLayouts = false; btn.textContent = '生成方案'; return }
          applyLayoutResult(newRaw, existing, false)
        } catch (error) {
          console.error('layout generation error:', error)
          showAg41Notify('生成新方案时出错', false)
          isGeneratingLayouts = false
          btn.textContent = '生成方案'
          return
        }
        if (isGeneratingLayouts) generationReqId = requestAnimationFrame(generationLoop)
      }

      generationReqId = requestAnimationFrame(generationLoop)
    }
  })

  document.getElementById('btn-ag41-optimize')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-ag41-optimize')
    const expanded = getExpandedVariants()
    if (expanded.length === 0) return
    const selected = expanded[Math.floor(Math.random() * expanded.length)];

    if (window._bypassCheckpointA) {
      const hints = computeMutatedLayout(selected);
      const debugWithHints = {
        ground: { ...selected._debug?.ground, movementHints: hints.ground },
        level1: { ...selected._debug?.level1, movementHints: hints.level1 },
      };
      refreshDetailRow(selected.id, { ...selected, _debug: debugWithHints });
      return;
    }

    btn.disabled = true
    btn.textContent = '优化中…'
    try {
      const candidate = await optimizeVariant(selected)
      candidate.id = selected.id
      if (candidate.score > selected.score) {
        replaceVariant(selected.id, candidate)
        showAg41Notify(`方案 ${selected.id} 已更新 (${selected.score} → ${candidate.score})`, true)
      } else {
        const msg = {
          text: `本次优化：${candidate.score}分，未超过当前 ${selected.score}分，未替换`,
          isWarning: true,
        }
        const displayVariant = { ...selected, _debug: candidate._debug }
        refreshDetailRow(selected.id, displayVariant, msg)
        showAg41Notify(msg.text, false)
      }
    } catch (e) {
      console.error('optimizeVariant failed:', e)
      showAg41Notify('优化失败', false)
    } finally {
      btn.disabled = false
      btn.textContent = '优化方案'
    }
  })

  document.getElementById('btn-ag41-merge')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-ag41-merge')
    const expanded = getExpandedVariants()
    if (expanded.length !== 2) return
    btn.disabled = true
    btn.textContent = '合并中…'
    try {
      const merged = await generateMergedLayout(expanded[0], expanded[1])
      const existing = getVariants()
      const { variants, eliminated } = mergeVariants(existing, [merged])
      renderLayoutPanel(variants, eliminated)
      showAg41Notify(`合并方案已生成：${merged.id}（得分 ${merged.score}）`, true)
    } catch (e) {
      console.error('merge failed:', e)
      showAg41Notify('合并失败', false)
    } finally {
      btn.disabled = false
      btn.textContent = '合并方案'
    }
  })

  document.getElementById('btn-ag41-reset')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-ag41-reset')
    btn.disabled = true
    btn.textContent = '生成中…'
    try {
      const newRaw = await runAG41([]) 
      applyLayoutResult(newRaw, [], true)
    } finally {
      btn.disabled = false
      btn.textContent = '重制方案'
    }
  });

  // ── 建筑参数面板 ──
  const btnParams = document.getElementById('btn-ag41-params');
  const buildParamsDialog = document.getElementById('modal-build-params');
  const closeBtn = buildParamsDialog?.querySelector('.modal-close');

  btnParams?.addEventListener('click', () => {
    const defaultParams = getDefaultUserParams();
    const panel = renderBuildingParamsPanel(defaultParams);
    const modalBody = buildParamsDialog.querySelector('#modal-params-wrap');
    if (panel && modalBody) {
        modalBody.innerHTML = panel.innerHTML;
        panel.init(modalBody);

        const actionsContainer = buildParamsDialog.querySelector('#modal-params-actions');
        if (actionsContainer) {
          actionsContainer.innerHTML = `
            <button id="btn-params-cancel" style="padding: 8px 16px; font-size: 13px; border-radius: 6px; border: 1px solid #ccc; background: #fff; cursor: pointer;">取消</button>
            <button id="btn-params-done" style="padding: 8px 16px; font-size: 13px; border-radius: 6px; border: none; background: #2e86c1; color: white; cursor: pointer; font-weight: 600;">完成</button>
          `;
          actionsContainer.querySelector('#btn-params-done').addEventListener('click', () => {
            if (panel.validateAndConfirm()) {
              buildParamsDialog.close();
            }
          });
          actionsContainer.querySelector('#btn-params-cancel').addEventListener('click', () => {
            buildParamsDialog.close();
          });
        }
    }
    buildParamsDialog?.showModal();
  });

  closeBtn?.addEventListener('click', () => {
      buildParamsDialog.close();
  });

  // ── 评分参数面板 ──
  const btnScorerParams = document.getElementById('btn-ag41-scorer-params');
  const scorerParamsDialog = document.getElementById('modal-scorer-params');

  btnScorerParams?.addEventListener('click', () => {
      const panelHtml = renderScorerParamsPanel(SCORER_PARAMS);
      const modalBody = scorerParamsDialog?.querySelector('#modal-scorer-wrap');
      if (modalBody) {
          modalBody.innerHTML = panelHtml;
      }
      const actionsContainer = scorerParamsDialog?.querySelector('#modal-scorer-actions');
      if (actionsContainer) {
        actionsContainer.innerHTML = `
          <button id="btn-scorer-cancel" style="padding: 8px 16px; font-size: 13px; border-radius: 6px; border: 1px solid #ccc; background: #fff; cursor: pointer;">取消</button>
          <button id="btn-scorer-done" style="padding: 8px 16px; font-size: 13px; border-radius: 6px; border: none; background: #2e86c1; color: white; cursor: pointer; font-weight: 600;">完成</button>
        `;
        actionsContainer.querySelector('#btn-scorer-done').addEventListener('click', () => {
          rescoreAndRerender();
          scorerParamsDialog.close();
        });
        actionsContainer.querySelector('#btn-scorer-cancel').addEventListener('click', () => {
          scorerParamsDialog.close();
        });
      }
      scorerParamsDialog?.showModal();
  });
}
