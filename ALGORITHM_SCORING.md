# 评分和Checkpoint机制 (Scoring & Checkpoint System)

**文件**: `src/layout/scorer.js` (494 lines)  
**关键函数**: `scoreHardRedlines()`, `scoreSpatialQuality()`, `scoreLayout()`  
**三个Checkpoint**: A (Tier 1) → B (Tier 1+2) → C (Tier 1+2+3)

---

## 评分框架概览

```
总体流程:

Phase 1: 种子放置 ─┐
                   ├─→ Checkpoint A (Tier 1 评分)
Phase 2: L/U 扩展 ─┤  ├─ 必需房间
                   │  ├─ MUST 相邻约束
Phase 3: 空隙填充 ─┘  └─ EXT_ACCESS 约束
                       ↓
                   Checkpoint B (Tier 1+2)
                   ├─ Tier 1 (Checkpoint A 全部)
                   ├─ 空间效率 (efficiency)
                   └─ 形状质量 (aspect ratio)
                       ↓
                   Checkpoint C (最终，Tier 1+2+3)
                   ├─ Tier 1+2 (Checkpoint B 全部)
                   ├─ 生长顺利度 (growth success)
                   ├─ 相邻关系质量 (adjacency bonus)
                   ├─ 走廊完整性 (corridor hits)
                   └─ 多样性评分
```

---

## 评分等级详解

### Tier 1: 硬性红线 (Hard Redlines)

**函数**: `scoreHardRedlines(result)` → `evaluateCheckpointA(result)`  
**通过条件**: 得分 = 0（所有违规计数 = 0）  
**扣分机制**: 每项违规扣相同的"罚分单位" (Penalty Unit, PU)

#### Tier 1.1: 必需房间 (Missing Rooms)
```
Rooms expected on ground floor:
  trafo1, trafo2, meter_main, meter_sub, fire_equip, parking, repair_zone

Rooms expected on Level 1:
  fan_room, clean_pump, rainwater, lv_control, corridor_l1

Penalty: missingRoomPenalty × count
Default: 500 × [number of missing rooms]

Example: If trafo1 is not placed, penalty = -500
```

#### Tier 1.2: 必需相邻关系 (ADJACENCY_MUST)
```
Constraint pairs:
  (meter_main, meter_sub)      // 水表房并排
  (trafo1, trafo2)             // 变压器相邻
  (parking, repair_zone)       // 停车↔检修（b803908）

Check: Are both rooms placed AND adjacent?

Penalty: doorAccessPenalty × count of violations
Default: 500 × [count of unmet MUST pairs]

Note: Adjacent = shares at least one grid cell edge (4-connectivity)
```

#### Tier 1.3: 外墙约束 (EXT_ACCESS)
```
Rooms requiring non-south exterior wall access:
  trafo1, trafo2, meter_main, meter_sub, fire_equip

Check: Does the room boundary touch exterior (north, west, east)?

Special handling for parking/repair_zone:
  - Both rooms must be adjacent (after b803908 upgrade)
  - OR: parking/repair_zone can ONLY satisfy this via mutual adjacency
  - (No separate external wall escape route allowed)

Penalty: doorAccessPenalty × count of violations
Default: 500 × [count of rooms failing EXT_ACCESS]

Implementation: computeDoorAccessPenalty()
```

#### Tier 1.4: 拓扑桥接 (Topological Bridging)
```
Issue: Some Level 1 rooms (fan_room, etc.) must reach Level 1 corridor
for door access. But if corridor is blocked, they fail.

Solution: "Relaxed door access" mechanism via computeRelaxedDoorAccess()
- Temporarily bridges Level 1 rooms to exterior (via stairwell escape)
- Allows them to pass Checkpoint A even if corridor is blocked
- Relaxation cost: labeled in doorAccessOverride

Status: Advanced feature, used in Phase 1 → Phase 2 progression
```

**Checkpoint A score formula**:
```
CheckpointA_score = (
  - missingRoomPenalty × missing_count
  - doorAccessPenalty × (must_violations + ext_access_violations)
  - mustViolationPenalty × (topology_violations if not bridged)
)

Passes if: score = 0
```

---

### Tier 2: 空间质量 (Spatial Quality)

**Function**: `scoreSpatialQuality(result)` → scored alongside Checkpoint B  
**Available at**: After Phase 2 L/U expansion  
**Impact on ranking**: Tier 2 determines relative ordering of Checkpoint A-passing layouts

#### Tier 2.1: 形状质量 (Aspect Ratio & Shape)

**函数**: `computeAspectRatioPenalty(result)` (149-210 lines)  
**三个维度的违规检查**:

