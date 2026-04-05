// zstack-3d.js — 3D textured heightmap viewer for the Z-stack result.
//
// Opens a full-screen modal containing a Three.js scene: the all-in-focus
// composite texture-mapped onto a displaced PlaneGeometry whose vertex Z
// comes from the raw focus-index map scaled by ``z_step_mm``.  Three.js is
// loaded lazily from esm.sh on first open so the rest of the app pays zero
// cost unless the user actually opens the 3D viewer.

import { apiFetch } from './api.js';

// Lazy module cache — populated on first openZstack3dView() call.
let _THREE = null;
let _OrbitControls = null;

async function loadThree() {
  if (_THREE) return;
  _THREE = await import('https://esm.sh/three@0.160.0');
  const mod = await import('https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js');
  _OrbitControls = mod.OrbitControls;
}

// Active viewer instance (so repeated clicks don't stack modals).
let _active = null;

export async function openZstack3dView() {
  if (_active) return;

  // Fetch the raw height data first — if there is no computed result,
  // bail out before touching the DOM.
  let payload;
  try {
    const resp = await apiFetch('/zstack/heightmap.raw?detrend=none');
    if (resp.status === 404) {
      alert('No Z-stack result available yet. Build the height map first.');
      return;
    }
    if (!resp.ok) {
      alert('Failed to fetch height map: ' + resp.status);
      return;
    }
    payload = await resp.json();
  } catch (err) {
    alert('Failed to fetch height map: ' + err.message);
    return;
  }

  const modal = buildModal();
  document.body.appendChild(modal);
  const loadingEl = modal.querySelector('#zstack-3d-loading');

  try {
    await loadThree();
  } catch (err) {
    loadingEl.textContent = 'Failed to load 3D viewer: ' + err.message;
    return;
  }
  loadingEl.hidden = true;

  _active = initScene(modal, payload);
}

function buildModal() {
  const modal = document.createElement('div');
  modal.id = 'zstack-3d-modal';
  modal.innerHTML = `
    <div id="zstack-3d-canvas-host"></div>
    <button id="zstack-3d-close" title="Close (Esc)">✕</button>
    <div id="zstack-3d-settings">
      <div class="zstack-3d-settings-header">View Settings</div>
      <div class="zstack-3d-settings-rows"></div>
    </div>
    <div id="zstack-3d-loading">Loading 3D viewer…</div>
  `;
  return modal;
}

// Helper: append a labelled control row to the settings panel.  Use this
// when adding future settings so the layout stays consistent.
function addSettingRow(rowsEl, label, inputElement, valueSpan) {
  const row = document.createElement('div');
  row.className = 'zstack-3d-row';
  const lbl = document.createElement('label');
  lbl.textContent = label;
  row.appendChild(lbl);
  row.appendChild(inputElement);
  if (valueSpan) row.appendChild(valueSpan);
  rowsEl.appendChild(row);
  return row;
}

