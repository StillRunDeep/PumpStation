# 参数变更验证测试计划 (b803908)

**目标**: 验证 parking↔repair_zone MUST 升级和 aspectRatioPenalty 4 倍增加的影响

**优先级**: P0 - 必须在合并 PR #49 前完成

---

## 测试环境设置

### 前置条件

```bash
# 检出 b803908 前的版本
git checkout 83d6944

# 运行完整方案生成，记录基线数据
npm run test:baseline > baseline_scores.json

# 检出 b803908 版本
git checkout b803908

# 运行相同配置，记录新数据
npm run test:current > current_scores.json
```

### 基线配置

建筑参数（保持一致）:
- buildingWidth: 25000mm
- buildingDepth: 15000mm
- 入口位置: (12500mm, 15000mm)

生成配置:
- 样本数: ≥ 100 个随机方案
- 随机种子: 固定值（可重现）

---

## 测试用例清单

### Test 1: MUST 约束强制性

**目标**: 验证 parking↔repair_zone 必须相邻，不允许分离

**实现方式**:
```javascript
// tests/integration/must_constraint_parking.test.js

describe('MUST constraint: parking ↔ repair_zone', () => {
  test('违反 MUST 约束的方案应通不过 Checkpoint A', () => {
    // 人工构造 parking 和 repair_zone 不相邻的布局
    const badLayout = {
      groundPlacements: {
        parking: { x: 0, y: 0, w: 2500, d: 2000 },
        repair_zone: { x: 10000, y: 10000, w: 2000, d: 2500 }
        // 距离 > 10000mm，明显不相邻
      }
    }
    
    // 评分
    const result = evaluateCheckpointA(badLayout)
    
    // 应该失败
    expect(result.passes).toBe(false)
    expect(result.doorAccessCount).toBeGreaterThan(0)
    expect(result.doorAccess).toBeLessThan(0)  // 有惩罚
  })
  
  test('满足 MUST 约束的方案应通过 Checkpoint A', () => {
    const goodLayout = {
      groundPlacements: {
        parking: { x: 5000, y: 5000, w: 3000, d: 2000 },
        repair_zone: { x: 8500, y: 5000, w: 2000, d: 2500 }
        // 共享边界，满足相邻条件
      }
    }
    
    const result = evaluateCheckpointA(goodLayout)
    expect(result.passes).toBe(true)
  })
})
```

**验收标准**:
- ✅ 相邻的 parking/repair_zone 通过 Checkpoint A
- ✅ 分离的 parking/repair_zone 失败，扣 doorAccessPenalty (500)

---

### Test 2: Aspect Ratio 惩罚校验

**目标**: 验证 aspectRatioPenalty 4 倍增加后的扣分合理性

**实现方式**:
```javascript
// tests/unit/scorer_aspect_ratio.test.js

describe('computeAspectRatioPenalty with b803908 params', () => {
  test('单个长宽比违规房间扣分 = 2000', () => {
    const result = {
      groundPlacements: {
        trafo1: {
          x: 0, y: 0,
          w: 5000,  // 5m
          d: 1000,  // 1m
          // aspect ratio = 5, 超过阈值 3
        }
      },
      level1Placements: {}
    }
    
    const penalty = computeAspectRatioPenalty(result)
    
    expect(penalty.violations.length).toBeGreaterThan(0)
    expect(penalty.violationCount).toBe(1)
    expect(penalty.penalty).toBe(-2000)  // 新参数
  })
  
  test('多维度违规应累加扣分', () => {
    // 长宽比 + 利用率低 + 顶点多
    const result = {
      groundPlacements: {
        meter_main: {
          x: 0, y: 0,
          w: 6000,  // aspect ratio > 3 ✗
          d: 1500,
          actualArea: 4000,  // utilization < 70% ✗
          vertices: 8  // 超过阈值 6 ✗
        }
      },
      level1Placements: {}
    }
    
    const penalty = computeAspectRatioPenalty(result)
    
    // 三个维度各 1 次违规
    expect(penalty.violationCount).toBe(3)
    expect(penalty.penalty).toBe(-6000)  // 3 × 2000
  })
})
```

**验收标准**:
- ✅ 单个违规扣 2000
- ✅ 多维度违规正确累加
- ✅ 单房间扣分不超过 6000 (为合理范围)

---

### Test 3: Checkpoint A 通过率

**目标**: 验证整体通过率是否在可接受范围（≥ 60%）

**实现方式**:
```javascript
// tests/integration/checkpoint_a_pass_rate.test.js

describe('Checkpoint A pass rate after b803908', () => {
  test('100+ 个随机方案至少 60% 通过 Checkpoint A', () => {
    const schemes = generateRandomSchemes(100)  // 100 个随机布局
    
    let passCount = 0
    const results = schemes.map(scheme => {
      const eval = evaluateCheckpointA(scheme)
      if (eval.passes) passCount++
      return eval
    })
    
    const passRate = passCount / schemes.length
    console.log(`Checkpoint A pass rate: ${passRate * 100}%`)
    
    // 验收标准
    expect(passRate).toBeGreaterThanOrEqual(0.60)
  })
})
```

**运行命令**:
```bash
npm test -- --testNamePattern="Checkpoint A pass rate"
```

