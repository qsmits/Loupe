// frontend/palette.js — the verb-first "Measure…" task index. The ONLY
// creation surface for relation measurements; also the discovery layer over
// the toolbar tools. No selection-context filtering by design (spec §2).
import { h, render } from './vendor/preact.mjs';
import htm from './vendor/htm.mjs';
import { state } from './state.js';

const html = htm.bind(h);
let _mount = null;

export const TASKS = [
  // Distances
  { id: 'distance', group: 'Distances', icon: '↔', title: 'Distance between two points',
    desc: 'Click two points — snaps to edges and centers', action: { tool: 'distance' }, keywords: 'length gap measure' },
  { id: 'circle-circle', group: 'Distances', icon: '◎↔◎', title: 'Distance between two circles',
    desc: 'Pick or fit two circles — center distance, min gap or max span', action: { tool: 'center-dist' }, keywords: 'center pitch bolt hole' },
  { id: 'point-circle', group: 'Distances', icon: '•↔◎', title: 'Distance from point to circle',
    desc: 'Pick a circle, then a point — gap to the edge', action: { tool: 'pt-circle-dist' }, keywords: 'edge gap clearance' },
  { id: 'perp', group: 'Distances', icon: '⊥', title: 'Perpendicular distance from a line',
    desc: 'Pick a reference line, then start and end points', action: { tool: 'perp-dist' }, keywords: 'offset height normal' },
  { id: 'para', group: 'Distances', icon: '∥', title: 'Parallel distance / parallelism',
    desc: 'Pick a line, then another line (parallelism) or a point', action: { tool: 'para-dist' }, keywords: 'parallel offset' },
  { id: 'slot', group: 'Distances', icon: '⇿', title: 'Width between two lines',
    desc: 'Slot or groove width between two edges', action: { tool: 'slot-dist' }, keywords: 'slot groove gap width' },
  // Angles & position
  { id: 'angle-lines', group: 'Angles & position', icon: '∠', title: 'Angle between two lines',
    desc: 'Click two existing lines', action: { tool: 'angle', angleMode: 'two-lines' }, keywords: 'degrees' },
  { id: 'angle-points', group: 'Angles & position', icon: '∠·', title: 'Angle by three points',
    desc: 'Arm point, vertex, arm point', action: { tool: 'angle', angleMode: 'three-points' }, keywords: 'degrees vertex' },
  { id: 'intersect', group: 'Angles & position', icon: '✚', title: 'Intersection of two lines',
    desc: 'Click two lines — coordinates in the reference frame', action: { tool: 'intersect' }, keywords: 'cross corner point' },
  { id: 'point', group: 'Angles & position', icon: '·', title: 'Reference point',
    desc: 'Place a point — snaps to edges and centers', action: { tool: 'point' }, keywords: 'datum mark' },
  // Circles & arcs
  { id: 'circle-3pt', group: 'Circles & arcs', icon: '○', title: 'Circle through three points',
    desc: 'Click three points on the edge', action: { tool: 'circle', circleMode: '3-point' }, keywords: 'diameter radius bore hole' },
  { id: 'best-fit', group: 'Circles & arcs', icon: '◎', title: 'Best-fit circle or arc to an edge',
    desc: 'Place many points — least-squares fit with RMS', action: { tool: 'arc-fit' }, keywords: 'diameter radius fit ols' },
  { id: 'arc', group: 'Circles & arcs', icon: '◠', title: 'Arc through three points',
    desc: 'Radius and sweep of a partial arc', action: { tool: 'arc-measure' }, keywords: 'radius sweep' },
  // Areas & profiles
  { id: 'area', group: 'Areas & profiles', icon: '▱', title: 'Area of a polygon',
    desc: 'Click vertices, Enter to close', action: { tool: 'area' }, keywords: 'surface polygon' },
  { id: 'area-shape', group: 'Areas & profiles', icon: '⬠', title: 'Area from a closed shape',
    desc: 'One click on a closed loop of measurements', action: { tool: 'area-shape' }, keywords: 'surface trace' },
  { id: 'spline', group: 'Areas & profiles', icon: '〜', title: 'Spline through points',
    desc: 'Smooth curve through anchors', action: { tool: 'spline' }, keywords: 'curve profile' },
  { id: 'flatness', group: 'Areas & profiles', icon: '▬', title: 'Flatness of an edge',
    desc: 'Points along a nominally straight edge — line fit + RMS', action: { tool: 'fit-line' }, keywords: 'straightness line fit' },
  // Reference
  { id: 'calibrate', group: 'Reference', icon: '⌖', title: 'Calibrate the image scale',
    desc: 'Known distance or known circle diameter', action: { tool: 'calibrate' }, keywords: 'scale mm pixel' },
];

export function filterTasks(tasks, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter(t =>
    `${t.title} ${t.desc} ${t.keywords || ''} ${t.group}`.toLowerCase().includes(q));
}

function _arm(task) {
  closePalette();
  document.dispatchEvent(new CustomEvent('set-tool', { detail: task.action }));
}

export function MeasurePalette() {
  if (!state.paletteOpen) return null;
  const tasks = filterTasks(TASKS, state.paletteQuery);
  const groups = [...new Set(tasks.map(t => t.group))];
  return html`<div class="palette-backdrop" onClick=${e => { if (e.target === e.currentTarget) closePalette(); }}>
    <div class="palette">
      <input class="palette-search" placeholder="Search measuring tasks…" autofocus
        value=${state.paletteQuery || ''}
        onInput=${e => { state.paletteQuery = e.target.value; renderPalette(); }}
        onKeyDown=${e => {
          if (e.key === 'Escape') { e.stopPropagation(); closePalette(); }
          else if (e.key === 'Enter' && tasks.length) { e.stopPropagation(); _arm(tasks[0]); }
        }} />
      ${groups.map(g => html`<div class="palette-group">${g}</div>
        ${tasks.filter(t => t.group === g).map(t => html`<div
          class="palette-task ${t === tasks[0] ? 'hl' : ''}" onClick=${() => _arm(t)}>
          <div class="palette-ic">${t.icon}</div>
          <div><div class="palette-tt">${t.title}</div><div class="palette-td">${t.desc}</div></div>
        </div>`)}`)}
      ${tasks.length === 0 ? html`<div class="palette-empty">No task matches — try "distance", "circle", "angle"…</div>` : null}
    </div>
  </div>`;
}

export function renderPalette() {
  if (!_mount) return;
  render(html`<${MeasurePalette} />`, _mount);
}
export function openPalette() {
  state.paletteOpen = true; state.paletteQuery = '';
  renderPalette();
  // focus the search box after Preact commits — requestAnimationFrame isn't
  // defined under the node --test dom-stub environment.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => _mount?.querySelector('.palette-search')?.focus());
  }
}
export function closePalette() {
  state.paletteOpen = false;
  renderPalette();
}
export function initPalette() {
  _mount = document.getElementById('palette-mount');
  document.addEventListener('workspace-changed', renderPalette);
  renderPalette();
}