function initScene(modal, payload) {
  const THREE = _THREE;
  const OrbitControls = _OrbitControls;

  const host = modal.querySelector('#zstack-3d-canvas-host');
  const closeBtn = modal.querySelector('#zstack-3d-close');
  const rowsEl = modal.querySelector('.zstack-3d-settings-rows');

  const { width: cols, height: rows, data, confidence, brightness, z_step_mm } = payload;

  // World-space plane: longest side = 1.
  const aspect = cols / rows;
  const worldW = aspect >= 1 ? 1.0 : aspect;
  const worldH = aspect >= 1 ? 1.0 / aspect : 1.0;

  // Scene, camera, renderer
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  const hostRect = host.getBoundingClientRect();
  const camera = new THREE.PerspectiveCamera(45, hostRect.width / hostRect.height, 0.01, 100);
  camera.position.set(0, -1.6, 1.3);
  camera.up.set(0, 0, 1);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(hostRect.width, hostRect.height);
  host.appendChild(renderer.domElement);

  // PlaneGeometry with (cols-1) x (rows-1) segments so it has cols*rows vertices.
  // Three.js PlaneGeometry vertex order: left→right across the width, then
  // top→bottom down the height.  Our ``data`` array is row-major with
  // row 0 = top, matching that traversal.
  const geometry = new THREE.PlaneGeometry(worldW, worldH, cols - 1, rows - 1);
  const positions = geometry.attributes.position.array;
  const vertexCount = cols * rows;

  // Cache the raw index values, then normalize into world-space Z so that
  // at exaggeration = 1× the surface has ~10% relief relative to the XY
  // extent — otherwise real `z_step_mm` against a unit-normalized XY plane
  // produces wildly tall peaks on typical stacks.
  const rawIdx = new Float32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) rawIdx[i] = data[i];
  let minIdx = Infinity, maxIdx = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    if (rawIdx[i] < minIdx) minIdx = rawIdx[i];
    if (rawIdx[i] > maxIdx) maxIdx = rawIdx[i];
  }
  const idxRange = Math.max(1e-6, maxIdx - minIdx);
  const midIdx = (minIdx + maxIdx) * 0.5;
  const RELIEF_AT_UNIT = 0.10;  // 1× → Z range is 10% of longest XY side
  // Natural Z: centered on 0, spans [-0.5, 0.5] * RELIEF_AT_UNIT at 1×.
  const naturalZ = new Float32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    naturalZ[i] = (rawIdx[i] - midIdx) / idxRange * RELIEF_AT_UNIT;
  }
  const floorZ = -0.5 * RELIEF_AT_UNIT;  // sink low-confidence pixels here

  // Confidence array (per vertex, 0..1).  When the threshold slider is
  // raised, pixels below it are clamped to `floorZ` in `maskedZ` so holes
  // and textureless regions don't float at whatever random frame index
  // argmax happened to pick.
  const conf = new Float32Array(vertexCount);
  if (Array.isArray(confidence) && confidence.length === vertexCount) {
    for (let i = 0; i < vertexCount; i++) conf[i] = confidence[i];
  } else {
    for (let i = 0; i < vertexCount; i++) conf[i] = 1.0;  // no data → keep all
  }
  // Per-pixel peak brightness across the stack (0..1).  Used by the
  // saturation override slider: overexposed / specular pixels have very
  // low Laplacian gradient and would otherwise be masked out, but they
  // usually do sit on a real surface — the slider lets the user force
  // them back in.
  const bright = new Float32Array(vertexCount);
  if (Array.isArray(brightness) && brightness.length === vertexCount) {
    for (let i = 0; i < vertexCount; i++) bright[i] = brightness[i];
  } else {
    for (let i = 0; i < vertexCount; i++) bright[i] = 0.0;
  }

  // Pipeline: naturalZ → maskedZ (by confidence) → smoothedZ (blur) → positions * exaggeration
  const maskedZ = new Float32Array(vertexCount);
  const smoothedZ = new Float32Array(vertexCount);
  maskedZ.set(naturalZ);
  smoothedZ.set(naturalZ);

  const defaultExaggeration = 1.0;
  const defaultSmoothing = 0;
  const defaultConfThreshold = 0.0;
  const defaultSatOverride = 0.98;  // brightness ≥ 0.98 → force-keep the pixel
  applyZ(positions, smoothedZ, defaultExaggeration);
  geometry.attributes.position.needsUpdate = true;
  geometry.computeBoundingSphere();
  geometry.computeVertexNormals();

  // Texture-map the composite
  const texLoader = new THREE.TextureLoader();
  const texture = texLoader.load('/zstack/composite.png');
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // Controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.update();

  // Settings: Level (detrend mode).  Re-fetches the raw heightmap with the
  // chosen fit subtracted server-side; the grid dimensions stay identical so
  // we can refill rawIdx / naturalZ in place and re-run the existing
  // mask → blur → exaggerate pipeline without rebuilding the mesh.
  const levelSelect = document.createElement('select');
  levelSelect.className = 'zstack-3d-select';
  for (const [val, label] of [
    ['none', 'None'],
    ['plane', 'Plane'],
    ['poly2', 'Poly² (lens curvature)'],
  ]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    levelSelect.appendChild(opt);
  }
  levelSelect.value = 'none';
  addSettingRow(rowsEl, 'Level', levelSelect, null);

  async function reloadWithDetrend(mode) {
    try {
      const resp = await apiFetch('/zstack/heightmap.raw?detrend=' + encodeURIComponent(mode));
      if (!resp.ok) {
        alert('Failed to reload height map: ' + resp.status);
        return;
      }
      const p = await resp.json();
      if (p.width !== cols || p.height !== rows) {
        alert('Height map grid size changed unexpectedly; close and reopen the 3D view.');
        return;
      }
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < vertexCount; i++) {
        const v = p.data[i];
        rawIdx[i] = v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const range = Math.max(1e-6, mx - mn);
      const mid = (mn + mx) * 0.5;
      for (let i = 0; i < vertexCount; i++) {
        naturalZ[i] = (rawIdx[i] - mid) / range * RELIEF_AT_UNIT;
      }
      applyMask();
      updateFromPipeline();
    } catch (err) {
      alert('Reload failed: ' + err.message);
    }
  }
  levelSelect.addEventListener('change', () => {
    reloadWithDetrend(levelSelect.value);
  });

  // Settings: Z exaggeration
  const zInput = document.createElement('input');
  zInput.type = 'range';
  zInput.min = '0.1';
  zInput.max = '20';
  zInput.step = '0.1';
  zInput.value = String(defaultExaggeration);
  const zValueSpan = document.createElement('span');
  zValueSpan.className = 'zstack-3d-value';
  zValueSpan.textContent = defaultExaggeration.toFixed(1) + '×';
  addSettingRow(rowsEl, 'Z exaggeration', zInput, zValueSpan);

  // Settings: XY smoothing (passes of a separable 3-tap box blur on the
  // height field — cheap and recomputed in place on slider drag).
  const smoothInput = document.createElement('input');
  smoothInput.type = 'range';
  smoothInput.min = '0';
  smoothInput.max = '10';
  smoothInput.step = '1';
  smoothInput.value = String(defaultSmoothing);
  const smoothValueSpan = document.createElement('span');
  smoothValueSpan.className = 'zstack-3d-value';
  smoothValueSpan.textContent = String(defaultSmoothing);
  addSettingRow(rowsEl, 'XY smoothing', smoothInput, smoothValueSpan);

  // Settings: Confidence threshold.  Pixels whose peak sharpness response
  // (normalized 0..1) is below this are considered "never in focus" and
  // sunk to `floorZ`, so holes / textureless regions don't float at
  // whatever random frame argmax happened to pick.
  const confInput = document.createElement('input');
  confInput.type = 'range';
  confInput.min = '0';
  confInput.max = '1';
  confInput.step = '0.01';
  confInput.value = String(defaultConfThreshold);
  const confValueSpan = document.createElement('span');
  confValueSpan.className = 'zstack-3d-value';
  confValueSpan.textContent = defaultConfThreshold.toFixed(2);
  addSettingRow(rowsEl, 'Confidence cutoff', confInput, confValueSpan);

  // Settings: Saturation override.  Pixels whose peak brightness across the
  // stack is >= this threshold bypass the confidence cutoff — useful for
  // specular highlights and overexposed surfaces that have low Laplacian
  // response but are still real surface.  Set to 1.0 to disable (nothing
  // passes), ≤0 to keep every pixel regardless of confidence.
  const satInput = document.createElement('input');
  satInput.type = 'range';
  satInput.min = '0';
  satInput.max = '1';
  satInput.step = '0.01';
  satInput.value = String(defaultSatOverride);
  const satValueSpan = document.createElement('span');
  satValueSpan.className = 'zstack-3d-value';
  satValueSpan.textContent = defaultSatOverride.toFixed(2);
  addSettingRow(rowsEl, 'Saturation override', satInput, satValueSpan);

  function applyMask() {
    const thr = parseFloat(confInput.value);
    const satThr = parseFloat(satInput.value);
    for (let i = 0; i < vertexCount; i++) {
      const keep = conf[i] >= thr || bright[i] >= satThr;
      maskedZ[i] = keep ? naturalZ[i] : floorZ;
    }
  }

  function updateFromPipeline() {
    const passes = parseInt(smoothInput.value, 10) || 0;
    blurHeightField(maskedZ, smoothedZ, cols, rows, passes);
    applyZ(positions, smoothedZ, parseFloat(zInput.value));
    geometry.attributes.position.needsUpdate = true;
    geometry.computeBoundingSphere();
    geometry.computeVertexNormals();
  }

  function updateSmoothing() {
    const passes = parseInt(smoothInput.value, 10) || 0;
    smoothValueSpan.textContent = String(passes);
    updateFromPipeline();
  }
  smoothInput.addEventListener('input', updateSmoothing);

  confInput.addEventListener('input', () => {
    const thr = parseFloat(confInput.value);
    confValueSpan.textContent = thr.toFixed(2);
    applyMask();
    updateFromPipeline();
  });

  satInput.addEventListener('input', () => {
    const s = parseFloat(satInput.value);
    satValueSpan.textContent = s.toFixed(2);
    applyMask();
    updateFromPipeline();
  });

  // Initialize mask with defaults so the first render honours the override.
  applyMask();
  blurHeightField(maskedZ, smoothedZ, cols, rows, defaultSmoothing);
  applyZ(positions, smoothedZ, defaultExaggeration);
  geometry.attributes.position.needsUpdate = true;
  geometry.computeVertexNormals();

  zInput.addEventListener('input', () => {
    const ex = parseFloat(zInput.value);
    zValueSpan.textContent = ex.toFixed(1) + '×';
    applyZ(positions, smoothedZ, ex);
    geometry.attributes.position.needsUpdate = true;
    geometry.computeBoundingSphere();
  });

  // Settings: Z calibration via two-point pick on the mesh.  Lets the user
  // click two features of known height difference (e.g. a gauge block step)
  // to derive an effective `z_step_mm` correction factor.  Purely a
  // readout — does not change the rendered shape, only the reported mm.
  const calibRow = document.createElement('div');
  calibRow.className = 'zstack-3d-row zstack-3d-calib-row';
  const calibBtn = document.createElement('button');
  calibBtn.type = 'button';
  calibBtn.className = 'zstack-3d-calib-btn';
  calibBtn.textContent = 'Calibrate Z…';
  const calibReadout = document.createElement('div');
  calibReadout.className = 'zstack-3d-calib-readout';
  calibReadout.textContent = `z_step: ${z_step_mm.toFixed(4)} mm (nominal)`;
  const calibReset = document.createElement('button');
  calibReset.type = 'button';
  calibReset.className = 'zstack-3d-calib-reset';
  calibReset.textContent = 'Reset';
  calibReset.hidden = true;
  calibRow.appendChild(calibBtn);
  calibRow.appendChild(calibReset);
  calibRow.appendChild(calibReadout);
  rowsEl.appendChild(calibRow);

  // Effective z_step (mm/index) after calibration — starts at the nominal
  // value the user entered when building the stack.
  let effectiveZStep = z_step_mm;
  let calibCorrection = 1.0;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let pickMode = false;
  let pickStage = 0;  // 0 = idle, 1 = waiting for point 1, 2 = waiting for point 2
  const pickedPoints = [];  // [{ worldPoint: Vector3, idxRow, idxCol, rawZ }]
  const markerGroup = new THREE.Group();
  scene.add(markerGroup);

  function clearMarkers() {
    while (markerGroup.children.length) {
      const child = markerGroup.children[0];
      markerGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
  }

  function addMarker(worldPoint, color) {
    const geo = new THREE.SphereGeometry(0.012, 16, 12);
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.copy(worldPoint);
    sphere.renderOrder = 999;
    markerGroup.add(sphere);
    return sphere;
  }

  function addLine(p1, p2, color) {
    const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 999;
    markerGroup.add(line);
    return line;
  }

  function enterPickMode() {
    pickMode = true;
    pickStage = 1;
    pickedPoints.length = 0;
    clearMarkers();
    controls.enabled = false;
    renderer.domElement.style.cursor = 'crosshair';
    calibBtn.textContent = 'Pick point 1…';
    calibBtn.disabled = true;
  }

  function exitPickMode() {
    pickMode = false;
    pickStage = 0;
    controls.enabled = true;
    renderer.domElement.style.cursor = '';
    calibBtn.textContent = 'Calibrate Z…';
    calibBtn.disabled = false;
  }

  function onCanvasClick(e) {
    if (!pickMode) return;
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(mesh);
    if (!hits.length) return;
    const hit = hits[0];
    // Map UV → grid index → raw focus index
    const uv = hit.uv;
    if (!uv) return;
    const col = Math.min(cols - 1, Math.max(0, Math.round(uv.x * (cols - 1))));
    const rowIdx = Math.min(rows - 1, Math.max(0, Math.round((1 - uv.y) * (rows - 1))));
    const flatIdx = rowIdx * cols + col;
    pickedPoints.push({
      worldPoint: hit.point.clone(),
      col, row: rowIdx,
      rawIdx: rawIdx[flatIdx],
    });
    addMarker(hit.point, pickStage === 1 ? 0xff4455 : 0x44ff88);

    if (pickStage === 1) {
      pickStage = 2;
      calibBtn.textContent = 'Pick point 2…';
    } else {
      // Second point — finish.
      addLine(pickedPoints[0].worldPoint, pickedPoints[1].worldPoint, 0xffff00);
      exitPickMode();
      finalizeCalibration();
    }
  }

  function finalizeCalibration() {
    const dIdx = Math.abs(pickedPoints[1].rawIdx - pickedPoints[0].rawIdx);
    if (dIdx < 0.5) {
      alert('The two points are at (essentially) the same focus level — pick points with a visible height difference.');
      clearMarkers();
      return;
    }
    const observedMm = dIdx * z_step_mm;
    const knownStr = window.prompt(
      `Observed Δ (nominal): ${observedMm.toFixed(4)} mm (Δindex = ${dIdx.toFixed(2)})\n\nEnter the KNOWN height difference in mm:`,
      observedMm.toFixed(3),
    );
    if (knownStr == null) { clearMarkers(); return; }
    const known = parseFloat(knownStr);
    if (!Number.isFinite(known) || known <= 0) {
      alert('Invalid value.');
      clearMarkers();
      return;
    }
    calibCorrection = known / observedMm;
    effectiveZStep = z_step_mm * calibCorrection;
    calibReadout.innerHTML =
      `z_step: <b>${effectiveZStep.toFixed(4)} mm</b> (${calibCorrection.toFixed(3)}×)`;
    calibReset.hidden = false;
  }

  calibBtn.addEventListener('click', () => {
    if (!pickMode) enterPickMode();
  });
  calibReset.addEventListener('click', () => {
    calibCorrection = 1.0;
    effectiveZStep = z_step_mm;
    calibReadout.textContent = `z_step: ${z_step_mm.toFixed(4)} mm (nominal)`;
    calibReset.hidden = true;
    clearMarkers();
  });
  renderer.domElement.addEventListener('click', onCanvasClick);

  // <!-- Future settings rows (wireframe toggle, lighting, colormap) go here -->

  // Animation loop
  let rafId = 0;
  let disposed = false;
  function animate() {
    if (disposed) return;
    rafId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // Resize handling
  function onResize() {
    const r = host.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
    renderer.setSize(r.width, r.height);
  }
  window.addEventListener('resize', onResize);

  // Close handling
  function close() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey);
    renderer.domElement.removeEventListener('click', onCanvasClick);
    clearMarkers();
    controls.dispose();
    geometry.dispose();
    material.dispose();
    texture.dispose();
    renderer.dispose();
    if (renderer.domElement && renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
    if (modal.parentNode) modal.parentNode.removeChild(modal);
    _active = null;
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (pickMode) {
      // Cancel the in-progress calibration pick without closing the viewer.
      clearMarkers();
      exitPickMode();
      return;
    }
    close();
  }
  closeBtn.addEventListener('click', close);
  window.addEventListener('keydown', onKey);

  return { close };
}

