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
  maskPolygons: [],        // [{vertices: [{x,y},...], include: bool}, ...]
  maskDrawing: false,      // currently drawing a polygon?
  maskCurrentVertices: [], // vertices being placed for current polygon
  maskIsHole: false,       // current polygon is a hole?
  measureMode: null,       // null | "cursor" | "point2point" | "lineProfile" | "area"
  measurePoints: [],       // array of {nx, ny} normalized coords for active measurement
  heightGrid: null,        // Float32Array from server
  maskGrid: null,          // Uint8Array from server
  gridRows: 0,
  gridCols: 0,
  avgCoefficients: null,   // Float64Array of accumulated coefficient sums
  avgCount: 0,             // number of captures averaged
  avgSurfaceHeight: 0,
  avgSurfaceWidth: 0,
};

function $(id) { return document.getElementById(id); }

// ── Wavelength presets ──────────────────────────────────────────────────
// Defaults; overridden at init from /config/fringe if available.
// "custom" is a UI-only entry, always appended by rebuildWavelengthSelect().

let WAVELENGTHS = [
  { id: "sodium", label: "Sodium (589 nm)",   nm: 589.0 },
  { id: "hene",   label: "HeNe (632.8 nm)",   nm: 632.8 },
  { id: "green",  label: "Green LED (532 nm)", nm: 532.0 },
];

function rebuildWavelengthSelect() {
  const sel = $("fringe-wavelength");
  if (!sel) return;
  sel.innerHTML = "";
  for (const wl of WAVELENGTHS) {
    const opt = document.createElement("option");
    opt.value = wl.id;
    opt.textContent = wl.label;
    opt.dataset.nm = wl.nm;
    sel.appendChild(opt);
  }
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "Custom...";
  sel.appendChild(custom);
}