```
1. ASPECT RATIO (长宽比)
   Formula: max(w/d, d/w)  // Always ≥ 1
   Threshold: aspectRatioThreshold (default: 3)
   Violation: if aspect_ratio > 3
   Penalty per violation: aspectRatioPenalty (default: 2000)
   
   Example: Room 6m × 2m → aspect ratio = 3.0 ✓ (passes)
           Room 9m × 2m → aspect ratio = 4.5 ✗ (1 violation = -2000)

2. ROOM UTILIZATION (面积利用率)
   Formula: actualArea / boundingBoxArea
   Threshold: utilizationThreshold (default: 0.70)
   Violation: if utilization < 0.70
   Penalties: 1 + floor((0.70 - utilization) / utilizationStep)
   
   Example: Bounding box 50m², actual area 30m² → util = 60%
           Deficit = 10%, violationCount = 1 + floor(10%/15%) = 1
           Penalty: -2000 × 1

3. CORNER COUNT (顶点数)
   Formula: Count distinct corners in room boundary polygon
   Threshold: vertexThreshold (default: 6)
   Violation count: max(0, (vertices - 6) / vertexStep)
   
   Example: L-shaped room has 6 corners ✓ (passes)
           T-shaped room has 8 corners ✗ (1 violation = -2000)
```

**⚠️ Risk from b803908**: aspectRatioPenalty increased 4× (500 → 2000)
- Single room can now accrue penalties > 6000 (exceeds missing room penalty)
- Validation: Ensure ≥ 60% layouts pass Checkpoint A

#### Tier 2.2: 空间效率 (Space Efficiency)

```
Formula: (ground_floor_functional_area + level1_functional_area) / (2 × building_area)

Excluded from functional area: corridor_l1, dock1, dock2

Score: linearScore(efficiency, efficiencyBase, efficiencyRange, efficiencyMaxBonus)
       = max(0, min(1, (efficiency - base) / range)) × maxBonus

Default parameters:
  efficiencyBase: 0.60      // Below 60% gets no bonus
  efficiencyRange: 0.30     // 60% → 90% maps to full bonus
  efficiencyMaxBonus: 50    // Max +50 points for efficiency

Example: If efficiency = 0.75:
  score = (0.75 - 0.60) / 0.30 × 50 = 0.5 × 50 = +25 points
```

#### Tier 2.3: 走廊完整性 (Corridor Hits)

```
Definition: Count SHOULD pairs that include 'corridor_l1'

ADJACENCY_SHOULD pairs with corridor_l1:
  (lv_control, corridor_l1)
  (clean_pump, corridor_l1)
  (rainwater, corridor_l1)
  (fan_room, corridor_l1)

Bonus: min(corridorBonus, round((hits / threshold) × corridorBonus))

Default parameters:
  corridorHitsThreshold: 2
  corridorBonus: 20

Example: If 2 out of 4 rooms touch corridor:
  bonus = min(20, round((2/2) × 20)) = 20
```

**Checkpoint B score formula**:
```
CheckpointB_score = (
  CheckpointA_score                    // Tier 1 (must be 0)
  - aspectRatioPenalty × shape_violations
  + efficiencyScore                    // Tier 2.2
  + corridorScore                      // Tier 2.3
)
```

---

### Tier 3: 优化项 (Optimization Bonuses)

**Function**: `scoreLayout(result)` (309-450 lines)  
**Available at**: After Phase 3 gap filling (final comprehensive scoring)  
**Impact on ranking**: Final 9-scheme ranking and display in UI

#### Tier 3.1: 生长顺利度 (Growth Success)
```
Definition: Ratio of actual vs. target total area across all rooms

Formula: growthRatio = min(1, totalActualArea / totalTargetArea)
Score: growthRatio × growthSuccessMaxBonus

Default: growthSuccessMaxBonus = 100

If all rooms reach 100% of target area: +100 bonus
If rooms reach only 50% of target: +50 bonus
```

#### Tier 3.2: 变压器布置 (Trafo Placement)
```
Bonus 1: Exterior wall bonus (trafoExteriorBonus = 20)
  Awarded if trafo1 or trafo2 touches exterior wall (west or east)

Bonus 2: Same-side bonus (trafoSameSideBonus = 20)
  Awarded if both trafo1 and trafo2 are on the same side (both west or both east)

Max trafo bonus: 20 + 20 + 20 = 60 points
```

#### Tier 3.3: 风机房距离 (Fan Room Proximity)
```
Definition: Fan room should be near dock2 (equipment hoist)

Distance: Euclidean distance between centers in mm

Formula: bonus = max(0, fanRoomMaxBonus - distance / fanRoomDistDivisor)

Default parameters:
  fanRoomMaxBonus: 30
  fanRoomDistDivisor: 500

Example: If distance = 5000mm (5m):
  bonus = max(0, 30 - 5000/500) = max(0, 30 - 10) = +20
```

#### Tier 3.4: 相邻关系质量 (Adjacency Bonuses)
```
MUST adjacency bonus: +40 per satisfied pair
SHOULD adjacency bonus: +15 per satisfied pair

Total max: 40 × 3 MUST pairs + 15 × 6 SHOULD pairs = 210 points
```

#### Tier 3.5: 多样性惩罚 (Diversity Penalty)

