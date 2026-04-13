// fringe.js — Full-window fringe analysis workspace.
//
// Two-column layout:
//   Left:   camera preview, focus quality bar, freeze & analyze, settings,
//           Zernike subtraction checkboxes
//   Right:  summary bar (PV/RMS), tabs (Surface Map | 3D View | Zernike | Profiles)
//
// Lives inside #mode-fringe, managed by modes.js.

import { apiFetch } from './api.js';

const fr = {
  polling: null,
  built: false,
  threeLoaded: false,
  lastResult: null,
  lastMask: null,
};

function $(id) { return document.getElementById(id); }

// ── Wavelength presets ──────────────────────────────────────────────────

const WAVELENGTHS = {
  "sodium":  { label: "Sodium (589 nm)",   nm: 589.0 },
  "hene":    { label: "HeNe (632.8 nm)",   nm: 632.8 },
  "green":   { label: "Green LED (532 nm)", nm: 532.0 },
  "custom":  { label: "Custom...",          nm: null },
};

// ── Build workspace DOM ─────────────────────────────────────────────────

function buildWorkspace() {
  if (fr.built) return;
  fr.built = true;

  const root = $("mode-fringe");
  if (!root) return;

  root.innerHTML = `
    <div class="fringe-workspace">
      <!-- Left column: preview + settings -->
      <div class="fringe-preview-col">
        <div class="fringe-preview-container">
          <img id="fringe-preview" src="/stream" alt="Camera preview" />
          <div class="fringe-enlarge-overlay" id="fringe-enlarge-overlay" hidden>
            <img id="fringe-enlarge-img" />
            <button class="fringe-enlarge-close" id="fringe-enlarge-close">&#10005;</button>
          </div>
        </div>
        <div class="fringe-focus-bar-container">
          <label style="font-size:11px;opacity:0.7">Focus quality</label>
          <div class="fringe-focus-bar">
            <div class="fringe-focus-fill" id="fringe-focus-fill" style="width:0%"></div>
          </div>
          <span id="fringe-focus-score" style="font-size:11px;min-width:30px;text-align:right">--</span>
        </div>

        <button class="detect-btn" id="fringe-btn-analyze" style="padding:8px 16px;font-size:13px;font-weight:600;width:100%">
          Freeze &amp; Analyze
        </button>

        <div class="fringe-drop-zone" id="fringe-drop-zone">
          <span style="opacity:0.5;font-size:12px">or drag &amp; drop an image</span>
        </div>

        <div class="fringe-setting-group" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
          <div style="font-size:12px;font-weight:600;opacity:0.7">Settings</div>
          <label>Wavelength
            <select id="fringe-wavelength">
              <option value="sodium">Sodium (589 nm)</option>
              <option value="hene" selected>HeNe (632.8 nm)</option>
              <option value="green">Green LED (532 nm)</option>
              <option value="custom">Custom...</option>
            </select>
          </label>
          <label id="fringe-custom-wl-label" hidden>Custom wavelength (nm)
            <input type="number" id="fringe-custom-wl" min="200" max="2000" step="0.1" value="632.8" />
          </label>
          <label>Mask threshold
            <input type="range" id="fringe-mask-thresh" min="0" max="100" step="1" value="15" style="width:100px" />
            <span id="fringe-mask-thresh-val" style="font-size:11px;min-width:28px">15%</span>
          </label>
        </div>

        <div class="fringe-setting-group" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
          <div style="font-size:12px;font-weight:600;opacity:0.7">Zernike Subtraction</div>
          <label class="fringe-zernike-cb">
            <input type="checkbox" id="fringe-sub-tilt" checked disabled />
            Tilt X/Y (Z2, Z3) <span style="opacity:0.5;font-size:10px">always on</span>
          </label>
          <label class="fringe-zernike-cb">
            <input type="checkbox" id="fringe-sub-power" />
            Power / Defocus (Z4)
          </label>
          <label class="fringe-zernike-cb">
            <input type="checkbox" id="fringe-sub-astig" />
            Astigmatism (Z5, Z6)
          </label>
          <label class="fringe-zernike-cb">
            <input type="checkbox" id="fringe-sub-coma" />
            Coma (Z7, Z8)
          </label>
          <label class="fringe-zernike-cb">
            <input type="checkbox" id="fringe-sub-spherical" />
            Spherical (Z11)
          </label>
        </div>
      </div>

      <!-- Right column: results -->
      <div class="fringe-results-col">
        <div class="fringe-summary-bar" id="fringe-summary-bar" hidden>
          <div class="fringe-stat">
            <span class="fringe-stat-label">PV</span>
            <span class="fringe-stat-value" id="fringe-pv-waves">--</span>
            <span class="fringe-stat-unit">\u03bb</span>
            <span class="fringe-stat-value fringe-stat-nm" id="fringe-pv-nm">--</span>
            <span class="fringe-stat-unit">nm</span>
          </div>
          <div class="fringe-stat">
            <span class="fringe-stat-label">RMS</span>
            <span class="fringe-stat-value" id="fringe-rms-waves">--</span>
            <span class="fringe-stat-unit">\u03bb</span>
            <span class="fringe-stat-value fringe-stat-nm" id="fringe-rms-nm">--</span>
            <span class="fringe-stat-unit">nm</span>
          </div>
        </div>

        <div class="fringe-tab-bar" id="fringe-tab-bar">
          <button class="fringe-tab active" data-tab="surface">Surface Map</button>
          <button class="fringe-tab" data-tab="3d">3D View</button>
          <button class="fringe-tab" data-tab="zernike">Zernike</button>
          <button class="fringe-tab" data-tab="profiles">Profiles</button>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-surface">
          <div class="fringe-empty-state" id="fringe-empty">
            Freeze a frame or drop an interferogram image to analyze.
          </div>
          <div id="fringe-surface-content" hidden>
            <div class="fringe-surface-container">
              <img id="fringe-surface-img" />
            </div>
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-3d" hidden>
          <div class="fringe-empty-state" id="fringe-3d-empty">Analyze an image first.</div>
          <div id="fringe-3d-content" hidden style="display:flex;flex-direction:column;flex:1;min-height:0">
            <div class="fringe-3d-host" id="fringe-3d-host">
              <div class="fringe-3d-controls" id="fringe-3d-controls">
                <label style="font-size:12px">Z exaggeration:
                  <input type="range" id="fringe-3d-z-scale" min="1" max="200" step="1" value="10" style="width:120px" />
                  <span id="fringe-3d-z-val">10x</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-zernike" hidden>
          <div class="fringe-empty-state" id="fringe-zernike-empty">Analyze an image first.</div>
          <div id="fringe-zernike-content" hidden>
            <img id="fringe-zernike-chart" style="width:100%;max-width:900px" />
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-profiles" hidden>
          <div class="fringe-empty-state" id="fringe-profiles-empty">Analyze an image first.</div>
          <div id="fringe-profiles-content" hidden>
            <canvas id="fringe-profile-x-canvas" width="800" height="200"></canvas>
            <canvas id="fringe-profile-y-canvas" width="800" height="200"></canvas>
          </div>
        </div>
      </div>
    </div>
  `;

  wireEvents();
}

