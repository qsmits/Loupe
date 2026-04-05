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
    const resp = await apiFetch('/zstack/heightmap.raw');
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

  const { width: cols, height: rows, data, z_step_mm } = payload;

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
  // Normalized Z: centered on 0, spans [-0.5, 0.5] * RELIEF_AT_UNIT at 1×.
  const baseZ = new Float32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    baseZ[i] = (rawIdx[i] - midIdx) / idxRange * RELIEF_AT_UNIT;
  }

  // `smoothedZ` is the XY-blurred version of `baseZ`, recomputed whenever
  // the smoothing slider changes.  `applyZ` always reads from it.
  const smoothedZ = new Float32Array(vertexCount);
  smoothedZ.set(baseZ);

  const defaultExaggeration = 1.0;
  const defaultSmoothing = 0;
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

  function updateSmoothing() {
    const passes = parseInt(smoothInput.value, 10) || 0;
    smoothValueSpan.textContent = String(passes);
    blurHeightField(baseZ, smoothedZ, cols, rows, passes);
    applyZ(positions, smoothedZ, parseFloat(zInput.value));
    geometry.attributes.position.needsUpdate = true;
    geometry.computeBoundingSphere();
    geometry.computeVertexNormals();
  }
  smoothInput.addEventListener('input', updateSmoothing);

  zInput.addEventListener('input', () => {
    const ex = parseFloat(zInput.value);
    zValueSpan.textContent = ex.toFixed(1) + '×';
    applyZ(positions, smoothedZ, ex);
    geometry.attributes.position.needsUpdate = true;
    geometry.computeBoundingSphere();
  });

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
  function onKey(e) { if (e.key === 'Escape') close(); }
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