async function loadWavelengthPresets() {
  try {
    const r = await apiFetch("/config/fringe");
    if (!r.ok) return;
    const cfg = await r.json();
    if (Array.isArray(cfg.fringe_wavelengths) && cfg.fringe_wavelengths.length > 0) {
      WAVELENGTHS = cfg.fringe_wavelengths;
      rebuildWavelengthSelect();
    }
    if (cfg.standards && Array.isArray(cfg.standards)) {
      const sel = $("fringe-standard");
      if (sel) {
        const groups = {};
        for (const s of cfg.standards) {
          const prefix = s.label.split(" ")[0];
          if (!groups[prefix]) groups[prefix] = [];
          groups[prefix].push(s);
        }
        for (const [name, items] of Object.entries(groups)) {
          const optgroup = document.createElement("optgroup");
          optgroup.label = name;
          for (const s of items) {
            const opt = document.createElement("option");
            opt.value = s.id;
            opt.textContent = s.label;
            opt.dataset.pvNm = s.pv_nm;
            optgroup.appendChild(opt);
          }
          sel.appendChild(optgroup);
        }
      }
    }
  } catch (e) { /* use defaults */ }
}

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
        <div class="fringe-preview-container" style="position:relative">
          <img id="fringe-preview" src="/stream" alt="Camera preview" />
          <canvas id="fringe-roi-canvas" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none"></canvas>
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

        <div id="fringe-avg-controls" style="display:flex;gap:4px;align-items:center;margin-top:4px">
          <button class="detect-btn" id="fringe-btn-avg-add" style="padding:4px 10px;font-size:11px;flex:1" disabled title="Freeze a frame and add its Zernike coefficients to the running average">
            + Add to Avg
          </button>
          <span id="fringe-avg-count" style="font-size:11px;opacity:0.6;min-width:20px;text-align:center">0</span>
          <button class="detect-btn" id="fringe-btn-avg-reset" style="padding:4px 10px;font-size:11px;opacity:0.6" disabled>
            Reset
          </button>
        </div>

        <div style="display:flex;gap:4px;align-items:center">
          <button class="detect-btn" id="fringe-btn-mask" style="padding:4px 10px;font-size:11px;flex:1">
            Draw Mask
          </button>
          <button class="detect-btn" id="fringe-btn-mask-hole" style="padding:4px 10px;font-size:11px;flex:1" hidden>
            + Add Hole
          </button>
          <button class="detect-btn" id="fringe-btn-mask-clear" style="padding:4px 10px;font-size:11px;opacity:0.6" disabled>
            Clear All
          </button>
        </div>
        <div id="fringe-mask-hint" style="font-size:10px;opacity:0.5;text-align:center" hidden>
          Click vertices to draw polygon. Double-click to close. Right-click to undo last vertex.
        </div>

        <div class="fringe-drop-zone" id="fringe-drop-zone">
          <span style="opacity:0.5;font-size:12px">or drag &amp; drop an image</span>
        </div>

        <div class="fringe-setting-group" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
          <div style="font-size:12px;font-weight:600;opacity:0.7">Settings</div>
          <label>Wavelength
            <select id="fringe-wavelength">
              ${WAVELENGTHS.map((wl, i) =>
                `<option value="${wl.id}"${i === 0 ? " selected" : ""} data-nm="${wl.nm}">${wl.label}</option>`
              ).join("")}
              <option value="custom">Custom...</option>
            </select>
          </label>
          <label id="fringe-custom-wl-label" hidden>Custom wavelength (nm)
            <input type="number" id="fringe-custom-wl" min="200" max="2000" step="0.1" value="589.0" />
          </label>
          <label>Mask threshold
            <input type="range" id="fringe-mask-thresh" min="0" max="100" step="1" value="15" style="width:100px" />
            <span id="fringe-mask-thresh-val" style="font-size:11px;min-width:28px">15%</span>
          </label>
          <label>Reference standard
            <select id="fringe-standard">
              <option value="">None</option>
            </select>
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
        <div class="fringe-setting-group" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
          <button class="detect-btn" id="fringe-btn-invert" style="padding:4px 10px;font-size:11px;width:100%" disabled title="Flip the wavefront sign (swap hills and valleys)">
            ↕ Invert Wavefront
          </button>
        </div>
        <div class="fringe-setting-group" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
          <div style="font-size:12px;font-weight:600;opacity:0.7">Export</div>
          <div style="display:flex;gap:4px">
            <button class="detect-btn" id="fringe-btn-export-pdf" style="padding:4px 10px;font-size:11px;flex:1" disabled>
              PDF Report
            </button>
            <button class="detect-btn" id="fringe-btn-export-csv" style="padding:4px 10px;font-size:11px;flex:1" disabled>
              Zernike CSV
            </button>
          </div>
        </div>
      </div>

      <!-- Right column: results -->
      <div class="fringe-results-col">
        <div class="fringe-summary-bar" id="fringe-summary-bar" hidden title="PV = total range of surface error. RMS = average deviation. Lower = flatter.">
          <div class="fringe-stat">
            <span class="fringe-stat-label" title="Peak-to-Valley: worst-case surface error">PV</span>
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
          <div class="fringe-stat">
            <span class="fringe-stat-label" title="Strehl ratio: 1.0 = diffraction-limited. Computed as exp(-(2\u03c0\u00b7RMS)\u00b2)">Strehl</span>
            <span class="fringe-stat-value" id="fringe-strehl">--</span>
          </div>
          <div class="fringe-stat" style="margin-left:auto">
            <span class="fringe-stat-label" style="min-width:auto">\u03bb</span>
            <span id="fringe-summary-wl" style="font-size:12px;opacity:0.7">589 nm</span>
            <span style="margin-left:12px;font-size:11px;opacity:0.5" id="fringe-summary-sub">Tilt subtracted</span>
          </div>
        </div>

        <div class="fringe-tab-bar" id="fringe-tab-bar">
          <button class="fringe-tab active" data-tab="surface">Surface Map</button>
          <button class="fringe-tab" data-tab="3d">3D View</button>
          <button class="fringe-tab" data-tab="zernike">Zernike</button>
          <button class="fringe-tab" data-tab="profiles">Profiles</button>
          <button class="fringe-tab" data-tab="psf">PSF / MTF</button>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-surface">
          <div class="fringe-empty-state" id="fringe-empty">
            <div style="max-width:420px;text-align:left;line-height:1.6">
              <div style="font-size:14px;font-weight:600;margin-bottom:8px;text-align:center">Freeze a frame or drop an interferogram to analyze</div>
              <div style="font-size:12px;opacity:0.7;margin-top:12px">
                <div style="font-weight:600;margin-bottom:4px">Tips for best results:</div>
                <ul style="margin:0;padding-left:18px">
                  <li>Clean both surfaces thoroughly — dust particles create false fringes</li>
                  <li>Place the flat gently, don't press — pressure causes stress fringes</li>
                  <li>Slide slightly to "wring" the flat — this minimizes the air gap</li>
                  <li>Aim for 3–5 fringes across the surface for best accuracy</li>
                  <li>Closed circular fringes indicate trapped dust or burrs</li>
                  <li>Use monochromatic light (sodium lamp or HeNe laser)</li>
                </ul>
              </div>
            </div>
          </div>
          <div id="fringe-loading-overlay" hidden style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);z-index:10">
            <div style="text-align:center">
              <div class="fringe-spinner"></div>
              <div style="margin-top:8px;font-size:13px;opacity:0.8" id="fringe-loading-text">Analyzing...</div>
            </div>
          </div>
          <div id="fringe-surface-content" hidden style="display:flex;flex-direction:column;flex:1;min-height:0">
            <div class="fringe-measure-toolbar" id="fringe-measure-toolbar">
              <button class="fringe-measure-btn active" data-mode="" title="Pan / zoom (no measurement)">↔ Pan</button>
              <button class="fringe-measure-btn" data-mode="cursor" title="Hover to see height at cursor">⊹ Cursor</button>
              <button class="fringe-measure-btn" data-mode="point2point" title="Click two points to measure height difference">⬍ Δh</button>
              <button class="fringe-measure-btn" data-mode="lineProfile" title="Click two points to draw a line profile">╲ Profile</button>
              <button class="fringe-measure-btn" data-mode="area" title="Click two corners to get area statistics">▭ Area</button>
              <span class="fringe-measure-readout" id="fringe-measure-readout"></span>
            </div>
            <div class="fringe-surface-container" id="fringe-surface-viewport" style="overflow:hidden;cursor:grab">
              <div id="fringe-surface-wrapper" style="position:relative;display:inline-block;transform-origin:0 0">
                <img id="fringe-surface-img" draggable="false" style="display:block" />
                <svg id="fringe-measure-svg" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible"></svg>
              </div>
            </div>
            <canvas id="fringe-line-profile-chart" width="800" height="150" hidden></canvas>
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-3d" hidden>
          <div class="fringe-empty-state" id="fringe-3d-empty">Analyze an image first.</div>
          <div id="fringe-3d-content" hidden style="display:flex;flex-direction:column;flex:1;min-height:0">
            <p style="font-size:11px;opacity:0.6;margin:4px 12px">Drag to rotate, scroll to zoom. Z exaggeration amplifies height differences for visibility.</p>
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
            <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Each bar = one type of surface error (tilt, curvature, astigmatism, etc). Taller bars = more of that error. Gray bars have been subtracted from the surface map.</p>
            <img id="fringe-zernike-chart" style="width:100%;max-width:900px" />
            <div id="fringe-zernike-table-container" style="margin-top:12px;max-height:400px;overflow-y:auto"></div>
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-profiles" hidden>
          <div class="fringe-empty-state" id="fringe-profiles-empty">Analyze an image first.</div>
          <div id="fringe-profiles-content" hidden>
            <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Cross-sections through the center of the surface. Shows height (nm) across the part horizontally and vertically.</p>
            <canvas id="fringe-profile-x-canvas" width="800" height="200"></canvas>
            <canvas id="fringe-profile-y-canvas" width="800" height="200"></canvas>
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-psf" hidden>
          <div class="fringe-empty-state" id="fringe-psf-empty">Analyze an image first.</div>
          <div id="fringe-psf-content" hidden style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
            <div>
              <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Point Spread Function (log scale)</p>
              <img id="fringe-psf-img" style="width:256px;height:256px;image-rendering:pixelated" />
            </div>
            <div style="flex:1;min-width:300px">
              <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Modulation Transfer Function</p>
              <canvas id="fringe-mtf-canvas" width="400" height="250" style="width:100%;max-width:500px"></canvas>
            </div>
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

  // Reference standard change → re-color PV
  $("fringe-standard")?.addEventListener("change", () => {
    if (fr.lastResult) renderResults(fr.lastResult);
  });

  // Analyze button
  $("fringe-btn-analyze")?.addEventListener("click", analyzeFromCamera);

  // Averaging buttons
  $("fringe-btn-avg-add")?.addEventListener("click", addToAverage);
  $("fringe-btn-avg-reset")?.addEventListener("click", resetAverage);
  $("fringe-btn-invert")?.addEventListener("click", invertWavefront);
  $("fringe-btn-export-pdf")?.addEventListener("click", exportFringePdf);
  $("fringe-btn-export-csv")?.addEventListener("click", exportFringeCsv);

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
    if (fr.maskDrawing) { exitMaskDrawMode(); return; }
    const overlay = $("fringe-enlarge-overlay");
    if (overlay) overlay.hidden = true;
  });
  $("fringe-enlarge-overlay")?.addEventListener("click", (e) => {
    if (fr.maskDrawing) return; // don't close during mask drawing
    if (e.target === e.currentTarget) {
      e.currentTarget.hidden = true;
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (fr.maskDrawing) { exitMaskDrawMode(); return; }
      const overlay = $("fringe-enlarge-overlay");
      if (overlay && !overlay.hidden) overlay.hidden = true;
    }
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

  // Mask polygon drawing
  $("fringe-btn-mask")?.addEventListener("click", () => {
    if (fr.maskDrawing) {
      exitMaskDrawMode();
    } else {
      enterMaskDrawMode(false);
    }
  });
  $("fringe-btn-mask-hole")?.addEventListener("click", () => {
    enterMaskDrawMode(true);
  });
  $("fringe-btn-mask-clear")?.addEventListener("click", () => {
    fr.maskPolygons = [];
    drawMaskOverlay();
    const clearBtn = $("fringe-btn-mask-clear");
    if (clearBtn) { clearBtn.disabled = true; clearBtn.style.opacity = "0.6"; }
    const holeBtn = $("fringe-btn-mask-hole");
    if (holeBtn) holeBtn.hidden = true;
  });

  // Surface map zoom/pan
  const viewport = $("fringe-surface-viewport");
  if (viewport) {
    let smZoom = 1, smPanX = 0, smPanY = 0, smDragging = false, smDragX = 0, smDragY = 0;
    const applySm = () => {
      const wrapper = $("fringe-surface-wrapper");
      if (wrapper) wrapper.style.transform = `translate(${smPanX}px,${smPanY}px) scale(${smZoom})`;
    };
    viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const prev = smZoom;
      smZoom = Math.max(1, Math.min(10, smZoom + (e.deltaY < 0 ? 0.3 : -0.3)));
      if (smZoom === 1) { smPanX = 0; smPanY = 0; }
      else {
        smPanX *= smZoom / prev;
        smPanY *= smZoom / prev;
      }
      applySm();
    });
    viewport.addEventListener("mousedown", (e) => {
      e.preventDefault(); // prevent native image drag
      if (fr.measureMode) return; // measurement mode handles its own clicks
      if (smZoom <= 1) return;
      smDragging = true; smDragX = e.clientX - smPanX; smDragY = e.clientY - smPanY;
      viewport.style.cursor = "grabbing";
    });
    window.addEventListener("mousemove", (e) => {
      if (!smDragging) return;
      smPanX = e.clientX - smDragX; smPanY = e.clientY - smDragY;
      applySm();
    });
    window.addEventListener("mouseup", () => {
      smDragging = false; viewport.style.cursor = fr.measureMode ? "crosshair" : "grab";
    });
  }

  // Measurement toolbar
  document.querySelectorAll(".fringe-measure-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".fringe-measure-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const mode = btn.dataset.mode || null;
      fr.measureMode = mode;
      fr.measurePoints = [];
      const viewport = $("fringe-surface-viewport");
      if (viewport) viewport.style.cursor = mode ? "crosshair" : "grab";
      clearMeasureSvg();
      setMeasureReadout("");
      const chart = $("fringe-line-profile-chart");
      if (chart) chart.hidden = true;
      if (!mode) drawPeakValleyMarkers(); // restore markers in pan mode
    });
  });

  // Surface measurement mouse events
  if (viewport) {
    viewport.addEventListener("mousemove", (e) => {
      const coords = surfaceMouseCoords(e);
      if (!coords) return;

      if (fr.measureMode === "cursor") {
        const h = getHeightAt(coords.nx, coords.ny);
        setMeasureReadout(h !== null ? `Height: ${fmtNm(h)}` : "Masked");
        drawCursorCrosshair(coords.nx, coords.ny);
      } else if (fr.measureMode === "area" && fr.measurePoints.length === 1) {
        const p1 = fr.measurePoints[0];
        const svg = $("fringe-measure-svg");
        const imgEl = $("fringe-surface-img");
        if (svg && imgEl) {
          const w = imgEl.clientWidth;
          const h = imgEl.clientHeight;
          svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
          const x0 = Math.min(p1.nx, coords.nx) * w;
          const y0 = Math.min(p1.ny, coords.ny) * h;
          const rw = Math.abs(coords.nx - p1.nx) * w;
          const rh = Math.abs(coords.ny - p1.ny) * h;
          svg.innerHTML = `<rect x="${x0}" y="${y0}" width="${rw}" height="${rh}"
            fill="rgba(10,132,255,0.1)" stroke="#0a84ff" stroke-width="1.5" stroke-dasharray="5,3"/>`;
        }
      } else if (fr.measureMode === "lineProfile" && fr.measurePoints.length === 1) {
        const p1 = fr.measurePoints[0];
        const svg = $("fringe-measure-svg");
        const imgEl = $("fringe-surface-img");
        if (svg && imgEl) {
          const w = imgEl.clientWidth;
          const h = imgEl.clientHeight;
          svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
          svg.innerHTML = `
            <line x1="${p1.nx * w}" y1="${p1.ny * h}" x2="${coords.nx * w}" y2="${coords.ny * h}"
              stroke="#0a84ff" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.6"/>
            <circle cx="${p1.nx * w}" cy="${p1.ny * h}" r="5" fill="#ff4d6d" stroke="#000" stroke-width="1"/>`;
        }
      }
    });

    viewport.addEventListener("mouseleave", () => {
      if (fr.measureMode === "cursor") {
        setMeasureReadout("");
        clearMeasureSvg();
      }
    });

    viewport.addEventListener("click", (e) => {
      if (!fr.measureMode || fr.measureMode === "cursor") return;
      const coords = surfaceMouseCoords(e);
      if (!coords) return;

      if (fr.measureMode === "point2point") {
        handlePoint2PointClick(coords);
      } else if (fr.measureMode === "lineProfile") {
        handleLineProfileClick(coords);
      } else if (fr.measureMode === "area") {
        handleAreaClick(coords);
      }
    });
  } // end if (viewport) — measurement events

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

