// Visual landmarks belong to one result and its immutable, analysis-aligned image.
// They are independent of measurements, aperture masks and height/sign references.
import { fr, $ } from './fringe.js';
import { GAP_DIRECTIONS, physicalOrientation, orientationSvg, polarityDescription } from './fringe-orientation.js';

export function referenceMarks(result) {
  if (!result?.reference_image_b64 || !Array.isArray(result.reference_marks)) return [];
  const used = new Set();
  return result.reference_marks.filter(p => {
    if (!p || !/^[A-Z]$/.test(p.label) || used.has(p.label)
        || !Number.isFinite(p.x) || !Number.isFinite(p.y)
        || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return false;
    used.add(p.label);
    return true;
  }).map(({label, x, y}) => ({label, x, y}));
}

export function referencePosition(clientX, clientY, rect) {
  if (!(rect.width > 0 && rect.height > 0)) return null;
  return {x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))};
}

export function addReferenceMark(marks, point) {
  const label = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(l => !marks.some(p => p.label === l));
  return label ? [...marks, {label, ...point}] : marks;
}

export function referenceSvg(marks, width, height, selected = null) {
  if (!(width > 0 && height > 0)) return '';
  return marks.map(p => {
    const x = p.x * width, y = p.y * height;
    const color = p.label === selected ? '#fff' : '#ffe15a';
    const tx = x > width - 30 ? x - 13 : x + 13;
    const ty = y < 25 ? y + 24 : y - 12;
    return `<g fill="none" stroke="${color}" stroke-width="2">
      <circle cx="${x}" cy="${y}" r="8" style="filter:drop-shadow(0 1px 2px #000)"/>
      <path d="M${x-3},${y}h6 M${x},${y-3}v6"/>
      <text x="${tx}" y="${ty}" text-anchor="${tx < x ? 'end' : 'start'}" fill="${color}" stroke="#161616" stroke-width="3" paint-order="stroke" font-size="16" font-weight="700">${p.label}</text></g>`;
  }).join('');
}

let dialog = null, owner = null, selected = null, undo = [], exportReport = null;

function draw(svg, image, marks, selection, result = fr.lastResult) {
  if (!svg || !image) return;
  const w = image.clientWidth, h = image.clientHeight;
  svg.setAttribute('viewBox', `0 0 ${w || 1} ${h || 1}`);
  svg.innerHTML = referenceSvg(marks, w, h, selection) + orientationSvg(result, w, h);
}

export function refreshReferenceMarks(result = fr.lastResult) {
  // Changing capture, resetting, or recomputing closes an old editing session.
  if (dialog?.open) dialog.close();
  const btn = $('fringe-reference-open');
  if (btn) {
    btn.disabled = !result?.reference_image_b64;
    btn.title = result?.reference_image_b64 ? 'Place matching landmarks on the interferogram and surface map'
      : 'Analyze an image to create an aligned interferogram preview';
  }
  draw($('fringe-reference-svg'), $('fringe-surface-img'), referenceMarks(result), null, result);
}

function redraw() {
  if (!owner || owner !== fr.lastResult) { dialog?.close(); return; }
  const marks = referenceMarks(owner);
  for (const side of ['source', 'surface']) {
    draw($(`fringe-reference-${side}-svg`), $(`fringe-reference-${side}`), marks, selected);
  }
  draw($('fringe-reference-svg'), $('fringe-surface-img'), marks);
  $('fringe-reference-labels').innerHTML = marks.map(p =>
    `<button type="button" data-label="${p.label}" aria-pressed="${p.label === selected}">${p.label}</button>`).join('');
  $('fringe-reference-delete').disabled = !selected;
  $('fringe-reference-clear').disabled = !marks.length;
  $('fringe-reference-undo').disabled = !undo.length;
  $('fringe-reference-count').textContent = `${marks.length}/26 marks`;
  const contact=$('fringe-orientation-contact');
  const record=physicalOrientation(owner);
  if (owner.physical_orientation) owner.physical_orientation.contact_label=record.contact_label;
  contact.innerHTML='<option value="">Not recorded</option>'+marks.map(p=>`<option value="${p.label}">${p.label}</option>`).join('');
  contact.value=record.contact_label || '';
  const status=$('fringe-orientation-status');
  if (status) status.textContent=polarityDescription(owner);
  document.dispatchEvent(new CustomEvent('fringe:orientation-changed'));

}

function remember() {
  undo.push({marks:referenceMarks(owner), orientation:structuredClone(owner.physical_orientation)});
  if (undo.length > 50) undo.shift();
}

