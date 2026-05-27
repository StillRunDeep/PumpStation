# 泵站项目布局生成与评估系统概览
该系统旨在根据用户定义的建筑参数和房间需求，自动化生成并优化泵站的内部平面布局方案。它采用进化式算法结合多阶段生长与严格评估，以确保生成方案的合规性、功能性和空间质量。

## 1. 系统目标
根据建筑尺寸和房间列表，自动生成多种可能的平面布局。
通过定义邻接、可达性等约束条件，确保生成方案满足工程和功能需求。
通过多维度评分体系，评估和筛选出高质量的布局方案。
支持“草图模式”快速探索和“深化模式”精细优化。
## 2. 核心模块与职责
### src/layout/generator/layout-generator.js (布局生成器)

```javascript

职责： 核心的布局生成算法实现，负责房间的放置、生长和几何形态调整。
关键功能：
Grid 类：表示二维网格，管理房间单元格的占用。
placeRoomSeeds()：为房间确定初始种子位置，考虑权重和邻接约束。
mergeMustPairsForFloor() / splitSuperRoom()：实现 Super-room 机制，处理必须邻接房间的协同生长与分割。
expandRooms()：房间扩展的核心迭代函数，包含阶段 1（矩形扩展）和阶段 2（L/U 形填补扩展）。
findBestRectangleExpansion()：寻找最佳矩形扩展线段。
findBestFillExpansion()：寻找最佳 L/U 形填补扩展线段。
findSmartLineExpansion()：寻找智能凹角填充或边界简化线段。
fillGaps()：空隙填充算法，将剩余空单元格分配给相邻房间。
runAreaSwap() / runSpaceSwap()：阶段 3b 的空间交换优化算法，用于调整房间面积偏差和形状。
generateConstrainedLayout()：整体算法的入口点，协调各个阶段的执行，并根据 schemaLayout/detailedLayout 参数控制流程。
```
### src/layout/evaluation/scorer.js (评分器)

```javascript

职责： 定义多层次的布局方案评估体系，为生成方案打分和排序。
关键功能：
scoreHardRedlines()： Tier 1 评估，检查硬性红线约束（缺失房间、必须邻接、外部可达性）。
scoreSpatialQuality()： Tier 1 + Tier 2 评估，增加空间质量指标（长宽比、空间利用率、走廊接触）。用于 Checkpoint B 评估。
scoreLayout()： Tier 1 + Tier 2 + Tier 3 评估，涵盖所有指标（生长成功率、变压器放置、风机房距离、多样性等）。用于最终排名。
computeMissingRoomsPenalty() / computeDoorAccessPenalty() / computeAspectRatioPenalty() 等辅助函数：计算各项具体惩罚或奖励分数。
evaluateCheckpointA()： Checkpoint A 的增强版评估，包含红线指标和 UI 关键指标。
```
### src/agents/layout-build.js (生成代理)

```javascript

职责： 高层级的布局生成与优化流程编排，调用生成器和评分器来执行任务。
关键功能：
optimizeVariant()：优化单个布局方案的接口。
runAG41()：运行全量布局生成流程的入口，包括交叉进化、智能变异和随机探索等策略。
generateMutatedLayout()：基于父代方案进行变异，生成子代方案。
generateHybridLayout()：融合两个父代方案的“基因”（种子位置），生成杂交方案。
applyCheckpointB()：对方案列表执行 Checkpoint B 评估并排序，是 layout-build.js 中反复调用的关键评估点。
computeMutatedLayout()：计算变异提示，用于 UI 调试。
runPhase3Optimization()：针对现有方案执行阶段 3 优化。
```
## 3. 整体工作流程
### 用户输入 (layout-build.js -> layout-generator.js)：

通过 getUserConfirmedParams() 获取用户定义的建筑尺寸 (buildingW, buildingD) 和房间目标面积 (roomTargetAreas) 等参数。
### 预处理 (Phase 0 - 协同生长预处理，layout-generator.js)：

mergeMustPairsForFloor()：将必须邻接的房间（例如 trafo1 ↔ trafo2）合并为 Super-room。这些 Super-room 在生长阶段被视为单个单元，确保其内部不会被割裂。
buildSuperRoomMeta()：构建 Super-room 的可达性元数据。
### 房间放置 (Phase 1a - 种子放置，layout-generator.js)：

placeRoomSeeds()：为每个房间（包括 Super-room）在网格中选择一个初始的种子位置，考虑权重图、邻近已放置房间以及外墙等约束。
### 房间扩展 (Phase 1b - 矩形扩展，layout-generator.js)：