// ── Measurement functions ────────────────────────────────────────────────

function drawCursorCrosshair(nx, ny) {
  const svg = $("fringe-measure-svg");
  const imgEl = $("fringe-surface-img");
  if (!svg || !imgEl) return;
  const w = imgEl.clientWidth;
  const h = imgEl.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const x = nx * w;
  const y = ny * h;
  svg.innerHTML = `
    <line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#fff" stroke-width="0.5" opacity="0.5"/>
    <line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#fff" stroke-width="0.5" opacity="0.5"/>
    <circle cx="${x}" cy="${y}" r="4" fill="none" stroke="#0a84ff" stroke-width="1.5"/>
  `;
}

function handlePoint2PointClick(coords) {
  const h = getHeightAt(coords.nx, coords.ny);
  if (h === null) { setMeasureReadout("Clicked on masked area"); return; }

  fr.measurePoints.push({ ...coords, h });

  if (fr.measurePoints.length === 1) {
    setMeasureReadout(`Point 1: ${fmtNm(h)} — click second point`);
    drawMeasurePoints();
  } else {
    const p1 = fr.measurePoints[0];
    const p2 = fr.measurePoints[1];
    const delta = p2.h - p1.h;
    setMeasureReadout(`Δh = ${fmtNm(delta)}  (${fmtNm(p1.h)} → ${fmtNm(p2.h)})`);
    drawMeasurePoints();
    fr.measurePoints = [];
  }
}

function drawMeasurePoints() {
  const svg = $("fringe-measure-svg");
  const imgEl = $("fringe-surface-img");
  if (!svg || !imgEl) return;
  const w = imgEl.clientWidth;
  const h = imgEl.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  let html = "";
  for (let i = 0; i < fr.measurePoints.length; i++) {
    const p = fr.measurePoints[i];
    const x = p.nx * w;
    const y = p.ny * h;
    const color = i === 0 ? "#ff4d6d" : "#7cff7c";
    const label = i === 0 ? "1" : "2";
    html += `<circle cx="${x}" cy="${y}" r="6" fill="none" stroke="${color}" stroke-width="2"/>`;
    html += `<text x="${x + 10}" y="${y - 6}" fill="${color}" font-size="12" font-weight="bold">${label}: ${fmtNm(p.h)}</text>`;
  }

  if (fr.measurePoints.length === 2) {
    const p1 = fr.measurePoints[0];
    const p2 = fr.measurePoints[1];
    html += `<line x1="${p1.nx * w}" y1="${p1.ny * h}" x2="${p2.nx * w}" y2="${p2.ny * h}"
              stroke="#fff" stroke-width="1" stroke-dasharray="4,3" opacity="0.7"/>`;
    const mx = (p1.nx + p2.nx) / 2 * w;
    const my = (p1.ny + p2.ny) / 2 * h;
    const delta = p2.h - p1.h;
    html += `<rect x="${mx - 2}" y="${my - 16}" width="${fmtNm(delta).length * 7 + 10}" height="18"
              rx="3" fill="rgba(0,0,0,0.75)"/>`;
    html += `<text x="${mx + 4}" y="${my - 2}" fill="#fff" font-size="11" font-weight="600">Δ ${fmtNm(delta)}</text>`;
  }

  svg.innerHTML = html;
}

function handleLineProfileClick(coords) {
  const h = getHeightAt(coords.nx, coords.ny);
  if (h === null) { setMeasureReadout("Clicked on masked area"); return; }

  fr.measurePoints.push({ ...coords, h });

  if (fr.measurePoints.length === 1) {
    setMeasureReadout("Click second point to draw profile line");
    drawMeasurePoints();
  } else {
    const p1 = fr.measurePoints[0];
    const p2 = fr.measurePoints[1];
    drawProfileLine(p1, p2);
    fr.measurePoints = [];
  }
}

function drawProfileLine(p1, p2) {
  const nSamples = 200;
  const samples = [];
  for (let i = 0; i <= nSamples; i++) {
    const t = i / nSamples;
    const nx = p1.nx + t * (p2.nx - p1.nx);
    const ny = p1.ny + t * (p2.ny - p1.ny);
    const h = getHeightAt(nx, ny);
    samples.push(h);
  }

  const svg = $("fringe-measure-svg");
  const imgEl = $("fringe-surface-img");
  if (svg && imgEl) {
    const w = imgEl.clientWidth;
    const h = imgEl.clientHeight;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const x1 = p1.nx * w, y1 = p1.ny * h;
    const x2 = p2.nx * w, y2 = p2.ny * h;
    svg.innerHTML = `
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
        stroke="#0a84ff" stroke-width="2" opacity="0.8"/>
      <circle cx="${x1}" cy="${y1}" r="5" fill="#ff4d6d" stroke="#000" stroke-width="1"/>
      <circle cx="${x2}" cy="${y2}" r="5" fill="#7cff7c" stroke="#000" stroke-width="1"/>
    `;
  }

  const valid = samples.filter(v => v !== null);
  if (valid.length < 2) {
    setMeasureReadout("Not enough valid points on line");
    return;
  }
  let lineMin = Infinity, lineMax = -Infinity;
  for (const v of valid) { if (v < lineMin) lineMin = v; if (v > lineMax) lineMax = v; }
  const linePV = lineMax - lineMin;
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const rms = Math.sqrt(valid.reduce((a, v) => a + (v - mean) ** 2, 0) / valid.length);
  setMeasureReadout(`Line PV: ${fmtNm(linePV)}  RMS: ${fmtNm(rms)}`);

  drawLineProfileChart(samples);
}

function drawLineProfileChart(samples) {
  const canvas = $("fringe-line-profile-chart");
  if (!canvas) return;
  canvas.hidden = false;

  const container = canvas.parentElement;
  if (container) canvas.width = container.clientWidth - 24;
  canvas.height = 150;

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = "#1c1c1e";
  ctx.fillRect(0, 0, w, h);

  const valid = samples.map((v, i) => v !== null ? { i, v } : null).filter(Boolean);
  if (valid.length < 2) return;

  const vMin = Math.min(...valid.map(d => d.v));
  const vMax = Math.max(...valid.map(d => d.v));
  const vRange = vMax - vMin || 1;

  const padL = 60, padR = 16, padT = 20, padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  ctx.strokeStyle = "#3a3a3c";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#ababab";
  ctx.font = "9px -apple-system, sans-serif";
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    const v = vMax - (vRange * i) / 4;
    ctx.fillText(fmtNm(v), 2, y + 3);
  }

  ctx.fillStyle = "#e8e8e8";
  ctx.font = "11px -apple-system, sans-serif";
  ctx.fillText("Line Profile", padL, 14);

  ctx.strokeStyle = "#4a9eff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (v === null) { started = false; continue; }
    const x = padL + (i / (samples.length - 1)) * plotW;
    const y = padT + ((vMax - v) / vRange) * plotH;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function handleAreaClick(coords) {
  fr.measurePoints.push(coords);

  if (fr.measurePoints.length === 1) {
    setMeasureReadout("Click second corner for area stats");
  } else {
    const p1 = fr.measurePoints[0];
    const p2 = fr.measurePoints[1];
    computeAreaStats(p1, p2);
    fr.measurePoints = [];
  }
}

