import { generateConstrainedLayout, buildPartialResult, computeRelaxedDoorAccess, GRID_SIZE, generateWeightMapForRoom } from '../layout/generator/layout-generator.js'
import { ROOM_DEFS } from '../layout/model/room-defs.js';
import { getDefaultUserParams, getUserConfirmedParams } from '../layout/model/user-params.js'
import { centerX, centerY, evaluateTemplate } from '../layout/generator/placer.js'
import { scoreLayout, scoreSpatialQuality } from '../layout/evaluation/scorer.js'

/**
 * @typedef {Object} GenerationContext
 * @property {number} buildingW
 * @property {number} buildingD
 * @property {number} gridW
 * @property {number} gridH
 * @property {Object} roomTargetAreas
 */

// --- 基础辅助工具 ---

const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * 在 debugModeEnabled 下计时执行 fn，超过 timeCostThreshold 时 toast 报警并抛出错误。
 * 同时将耗时记录到 window.timeCostLog。
 */
function timed(name, fn) {
  if (!window.debugModeEnabled) return fn();
  const t0 = performance.now();
  const result = fn();
  const duration = (performance.now() - t0) / 1000;
  const threshold = window.timeCostThreshold ?? 0.5;
  if (!window.timeCostLog) window.timeCostLog = [];
  window.timeCostLog.push({ fn: name, duration });
  if (duration > threshold) {
    const msg = `[性能] ${name} 耗时 ${duration.toFixed(3)}s，超过阈值 ${threshold}s`;
    import('../ui/layout-panel.js').then(({ showAg41Notify }) => showAg41Notify(msg, false));
    throw new Error(msg);
  }
  return result;
}

/** 将 mm 坐标转换为网格中心索引 */
function placementToGridCenter(placement) {
  return {
    x: Math.round(centerX(placement) / GRID_SIZE),
    y: Math.round(centerY(placement) / GRID_SIZE),
  }
}

/** 初始化生成上下文 */
async function getGenerationContext() {
  const params = await getUserConfirmedParams(getDefaultUserParams());
  return {
    ...params,
    gridW: Math.floor(params.buildingW / GRID_SIZE),
    gridH: Math.floor(params.buildingD / GRID_SIZE)
  };
}

/**
 * 检查点 B：对 Phase 2 结束后的快照进行打分并排序
 */
function applyCheckpointB(layouts, ctx) {
  for (const layout of layouts) {
    try {
      const { ground, level1 } = layout._debug || {};
      if (!ground?.gridBeforeGaps || !level1?.gridBeforeGaps) {
        layout._checkpointBScore = -Infinity;
        continue;
      }
      const snapshot = timed('buildPartialResult', () => buildPartialResult(ground.gridBeforeGaps, level1.gridBeforeGaps, ctx.buildingW, ctx.buildingD));
      const relaxed = timed('computeRelaxedDoorAccess', () => computeRelaxedDoorAccess(ground.gridBeforeGaps, level1.gridBeforeGaps));
      const evaluated = { ...timed('evaluateTemplate', () => evaluateTemplate(snapshot)), _relaxedDoorAccess: relaxed };

      layout._checkpointBScore = timed('scoreSpatialQuality', () => scoreSpatialQuality(evaluated).partialScore ?? -Infinity);
      layout._relaxedDoorAccess = relaxed;
    } catch (e) {
      console.error('Checkpoint B scoring failed:', e);
      layout._checkpointBScore = -Infinity;
    }
  }
  layouts.sort((a, b) => (b._checkpointBScore ?? -Infinity) - (a._checkpointBScore ?? -Infinity));
}

// --- 变异与进化核心逻辑 ---

/** 分析方案中的违规房间 */
function getViolatingRooms(variant) {
  const violators = new Set();
  
  // 1. 物理约束违规
  (variant.violations || []).forEach(v => {
    if (v.constraint === 'must_adjacent') {
      const parts = v.room.split('↔');
      if (parts.length > 0) violators.add(parts[Math.floor(Math.random() * parts.length)]);
    } else {
      violators.add(v.room);
    }
  });

  // 2. 交通可达性违规
  (variant._relaxedDoorAccess?.ids || []).forEach(id => {
    const def = ROOM_DEFS[id];
    if (!def) return;
    // 50% 概率怪房间自己，50% 概率怪走廊/玄关
    if (Math.random() < 0.5) {
      violators.add(id);
    } else {
      if (def.floor === 'level1') violators.add('corridor_l1');
      else violators.add(['parking', 'repair_zone'][Math.floor(Math.random() * 2)]);
    }
  });

  return violators;
}

