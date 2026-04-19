# AG4 模块更新日志 (CHANGELOG)

---

## v1.8 (2026-04-18)

### 约束关系变更

**MUST 约束对 (ADJACENCY_MUST) 从 2 对升级为 3 对**

| 约束对 | 原状态 | 新状态 | 原因 | 实现文件 |
|--------|--------|--------|------|---------|
| meter_main ↔ meter_sub | MUST | MUST | 水表房并排，共用外墙 | adjacency.js:14 |
| trafo1 ↔ trafo2 | MUST | MUST | 变压器相邻，方便母线连接 | adjacency.js:15 |
| **parking ↔ repair_zone** | **SHOULD** | **MUST** | **便于设备转运（b803908）** | **adjacency.js:16** |

**影响范围**:
- layout-generator.js: ag41 Phase 1 种子放置已覆盖
- scorer.js: computeDoorAccessPenalty() 已同步，parking/repair_zone 必须相邻
- 约束冲突已修复（CODE_REVIEW_b803908.md）

### 参数调整

**Aspect Ratio 形状约束加强（b803908）**

| 参数 | 前值 | 新值 | 变化 | 影响 |
|------|------|------|------|------|
| aspectRatioThreshold | 4 | 3 | 约束更严 | 长宽比≤3 才通过 |
| aspectRatioPenalty | 500 | 2000 | **4 倍增加** | ⚠️ **需要回归测试验证** |

**验证清单**:
- [ ] 至少 60% 的方案通过 Checkpoint A (参数变更后)
- [ ] 单个房间的平均扣分 < 1500
- [ ] 旧参数排名前 50 的方案排名变化 < 3 位（至少 80%）

**相关审查**: CODE_REVIEW_b803908.md

### 算法文档补充

新增两个详细的算法文档，每个 300+ 行，供新加入开发者快速上手：

1. **ALGORITHM_CONSTRAINT_GROWTH.md**
   - 约束生长三阶段算法详解
   - Phase 1: 种子放置 (权重图、采样策略)
   - Phase 2: L/U 扩展 (边界追踪、优先级排序)
   - Phase 3: 空隙填充 (贪心扩展)
   - 缓存优化和性能指标
   - 调试指南

2. **ALGORITHM_SCORING.md**
   - 三层评分框架（Tier 1/2/3）
   - Checkpoint A/B/C 定义和通过条件
   - 参数敏感性分析表
   - 8 个验证用例
   - 常见问题排查

### 代码文档更新

- **layout-generator.js**: 添加 30 行顶部文档，指向约束生长算法文档
- **scorer.js**: 添加 25 行顶部文档，指向评分规则文档及参数风险标记

---

## v1.7 (之前版本)

- 引入拓扑非交叉共享可达性验证 (Checkpoint A 宽松验证机制)
- 定义 MUST 约束对: meter_main↔meter_sub, trafo1↔trafo2
- 初始评分体系 (Tier 1/2/3)
- 多样性惩罚机制

---

## 依赖更新追踪

### 相关 Issues / PRs

- **PR #49 (b803908)**: 参数调整 (parking↔repair_zone MUST 升级，aspectRatioPenalty 4 倍增)
- **Code Review**: CODE_REVIEW_b803908.md (审查和修复报告)

### 影响的系统组件

| 组件 | 文件 | 修复状态 | 备注 |
|------|------|---------|------|
| Constraint Definition | adjacency.js | ✅ 已更新 | MUST 对升级 |
| Scoring Logic | scorer.js | ✅ 已修复 | parking/repair_zone 逻辑同步 |
| Constraint Growth | layout-generator.js | ✅ 已验证 | Phase 1 已处理新约束 |
| UI Panel | layout-panel.js | ✅ 无需改动 | 评分机制兼容 |

---

## 下周计划

- [ ] 运行参数变更回归测试
  - 生成 ≥ 100 个随机布局
  - 验证 Checkpoint A 通过率 ≥ 60%
  - 记录评分分布对比

- [ ] 建立单元测试
  - 验证 parking↔repair_zone 强制相邻性
  - 验证 aspectRatioPenalty 扣分合理性
  - 添加 Checkpoint 通过条件测试

- [ ] 更新相关文档
  - 官方 AG4-3 评价文档 (02模块设计/) 同步参数值
  - 更新 README 中的约束列表

---

## 参考

- **审查报告**: CODE_REVIEW_b803908.md
- **约束生长算法**: ALGORITHM_CONSTRAINT_GROWTH.md
- **评分规则**: ALGORITHM_SCORING.md
- **约束定义**: src/layout/adjacency.js
- **评分参数**: src/layout/scorer-params.js