function computeAreaStats(p1, p2) {
  const x0 = Math.min(p1.nx, p2.nx);
  const y0 = Math.min(p1.ny, p2.ny);
  const x1 = Math.max(p1.nx, p2.nx);
  const y1 = Math.max(p1.ny, p2.ny);

  const col0 = Math.max(0, Math.floor(x0 * fr.gridCols));
  const col1 = Math.min(fr.gridCols - 1, Math.floor(x1 * fr.gridCols));
  const row0 = Math.max(0, Math.floor(y0 * fr.gridRows));
  const row1 = Math.min(fr.gridRows - 1, Math.floor(y1 * fr.gridRows));

  const values = [];
  for (let r = row0; r <= row1; r++) {
    for (let c = col0; c <= col1; c++) {
      const idx = r * fr.gridCols + c;
      if (fr.maskGrid[idx]) values.push(fr.heightGrid[idx]);
    }
  }

  const svg = $("fringe-measure-svg");
  const imgEl = $("fringe-surface-img");
  if (svg && imgEl) {
    const w = imgEl.clientWidth;
    const h = imgEl.clientHeight;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.innerHTML = `
      <rect x="${x0 * w}" y="${y0 * h}" width="${(x1 - x0) * w}" height="${(y1 - y0) * h}"
        fill="rgba(10,132,255,0.1)" stroke="#0a84ff" stroke-width="1.5" stroke-dasharray="5,3"/>
    `;
  }

  if (values.length < 2) {
    setMeasureReadout("Not enough valid pixels in area");
    return;
  }

  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const pv = max - min;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const rms = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);

  setMeasureReadout(`Area PV: ${fmtNm(pv)}  RMS: ${fmtNm(rms)}  (${values.length} px)`);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function getWavelength() {
  const sel = $("fringe-wavelength");
  if (!sel) return 589.0;
  if (sel.value === "custom") {
    const el = $("fringe-custom-wl");
    const v = parseFloat(el?.value || "589.0");
    return Number.isFinite(v) && v > 0 ? v : 589.0;
  }
  const opt = sel.selectedOptions[0];
  if (opt && opt.dataset.nm) return parseFloat(opt.dataset.nm);
  const entry = WAVELENGTHS.find(wl => wl.id === sel.value);
  return entry?.nm || 589.0;
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

function setMeasureReadout(text) {
  const el = $("fringe-measure-readout");
  if (el) el.textContent = text;
}

function clearMeasureSvg() {
  const svg = $("fringe-measure-svg");
  if (svg) svg.innerHTML = "";
}

function findPeakValley() {
  if (!fr.heightGrid || !fr.maskGrid) return null;
  let peakIdx = -1, valleyIdx = -1;
  let peakVal = -Infinity, valleyVal = Infinity;
  for (let i = 0; i < fr.heightGrid.length; i++) {
    if (!fr.maskGrid[i]) continue;
    const v = fr.heightGrid[i];
    if (v > peakVal) { peakVal = v; peakIdx = i; }
    if (v < valleyVal) { valleyVal = v; valleyIdx = i; }
  }
  if (peakIdx < 0 || valleyIdx < 0) return null;
  return {
    peak: {
      nx: ((peakIdx % fr.gridCols) + 0.5) / fr.gridCols,
      ny: (Math.floor(peakIdx / fr.gridCols) + 0.5) / fr.gridRows,
      h: peakVal,
    },
    valley: {
      nx: ((valleyIdx % fr.gridCols) + 0.5) / fr.gridCols,
      ny: (Math.floor(valleyIdx / fr.gridCols) + 0.5) / fr.gridRows,
      h: valleyVal,
    },
  };
}

function drawPeakValleyMarkers() {
  const pv = findPeakValley();
  if (!pv) return;
  const svg = $("fringe-measure-svg");
  const imgEl = $("fringe-surface-img");
  if (!svg || !imgEl) return;
  if (fr.measureMode) return; // don't draw when measurement mode is active

  const w = imgEl.clientWidth;
  const h = imgEl.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const px = pv.peak.nx * w, py = pv.peak.ny * h;
  const vx = pv.valley.nx * w, vy = pv.valley.ny * h;

  svg.innerHTML = `
    <g>
      <polygon points="${px},${py - 10} ${px - 6},${py} ${px + 6},${py}"
        fill="#ff4d6d" stroke="#000" stroke-width="0.5"/>
      <text x="${px + 10}" y="${py - 2}" fill="#ff4d6d" font-size="10"
        font-weight="600" stroke="#000" stroke-width="2" paint-order="stroke">▲ ${fmtNm(pv.peak.h)}</text>
      <polygon points="${vx},${vy + 10} ${vx - 6},${vy} ${vx + 6},${vy}"
        fill="#4a9eff" stroke="#000" stroke-width="0.5"/>
      <text x="${vx + 10}" y="${vy + 14}" fill="#4a9eff" font-size="10"
        font-weight="600" stroke="#000" stroke-width="2" paint-order="stroke">▼ ${fmtNm(pv.valley.h)}</text>
    </g>
  `;
}

function getHeightAt(nx, ny) {
  if (!fr.heightGrid || !fr.maskGrid) return null;
  const col = Math.min(fr.gridCols - 1, Math.max(0, Math.floor(nx * fr.gridCols)));
  const row = Math.min(fr.gridRows - 1, Math.max(0, Math.floor(ny * fr.gridRows)));
  const idx = row * fr.gridCols + col;
  if (!fr.maskGrid[idx]) return null;
  return fr.heightGrid[idx];
}

function surfaceMouseCoords(e) {
  const imgEl = $("fringe-surface-img");
  if (!imgEl) return null;
  const imgRect = imgEl.getBoundingClientRect();
  const nx = (e.clientX - imgRect.left) / imgRect.width;
  const ny = (e.clientY - imgRect.top) / imgRect.height;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  return { nx, ny };
}

function fmtNm(v) {
  if (v === null || v === undefined) return "masked";
  const abs = Math.abs(v);
  if (abs >= 1000) return (v / 1000).toFixed(2) + " µm";
  return v.toFixed(1) + " nm";
}

// ── Mask polygon overlay (small preview canvas) ─────────────────────────

function drawMaskOverlay() {
  const canvas = $("fringe-roi-canvas");
  const img = $("fringe-preview");
  if (!canvas || !img) return;
  canvas.width = img.clientWidth;
  canvas.height = img.clientHeight;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  _drawPolygonsOnCtx(ctx, canvas.width, canvas.height, fr.maskPolygons, []);
}

function _drawPolygonsOnCtx(ctx, w, h, polygons, currentVerts) {
  // Draw completed polygons
  for (const poly of polygons) {
    if (poly.vertices.length < 2) continue;
    const color = poly.include ? "#0a84ff" : "#ff453a";
    const fill  = poly.include ? "rgba(10,132,255,0.15)" : "rgba(255,69,58,0.15)";
    ctx.beginPath();
    ctx.moveTo(poly.vertices[0].x * w, poly.vertices[0].y * h);
    for (let i = 1; i < poly.vertices.length; i++) {
      ctx.lineTo(poly.vertices[i].x * w, poly.vertices[i].y * h);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Vertex dots
    ctx.fillStyle = color;
    for (const v of poly.vertices) {
      ctx.beginPath();
      ctx.arc(v.x * w, v.y * h, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Draw current in-progress polygon
  if (currentVerts.length > 0) {
    const color = fr.maskIsHole ? "#ff9f0a" : "#30d158";
    ctx.beginPath();
    ctx.moveTo(currentVerts[0].x * w, currentVerts[0].y * h);
    for (let i = 1; i < currentVerts.length; i++) {
      ctx.lineTo(currentVerts[i].x * w, currentVerts[i].y * h);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    // Vertex dots
    for (let i = 0; i < currentVerts.length; i++) {
      const v = currentVerts[i];
      ctx.beginPath();
      ctx.arc(v.x * w, v.y * h, i === 0 ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? "#fff" : color;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// ── Polygon mask draw mode (enlarge overlay + click-to-place vertices) ──

function enterMaskDrawMode(isHole) {
  fr.maskDrawing = true;
  fr.maskIsHole = isHole;
  fr.maskCurrentVertices = [];

  const maskBtn = $("fringe-btn-mask");
  const maskHint = $("fringe-mask-hint");
  if (maskBtn) { maskBtn.textContent = "Cancel"; maskBtn.style.background = "var(--accent)"; }
  if (maskHint) maskHint.hidden = false;

  // Open the enlarge overlay with a drawing canvas on top
  const overlay = $("fringe-enlarge-overlay");
  const enlargeImg = $("fringe-enlarge-img");
  const preview = $("fringe-preview");
  if (!overlay || !enlargeImg || !preview) return;

  enlargeImg.src = preview.src;
  overlay.hidden = false;

  // Create or reuse the drawing canvas on the enlarge overlay
  let drawCanvas = $("fringe-enlarge-roi-canvas");
  if (!drawCanvas) {
    drawCanvas = document.createElement("canvas");
    drawCanvas.id = "fringe-enlarge-roi-canvas";
    drawCanvas.style.cssText = "position:fixed;cursor:crosshair;z-index:10";
    overlay.appendChild(drawCanvas);
  }
  drawCanvas.style.pointerEvents = "auto";
  drawCanvas.style.cursor = "crosshair";

  const setupCanvas = () => {
    const imgRect = enlargeImg.getBoundingClientRect();
    drawCanvas.width = imgRect.width;
    drawCanvas.height = imgRect.height;
    drawCanvas.style.left = imgRect.left + "px";
    drawCanvas.style.top = imgRect.top + "px";
    drawCanvas.style.width = imgRect.width + "px";
    drawCanvas.style.height = imgRect.height + "px";
    drawEnlargeMaskOverlay(drawCanvas);
  };
  if (enlargeImg.complete && enlargeImg.naturalWidth > 0) {
    requestAnimationFrame(setupCanvas);
  } else {
    enlargeImg.onload = () => requestAnimationFrame(setupCanvas);
  }

  // Helper: get normalized coords from mouse event
  const getNorm = (e) => {
    const rect = drawCanvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  // Check if cursor is near first vertex (for polygon closing)
  const nearFirst = (nx, ny) => {
    if (fr.maskCurrentVertices.length < 3) return false;
    const first = fr.maskCurrentVertices[0];
    const rect = drawCanvas.getBoundingClientRect();
    const dx = (nx - first.x) * rect.width;
    const dy = (ny - first.y) * rect.height;
    return Math.sqrt(dx * dx + dy * dy) < 10;
  };

  const closePoly = () => {
    if (fr.maskCurrentVertices.length >= 3) {
      fr.maskPolygons.push({
        vertices: [...fr.maskCurrentVertices],
        include: !fr.maskIsHole,
      });
    }
    fr.maskCurrentVertices = [];
    cleanup();
    exitMaskDrawMode();
  };

  let lastClickTime = 0;

  const handleClick = (e) => {
    if (e.button !== 0) return;
    const { x, y } = getNorm(e);

    // Double-click or click near first vertex → close polygon
    const now = Date.now();
    const isDblClick = now - lastClickTime < 350;
    lastClickTime = now;

    if (nearFirst(x, y) || isDblClick) {
      closePoly();
      return;
    }

    fr.maskCurrentVertices.push({ x, y });
    drawEnlargeMaskOverlay(drawCanvas);
  };

  const handleMove = (e) => {
    const { x, y } = getNorm(e);
    drawEnlargeMaskOverlay(drawCanvas, { x, y }, nearFirst(x, y));
  };

  const handleContext = (e) => {
    e.preventDefault();
    if (fr.maskCurrentVertices.length > 0) {
      fr.maskCurrentVertices.pop();
      drawEnlargeMaskOverlay(drawCanvas);
    } else {
      // No vertices: cancel drawing
      cleanup();
      exitMaskDrawMode();
    }
  };

  drawCanvas.addEventListener("mousedown", handleClick);
  drawCanvas.addEventListener("mousemove", handleMove);
  drawCanvas.addEventListener("contextmenu", handleContext);

  const cleanup = () => {
    drawCanvas.removeEventListener("mousedown", handleClick);
    drawCanvas.removeEventListener("mousemove", handleMove);
    drawCanvas.removeEventListener("contextmenu", handleContext);
    drawCanvas.style.pointerEvents = "none";
    const ctx = drawCanvas.getContext("2d");
    ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  };

  fr._maskCleanup = cleanup;
}

function exitMaskDrawMode() {
  fr.maskDrawing = false;
  fr.maskCurrentVertices = [];
  const maskBtn = $("fringe-btn-mask");
  const maskHint = $("fringe-mask-hint");
  if (maskBtn) { maskBtn.textContent = "Draw Mask"; maskBtn.style.background = ""; }
  if (maskHint) maskHint.hidden = true;
  if (fr._maskCleanup) { fr._maskCleanup(); fr._maskCleanup = null; }

  // Show/hide hole and clear buttons based on current state
  const hasInclude = fr.maskPolygons.some(p => p.include);
  const holeBtn = $("fringe-btn-mask-hole");
  if (holeBtn) holeBtn.hidden = !hasInclude;
  const clearBtn = $("fringe-btn-mask-clear");
  if (clearBtn) {
    clearBtn.disabled = fr.maskPolygons.length === 0;
    clearBtn.style.opacity = fr.maskPolygons.length === 0 ? "0.6" : "1";
  }

  // Close the enlarge overlay
  const overlay = $("fringe-enlarge-overlay");
  if (overlay) overlay.hidden = true;

  // Update the small preview overlay
  drawMaskOverlay();

  // Wire right-click context menu on enlarged view for completed polygons
  _wireEnlargeContextMenu();
}

function drawEnlargeMaskOverlay(canvas, cursor, nearFirst) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const w = canvas.width;
  const h = canvas.height;

  _drawPolygonsOnCtx(ctx, w, h, fr.maskPolygons, fr.maskCurrentVertices);

  // Draw rubber-band line from last vertex to cursor
  if (cursor && fr.maskCurrentVertices.length > 0) {
    const last = fr.maskCurrentVertices[fr.maskCurrentVertices.length - 1];
    const color = fr.maskIsHole ? "#ff9f0a" : "#30d158";
    ctx.beginPath();
    ctx.moveTo(last.x * w, last.y * h);
    ctx.lineTo(cursor.x * w, cursor.y * h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Highlight first vertex when near it (close hint)
    if (nearFirst && fr.maskCurrentVertices.length >= 3) {
      const first = fr.maskCurrentVertices[0];
      ctx.beginPath();
      ctx.arc(first.x * w, first.y * h, 8, 0, Math.PI * 2);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

// ── Right-click context menu on completed polygons in the enlarged view ──

function _wireEnlargeContextMenu() {
  // Context menu is only shown when the enlarged overlay is open and NOT in draw mode.
  // We use the enlarged image itself (or the overlay) as the event target.
  const overlay = $("fringe-enlarge-overlay");
  if (!overlay) return;

  // Remove any previously attached handler
  if (overlay._maskContextHandler) {
    overlay.removeEventListener("contextmenu", overlay._maskContextHandler);
  }

  overlay._maskContextHandler = (e) => {
    if (fr.maskDrawing) return;
    const enlargeImg = $("fringe-enlarge-img");
    if (!enlargeImg) return;
    const imgRect = enlargeImg.getBoundingClientRect();
    const nx = (e.clientX - imgRect.left) / imgRect.width;
    const ny = (e.clientY - imgRect.top) / imgRect.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;

    // Point-in-polygon test (ray casting), reverse order for top-most
    let hitIdx = -1;
    for (let i = fr.maskPolygons.length - 1; i >= 0; i--) {
      if (_pointInPolygon(nx, ny, fr.maskPolygons[i].vertices)) {
        hitIdx = i;
        break;
      }
    }
    if (hitIdx === -1) return;
    e.preventDefault();
    _showPolyContextMenu(e.clientX, e.clientY, hitIdx);
  };

  overlay.addEventListener("contextmenu", overlay._maskContextHandler);
}

function _pointInPolygon(px, py, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y;
    const xj = vertices[j].x, yj = vertices[j].y;
    const intersect = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function _showPolyContextMenu(cx, cy, idx) {
  // Remove any existing popup
  const existing = document.getElementById("fringe-poly-ctx-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.id = "fringe-poly-ctx-menu";
  menu.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;z-index:9999;
    background:var(--surface,#1c1c1e);border:1px solid var(--border,#3a3a3c);
    border-radius:6px;padding:4px 0;min-width:160px;box-shadow:0 4px 16px rgba(0,0,0,0.5);
    font-size:12px`;

  const poly = fr.maskPolygons[idx];
  const toggleLabel = poly.include ? "Convert to Hole (Exclude)" : "Convert to Include";

  const item1 = document.createElement("div");
  item1.textContent = toggleLabel;
  item1.style.cssText = "padding:6px 14px;cursor:pointer;opacity:0.9";
  item1.addEventListener("mouseover", () => { item1.style.background = "var(--accent,#0a84ff)"; });
  item1.addEventListener("mouseout", () => { item1.style.background = ""; });
  item1.addEventListener("click", () => {
    fr.maskPolygons[idx].include = !fr.maskPolygons[idx].include;
    menu.remove();
    // Redraw on the enlarged canvas if open
    const drawCanvas = $("fringe-enlarge-roi-canvas");
    if (drawCanvas && drawCanvas.width > 0) drawEnlargeMaskOverlay(drawCanvas);
    drawMaskOverlay();
  });

  const item2 = document.createElement("div");
  item2.textContent = "Delete";
  item2.style.cssText = "padding:6px 14px;cursor:pointer;color:#ff453a";
  item2.addEventListener("mouseover", () => { item2.style.background = "rgba(255,69,58,0.15)"; });
  item2.addEventListener("mouseout", () => { item2.style.background = ""; });
  item2.addEventListener("click", () => {
    fr.maskPolygons.splice(idx, 1);
    menu.remove();
    const hasInclude = fr.maskPolygons.some(p => p.include);
    const holeBtn = $("fringe-btn-mask-hole");
    if (holeBtn) holeBtn.hidden = !hasInclude;
    const clearBtn = $("fringe-btn-mask-clear");
    if (clearBtn) {
      clearBtn.disabled = fr.maskPolygons.length === 0;
      clearBtn.style.opacity = fr.maskPolygons.length === 0 ? "0.6" : "1";
    }
    const drawCanvas = $("fringe-enlarge-roi-canvas");
    if (drawCanvas && drawCanvas.width > 0) drawEnlargeMaskOverlay(drawCanvas);
    drawMaskOverlay();
  });

  menu.appendChild(item1);
  menu.appendChild(item2);
  document.body.appendChild(menu);

  // Close menu on any outside click
  const dismiss = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("mousedown", dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);
}

function setStatus(msg) {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.textContent = msg;
  const ws = document.querySelector(".fringe-workspace");
  if (ws) ws.style.cursor = "wait";
  const overlay = $("fringe-loading-overlay");
  if (overlay) {
    overlay.hidden = false;
    const text = $("fringe-loading-text");
    if (text) text.textContent = msg;
  }
}

function resetStatus() {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.textContent = "Freeze & Analyze";
  const ws = document.querySelector(".fringe-workspace");
  if (ws) ws.style.cursor = "";
  const overlay = $("fringe-loading-overlay");
  if (overlay) overlay.hidden = true;
}

// ── Analysis ────────────────────────────────────────────────────────────

async function analyzeFromCamera() {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.disabled = true;
  setStatus("Analyzing...");
  try {
    const payload = {
      wavelength_nm: getWavelength(),
      mask_threshold: getMaskThreshold(),
      subtract_terms: getSubtractTerms(),
      mask_polygons: fr.maskPolygons.length > 0
        ? fr.maskPolygons.map(p => ({
            vertices: p.vertices.map(v => [v.x, v.y]),
            include: p.include,
          }))
        : undefined,
    };
    console.log("[fringe] analyze payload:", JSON.stringify(payload));
    const r = await apiFetch("/fringe/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
    const avgBtn = $("fringe-btn-avg-add");
    if (avgBtn) avgBtn.disabled = false;
    const invBtn = $("fringe-btn-invert");
    if (invBtn) invBtn.disabled = false;
    const pdfBtn = $("fringe-btn-export-pdf");
    if (pdfBtn) pdfBtn.disabled = false;
    const csvBtn = $("fringe-btn-export-csv");
    if (csvBtn) csvBtn.disabled = false;
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
        mask_polygons: fr.maskPolygons.length > 0
          ? fr.maskPolygons.map(p => ({
              vertices: p.vertices.map(v => [v.x, v.y]),
              include: p.include,
            }))
          : undefined,
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
    const avgBtn = $("fringe-btn-avg-add");
    if (avgBtn) avgBtn.disabled = false;
    const invBtn2 = $("fringe-btn-invert");
    if (invBtn2) invBtn2.disabled = false;
    const pdfBtn2 = $("fringe-btn-export-pdf");
    if (pdfBtn2) pdfBtn2.disabled = false;
    const csvBtn2 = $("fringe-btn-export-csv");
    if (csvBtn2) csvBtn2.disabled = false;
  } catch (e) {
    console.warn("Fringe analysis error:", e);
    setStatus("Error");
    setTimeout(resetStatus, 2000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function addToAverage() {
  const btn = $("fringe-btn-avg-add");
  if (btn) btn.disabled = true;
  setStatus("Averaging...");
  try {
    const r = await apiFetch("/fringe/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wavelength_nm: getWavelength(),
        mask_threshold: getMaskThreshold(),
        subtract_terms: getSubtractTerms(),
        mask_polygons: fr.maskPolygons.length > 0
          ? fr.maskPolygons.map(p => ({
              vertices: p.vertices.map(v => [v.x, v.y]),
              include: p.include,
            }))
          : undefined,
      }),
    });
    if (!r.ok) { setStatus("Failed"); setTimeout(resetStatus, 2000); return; }
    const data = await r.json();
    fr.lastResult = data;

    // Accumulate coefficients
    if (!fr.avgCoefficients) {
      fr.avgCoefficients = new Float64Array(data.coefficients.length);
      fr.avgCount = 0;
      fr.avgSurfaceHeight = data.surface_height;
      fr.avgSurfaceWidth = data.surface_width;
    }
    for (let i = 0; i < data.coefficients.length; i++) {
      fr.avgCoefficients[i] += data.coefficients[i];
    }
    fr.avgCount++;
    $("fringe-avg-count").textContent = fr.avgCount;
    $("fringe-btn-avg-reset").disabled = false;

    if (fr.avgCount >= 2) {
      // Reanalyze with averaged coefficients
      setStatus(`Averaging (${fr.avgCount})...`);
      const avgCoeffs = Array.from(fr.avgCoefficients).map(c => c / fr.avgCount);
      const r2 = await apiFetch("/fringe/reanalyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          coefficients: avgCoeffs,
          subtract_terms: getSubtractTerms(),
          wavelength_nm: getWavelength(),
          surface_height: fr.avgSurfaceHeight,
          surface_width: fr.avgSurfaceWidth,
        }),
      });
      if (r2.ok) {
        const avgData = await r2.json();
        fr.lastResult.surface_map = avgData.surface_map;
        fr.lastResult.zernike_chart = avgData.zernike_chart;
        fr.lastResult.profile_x = avgData.profile_x;
        fr.lastResult.profile_y = avgData.profile_y;
        fr.lastResult.pv_nm = avgData.pv_nm;
        fr.lastResult.rms_nm = avgData.rms_nm;
        fr.lastResult.pv_waves = avgData.pv_waves;
        fr.lastResult.rms_waves = avgData.rms_waves;
        fr.lastResult.subtracted_terms = avgData.subtracted_terms;
        fr.lastResult.coefficients = avgCoeffs;
        if (avgData.strehl !== undefined) fr.lastResult.strehl = avgData.strehl;
        if (avgData.psf) fr.lastResult.psf = avgData.psf;
        if (avgData.mtf) fr.lastResult.mtf = avgData.mtf;
      }
    }
    renderResults(fr.lastResult);
    resetStatus();
  } catch (e) {
    console.warn("Average error:", e);
    setStatus("Error");
    setTimeout(resetStatus, 2000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function resetAverage() {
  fr.avgCoefficients = null;
  fr.avgCount = 0;
  $("fringe-avg-count").textContent = "0";
  $("fringe-btn-avg-reset").disabled = true;
  if (fr.lastResult) renderResults(fr.lastResult);
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
        surface_height: fr.lastResult.surface_height || 128,
        surface_width: fr.lastResult.surface_width || 128,
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
    if (data.strehl !== undefined) fr.lastResult.strehl = data.strehl;
    if (data.psf) fr.lastResult.psf = data.psf;
    if (data.mtf) fr.lastResult.mtf = data.mtf;
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
  const strehlEl = $("fringe-strehl");
  if (strehlEl) strehlEl.textContent = Number.isFinite(data.strehl) ? data.strehl.toFixed(3) : "--";

  // Standard pass/fail coloring
  const stdSel = $("fringe-standard");
  const pvEl = $("fringe-pv-nm");
  const pvWavesEl = $("fringe-pv-waves");
  if (stdSel && pvEl && stdSel.value) {
    const opt = stdSel.selectedOptions[0];
    const limit = parseFloat(opt.dataset.pvNm);
    if (Number.isFinite(limit) && Number.isFinite(data.pv_nm)) {
      const pass = data.pv_nm <= limit;
      const color = pass ? "#4caf50" : "#f44336";
      pvEl.style.color = color;
      pvWavesEl.style.color = color;
    }
  } else if (pvEl) {
    pvEl.style.color = "";
    if (pvWavesEl) pvWavesEl.style.color = "";
  }

  // Wavelength and subtracted terms in summary bar
  const wlEl = $("fringe-summary-wl");
  if (wlEl) wlEl.textContent = getWavelength() + " nm";
  const subEl = $("fringe-summary-sub");
  if (subEl) {
    const sub = getSubtractTerms();
    const names = [];
    if (sub.includes(2)) names.push("Tilt");
    if (sub.includes(4)) names.push("Power");
    if (sub.includes(5)) names.push("Astig");
    if (sub.includes(7)) names.push("Coma");
    if (sub.includes(11)) names.push("Sph");
    subEl.textContent = names.length ? names.join(", ") + " subtracted" : "None subtracted";
  }

  // Cache height grid for measurements
  if (data.height_grid) {
    fr.heightGrid = new Float32Array(data.height_grid);
    fr.maskGrid = new Uint8Array(data.mask_grid);
    fr.gridRows = data.grid_rows;
    fr.gridCols = data.grid_cols;
  }

  // Surface map
  const surfaceContent = $("fringe-surface-content");
  const empty = $("fringe-empty");
  if (surfaceContent && data.surface_map) {
    surfaceContent.hidden = false;
    if (empty) empty.hidden = true;
    const surfImg = $("fringe-surface-img");
    surfImg.onload = () => drawPeakValleyMarkers();
    surfImg.src = "data:image/png;base64," + data.surface_map;
  }

  // Zernike chart
  const zernikeContent = $("fringe-zernike-content");
  const zernikeEmpty = $("fringe-zernike-empty");
  if (zernikeContent && data.zernike_chart) {
    zernikeContent.hidden = false;
    if (zernikeEmpty) zernikeEmpty.hidden = true;
    $("fringe-zernike-chart").src = "data:image/png;base64," + data.zernike_chart;

    // Build Zernike coefficient table
    const tableContainer = $("fringe-zernike-table-container");
    if (tableContainer && fr.lastResult) {
      const coeffs = fr.lastResult.coefficients || [];
      const names = fr.lastResult.coefficient_names || {};
      const subtracted = new Set((fr.lastResult.subtracted_terms || []).map(Number));
      const wl = fr.lastResult.wavelength_nm || 632.8;

      if (coeffs.length > 0) {
        // Find dominant term (largest |coeff| among non-subtracted)
        let dominantIdx = -1;
        let dominantAbs = 0;
        for (let i = 0; i < coeffs.length; i++) {
          const noll = i + 1;
          if (!subtracted.has(noll) && Math.abs(coeffs[i]) > dominantAbs) {
            dominantAbs = Math.abs(coeffs[i]);
            dominantIdx = i;
          }
        }

        let html = "<table><thead><tr><th>#</th><th>Term</th><th>Coeff (rad)</th><th>Surface (nm)</th></tr></thead><tbody>";
        for (let i = 0; i < coeffs.length; i++) {
          const noll = i + 1;
          const coeff = coeffs[i];
          const name = names[String(noll)] || ("Z" + noll);
          const surfNm = coeff * wl / (4 * Math.PI);
          const isSub = subtracted.has(noll);
          const isDom = i === dominantIdx;
          let cls = "";
          if (isSub) cls = "fringe-z-subtracted";
          else if (isDom) cls = "fringe-z-dominant";
          html += '<tr class="' + cls + '">'
            + "<td>" + noll + "</td>"
            + "<td>" + name + (isSub ? " <span style='font-size:10px'>(sub)</span>" : "") + "</td>"
            + "<td>" + coeff.toFixed(3) + "</td>"
            + "<td>" + surfNm.toFixed(1) + "</td>"
            + "</tr>";
        }
        html += "</tbody></table>";
        tableContainer.innerHTML = html;
      } else {
        tableContainer.innerHTML = "";
      }
    }
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

  // PSF / MTF
  const psfContent = $("fringe-psf-content");
  const psfEmpty = $("fringe-psf-empty");
  if (psfContent && data.psf) {
    psfContent.hidden = false;
    if (psfEmpty) psfEmpty.hidden = true;
    $("fringe-psf-img").src = "data:image/png;base64," + data.psf;
    if (data.mtf) {
      drawMtfChart(data.mtf);
    }
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

  let vMin = Infinity, vMax = -Infinity;
  for (const v of values) { if (v < vMin) vMin = v; if (v > vMax) vMax = v; }
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

function drawMtfChart(mtfData) {
  const canvas = $("fringe-mtf-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const pad = { top: 20, right: 20, bottom: 35, left: 45 };
  const pw = W - pad.left - pad.right;
  const ph = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ph * (1 - i / 4);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + pw, y); ctx.stroke();
  }

  // Axes labels
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Normalized spatial frequency", pad.left + pw / 2, H - 5);
  ctx.save();
  ctx.translate(12, pad.top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Contrast", 0, 0);
  ctx.restore();

  // Y-axis tick labels
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ph * (1 - i / 4);
    ctx.fillText((i * 0.25).toFixed(2), pad.left - 4, y + 3);
  }

  // X-axis tick labels
  ctx.textAlign = "center";
  for (let i = 0; i <= 4; i++) {
    const x = pad.left + pw * i / 4;
    ctx.fillText((i * 0.25).toFixed(2), x, pad.top + ph + 15);
  }

  const n = mtfData.freq.length;

  // Diffraction limit (dashed, white)
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = pad.left + mtfData.freq[i] * pw;
    const y = pad.top + ph * (1 - mtfData.mtf_diff[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Measured MTF (solid, colored)
  ctx.strokeStyle = "#4fc3f7";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = pad.left + mtfData.freq[i] * pw;
    const y = pad.top + ph * (1 - mtfData.mtf[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Legend
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#4fc3f7";
  ctx.fillText("Measured", pad.left + pw - 60, pad.top + 12);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fillText("Diffraction limit", pad.left + pw - 60, pad.top + 24);
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

  // Use actual height grid data (not profile approximation)
  if (!fr.heightGrid || !fr.maskGrid) return;

  const gridSize = 128;
  const sw = fr.lastResult.surface_width || 1;
  const sh = fr.lastResult.surface_height || 1;
  const aspect = sw / sh;
  const planeW = aspect >= 1 ? 2 : 2 * aspect;
  const planeH = aspect >= 1 ? 2 / aspect : 2;
  const geo = new THREE.PlaneGeometry(planeW, planeH, gridSize - 1, gridSize - 1);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  const zSlider = $("fringe-3d-z-scale");
  const zLabel = $("fringe-3d-z-val");
  let zScale = zSlider ? parseFloat(zSlider.value) : 10;

  function applyZ() {
    let zMin = Infinity, zMax = -Infinity;
    const zVals = new Float32Array(gridSize * gridSize);
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        // Sample from height grid
        const gx = (c / (gridSize - 1)) * (fr.gridCols - 1);
        const gy = (r / (gridSize - 1)) * (fr.gridRows - 1);
        const gi = Math.round(gy) * fr.gridCols + Math.round(gx);
        const z = fr.maskGrid[gi] ? fr.heightGrid[gi] : 0;
        zVals[r * gridSize + c] = z;
        if (fr.maskGrid[gi]) {
          if (z < zMin) zMin = z;
          if (z > zMax) zMax = z;
        }
      }
    }
    if (!isFinite(zMin)) { zMin = 0; zMax = 1; }
    const zRange = zMax - zMin || 1;
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        const idx = r * gridSize + c;
        const z = zVals[idx];
        const zNorm = ((z - zMin) / zRange - 0.5) * zScale * 0.01;
        pos.setZ(idx, zNorm);
        // Blue-white-red colormap
        const t = (z - zMin) / zRange;
        colors[idx * 3]     = t < 0.5 ? 0.3 + t * 1.4 : 1.0;
        colors[idx * 3 + 1] = t < 0.5 ? 0.3 + t * 1.4 : 1.0 - (t - 0.5) * 1.4;
        colors[idx * 3 + 2] = t < 0.5 ? 1.0 : 1.0 - (t - 0.5) * 1.4;
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

  camera.position.set(0, -1.8, 2.2);
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

// ── Wavefront inversion ─────────────────────────────────────────────────

async function invertWavefront() {
  if (!fr.lastResult || !fr.lastResult.coefficients) return;
  // Negate all coefficients
  const inverted = fr.lastResult.coefficients.map(c => -c);
  fr.lastResult.coefficients = inverted;

  // If averaging, also negate the accumulated coefficients
  if (fr.avgCoefficients) {
    for (let i = 0; i < fr.avgCoefficients.length; i++) {
      fr.avgCoefficients[i] = -fr.avgCoefficients[i];
    }
  }

  // Reanalyze with inverted coefficients
  try {
    const r = await apiFetch("/fringe/reanalyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coefficients: inverted,
        subtract_terms: getSubtractTerms(),
        wavelength_nm: getWavelength(),
        surface_height: fr.lastResult.surface_height || 128,
        surface_width: fr.lastResult.surface_width || 128,
      }),
    });
    if (!r.ok) return;
    const data = await r.json();
    // Merge results
    fr.lastResult.surface_map = data.surface_map;
    fr.lastResult.zernike_chart = data.zernike_chart;
    fr.lastResult.profile_x = data.profile_x;
    fr.lastResult.profile_y = data.profile_y;
    fr.lastResult.pv_nm = data.pv_nm;
    fr.lastResult.rms_nm = data.rms_nm;
    fr.lastResult.pv_waves = data.pv_waves;
    fr.lastResult.rms_waves = data.rms_waves;
    fr.lastResult.subtracted_terms = data.subtracted_terms;
    if (data.strehl !== undefined) fr.lastResult.strehl = data.strehl;
    if (data.psf) fr.lastResult.psf = data.psf;
    if (data.mtf) fr.lastResult.mtf = data.mtf;
    renderResults(fr.lastResult);
  } catch (e) {
    console.warn("Invert error:", e);
  }
}

// ── Export (CSV + PDF) ──────────────────────────────────────────────────

function exportFringeCsv() {
  if (!fr.lastResult) return;
  const coeffs = fr.lastResult.coefficients;
  const names = fr.lastResult.coefficient_names || {};
  const wl = fr.lastResult.wavelength_nm || 632.8;
  const sub = fr.lastResult.subtracted_terms || [];

  let csv = "Index,Name,Coefficient (rad),Surface Error (nm),Subtracted\n";
  for (let i = 0; i < coeffs.length; i++) {
    const j = i + 1;
    const name = names[String(j)] || `Z${j}`;
    const nm = (coeffs[i] * wl / (4 * Math.PI)).toFixed(2);
    const subtracted = sub.includes(j) ? "yes" : "no";
    csv += `${j},"${name}",${coeffs[i].toFixed(6)},${nm},${subtracted}\n`;
  }

  // Add summary
  csv += `\nSummary\n`;
  csv += `PV (nm),${fr.lastResult.pv_nm?.toFixed(1)}\n`;
  csv += `RMS (nm),${fr.lastResult.rms_nm?.toFixed(1)}\n`;
  csv += `PV (waves),${fr.lastResult.pv_waves?.toFixed(4)}\n`;
  csv += `RMS (waves),${fr.lastResult.rms_waves?.toFixed(4)}\n`;
  csv += `Strehl,${fr.lastResult.strehl?.toFixed(4)}\n`;
  csv += `Wavelength (nm),${wl}\n`;

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `fringe_zernike_${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportFringePdf() {
  if (!fr.lastResult) return;
  const { jsPDF } = window.jspdf;
  if (!jsPDF) { alert("PDF library not loaded"); return; }

  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = 297;
  const pageH = 210;
  const margin = 10;
  const data = fr.lastResult;

  // Header
  doc.setFontSize(16);
  doc.text("Fringe Analysis Report", margin, margin + 7);
  doc.setFontSize(9);
  doc.setTextColor(100);
  const ts = new Date().toLocaleString();
  doc.text(`Exported: ${ts}   Wavelength: ${data.wavelength_nm} nm`, margin, margin + 13);

  // Standard
  const stdSel = $("fringe-standard");
  if (stdSel && stdSel.value) {
    const stdOpt = stdSel.selectedOptions[0];
    doc.text(`Reference: ${stdOpt.textContent}  (PV limit: ${stdOpt.dataset.pvNm} nm)`, margin, margin + 18);
  }
  doc.setTextColor(0);

  let y = margin + 24;

  // Stats box
  doc.setFontSize(11);
  const pvStr = `PV: ${data.pv_nm?.toFixed(1)} nm (${data.pv_waves?.toFixed(3)} \u03bb)`;
  const rmsStr = `RMS: ${data.rms_nm?.toFixed(1)} nm (${data.rms_waves?.toFixed(3)} \u03bb)`;
  const strehlStr = `Strehl: ${data.strehl?.toFixed(3)}`;
  doc.text(`${pvStr}     ${rmsStr}     ${strehlStr}`, margin, y);

  // Standard pass/fail
  if (stdSel && stdSel.value) {
    const limit = parseFloat(stdSel.selectedOptions[0].dataset.pvNm);
    const pass = data.pv_nm <= limit;
    doc.setTextColor(pass ? 0 : 200, pass ? 150 : 0, 0);
    doc.text(pass ? "  PASS" : "  FAIL", margin + 180, y);
    doc.setTextColor(0);
  }
  y += 8;

  // Surface map image
  if (data.surface_map) {
    try {
      const imgData = "data:image/png;base64," + data.surface_map;
      // Fit in left half of page
      const imgW = 130;
      const imgH = 100;
      doc.addImage(imgData, "PNG", margin, y, imgW, imgH);

      // PSF in the right area (smaller)
      if (data.psf) {
        const psfData = "data:image/png;base64," + data.psf;
        doc.setFontSize(8);
        doc.text("PSF", margin + imgW + 10, y);
        doc.addImage(psfData, "PNG", margin + imgW + 10, y + 3, 50, 50);
      }

      y += imgH + 5;
    } catch (e) {
      console.warn("PDF image error:", e);
    }
  }

  // Zernike chart
  if (data.zernike_chart && y + 60 < pageH - margin) {
    try {
      const chartData = "data:image/png;base64," + data.zernike_chart;
      const chartW = pageW - margin * 2;
      const chartH = 55;
      doc.addImage(chartData, "PNG", margin, y, chartW, chartH);
      y += chartH + 5;
    } catch (e) {
      console.warn("PDF chart error:", e);
    }
  }

  // If we need a second page for the Zernike table
  if (y + 10 > pageH - margin) {
    doc.addPage();
    y = margin + 7;
  }

  // Zernike coefficient table
  doc.setFontSize(10);
  doc.text("Zernike Coefficients", margin, y);
  y += 5;
  doc.setFontSize(7);

  const coeffs = data.coefficients || [];
  const names = data.coefficient_names || {};
  const sub = data.subtracted_terms || [];
  const wl = data.wavelength_nm || 632.8;

  // Table header
  doc.setFont(undefined, "bold");
  doc.text("#", margin, y);
  doc.text("Term", margin + 8, y);
  doc.text("Coeff (rad)", margin + 50, y);
  doc.text("Surface (nm)", margin + 80, y);
  doc.text("Status", margin + 110, y);
  doc.setFont(undefined, "normal");
  y += 4;

  // Only show terms with |coeff| > 0.001 to keep it concise
  for (let i = 0; i < Math.min(coeffs.length, 36); i++) {
    if (Math.abs(coeffs[i]) < 0.001) continue;
    if (y + 4 > pageH - margin) {
      doc.addPage();
      y = margin + 7;
    }
    const j = i + 1;
    const name = names[String(j)] || `Z${j}`;
    const nm = (coeffs[i] * wl / (4 * Math.PI)).toFixed(1);
    const status = sub.includes(j) ? "(subtracted)" : "";
    if (sub.includes(j)) doc.setTextColor(150);
    doc.text(String(j), margin, y);
    doc.text(name, margin + 8, y);
    doc.text(coeffs[i].toFixed(4), margin + 50, y);
    doc.text(nm, margin + 80, y);
    doc.text(status, margin + 110, y);
    doc.setTextColor(0);
    y += 3.5;
  }

  // Save
  const filename = `fringe_report_${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.pdf`;
  doc.save(filename);
}

// ── Public init ─────────────────────────────────────────────────────────

export function initFringe() {
  buildWorkspace();
  loadWavelengthPresets();   // async — overrides defaults from config.json

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
