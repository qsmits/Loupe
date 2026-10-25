// A single setup/progress dialog. Existing settings nodes are moved here so
// listeners and project persistence continue to use one source of truth.
import { fr, $ } from './fringe.js';
import { regionFromDrag, circleRegionFromPoints, regionBounds, moveRegion, resizeRegion, regionContains } from './fringe-region.js';
import { getActiveRecipe, recipeToMaskPolygons, setActiveRecipeId } from './fringe-geometry.js';
import { drawMaskOverlay, refreshRecipeUi } from './fringe-panel.js';
import { captureFringeOptions } from './fringe-results.js';
import { createProgressBar } from './fringe-progress.js';
import { maybeShowUploadNotice } from './upload-notice.js';

let image = null;
let dragStart = null;
let draft = null;
let busy = false;
let ready = false;
let imageVersion = 0;
let circlePoints = [];
let selected = -1;
let editDrag = null;
let regionHistory = [];
const clone = value => JSON.parse(JSON.stringify(value));

export function initFringeSetup(onAnalyze, onCancel) {
  const dialog = document.createElement('dialog');
  dialog.id = 'fringe-setup-dialog';
  dialog.className = 'dialog-overlay fringe-setup-dialog fringe-image-drop-target';
  dialog.hidden = true;
  dialog.setAttribute('aria-labelledby', 'fringe-setup-title');
  dialog.innerHTML = `
    <header class="fringe-setup-header">
      <div><h2 id="fringe-setup-title">Set up fringe analysis</h2>
        <p id="fringe-setup-source"></p></div>
      <button id="fringe-setup-close" aria-label="Close analysis setup">✕</button>
    </header>
    <div id="fringe-setup-options" class="fringe-setup-body">
      <fieldset id="fringe-area-controls" class="fringe-area-controls">
        <legend>Area to measure</legend>
        <p>Trace the part surface to its physical edge. Exclude holes, dust, glare, and background.
          Your outline defines the part area; the analysis still rejects weak or unreliable fringes and applies a boundary guard. You do not need to leave an extra margin yourself.</p>
        <div class="fringe-region-tools">
          <label>Tool <select id="fringe-region-shape"><option value="circle">Circle · 3 points</option><option value="ellipse">Ellipse · drag corners</option><option value="rectangle">Rectangle</option><option value="edit">Select / edit</option></select></label>
          <label>Purpose <select id="fringe-region-purpose"><option value="include">Include surface</option><option value="exclude">Exclude defect / hole</option></select></label>
          <button type="button" id="fringe-region-undo">Undo edit</button>
          <button type="button" id="fringe-region-delete" disabled>Delete region</button>
          <button type="button" id="fringe-region-clear">Use automatic area</button>
        </div>
        <div class="fringe-region-preview"><canvas id="fringe-region-canvas" width="640" height="400" tabindex="0"
          aria-label="Analysis area preview. Click three points on a circle edge, or select and drag a region to edit it. Coordinate fields are available below."></canvas></div>
        <p id="fringe-region-status" role="status"></p>
        <label class="fringe-region-picker">Selected region <select id="fringe-region-select"><option value="">None</option></select></label>
        <details class="fringe-region-coordinates"><summary>Region coordinates</summary>
          <div class="fringe-region-tools">
            <label>Left % <input id="fringe-region-x" type="number" min="0" max="100" step="any" value="10"></label>
            <label>Top % <input id="fringe-region-y" type="number" min="0" max="100" step="any" value="10"></label>
            <label>Width % <input id="fringe-region-w" type="number" min="0.5" max="100" step="any" value="80"></label>
            <label>Height % <input id="fringe-region-h" type="number" min="0.5" max="100" step="any" value="80"></label>
            <button type="button" id="fringe-region-add">Add region</button>
          </div>
        </details>
        <p class="fringe-region-hint">Blue = included · Red = excluded. Click three points spread around a circular edge.
          Select / edit: drag a region to move it, or a corner handle to resize. Circle handles keep it round.</p>
      </fieldset>
      <fieldset id="fringe-setup-settings"><legend>Analysis settings</legend>
        <div class="detect-section">
          <label for="fringe-analysis-engine">Analyze using</label>
          <select id="fringe-analysis-engine"><option value="server">Server (established)</option><option value="browser">This browser (experimental)</option></select>
          <p id="fringe-engine-note">Browser mode keeps the image on this device and downloads scientific libraries on first use. Images are limited to 1024 pixels on the longest side. Use the server for larger analyses. Camera capture still needs the camera connection.</p>
        </div>
        <div class="detect-section">
          <label for="fringe-analysis-method">Analysis method</label>
          <select id="fringe-analysis-method" aria-describedby="fringe-method-note"><option value="current">Current method (default)</option><option value="hybrid">Hybrid quadratic fit (experimental)</option></select>
          <p id="fringe-method-note">Hybrid tries local fits where checks pass and uses the current method elsewhere. It can retain more edges, but may still misread sharp roll-off or scratches. Slower and more memory intensive; maximum image side 1024 px. Browser mode resizes automatically. For comparison, use the same engine, resolution, mask, wavelength and form removal for both runs. Export the first result before analyzing again; browser runs also appear in Session while this tab stays open.</p>
        </div>
        <div id="fringe-settings-host"></div>
        <div class="detect-section">
          <label for="fringe-setup-form">Form removal</label>
          <select id="fringe-setup-form"><option value="plane">Flatness · Plane (tilt only)</option><optgroup label="Advanced form removal"><option value="zernike">Zernike · selected terms</option><option value="poly2">Polynomial, order 2</option><option value="poly3">Polynomial, order 3</option></optgroup></select>
          <p>For flatness, remove only height offset and tilt. Plane retains bow, curvature and other surface errors. Advanced removal can hide those errors; its PV/RMS describe the residual shape.</p>
        </div>
      </fieldset>
    </div>
    <section id="fringe-setup-progress" hidden aria-label="Analysis progress"></section>
    <footer class="fringe-setup-footer">
      <span id="fringe-setup-note" role="status">Review the image and settings, then start.</span>
      <button id="fringe-setup-cancel">Cancel</button>
      <button id="fringe-setup-start" class="fringe-primary">Analyze image</button>
    </footer>`;
  document.body.appendChild(dialog);
  const oldSettings = $('dropdown-fringe-settings');
  if (oldSettings) $('fringe-settings-host').append(...oldSettings.children);
  createProgressBar($('fringe-setup-progress'));

  const close = () => { onCancel(); closeFringeSetup(); };
  $('fringe-setup-close').onclick = close;
  $('fringe-setup-cancel').onclick = close;
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  $('fringe-setup-start').onclick = async () => {
    if (!ready || busy) return;
    const custom = $('fringe-custom-wl');
    if ($('fringe-wavelength')?.value === 'custom' && !custom.reportValidity()) return;
    const dc = $('fringe-dc-margin');
    if (!$('fringe-dc-margin-auto')?.checked && !dc.reportValidity()) return;
    // Existing hosted-upload notice is outside the native dialog's top
    // layer. Temporarily yield focus to it before any upload or timeout.
    const version = imageVersion;
    busy = true;
    $('fringe-setup-start').disabled = true;
    dialog.close(); dialog.hidden = true;
    try {
      const engine = $('fringe-analysis-engine').value;
      if (engine !== 'browser') await maybeShowUploadNotice('/fringe/analyze-stream');
      if (version !== imageVersion) return;
      dialog.hidden = false; dialog.showModal();
      busy = false;
      $('fringe-setup-start').disabled = false;
      onAnalyze($('fringe-setup-form').value, engine, $('fringe-analysis-method').value);
    } catch (error) {
      if (version !== imageVersion) return;
      dialog.hidden = false; dialog.showModal();
      busy = false;
      $('fringe-setup-start').disabled = false;
      $('fringe-setup-note').textContent = error.message;
    }
  };
  $('fringe-region-undo').onclick = () => {
    if (circlePoints.length) { circlePoints.pop(); draft = null; refreshRegionEditor(); return; }
    const previous = regionHistory.pop();
    if (!previous) return;
    fr.maskPolygons = previous.polygons;
    setActiveRecipeId(previous.recipeId);
    selected = -1; editDrag = null;
    refreshRecipeUi(); refreshRegionEditor();
  };
  $('fringe-region-clear').onclick = () => {
    rememberRegions();
    fr.maskPolygons = []; circlePoints = []; selected = -1; draft = null;
    setActiveRecipeId(null);
    refreshRecipeUi(); refreshRegionEditor();
  };
  $('fringe-region-delete').onclick = deleteSelectedRegion;
  $('fringe-region-shape').onchange = () => {
    circlePoints = []; draft = null; selected = -1;
    refreshRegionEditor();
  };
  $('fringe-region-select').onchange = () => {
    selected = $('fringe-region-select').value === '' ? -1 : Number($('fringe-region-select').value);
    circlePoints = []; draft = null;
    $('fringe-region-shape').value = 'edit';
    refreshRegionEditor();
  };
  $('fringe-region-purpose').onchange = () => {
    if (selected < 0) return;
    rememberRegions(); materializeRegions();
    fr.maskPolygons[selected].include = $('fringe-region-purpose').value === 'include';
    refreshRegionEditor();
  };
  // A recipe change supplies a new set of polygons, invalidating edit selection/history.
  $('fringe-recipe-select')?.addEventListener('change', () => {
    selected = -1; circlePoints = []; draft = null; regionHistory = [];
    refreshRegionEditor();
  });
  const canvas = $('fringe-region-canvas');
  const point = e => {
    const r = canvas.getBoundingClientRect();
    return {x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))};
  };
  const region = (a, b) => regionFromDrag(a, b, $('fringe-region-shape').value, $('fringe-region-purpose').value === 'include');
  canvas.addEventListener('pointerdown', e => {
    if (!ready || busy || e.button !== 0) return;
    e.preventDefault(); canvas.focus();
    const p = point(e), tool = $('fringe-region-shape').value;
    if (tool === 'circle') {
      if (circlePoints.length === 2) {
        const circle = circleRegionFromPoints([...circlePoints, p], canvas.width, canvas.height,
          $('fringe-region-purpose').value === 'include');
        if (!circle) {
          $('fringe-region-status').textContent = 'Choose a third point farther around the edge. The circle must fit inside the image.';
          return;
        }
        circlePoints = []; draft = null; addRegion(circle);
      } else { circlePoints.push(p); refreshRegionEditor(); }
      return;
    }
    if (tool === 'edit') {
      const regions = activeRegions();
      const handle = selected >= 0 ? regionHandleAt(regions[selected], p) : null;
      if (!handle) selected = regions.findLastIndex(r => regionContains(r, p));
      if (selected >= 0) {
        editDrag = {start: p, original: clone(regions[selected]), handle, saved: false};
        canvas.setPointerCapture(e.pointerId);
      }
      refreshRegionEditor(); return;
    }
    dragStart = p;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    const p = point(e);
    if (editDrag) {
      if (!editDrag.saved && Math.hypot(p.x - editDrag.start.x, p.y - editDrag.start.y) < .001) return;
      if (!editDrag.saved) { rememberRegions(); materializeRegions(); editDrag.saved = true; }
      fr.maskPolygons[selected] = editDrag.handle
        ? resizeRegion(editDrag.original, editDrag.handle, p)
        : moveRegion(editDrag.original, p.x - editDrag.start.x, p.y - editDrag.start.y);
      refreshRegionEditor(); return;
    }
    if (circlePoints.length === 2) {
      draft = circleRegionFromPoints([...circlePoints, p], canvas.width, canvas.height,
        $('fringe-region-purpose').value === 'include');
      drawRegions(); return;
    }
    if (!dragStart) return;
    draft = region(dragStart, p);
    drawRegions();
  });
  canvas.addEventListener('pointerup', e => {
    if (editDrag) { editDrag = null; refreshRegionEditor(); }
    else if (dragStart) {
      const polygon = region(dragStart, point(e));
      dragStart = draft = null;
      if (polygon) addRegion(polygon);
      else drawRegions();
    }
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointercancel', () => {
    if (editDrag?.saved) {
      const previous = regionHistory.pop();
      fr.maskPolygons = previous.polygons; setActiveRecipeId(previous.recipeId);
      refreshRecipeUi();
    }
    editDrag = dragStart = draft = null; refreshRegionEditor();
  });
  canvas.addEventListener('keydown', e => {
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelectedRegion(); }
    if (e.key === 'Escape' && circlePoints.length) {
      e.preventDefault(); e.stopPropagation(); circlePoints = []; draft = null; refreshRegionEditor();
    }
    const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[e.key];
    if (direction && selected >= 0) {
      e.preventDefault(); rememberRegions(); materializeRegions();
      const step = e.shiftKey ? 10 : 1;
      fr.maskPolygons[selected] = moveRegion(fr.maskPolygons[selected], direction[0] * step / canvas.width, direction[1] * step / canvas.height);
      refreshRegionEditor();
    }
  });
  $('fringe-region-add').onclick = () => {
    const values = ['x', 'y', 'w', 'h'].map(k => $('fringe-region-' + k));
    if (!values.every(el => el.reportValidity())) return;
    const [x, y, w, h] = values.map(el => Number(el.value) / 100);
    if (selected >= 0) {
      rememberRegions(); materializeRegions();
      const original = fr.maskPolygons[selected], b = regionBounds(original);
      const moved = moveRegion(original, x - b.x0, y - b.y0), m = regionBounds(moved);
      fr.maskPolygons[selected] = resizeRegion(moved, 'se', {x: m.x0 + w, y: m.y0 + h});
      refreshRegionEditor();
    } else {
      const shape = $('fringe-region-shape').value;
      let polygon;
      if (shape === 'circle') {
        const radius = Math.min(w * canvas.width, h * canvas.height) / 2;
        const cx = x + radius / canvas.width, cy = y + radius / canvas.height;
        polygon = circleRegionFromPoints([{x: cx + radius / canvas.width, y: cy},
          {x: cx, y: cy + radius / canvas.height}, {x: cx - radius / canvas.width, y: cy}],
          canvas.width, canvas.height, $('fringe-region-purpose').value === 'include');
      } else polygon = regionFromDrag({x, y}, {x: x + w, y: y + h}, shape === 'edit' ? 'rectangle' : shape,
        $('fringe-region-purpose').value === 'include');
      if (polygon) addRegion(polygon);
      else $('fringe-region-status').textContent = 'Use coordinates that keep the region inside the image.';
    }
  };
}

