**视觉检查通常比原始JSON更有帮助**。在每个阶段生成SVG并在浏览器中对比：

```bash
for phase in 1 2 3; do node src/layout/generator/debug-runner.js --case simple_rect --phase $phase --visualize src/layout/debug/"phase${phase}.svg"; done
```

# 布局生成调试指南（阶段2和阶段3）

本指南说明如何使用调试框架测试和优化约束生长布局生成器中的**阶段2（L/U形扩展）**和**阶段3（缝隙填充）**算法。

## 快速开始

### 基本用法

运行预定义的测试用例：
```bash
node src/layout/generator/debug-runner.js --case simple_rect
```

生成输出文件（JSON + SVG）：
```bash
node src/layout/generator/debug-runner.js \
  --case must_pair_trafo \
  --output out.json \
  --visualize out.svg
```

### 启用日志调试

启用详细的阶段2日志：
```bash
DEBUG_LAYOUT=phase2 node src/layout/generator/debug-runner.js --case simple_rect
```

同时启用阶段2和阶段3日志：
```bash
DEBUG_LAYOUT=phase2,phase3 node src/layout/generator/debug-runner.js --case must_pair_trafo
```

### 运行特定阶段

`--phase` 参数允许你在特定阶段后停止执行并查看中间结果：

```bash
# 仅运行阶段1（矩形扩展）
node src/layout/generator/debug-runner.js --case must_pair_trafo --phase 1 --visualize phase1.svg

# 仅运行到阶段2（L/U形扩展）
DEBUG_LAYOUT=phase2 node src/layout/generator/debug-runner.js --case must_pair_trafo --phase 2 --visualize phase2.svg

# 完整执行（阶段1 → 2 → 3）
node src/layout/generator/debug-runner.js --case must_pair_trafo --phase 3 --visualize phase3.svg
```

**并排对比阶段结果：**
```bash
node src/layout/generator/debug-runner.js --case must_pair_trafo --phase 1 --output phase1.json --visualize phase1.svg
node src/layout/generator/debug-runner.js --case must_pair_trafo --phase 2 --output phase2.json --visualize phase2.svg
node src/layout/generator/debug-runner.js --case must_pair_trafo --phase 3 --output phase3.json --visualize phase3.svg

# 对比JSON输出
diff phase1.json phase2.json
diff phase2.json phase3.json
```

## 测试用例

预定义的测试用例位于 `debug-cases.json`：

| 用例 | 楼层 | 建筑尺寸 | 用途 |
|------|------|--------|------|
| `simple_rect` | 地面 | 30m × 20m | 基础矩形布局验证 |
| `must_pair_trafo` | 地面 | 35m × 22m | 测试变压器1↔变压器2协同生长分割 |
| `must_pair_meter` | 地面 | 32m × 21m | 测试水表主↔水表副MUST邻接对 |
| `level1_layout` | 一层 | 40m × 25m | 测试走廊可达性和L/U形扩展 |

运行所有测试用例：
```bash
node src/layout/generator/debug-runner.js --all-cases --validate
```

## 输出文件

### JSON输出（`--output file.json`）

包含以下内容：
- `seed`: 使用的随机种子
- `floor`: 地面或一层
- `buildingW`, `buildingD`: 建筑尺寸（毫米）
- `generatedAt`: 时间戳
- `elapsedMs`: 生成耗时（毫秒）
- `rooms`: 房间数据，包括尺寸、面积、顶点数、利用率
- `violations`: 约束违规（如果有）
- `debugLog`: 详细的阶段日志
- `stopPhase`: 执行停止的阶段（1、2或3）

示例：
```json
{
  "seed": 42,
  "floor": "ground",
  "stopPhase": 2,
  "rooms": {
    "trafo1": {
      "id": "trafo1",
      "label": "中电变压器房1",
      "x": 0, "y": 1000,
      "w": 11000, "d": 19000,
      "actualArea": 209000000,
      "vertices": 4,
      "utilization": 1.0
    }
  },
  "debugLog": [...]
}
```

### SVG输出（`--visualize file.svg`）

调试可视化显示：
- 建筑边界（黑色轮廓）
- 网格背景（2m间距，淡色）
- 房间矩形（彩色，半透明）
- 房间ID标签
- 顶点计数和利用率百分比
- 房间面积（平方米）
- 包含布局元数据的信息框

用任何浏览器或SVG查看器打开。

## 约束验证

验证约束合规性：
```bash
node src/layout/generator/debug-runner.js \
  --case must_pair_trafo \
  --validate
```

检查项：
- ✅ 房间重叠检测
- ✅ 顶点数限制（最多8个，除走廊外）
- ✅ 利用率比例（最少60%）
- ✅ 约束违规

## 命令行选项参考

```bash
node src/layout/generator/debug-runner.js [选项]

选项：
  --case <名称>          运行预定义的测试用例
                         (simple_rect, must_pair_trafo, must_pair_meter, level1_layout)
  --seed <数字>          随机种子（1-2147483647）
  --floor <楼层>         目标楼层（ground或level1；默认：ground）
  --phase <1|2|3>        在特定阶段后停止（1=矩形, 2=L/U, 3=全部；默认：3）
  --output <文件>        保存JSON布局到文件
  --visualize <文件>     生成SVG可视化
  --log-level <级别>     日志详细程度（terse, normal, verbose；默认：normal）
  --all-cases            运行所有4个预定义测试用例
  --validate             检查约束合规性
  --help, -h             显示帮助信息

环境变量：
  DEBUG_LAYOUT=phase2,phase3   为阶段2和/或阶段3启用日志
  DEBUG_MODE=true              启用性能计时分解
  TIME_THRESHOLD=N             当任何阶段耗时 > N秒时发出警告
```

## 调试日志格式

