import { ROOM_DEFS } from '../model/room-defs.js'

/**
 * Builds the message payload for creating a pump room model in Revit.
 * @param {Object} v The layout variant to export
 * @returns {Object} A message object ready for serialization
 */
export function buildRevitMessage(v) {
  const WALL_THICK = 200
  const GROUND_H = 3500
  const LEVEL1_H = 3000

  const rooms = []
  const walls = []
  let wallIdx = 0

  const addRooms = (placements, floor) => {
    const z = floor === 'ground' ? 0 : GROUND_H
    const height = floor === 'ground' ? GROUND_H : LEVEL1_H
    Object.entries(placements || {}).forEach(([roomId, p]) => {
      const rid = `${floor}-${roomId}`
      rooms.push({ id: rid, name: ROOM_DEFS[roomId]?.label || roomId })
      const { x, y, w, d } = p
      ;[
        { start: { x, y, z },         end: { x: x + w, y,       z } },
        { start: { x: x + w, y, z },  end: { x: x + w, y: y + d, z } },
        { start: { x, y: y + d, z },  end: { x: x + w, y: y + d, z } },
        { start: { x, y, z },         end: { x,         y: y + d, z } },
      ].forEach(seg => {
        walls.push({
          id: `wall-${++wallIdx}`,
          roomId: rid,
          startMm: seg.start,
          endMm: seg.end,
          thicknessMm: WALL_THICK,
          heightMm: height,
        })
      })
    })
  }

  addRooms(v.groundPlacements, 'ground')
  addRooms(v.level1Placements, 'level1')

  return {
    type: 'create-pump-room',
    payload: {
      requestId: (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `req-${Date.now()}`,
      rooms,
      walls,
    },
  }
}

/**
 * Sends the Revit model creation message via WebView2 host if available,
 * otherwise logs it to the console in development mode.
 * 
 * @param {Object} variant The layout variant to send
 * @param {Function} notify (msg, isSuccess) => void
 */
export function sendToRevit(variant, notify) {
  if (!variant) return
  const msg = buildRevitMessage(variant)
  const json = JSON.stringify(msg)

  if (window.chrome?.webview) {
    window.chrome.webview.postMessage(json)
    if (notify) notify('已发送 create-pump-room 消息到 Revit Host', true)
  } else {
    console.log('[Revit Message]', msg)
    if (notify) notify('（开发模式）消息已输出到控制台，未检测到 WebView Host', false)
  }
}
