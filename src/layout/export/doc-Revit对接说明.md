# Pump Room WebView 消息对接说明

本文档用于前端与 Revit 插件做消息联调，覆盖：

- Host -> Web（预填参数、执行结果）
- Web -> Host（提交建模数据）
- 参数配置文件驱动规则（必填、二选一、字段映射）

---

## 1. 消息通道

在 WebView2 页面内：

- 前端发给 Host：`window.chrome.webview.postMessage(...)`
- Host 发给前端：监听 `window.chrome.webview.addEventListener('message', handler)`

建议前端统一处理 `event.data`（对象）即可。

---

## 2. Host -> Web 消息

## 2.1 预填参数消息（聊天参数收集完整后发送）

`type = "pump-room-prefill"`

```json
{
  "type": "pump-room-prefill",
  "payload": {
    "requestId": "a8c9...",
    "qTotal": 1.2,
    "vDesign": 500.0,
    "poolDepth": 4.5,
    "zBottom": -3.2,
    "workingPumpCount": 2,
    "sparePumpCount": 1
  }
}
```

说明：

- `payload` 字段名由配置文件 `PumpRoomPrefillMapping.json` 决定。
- 当前规则：
  - 必填：`qTotal`、`vDesign`
  - 二选一组：`poolDepth | baseArea`
  - 二选一组：`zBottom | zDischarge`
  - 可选：`workingPumpCount`、`sparePumpCount`

---

## 2.2 Revit 执行状态消息

`type = "revit-result"`

```json
{
  "type": "revit-result",
  "status": "queued|completed|error",
  "requestId": "a8c9...",
  "message": "Request accepted."
}
```

常见 `status`：

- `queued`：Host 已接收前端建模请求
- `completed`：Revit 建模完成
- `error`：校验失败/建模异常

---

## 3. Web -> Host 消息

前端提交建模请求时，必须发送：`type = "create-pump-room"`

```json
{
  "type": "create-pump-room",
  "payload": {
    "requestId": "a8c9...",
    "rooms": [
      {
        "id": "room-001",
        "name": "泵房"
      }
    ],
    "walls": [
      {
        "id": "wall-001",
        "roomId": "room-001",
        "startMm": { "x": 0, "y": 0, "z": 0 },
        "endMm": { "x": 6000, "y": 0, "z": 0 },
        "thicknessMm": 200,
        "heightMm": 3000
      }
    ],
    "doors": [
      {
        "id": "door-001",
        "wallId": "wall-001",
        "widthMm": 900,
        "heightMm": 2100,
        "locationMm": { "x": 1200, "y": 0, "z": 0 }
      }
    ]
  }
}
```

约束：

- `rooms` 至少 1 项
- `walls` 至少 1 项
- `doors` 可选
- `room.id / room.name` 必填
- `wall.id / wall.roomId / wall.startMm / wall.endMm / wall.thicknessMm / wall.heightMm` 必填
- `door.id / door.wallId / door.widthMm / door.heightMm / door.locationMm`（如果提供 door）必填
- 点坐标统一为毫米：`{x,y,z}`

---

## 4. 前端建议处理流程

1. 监听 `pump-room-prefill`，将 `payload` 回填到 UI。
2. 用户点击“计算/确认”后，生成几何数据（rooms/walls/doors）。
3. 使用 `create-pump-room` 发回 Host。
4. 监听 `revit-result`，根据 `queued/completed/error` 更新页面提示。

---

## 5. 配置文件（字段映射）

位置：`PumpRoomPrefillMapping.json`

可配置内容：

- `requestIdFieldName`：预填消息中 requestId 字段名
- `requiredParameters`：绝对必填
- `requiredAnyOfGroups`：二选一（或多选一）分组
- `requiredParameterExamples`：缺参提示示例
- `fieldMappings`：后端参数名 -> 前端 payload 字段名

前端字段若需改名，只要双方约定并同步 `fieldMappings` 即可，无需改工具代码逻辑。
