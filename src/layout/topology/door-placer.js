
import { ROOM_DEFS } from '../model/room-defs.js';

const DOOR_WIDTH = 900; // Standard door width in mm

/**
 * Finds the overlapping segment between two 1D segments.
 * @returns {{start: number, end: number}|null}
 */
function getOverlap(a1, a2, b1, b2) {
    const start = Math.max(a1, b1);
    const end = Math.min(a2, b2);
    return (start < end) ? { start, end } : null;
}

/**
 * Finds the shared wall between two rooms.
 * @returns {object|null} Shared wall segment info or null.
 */
function getSharedWallSegment(p1, p2, tol = 100) {
    if (!p1 || !p2) return null;

    const r1 = { x1: p1.x, y1: p1.y, x2: p1.x + p1.w, y2: p1.y + p1.d };
    const r2 = { x1: p2.x, y1: p2.y, x2: p2.x + p2.w, y2: p2.y + p2.d };

    // Check vertical wall (r1 is left of r2)
    if (Math.abs(r1.x2 - r2.x1) < tol) {
        const overlap = getOverlap(r1.y1, r1.y2, r2.y1, r2.y2);
        console.log(`  [V-L] Overlap Y for ${p1.id} & ${p2.id}:`, overlap);
        if (overlap && (overlap.end - overlap.start) >= DOOR_WIDTH) {
            return { x: r1.x2, y: overlap.start, w: 0, d: overlap.end - overlap.start, type: 'vertical' };
        }
    }
    // Check vertical wall (r1 is right of r2)
    if (Math.abs(r1.x1 - r2.x2) < tol) {
        const overlap = getOverlap(r1.y1, r1.y2, r2.y1, r2.y2);
        console.log(`  [V-R] Overlap Y for ${p1.id} & ${p2.id}:`, overlap);
        if (overlap && (overlap.end - overlap.start) >= DOOR_WIDTH) {
            return { x: r1.x1, y: overlap.start, w: 0, d: overlap.end - overlap.start, type: 'vertical' };
        }
    }
    // Check horizontal wall (r1 is above r2)
    if (Math.abs(r1.y2 - r2.y1) < tol) {
        const overlap = getOverlap(r1.x1, r1.x2, r2.x1, r2.x2);
        console.log(`  [H-A] Overlap X for ${p1.id} & ${p2.id}:`, overlap);
        if (overlap && (overlap.end - overlap.start) >= DOOR_WIDTH) {
            return { x: overlap.start, y: r1.y2, w: overlap.end - overlap.start, d: 0, type: 'horizontal' };
        }
    }
    // Check horizontal wall (r1 is below r2)
    if (Math.abs(r1.y1 - r2.y2) < tol) {
        const overlap = getOverlap(r1.x1, r1.x2, r2.x1, r2.x2);
        console.log(`  [H-B] Overlap X for ${p1.id} & ${p2.id}:`, overlap);
        if (overlap && (overlap.end - overlap.start) >= DOOR_WIDTH) {
            return { x: overlap.start, y: r1.y1, w: overlap.end - overlap.start, d: 0, type: 'horizontal' };
        }
    }
    return null;
}

/**
 * Places doors in a layout based on connectivity rules.
 * @param {object} allPlacements - A map of room ID to its placement {x, y, w, d}.
 * @returns {Array} A list of door objects.
 */
export function placeDoors(allPlacements) {
    const doors = [];
    const processedPairs = new Set();

    console.log("--- Starting Door Placement ---");

    for (const [id1, p1] of Object.entries(allPlacements)) {
        const def1 = ROOM_DEFS[id1];
        if (!def1 || !def1.connectsTo) continue;

        for (const id2 of def1.connectsTo) {
            const p2 = allPlacements[id2];
            if (!p2) continue;

            const pairKey = [id1, id2].sort().join('--');
            if (processedPairs.has(pairKey)) continue;

            console.log(`Checking connection: ${id1} <-> ${id2}`);
            console.log(`  - ${id1}:`, p1);
            console.log(`  - ${id2}:`, p2);

            const wall = getSharedWallSegment({id: id1, ...p1}, {id: id2, ...p2});
            if (wall) {
                processedPairs.add(pairKey);
                let doorX, doorY;
                if (wall.type === 'vertical') {
                    doorX = wall.x;
                    doorY = wall.y + wall.d / 2;
                } else { // horizontal
                    doorX = wall.x + wall.w / 2;
                    doorY = wall.y;
                }
                doors.push({
                    x: doorX, y: doorY,
                    w: wall.type === 'horizontal' ? DOOR_WIDTH : 0,
                    d: wall.type === 'vertical' ? DOOR_WIDTH : 0,
                    rooms: [id1, id2]
                });
                console.log(`  SUCCESS: Door placed between ${id1} and ${id2}`);
            } else {
                console.log(`  FAILURE: No shared wall found between ${id1} and ${id2}`);
            }
        }
    }
    console.log(`--- Finished Door Placement: Placed ${doors.length} doors. ---`);
    return doors;
}