function restoreEdit() {
  const saved=undo.pop();
  if (!saved || !owner) return;
  owner.reference_marks=saved.marks;
  if (saved.orientation) owner.physical_orientation=saved.orientation;
  else delete owner.physical_orientation;
  syncOrientationInputs();
}
function syncOrientationInputs() {
  const record=physicalOrientation(owner);
  $('fringe-orientation-direction').value=record.gap_direction;
  $('fringe-orientation-polarity').value=record.polarity;
  $('fringe-orientation-notes').value=record.notes;
}
function fitImages() {
  const zoom = Number($('fringe-reference-zoom').value);
  for (const frame of dialog.querySelectorAll('.fringe-reference-frame')) {
    const img = frame.querySelector('img'), pane = frame.parentElement;
    if (!img.naturalWidth || !img.naturalHeight) continue;
    const height = parseFloat(getComputedStyle(pane).height);
    frame.style.width = `${Math.min(pane.clientWidth, height * img.naturalWidth / img.naturalHeight) * zoom}px`;
  }
  redraw();
}

function buildDialog() {
  dialog = document.createElement('dialog');
  dialog.id = 'fringe-reference-dialog';
  dialog.className = 'fringe-reference-dialog';
  dialog.setAttribute('aria-labelledby', 'fringe-reference-title');
  dialog.innerHTML = `<header><div><h2 id="fringe-reference-title">Reference marks</h2>
    <p>Click either image to add a matching label. Drag a mark to adjust it.</p></div>
    <div><button type="button" id="fringe-reference-export">Export report</button> <button type="button" id="fringe-reference-done">Done</button></div></header>
    <div class="fringe-reference-tools">
      <span id="fringe-reference-labels" aria-label="Select a mark"></span>
      <button type="button" id="fringe-reference-delete">Delete selected</button>
      <button type="button" id="fringe-reference-undo">Undo</button>
      <button type="button" id="fringe-reference-clear">Clear marks</button>
      <label>Zoom <input id="fringe-reference-zoom" type="range" min="1" max="4" step="0.25" value="1" /></label>
      <span id="fringe-reference-count" role="status"></span>
    </div>
    <div class="fringe-reference-pair">${['source', 'surface'].map(side => `<section>
      <h3>${side === 'source' ? 'Interferogram · analysis crop' : 'Surface map'}</h3>
      <div class="fringe-reference-scroll"><div class="fringe-reference-frame" data-side="${side}">
        <img id="fringe-reference-${side}" draggable="false" alt="${side === 'source' ? 'Interferogram aligned with the analysis' : 'Analyzed surface'}" />
        <svg id="fringe-reference-${side}-svg" aria-hidden="true"></svg>
      </div></div></section>`).join('')}</div>
    <details class="fringe-orientation-settings">
      <summary>Physical orientation &amp; contact record</summary>
      <p>Record observations from the physical setup. Image directions refer to the views above. Loupe does not infer polarity or absolute gap from these entries.</p>
      <div class="fringe-orientation-fields">
        <label>Gap opens toward <select id="fringe-orientation-direction">${Object.entries(GAP_DIRECTIONS).map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label>
        <label>Known contact landmark <select id="fringe-orientation-contact"></select></label>
        <label>Physically checked display polarity <select id="fringe-orientation-polarity"><option value="unverified">Not checked</option><option value="red-larger-gap">Red = larger air-gap departure</option><option value="red-smaller-gap">Red = smaller air-gap departure</option></select></label>
      </div>
      <label>How you checked it / setup notes <textarea id="fringe-orientation-notes" maxlength="1000" rows="2" placeholder="For example: known wedge direction, reference feature, fixture orientation…"></textarea></label>
      <p id="fringe-orientation-status" role="status"></p>
      <p>Contact is recorded for interpretation; it does not set height zero. Inverting the displayed map also reverses the recorded red/blue meaning. A fresh analysis requires a new record.</p>
    </details>
    <p class="fringe-reference-note">Both views use the same crop and lens correction. Marks stay on the surface map and are saved with the current result in your project. A mark only identifies contact if you explicitly record it above; it never sets height zero. A new analysis starts with no marks.</p>`;
  document.body.appendChild(dialog);
  $('fringe-reference-export').onclick = () => exportReport?.();
  $('fringe-reference-done').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { owner = null; selected = null; undo = []; });
  $('fringe-reference-labels').onclick = e => {
    if (e.target.dataset.label) { selected = e.target.dataset.label; redraw(); }
  };
  $('fringe-reference-delete').onclick = () => {
    remember(); owner.reference_marks = referenceMarks(owner).filter(p => p.label !== selected);
    selected = null; redraw();
  };
  $('fringe-reference-clear').onclick = () => {
    remember(); owner.reference_marks = []; selected = null; redraw();
  };
  $('fringe-reference-undo').onclick = () => {
    if (undo.length) restoreEdit();
    selected = null; redraw();
  };
  $('fringe-reference-zoom').oninput = e => {
    fitImages();
  };
  for (const id of ['direction','contact','polarity','notes']) {
    $(`fringe-orientation-${id}`).addEventListener(id==='notes'?'input':'change', () => {
      if (!owner || owner!==fr.lastResult) return;
      remember();
      owner.physical_orientation={gap_direction:$('fringe-orientation-direction').value,
        contact_label:$('fringe-orientation-contact').value || null,
        polarity:$('fringe-orientation-polarity').value, notes:$('fringe-orientation-notes').value,
        recorded_at:new Date().toISOString()};
      redraw();
    });
  }
  dialog.querySelector('.fringe-orientation-settings').addEventListener('toggle', e => {
    dialog.classList.toggle('orientation-open',e.target.open);
    dialog.scrollTop=0;
    fitImages();
  });
  const panes = [...dialog.querySelectorAll('.fringe-reference-scroll')];
  panes.forEach((pane, i) => pane.addEventListener('scroll', () => {
    const other = panes[1 - i];
    if (other.scrollLeft !== pane.scrollLeft) other.scrollLeft = pane.scrollLeft;
    if (other.scrollTop !== pane.scrollTop) other.scrollTop = pane.scrollTop;
  }));
  for (const frame of dialog.querySelectorAll('.fringe-reference-frame')) {
    const img = frame.querySelector('img');
    let dragging = null;
    img.onload = fitImages;
    frame.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !owner || owner !== fr.lastResult) return;
      const rect = img.getBoundingClientRect();
      const point = referencePosition(e.clientX, e.clientY, rect);
      if (!point) return;
      const marks = referenceMarks(owner);
      const nearest = marks.map(p => ({p, d: Math.hypot((p.x-point.x)*rect.width, (p.y-point.y)*rect.height)}))
        .sort((a, b) => a.d-b.d)[0];
      if ((!nearest || nearest.d > 18) && marks.length >= 26) return;
      remember();
      if (nearest && nearest.d <= 18) selected = nearest.p.label;
      else { owner.reference_marks = addReferenceMark(marks, point); selected = owner.reference_marks.at(-1).label; }
      dragging = e.pointerId;
      frame.setPointerCapture(e.pointerId);
      e.preventDefault(); redraw();
    });
    frame.addEventListener('pointermove', e => {
      if (dragging !== e.pointerId || !owner || owner !== fr.lastResult) return;
      const point = referencePosition(e.clientX, e.clientY, img.getBoundingClientRect());
      if (!point) return;
      owner.reference_marks = referenceMarks(owner).map(p => p.label === selected ? {...p, ...point} : p);
      redraw();
    });
    frame.addEventListener('pointerup', () => { dragging = null; });
    frame.addEventListener('pointercancel', () => {
      if (dragging !== null && owner && undo.length) restoreEdit();
      dragging = null; redraw();
    });
  }
  new ResizeObserver(() => { if (dialog.open) fitImages(); }).observe(dialog);
}

export function wireReferenceMarks(onExport) {
  exportReport = onExport;
  $('fringe-reference-open')?.addEventListener('click', () => {
    if (!fr.lastResult?.reference_image_b64) return;
    if (!dialog) buildDialog();
    owner = fr.lastResult; selected = null; undo = [];
    syncOrientationInputs();
    $('fringe-reference-source').src = `data:image/png;base64,${owner.reference_image_b64}`;
    $('fringe-reference-surface').src = `data:image/png;base64,${owner.surface_map}`;
    $('fringe-reference-zoom').value = '1';
    dialog.querySelectorAll('.fringe-reference-frame').forEach(el => { el.style.width = '100%'; });
    dialog.showModal();
    dialog.querySelectorAll('.fringe-reference-scroll').forEach(el => { el.scrollLeft = el.scrollTop = 0; });
    fitImages();
  });
  const img = $('fringe-surface-img');
  if (img) {
    img.addEventListener('load', () => draw($('fringe-reference-svg'), img, referenceMarks(fr.lastResult)));
    new ResizeObserver(() => draw($('fringe-reference-svg'), img, referenceMarks(fr.lastResult))).observe(img);
  }
}