function activeRegions() {
  if (fr.maskPolygons.length) return fr.maskPolygons;
  return recipeToMaskPolygons(getActiveRecipe()).map(p => ({include: p.include,
    vertices: p.vertices.map(([x, y]) => ({x, y}))}));
}

function rememberRegions() {
  regionHistory.push({polygons: clone(fr.maskPolygons), recipeId: getActiveRecipe()?.id || null});
  if (regionHistory.length > 50) regionHistory.shift();
}

function materializeRegions() {
  if (!fr.maskPolygons.length) fr.maskPolygons = clone(activeRegions());
  // From now on the working copy owns the area, even if its last region is deleted.
  setActiveRecipeId(null); refreshRecipeUi();
}

function addRegion(polygon) {
  rememberRegions(); materializeRegions();
  fr.maskPolygons.push(polygon);
  selected = fr.maskPolygons.length - 1;
  $('fringe-region-shape').value = 'edit';
  refreshRegionEditor();
}

function deleteSelectedRegion() {
  if (selected < 0 || !activeRegions()[selected]) return;
  rememberRegions(); materializeRegions();
  fr.maskPolygons.splice(selected, 1); selected = -1;
  refreshRegionEditor();
}

function regionHandleAt(region, point) {
  if (!region) return null;
  const b = regionBounds(region), rect = $('fringe-region-canvas').getBoundingClientRect();
  return [['nw', b.x0, b.y0], ['ne', b.x1, b.y0], ['sw', b.x0, b.y1], ['se', b.x1, b.y1]]
    .find(([, x, y]) => Math.abs(point.x - x) * rect.width <= 10 && Math.abs(point.y - y) * rect.height <= 10)?.[0] || null;
}

