#!/usr/bin/env node

/**
 * Debug Runner for Layout Generation
 *
 * Standalone Node.js script to test individual layout schemes without the Web UI overhead.
 * Enables fast iteration on Phase 2 (L/U expansion) and Phase 3 (gap filling) algorithms.
 *
 * Usage:
 *   node debug-runner.js --case must_pair_trafo --floor ground --visualize out.svg
 *   DEBUG_LAYOUT=phase2,phase3 node debug-runner.js --seed 42 --log-level verbose
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateConstrainedLayout, GRID_SIZE, generateWeightMapForRoom } from './layout-generator.js';
import { ROOM_DEFS } from '../model/room-defs.js';
import { getDefaultUserParams } from '../model/user-params.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Global shim for Node.js environment ──────────────────────────
// Mock window object for code that references it
if (typeof window === 'undefined') {
  globalThis.window = {
    debugModeEnabled: process.env.DEBUG_MODE === 'true',
    debugLayoutPhase2: (process.env.DEBUG_LAYOUT || '').includes('phase2'),
    debugLayoutPhase3: (process.env.DEBUG_LAYOUT || '').includes('phase3'),
    timeCostThreshold: parseFloat(process.env.TIME_THRESHOLD || '5'),
    timeCostLog: [],
    layoutDebugLog: [],
    debugCurrentModuleEnabled: true,
  };
}

// Mock localStorage for Node.js
if (typeof localStorage === 'undefined') {
  const store = {};
  globalThis.localStorage = {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
    key: (index) => Object.keys(store)[index] || null,
    get length() { return Object.keys(store).length; }
  };
}

// ── Test Cases ────────────────────────────────────────────────────

const CASES_FILE = path.join(__dirname, 'debug-cases.json');
const DEBUG_CASES = Object.fromEntries(
  JSON.parse(fs.readFileSync(CASES_FILE, 'utf8')).map(c => [c.name, c])
);

// ── Argument Parser ───────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    case: null,
    seed: null,
    floor: 'ground',
    output: null,
    visualize: null,
    logLevel: 'normal',
    allCases: false,
    validate: false,
    phase: 3,  // Default: run all phases (1, 2, 3)
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--case') opts.case = args[++i];
    else if (arg === '--seed') opts.seed = parseInt(args[++i]);
    else if (arg === '--floor') opts.floor = args[++i];
    else if (arg === '--output') opts.output = args[++i];
    else if (arg === '--visualize') opts.visualize = args[++i];
    else if (arg === '--log-level') opts.logLevel = args[++i];
    else if (arg === '--phase') opts.phase = parseInt(args[++i]);
    else if (arg === '--all-cases') opts.allCases = true;
    else if (arg === '--validate') opts.validate = true;
    else if (arg === '--localstorage-file') args[++i]; // Skip unknown param silently
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
Usage: node debug-runner.js [options]

Options:
  --case <name>          Run predefined test case (simple_rect, must_pair_trafo, etc.)
  --seed <number>        Random seed for layout generation
  --floor <floor>        Floor to generate (ground, level1; default: ground)
  --output <file>        Output layout JSON to file
  --visualize <file>     Generate debug SVG visualization
  --log-level <level>    Log verbosity (terse, normal, verbose; default: normal)
  --phase <1|2|3>        Stop after specific phase: 1=rect, 2=L/U, 3=all (default: 3)
  --all-cases            Run all predefined test cases
  --validate             Validate generated layouts (check constraints)
  --help, -h             Show this help message

Environment variables:
  DEBUG_LAYOUT=phase2,phase3   Enable debug logs for specific phases
  DEBUG_MODE=true              Enable performance timing
  TIME_THRESHOLD=N             Alert if phase takes > N seconds

Examples:
  # Quick test with predefined case
  node debug-runner.js --case must_pair_trafo --visualize out.svg

  # Detailed logging with custom seed
  DEBUG_LAYOUT=phase2,phase3 node debug-runner.js --seed 999 --log-level verbose

  # Run all cases with validation
  node debug-runner.js --all-cases --validate

  # Only run Phase 2 (L/U expansion)
  DEBUG_LAYOUT=phase2 node debug-runner.js --case must_pair_trafo --phase 2 --visualize phase2.svg

  # Compare phases
  node debug-runner.js --case must_pair_trafo --phase 1 --output phase1.json
  node debug-runner.js --case must_pair_trafo --phase 2 --output phase2.json
  node debug-runner.js --case must_pair_trafo --phase 3 --output phase3.json
  `);
}

// ── Layout Generation ─────────────────────────────────────────────

async function generateLayout(seed, buildingW, buildingD, floor, phase = 3) {
  // Load default parameters
  const defaultParams = getDefaultUserParams();

  // Calculate room target areas
  const roomTargetAreas = {};
  for (const [roomId, roomDef] of Object.entries(ROOM_DEFS)) {
    if (roomDef.floor !== floor) continue;
    if (roomDef.derived) continue; // Skip derived rooms
    const baseArea = ((roomDef.w || 5000) * (roomDef.d || 5000)) / 1e6;
    roomTargetAreas[roomId] = baseArea;
  }

  console.log(`[INFO] Generating ${floor} floor layout with seed ${seed}`);
  console.log(`[INFO] Building size: ${buildingW}mm × ${buildingD}mm`);
  console.log(`[INFO] Room targets: ${Object.keys(roomTargetAreas).length} rooms`);
  console.log(`[INFO] Phase limit: ${phase}`);

  const startTime = performance.now();
  // If stopPhase < 3, we need to enable detailedLayout to run Phases 2 and beyond
  const runParams = {
    stopPhase: phase,
    detailedLayout: phase > 1  // Enable Phase 2+ only if stopPhase > 1
  };
  const result = generateConstrainedLayout(
    seed,
    buildingW,
    buildingD,
    roomTargetAreas,
    runParams,
    'DEBUG',
    1,
    'R'
  );
  const elapsedMs = performance.now() - startTime;

  console.log(`[INFO] Generation completed in ${(elapsedMs / 1000).toFixed(2)}s`);

  // Extract layout data
  const layout = {
    seed,
    floor,
    buildingW,
    buildingD,
    generatedAt: new Date().toISOString(),
    elapsedMs,
    rooms: {},
    violations: result.violations || [],
    debugLog: window.layoutDebugLog || [],
  };

  // Include phase information if available
  if (result.stopPhase) {
    layout.stopPhase = result.stopPhase;
  }

  // Collect per-cell grid data for cell-accurate SVG rendering
  const cellsData = floor === 'ground' ? result.groundCells : result.level1Cells;
  if (cellsData) {
    layout.gridCells = cellsData;
  }

  // Collect room data from result
  const placements = floor === 'ground' ? result.groundPlacements : result.level1Placements;
  if (placements && typeof placements === 'object') {
    for (const [roomId, placement] of Object.entries(placements)) {
      if (!placement) continue;
      layout.rooms[roomId] = {
        id: roomId,
        label: ROOM_DEFS[roomId]?.label || roomId,
        x: placement.x || 0,
        y: placement.y || 0,
        w: placement.w || 0,
        d: placement.d || 0,
        actualArea: (placement.w || 0) * (placement.d || 0),
        vertices: placement.vertices ? (Array.isArray(placement.vertices) ? placement.vertices.length : placement.vertices) : 4,
        utilization: placement.utilization || 1.0,
      };
    }
  }

  return layout;
}

// ── SVG Visualization ─────────────────────────────────────────────

// Returns merged horizontal and vertical border edge segments for a set of grid cells.
// Each edge is a boundary between a cell in the room and a cell outside it.
function getRoomBorderEdges(cells) {
  const cellSet = new Set(cells.map(c => `${c.x},${c.y}`));
  const hEdges = {}; // key: y → sorted x-segments
  const vEdges = {}; // key: x → sorted y-segments

  for (const { x, y } of cells) {
    if (!cellSet.has(`${x},${y - 1}`)) { const k = y;     (hEdges[k] = hEdges[k] || []).push(x); }
    if (!cellSet.has(`${x},${y + 1}`)) { const k = y + 1; (hEdges[k] = hEdges[k] || []).push(x); }
    if (!cellSet.has(`${x - 1},${y}`)) { const k = x;     (vEdges[k] = vEdges[k] || []).push(y); }
    if (!cellSet.has(`${x + 1},${y}`)) { const k = x + 1; (vEdges[k] = vEdges[k] || []).push(y); }
  }

  const merged = [];

  // Merge consecutive unit-segments on the same row into longer horizontal lines
  for (const [yk, xs] of Object.entries(hEdges)) {
    const sorted = [...new Set(xs)].sort((a, b) => a - b);
    let start = sorted[0], prev = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === prev + 1) { prev = sorted[i]; }
      else { merged.push({ x1: start, y1: +yk, x2: prev + 1, y2: +yk }); start = prev = sorted[i]; }
    }
    merged.push({ x1: start, y1: +yk, x2: prev + 1, y2: +yk });
  }

  // Merge consecutive unit-segments on the same column into longer vertical lines
  for (const [xk, ys] of Object.entries(vEdges)) {
    const sorted = [...new Set(ys)].sort((a, b) => a - b);
    let start = sorted[0], prev = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === prev + 1) { prev = sorted[i]; }
      else { merged.push({ x1: +xk, y1: start, x2: +xk, y2: prev + 1 }); start = prev = sorted[i]; }
    }
    merged.push({ x1: +xk, y1: start, x2: +xk, y2: prev + 1 });
  }

  return merged;
}

function generateDebugSVG(layout) {
  const GRID = 500; // grid cell size in mm
  const scale = 0.1; // 1 SVG unit = 10mm → each cell = 5px
  const cellPx = GRID * scale;
  const w = layout.buildingW * scale;
  const h = layout.buildingD * scale;
  const padding = 20;

  const colors = ['#fdebd0', '#d5f5e3', '#fadbd8', '#d6eaf8', '#ebdef0', '#d2b4de', '#a9dfbf', '#fad7a0'];
  const roomColorMap = {};
  let colorIdx = 0;
  for (const roomId of Object.keys(layout.rooms)) {
    roomColorMap[roomId] = colors[colorIdx++ % colors.length];
  }

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${w + padding * 2}" height="${h + padding * 2}" viewBox="0 0 ${w + padding * 2} ${h + padding * 2}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      .room-label { font-family: Arial; font-size: 110px; font-weight: bold; text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
      .room-stats { font-family: Arial; font-size: 75px; fill: #333; text-anchor: middle; }
      .debug-title { font-family: Arial; font-size: 14px; font-weight: bold; fill: #000; }
      .debug-info  { font-family: Arial; font-size: 12px; fill: #444; }
      .building-boundary { stroke: #000; stroke-width: 3; fill: none; }
      .grid-line { stroke: #ccc; stroke-width: 0.5; }
    </style>
  </defs>

  <!-- Building boundary -->
  <rect x="${padding}" y="${padding}" width="${w}" height="${h}" class="building-boundary" />

  <!-- Grid lines (500mm spacing) -->
  <g>`;

  for (let x = 0; x <= layout.buildingW; x += GRID) {
    svg += `<line x1="${padding + x * scale}" y1="${padding}" x2="${padding + x * scale}" y2="${padding + h}" class="grid-line"/>`;
  }
  for (let y = 0; y <= layout.buildingD; y += GRID) {
    svg += `<line x1="${padding}" y1="${padding + y * scale}" x2="${padding + w}" y2="${padding + y * scale}" class="grid-line"/>`;
  }
  svg += `</g>\n`;

  if (layout.gridCells) {
    // ── Cell-accurate mode: draw each grid cell as a filled square ──
    svg += `  <!-- Cell-accurate room rendering -->\n`;
    for (const [roomId, cells] of Object.entries(layout.gridCells)) {
      if (!layout.rooms[roomId]) continue; // skip super-rooms already split
      const color = roomColorMap[roomId] || '#eee';
      svg += `  <g id="room-${roomId}" fill="${color}" fill-opacity="0.75" stroke="none">\n`;
      for (const { x, y } of cells) {
        const px = padding + x * cellPx;
        const py = padding + y * cellPx;
        svg += `    <rect x="${px}" y="${py}" width="${cellPx}" height="${cellPx}"/>\n`;
      }
      svg += `  </g>\n`;
    }

    // Room boundary outlines (actual cell perimeter)
    svg += `  <!-- Room boundary outlines -->\n`;
    for (const [roomId, cells] of Object.entries(layout.gridCells)) {
      if (!layout.rooms[roomId]) continue;
      const edges = getRoomBorderEdges(cells);
      svg += `  <g stroke="#444" stroke-width="3" stroke-linecap="square">\n`;
      for (const { x1, y1, x2, y2 } of edges) {
        svg += `    <line x1="${padding + x1 * cellPx}" y1="${padding + y1 * cellPx}" x2="${padding + x2 * cellPx}" y2="${padding + y2 * cellPx}"/>\n`;
      }
      svg += `  </g>\n`;
    }

    // Room labels (centered on bounding box)
    svg += `  <!-- Room labels -->\n`;
    for (const [roomId, room] of Object.entries(layout.rooms)) {
      const cx = padding + (room.x + room.w / 2) * scale;
      const cy = padding + (room.y + room.d / 2) * scale;
      const area = Math.round(room.actualArea / 1000000);
      svg += `  <text x="${cx}" y="${cy - 45}" class="room-label">${room.label || roomId}</text>\n`;
      svg += `  <text x="${cx}" y="${cy + 55}" class="room-stats">V:${room.vertices} ${area}m²</text>\n`;
    }
  } else {
    // ── Fallback: bounding-box rectangles ──
    svg += `  <!-- Bounding-box room rendering (no gridCells available) -->\n`;
    for (const [roomId, room] of Object.entries(layout.rooms)) {
      const color = roomColorMap[roomId] || '#eee';
      const x = padding + room.x * scale;
      const y = padding + room.y * scale;
      const rw = room.w * scale;
      const rh = room.d * scale;
      const area = Math.round(room.actualArea / 1000000);
      svg += `  <rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="${color}" fill-opacity="0.5" stroke="#444" stroke-width="3"/>\n`;
      svg += `  <text x="${x + rw / 2}" y="${y + rh / 2 - 14}" class="room-label">${roomId}</text>\n`;
      svg += `  <text x="${x + rw / 2}" y="${y + rh / 2 + 14}" class="room-stats">V:${room.vertices} ${area}m²</text>\n`;
    }
  }

  // Info box
  const phase = layout.stopPhase ? `Phase ${layout.stopPhase}` : 'Full';
  svg += `
  <!-- Info box -->
  <rect x="${padding + 4}" y="${padding + 4}" width="200" height="84" fill="white" fill-opacity="0.92" stroke="#aaa" stroke-width="1" rx="3"/>
  <text x="${padding + 10}" y="${padding + 18}" class="debug-title">${phase} · ${layout.floor} · seed=${layout.seed}</text>
  <text x="${padding + 10}" y="${padding + 34}" class="debug-info">Building: ${layout.buildingW/1000}m × ${layout.buildingD/1000}m</text>
  <text x="${padding + 10}" y="${padding + 48}" class="debug-info">Rooms: ${Object.keys(layout.rooms).length}   Time: ${(layout.elapsedMs/1000).toFixed(2)}s</text>
  <text x="${padding + 10}" y="${padding + 62}" class="debug-info">Render: ${layout.gridCells ? 'cell-accurate' : 'bounding-box'}</text>
  <text x="${padding + 10}" y="${padding + 76}" class="debug-info">Violations: ${layout.violations.length}</text>
</svg>`;

  return svg;
}

// ── Validation ─────────────────────────────────────────────────────

function validateLayout(layout) {
  const errors = [];
  const warnings = [];

  // Check room overlap (simple AABB check)
  const roomList = Object.values(layout.rooms);
  for (let i = 0; i < roomList.length; i++) {
    for (let j = i + 1; j < roomList.length; j++) {
      const r1 = roomList[i];
      const r2 = roomList[j];
      const overlap = !(
        r1.x + r1.w <= r2.x ||
        r2.x + r2.w <= r1.x ||
        r1.y + r1.d <= r2.y ||
        r2.y + r2.d <= r1.y
      );
      if (overlap) {
        errors.push(`Rooms overlap: ${r1.id} and ${r2.id}`);
      }
    }
  }

  // Check vertex count
  for (const [id, room] of Object.entries(layout.rooms)) {
    if (room.vertices > 8 && id !== 'corridor_l1') {
      errors.push(`Room ${id} has ${room.vertices} vertices (max 8)`);
    }
    if (room.utilization < 0.60) {
      warnings.push(`Room ${id} has low utilization: ${(room.utilization * 100).toFixed(1)}% (min 60%)`);
    }
  }

  // Check constraints
  if (layout.violations && layout.violations.length > 0) {
    warnings.push(`${layout.violations.length} constraint violation(s)`);
  }

  return { errors, warnings };
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  // Handle all-cases mode
  if (opts.allCases) {
    console.log('[INFO] Running all predefined test cases...\n');
    const results = [];
    for (const [, caseConfig] of Object.entries(DEBUG_CASES)) {
      console.log(`\n=== Test Case: ${caseConfig.name} ===`);
      console.log(`Description: ${caseConfig.description}`);
      try {
        const layout = await generateLayout(caseConfig.seed, caseConfig.buildingW, caseConfig.buildingD, caseConfig.floor, opts.phase);
        results.push(layout);

        if (opts.validate) {
          const { errors, warnings } = validateLayout(layout);
          if (errors.length > 0) {
            console.log(`[ERROR] ${errors.join('\n[ERROR] ')}`);
          }
          if (warnings.length > 0) {
            console.log(`[WARN] ${warnings.join('\n[WARN] ')}`);
          }
          if (errors.length === 0 && warnings.length === 0) {
            console.log('[OK] No violations detected');
          }
        }
      } catch (e) {
        console.error(`[ERROR] Test case ${caseConfig.name} failed:`, e.message);
      }
    }

    if (opts.output) {
      fs.writeFileSync(opts.output, JSON.stringify(results, null, 2));
      console.log(`\n[INFO] Results saved to ${opts.output}`);
    }
    process.exit(0);
  }

  // Determine test case or use custom parameters
  let buildingW, buildingD, seed, floor;

  if (opts.case && DEBUG_CASES[opts.case]) {
    const caseConfig = DEBUG_CASES[opts.case];
    seed = caseConfig.seed;
    buildingW = caseConfig.buildingW;
    buildingD = caseConfig.buildingD;
    floor = opts.floor || caseConfig.floor;  // User --floor takes precedence
    console.log(`[INFO] Using predefined case: ${opts.case}`);
    console.log(`[INFO] ${caseConfig.description}\n`);
  } else {
    seed = opts.seed || 42;
    buildingW = opts.buildingW || 30000;
    buildingD = opts.buildingD || 20000;
    floor = opts.floor || 'ground';
  }

  try {
    const layout = await generateLayout(seed, buildingW, buildingD, floor, opts.phase);

    // Validation
    if (opts.validate) {
      const { errors, warnings } = validateLayout(layout);
      console.log('\n=== Validation Report ===');
      if (errors.length > 0) {
        console.error(`[ERROR] ${errors.length} error(s):`);
        errors.forEach(e => console.error(`  - ${e}`));
      } else {
        console.log('[OK] No errors detected');
      }
      if (warnings.length > 0) {
        console.warn(`[WARN] ${warnings.length} warning(s):`);
        warnings.forEach(w => console.warn(`  - ${w}`));
      }
    }

    // Output JSON
    if (opts.output) {
      fs.writeFileSync(opts.output, JSON.stringify(layout, null, 2));
      console.log(`\n[INFO] Layout saved to ${opts.output}`);
    }

    // Generate SVG
    if (opts.visualize) {
      const svg = generateDebugSVG(layout);
      fs.writeFileSync(opts.visualize, svg);
      console.log(`[INFO] Visualization saved to ${opts.visualize}`);
    }

    // Print summary
    console.log('\n=== Layout Summary ===');
    console.log(`Rooms: ${Object.keys(layout.rooms).length}`);
    console.log(`Total violations: ${layout.violations.length}`);
    if (window.timeCostLog && window.timeCostLog.length > 0) {
      console.log('\nPerformance breakdown:');
      window.timeCostLog.forEach(entry => {
        console.log(`  ${entry.fn}: ${entry.duration.toFixed(3)}s`);
      });
    }
  } catch (e) {
    console.error('[ERROR] Layout generation failed:');
    console.error(e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
