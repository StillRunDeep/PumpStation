/**
 * @file 建筑平面参数面板组件
 * @description 在 AG3-1 和 AG4-1 之间提供建筑尺寸及功能空间面积参数设置
 */

function renderBuildingParamsPanel(defaultParams = {}) {
  const defaultBw = defaultParams.buildingW || 18600
  const defaultBd = defaultParams.buildingD || 24000
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
          <td><input type="number" id="ra-trafo" class="ra-input" min="20" step="1" value="${defaultAreas.trafo1 || 69}"></td>
          <td class="ag41-note">每间约 68.8 m²；由变压器型号确定</td>
        </tr>
        <tr>
          <td>服务用房（水表＋消防）</td>
          <td><input type="number" id="ra-svc" class="ra-input" min="10" step="1" value="${defaultAreas.svc || 26}"></td>
          <td class="ag41-note">三间合计约 25.8 m²；由规范最小尺寸确定</td>
        </tr>
        <tr>
          <td>维修区域</td>
          <td><input type="number" id="ra-repair" class="ra-input" min="10" step="1" value="${defaultAreas.repair_zone || 34}"></td>
          <td class="ag41-note">初始值约 34 m²；建议参考 AG1-2 维护间尺寸</td>
        </tr>
        <tr>
          <td>停车区域</td>
          <td><input type="number" id="ra-parking" class="ra-input" min="20" step="1" value="${defaultAreas.parking || 172}"></td>
          <td class="ag41-note">默认约 172 m²（10 m 跨 × 17.2 m）</td>
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
          <td><input type="number" id="ra-fan" class="ra-input" min="50" step="1" value="${defaultAreas.fan_room || 160}"></td>
          <td class="ag41-note">约 160 m²；由 5t 吊车覆盖范围决定</td>
        </tr>
        <tr>
          <td>清洁泵房及水箱房</td>
          <td><input type="number" id="ra-cp" class="ra-input" min="10" step="1" value="${defaultAreas.clean_pump || 40}"></td>
          <td class="ag41-note">初始值约 39.7 m²</td>
        </tr>
        <tr>
          <td>雨水回收及灌溉设备房</td>
          <td><input type="number" id="ra-rw" class="ra-input" min="10" step="1" value="${defaultAreas.rainwater || 57}"></td>
          <td class="ag41-note">初始值约 56.7 m²</td>
        </tr>
        <tr>
          <td>低压配电及 PLC 控制室</td>
          <td><input type="number" id="ra-lv" class="ra-input" min="50" step="1" value="${defaultAreas.lv_control || 140}"></td>
          <td class="ag41-note">初始值约 140 m²；宽度在 7.5–9.0 m 之间随机</td>
        </tr>
        <tr>
          <td>一层主走廊</td>
          <td><input type="number" id="ra-corr" class="ra-input" min="8" step="1" value="20" disabled></td>
          <td class="ag41-note">最小净宽 1.6 m，长度由楼层决定；不可单独指定</td>
        </tr>
      </tbody>
    </table>
  `
  return {
    innerHTML: `<div class="building-params-panel">${panelHTML.trim()}</div>`,

    readParams() {
      const container = this.parentElement
      const bW = parseFloat(container.querySelector('#inp-bw')?.value) || defaultBw
      const bD = parseFloat(container.querySelector('#inp-bd')?.value) || defaultBd

      const roomAreas = {}
      const readOptional = (id) => {
        const el = container.querySelector(id)
        if (!el) return null
        const v = parseFloat(el.value)
        return isNaN(v) || v <= 0 ? null : v
      }

      if (readOptional('ra-repair') !== null) roomAreas.repair_zone = readOptional('ra-repair')
      if (readOptional('ra-parking') !== null) roomAreas.parking = readOptional('ra-parking')
      if (readOptional('ra-trafo') !== null) roomAreas.trafo1 = readOptional('ra-trafo')
      if (readOptional('ra-lv') !== null) roomAreas.lv_control = readOptional('ra-lv')
      if (readOptional('ra-cp') !== null) roomAreas.clean_pump = readOptional('ra-cp')
      if (readOptional('ra-fan') !== null) roomAreas.fan_room = readOptional('ra-fan')
      if (readOptional('ra-rw') !== null) roomAreas.rainwater = readOptional('ra-rw')
      if (readOptional('ra-dock1') !== null) roomAreas.dock1 = readOptional('ra-dock1')

      return {
        buildingW: Math.round(bW / 100) * 100,
        buildingD: Math.round(bD / 100) * 100,
        roomTargetAreas: roomAreas,
      }
    },
  }
}

export { renderBuildingParamsPanel }
