import { runAG41, optimizeVariant, computeMutatedLayout, runPhase3Optimization } from '../agents/layout-build.js'
import { mergeVariants } from '../agents/layout-eval.js'
import {
  renderLayoutPanel, getVariants, getSelectedVariant, getExpandedVariants,
  replaceVariant, refreshDetailRow, showAg41Notify, rescoreAndRerender,
  renderScorerParamsPanel
} from './layout-panel.js'
import { renderBuildingParamsPanel } from './building-params-panel.js'
import { getDefaultUserParams } from '../layout/model/user-params.js'
import { SCORER_PARAMS } from '../layout/evaluation/scorer-params.js'
import { scoreLayout, scoreHardRedlines } from '../layout/evaluation/scorer.js'

let schemaLayout = true;
let detailedLayout = false;
let isGeneratingLayouts = false;
let generationReqId = null;

function isQualifiedVariant(variant) {
  const hardRedlinesResult = scoreHardRedlines(variant);
  return hardRedlinesResult.passes === true;
}

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
  const ag41Variants = await runAG41([], () => false, { detailedLayout: false })
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
      schemaLayout = true;
      detailedLayout = false;
      isGeneratingLayouts = true
      btn.textContent = '停止生成'

      const existing = getVariants();
      const top9 = existing.slice(0, 9);
      const top9areQualified = top9.length > 0 && top9.every(isQualifiedVariant);

      if (top9.length >= 9 && top9areQualified) {
        showAg41Notify('排名前9的方案均已合格，无需生成更多', true);
        isGeneratingLayouts = false;
        btn.textContent = '生成方案';
        return;
      }

      const generationLoop = async () => {
        if (!isGeneratingLayouts) { btn.textContent = '生成方案'; return }
        try {
          const existing = getVariants()
          const newRaw = await runAG41(existing, () => !isGeneratingLayouts, { schemaLayout: schemaLayout, detailedLayout: false })
          if (newRaw === null) { isGeneratingLayouts = false; btn.textContent = '生成方案'; return }
          applyLayoutResult(newRaw, existing, false)

          const currentVariants = getVariants();
          const top9 = currentVariants.slice(0, 9);
          const top9areQualified = top9.length > 0 && top9.every(isQualifiedVariant);
          if (top9.length >= 9 && top9areQualified) {
            isGeneratingLayouts = false;
            btn.textContent = '生成方案';
            showAg41Notify('排名前9的方案均已合格，停止自动生成', true);
            return;
          }

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
    const existing = getVariants()
    if (existing.length === 0) {
      showAg41Notify('请先生成方案，再进行优化', false);
      return;
    }

    detailedLayout = true;
    btn.disabled = true
    btn.textContent = '优化中…'
    try {
      const optimized = await runPhase3Optimization(existing)
      // 直接替换原方案，不重新排序（优化应该替换，而不是重新参与竞争）
      const replaced = existing.map(orig => {
        const opt = optimized.find(o => o.variantIdx === orig.variantIdx);
        return opt ? { ...orig, ...opt, groundPlacements: opt.groundPlacements, level1Placements: opt.level1Placements } : orig;
      });
      renderLayoutPanel(replaced)
      showAg41Notify(`对 ${existing.length} 个方案完成优化`, true)
    } catch (e) {
      console.error('runPhase3Optimization failed:', e)
      showAg41Notify('优化失败', false)
    } finally {
      btn.disabled = false
      btn.textContent = '优化方案'
      detailedLayout = false
    }
  })

  document.getElementById('btn-ag41-reset')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-ag41-reset')
    btn.disabled = true
    btn.textContent = '生成中…'
    try {
      const newRaw = await runAG41([], () => false, { detailedLayout: false }) 
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