### 阶段2日志（L/U形扩展）

格式：
```
[Phase2] <消息> { roomId, type, cellsAdded, ... }
```

示例：
```
[Phase2] Priority 1: trafo1 (45% area, accessibility=false)
[Phase2] trafo1 L/U fill expansion: 24 cells
[Phase2] trafo2 smart line expansion: 0 cells
```

关键字段：
- `roomId`: 正在扩展的房间
- `type`: `fillExpansion`（面积补偿扩展）或 `smartLineExpansion`（智能线条扩展）
- `cellsAdded`: 添加的网格单元数
- `areaPercent`: 当前面积完成百分比
- `accessibility`: 是否满足可达性要求

### 阶段3日志（缝隙填充）

格式：
```
[Phase3] <消息> { data... }
```

示例：
```
[Phase3] fillGaps started: 145 empty cells
[Phase3] Assign segment to meter_main: cellsAdded=12, score=1250.5
[Phase3] No more filling candidates found: remainingEmptyCells=5
```

关键字段：
- `cellsAdded`: 本次迭代分配的网格单元数
- `score`: 此段分配的算法评分
- `remainingEmptyCells`: 剩余的空网格单元数

## 阶段特定分析

### 理解阶段输出

**阶段1**（矩形扩展）：
- 房间从种子位置向外以矩形方式扩展
- 目标：达到约50-70%的利用率
- 输出：`_debug`中的 `gridAfterRect` 快照

**阶段2**（带面积约束的L/U形扩展）：
- 房间在面积目标内继续以L/U形方式扩展
- 目标：在遵守最大顶点数的同时填充剩余空间至70%+利用率
- 输出：`_debug`中的 `gridBeforeGaps` 快照
- 检查点B评估在本阶段后进行

**阶段3**（无面积约束的缝隙填充）：
- 无限制扩展：房间超越初始目标以填充可用空间
- 超级房间分割为组成房间
- 目标：最大化空间利用并最小化碎片化
- 输出：`_debug`中的 `gridAfterGaps` 快照

### 识别瓶颈

使用 `--phase` 隔离哪个阶段造成问题：

```bash
# 如果阶段2结果看起来不错但阶段3破坏了布局：
DEBUG_LAYOUT=phase2,phase3 node debug-runner.js --case test --phase 2 --output p2.json
DEBUG_LAYOUT=phase2,phase3 node debug-runner.js --case test --phase 3 --output p3.json

# 对比房间形状（顶点数、利用率）：
jq '.rooms[] | {id, vertices, utilization}' p2.json
jq '.rooms[] | {id, vertices, utilization}' p3.json
```

### SVG对比

**视觉检查通常比原始JSON更有帮助**。在每个阶段生成SVG并在浏览器中对比：

```bash
for phase in 1 2 3; do node src/layout/generator/debug-runner.js --case simple_rect --phase $phase --visualize src/layout/debug/"phase${phase}.svg"; done
# 在浏览器中并排打开 phase1.svg, phase2.svg, phase3.svg
```

## 故障排除

### 问题：JSON输出中"Rooms: 0"

**原因**：房间放置提取失败  
**解决方案**：检查 `generateConstrainedLayout()` 是否返回有效的 `groundPlacements` 或 `level1Placements`

### 问题：没有调试日志出现

**原因**：`window.debugLayoutPhase2/3` 标志未设置  
**解决方案**：使用环境变量：
```bash
DEBUG_LAYOUT=phase2,phase3 node debug-runner.js --case test
```

### 问题：SVG显示不正确或不完整

**原因**：房间坐标或尺寸无效  
**解决方案**：检查JSON输出中是否有NaN或负值

## 性能监测

跟踪生成耗时：
```bash
DEBUG_MODE=true node src/layout/generator/debug-runner.js --case test
```

输出显示性能分解：
```
Performance breakdown:
  expandRooms/phase2_ground/findBestRect: 0.045s
  expandRooms/phase2_ground/findBestFill: 2.123s
  fillGaps: 0.087s
```

**性能目标：**
- 阶段2：每个方案 < 5秒
- 阶段3：每个方案 < 1秒

## 修改算法

### 添加新的调试点

在 `layout-generator.js` 中使用 `debugLog()` 函数：

```javascript
if (window.debugLayoutPhase2) {
  debugLog(2, '房间扩展决策', {
    roomId: room.id,
    currentArea: room.currentArea,
    targetArea: room.targetGridCount,
    expansionType: 'rectangular'
  });
}
```

### 测试算法变更

1. 在 `layout-generator.js` 中进行代码更改
2. 使用日志运行测试用例：
   ```bash
   DEBUG_LAYOUT=phase2,phase3 node debug-runner.js --case must_pair_trafo --output new.json --visualize new.svg
   ```
3. 与基准进行对比：
   ```bash
   # 变更前
   node debug-runner.js --case must_pair_trafo --output baseline.json
   
   # 变更后，对比
   diff baseline.json new.json
   diff baseline.svg new.svg (在浏览器中视觉对比)
   ```

## 与Web UI集成

debug-runner是独立的，**不会**修改Web UI。如需在UI中测试变更：

1. 确保变更向后兼容（所有调试标志都有安全默认值）
2. 使用Web UI的"生成布局"按钮测试
3. 在浏览器控制台检查 `window.layoutDebugLog`

## 文件结构

```
src/layout/generator/
├── debug-runner.js         # 独立测试工具
├── debug-cases.json        # 测试用例定义
├── DEBUG-GUIDE.md          # 本文件
└── layout-generator.js     # 核心算法（带调试钩子）
```

## 相关文档

- `doc-约束生长算法.md` - 算法设计和理论
- `doc-评价体系.md` - 约束验证系统
- 计划文件：`/Users/miaoyixin/.claude/plans/src-layout-generator-...md`