/** 为指定房间生成新种子（智能或随机）
 *  parentPlacements: 父代该楼层所有房间的实际 placement，用于构建真实占用格子
 */
function getNewSeed(roomId, ctx, currentSeeds, isSmart = false, parentPlacements = null) {
  if (!isSmart) {
    return { x: Math.floor(Math.random() * ctx.gridW), y: Math.floor(Math.random() * ctx.gridH) };
  }

  const roomDef = { id: roomId, ...ROOM_DEFS[roomId] };

  // 用实际轮廓建 occupied set，避免新种子落入已有房间内部
  let getCell;
  if (parentPlacements) {
    const occupied = new Set();
    for (const [id, p] of Object.entries(parentPlacements)) {
      if (id === roomId) continue; // 目标房间本身不阻挡——允许在原地附近重新生长
      const x0 = Math.floor(p.x / GRID_SIZE);
      const y0 = Math.floor(p.y / GRID_SIZE);
      const x1 = Math.ceil((p.x + p.w) / GRID_SIZE);
      const y1 = Math.ceil((p.y + p.d) / GRID_SIZE);
      for (let gy = y0; gy < y1; gy++)
        for (let gx = x0; gx < x1; gx++)
          occupied.add(`${gx},${gy}`);
    }
    getCell = (x, y) => occupied.has(`${x},${y}`) ? 1 : 0;
  } else {
    getCell = (x, y) => Object.values(currentSeeds).some(s => s.x === x && s.y === y) ? 1 : 0;
  }

  const mockGrid = { width: ctx.gridW, height: ctx.gridH, getCell };
  const weightMap = timed('generateWeightMapForRoom', () => generateWeightMapForRoom(mockGrid, roomDef, currentSeeds, parentPlacements));
  let bestPos = null;
  let maxWeight = -1;

  for (let i = 0; i < 500; i++) {
    const x = Math.floor(Math.random() * ctx.gridW);
    const y = Math.floor(Math.random() * ctx.gridH);
    if (mockGrid.getCell(x, y) === 0 && weightMap[y][x] > maxWeight) {
      maxWeight = weightMap[y][x];
      bestPos = { x, y };
    }
  }
  return bestPos || { x: Math.floor(Math.random() * ctx.gridW), y: Math.floor(Math.random() * ctx.gridH) };
}

// --- 导出的核心 API ---

/**
 * 优化单个方案
 */
export async function optimizeVariant(parent) {
  const ctx = await getGenerationContext();
  const seed = Math.floor(Math.random() * 100000);

  const rawChild = generateMutatedLayout(parent, 'unverified_smart', seed, ctx, 'Opt', 1, 'OPT');
  const candidate = evaluateTemplate(rawChild);

  Object.assign(candidate, scoreLayout(candidate));
  candidate._seedsMeta = rawChild._debug;

  applyCheckpointB([candidate], ctx);
  return candidate;
}


/**
 * 运行全量布局生成流程
 */