function drawRegions() {
  const canvas = $('fringe-region-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (image) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  for (const poly of [...activeRegions(), ...(draft ? [draft] : [])]) {
    if (!poly.vertices.length) continue;
    ctx.beginPath();
    poly.vertices.forEach((v, i) => ctx[i ? 'lineTo' : 'moveTo'](v.x * canvas.width, v.y * canvas.height));
    ctx.closePath();
    ctx.fillStyle = poly.include ? 'rgba(40,150,255,.18)' : 'rgba(255,65,75,.35)';
    ctx.strokeStyle = poly.include ? '#52b2ff' : '#ff6670';
    ctx.lineWidth = Math.max(2, canvas.width / 250);
    ctx.fill(); ctx.stroke();
  }
  const handleSize = 8 * canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
  const chosen = activeRegions()[selected];
  if (chosen) {
    const b = regionBounds(chosen);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = handleSize / 5;
    ctx.setLineDash([handleSize, handleSize / 2]);
    ctx.strokeRect(b.x0 * canvas.width, b.y0 * canvas.height,
      (b.x1 - b.x0) * canvas.width, (b.y1 - b.y0) * canvas.height);
    ctx.setLineDash([]);
    for (const x of [b.x0, b.x1]) for (const y of [b.y0, b.y1]) {
      ctx.fillStyle = '#fff'; ctx.fillRect(x * canvas.width - handleSize / 2, y * canvas.height - handleSize / 2, handleSize, handleSize);
      ctx.strokeStyle = '#111'; ctx.strokeRect(x * canvas.width - handleSize / 2, y * canvas.height - handleSize / 2, handleSize, handleSize);
    }
  }
  for (const p of circlePoints) {
    ctx.beginPath(); ctx.arc(p.x * canvas.width, p.y * canvas.height, handleSize / 2, 0, 2 * Math.PI);
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#111'; ctx.stroke();
  }
}

