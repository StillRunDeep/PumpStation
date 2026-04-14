/**
 * @file 建筑平面参数面板组件
 * @description 在 AG3-1 和 AG4-1 之间提供建筑尺寸及功能空间面积参数设置
 */

import { saveParams } from '../layout/user-params.js'

function renderBuildingParamsPanel(defaultParams = {}) {
  const defaultBw = defaultParams.buildingW || 43850
  const defaultBd = defaultParams.buildingD || 18600
  const defaultAreas = defaultParams.roomTargetAreas || {}

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
          'ra-repair':  ['repair_zone'],
          'ra-parking': ['parking'],
          'ra-fan':     ['fan_room'],
          'ra-cp':      ['clean_pump'],
          'ra-rw':      ['rainwater'],
          'ra-lv':      ['lv_control'],
        }

        for (const [inputId, keys] of Object.entries(mapping)) {
          const v = readVal(inputId)
          if (v !== null) keys.forEach(k => { roomTargetAreas[k] = v })
        }

        return {
          buildingW: Math.round(bW / 100) * 100,
          buildingD: Math.round(bD / 100) * 100,
          roomTargetAreas,
        }
      }

      // 监听所有可编辑 input，每次变化即刻保存
      container.querySelectorAll('input:not([disabled])').forEach(el => {
        el.addEventListener('input', () => saveParams(readCurrent()))
      })
    },

    readParams() {
      // 兼容旧调用：直接从 document 读取（已插入 DOM 的情况）
      const bW = parseFloat(document.querySelector('#inp-bw')?.value) || defaultBw
      const bD = parseFloat(document.querySelector('#inp-bd')?.value) || defaultBd

      const roomAreas = {}
      const readOptional = (id) => {
        const el = document.querySelector(`#${id}`)
        if (!el) return null
        const v = parseFloat(el.value)
        return isNaN(v) || v <= 0 ? null : v
      }

      const v_repair  = readOptional('ra-repair')
      const v_parking = readOptional('ra-parking')
      const v_trafo   = readOptional('ra-trafo')
      const v_lv      = readOptional('ra-lv')
      const v_cp      = readOptional('ra-cp')
      const v_fan     = readOptional('ra-fan')
      const v_rw      = readOptional('ra-rw')

      if (v_repair  !== null) { roomAreas.repair_zone = v_repair }
      if (v_parking !== null) { roomAreas.parking     = v_parking }
      if (v_trafo   !== null) { roomAreas.trafo1 = v_trafo; roomAreas.trafo2 = v_trafo }
      if (v_lv      !== null) { roomAreas.lv_control  = v_lv }
      if (v_cp      !== null) { roomAreas.clean_pump  = v_cp }
      if (v_fan     !== null) { roomAreas.fan_room    = v_fan }
      if (v_rw      !== null) { roomAreas.rainwater   = v_rw }

      return {
        buildingW: Math.round(bW / 100) * 100,
        buildingD: Math.round(bD / 100) * 100,
        roomTargetAreas: roomAreas,
      }
    },
  }
}

export { renderBuildingParamsPanel }