// ── Event wiring ────────────────────────────────────────────────────────

function wireEvents() {
  // Tab switching
  document.querySelectorAll(".fringe-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".fringe-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".fringe-tab-panel").forEach(p => p.hidden = true);
      tab.classList.add("active");
      const panelId = "fringe-panel-" + tab.dataset.tab;
      const panel = $(panelId);
      if (panel) panel.hidden = false;

      // Load 3D view on tab click
      if (tab.dataset.tab === "3d" && fr.lastResult) {
        render3dView();
      }
    });
  });

  // Wavelength dropdown
  const wlSel = $("fringe-wavelength");
  if (wlSel) {
    wlSel.addEventListener("change", () => {
      const customLabel = $("fringe-custom-wl-label");
      if (customLabel) customLabel.hidden = wlSel.value !== "custom";
    });
  }

  // Mask threshold slider
  const maskSlider = $("fringe-mask-thresh");
  const maskLabel = $("fringe-mask-thresh-val");
  if (maskSlider && maskLabel) {
    maskSlider.addEventListener("input", () => {
      maskLabel.textContent = maskSlider.value + "%";
    });
  }

  // Analyze button
  $("fringe-btn-analyze")?.addEventListener("click", analyzeFromCamera);

  // Drag and drop
  const dropZone = $("fringe-drop-zone");
  if (dropZone) {
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("fringe-drop-active");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("fringe-drop-active");
    });
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("fringe-drop-active");
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith("image/")) {
        analyzeFromFile(file);
      }
    });
  }

  // Preview click-to-enlarge
  const preview = $("fringe-preview");
  if (preview) {
    preview.style.cursor = "zoom-in";
    preview.addEventListener("click", () => {
      const overlay = $("fringe-enlarge-overlay");
      const enlargeImg = $("fringe-enlarge-img");
      if (overlay && enlargeImg) {
        enlargeImg.src = preview.src;
        overlay.hidden = false;
      }
    });
  }
  $("fringe-enlarge-close")?.addEventListener("click", () => {
    const overlay = $("fringe-enlarge-overlay");
    if (overlay) overlay.hidden = true;
  });

  // Preview scroll-to-zoom
  const previewContainer = $("fringe-preview")?.parentElement;
  if (previewContainer) {
    let zoomLevel = 1;
    previewContainer.addEventListener("wheel", (e) => {
      e.preventDefault();
      const img = $("fringe-preview");
      if (!img) return;
      zoomLevel = Math.max(1, Math.min(5, zoomLevel + (e.deltaY < 0 ? 0.2 : -0.2)));
      img.style.transform = `scale(${zoomLevel})`;
      img.style.transformOrigin = "center center";
    });
  }

  // Zernike checkbox change → re-analyze
  const checkboxIds = [
    "fringe-sub-power", "fringe-sub-astig",
    "fringe-sub-coma", "fringe-sub-spherical"
  ];
  let _reanalyzeDebounce = null;
  for (const id of checkboxIds) {
    $(id)?.addEventListener("change", () => {
      if (_reanalyzeDebounce) clearTimeout(_reanalyzeDebounce);
      _reanalyzeDebounce = setTimeout(() => {
        if (fr.lastResult) doReanalyze();
      }, 150);
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function getWavelength() {
  const sel = $("fringe-wavelength");
  if (!sel) return 632.8;
  if (sel.value === "custom") {
    const el = $("fringe-custom-wl");
    const v = parseFloat(el?.value || "632.8");
    return Number.isFinite(v) && v > 0 ? v : 632.8;
  }
  return WAVELENGTHS[sel.value]?.nm || 632.8;
}

function getMaskThreshold() {
  const el = $("fringe-mask-thresh");
  return el ? parseInt(el.value, 10) / 100 : 0.15;
}

function getSubtractTerms() {
  // Piston + tilt always on
  const terms = [1, 2, 3];
  if ($("fringe-sub-power")?.checked) terms.push(4);
  if ($("fringe-sub-astig")?.checked) terms.push(5, 6);
  if ($("fringe-sub-coma")?.checked) terms.push(7, 8);
  if ($("fringe-sub-spherical")?.checked) terms.push(11);
  return terms;
}

function setStatus(msg) {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.textContent = msg;
}

function resetStatus() {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.textContent = "Freeze & Analyze";
}

// ── Analysis ────────────────────────────────────────────────────────────

async function analyzeFromCamera() {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.disabled = true;
  setStatus("Analyzing...");
  try {
    const r = await apiFetch("/fringe/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wavelength_nm: getWavelength(),
        mask_threshold: getMaskThreshold(),
        subtract_terms: getSubtractTerms(),
      }),
    });
    if (!r.ok) {
      const msg = await r.text();
      console.warn("Fringe analysis failed:", msg);
      setStatus("Failed");
      setTimeout(resetStatus, 2000);
      return;
    }
    const data = await r.json();
    fr.lastResult = data;
    renderResults(data);
    resetStatus();
  } catch (e) {
    console.warn("Fringe analysis error:", e);
    setStatus("Error");
    setTimeout(resetStatus, 2000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function analyzeFromFile(file) {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.disabled = true;
  setStatus("Analyzing...");
  try {
    const arrayBuf = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuf)));
    const r = await apiFetch("/fringe/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wavelength_nm: getWavelength(),
        mask_threshold: getMaskThreshold(),
        subtract_terms: getSubtractTerms(),
        image_b64: b64,
      }),
    });
    if (!r.ok) {
      const msg = await r.text();
      console.warn("Fringe analysis failed:", msg);
      setStatus("Failed");
      setTimeout(resetStatus, 2000);
      return;
    }
    const data = await r.json();
    fr.lastResult = data;
    renderResults(data);
    resetStatus();
  } catch (e) {
    console.warn("Fringe analysis error:", e);
    setStatus("Error");
    setTimeout(resetStatus, 2000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function doReanalyze() {
  if (!fr.lastResult) return;
  try {
    const r = await apiFetch("/fringe/reanalyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coefficients: fr.lastResult.coefficients,
        subtract_terms: getSubtractTerms(),
        wavelength_nm: getWavelength(),
        surface_height: fr.lastResult.n_total_pixels
          ? Math.round(Math.sqrt(fr.lastResult.n_total_pixels))
          : 128,
        surface_width: fr.lastResult.n_total_pixels
          ? Math.round(Math.sqrt(fr.lastResult.n_total_pixels))
          : 128,
      }),
    });
    if (!r.ok) return;
    const data = await r.json();
    // Merge into lastResult
    fr.lastResult.surface_map = data.surface_map;
    fr.lastResult.zernike_chart = data.zernike_chart;
    fr.lastResult.profile_x = data.profile_x;
    fr.lastResult.profile_y = data.profile_y;
    fr.lastResult.pv_nm = data.pv_nm;
    fr.lastResult.rms_nm = data.rms_nm;
    fr.lastResult.pv_waves = data.pv_waves;
    fr.lastResult.rms_waves = data.rms_waves;
    fr.lastResult.subtracted_terms = data.subtracted_terms;
    renderResults(fr.lastResult);
  } catch (e) {
    console.warn("Re-analyze error:", e);
  }
}