expandRooms() (参数 stopAfterStage1 = true 或 false, ignoreAreaLimit = false)：
阶段 1 (全局矩形扩展)：所有房间优先进行矩形生长。当任何房间都无法再进行矩形扩展时，此阶段结束。
Checkpoint A 评估 (scorer.js)： 在阶段 1 结束后，对当前网格快照 (gridAfterRect) 进行初步评估。此时，Super-room 会被克隆并分割还原为原始房间，然后通过 evaluateCheckpointA() 进行硬性红线（Tier 1）检查，包括缺失房间、必须邻接和外部可达性。这里使用 computeRelaxedDoorAccess() 进行宽松的可达性检查。
### L/U 形扩展 (Phase 2 - 形态降级与填补，layout-generator.js)：

expandRooms() (参数 stopAfterStage1 = false, ignoreAreaLimit = false)：
阶段 2 (L/U 形填补扩展)：允许房间进行非矩形生长，填补剩余面积，并解决可达性问题。会依次尝试 findBestRectangleExpansion、findBestFillExpansion 和 findSmartLineExpansion。此阶段考虑形态约束（顶点数、利用率）和走廊最小宽度。
Checkpoint B 评估 (scorer.js)： 在阶段 2 结束后，对当前网格快照 (gridBeforeGaps) 进行评估。Super-room 同样会克隆并分割还原。applyCheckpointB (layout-build.js 中调用) 会使用 scoreSpatialQuality() 进行 Tier 1 + Tier 2 评估，并对方案进行排序。
### 边界优化与空隙填充 (Phase 3 - 最终形态调整，layout-generator.js)：

此阶段主要在“深化模式”下执行，或者作为对 Checkpoint B 通过方案的进一步优化。
无面积限制扩展： expandRooms() (参数 ignoreAreaLimit = true)：允许房间在符合形态约束的前提下，自由侵占邻近空地，形成更自然舒展的边界。
空隙填充： fillGaps()：将建筑轮廓内所有剩余空隙分配给相邻房间，并平滑交界线。
Super-room 分割还原： 在所有生长和填充完成后，splitAllSuperRooms() 将所有 Super-room 完全还原为原始的房间对。
空间交换协商 (runAreaSwap, runSpaceSwap)： 阶段 3b 的优化，通过小块单元格的交换，进一步优化房间质量（长宽比、利用率、面积吻合度）。
### 最终布局生成与评分 (layout-generator.js -> scorer.js)：

finalizeLayout()：将网格中的房间信息转换为最终的布局对象，包含毫米单位的 x, y, w, d 以及 actualArea 和 vertices 等。
scoreLayout()：对最终布局方案进行全面评估 (Tier 1 + Tier 2 + Tier 3)，计算最终得分，用于方案的最终排名。
## 4. 模式区分
### 草图模式 (schemaLayout = true, detailedLayout = false)

*   目标： 快速生成大量通过基本约束检查的方案草图。
*   流程： 仅执行阶段 1 的矩形扩展，并在 Checkpoint A 后停止。不进行 L/U 形扩展和边界优化。
*   特点： 速度快，提供多样化的初始高潜力方案。
### 深化模式 (detailedLayout = true)

*   目标： 在现有方案的基础上，进行精细化的边界优化和全面生长。
*   流程：
    *   新生成： 执行完整的阶段 1、2、3 流程。
    *   优化现有： 优先从一个已完成阶段 2 的方案快照 (initialGrid 包含 `gridBeforeGaps`) 开始，直接进入阶段 3 的无面积限制扩展、空隙填充与 AreaSwap；若旧结果缺少 `gridBeforeGaps` 但保留了 `gridAfterRect`，则仅作为 legacy fallback 使用，从阶段 1 快照继续补齐后续阶段。
*   特点： 方案质量更高，细节更精细，但计算成本更高。
## 5. 进化策略 (layout-build.js)
runAG41() 函数实现了以下进化策略，以在多样性和质量之间取得平衡：

*   交叉进化 (Hybrid)：从现有精英方案中选择父代（例如 Top 1 和 Top 5），通过种子位置的交叉组合生成子代。
*   智能变异 (Mutated)：对现有方案进行局部修改，特别针对违规房间，智能地调整其种子位置。
*   随机探索 (Random)：生成纯随机方案，以跳出局部最优解，探索新的空间组织可能性。
*   筛选与排序： 每轮生成的新方案与旧方案合并，重新评分，并保留最佳方案。
整个系统通过模块化的设计、阶段性的处理流程和多维度的评估体系，实现了自动化、智能化的建筑平面布局生成与优化。