export async function runAG41(existingVariants = [], isCancelled = () => false, options = {}) {
  const ctx = await getGenerationContext();
  const sorted = [...existingVariants].sort((a, b) => b.score - a.score);
  const results = [];
  let attempts = 0;
  const maxVariantIdx = existingVariants.reduce((max, v) => Math.max(max, v.variantIdx || 0), 0);

  const runParams = {
    enableAreaSwap: true,
    schemaLayout: options.schemaLayout || false,
    detailedLayout: options.detailedLayout !== false, // Default to true unless explicitly set to false
  };

  const pushResult = (layout) => results.push(evaluateTemplate(layout));

  // 策略 1: 交叉进化 (Top 10 中选优)
  if (!options.randomOnly && sorted.length >= 5) {
    const pairs = [
      { a: sorted[0], b: sorted[4], tag: 'C15' },
      { a: sorted[4], b: sorted[8] || sorted[0], tag: 'C59' }
    ];
    for (const p of pairs) {
      if (isCancelled()) break;
      pushResult(generateHybridLayout(p.a, p.b, Math.random() * 1000, ctx, 'Evo', maxVariantIdx + results.length + 1, p.tag, runParams));
      attempts++; await yieldToEventLoop();
    }
  }

  // 策略 2: 智能变异 (Top 3 进化)
  if (!options.randomOnly && sorted.length > 0) {
    for (let i = 0; i < Math.min(sorted.length, 3); i++) {
      if (isCancelled()) break;
      pushResult(generateMutatedLayout(sorted[i], 'unverified_smart', Math.random() * 1000, ctx, 'Exp', maxVariantIdx + results.length + 1, `O${i+1}`, runParams));
      attempts++; await yieldToEventLoop();
    }
  }

  // 策略 3: 随机探索与存量修正
  const explorers = options.randomOnly ? [{ count: 9, tag: 'RND' }] : [
    { parent: sorted[3], mode: 'all_but_verified', count: 1, tag: 'M4' },
    { parent: sorted[4], mode: 'all_but_verified', count: 1, tag: 'M5' },
    { count: 2, tag: 'RND' }
  ];

  for (const ex of explorers) {
    for (let i = 0; i < ex.count; i++) {
      if (isCancelled() || results.length >= 9) break;
      const seed = Math.random() * 1000;
      if (ex.parent) {
        pushResult(generateMutatedLayout(ex.parent, ex.mode, seed, ctx, 'Exp', maxVariantIdx + results.length + 1, ex.tag, runParams));
      } else {
        pushResult(timed('generateConstrainedLayout', () => generateConstrainedLayout(seed, ctx.buildingW, ctx.buildingD, ctx.roomTargetAreas,
          runParams, 'Exp', maxVariantIdx + results.length + 1, ex.tag)));
      }
      attempts++; await yieldToEventLoop();
    }
  }

  // 兜底：纯随机补足
  while (results.length < 9 && attempts < 50 && !isCancelled()) {
    pushResult(timed('generateConstrainedLayout', () => generateConstrainedLayout(Math.random() * 1000, ctx.buildingW, ctx.buildingD, ctx.roomTargetAreas,
      runParams, 'Fill', maxVariantIdx + results.length + 1, 'R')));
    attempts++; await yieldToEventLoop();
  }

  results._attemptCount = attempts;
  applyCheckpointB(results, ctx);
  return results;
}

/**
 * 变异逻辑：基于父代进行局部修改
 */
function generateMutatedLayout(parent, mode, seed, ctx, groupId, idx, prefix, runParams = {}) {
  const childSeeds = { ground: {}, level1: {} };
  const seedsMeta = { ground: {}, level1: {} };
  
  const violatingRooms = getViolatingRooms(parent);
  // 核心：如果有多个违规，变异时仅随机挑一个改
  const violators = Array.from(violatingRooms);
  const targetRoomId = violators.length > 0 ? violators[Math.floor(Math.random() * violators.length)] : null;

  ['ground', 'level1'].forEach(floor => {
    const rooms = Object.keys(ROOM_DEFS).filter(id => ROOM_DEFS[id].floor === floor && !ROOM_DEFS[id].isOpening);
    const floorPlacements = parent?.[`${floor}Placements`] ?? {};

    // 预先汇总所有父代种子中心，让权重图拥有完整上下文（不依赖循环顺序）
    const allParentSeeds = {};
    for (const id of rooms) {
      const p = floorPlacements[id];
      if (p) allParentSeeds[id] = placementToGridCenter(p);
    }

    for (const id of rooms) {
      const isTarget = (id === targetRoomId);
      const isVerified = !violatingRooms.has(id);

      let keepParent = false;
      if (mode === 'all_but_verified') keepParent = isVerified;
      else if (mode === 'unverified' || mode === 'unverified_smart') keepParent = !isTarget;

      const parentPlacement = floorPlacements[id];
      if (keepParent && parentPlacement) {
        childSeeds[floor][id] = placementToGridCenter(parentPlacement);
        seedsMeta[floor][id] = { parent: childSeeds[floor][id], child: childSeeds[floor][id], replaced: false };
      } else {
        const isSmart = (mode === 'unverified_smart');
        childSeeds[floor][id] = getNewSeed(id, ctx, allParentSeeds, isSmart,
          isSmart ? floorPlacements : null);
        seedsMeta[floor][id] = { parent: parentPlacement ? placementToGridCenter(parentPlacement) : null, child: childSeeds[floor][id], replaced: true };
      }
    }
  });

  return timed('generateConstrainedLayout', () => generateConstrainedLayout(seed, ctx.buildingW, ctx.buildingD, ctx.roomTargetAreas,
    { ...runParams, seedsMeta }, groupId, idx, prefix, childSeeds));
}