export function refreshRegionEditor() {
  if (!$('fringe-region-status')) return;
  const regions = activeRegions();
  const includes = regions.filter(p => p.include).length;
  const excludes = regions.length - includes;
  const recipe = !fr.maskPolygons.length && getActiveRecipe();
  $('fringe-region-status').textContent = regions.length
    ? `${recipe ? 'Recipe: ' + recipe.name + ' · ' : ''}${includes} included · ${excludes} excluded${!includes ? ' · Whole image except exclusions' : ''}`
    : 'Automatic area — Loupe detects the surface and rejects weak fringes.';
  if (selected >= regions.length) selected = -1;
  const picker = $('fringe-region-select');
  picker.replaceChildren(new Option('None', ''));
  regions.forEach((r, i) => picker.add(new Option(`${i + 1} · ${r.include ? 'Include' : 'Exclude'}${r.shape === 'circle' ? ' circle' : ''}`, String(i))));
  picker.value = selected < 0 ? '' : String(selected);
  $('fringe-region-delete').disabled = selected < 0;
  $('fringe-region-undo').disabled = !regionHistory.length && !circlePoints.length;
  $('fringe-region-add').textContent = selected < 0 ? 'Add region' : 'Apply coordinates';
  const chosen = regions[selected];
  if (chosen) {
    const b = regionBounds(chosen);
    [b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0].forEach((v, i) => {
      $('fringe-region-' + ['x', 'y', 'w', 'h'][i]).value = (v * 100).toFixed(2);
    });
    $('fringe-region-purpose').value = chosen.include ? 'include' : 'exclude';
  }
  if (circlePoints.length) $('fringe-region-status').textContent = `Circle: ${circlePoints.length} of 3 points — click another point around the edge.`;
  else if ($('fringe-region-shape').value === 'circle') $('fringe-region-status').textContent += ' Click 3 points on the circular edge.';
  $('fringe-region-canvas').style.cursor = $('fringe-region-shape').value === 'edit' ? 'move' : 'crosshair';
  drawRegions();
  drawMaskOverlay();
}