Applied after final ranking (ag42 phase):
```
Problem: 9 generated schemes may be similar, reduce UI value

Solution: Compare all pairs of final schemes, penalize duplicates

Threshold: diversityThreshold = 5.0 grid units (2500mm)

If scheme A and B are too similar:
  penalty = -diversityPenalty × (1 - similarity_distance / threshold)

Default: diversityPenalty = 200
```

**Checkpoint C (final) score formula**:
```
FinalScore = (
  CheckpointB_score                    // Tier 1+2 (may be negative)
  + growthSuccess                      // Tier 3.1
  + trafo_bonuses                      // Tier 3.2
  + fanRoom_bonus                      // Tier 3.3
  + adjacency_bonuses                  // Tier 3.4
  - diversity_penalty                  // Tier 3.5 (applied during ag42 ranking)
)

Base score: 10000
Final range: typically 8000 ~ 11000
```

---

## 参数敏感性分析 (Parameter Sensitivity)

### 关键参数及其影响

| 参数 | 当前值 | ±10% 影响 | 类型 | 调整建议 |
|------|--------|----------|------|---------|
| `aspectRatioPenalty` | 2000 | ⚠️ ±200 | **风险** | 需回归测试验证 |
| `aspectRatioThreshold` | 3 | 低 | 约束 | 保持现状 |
| `doorAccessPenalty` | 500 | 中 | 惩罚 | 可调 |
| `convenienceRange` | 100 | 低 | 奖励 | 可调 |
| `efficiencyMaxBonus` | 50 | 低 | 奖励 | 可调 |
| `corridorBonus` | 20 | 低 | 奖励 | 可调 |
| `diversityPenalty` | 200 | 中 | 惩罚 | 监控通过率 |

### 风险指标 (Risk Indicators)
- **Checkpoint A 通过率** < 60%: 约束过严，考虑松动
- **形状违规占比** > 30%: aspectRatioPenalty 过高
- **多样性惩罚应用** > 50%: 方案相似度过高，考虑优化 Phase 2

---

## Checkpoint 通过流程 (Decision Logic)

```
Phase 1 完成 (种子放置)
  ↓
evaluateCheckpointA(result)  // 硬性红线评分
  ├─ If passes (score = 0)   → 继续 Phase 2
  └─ If fails               → 标记不可行，停止
  
Phase 2 完成 (L/U 扩展)
  ↓
scoreSpatialQuality(result)  // Tier 1+2 评分，对 9 方案排序
  ├─ Top 3: 最优方案，继续 Phase 3
  └─ Remaining 6: 备选（UI 展示，不继续优化）
  
Phase 3 完成 (空隙填充)
  ↓
scoreLayout(result)          // 最终 Checkpoint C 评分
  ↓
applyDiversityPenalty()      // ag42 多样性筛选
  ↓
Final ranking & UI display
```

---

## 验证用例 (Test Cases)

### 用例 1: MUST 约束强制性
```
Test: parking 和 repair_zone 未相邻
Expected: Checkpoint A 失败 (doorAccessPenalty 扣 500 分)

Code location: tests/integration/checkpointA.test.js
```

### 用例 2: 形状违规惩罚
```
Test: 房间长宽比 = 4.5（超过 3.0 阈值）
Expected: -2000 惩罚，可能导致 Checkpoint B 排名下降

Code location: tests/unit/scorer.test.js::computeAspectRatioPenalty
```

### 用例 3: 多样性约束
```
Test: 9 个方案中 6 个相似度 > 阈值
Expected: 后排方案被 -diversityPenalty 惩罚，排名重新调整

Code location: tests/integration/ag42.test.js
```

---

## 常见问题排查

**Q: 为什么我的方案通不过 Checkpoint A?**

A: 检查以下硬性红线:
1. 所有房间都放置了吗? (computeMissingRoomsPenalty)
2. MUST 对都相邻吗? (parking↔repair_zone, trafo1↔trafo2, etc.)
3. 外墙约束房间都接触外墙了吗? (EXT_ACCESS: trafo, meter, fire_equip)

调试: 启用 evaluateCheckpointA 的详细日志,查看具体违规项

---

**Q: 为什么 Phase 2 中方案排名变化很大?**

A: Phase 2 引入 Tier 2 评分，空间效率和形状质量现在影响排名
- 高效率布局会获得更高分
- 形状好的方案不再被过度惩罚

调试: 对比 Phase 1 和 Phase 2 的评分，观察 Tier 2 贡献

---

**Q: 如何微调方案排名?**

A: 调整 scorer-params.js 中的权重参数:
- 增加 `efficiencyMaxBonus` → 偏好高效布局
- 减少 `aspectRatioPenalty` → 容忍更宽的房间
- 增加 `corridorBonus` → 偏好走廊完整性

监控: 在 ag42 中对比参数调整前后的排名变化

---

## 参考文件

- `/src/layout/scorer.js` - 评分实现 (494 行)
- `/src/layout/scorer-params.js` - 可调参数 (137 行)
- `/src/layout/adjacency.js` - MUST/SHOULD 约束定义
- `/CODE_REVIEW_b803908.md` - 参数变更审查报告
