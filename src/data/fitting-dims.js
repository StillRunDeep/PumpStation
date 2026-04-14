// 管件尺寸查表 + 间距规则
// 参考标准：GB/T 12221-2005（法兰连接金属阀门 结构长度）、
//           GB/T 12459-2005（钢制对焊无缝管件）、
//           GB 50265-2022（泵站设计标准）

// ── 闸阀面对面尺寸（GB/T 12221 PN10 长型），单位：mm ──
export const GATE_VALVE_FF = {
  100: 229, 150: 267, 200: 292, 250: 330, 300: 356,
  400: 457, 500: 610, 600: 711, 700: 787, 800: 914, 1000: 991,
}

// ── 旋启式止回阀面对面尺寸（GB/T 12221），单位：mm ──
export const CHECK_VALVE_FF = {
  100: 203, 150: 267, 200: 292, 250: 356, 300: 381,
  400: 457, 500: 559, 600: 610, 700: 686, 800: 762, 1000: 991,
}

// ── 90° 长半径弯头中心到端面 = 1.5×DN（GB/T 12459），单位：mm ──
export function elbowCTF(dn) {
  return 1.5 * dn
}

// ── 偏心大小头长度 ≈ max(100, 1.5×|D1-D2|)，单位：mm ──
export function reducerL(d1, d2) {
  return Math.max(100, 1.5 * Math.abs(d1 - d2))
}

// ── 电磁流量计本体长度 ≈ max(300, 4×DN)，单位：mm ──
export function flowmeterBodyL(dn) {
  return Math.max(300, 4 * dn)
}

// ── 查表（带插值）────────────────────────────────────────────────
export function lookupFF(table, dn) {
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b)
  if (dn <= keys[0]) return table[keys[0]]
  if (dn >= keys[keys.length - 1]) return table[keys[keys.length - 1]]
  // 线性插值
  for (let i = 0; i < keys.length - 1; i++) {
    if (dn >= keys[i] && dn <= keys[i + 1]) {
      const t = (dn - keys[i]) / (keys[i + 1] - keys[i])
      return table[keys[i]] + t * (table[keys[i + 1]] - table[keys[i]])
    }
  }
  return table[keys[keys.length - 1]]
}

// ── 检修间距默认值（可由用户覆盖），单位说明见各字段 ──
export const SPACE_RULES_DEFAULT = {
  pipeToWall_mm: 800,   // 管外壁到墙面净距（GB 50265-2022 §7）
  pipeToPipe_mm: 800,   // 相邻管外壁间净距（GB 50265-2022 §7）
  minStraight_mm: 300,  // 阀件间最小直管段（或用 2D，取大值）
  fmUpstream_D: 5,       // 流量计上游直管倍数（GB/T 18940）
  fmDownstream_D: 2,    // 流量计下游直管倍数
  sleeveEdge_mm: 200,   // 穿楼板套管外壁到结构边缘
}