export function openFringeSetup(src, name) {
  const dialog = $('fringe-setup-dialog');
  if (!dialog) return;
  const version = ++imageVersion;
  busy = false; ready = false; image = null; dragStart = draft = editDrag = null;
  circlePoints = []; selected = -1; regionHistory = [];
  $('fringe-region-shape').value = 'circle';
  $('fringe-setup-title').textContent = 'Set up fringe analysis';
  $('fringe-setup-source').textContent = name;
  $('fringe-setup-options').hidden = false;
  $('fringe-setup-progress').hidden = true;
  $('fringe-setup-start').hidden = false;
  $('fringe-setup-start').disabled = true;
  $('fringe-area-controls').disabled = true;
  $('fringe-setup-cancel').textContent = 'Cancel';
  $('fringe-setup-note').textContent = 'Loading image preview…';
  $('fringe-setup-form').value = captureFringeOptions().formModel;
  if ($('fringe-custom-wl-label')) $('fringe-custom-wl-label').hidden = $('fringe-wavelength')?.value !== 'custom';
  if ($('fringe-mask-thresh-val')) $('fringe-mask-thresh-val').textContent = $('fringe-mask-thresh').value + '%';
  if ($('fringe-lpf-sigma')) $('fringe-lpf-sigma').disabled = !!$('fringe-lpf-sigma-auto')?.checked;
  if ($('fringe-dc-margin')) $('fringe-dc-margin').disabled = !!$('fringe-dc-margin-auto')?.checked;
  dialog.hidden = false;
  if (!dialog.open) dialog.showModal();
  refreshRegionEditor();
  $('fringe-analysis-engine').value = fr.analysisEngine || 'server';
  $('fringe-analysis-method').value = fr.analysisMethod || 'current';
  const next = new Image();
  next.onload = () => {
    if (version !== imageVersion) return;
    image = next; ready = true;
    const canvas = $('fringe-region-canvas');
    canvas.width = next.naturalWidth; canvas.height = next.naturalHeight;
    $('fringe-setup-start').disabled = false;
    $('fringe-area-controls').disabled = false;
    $('fringe-setup-note').textContent = 'Review the image and settings, then start.';
    refreshRegionEditor();
  };
  next.onerror = () => {
    if (version === imageVersion) $('fringe-setup-note').textContent = 'Could not open this image. Choose another file.';
  };
  next.src = src;
}

export function showFringeAnalysisProgress() {
  busy = true;
  $('fringe-setup-title').textContent = 'Analyzing interferogram';
  $('fringe-setup-options').hidden = true;
  $('fringe-setup-progress').hidden = false;
  $('fringe-setup-start').hidden = true;
  $('fringe-setup-note').textContent = 'Processing the selected image. Results open when complete.';
  $('fringe-setup-cancel').textContent = 'Cancel analysis';
}

export function showFringeAnalysisError() {
  busy = false;
  $('fringe-setup-title').textContent = 'Analysis could not finish';
  $('fringe-setup-options').hidden = false;
  $('fringe-setup-start').hidden = false;
  $('fringe-setup-note').textContent = 'Adjust the settings and try again, or cancel to choose another image.';
  $('fringe-setup-cancel').textContent = 'Cancel';
}

export function closeFringeSetup() {
  imageVersion++;
  busy = false; ready = false; image = null; dragStart = draft = editDrag = null;
  circlePoints = []; selected = -1; regionHistory = [];
  const dialog = $('fringe-setup-dialog');
  if (!dialog) return;
  dialog.close(); dialog.hidden = true;
}
