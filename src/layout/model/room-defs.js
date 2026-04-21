/**
 * Room definitions for the pump station building.
 * Dimensions in mm (matching source document units).
 *
 * constraints: array of keys from CONSTRAINT_RULES
 * derived: true if dimensions are calculated at layout time
 * rotatable: whether the room can be rotated 90°
 * isOpening: true for floor hatches (送货口), drawn differently
 */
export const ROOM_DEFS = {
  // ── Ground floor ──────────────────────────────────────
  trafo1: {
    id: 'trafo1', label: '中电变压器房1', labelEn: 'CLP Transformer 1',
    w: 8600, d: 8000, floor: 'ground',
    rotatable: false, constraints: ['ext_access'], color: '#fdebd0', strokeColor: '#d68910',
  },
  trafo2: {
    id: 'trafo2', label: '中电变压器房2', labelEn: 'CLP Transformer 2',
    w: 8600, d: 8000, floor: 'ground',
    rotatable: false, constraints: ['ext_access'], color: '#fdebd0', strokeColor: '#d68910',
  },
  meter_main: {
    id: 'meter_main', label: '总水表房', labelEn: 'Master Water Meter',
    w: 2800, d: 3400, floor: 'ground',
    rotatable: true, constraints: ['ext_access'], color: '#d5f5e3', strokeColor: '#1e8449',
  },
  meter_sub: {
    id: 'meter_sub', label: '水表房', labelEn: 'Water Meter Room',
    w: 2800, d: 3300, floor: 'ground',
    rotatable: true, constraints: ['ext_access'], color: '#d5f5e3', strokeColor: '#1e8449',
  },
  fire_equip: {
    id: 'fire_equip', label: '消防设备房', labelEn: 'Fire Services Room',
    w: 2800, d: 2500, floor: 'ground',
    rotatable: true, constraints: ['ext_access'], color: '#fadbd8', strokeColor: '#c0392b',
  },
  parking: {
    id: 'parking', label: '停车区域', labelEn: 'Parking Area',
    w: 10000, d: 17200, floor: 'ground',
    rotatable: false, constraints: ['crane15_cover'], color: '#d6eaf8', strokeColor: '#2471a3',
    connectsTo: ['repair_zone'],
  },
  repair_zone: {
    id: 'repair_zone', label: '水泵维修区域', labelEn: 'Pump Maintenance Area',
    w: null, d: null, floor: 'ground',  // derived at layout time
    rotatable: false, constraints: ['crane15_cover'], color: '#ebdef0', strokeColor: '#6c3483',
    derived: true,
  },
  dock1: {
    id: 'dock1', label: '送货口1', labelEn: 'Delivery Hatch 1',
    w: 3000, d: 3000, floor: 'ground',
    rotatable: false, constraints: ['crane15_cover'], color: '#aed6f1', strokeColor: '#2471a3',
    isOpening: true,
  },

  // ── Level 1 ───────────────────────────────────────────
  fan_room: {
    id: 'fan_room', label: '风机房', labelEn: 'Fan Room',
    w: 13600, d: 11800, floor: 'level1',
    rotatable: false, constraints: ['crane5_cover', 'near_dock2'], color: '#d2b4de', strokeColor: '#6c3483',
  },
  clean_pump: {
    id: 'clean_pump', label: '清洁泵房及水箱房', labelEn: 'Cleansing Pumps & Tanks',
    w: 6500, d: 6100, floor: 'level1',
    rotatable: true, constraints: [], color: '#a9dfbf', strokeColor: '#1e8449',
  },
  rainwater: {
    id: 'rainwater', label: '雨水回收及灌溉设备房', labelEn: 'Rainwater Harvesting & Irrigation',
    w: 9000, d: 6300, floor: 'level1',
    rotatable: true, constraints: [], color: '#a9dfbf', strokeColor: '#1e8449',
  },
  lv_control: {
    id: 'lv_control', label: '低压配电及PLC控制室', labelEn: 'LV Switch & PLC Room',
    w: 8000, d: 17500, floor: 'level1',
    rotatable: false, constraints: [], color: '#fad7a0', strokeColor: '#d35400',
  },
  dock2: {
    id: 'dock2', label: '送货口2', labelEn: 'Delivery Hatch 2',
    w: 3000, d: 3000, floor: 'level1',
    rotatable: false, constraints: ['crane5_cover'], color: '#aed6f1', strokeColor: '#2471a3',
    isOpening: true,
  },

  // ── Circulation ───────────────────────────────────────
  corridor_l1: {
    id: 'corridor_l1', label: '一层主走廊', labelEn: 'Level 1 Main Corridor',
    w: 1500, d: 8800, floor: 'level1',
    rotatable: true, constraints: [], color: '#f5f0e8', strokeColor: '#aaa',
    connectsTo: ['fan_room', 'lv_control', 'clean_pump', 'rainwater'],
  },
}

// Crane coverage regions (template-dependent, defined per template in templates.js)
// These are used by the constraint checker in placer.js