function applyZ(positions, normZ, exaggeration) {
  const n = normZ.length;
  for (let i = 0; i < n; i++) {
    positions[i * 3 + 2] = normZ[i] * exaggeration;
  }
}

// Separable 3-tap box blur on a 2D scalar field, N passes (passes=0 is a
// pure copy).  Scratch buffer avoids per-pass allocations.
const _blurScratch = { buf: null };
function blurHeightField(src, dst, cols, rows, passes) {
  dst.set(src);
  if (passes <= 0) return;
  if (!_blurScratch.buf || _blurScratch.buf.length < dst.length) {
    _blurScratch.buf = new Float32Array(dst.length);
  }
  const tmp = _blurScratch.buf;
  for (let p = 0; p < passes; p++) {
    // Horizontal pass: dst → tmp
    for (let y = 0; y < rows; y++) {
      const row = y * cols;
      for (let x = 0; x < cols; x++) {
        const xl = x > 0 ? x - 1 : x;
        const xr = x < cols - 1 ? x + 1 : x;
        tmp[row + x] = (dst[row + xl] + dst[row + x] + dst[row + xr]) / 3;
      }
    }
    // Vertical pass: tmp → dst
    for (let y = 0; y < rows; y++) {
      const yu = y > 0 ? y - 1 : y;
      const yd = y < rows - 1 ? y + 1 : y;
      for (let x = 0; x < cols; x++) {
        dst[y * cols + x] = (tmp[yu * cols + x] + tmp[y * cols + x] + tmp[yd * cols + x]) / 3;
      }
    }
  }
}
