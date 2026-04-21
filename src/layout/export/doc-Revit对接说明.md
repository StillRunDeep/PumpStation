# Pump Room WebView 消息对接说明

本文档定义了 Revit 宿主 (C# / WPF) 与 WebView2 前端页面之间的 JSON 消息协议，用于泵站设计功能的参数预填与 BIM 模型生成。

---

## 1. 消息通道

在 WebView2 页面内：

- **前端发送给宿主 (Web -> Host):** 使用 `window.chrome.webview.postMessage(jsonString)`。
- **宿主发送给前端 (Host -> Web):** 前端通过 `window.chrome.webview.addEventListener('message', handler)` 进行监听。

---

## 2. Host -> Web 消息

### 2.1 预填参数消息 (pump-room-prefill)

当用户在聊天面板确认设计参数后，宿主向前端发送此消息以预填表单。

**消息格式：**

```json
{
  "type": "pump-room-prefill",
  "payload": {
    "requestId":        "uuid-string",
    "qTotal":           1.2,
    "vDesign":          500.0,
    "poolDepth":        4.5,
    "baseArea":         120.0,
    "zBottom":          -3.2,
    "zDischarge":       1.8,
    "workingPumpCount": 2,
    "sparePumpCount":   1
  }
}
```

**字段说明：**

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| requestId | string | 是 | 唯一请求标识符 (UUID) |
| qTotal | number | 是 | 最大总排量 (m3/s) |
| vDesign | number | 是 | 设计集水池容积 (m3) |
| poolDepth | number | 二选一* | 集水池深度 (m) |
| baseArea | number | 二选一* | 集水池底面积 (m2) |
| zBottom | number | 二选一** | 集水池底部标高 (mPD) |
| zDischarge | number | 二选一** | 排出管中心标高 (mPD) |
| workingPumpCount | int | 否 | 工作泵数量 |
| sparePumpCount | int | 否 | 备用泵数量 |

*\* poolDepth 与 baseArea 至少提供一个。*
*\*\* zBottom 与 zDischarge 至少提供一个。*

---

### 2.2 Revit 执行结果 (revit-result)

宿主在处理建模请求后反馈状态。

**消息格式：**

```json
{
  "type": "revit-result",
  "status": "completed",
  "requestId": "uuid-string",
  "message": "Pump room created successfully."
}
```

**字段说明：**

| 字段 | 类型 | 取值范围 | 说明 |
| :--- | :--- | :--- | :--- |
| type | string | "revit-result" | 固定消息类型 |
| status | string | "completed"/"error"/"queued" | 执行结果状态 |
| requestId | string | | 对应建模请求的 UUID |
| message | string | | 结果详细说明（用于 UI 显示） |

---

## 3. Web -> Host 消息 (create-pump-room)

前端完成计算并由用户触发建模时发送此消息。

**消息格式：**

```json
{
  "type": "create-pump-room",
  "payload": {
    "requestId": "uuid-string",
    "levels": [
      {
        "id": "ground",
        "name": "Ground Floor",
        "elevationMm": 0
      },
      {
        "id": "level1",
        "name": "Level 1",
        "elevationMm": 8500
      }
    ],
    "rooms": [ ... ],
    "walls": [ ... ],
    "doors": [ ... ],
    "slabs": [ ... ]
  }
}
```

### 3.1 Level (标高)

定义建筑内的楼层标高，供其他构件引用。

```json
{ "id": "level1", "name": "Level 1", "elevationMm": 8500 }
```

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| id | string | 是 | 唯一标高 ID (如 "ground", "level1") |
| name | string | 是 | 标高名称 |
| elevationMm | number | 是 | 标高的绝对绝对高度 (mm) |

### 3.2 Room (房间)

```json
{ "id": "ground-trafo1", "name": "中电变压器房1", "levelId": "ground" }
```

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| id | string | 是 | 唯一房间 ID |
| name | string | 是 | Revit 中的房间名称 |
| levelId | string | 是 | 关联的标高 ID |

### 3.3 Wall (墙体)

坐标单位均为毫米 (mm)。Z 轴为相对于关联标高的基础偏移。

```json
{
  "id":          "wall-01",
  "roomId":      "ground-trafo1",
  "startMm":     { "x": 0,    "y": 0, "z": 0 },
  "endMm":       { "x": 5000, "y": 0, "z": 0 },
  "thicknessMm": 200,
  "heightMm":    8500
}
```

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| id | string | 是 | 唯一墙体 ID |
| roomId | string | 是 | 所属房间 ID |
| startMm | Point3 | 是 | 墙体起点 (mm) |
| endMm | Point3 | 是 | 墙体终点 (mm) |
| thicknessMm | number | 是 | 墙体厚度 (mm) |
| heightMm | number | 是 | 墙体高度 (mm) |

### 3.4 Door (门)

```json
{
  "id":         "door-01",
  "wallId":     "wall-01",
  "widthMm":    900,
  "heightMm":   2100,
  "locationMm": { "x": 2500, "y": 0, "z": 0 }
}
```

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| id | string | 是 | 唯一门 ID |
| wallId | string | 是 | 宿主墙体 ID |
| widthMm | number | 是 | 门宽度 (mm) |
| heightMm | number | 是 | 门高度 (mm) |
| locationMm | Point3 | 是 | 在墙体上的插入点 (mm)，Z 为 Sill Height |

### 3.5 Slab (楼板)

楼板由 XY 平面上的闭合边界多边形定义。

```json
{
  "id":          "slab-ground",
  "roomId":      "ground-trafo1",
  "levelId":     "ground",
  "elevationMm": 0,
  "thicknessMm": 300,
  "boundaryMm": [
    { "x": 0,    "y": 0,    "z": 0 },
    { "x": 5000, "y": 0,    "z": 0 },
    { "x": 5000, "y": 4000, "z": 0 },
    { "x": 0,    "y": 4000, "z": 0 }
  ],
  "openings": []
}
```

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| id | string | 是 | 唯一楼板 ID |
| roomId | string | 是 | 关联房间 ID（用于标高定位参考） |
| levelId | string | 是 | 关联的标高 ID |
| elevationMm | number | 是 | 相对于关联标高的顶面高度偏移 (mm) |
| thicknessMm | number | 是 | 楼板厚度 (mm) |
| boundaryMm | Point3[] | 是 | 有序边界顶点（至少3个点） |
| openings | Opening[] | 否 | 楼板上的开洞（孔洞） |

---

### 3.6 几何生成规则

- **坐标系:** 统一使用毫米 (mm)。
- **显式标高定义:** 传输协议中通过 `levels` 数组显式定义各楼层的绝对高度，避免 Revit 插件预定义的硬编码错误。
- **相对高程 (Relative Z-Offset):** 所有几何元素（墙体、楼板、门）的 Z 坐标均相对于其所在房间关联的标高。目前默认偏移量均为 `0`。
- **标高分配:** 插件应根据 `levels` 定义在 Revit 中创建或匹配标高，并根据房间对象的 `levelId` 将其及下属构件分配到对应的标高上。
- **楼板生成:** 每一层会自动生成一个楼板，其边界 `boundaryMm` 为该层所有房间的最小外接矩形（Bounding Box）。
- **门墙匹配:** 门与其宿主墙的关联必须保证在同一楼层（通过 `roomId` 前缀校验）。

---

## 4. 辅助数据类型

### 4.1 Point3

```json
{ "x": 1000, "y": 2000, "z": 0 }
```

### 4.2 Opening

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| id | string | 是 | 唯一开洞 ID |
| boundaryMm | Point3[] | 是 | 开洞边界顶点 |

---

## 5. 参数配置文件 (PumpRoomPrefillMapping.json)

宿主端通过此配置文件驱动参数映射与校验规则：

- `requestIdFieldName`: 预填消息中的 ID 字段名。
- `requiredParameters`: 绝对必填参数列表。
- `requiredAnyOfGroups`: 逻辑“或”必填分组（如深度或面积）。
- `fieldMappings`: 宿主内部参数名与前端 Payload 字段名的映射关系。