// ── Rendering ───────────────────────────────────────────────────────────

function renderResults(data) {
  // Summary bar
  const summaryBar = $("fringe-summary-bar");
  if (summaryBar) summaryBar.hidden = false;

  const fmt = (v) => Number.isFinite(v) ? v.toFixed(3) : "--";
  const fmtNm = (v) => Number.isFinite(v) ? v.toFixed(1) : "--";

  $("fringe-pv-waves").textContent = fmt(data.pv_waves);
  $("fringe-pv-nm").textContent = fmtNm(data.pv_nm);
  $("fringe-rms-waves").textContent = fmt(data.rms_waves);
  $("fringe-rms-nm").textContent = fmtNm(data.rms_nm);

  // Surface map
  const surfaceContent = $("fringe-surface-content");
  const empty = $("fringe-empty");
  if (surfaceContent && data.surface_map) {
    surfaceContent.hidden = false;
    if (empty) empty.hidden = true;
    $("fringe-surface-img").src = "data:image/png;base64," + data.surface_map;
  }

  // Zernike chart
  const zernikeContent = $("fringe-zernike-content");
  const zernikeEmpty = $("fringe-zernike-empty");
  if (zernikeContent && data.zernike_chart) {
    zernikeContent.hidden = false;
    if (zernikeEmpty) zernikeEmpty.hidden = true;
    $("fringe-zernike-chart").src = "data:image/png;base64," + data.zernike_chart;
  }

  // Profiles
  const profilesContent = $("fringe-profiles-content");
  const profilesEmpty = $("fringe-profiles-empty");
  if (profilesContent && data.profile_x) {
    profilesContent.hidden = false;
    if (profilesEmpty) profilesEmpty.hidden = true;
    drawProfile($("fringe-profile-x-canvas"), data.profile_x, "Horizontal Profile (center row)");
    drawProfile($("fringe-profile-y-canvas"), data.profile_y, "Vertical Profile (center col)");
  }

  // Hide 3D empty state if we have results
  if (fr.lastResult) {
    const empty3d = $("fringe-3d-empty");
    if (empty3d) empty3d.textContent = "Click to load 3D view.";
  }
}

