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
  roi: null,         // {x, y, w, h} in image coordinates (0-1 normalized)
  roiDrawing: false,  // currently drawing?
  roiStart: null,     // {x, y} in normalized coords
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
          <button class="detect-btn" id="fringe-btn-roi" style="padding:4px 10px;font-size:11px;flex:1">
            Draw ROI
          </button>
          <button class="detect-btn" id="fringe-btn-roi-clear" style="padding:4px 10px;font-size:11px;opacity:0.6" disabled>
            Clear ROI
          </button>
        </div>
        <div id="fringe-roi-hint" style="font-size:10px;opacity:0.5;text-align:center" hidden>
          Click two corners on the enlarged preview to select the analysis region
        </div>

        <div class="fringe-drop-zone" id="fringe-drop-zone">
          <span style="opacity:0.5;font-size:12px">or drag &amp; drop an image</span>
        </div>

        <div class="fringe-setting-group" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
          <div style="font-size:12px;font-weight:600;opacity:0.7">Settings</div>
          <label>Wavelength
            <select id="fringe-wavelength">
              <option value="sodium" selected>Sodium (589 nm)</option>
              <option value="hene">HeNe (632.8 nm)</option>
              <option value="green">Green LED (532 nm)</option>
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
            Freeze a frame or drop an interferogram image to analyze.
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

  // Analyze button
  $("fringe-btn-analyze")?.addEventListener("click", analyzeFromCamera);

  // Averaging buttons
  $("fringe-btn-avg-add")?.addEventListener("click", addToAverage);
  $("fringe-btn-avg-reset")?.addEventListener("click", resetAverage);

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
    if (fr.roiDrawing) { exitRoiDrawMode(); return; }
    const overlay = $("fringe-enlarge-overlay");
    if (overlay) overlay.hidden = true;
  });
  $("fringe-enlarge-overlay")?.addEventListener("click", (e) => {
    if (fr.roiDrawing) return; // don't close during ROI drawing
    if (e.target === e.currentTarget) {
      e.currentTarget.hidden = true;
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (fr.roiDrawing) { exitRoiDrawMode(); return; }
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

  // ROI drawing — opens enlarge overlay, click two corners to define rectangle
  const roiBtn = $("fringe-btn-roi");
  const roiClearBtn = $("fringe-btn-roi-clear");
  const roiHint = $("fringe-roi-hint");

  if (roiBtn) {
    roiBtn.addEventListener("click", () => {
      if (fr.roiDrawing) {
        exitRoiDrawMode();
      } else {
        enterRoiDrawMode();
      }
    });
  }

  if (roiClearBtn) {
    roiClearBtn.addEventListener("click", () => {
      fr.roi = null;
      roiClearBtn.disabled = true;
      roiClearBtn.style.opacity = "0.6";
      drawRoiOverlay();
    });
  }

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
  return WAVELENGTHS[sel.value]?.nm || 589.0;
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

function drawRoiOverlay(tempRoi) {
  const canvas = $("fringe-roi-canvas");
  const img = $("fringe-preview");
  if (!canvas || !img) return;
  canvas.width = img.clientWidth;
  canvas.height = img.clientHeight;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const roi = tempRoi || fr.roi;
  if (!roi) return;
  const x = roi.x * canvas.width;
  const y = roi.y * canvas.height;
  const w = roi.w * canvas.width;
  const h = roi.h * canvas.height;
  // Dim everything outside ROI
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.clearRect(x, y, w, h);
  // Draw ROI border
  ctx.strokeStyle = "#0a84ff";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
}

// ── ROI draw mode (enlarge overlay + click-to-place corners) ────────────

function enterRoiDrawMode() {
  fr.roiDrawing = true;
  fr.roiStart = null;
  const roiBtn = $("fringe-btn-roi");
  const roiHint = $("fringe-roi-hint");
  if (roiBtn) { roiBtn.textContent = "Cancel"; roiBtn.style.background = "var(--accent)"; }
  if (roiHint) roiHint.hidden = false;

  // Open the enlarge overlay with a drawing canvas on top
  const overlay = $("fringe-enlarge-overlay");
  const enlargeImg = $("fringe-enlarge-img");
  const preview = $("fringe-preview");
  if (!overlay || !enlargeImg || !preview) return;

  enlargeImg.src = preview.src;
  overlay.hidden = false;

  // Create or reuse the ROI drawing canvas on the enlarge overlay
  let roiCanvas = $("fringe-enlarge-roi-canvas");
  if (!roiCanvas) {
    roiCanvas = document.createElement("canvas");
    roiCanvas.id = "fringe-enlarge-roi-canvas";
    roiCanvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;cursor:crosshair;z-index:10";
    overlay.appendChild(roiCanvas);
  }
  roiCanvas.style.pointerEvents = "auto";

  // Wait for image to load so we can size the canvas over the image
  const setupCanvas = () => {
    const imgRect = enlargeImg.getBoundingClientRect();
    roiCanvas.width = imgRect.width;
    roiCanvas.height = imgRect.height;
    roiCanvas.style.left = imgRect.left + "px";
    roiCanvas.style.top = imgRect.top + "px";
    roiCanvas.style.width = imgRect.width + "px";
    roiCanvas.style.height = imgRect.height + "px";
    roiCanvas.style.position = "fixed";
    drawEnlargeRoiOverlay(roiCanvas, null);
  };
  if (enlargeImg.complete && enlargeImg.naturalWidth > 0) {
    // Use rAF to ensure layout is settled after overlay becomes visible
    requestAnimationFrame(setupCanvas);
  } else {
    enlargeImg.onload = () => requestAnimationFrame(setupCanvas);
  }

  // Click handler — first click = corner 1, second click = corner 2
  const handleClick = (e) => {
    const rect = roiCanvas.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    if (!fr.roiStart) {
      // First corner
      fr.roiStart = { x: nx, y: ny };
      drawEnlargeRoiOverlay(roiCanvas, null);
      // Draw the first point marker
      const ctx = roiCanvas.getContext("2d");
      ctx.fillStyle = "#0a84ff";
      ctx.beginPath();
      ctx.arc(nx * roiCanvas.width, ny * roiCanvas.height, 5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Second corner — finalize ROI
      const roi = {
        x: Math.min(fr.roiStart.x, nx),
        y: Math.min(fr.roiStart.y, ny),
        w: Math.abs(nx - fr.roiStart.x),
        h: Math.abs(ny - fr.roiStart.y),
      };
      if (roi.w > 0.02 && roi.h > 0.02) {
        fr.roi = roi;
        const roiClearBtn = $("fringe-btn-roi-clear");
        if (roiClearBtn) { roiClearBtn.disabled = false; roiClearBtn.style.opacity = "1"; }
      }
      roiCanvas.removeEventListener("click", handleClick);
      roiCanvas.removeEventListener("mousemove", handleMove);
      exitRoiDrawMode();
    }
  };

  // Mousemove handler — show rectangle preview after first corner placed
  const handleMove = (e) => {
    if (!fr.roiStart) return;
    const rect = roiCanvas.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    drawEnlargeRoiOverlay(roiCanvas, {
      x: Math.min(fr.roiStart.x, nx),
      y: Math.min(fr.roiStart.y, ny),
      w: Math.abs(nx - fr.roiStart.x),
      h: Math.abs(ny - fr.roiStart.y),
    });
  };

  roiCanvas.addEventListener("click", handleClick);
  roiCanvas.addEventListener("mousemove", handleMove);

  // Store cleanup refs so exitRoiDrawMode can remove them
  fr._roiCleanup = () => {
    roiCanvas.removeEventListener("click", handleClick);
    roiCanvas.removeEventListener("mousemove", handleMove);
    roiCanvas.style.pointerEvents = "none";
    const ctx = roiCanvas.getContext("2d");
    ctx.clearRect(0, 0, roiCanvas.width, roiCanvas.height);
  };
}

function exitRoiDrawMode() {
  fr.roiDrawing = false;
  fr.roiStart = null;
  const roiBtn = $("fringe-btn-roi");
  const roiHint = $("fringe-roi-hint");
  if (roiBtn) { roiBtn.textContent = "Draw ROI"; roiBtn.style.background = ""; }
  if (roiHint) roiHint.hidden = true;
  if (fr._roiCleanup) { fr._roiCleanup(); fr._roiCleanup = null; }
  // Close the enlarge overlay
  const overlay = $("fringe-enlarge-overlay");
  if (overlay) overlay.hidden = true;
  // Update the small preview ROI overlay
  drawRoiOverlay();
}

function drawEnlargeRoiOverlay(canvas, tempRoi) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const roi = tempRoi;
  if (!roi) return;
  const x = roi.x * canvas.width;
  const y = roi.y * canvas.height;
  const w = roi.w * canvas.width;
  const h = roi.h * canvas.height;
  // Dim everything outside
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.clearRect(x, y, w, h);
  // Draw border
  ctx.strokeStyle = "#0a84ff";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  // Draw corner markers
  ctx.fillStyle = "#0a84ff";
  for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
  }
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
      roi: fr.roi || undefined,
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
        roi: fr.roi || undefined,
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
        roi: fr.roi || undefined,
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
