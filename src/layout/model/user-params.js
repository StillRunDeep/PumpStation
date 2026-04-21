
/**
 * @file 用户交互参数收集与继承提示逻辑
 * @description 根据 AG4-1 模板A 的用户交互参数，实现参数收集和继承提示机制。
 */

/**
 * 定义用户交互参数的接口
 * @typedef {object} UserParams
 * @property {number} buildingW - 建筑东西向宽度 BW（mm），最大值约束，默认 43850
 * @property {number} buildingD - 建筑南北向进深 BD（mm），最大值约束，默认 18600
 * @property {object} roomTargetAreas - 各功能空间目标面积（m²），用户可修改
 * @property {number} roomTargetAreas.trafo1 - 默认 60
 * @property {number} roomTargetAreas.trafo2 - 默认 60
 * @property {number} roomTargetAreas.parking - 默认 150（最小值，满足 5.5t 货车停放需求）
 * @property {number} roomTargetAreas.repair_zone - 默认 120（最小值，满足三条 DN1000 主管布置）
 * @property {number} roomTargetAreas.meter_main - 默认 12
 * @property {number} roomTargetAreas.meter_sub - 默认 8
 * @property {number} roomTargetAreas.fire_equip - 默认 15
 * @property {number} roomTargetAreas.lv_control - 默认 65
 * @property {number} roomTargetAreas.fan_room - 默认 55
 * @property {number} roomTargetAreas.clean_pump - 默认 25
 * @property {number} roomTargetAreas.rainwater - 默认 25
 * @property {number} roomTargetAreas.corridor_l1 - 0（走廊面积不作要求，仅限宽度 ≥ 1500 mm）
 */

const STORAGE_KEY = 'pumpstation_building_params'

/** 硬编码的出厂默认值，不含用户缓存。 */
export const HARDCODED_DEFAULTS = {
  buildingW: 43850,  // 东西向宽度 BW（最大值约束）
  buildingD: 18600,  // 南北向进深 BD（最大值约束）
  roomTargetAreas: {
    trafo1:      60,   // 变压器房 1
    trafo2:      60,   // 变压器房 2
    parking:    150,   // 停车位（最小 150 m²，满足 5.5t 货车）
    repair_zone: 120,  // 泵房维护间（最小 120 m²，满足三条 DN1000 主管）
    meter_main:  12,   // 总水表房
    meter_sub:    8,   // 水表房
    fire_equip:  15,   // 消防设备房
    lv_control:  65,   // 低压配电及 PLC 控制室
    fan_room:    55,   // 风机房
    clean_pump:  25,   // 清洁泵房
    rainwater:   25,   // 雨水回用泵房
    corridor_l1:  0,   // 走廊（不作面积要求，宽度须 ≥ 1500 mm）
  },
}

/**
 * 将参数保存到 localStorage。
 * @param {UserParams} params
 */
export function saveParams(params) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(params))
  } catch (e) {
    // localStorage 不可用时静默忽略
  }
}

/**
 * 从 localStorage 读取已保存的参数。
 * @returns {UserParams|null} 已保存的参数，或 null（若无记录）
 */
export function loadSavedParams() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}

/**
 * 获取用户参数：若有 localStorage 缓存则深合并覆盖默认值，否则返回出厂默认值。
 * @returns {UserParams}
 */
export function getDefaultUserParams() {
  const saved = loadSavedParams()
  if (!saved) {
    return {
      ...HARDCODED_DEFAULTS,
      roomTargetAreas: { ...HARDCODED_DEFAULTS.roomTargetAreas },
    }
  }
  // 深合并：用户保存的字段覆盖硬编码默认值，其余保持默认
  return {
    buildingW: saved.buildingW ?? HARDCODED_DEFAULTS.buildingW,
    buildingD: saved.buildingD ?? HARDCODED_DEFAULTS.buildingD,
    roomTargetAreas: {
      ...HARDCODED_DEFAULTS.roomTargetAreas,
      ...(saved.roomTargetAreas || {}),
    },
  }
}

/**
 * Read optional numeric input from a DOM element. Returns null if empty or invalid.
 * @param {string} id The ID of the input element
 * @returns {number|null} The parsed number or null
 */
function readOptional(id) {
  const v = parseFloat(document.getElementById(id)?.value)
  return isNaN(v) || v <= 0 ? null : v
}

/**
 * 从 UI 收集 AG4-1 用户参数。
 * 在新的流程中，此函数直接返回从 localStorage 或默认值加载的参数，
 * 因为 UI 的 `init` 函数会实时将用户的输入保存到 localStorage。
 * @returns {UserParams} 用户确认或修改后的参数
 */
export async function getUserConfirmedParams() {
  // UI 面板的 `init` 方法会监听输入并实时调用 `saveParams`。
  // 因此，这里直接从 `getDefaultUserParams`（它会从localStorage加载）获取最新值即可。
  return getDefaultUserParams();
}
