# 代码审查报告：参数调整 (b803908)

**日期**: 2026-04-18  
**审查范围**: commit b803908 "参数调整 (#49)"  
**修改文件**: `src/layout/adjacency.js`, `src/layout/scorer-params.js`

---

## 变更摘要

### 1. 约束关系升级

**文件**: `src/layout/adjacency.js`

```diff
+ { pair: ['parking', 'repair_zone'], reason: '临近，便于设备转运' },  // 从 SHOULD → MUST
```

**影响评估**: ⚠️ **中风险**
- parking 和 repair_zone 现在必须相邻（ADJACENCY_MUST）
- 违规扣分: 500 分（vs. SHOULD 的 15 分）
- 约束强度提升 ~33 倍

---

### 2. 形状违规惩罚加重

**文件**: `src/layout/scorer-params.js`

```diff
- aspectRatioThreshold:   4,
+ aspectRatioThreshold:   3,
- aspectRatioPenalty:     500,
+ aspectRatioPenalty:     2000,
```

**影响评估**: ⚠️ **高风险**

| 参数 | 前值 | 新值 | 变化 |
|------|------|------|------|
| 阈值 | 4 | 3 | 约束更严（只有长宽比≤3的房间才合格）|
| 扣分 | 500 | 2000 | **4 倍增加** |

**风险点**:
1. **倍数不对称**: 单个房间形状违规（2000分）现在相当于缺失整个房间（500分）或违反4项MUST约束
2. **累积风险**: `computeAspectRatioPenalty()` 检查3个维度（长宽比、利用率、顶点数），同一房间可能被扣超过6000分
3. **可行性影响**: 高扣分可能导致大量方案跌出可行域（通不过Checkpoint A）

---

## 代码审查发现

### 问题 A: 约束升级未全面同步

**位置**: `src/layout/scorer.js`, `computeDoorAccessPenalty()` (103-110行)

**原代码**:
```javascript
const parking    = groundPlacements['parking']
const repairZone = groundPlacements['repair_zone']
if (parking && repairZone) {
  const parkingOk = adjacent(parking, repairZone) || touchesExteriorNonSouth(parking, buildingW, buildingD)
  const repairOk  = adjacent(parking, repairZone) || touchesExteriorNonSouth(repairZone, buildingW, buildingD)
  if (!parkingOk) violations.push({ id: 'parking', source: 'parkingRepairAdjExt' })
  if (!repairOk)  violations.push({ id: 'repair_zone', source: 'parkingRepairAdjExt' })
}
```

**问题**:
- 旧逻辑允许 parking 和 repair_zone 分别通过外墙逃逸（touchesExteriorNonSouth）
- 新的 MUST 约束要求它们**互相相邻**，不允许独立外墙访问
- 代码未更新导致约束冲突

**修复**:
```javascript
const parking    = groundPlacements['parking']
const repairZone = groundPlacements['repair_zone']
if (parking && repairZone) {
  // parking/repair_zone upgraded to ADJACENCY_MUST (b803908)
  // They must be adjacent (no external wall escape route for either)
  if (!adjacent(parking, repairZone)) {
    violations.push({ id: 'parking', source: 'parkingRepairMust' })
    violations.push({ id: 'repair_zone', source: 'parkingRepairMust' })
  }
}
```

**状态**: ✅ **已修复** (提交中)

---

### 问题 B: 参数调整缺乏验证基准

**位置**: `src/layout/scorer-params.js` (106-107行)

**风险描述**:
- aspectRatioPenalty 4 倍增加 (500 → 2000) 无对应的测试数据
- 无法判断是否是有意加强还是误操作
- 缺乏"变更前后方案通过率对比"的验证记录

**建议验收标准**:
- [ ] 变更后至少 **60% 的方案通过 Checkpoint A**（不低于历史平均）
- [ ] 新参数下单个房间的平均扣分 **< 1500 分**（避免过度惩罚）
- [ ] 旧参数下排名前 50 的方案在新参数下排名变化 **< 3 位**

