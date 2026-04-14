/**
 * Attach mouse-wheel zoom + drag pan + touch pinch to an SVG element.
 * Zoom buttons are looked up by the IDs passed in btnIds.
 *
 * @param {SVGElement} svg
 * @param {number} vw   initial viewBox width
 * @param {number} vh   initial viewBox height
 * @param {object} [btnIds]  { zIn, zOut, zRst } — DOM element IDs for toolbar buttons
 * @param {object} [opts]  { minScale, maxScale, onReset } — zoom limits and reset callback
 */
export function initSvgZoomPan(svg, vw, vh, btnIds = {}, opts = {}) {
  const minScale = opts.minScale ?? 0.25
  const maxScale = opts.maxScale ?? 8
  const onReset  = opts.onReset   ?? null
  svg._zpclean && svg._zpclean()
  let vb = { x: 0, y: 0, w: vw, h: vh }
  let isZoomActive = false;

  // Keep track of all zoomable SVGs to deactivate others
  if (!window._zoomableSvgs) window._zoomableSvgs = new Set();
  window._zoomableSvgs.add(svg);

  function applyVB() {
    svg.setAttribute('viewBox', `${vb.x.toFixed(1)} ${vb.y.toFixed(1)} ${vb.w.toFixed(1)} ${vb.h.toFixed(1)}`)
  }

  function onWheel(e) {
    if (!isZoomActive) return;
    e.preventDefault()
    const f = e.deltaY > 0 ? 1.12 : 0.89
    const rect = svg.getBoundingClientRect()
    const mx = (e.clientX - rect.left) / rect.width * vb.w + vb.x
    const my = (e.clientY - rect.top) / rect.height * vb.h + vb.y
    vb.w = Math.min(Math.max(vb.w * f, vw / maxScale), vw / minScale)
    vb.h = vb.w * (vh / vw)
    vb.x = mx - (e.clientX - rect.left) / rect.width * vb.w
    vb.y = my - (e.clientY - rect.top) / rect.height * vb.h
    applyVB()
  }

  let drag = false, last = { x: 0, y: 0 }
  function activateSvg() {
    for (const otherSvg of window._zoomableSvgs) {
        otherSvg.classList.remove('zoom-active');
        otherSvg._zp_deactivate && otherSvg._zp_deactivate();
    }
    isZoomActive = true;
    svg.classList.add('zoom-active');
  }
  function onEnter(e) {
    activateSvg()
  }
  function onDown(e) {
    activateSvg()
    drag = true;
    last = { x: e.clientX, y: e.clientY };
    svg.style.cursor = 'grabbing';
    e.preventDefault();
  }
  function onUp()    { drag = false; svg.style.cursor = 'grab' }
  function onMove(e) {
    if (!drag) return
    const rect = svg.getBoundingClientRect()
    vb.x -= (e.clientX - last.x) / rect.width * vb.w
    vb.y -= (e.clientY - last.y) / rect.height * vb.h
    last = { x: e.clientX, y: e.clientY }
    applyVB()
  }

  svg.addEventListener('wheel', onWheel, { passive: false })
  svg.addEventListener('mouseenter', onEnter)
  svg.addEventListener('mousedown', onDown)
  window.addEventListener('mouseup', onUp)
  window.addEventListener('mousemove', onMove)
  window.addEventListener('click', onWindowClick)
  let _lastClickTarget = null
  function onWindowClick(e) {
    _lastClickTarget = e.target
    if (!svg.contains(e.target) && e.target !== svg) {
      isZoomActive = false
      svg.classList.remove('zoom-active')
    }
  }

  // Touch: single-finger pan + two-finger pinch
  let touch = { active: false, last: { x: 0, y: 0 }, pinchDist: 0 }
  function pinchDist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) }
  function touchMid(t, rect) {
    return {
      cx: ((t[0].clientX + t[1].clientX) / 2 - rect.left) / rect.width * vb.w + vb.x,
      cy: ((t[0].clientY + t[1].clientY) / 2 - rect.top) / rect.height * vb.h + vb.y,
      sx: (t[0].clientX + t[1].clientX) / 2,
      sy: (t[0].clientY + t[1].clientY) / 2,
    }
  }
  function onTouchStart(e) {
    e.preventDefault()
    const rect = svg.getBoundingClientRect()
    if (e.touches.length === 1) {
      touch.active = true
      touch.last = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    } else if (e.touches.length === 2) {
      touch.active = false
      touch.pinchDist = pinchDist(e.touches)
      const m = touchMid(e.touches, rect)
      touch.midSvg = { x: m.cx, y: m.cy }
      touch.midScreen = { x: m.sx, y: m.sy }
    }
  }
  function onTouchMove(e) {
    e.preventDefault()
    const rect = svg.getBoundingClientRect()
    if (e.touches.length === 1 && touch.active) {
      vb.x -= (e.touches[0].clientX - touch.last.x) / rect.width * vb.w
      vb.y -= (e.touches[0].clientY - touch.last.y) / rect.height * vb.h
      touch.last = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      applyVB()
    } else if (e.touches.length === 2) {
      const d = pinchDist(e.touches)
      if (touch.pinchDist > 0) {
        const f = touch.pinchDist / d
        const newW = Math.min(Math.max(vb.w * f, vw / maxScale), vw / minScale)
        const newH = newW * (vh / vw)
        vb.x = touch.midSvg.x - (touch.midScreen.x - rect.left) / rect.width * newW
        vb.y = touch.midSvg.y - (touch.midScreen.y - rect.top) / rect.height * newH
        vb.w = newW; vb.h = newH
        touch.pinchDist = d
        applyVB()
      }
    }
  }
  function onTouchEnd(e) { if (e.touches.length === 0) { touch.active = false; touch.pinchDist = 0 } }
  svg.addEventListener('touchstart', onTouchStart, { passive: false })
  svg.addEventListener('touchmove', onTouchMove, { passive: false })
  svg.addEventListener('touchend', onTouchEnd)

  // Toolbar buttons
  function zoomBy(f) {
    const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2
    const newW = Math.min(Math.max(vb.w * f, vw / maxScale), vw / minScale)
    const newH = newW * (vh / vw)
    vb = { x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH }
    applyVB()
  }
  function doZin()  { zoomBy(0.8) }
  function doZout() { zoomBy(1.25) }
  function doRst()  {
    vb = { x: 0, y: 0, w: vw, h: vh }
    applyVB()
    if (onReset) onReset()
  }

  const zIn  = btnIds.zIn  ? document.getElementById(btnIds.zIn)  : null
  const zOut = btnIds.zOut ? document.getElementById(btnIds.zOut) : null
  const zRst = btnIds.zRst ? document.getElementById(btnIds.zRst) : null
  if (zIn)  zIn.addEventListener('click', doZin)
  if (zOut) zOut.addEventListener('click', doZout)
  if (zRst) zRst.addEventListener('click', doRst)

  svg._zpclean = () => {
    svg.removeEventListener('wheel', onWheel)
    svg.removeEventListener('mouseenter', onEnter)
    svg.removeEventListener('mousedown', onDown)
    window.removeEventListener('mouseup', onUp)
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('click', onWindowClick)
    svg.removeEventListener('touchstart', onTouchStart)
    svg.removeEventListener('touchmove', onTouchMove)
    svg.removeEventListener('touchend', onTouchEnd)
    if (zIn)  zIn.removeEventListener('click', doZin)
    if (zOut) zOut.removeEventListener('click', doZout)
    if (zRst) zRst.removeEventListener('click', doRst)
    window._zoomableSvgs.delete(svg);
  }

  svg._zp_deactivate = () => {
    isZoomActive = false;
    svg.classList.remove('zoom-active');
  }
}