function drawProfile(canvas, profile, title) {
  if (!canvas || !profile) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = "#1c1c1e";
  ctx.fillRect(0, 0, w, h);

  const values = profile.values.filter(v => v !== null);
  if (values.length < 2) return;

  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  const vRange = vMax - vMin || 1;

  const padL = 60, padR = 20, padT = 30, padB = 30;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // Grid
  ctx.strokeStyle = "#3a3a3c";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  // Title
  ctx.fillStyle = "#e8e8e8";
  ctx.font = "11px -apple-system, sans-serif";
  ctx.fillText(title, padL, 16);

  // Y-axis labels
  ctx.fillStyle = "#ababab";
  ctx.font = "9px -apple-system, sans-serif";
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    const v = vMax - (vRange * i) / 4;
    ctx.fillText(v.toFixed(1), 5, y + 3);
  }

  // Plot line
  ctx.strokeStyle = "#4a9eff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < profile.values.length; i++) {
    const v = profile.values[i];
    if (v === null) { started = false; continue; }
    const x = padL + (i / (profile.values.length - 1)) * plotW;
    const y = padT + ((vMax - v) / vRange) * plotH;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ── 3D View ─────────────────────────────────────────────────────────────

async function render3dView() {
  if (!fr.lastResult) return;
  const empty = $("fringe-3d-empty");
  const content = $("fringe-3d-content");
  const host = $("fringe-3d-host");
  if (!host) return;

  if (empty) empty.hidden = true;
  if (content) content.hidden = false;

  // Load Three.js if needed
  if (!fr.threeLoaded) {
    const THREE = await import("https://esm.sh/three@0.160.0");
    const { OrbitControls } = await import("https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js");
    fr.THREE = THREE;
    fr.OrbitControls = OrbitControls;
    fr.threeLoaded = true;
  }
  const THREE = fr.THREE;
  const OrbitControls = fr.OrbitControls;

  const controlsEl = $("fringe-3d-controls");
  host.innerHTML = "";

  const w = host.clientWidth || 600;
  const h = host.clientHeight || 400;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  const camera = new THREE.PerspectiveCamera(50, w / h, 0.01, 1000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  host.appendChild(renderer.domElement);
  if (controlsEl) host.appendChild(controlsEl);
  const controls = new OrbitControls(camera, renderer.domElement);

  // Build mesh from profile data
  const profileX = fr.lastResult.profile_x;
  const profileY = fr.lastResult.profile_y;
  if (!profileX || !profileY) return;

  const cols = profileX.values.length;
  const rows = profileY.values.length;
  const geo = new THREE.PlaneGeometry(cols, rows, cols - 1, rows - 1);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  const coeffs = fr.lastResult.coefficients || [];

  const zSlider = $("fringe-3d-z-scale");
  const zLabel = $("fringe-3d-z-val");
  let zScale = zSlider ? parseFloat(zSlider.value) : 10;

  function applyZ() {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const nx = (c / (cols - 1) - 0.5) * 2;
        const ny = (r / (rows - 1) - 0.5) * 2;
        const rho = Math.sqrt(nx * nx + ny * ny);
        let z = 0;
        if (coeffs.length >= 4) {
          z += coeffs[3] * (2 * rho * rho - 1); // defocus
        }
        if (coeffs.length >= 6) {
          z += coeffs[4] * rho * rho * Math.cos(2 * Math.atan2(ny, nx)); // astig
        }
        z *= zScale * 0.1;
        pos.setZ(idx, z);
        const t = Math.max(0, Math.min(1, (z + zScale * 0.1) / (2 * zScale * 0.1)));
        colors[idx * 3] = t < 0.5 ? 0.2 + t : 0.8;
        colors[idx * 3 + 1] = 0.2;
        colors[idx * 3 + 2] = t < 0.5 ? 0.8 : 1.0 - t;
      }
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }
  applyZ();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  const light1 = new THREE.DirectionalLight(0xffffff, 1);
  light1.position.set(1, 1, 2);
  scene.add(light1);
  scene.add(new THREE.AmbientLight(0x404040));

  camera.position.set(0, -cols * 0.4, cols * 0.6);
  camera.lookAt(0, 0, 0);
  controls.update();

  if (zSlider) {
    zSlider.oninput = () => {
      zScale = parseFloat(zSlider.value);
      if (zLabel) zLabel.textContent = zScale + "x";
      applyZ();
    };
  }

  function animate() {
    if (!host.isConnected) return;
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  const ro = new ResizeObserver(() => {
    const nw = host.clientWidth, nh = host.clientHeight;
    if (nw > 0 && nh > 0) {
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    }
  });
  ro.observe(host);
}

// ── Focus quality polling ───────────────────────────────────────────────

async function pollFocusQuality() {
  try {
    const r = await apiFetch("/fringe/focus-quality");
    if (!r.ok) return;
    const data = await r.json();
    const fill = $("fringe-focus-fill");
    const label = $("fringe-focus-score");
    if (fill) fill.style.width = data.score + "%";
    if (label) label.textContent = data.score.toFixed(0);
    // Color: red < 30, yellow 30-60, green > 60
    if (fill) {
      if (data.score < 30) fill.style.background = "var(--danger)";
      else if (data.score < 60) fill.style.background = "var(--warning)";
      else fill.style.background = "var(--success)";
    }
  } catch { /* ignore */ }
}

function startPolling() {
  stopPolling();
  pollFocusQuality();
  fr.polling = setInterval(pollFocusQuality, 2000);
}

function stopPolling() {
  if (fr.polling) {
    clearInterval(fr.polling);
    fr.polling = null;
  }
}

// ── Public init ─────────────────────────────────────────────────────────

export function initFringe() {
  buildWorkspace();

  // Start/stop polling when mode becomes visible/hidden
  const observer = new MutationObserver(() => {
    const root = $("mode-fringe");
    if (!root) return;
    if (root.hidden) {
      stopPolling();
    } else {
      startPolling();
    }
  });
  const root = $("mode-fringe");
  if (root) observer.observe(root, { attributes: true, attributeFilter: ["hidden"] });
}