/**
 * 杂交逻辑：融合两个父代的优良基因
 */
function generateHybridLayout(parentA, parentB, seed, ctx, groupId, idx, prefix, runParams = {}) {
  let rngState = seed;
  const rng = () => (rngState = (rngState * 9301 + 49297) % 233280) / 233280;

  const childSeeds = { ground: {}, level1: {} };

  ['ground', 'level1'].forEach(floor => {
    const used = new Set();
    const rooms = Object.keys(ROOM_DEFS).filter(id => ROOM_DEFS[id].floor === floor && !ROOM_DEFS[id].isOpening);

    for (const id of rooms) {
      const pA = parentA?.[`${floor}Placements`]?.[id];
      const pB = parentB?.[`${floor}Placements`]?.[id];
      
      let placement = (pA && pB) ? (rng() < 0.5 ? pA : pB) : (pA || pB);
      if (placement) {
        let pos = placementToGridCenter(placement);
        // 碰撞躲避
        let att = 0;
        while (used.has(`${pos.x},${pos.y}`) && att < 20) {
          pos.x = (pos.x + (rng() < 0.5 ? 1 : -1) + ctx.gridW) % ctx.gridW;
          pos.y = (pos.y + (rng() < 0.5 ? 1 : -1) + ctx.gridH) % ctx.gridH;
          att++;
        }
        childSeeds[floor][id] = pos;
        used.add(`${pos.x},${pos.y}`);
      } else {
        childSeeds[floor][id] = getNewSeed(id, ctx, childSeeds[floor], false);
      }
    }
  });

  return timed('generateConstrainedLayout', () => generateConstrainedLayout(seed, ctx.buildingW, ctx.buildingD, ctx.roomTargetAreas,
    runParams, groupId, idx, prefix, childSeeds));
}

/**
 * 计算变异提示（用于 UI 调试显示箭头）
 */
export function computeMutatedLayout(parent) {
  const ctx = {
    buildingW: parent.buildingW, buildingD: parent.buildingD,
    gridW: Math.floor(parent.buildingW / GRID_SIZE),
    gridH: Math.floor(parent.buildingD / GRID_SIZE)
  };

  const violators = Array.from(getViolatingRooms(parent));
  const targetId = violators.length > 0 ? violators[Math.floor(Math.random() * violators.length)] : null;
  const hints = { ground: {}, level1: {} };

  if (!targetId) return hints;

  ['ground', 'level1'].forEach(floor => {
    const currentSeeds = {};
    for (const [id, p] of Object.entries(parent[`${floor}Placements`] || {})) {
      currentSeeds[id] = placementToGridCenter(p);
    }

    const targetDef = ROOM_DEFS[targetId];
    if (targetDef && targetDef.floor === floor && currentSeeds[targetId]) {
      const best = getNewSeed(targetId, ctx, currentSeeds, true);
      hints[floor][targetId] = { from: currentSeeds[targetId], to: best };
    }
  });

  return hints;
}

export async function runPhase3Optimization(variants) {
  const ctx = await getGenerationContext();
  const results = [];

  for (const variant of variants) {
    const runParams = {
      detailedLayout: true,
      initialGrid: variant,
    };
    const optimized = generateConstrainedLayout(Math.random() * 1000, ctx.buildingW, ctx.buildingD, ctx.roomTargetAreas, runParams, 'Opt', variant.variantIdx, variant.id.slice(0, 3));
    results.push(evaluateTemplate(optimized));
  }

  applyCheckpointB(results, ctx);
  for (const r of results) {
    Object.assign(r, scoreLayout(r));
  }

  return results;
}