**建议行动**:
1. 运行完整的方案生成测试（>=100 个随机配置）
2. 对比 b803908 前后的评分分布
3. 记录测试结果并归档

---

### 问题 C: 文档版本滞后

**文件**: `02模块设计/AG4建筑平面布局4_评价.md`

**现状**: v1.7（旧版本）
- MUST 约束列表仍列出 2 对：meter_main↔meter_sub, trafo1↔trafo2
- 缺少新增的 parking↔repair_zone MUST 约束
- 用户文档与代码不一致

**修复**: 已更新 `adjacency.js` 和 `scorer-params.js` 的文档注释标记为 v1.8

**待办**: 
- [ ] 更新 `02模块设计/AG4建筑平面布局4_评价.md` 至 v1.8，列出所有 MUST 约束

---

## 其他观察

### ag41 约束处理
**文件**: `src/layout/layout-generator.js` (798, 944-947 行)

**状态**: ✅ **已覆盖**
- ag41 Phase 1 种子放置已处理 parking/repair_zone 的相邻关系
- layout-generator 798 行: `processFloor(groundGrid, GROUND_MUST_EXT, [['parking', 'repair_zone']])`
- 944-947 行: repair_zone 的相邻性检查已实现

---

## 修复清单

| 项目 | 状态 | 备注 |
|------|------|------|
| scorer.js 约束逻辑修复 | ✅ 完成 | 强制 parking↔repair_zone 相邻，移除外墙逃逸 |
| adjacency.js 文档更新 | ✅ 完成 | 更新版本标记和约束说明 |
| scorer-params.js 审查注释 | ✅ 完成 | 标记参数变更历史和验收标准 |
| ag41 一致性验证 | ✅ 确认 | 种子放置逻辑已覆盖新约束 |
| 官方文档更新 (v1.8) | ⏳ 待办 | 需要手工更新 AG4 文档 |
| 参数变更影响测试 | ⏳ 待办 | 需要运行回归测试 |

---

## 建议行动计划

### 立即执行（本周）
1. ✅ 修复 scorer.js 约束逻辑 → **提交本 PR**
2. ⏳ 运行本地方案生成测试，记录通过率对比
3. ⏳ 更新 `02模块设计/AG4建筑平面布局4_评价.md` 至 v1.8

### 下周启动
1. 建立单元测试验证 parking↔repair_zone 强制相邻性
2. 创建参数变更回归测试，验收标准见"问题 B"
3. 建立"参数变更 → 文档更新"的必需审查流程

---

## 总体风险评级

| 项目 | 风险等级 | 缓解措施 |
|------|---------|--------|
| 约束升级未同步 | 🔴 高 | ✅ 已修复 scorer.js |
| 参数倍数过度 | 🟡 中 | ⏳ 需要回归测试验证 |
| 文档版本滞后 | 🟡 中 | ⏳ 需要手工更新 |
| 种子放置逻辑 | 🟢 低 | ✅ 已确认覆盖 |

---

## 技术债务记录

### 相关 issues 和改进项

1. **状态管理分散** (main.js, 909 行)
   - moduleCache 不覆盖 ag31/ag41/ag42
   - 参数验证零散分布
   - 建议: 提取 services/moduleCache.js, services/parameterValidator.js

2. **layout-generator.js 文档不足** (2183 行)
   - Phase 1/2/3 流程无顶层伪代码
   - 权重图生成的数学原理无文档
   - 建议: 补充 200-300 行算法文档

3. **评分函数职责重叠** (scorer.js, 494 行)
   - scoreHardRedlines(), scoreSpatialQuality(), scoreLayout() 职责不清
   - 建议: 统一分层接口 (Tier 1 → Tier 2 → Tier 3)

4. **无回归测试框架**
   - 无法快速验证参数变更的影响
   - 建议: 建立参数变更压力测试套件

---

**审查结论**: ✅ **合格（已修复关键问题）**

关键约束逻辑已修正，文档已标记。建议在合并 PR 之前完成回归测试验证。
