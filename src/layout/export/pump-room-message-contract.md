# Pump Room Skill - WebView Message Contract

This document defines the JSON message protocol between the Revit host
(C# / WPF) and the WebView2 frontend page for the pump room design Skill.

---

## 1. Host -> WebView: Prefill Parameters

Sent after the user confirms in the Chat panel. The frontend pre-populates
its form with the collected design parameters.

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

| Field            | Type   | Required | Description                      |
|------------------|--------|----------|----------------------------------|
| requestId        | string | yes      | Unique request identifier (UUID) |
| qTotal           | number | yes      | Max total drainage flow (m3/s)   |
| vDesign          | number | yes      | Design tank volume (m3)          |
| poolDepth        | number | one of*  | Sump pit depth (m)               |
| baseArea         | number | one of*  | Sump pit base area (m2)          |
| zBottom          | number | one of** | Pit bottom elevation (mPD)       |
| zDischarge       | number | one of** | Discharge pipe elevation (mPD)   |
| workingPumpCount | int    | no       | Number of working pumps          |
| sparePumpCount   | int    | no       | Number of standby pumps          |

*  At least one of poolDepth / baseArea is required.
** At least one of zBottom / zDischarge is required.

---

## 2. WebView -> Host: Create BIM Model

Sent when the frontend calculation is complete and the user triggers
BIM model generation.

```json
{
  "type": "create-pump-room",
  "payload": {
    "requestId": "uuid-string",
    "rooms": [ ... ],
    "walls": [ ... ],
    "doors": [ ... ],
    "slabs": [ ... ]
  }
}
```

---

### 2.1 Room

```json
{ "id": "room-01", "name": "Pump Room" }
```

| Field | Type   | Required | Description        |
|-------|--------|----------|--------------------|
| id    | string | yes      | Unique room ID     |
| name  | string | yes      | Room name in Revit |

---

### 2.2 Wall

All coordinates in millimetres. Z is the base offset from the level.

```json
{
  "id":          "wall-01",
  "roomId":      "room-01",
  "startMm":     { "x": 0,    "y": 0, "z": 0 },
  "endMm":       { "x": 5000, "y": 0, "z": 0 },
  "thicknessMm": 300,
  "heightMm":    3000
}
```

| Field       | Type   | Required | Description             |
|-------------|--------|----------|-------------------------|
| id          | string | yes      | Unique wall ID          |
| roomId      | string | yes      | Parent room ID          |
| startMm     | Point3 | yes      | Wall start point (mm)   |
| endMm       | Point3 | yes      | Wall end point (mm)     |
| thicknessMm | number | yes      | Wall thickness > 0 (mm) |
| heightMm    | number | yes      | Wall height > 0 (mm)    |

---

### 2.3 Door

```json
{
  "id":         "door-01",
  "wallId":     "wall-01",
  "widthMm":    900,
  "heightMm":   2100,
  "locationMm": { "x": 2500, "y": 0, "z": 0 }
}
```

| Field      | Type   | Required | Description                  |
|------------|--------|----------|------------------------------|
| id         | string | yes      | Unique door ID               |
| wallId     | string | yes      | Host wall ID                 |
| widthMm    | number | yes      | Door width > 0 (mm)          |
| heightMm   | number | yes      | Door height > 0 (mm)         |
| locationMm | Point3 | yes      | Insertion point on wall (mm) |

---

### 2.4 Slab

A slab is defined by a closed boundary polygon on the XY plane at a given
elevation. One or more openings (holes) can be cut into the slab by
providing additional boundary polygons in the `openings` array.

```json
{
  "id":          "slab-01",
  "roomId":      "room-01",
  "elevationMm": 3000,
  "thicknessMm": 200,
  "boundaryMm": [
    { "x": 0,    "y": 0,    "z": 0 },
    { "x": 5000, "y": 0,    "z": 0 },
    { "x": 5000, "y": 4000, "z": 0 },
    { "x": 0,    "y": 4000, "z": 0 }
  ],
  "openings": [
    {
      "id": "opening-01",
      "boundaryMm": [
        { "x": 1000, "y": 1000, "z": 0 },
        { "x": 2000, "y": 1000, "z": 0 },
        { "x": 2000, "y": 2000, "z": 0 },
        { "x": 1000, "y": 2000, "z": 0 }
      ]
    }
  ]
}
```

#### Slab Fields

| Field       | Type          | Required | Description                           |
|-------------|---------------|----------|---------------------------------------|
| id          | string        | yes      | Unique slab ID                        |
| roomId      | string        | yes      | Parent room ID                        |
| elevationMm | number        | yes      | Top face elevation from level (mm)    |
| thicknessMm | number        | yes      | Slab thickness > 0 (mm)              |
| boundaryMm  | Point3 array  | yes      | Ordered boundary vertices, min 3 pts  |
| openings    | Opening array | no       | Openings (holes) cut into the slab    |

#### Opening Fields

| Field      | Type         | Required | Description                           |
|------------|--------------|----------|---------------------------------------|
| id         | string       | yes      | Unique opening ID                     |
| boundaryMm | Point3 array | yes      | Ordered boundary vertices, min 3 pts  |

#### Rules

- `boundaryMm` Z values are ignored. Elevation comes from `elevationMm`.
- Vertices must be ordered consistently (CW or CCW).
- Opening polygons must lie fully within the slab boundary.
- Multiple openings per slab are supported.

---

### 2.5 Point3

```json
{ "x": 1000, "y": 2000, "z": 0 }
```

| Field | Type   | Required | Description       |
|-------|--------|----------|-------------------|
| x     | number | yes      | X coordinate (mm) |
| y     | number | yes      | Y coordinate (mm) |
| z     | number | yes      | Z coordinate (mm) |

---

## 3. Host -> WebView: Result Callback

```json
{
  "type":      "revit-result",
  "status":    "completed",
  "requestId": "uuid-string",
  "message":   "Pump room created successfully."
}
```

| Field     | Type   | Values              | Description          |
|-----------|--------|---------------------|----------------------|
| type      | string | "revit-result"      | Fixed message type   |
| status    | string | "completed"/"error" | Execution result     |
| requestId | string |                     | Matches request UUID |
| message   | string |                     | Human-readable info  |
