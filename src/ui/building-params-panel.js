/**
 * @file 建筑平面参数面板组件
 * @description 在 AG3-1 和 AG4-1 之间提供建筑尺寸及功能空间面积参数设置
 */

import { saveParams, HARDCODED_DEFAULTS } from '../layout/model/user-params.js'

function renderBuildingParamsPanel(defaultParams = {}) {
  const defaultBw = defaultParams.buildingW || 43850
  const defaultBd = defaultParams.buildingD || 18600
  const defaultAreas = defaultParams.roomTargetAreas || {}

  // 共享读取函数：在 init() 和 validateAndConfirm() 中均使用
  let _readCurrent = null;

  const panelHTML = `
    <div class="ag41-section-title">建筑总尺寸设置
      <span class="ag41-hint">尺寸确认后用于生成布局方案</span>
    </div>

    <div class="form-grid">
      <div class="form-group">
        <label>建筑宽度 BW（mm）</label>
        <input type="number" id="inp-bw" min="10000" max="40000" step="100" value="${defaultBw}">
        <span class="hint">东西向外包净尺寸，初始值 ${defaultBw} mm</span>
      </div>
      <div class="form-group">
        <label>建筑进深 BD（mm）</label>
        <input type="number" id="inp-bd" min="10000" max="50000" step="100" value="${defaultBd}">
        <span class="hint">南北向外包净尺寸，初始值 ${defaultBd} mm</span>
      </div>
    </div>

    <div class="ag41-section-title" style="margin-top:14px">各功能空间目标面积（m²）
      <span class="ag41-hint">允许自行修改；留空则使用默认值</span>
    </div>

    <table class="ag41-area-table">
      <thead>
        <tr>
          <th>楼层</th>
          <th>功能空间</th>
          <th>目标面积（m²）</th>
          <th>说明 / 初始参考值</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td rowspan="5" class="ag41-floor-cell">地面层</td>
          <td>中电变压器房（×2）</td>
          <td><input type="number" id="ra-trafo" class="ra-input" min="20" step="1" value="${defaultAreas.trafo1 || 60}"></td>
          <td class="ag41-note">每间约 60 m²；由变压器型号确定</td>
        </tr>
        <tr>
          <td>服务用房（水表＋消防）</td>
          <td><input type="number" id="ra-svc" class="ra-input" min="10" step="1" value="${defaultAreas.svc || 26}"></td>
          <td class="ag41-note">三间合计约 25.8 m²；由规范最小尺寸确定</td>
        </tr>
        <tr>
          <td>维修区域</td>
          <td><input type="number" id="ra-repair" class="ra-input" min="120" step="1" value="${defaultAreas.repair_zone || 120}"></td>
          <td class="ag41-note">最小 120 m²，满足三条 DN1000 上升主管布置</td>
        </tr>
        <tr>
          <td>停车区域</td>
          <td><input type="number" id="ra-parking" class="ra-input" min="150" step="1" value="${defaultAreas.parking || 150}"></td>
          <td class="ag41-note">最小 150 m²，满足 5.5t 货车停放需求</td>
        </tr>
        <tr>
          <td>送货口 1（地坑）</td>
          <td><input type="number" id="ra-dock1" class="ra-input" min="4" step="1" value="9" disabled></td>
          <td class="ag41-note">固定 3 m × 3 m = 9 m²；不可调整</td>
        </tr>
      </tbody>
      <tbody>
        <tr>
          <td rowspan="5" class="ag41-floor-cell">一层</td>
          <td>风机房</td>
          <td><input type="number" id="ra-fan" class="ra-input" min="50" step="1" value="${defaultAreas.fan_room || 55}"></td>
          <td class="ag41-note">默认 55 m²</td>
        </tr>
        <tr>
          <td>清洁泵房及水箱房</td>
          <td><input type="number" id="ra-cp" class="ra-input" min="10" step="1" value="${defaultAreas.clean_pump || 25}"></td>
          <td class="ag41-note">默认 25 m²</td>
        </tr>
        <tr>
          <td>雨水回收及灌溉设备房</td>
          <td><input type="number" id="ra-rw" class="ra-input" min="10" step="1" value="${defaultAreas.rainwater || 25}"></td>
          <td class="ag41-note">默认 25 m²</td>
        </tr>
        <tr>
          <td>低压配电及 PLC 控制室</td>
          <td><input type="number" id="ra-lv" class="ra-input" min="50" step="1" value="${defaultAreas.lv_control || 65}"></td>
          <td class="ag41-note">默认 65 m²</td>
        </tr>
        <tr>
          <td>一层主走廊</td>
          <td><input type="number" id="ra-corr" class="ra-input" min="8" step="1" value="0" disabled></td>
          <td class="ag41-note">宽度须 ≥ 1500 mm，不设面积要求；不可单独指定</td>
        </tr>
      </tbody>
    </table>
  `

  return {
    innerHTML: `<div class="building-params-panel">${panelHTML.trim()}</div>`,

    /**
     * 激活输入监听：每次用户修改任意字段后立即保存到 localStorage。
     * 必须在 innerHTML 已被插入 DOM 后调用。
     * @param {HTMLElement} container - 包含面板 HTML 的容器元素
     */
    init(container) {
      const readCurrent = () => {
        const bW = parseFloat(container.querySelector('#inp-bw')?.value) || defaultBw
        const bD = parseFloat(container.querySelector('#inp-bd')?.value) || defaultBd

        const readVal = (id) => {
          const el = container.querySelector(`#${id}`)
          if (!el || el.disabled) return null
          const v = parseFloat(el.value)
          return isNaN(v) || v <= 0 ? null : v
        }

        const roomTargetAreas = {}
        const mapping = {
          'ra-trafo':   ['trafo1', 'trafo2'],  // 同一输入同时应用到 trafo1 和 trafo2
          'ra-svc':     ['meter_main', 'meter_sub', 'fire_equip'], // 服务用房合计，按比例分配给三间
          'ra-repair':  ['repair_zone'],
          'ra-parking': ['parking'],
          'ra-fan':     ['fan_room'],
          'ra-cp':      ['clean_pump'],
          'ra-rw':      ['rainwater'],
          'ra-lv':      ['lv_control'],
        }

        for (const [inputId, keys] of Object.entries(mapping)) {
          const v = readVal(inputId)
          if (v !== null) {
            if (inputId === 'ra-svc') {
              // 服务用房合计按原始默认比例拆分到三间：meter_main:meter_sub:fire_equip = 12:8:15
              const total = HARDCODED_DEFAULTS.roomTargetAreas.meter_main
                          + HARDCODED_DEFAULTS.roomTargetAreas.meter_sub
                          + HARDCODED_DEFAULTS.roomTargetAreas.fire_equip
              roomTargetAreas.meter_main  = Math.round(v * HARDCODED_DEFAULTS.roomTargetAreas.meter_main  / total)
              roomTargetAreas.meter_sub   = Math.round(v * HARDCODED_DEFAULTS.roomTargetAreas.meter_sub   / total)
              roomTargetAreas.fire_equip  = Math.round(v * HARDCODED_DEFAULTS.roomTargetAreas.fire_equip  / total)
            } else {
              keys.forEach(k => { roomTargetAreas[k] = v })
            }
          }
        }

        return {
          buildingW: Math.round(bW / 100) * 100,
          buildingD: Math.round(bD / 100) * 100,
          roomTargetAreas,
        }
      }

      // 供 validateAndConfirm 共享使用
      _readCurrent = readCurrent;

      // 监听所有可编辑 input，每次变化即刻保存
      container.querySelectorAll('input:not([disabled])').forEach(el => {
        el.addEventListener('input', () => saveParams(readCurrent()))
      })
    },

    readParams() {
      // (This function seems to be legacy, but we'll update it just in case)
      const bW = parseFloat(document.querySelector('#inp-bw')?.value) || defaultBw
      const bD = parseFloat(document.querySelector('#inp-bd')?.value) || defaultBd

      const roomAreas = {}
      const readOptional = (id) => {
        const el = document.querySelector(`#${id}`)
        if (!el) return null
        const v = parseFloat(el.value)
        return isNaN(v) || v <= 0 ? null : v
      }
      // ... (rest of readParams, we are deprecating this)
      return { buildingW: bW, buildingD: bD, roomTargetAreas: roomAreas };
    },

    /**
     * Validates user-entered params. If total room area is less than 70% of
     * building area for any floor, it shows a confirmation dialog.
     * @returns {boolean} true if user confirms to proceed, false otherwise.
     */
    validateAndConfirm() {
      const params = _readCurrent ? _readCurrent() : (this.readParams ? this.readParams() : {});
      const { buildingW, buildingD, roomTargetAreas } = params;
      const floorAreaM2 = (buildingW * buildingD) / 1e6;

      const roomDefs = {
        'ground': ['trafo1', 'trafo2', 'parking', 'repair_zone', 'meter_main', 'meter_sub', 'fire_equip'],
        'level1': ['lv_control', 'fan_room', 'clean_pump', 'rainwater', 'corridor_l1']
      };

      const floorTotals = { ground: 0, level1: 0 };
      for (const [floor, roomIds] of Object.entries(roomDefs)) {
        for (const id of roomIds) {
          // Special handling for trafo rooms as they share one input
          const key = (id === 'trafo2') ? 'trafo1' : id;
          floorTotals[floor] += roomTargetAreas[key] || HARDCODED_DEFAULTS.roomTargetAreas[id] || 0;
        }
      }

      const groundRatio = floorTotals.ground / floorAreaM2;
      const level1Ratio = floorTotals.level1 / floorAreaM2;

      const lowRatioFloors = [];
      if (groundRatio < 0.7) lowRatioFloors.push(`地面层 (仅 ${Math.round(groundRatio*100)}%)`);
      if (level1Ratio < 0.7) lowRatioFloors.push(`一层 (仅 ${Math.round(level1Ratio*100)}%)`);

      if (lowRatioFloors.length > 0) {
        const floorStr = lowRatioFloors.join(' 和 ');
        const msg = `警告：当前建筑轮廓偏大。\n\n您建议的房间总面积在 ${floorStr} 不足楼层面积的70%。\n\n这可能导致布局松散、产生不规则的剩余空间。\n是否仍要继续生成？`;
        return window.confirm(msg);
      }

      return true; // All good
    },
  }
}

export { renderBuildingParamsPanel }