**输出示例**:
```
Checkpoint A pass rate: 68.5%  ✅ PASS (>= 60%)
```

---

### Test 4: 排名稳定性

**目标**: 验证参数变更前后的排名是否发生大幅波动

**实现方式**:
```javascript
// tests/integration/ranking_stability.test.js

describe('Ranking stability after b803908', () => {
  test('前 50 名方案排名变化应 < 3 位，至少 80% 满足', () => {
    // 1. 在旧参数下生成和排名 100 个方案
    const oldSchemes = generateSchemes(100)
    const oldRanking = scoreAndRank(oldSchemes, OLD_PARAMS)
    
    // 2. 使用新参数重新评分同样的 100 个方案
    const newRanking = scoreAndRank(oldSchemes, NEW_PARAMS)
    
    // 3. 对比前 50 的排名变化
    const top50Old = oldRanking.slice(0, 50)
    let stableCount = 0
    
    for (const scheme of top50Old) {
      const oldRank = oldRanking.indexOf(scheme)
      const newRank = newRanking.indexOf(scheme)
      const rankChange = Math.abs(newRank - oldRank)
      
      if (rankChange < 3) {
        stableCount++
      }
    }
    
    const stabilityRatio = stableCount / 50
    console.log(`Ranking stability: ${stabilityRatio * 100}%`)
    
    expect(stabilityRatio).toBeGreaterThanOrEqual(0.80)
  })
})
```

**验收标准**:
- ✅ 至少 80% 的前 50 名方案排名变化 < 3 位
- 🟡 排名变化 3～5 位: 需人工审查
- ❌ 排名变化 > 5 位: 参数调整过度

---

### Test 5: 形状违规分布

**目标**: 分析参数变更对形状违规的影响

**实现方式**:
```javascript
// tests/analysis/aspect_ratio_distribution.js

function analyzeAspectRatioViolations() {
  const schemes = generateSchemes(100)
  
  const violations = {
    old: [],  // b803908 前
    new: []   // b803908 后
  }
  
  schemes.forEach(scheme => {
    // 旧参数
    const oldPenalty = computeAspectRatioPenalty(scheme, OLD_PARAMS)
    violations.old.push({
      count: oldPenalty.violationCount,
      penalty: oldPenalty.penalty
    })
    
    // 新参数
    const newPenalty = computeAspectRatioPenalty(scheme, NEW_PARAMS)
    violations.new.push({
      count: newPenalty.violationCount,
      penalty: newPenalty.penalty
    })
  })
  
  // 统计
  const avgOld = violations.old.reduce((s, v) => s + Math.abs(v.penalty), 0) / 100
  const avgNew = violations.new.reduce((s, v) => s + Math.abs(v.penalty), 0) / 100
  
  console.log(`
  形状违规平均扣分:
  - 旧参数: ${avgOld.toFixed(0)} 分
  - 新参数: ${avgNew.toFixed(0)} 分
  - 增幅: ${((avgNew / avgOld - 1) * 100).toFixed(1)}%
  `)
  
  // 风险判断
  if (avgNew > 1500) {
    console.warn('⚠️  形状违规扣分过高，可能需要调整参数')
  }
}
```

**输出示例**:
```
形状违规平均扣分:
- 旧参数: 450 分
- 新参数: 1200 分
- 增幅: 166.7%

⚠️  形状违规扣分过高，可能需要调整参数
```

---

## 回归测试执行步骤

### Step 1: 设置基线

```bash
# 检出旧版本，运行一次生成和评分
git checkout 83d6944
npm run generate:baseline -- --count=100 > baseline.json
```

### Step 2: 运行新参数测试

```bash
# 检出新版本，使用相同配置
git checkout b803908
npm run test:validation
```

### Step 3: 对比分析

```bash
# 生成对比报告
npm run analyze:comparison -- baseline.json current.json > report.md
```

### Step 4: 审查结果

打开 `report.md` 检查关键指标:
- ✅ Checkpoint A 通过率
- ✅ 排名稳定性
- ✅ 形状违规分布
- ✅ 整体评分变化

---

## 验收准则

| 指标 | 验收标准 | 状态 |
|------|---------|------|
| **Checkpoint A 通过率** | ≥ 60% | ⏳ 待测试 |
| **排名稳定性** | 前 50 中 ≥ 80% 变化 < 3 位 | ⏳ 待测试 |
| **形状违规平均扣分** | < 1500 分 | ⏳ 待测试 |
| **MUST 约束强制性** | parking/repair_zone 必须相邻 | ✅ 代码验证通过 |

**整体判断**:
- 所有指标通过 → **绿灯**，可合并 PR
- 1～2 项指标在警戒线 → **黄灯**，需调整参数或继续监控
- 3 项及以上指标不通过 → **红灯**，回滚参数调整

---

## 后续行动

### 如果通过
```
[ ] 合并 PR #49
[ ] 更新 AG4 文档版本标记
[ ] 发布测试报告
```

### 如果不通过
```
[ ] 调整 aspectRatioPenalty (考虑 1500 或 1200)
[ ] 重新运行测试
[ ] 记录调整原因在 CODE_REVIEW_b803908.md
```

---

## 参考

- CODE_REVIEW_b803908.md - 参数变更审查报告
- ALGORITHM_SCORING.md - 评分规则详解
- 测试框架位置: `/tests/`
