// zstack.js — Manual Z-stack (depth-from-focus) workflow UI.
//
// Mirrors the Keyence VHX-900 "3D" workflow: the user manually advances
// the Z axis by a fixed amount between captures, collects 3-15+ frames,
// then the backend builds an all-in-focus composite and a colourised
// height map.  The composite can optionally replace the current frozen
// background so normal measurement tools operate on a sharp image.

import { apiFetch } from './api.js';
import { state } from './state.js';
import { img, showStatus, resizeCanvas } from './render.js';
import { setImageSize, viewport } from './viewport.js';
import { cacheImageData } from './subpixel-js.js';
import { updateFreezeUI } from './sidebar.js';
import { openZstack3dView } from './zstack-3d.js';

// Local UI state (scoped — does NOT touch core `state`)
const zs = {
  sessionId: null,
  frameCount: 0,
  zStepMm: 0.05,
  suggestedMin: 10,
  suggestedMax: 15,
  computed: null, // { compositeUrl, heightmapUrl, minZ, maxZ, width, height }
  hdrSupported: false,
  hdrEnabled: false,
  hdrStops: [-2.0, 0.0, 2.0],
  fusionMode: "pyramid", // "argmax" | "pyramid"
  profile: {
    active: false,    // "click two points" mode
    p0: null,         // {x, y} in full-res image px
    p1: null,
    data: null,       // last /zstack/profile response
    markerA: 0.25,
    markerB: 0.75,
    dragging: null,   // "A" | "B" | null
  },
  area: {
    active: false,    // rect-draw mode
    drawing: false,
    p0: null,         // {x, y} in full-res image px
    p1: null,
    data: null,       // last /zstack/area-roughness response
  },
  calibZ: {
    active: false,
    p0: null,
    p1: null,
  },
  zScale: 1.0,
  noiseFloor: null,  // { Sq_noise, pv_noise } — persists across reset
};

function $(id) { return document.getElementById(id); }

function buildDialog() {
  if ($("zstack-dialog")) return;

  const dlg = document.createElement("div");
  dlg.id = "zstack-dialog";
  dlg.className = "dialog-overlay";
  dlg.hidden = true;
  dlg.innerHTML = `
    <div class="dialog-content" style="max-width:960px;width:92vw">
      <div class="dialog-header">
        <span class="dialog-title">3D Z-Stack (Depth-from-Focus)</span>
        <button class="dialog-close" id="btn-zstack-close">✕</button>
      </div>
      <div style="padding:14px 18px;flex:1;min-height:0;overflow-y:auto">
        <p style="margin:0 0 10px;opacity:0.85;font-size:13px">
          Manually advance the Z axis by a fixed amount between captures,
          just like the Keyence VHX "3D" mode. Collect 10–15 frames for
          best results, then build the height map.
          <span style="opacity:0.7">Tip: press <kbd style="font-family:inherit;padding:1px 5px;border:1px solid #555;border-radius:3px;background:#222">Space</kbd> to capture.</span>
        </p>

        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
          <label style="font-size:13px">Z step (mm):</label>
          <input type="number" id="zstack-step" step="0.001" min="0.001" value="0.05"
                 style="width:100px" />
          <label style="font-size:13px;margin-left:12px">Fusion:</label>
          <select id="zstack-fusion" style="padding:3px 6px;background:#1a1a1a;color:#eee;border:1px solid #444;border-radius:3px">
            <option value="pyramid" selected>Pyramid (preserves more detail)</option>
            <option value="argmax">Argmax (per-pixel best-focus)</option>
          </select>
          <span id="zstack-instruction" style="opacity:0.8;font-size:12px"></span>
        </div>

        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;padding:6px 8px;background:#161616;border:1px solid #2a2a2a;border-radius:3px">
          <label style="font-size:13px;display:flex;align-items:center;gap:6px;cursor:pointer" id="zstack-hdr-label">
            <input type="checkbox" id="zstack-hdr-toggle" />
            HDR bracket (−2 / 0 / +2 EV)
          </label>
          <span id="zstack-hdr-note" style="opacity:0.7;font-size:11px">
            Captures 3 exposures per slice and fuses them — ~0.5 s slower per frame.
          </span>
        </div>

        <div style="display:flex;gap:8px;margin-bottom:6px;flex-shrink:0">
          <button class="detect-btn" id="btn-zstack-capture" style="flex-shrink:0;min-width:150px">Capture frame</button>
          <button class="detect-btn" id="btn-zstack-compute" style="flex-shrink:0;min-width:160px" disabled>Build height map</button>
          <button class="detect-btn" id="btn-zstack-reset" style="flex-shrink:0;min-width:80px">Reset</button>
        </div>
        <div id="zstack-count" style="opacity:0.85;font-size:12px;margin-bottom:8px">0 / suggested 10–15</div>

        <div id="zstack-thumbs" style="display:flex;flex-wrap:wrap;gap:4px;max-height:160px;overflow-y:auto;margin-bottom:10px;padding:4px;background:#0f0f0f;border:1px solid #2a2a2a;border-radius:3px"></div>

        <div id="zstack-result" hidden>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px">
            <div style="flex:1;min-width:260px">
              <div style="font-size:12px;opacity:0.85;margin-bottom:4px">All-in-focus composite</div>
              <img id="zstack-composite-img" style="width:100%;border:1px solid #444;background:#111" />
              <a id="zstack-composite-dl" download="zstack-composite.png" class="detect-btn" style="display:inline-block;margin-top:6px;text-decoration:none">Download PNG</a>
            </div>
            <div style="flex:1;min-width:260px">
              <div style="font-size:12px;opacity:0.85;margin-bottom:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span>Height map (<span id="zstack-zrange">—</span>)</span>
                <label style="margin-left:auto">Level:
                  <select id="zstack-detrend" style="padding:2px 5px;background:#1a1a1a;color:#eee;border:1px solid #444;border-radius:3px">
                    <option value="none" selected>None</option>
                    <option value="plane">Plane</option>
                    <option value="poly2">Poly² (removes lens curvature)</option>
                  </select>
                </label>
              </div>
              <div id="zstack-heightmap-wrap" style="position:relative;line-height:0">
                <img id="zstack-heightmap-img" style="width:100%;border:1px solid #444;background:#111;display:block" />
                <svg id="zstack-profile-overlay" style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none"></svg>
              </div>
              <a id="zstack-heightmap-dl" download="zstack-heightmap.png" class="detect-btn" style="display:inline-block;margin-top:6px;text-decoration:none">Download PNG</a>
            </div>
          </div>

          <div style="margin-top:12px;padding:8px 10px;background:#161616;border:1px solid #2a2a2a;border-radius:3px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
              <strong style="font-size:12px">Profile &amp; Roughness</strong>
              <button class="detect-btn" id="btn-zstack-profile-draw" style="margin-left:8px">Draw profile</button>
              <button class="detect-btn" id="btn-zstack-area-draw">Measure area</button>
              <button class="detect-btn" id="btn-zstack-calib-z">Calibrate Z</button>
              <button class="detect-btn" id="btn-zstack-noise-ref">Set noise ref</button>
              <button class="detect-btn" id="btn-zstack-profile-clear">Clear</button>
              <span id="zstack-zscale-readout" style="margin-left:8px;font-size:11px;font-variant-numeric:tabular-nums">Z scale: 1.00×</span>
              <button class="detect-btn" id="btn-zstack-zscale-reset" style="padding:2px 6px;font-size:11px" hidden>Reset</button>
              <span id="zstack-noise-readout" style="font-size:11px;opacity:0.75"></span>
              <span id="zstack-profile-status" style="opacity:0.75;font-size:11px"></span>
            </div>
            <div id="zstack-cal-warning" hidden style="margin-bottom:8px;padding:6px 10px;background:#3a2a0a;border:1px solid #8a6a1a;border-radius:3px;font-size:11px;color:#fbbf24;line-height:1.4">
              <strong>Pixel calibration required.</strong> Surface roughness needs a set calibration to report values in real units and for the ISO 25178-3 S/L filters to work. Close this dialog and calibrate via <em>Setup &rarr; Calibrate</em> before using the roughness tools.
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
              <label style="font-size:11px">Noise comp:</label>
              <select id="zstack-noise-comp" style="font-size:11px" title="Subtract noise floor from roughness values (quadrature: Rq_corr = √(Rq² − Sq_noise²))">
                <option value="off">Off</option>
                <option value="quadrature">Quadrature</option>
              </select>
              <label style="font-size:11px">S-filter (mm):</label>
              <input type="number" id="zstack-s-filter" step="0.001" min="0" value="0" style="width:70px;font-size:11px" title="ISO 25178-3 S-filter cutoff — removes short-wavelength noise" />
              <label style="font-size:11px;margin-left:6px">L-filter (mm):</label>
              <input type="number" id="zstack-l-filter" step="0.01" min="0" value="0" style="width:70px;font-size:11px" title="ISO 25178-3 L-filter cutoff — removes long-wavelength waviness (typical: 0.8mm)" />
              <span style="font-size:10px;opacity:0.6">(ISO 25178-3 Gaussian, typical L = 0.8mm)</span>
            </div>
            <div id="zstack-profile-section" hidden>
              <canvas id="zstack-profile-chart" style="width:100%;height:200px;background:#0b0b0b;border:1px solid #333;display:block"></canvas>
              <div id="zstack-profile-readout" style="margin-top:6px;font-size:12px;opacity:0.9;font-variant-numeric:tabular-nums"></div>
              <div id="zstack-roughness-full" style="margin-top:4px;font-size:12px;opacity:0.9;font-variant-numeric:tabular-nums"></div>
              <div id="zstack-roughness-range" style="margin-top:2px;font-size:12px;opacity:0.9;font-variant-numeric:tabular-nums"></div>
              <div id="zstack-roughness-area" style="margin-top:4px;font-size:12px;opacity:0.9;font-variant-numeric:tabular-nums"></div>
              <div id="zstack-lateral-res" style="margin-top:2px;font-size:11px;opacity:0.7"></div>
              <div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap">
                <div style="flex:1;min-width:200px">
                  <div style="font-size:11px;opacity:0.7;margin-bottom:3px">Bearing ratio (Abbott-Firestone)</div>
                  <canvas id="zstack-bearing-chart" style="width:100%;height:140px;background:#0b0b0b;border:1px solid #333;display:block"></canvas>
                  <div id="zstack-bearing-readout" style="margin-top:3px;font-size:11px;opacity:0.8;font-variant-numeric:tabular-nums"></div>
                </div>
                <div style="flex:1;min-width:200px">
                  <div style="font-size:11px;opacity:0.7;margin-bottom:3px">Power spectral density</div>
                  <canvas id="zstack-psd-chart" style="width:100%;height:140px;background:#0b0b0b;border:1px solid #333;display:block"></canvas>
                </div>
              </div>
            </div>
          </div>
          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="detect-btn" id="btn-zstack-use-composite">Use composite as working image</button>
            <button class="detect-btn" id="btn-zstack-open-3d">Open 3D view</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);

  $("btn-zstack-close").addEventListener("click", closeDialog);
  $("zstack-step").addEventListener("input", e => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v > 0) {
      zs.zStepMm = v;
      updateInstruction();
    }
  });
  $("btn-zstack-capture").addEventListener("click", captureFrame);
  $("zstack-hdr-toggle").addEventListener("change", e => {
    zs.hdrEnabled = !!e.target.checked;
    updateInstruction();
  });
  $("zstack-fusion").addEventListener("change", e => {
    zs.fusionMode = e.target.value === "pyramid" ? "pyramid" : "argmax";
  });
  $("btn-zstack-compute").addEventListener("click", compute);
  $("btn-zstack-reset").addEventListener("click", resetStack);
  $("btn-zstack-use-composite").addEventListener("click", useCompositeAsWorkingImage);
  $("btn-zstack-open-3d").addEventListener("click", () => { openZstack3dView(); });
  $("zstack-detrend").addEventListener("change", e => {
    if (!zs.computed) return;
    const mode = e.target.value;
    const base = "/zstack/heightmap.png";
    const url = `${base}?detrend=${encodeURIComponent(mode)}&t=${Date.now()}`;
    $("zstack-heightmap-img").src = url;
    $("zstack-heightmap-dl").href = url;
    // Re-fetch the profile against the new detrend so the chart matches.
    // Recover points from cached data if lost (dialog reopen).
    if (!zs.profile.p0 && zs.profile.data) {
      const d = zs.profile.data;
      zs.profile.p0 = { x: d.x_px[0], y: d.y_px[0] };
      zs.profile.p1 = { x: d.x_px[d.x_px.length - 1], y: d.y_px[d.y_px.length - 1] };
    }
    if (zs.profile.p0 && zs.profile.p1) fetchProfile();
    if (zs.area.p0 && zs.area.p1) fetchAreaRoughness();
  });

  // Profile controls
  $("btn-zstack-profile-draw").addEventListener("click", () => {
    if (!zs.computed) return;
    zs.area.active = false;
    zs.area.drawing = false;
    zs.profile.active = true;
    zs.profile.p0 = null;
    zs.profile.p1 = null;
    $("zstack-profile-section").hidden = false;
    $("zstack-heightmap-img").style.cursor = "crosshair";
    setProfileStatus("Click two points on the height map.");
  });
  $("btn-zstack-profile-clear").addEventListener("click", () => { clearProfile(); clearArea(); });
  $("btn-zstack-calib-z").addEventListener("click", () => {
    if (!zs.computed) return;
    zs.profile.active = false;
    zs.area.active = false;
    zs.area.drawing = false;
    zs.calibZ.active = true;
    zs.calibZ.p0 = null;
    zs.calibZ.p1 = null;
    $("zstack-heightmap-img").style.cursor = "crosshair";
    setProfileStatus("Click two points that span a known height difference.");
  });
  $("btn-zstack-zscale-reset").addEventListener("click", resetZScale);
  $("btn-zstack-noise-ref").addEventListener("click", captureNoiseReference);
  // Re-fetch profile/area when S/L filters change
  const refetchOnFilterChange = () => {
    // Use existing data's coordinates if points were lost (e.g. dialog reopen)
    if (!zs.profile.p0 && zs.profile.data) {
      const d = zs.profile.data;
      zs.profile.p0 = { x: d.x_px[0], y: d.y_px[0] };
      zs.profile.p1 = { x: d.x_px[d.x_px.length - 1], y: d.y_px[d.y_px.length - 1] };
    }
    if (zs.profile.p0 && zs.profile.p1) fetchProfile();
    if (zs.area.p0 && zs.area.p1) fetchAreaRoughness();
  };
  $("zstack-s-filter").addEventListener("change", refetchOnFilterChange);
  $("zstack-s-filter").addEventListener("input", refetchOnFilterChange);
  $("zstack-l-filter").addEventListener("change", refetchOnFilterChange);
  $("zstack-l-filter").addEventListener("input", refetchOnFilterChange);
  $("zstack-noise-comp").addEventListener("change", () => {
    // Noise compensation is display-side only — just refresh readouts
    if (zs.profile.data) updateProfileReadout();
    if (zs.area.data) updateAreaReadout();
  });
  $("btn-zstack-area-draw").addEventListener("click", () => {
    if (!zs.computed) return;
    // cancel any profile-draw mode — only one drawing mode at a time
    zs.profile.active = false;
    zs.area.active = true;
    zs.area.drawing = false;
    zs.area.p0 = null;
    zs.area.p1 = null;
    $("zstack-profile-section").hidden = false;
    $("zstack-heightmap-img").style.cursor = "crosshair";
    setProfileStatus("Drag a rectangle on the height map.");
  });

  const hmImg = $("zstack-heightmap-img");
  hmImg.addEventListener("click", onHeightmapClick);
  hmImg.addEventListener("mousedown", onHeightmapMouseDown);
  window.addEventListener("mousemove", onHeightmapMouseMove);
  window.addEventListener("mouseup", onHeightmapMouseUp);
  hmImg.addEventListener("load", () => {
    if (zs.profile.data) drawProfileOverlay();
    drawAreaOverlay();
  });
  // Re-render overlay on resize so the SVG line tracks the image.
  window.addEventListener("resize", () => {
    if (zs.profile.data) drawProfileOverlay();
    if (zs.profile.data) drawProfileChart();
    drawAreaOverlay();
  });

  const chart = $("zstack-profile-chart");
  chart.addEventListener("mousedown", onChartMouseDown);
  window.addEventListener("mousemove", onChartMouseMove);
  window.addEventListener("mouseup", onChartMouseUp);

  updateCalibrationWarning();
}

// Show the calibration warning banner + disable the S/L filter inputs
// when pixel calibration is missing. Without calibration the backend
// skips the filter branch entirely (it requires spacing_mm > 0), which
// previously caused the spinners to silently do nothing.
function updateCalibrationWarning() {
  const hasCal = !!(state.calibration && state.calibration.pixelsPerMm > 0);
  const warn = $("zstack-cal-warning");
  if (warn) warn.hidden = hasCal;
  const sFilter = $("zstack-s-filter");
  const lFilter = $("zstack-l-filter");
  if (sFilter) sFilter.disabled = !hasCal;
  if (lFilter) lFilter.disabled = !hasCal;
}

function setProfileStatus(msg) {
  const el = $("zstack-profile-status");
  if (el) el.textContent = msg || "";
}

function clearProfile() {
  zs.profile.active = false;
  zs.profile.p0 = null;
  zs.profile.p1 = null;
  zs.profile.data = null;
  zs.profile.markerA = 0.25;
  zs.profile.markerB = 0.75;
  const section = $("zstack-profile-section");
  if (section) section.hidden = true;
  const img = $("zstack-heightmap-img");
  if (img) img.style.cursor = "";
  const svg = $("zstack-profile-overlay");
  if (svg) svg.innerHTML = "";
  setProfileStatus("");
  const readout = $("zstack-profile-readout");
  if (readout) readout.textContent = "";
  const full = $("zstack-roughness-full");
  if (full) full.textContent = "";
  const rng = $("zstack-roughness-range");
  if (rng) rng.textContent = "";
  drawAreaOverlay();
}

function onHeightmapClick(e) {
  if (!zs.computed) return;
  const img = e.currentTarget;
  const rect = img.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const scaleX = zs.computed.width / rect.width;
  const scaleY = zs.computed.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;
  if (zs.calibZ.active) {
    if (!zs.calibZ.p0) {
      zs.calibZ.p0 = { x, y };
      setProfileStatus("Click the second point.");
    } else {
      zs.calibZ.p1 = { x, y };
      zs.calibZ.active = false;
      img.style.cursor = "";
      setProfileStatus("");
      finalizeCalibZ();
    }
    return;
  }
  if (!zs.profile.active) return;
  if (!zs.profile.p0) {
    zs.profile.p0 = { x, y };
    setProfileStatus("Click the second point.");
  } else {
    zs.profile.p1 = { x, y };
    zs.profile.active = false;
    img.style.cursor = "";
    setProfileStatus("");
    fetchProfile();
  }
}

async function finalizeCalibZ() {
  const { p0, p1 } = zs.calibZ;
  zs.calibZ.p0 = null;
  zs.calibZ.p1 = null;
  if (!p0 || !p1) return;
  // Sample a profile between the two picks in the current detrend mode;
  // its full z range is our "measured" delta.
  const detrend = $("zstack-detrend") ? $("zstack-detrend").value : "none";
  let measured_mm = 0;
  try {
    const r = await apiFetch("/zstack/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y, detrend }),
    });
    if (!r.ok) { setProfileStatus("Calibrate failed: " + r.status); return; }
    const data = await r.json();
    const z = data.z_mm;
    if (!z || z.length < 2) { setProfileStatus("Calibrate failed: no profile"); return; }
    measured_mm = Math.abs(z[z.length - 1] - z[0]);
  } catch (err) {
    setProfileStatus("Calibrate error: " + err.message);
    return;
  }
  if (!(measured_mm > 1e-9)) {
    setProfileStatus("Pick two points at different heights.");
    return;
  }
  const knownStr = window.prompt(
    `Measured Δ: ${measured_mm.toFixed(4)} mm\n\nKnown Z difference in mm?`,
    measured_mm.toFixed(3),
  );
  if (knownStr == null) { setProfileStatus(""); return; }
  const known = parseFloat(knownStr);
  if (!Number.isFinite(known) || known <= 0) {
    setProfileStatus("Invalid value.");
    return;
  }
  try {
    const r = await apiFetch("/zstack/calibrate-z", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ measured_mm, known_mm: known }),
    });
    if (!r.ok) { setProfileStatus("Calibrate failed: " + r.status); return; }
    const body = await r.json();
    setZScale(body.z_scale);
    await refreshAfterScaleChange();
  } catch (err) {
    setProfileStatus("Calibrate error: " + err.message);
  }
}

async function resetZScale() {
  try {
    const r = await apiFetch("/zstack/calibrate-z/reset", { method: "POST" });
    if (!r.ok) { setProfileStatus("Reset failed: " + r.status); return; }
    const body = await r.json();
    setZScale(body.z_scale);
    await refreshAfterScaleChange();
  } catch (err) {
    setProfileStatus("Reset error: " + err.message);
  }
}

function setZScale(s) {
  const v = Number.isFinite(s) ? s : 1.0;
  zs.zScale = v;
  const el = $("zstack-zscale-readout");
  const resetBtn = $("btn-zstack-zscale-reset");
  if (el) {
    el.textContent = `Z scale: ${v.toFixed(2)}×`;
    el.style.color = Math.abs(v - 1.0) > 1e-9 ? "#ff9a3c" : "";
  }
  if (resetBtn) resetBtn.hidden = Math.abs(v - 1.0) < 1e-9;
}

// Re-fetch the heightmap PNG (cache-busted) and any active profile / area
// so the UI reflects a new server-side scale factor.
async function refreshAfterScaleChange() {
  if (!zs.computed) return;
  const detrend = $("zstack-detrend") ? $("zstack-detrend").value : "none";
  const url = `/zstack/heightmap.png?detrend=${encodeURIComponent(detrend)}&t=${Date.now()}`;
  $("zstack-heightmap-img").src = url;
  $("zstack-heightmap-dl").href = url;
  // Pull fresh min/max from status so the z-range label is correct.
  try {
    const sr = await apiFetch("/zstack/status");
    if (sr.ok) {
      const st = await sr.json();
      if (st.result) {
        zs.computed.minZ = st.result.min_z;
        zs.computed.maxZ = st.result.max_z;
        $("zstack-zrange").textContent =
          `Z ${zs.computed.minZ.toFixed(3)} → ${zs.computed.maxZ.toFixed(3)} mm`;
      }
    }
  } catch {}
  if (zs.profile.p0 && zs.profile.p1) await fetchProfile();
  if (zs.area.p0 && zs.area.p1) await fetchAreaRoughness();
}

async function fetchProfile() {
  const p0 = zs.profile.p0, p1 = zs.profile.p1;
  if (!p0 || !p1) return;
  const detrend = $("zstack-detrend") ? $("zstack-detrend").value : "none";
  const sFilter = parseFloat($("zstack-s-filter")?.value) || 0;
  const lFilter = parseFloat($("zstack-l-filter")?.value) || 0;
  const body = {
    x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y,
    detrend,
    s_filter_mm: sFilter,
    l_filter_mm: lFilter,
  };
  // pixelsPerMm is our frontend calibration field — only send if positive.
  if (state.calibration && state.calibration.pixelsPerMm > 0) {
    body.px_per_mm = state.calibration.pixelsPerMm;
  }
  try {
    const r = await apiFetch("/zstack/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      setProfileStatus("Profile failed: " + r.status);
      return;
    }
    zs.profile.data = await r.json();
    drawProfileOverlay();
    drawProfileChart();
    drawBearingChart(zs.profile.data.bearing);
    drawPsdChart(zs.profile.data.psd);
    updateLateralResReadout(zs.profile.data);
    updateNoiseReadout(zs.profile.data);
  } catch (err) {
    setProfileStatus("Profile error: " + err.message);
  }
}

function drawProfileOverlay() {
  // Unified SVG overlay: profile line + area rect share the same SVG element.
  drawAreaOverlay();
}

// Plain-canvas side-view chart.  Small enough that hand-rolled axes beat
// pulling in a chart library.
function drawProfileChart() {
  const canvas = $("zstack-profile-chart");
  const data = zs.profile.data;
  if (!canvas || !data) return;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 200;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 46, padR = 12, padT = 10, padB = 22;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const dist = data.distances;
  const z = data.z_mm;
  const n = z.length;
  if (n < 2 || plotW <= 0 || plotH <= 0) return;

  const distMin = dist[0], distMax = dist[n - 1];
  const distSpan = Math.max(1e-9, distMax - distMin);
  let zMin = data.z_min_mm, zMax = data.z_max_mm;
  const zSpanRaw = zMax - zMin;
  if (zSpanRaw < 1e-6) { zMin -= 5e-4; zMax += 5e-4; }  // avoid degenerate flat line
  // 5% headroom so the polyline doesn't clip the frame
  const pad = (zMax - zMin) * 0.05;
  zMin -= pad; zMax += pad;
  const zSpan = zMax - zMin;

  const xToPx = x => padL + (x - distMin) / distSpan * plotW;
  const zToPx = v => padT + (1 - (v - zMin) / zSpan) * plotH;

  // Frame
  ctx.strokeStyle = "#444";
  ctx.lineWidth = 1;
  ctx.strokeRect(padL + 0.5, padT + 0.5, plotW, plotH);

  // Axis labels
  ctx.fillStyle = "#aaa";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const xUnit = data.distances_unit;
  const distMid = (distMin + distMax) / 2;
  ctx.fillText(distMin.toFixed(xUnit === "mm" ? 3 : 0), xToPx(distMin), padT + plotH + 3);
  ctx.fillText(distMid.toFixed(xUnit === "mm" ? 3 : 0), xToPx(distMid), padT + plotH + 3);
  ctx.fillText(distMax.toFixed(xUnit === "mm" ? 3 : 0) + " " + xUnit, xToPx(distMax), padT + plotH + 3);
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(zMax.toFixed(4), padL - 4, zToPx(zMax));
  ctx.fillText(((zMin + zMax) / 2).toFixed(4), padL - 4, zToPx((zMin + zMax) / 2));
  ctx.fillText(zMin.toFixed(4) + " mm", padL - 4, zToPx(zMin));

  // Profile polyline
  ctx.strokeStyle = "#00c8ff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const px = xToPx(dist[i]);
    const py = zToPx(z[i]);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Markers
  const drawMarker = (t, colour, label) => {
    const x = padL + t * plotW;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(x - 5, padT);
    ctx.lineTo(x + 5, padT);
    ctx.lineTo(x, padT + 7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, padT + 2);
  };
  drawMarker(zs.profile.markerA, "#ff4d6d", "A");
  drawMarker(zs.profile.markerB, "#7cff7c", "B");

  // Cache plot geometry for hit-testing on mousedown.
  zs.profile._plot = { padL, padT, plotW, plotH };

  updateProfileReadout();
}

function updateProfileReadout() {
  const data = zs.profile.data;
  if (!data) return;
  const n = data.z_mm.length;
  const idxA = Math.max(0, Math.min(n - 1, Math.round(zs.profile.markerA * (n - 1))));
  const idxB = Math.max(0, Math.min(n - 1, Math.round(zs.profile.markerB * (n - 1))));
  const zA = data.z_mm[idxA], zB = data.z_mm[idxB];
  const dZmm = Math.abs(zB - zA);
  const unit = data.distances_unit;
  const dX = Math.abs(data.distances[idxB] - data.distances[idxA]);
  // Auto-unit for ΔZ: below 100 µm → µm, else mm.  3 sig figs.
  let dZstr;
  if (dZmm < 0.1) dZstr = (dZmm * 1000).toPrecision(3) + " µm";
  else dZstr = dZmm.toPrecision(3) + " mm";
  let parts = [
    `ΔX: ${dX.toPrecision(4)} ${unit}`,
    `ΔZ: ${dZstr}`,
    `zA: ${zA.toFixed(4)} mm`,
    `zB: ${zB.toFixed(4)} mm`,
  ];
  if (unit === "mm" && dX > 1e-9) {
    const slopeDeg = Math.atan2(zB - zA, data.distances[idxB] - data.distances[idxA]) * 180 / Math.PI;
    parts.push(`slope: ${slopeDeg.toFixed(2)}°`);
  }
  const el = $("zstack-profile-readout");
  if (el) el.textContent = parts.join("    ");

  updateRoughnessReadout(idxA, idxB);
}

// Auto-unit a length in mm: sub-0.1mm → µm, else mm. 2-3 sig figs.
function fmtLen(mm) {
  if (!Number.isFinite(mm)) return "—";
  if (Math.abs(mm) < 0.1) return (mm * 1000).toFixed(2) + " µm";
  return mm.toFixed(4) + " mm";
}

// Client-side mirror of compute_roughness_1d for the marker sub-range readout.
// Matches the backend math so end-to-end values agree at the range limits.
function computeRoughness1d(z) {
  const n = z.length;
  if (n < 2) return { Ra: 0, Rq: 0, Rp: 0, Rv: 0, Rt: 0, Rz: 0, Rsk: 0, Rku: 0, count: n };
  let mu = 0;
  for (let i = 0; i < n; i++) mu += z[i];
  mu /= n;
  let sa = 0, sq = 0, s3 = 0, s4 = 0, mx = -Infinity, mn = Infinity;
  for (let i = 0; i < n; i++) {
    const d = z[i] - mu;
    sa += Math.abs(d);
    const d2 = d * d;
    sq += d2;
    s3 += d2 * d;
    s4 += d2 * d2;
    if (d > mx) mx = d;
    if (d < mn) mn = d;
  }
  const Ra = sa / n;
  const Rq = Math.sqrt(sq / n);
  const Rp = mx;
  const Rv = -mn;
  const Rt = Rp + Rv;
  let Rsk = 0, Rku = 0;
  if (Rq > 1e-15) {
    Rsk = (s3 / n) / (Rq ** 3);
    Rku = (s4 / n) / (Rq ** 4) - 3.0;
  }
  return { Ra, Rq, Rp, Rv, Rt, Rz: Rt, Rsk, Rku, count: n };
}

function getNoiseFloorSq() {
  if (zs.noiseFloor?.Sq_noise) return zs.noiseFloor.Sq_noise;
  return null;
}

function compensateRoughness(r) {
  const mode = $("zstack-noise-comp")?.value || "off";
  if (mode !== "quadrature") return r;
  const sqNoise = getNoiseFloorSq();
  if (!sqNoise || sqNoise <= 0 || !r.Rq || r.Rq <= 0) return r;
  const rqCorr = Math.sqrt(Math.max(0, r.Rq * r.Rq - sqNoise * sqNoise));
  if (r.Rq < 1e-15) return r;
  const ratio = rqCorr / r.Rq;
  return {
    ...r,
    Ra: r.Ra * ratio,
    Rq: rqCorr,
    Rp: r.Rp * ratio,
    Rv: r.Rv * ratio,
    Rz: r.Rz * ratio,
    Rsk: r.Rsk,
    Rku: r.Rku,
    count: r.count,
  };
}

function fmtRoughnessLine(label, r) {
  return `${label}  Ra ${fmtLen(r.Ra)}   Rq ${fmtLen(r.Rq)}   Rz ${fmtLen(r.Rz)}   ` +
         `Rsk ${r.Rsk.toFixed(2)}   Rku ${r.Rku.toFixed(2)}   (${r.count} samples)`;
}

function updateRoughnessReadout(idxA, idxB) {
  const data = zs.profile.data;
  const fullEl = $("zstack-roughness-full");
  const rngEl = $("zstack-roughness-range");
  if (!data || !fullEl || !rngEl) return;
  const r = data.roughness;
  if (r) {
    const rc = compensateRoughness({
      Ra: r.Ra, Rq: r.Rq, Rz: r.Rz, Rsk: r.Rsk, Rku: r.Rku, count: r.count,
    });
    fullEl.textContent = fmtRoughnessLine("Full line:", rc);
  } else {
    fullEl.textContent = "";
  }
  // Marker-range roughness is client-side over the z slice between A and B,
  // so dragging the markers is instant and can focus on a single feature.
  const lo = Math.min(idxA, idxB), hi = Math.max(idxA, idxB);
  const slice = data.z_mm.slice(lo, hi + 1);
  if (slice.length >= 2) {
    const rr = compensateRoughness(computeRoughness1d(slice));
    rngEl.textContent = fmtRoughnessLine("Marker A→B:", rr);
  } else {
    rngEl.textContent = "Marker A→B:  (select a wider range)";
  }
}

// ---- Area roughness ----

function hmImgToFullRes(e) {
  const img = $("zstack-heightmap-img");
  const rect = img.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || !zs.computed) return null;
  const sx = zs.computed.width / rect.width;
  const sy = zs.computed.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function onHeightmapMouseDown(e) {
  if (!zs.area.active || !zs.computed) return;
  const pt = hmImgToFullRes(e);
  if (!pt) return;
  zs.area.drawing = true;
  zs.area.p0 = pt;
  zs.area.p1 = pt;
  drawAreaOverlay();
  e.preventDefault();
}

function onHeightmapMouseMove(e) {
  if (!zs.area.drawing) return;
  const pt = hmImgToFullRes(e);
  if (!pt) return;
  zs.area.p1 = pt;
  drawAreaOverlay();
}

function onHeightmapMouseUp(e) {
  if (!zs.area.drawing) return;
  zs.area.drawing = false;
  zs.area.active = false;
  $("zstack-heightmap-img").style.cursor = "";
  setProfileStatus("");
  if (!zs.area.p0 || !zs.area.p1) return;
  const w = Math.abs(zs.area.p1.x - zs.area.p0.x);
  const h = Math.abs(zs.area.p1.y - zs.area.p0.y);
  if (w < 2 || h < 2) {
    clearArea();
    return;
  }
  fetchAreaRoughness();
}

async function fetchAreaRoughness() {
  if (!zs.area.p0 || !zs.area.p1) return;
  const detrend = $("zstack-detrend") ? $("zstack-detrend").value : "none";
  const sFilter = parseFloat($("zstack-s-filter")?.value) || 0;
  const lFilter = parseFloat($("zstack-l-filter")?.value) || 0;
  const body = {
    x0: zs.area.p0.x, y0: zs.area.p0.y,
    x1: zs.area.p1.x, y1: zs.area.p1.y,
    detrend, detrend_scope: "roi",
    s_filter_mm: sFilter,
    l_filter_mm: lFilter,
  };
  if (state.calibration && state.calibration.pixelsPerMm > 0) {
    body.px_per_mm = state.calibration.pixelsPerMm;
  }
  try {
    const r = await apiFetch("/zstack/area-roughness", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      setProfileStatus("Area roughness failed: " + r.status);
      return;
    }
    zs.area.data = await r.json();
    updateAreaReadout();
    drawAreaOverlay();
    drawBearingChart(zs.area.data.bearing);
    drawPsdChart(zs.area.data.psd);
    updateLateralResReadout(zs.area.data);
    updateNoiseReadout(zs.area.data);
  } catch (err) {
    setProfileStatus("Area error: " + err.message);
  }
}

function compensateAreaRoughness(d) {
  const mode = $("zstack-noise-comp")?.value || "off";
  if (mode !== "quadrature") return d;
  const sqNoise = getNoiseFloorSq();
  if (!sqNoise || sqNoise <= 0 || !d.Sq || d.Sq <= 0) return d;
  const sqCorr = Math.sqrt(Math.max(0, d.Sq * d.Sq - sqNoise * sqNoise));
  const ratio = sqCorr / d.Sq;
  return { ...d, Sa: d.Sa * ratio, Sq: sqCorr, Sz: d.Sz * ratio };
}

function updateAreaReadout() {
  const el = $("zstack-roughness-area");
  if (!el) return;
  const d = zs.area.data;
  if (!d) { el.textContent = ""; return; }
  const c = compensateAreaRoughness(d);
  let text =
    `Area (${d.width_px}×${d.height_px} px):  ` +
    `Sa ${fmtLen(c.Sa)}   Sq ${fmtLen(c.Sq)}   Sz ${fmtLen(c.Sz)}   ` +
    `Ssk ${(d.Ssk ?? 0).toFixed(2)}   Sku ${(d.Sku ?? 0).toFixed(2)}   ` +
    `[scope ${d.detrend_scope}/${d.detrend}]`;
  if (d.s_filter_mm > 0 || d.l_filter_mm > 0) {
    text += `   [S=${d.s_filter_mm}mm L=${d.l_filter_mm}mm]`;
  }
  if (d.texture) {
    const t = d.texture;
    if (t.Sal != null) text += `   Sal ${fmtLen(t.Sal)}`;
    if (t.Str != null) text += `   Str ${t.Str.toFixed(3)}`;
    if (t.Std != null) text += `   Std ${t.Std.toFixed(1)}°`;
  }
  el.textContent = text;
}

function drawAreaOverlay() {
  const svg = $("zstack-profile-overlay");
  const img = $("zstack-heightmap-img");
  if (!svg || !img || !zs.computed) return;
  // Preserve any existing profile line content, then add/replace the rect.
  // Simplest: rebuild from both states.
  let content = "";
  if (zs.profile.data) {
    const data = zs.profile.data;
    const rect = img.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const sx = rect.width / zs.computed.width;
      const sy = rect.height / zs.computed.height;
      const xs = data.x_px, ys = data.y_px;
      if (xs && ys && xs.length >= 2) {
        const x0 = xs[0] * sx, y0 = ys[0] * sy;
        const x1 = xs[xs.length - 1] * sx, y1 = ys[ys.length - 1] * sy;
        content +=
          `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#ffcc00" stroke-width="2" />` +
          `<circle cx="${x0}" cy="${y0}" r="4" fill="#ffcc00" stroke="#000" stroke-width="1" />` +
          `<circle cx="${x1}" cy="${y1}" r="4" fill="#ffcc00" stroke="#000" stroke-width="1" />`;
      }
    }
  }
  const rect = img.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    if (zs.area.p0 && zs.area.p1) {
      const sx = rect.width / zs.computed.width;
      const sy = rect.height / zs.computed.height;
      const x0 = Math.min(zs.area.p0.x, zs.area.p1.x) * sx;
      const y0 = Math.min(zs.area.p0.y, zs.area.p1.y) * sy;
      const w = Math.abs(zs.area.p1.x - zs.area.p0.x) * sx;
      const h = Math.abs(zs.area.p1.y - zs.area.p0.y) * sy;
      content +=
        `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" ` +
        `fill="rgba(124,255,124,0.08)" stroke="#7cff7c" stroke-width="2" stroke-dasharray="5,3" />`;
    }
  }
  svg.innerHTML = content;
}

function clearArea() {
  zs.area.active = false;
  zs.area.drawing = false;
  zs.area.p0 = null;
  zs.area.p1 = null;
  zs.area.data = null;
  const el = $("zstack-roughness-area");
  if (el) el.textContent = "";
  drawAreaOverlay();
}

// ---- Bearing ratio chart (Abbott-Firestone) ----

function drawBearingChart(bearing) {
  const canvas = $("zstack-bearing-chart");
  if (!canvas || !bearing || !bearing.ratios || bearing.ratios.length < 2) {
    if (canvas) { const ctx = canvas.getContext("2d"); ctx.clearRect(0, 0, canvas.width, canvas.height); }
    return;
  }
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 140;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 10, padR = 46, padT = 8, padB = 20;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const ratios = bearing.ratios;
  const heights = bearing.heights;
  const n = ratios.length;
  const hMin = heights[n - 1], hMax = heights[0];
  const hSpan = Math.max(1e-9, hMax - hMin);

  // Frame
  ctx.strokeStyle = "#444";
  ctx.lineWidth = 1;
  ctx.strokeRect(padL + 0.5, padT + 0.5, plotW, plotH);

  // Curve
  ctx.strokeStyle = "#ff9f0a";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = padL + ratios[i] * plotW;
    const y = padT + (1 - (heights[i] - hMin) / hSpan) * plotH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Axis labels
  ctx.fillStyle = "#888";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("0%", padL, padT + plotH + 3);
  ctx.fillText("50%", padL + plotW / 2, padT + plotH + 3);
  ctx.fillText("100%", padL + plotW, padT + plotH + 3);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(fmtLen(hMax), padL + plotW + 4, padT);
  ctx.fillText(fmtLen(hMin), padL + plotW + 4, padT + plotH);

  // Readout: Spk/Sk/Svk
  const rd = $("zstack-bearing-readout");
  if (rd) {
    rd.textContent = `Spk ${fmtLen(bearing.Spk)}   Sk ${fmtLen(bearing.Sk)}   Svk ${fmtLen(bearing.Svk)}   Smr1 ${(bearing.Smr1 * 100).toFixed(1)}%   Smr2 ${(bearing.Smr2 * 100).toFixed(1)}%`;
  }
}

// ---- PSD chart (power spectral density) ----

function drawPsdChart(psd) {
  const canvas = $("zstack-psd-chart");
  if (!canvas || !psd || !psd.frequencies || psd.frequencies.length < 2) {
    if (canvas) { const ctx = canvas.getContext("2d"); ctx.clearRect(0, 0, canvas.width, canvas.height); }
    return;
  }
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 140;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 46, padR = 10, padT = 8, padB = 20;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const freqs = psd.frequencies;
  const vals = psd.psd;
  const n = freqs.length;

  // Log-log plot
  const posVals = vals.filter(v => v > 0);
  if (posVals.length < 2) return;
  const fMin = Math.log10(Math.max(1e-6, freqs[0]));
  const fMax = Math.log10(Math.max(1e-6, freqs[n - 1]));
  const fSpan = Math.max(0.1, fMax - fMin);
  const vMin = Math.log10(Math.min(...posVals));
  const vMax = Math.log10(Math.max(...posVals));
  const vSpan = Math.max(0.1, vMax - vMin);
  const vPad = vSpan * 0.05;

  // Frame
  ctx.strokeStyle = "#444";
  ctx.lineWidth = 1;
  ctx.strokeRect(padL + 0.5, padT + 0.5, plotW, plotH);

  // Curve
  ctx.strokeStyle = "#0a84ff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < n; i++) {
    if (vals[i] <= 0) continue;
    const x = padL + (Math.log10(freqs[i]) - fMin) / fSpan * plotW;
    const y = padT + (1 - (Math.log10(vals[i]) - (vMin - vPad)) / (vSpan + 2 * vPad)) * plotH;
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Axis labels
  ctx.fillStyle = "#888";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("1/mm", padL + plotW / 2, padT + plotH + 3);
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(psd.unit, padL - 3, padT + plotH / 2);
}

// ---- Lateral resolution readout ----

function updateLateralResReadout(data) {
  const el = $("zstack-lateral-res");
  if (!el) return;
  if (data && data.lateral_resolution_um) {
    el.textContent = `Lateral resolution: ${data.lateral_resolution_um.toFixed(1)} µm/px`;
  } else {
    el.textContent = "";
  }
}

// ---- Noise floor readout ----

function updateNoiseReadout(data) {
  const el = $("zstack-noise-readout");
  if (!el) return;
  if (data && data.noise_floor) {
    zs.noiseFloor = data.noise_floor;
    const nf = data.noise_floor;
    el.textContent = `Noise floor: Sq ${fmtLen(nf.Sq_noise)}, PV ${fmtLen(nf.pv_noise)}`;
    el.style.color = "#ff9f0a";
  } else if (!zs.noiseFloor) {
    el.textContent = "";
  }
}

// ---- Noise reference capture ----

async function captureNoiseReference() {
  if (!zs.computed) {
    setProfileStatus("Build a Z-stack on a flat surface first.");
    return;
  }
  if (!confirm("Set the current Z-stack as the noise floor reference? Use a known-flat surface (optical flat, polished gauge block).")) return;
  try {
    const r = await apiFetch("/zstack/noise-reference", { method: "POST" });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      setProfileStatus("Noise ref failed: " + (e.detail || r.status));
      return;
    }
    const data = await r.json();
    setProfileStatus(`Noise floor set: Sq = ${fmtLen(data.noise_floor.Sq_noise)}`);
    updateNoiseReadout(data);
  } catch (err) {
    setProfileStatus("Noise ref error: " + err.message);
  }
}

function chartXToT(e) {
  const canvas = $("zstack-profile-chart");
  const plot = zs.profile._plot;
  if (!canvas || !plot) return null;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const t = (x - plot.padL) / plot.plotW;
  return Math.max(0, Math.min(1, t));
}

function onChartMouseDown(e) {
  if (!zs.profile.data || !zs.profile._plot) return;
  const canvas = e.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const plot = zs.profile._plot;
  const x = e.clientX - rect.left;
  const xA = plot.padL + zs.profile.markerA * plot.plotW;
  const xB = plot.padL + zs.profile.markerB * plot.plotW;
  const dA = Math.abs(x - xA), dB = Math.abs(x - xB);
  if (dA < dB && dA < 10) zs.profile.dragging = "A";
  else if (dB < 10) zs.profile.dragging = "B";
  else {
    // Click elsewhere → snap nearest marker to click
    const t = chartXToT(e);
    if (t == null) return;
    if (dA < dB) { zs.profile.markerA = t; zs.profile.dragging = "A"; }
    else { zs.profile.markerB = t; zs.profile.dragging = "B"; }
    drawProfileChart();
  }
  e.preventDefault();
}

function onChartMouseMove(e) {
  if (!zs.profile.dragging) return;
  const t = chartXToT(e);
  if (t == null) return;
  if (zs.profile.dragging === "A") zs.profile.markerA = t;
  else zs.profile.markerB = t;
  drawProfileChart();
}

function onChartMouseUp() {
  zs.profile.dragging = null;
}

function updateInstruction() {
  const el = $("zstack-instruction");
  if (!el) return;
  if (zs.frameCount === 0) {
    el.textContent = "Focus at the lowest point, then click Capture.";
  } else {
    el.textContent = `Move Z up by ${zs.zStepMm} mm, then click Capture.`;
  }
}

function updateCount() {
  const el = $("zstack-count");
  if (el) el.textContent = `${zs.frameCount} / suggested ${zs.suggestedMin}–${zs.suggestedMax}`;
  const computeBtn = $("btn-zstack-compute");
  if (computeBtn) computeBtn.disabled = zs.frameCount < 3;
}

function renderThumbs() {
  const wrap = $("zstack-thumbs");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (let i = 0; i < zs.frameCount; i++) {
    const dot = document.createElement("div");
    dot.style.cssText = "width:42px;height:42px;border:1px solid #555;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:11px;background:#1a1a1a;color:#aaa;position:relative";
    dot.textContent = `#${i + 1}`;
    const del = document.createElement("button");
    del.textContent = "×";
    del.title = `Delete frame ${i + 1}`;
    del.style.cssText = "position:absolute;top:-6px;right:-6px;width:16px;height:16px;border-radius:50%;border:none;background:#c44;color:#fff;font-size:11px;line-height:1;cursor:pointer;padding:0;display:none";
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteFrame(i); });
    dot.addEventListener("mouseenter", () => { del.style.display = "block"; });
    dot.addEventListener("mouseleave", () => { del.style.display = "none"; });
    dot.appendChild(del);
    wrap.appendChild(dot);
  }
}

async function deleteFrame(index) {
  try {
    const r = await fetch(`/zstack/frame/${index}`, { method: "DELETE" });
    if (!r.ok) { const e = await r.json(); alert(e.detail || "Delete failed"); return; }
    const data = await r.json();
    zs.frameCount = data.frame_count;
    zs.result = null;
    renderThumbs();
    const cnt = $("zstack-count");
    if (cnt) cnt.textContent = zs.frameCount;
  } catch (err) { alert("Delete frame failed: " + err.message); }
}

// Applies HDR-support info from /zstack/status to the UI toggle.
function applyHdrCapability(status) {
  zs.hdrSupported = !!status.hdr_supported;
  if (Array.isArray(status.hdr_default_stops) && status.hdr_default_stops.length >= 2) {
    zs.hdrStops = status.hdr_default_stops;
  }
  const toggle = $("zstack-hdr-toggle");
  const label = $("zstack-hdr-label");
  const note = $("zstack-hdr-note");
  if (toggle) {
    toggle.disabled = !zs.hdrSupported;
    if (!zs.hdrSupported) {
      toggle.checked = false;
      zs.hdrEnabled = false;
    }
  }
  if (label) label.style.opacity = zs.hdrSupported ? "1" : "0.5";
  if (note && !zs.hdrSupported) {
    note.textContent = "Not supported on this camera (needs Aravis/GigE).";
  }
}

// Rehydrate the result panel from a /zstack/status response that has result!=null.
// Lets the user close + reopen the dialog (or reload the page) without losing
// a built Z-stack.
function rehydrateResult(status) {
  if (!status || !status.result) return;
  setZScale(typeof status.z_scale === "number" ? status.z_scale : 1.0);
  const r = status.result;
  zs.computed = {
    compositeUrl: "/zstack/composite.png?t=" + Date.now(),
    heightmapUrl: "/zstack/heightmap.png?t=" + Date.now(),
    minZ: r.min_z,
    maxZ: r.max_z,
    width: r.width,
    height: r.height,
  };
  const detrendSel = $("zstack-detrend");
  if (detrendSel) detrendSel.value = "none";
  $("zstack-composite-img").src = zs.computed.compositeUrl;
  $("zstack-heightmap-img").src = zs.computed.heightmapUrl;
  $("zstack-composite-dl").href = zs.computed.compositeUrl;
  $("zstack-heightmap-dl").href = zs.computed.heightmapUrl;
  $("zstack-zrange").textContent =
    `Z ${zs.computed.minZ.toFixed(3)} → ${zs.computed.maxZ.toFixed(3)} mm`;
  $("zstack-result").hidden = false;
}

// Fresh session on the backend: wipes frames and any computed result.
async function startFreshSession() {
  const r = await apiFetch("/zstack/start", { method: "POST" });
  if (!r.ok) { showStatus("Z-stack start failed"); return false; }
  const data = await r.json();
  zs.sessionId = data.session_id;
  zs.frameCount = 0;
  zs.computed = null;
  const resultEl = $("zstack-result");
  if (resultEl) resultEl.hidden = true;
  renderThumbs();
  updateCount();
  updateInstruction();
  updateSurfaceButtonState();
  return true;
}

async function captureFrame() {
  const btn = $("btn-zstack-capture");
  const origLabel = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    if (zs.hdrEnabled) btn.textContent = "Bracketing…";
  }
  try {
    let r;
    if (zs.hdrEnabled && zs.hdrSupported) {
      r = await apiFetch("/zstack/capture-hdr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stops: zs.hdrStops }),
      });
    } else {
      r = await apiFetch("/zstack/capture", { method: "POST" });
    }
    if (!r.ok) {
      const msg = await r.text();
      showStatus("Capture failed: " + msg);
      return;
    }
    const data = await r.json();
    zs.frameCount = data.frame_count;
    renderThumbs();
    updateCount();
    updateInstruction();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origLabel || "Capture frame";
    }
  }
}

async function compute() {
  const btn = $("btn-zstack-compute");
  if (btn) { btn.disabled = true; btn.textContent = "Building…"; }
  try {
    const r = await apiFetch("/zstack/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ z_step_mm: zs.zStepMm, mode: zs.fusionMode }),
    });
    if (!r.ok) {
      const msg = await r.text();
      showStatus("Compute failed: " + msg);
      return;
    }
    const data = await r.json();
    zs.computed = {
      compositeUrl: data.composite_url + "?t=" + Date.now(),
      heightmapUrl: data.heightmap_url + "?t=" + Date.now(),
      minZ: data.min_z,
      maxZ: data.max_z,
      width: data.width,
      height: data.height,
    };

    const detrendSel = $("zstack-detrend");
    if (detrendSel) detrendSel.value = "none";
    clearProfile();
    clearArea();
    setZScale(1.0);
    $("zstack-composite-img").src = zs.computed.compositeUrl;
    $("zstack-heightmap-img").src = zs.computed.heightmapUrl;
    $("zstack-composite-dl").href = zs.computed.compositeUrl;
    $("zstack-heightmap-dl").href = zs.computed.heightmapUrl;
    $("zstack-zrange").textContent =
      `Z ${zs.computed.minZ.toFixed(3)} → ${zs.computed.maxZ.toFixed(3)} mm`;
    $("zstack-result").hidden = false;
    showStatus(`Z-stack built: ${zs.frameCount} frames, Z range ${(zs.computed.maxZ - zs.computed.minZ).toFixed(3)} mm`);
    updateSurfaceButtonState();
  } finally {
    if (btn) { btn.disabled = zs.frameCount < 3; btn.textContent = "Build height map"; }
  }
}

async function resetStack() {
  await apiFetch("/zstack/reset", { method: "POST" });
  zs.frameCount = 0;
  zs.computed = null;
  clearProfile();
  clearArea();
  const resultEl = $("zstack-result");
  if (resultEl) resultEl.hidden = true;
  renderThumbs();
  updateCount();
  updateInstruction();
  updateSurfaceButtonState();
  // Noise floor survives reset on the backend — restore the readout
  try {
    const r = await apiFetch("/zstack/status");
    if (r.ok) {
      const status = await r.json();
      updateNoiseReadout(status);
    }
  } catch {}
}

// Replace the live/frozen view with the all-in-focus composite so existing
// measurement tools can run on the sharp stacked image.  Reuses the same
// pathway as a loaded image: populate state.frozenBackground and flip to
// the frozen UI state.
async function useCompositeAsWorkingImage() {
  if (!zs.computed) return;
  try {
    const resp = await fetch(zs.computed.compositeUrl);
    if (!resp.ok) throw new Error("failed to fetch composite");
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const loadedImg = await new Promise((resolve, reject) => {
      const bmp = new Image();
      bmp.onload = () => resolve(bmp);
      bmp.onerror = () => reject(new Error("decode failed"));
      bmp.src = url;
    });

    // Upload to backend so detection/inspection operate on the composite
    const fd = new FormData();
    fd.append("file", blob, "zstack-composite.png");
    const up = await apiFetch("/load-image", { method: "POST", body: fd });
    if (!up.ok) throw new Error("upload failed");
    const { width, height } = await up.json();

    state.frozenSize = { w: width, h: height };
    setImageSize(width, height);
    viewport.zoom = 1;
    viewport.panX = 0;
    viewport.panY = 0;
    state.frozenBackground = loadedImg;
    img.style.opacity = "0";
    state.frozen = true;
    cacheImageData(loadedImg, width, height);
    updateFreezeUI();
    resizeCanvas();
    showStatus("Composite loaded as working image");
    closeDialog();
  } catch (err) {
    showStatus("Use composite failed: " + err.message);
  }
}

// Spacebar → capture while the dialog is open.  Installed on openZstackDialog,
// removed on closeDialog.  Ignores key repeats and typing in number inputs.
function onZstackKey(e) {
  if (e.key !== " " && e.code !== "Space") return;
  const dlg = $("zstack-dialog");
  if (!dlg || dlg.hidden) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
  if (e.repeat) return;
  e.preventDefault();
  e.stopPropagation();
  captureFrame();
}

export async function openZstackDialog() {
  buildDialog();
  const dlg = $("zstack-dialog");
  dlg.hidden = false;
  window.addEventListener("keydown", onZstackKey, true);

  // Refresh the calibration banner — user may have calibrated since
  // the last time the dialog was opened.
  updateCalibrationWarning();

  // Probe backend state first — if there's an existing session with frames
  // or a computed result, keep it.  Closing and reopening the dialog (e.g.
  // to get back to the 3D view) must not wipe the user's work.
  let status = null;
  try {
    const sr = await apiFetch("/zstack/status");
    if (sr.ok) status = await sr.json();
  } catch {}

  if (status) applyHdrCapability(status);

  if (status && (status.has_result || status.frame_count > 0)) {
    // Adopt the existing session — no reset.
    zs.sessionId = status.session_id;
    zs.frameCount = status.frame_count;
    renderThumbs();
    updateCount();
    updateInstruction();
    if (status.has_result) rehydrateResult(status);
    updateSurfaceButtonState();
  } else {
    await startFreshSession();
  }
}

// Called by the toolbar "Surface view" button.  Opens the 3D viewer
// directly if the backend has a computed Z-stack, otherwise falls back
// to opening the capture dialog.
export async function openZstack3dFromToolbar() {
  try {
    const sr = await apiFetch("/zstack/status");
    if (sr.ok) {
      const status = await sr.json();
      if (status.has_result) {
        const { openZstack3dView } = await import("./zstack-3d.js");
        await openZstack3dView();
        return;
      }
    }
  } catch {}
  showStatus("Build a Z-stack first");
  openZstackDialog();
}

function closeDialog() {
  const dlg = $("zstack-dialog");
  if (dlg) dlg.hidden = true;
  window.removeEventListener("keydown", onZstackKey, true);
}

// Sync the toolbar "Surface view" button enabled-state to whether a
// computed Z-stack exists. Called on init (one-shot against the backend
// to rehydrate after a reload) and directly from compute/reset/open-dialog
// transitions — polling isn't needed because every has_result flip is
// frontend-driven in this tab.
export function updateSurfaceButtonState() {
  const viewBtn = $("btn-zstack-3d-view");
  if (!viewBtn) return;
  viewBtn.disabled = !zs.computed;
}

export function initZstack() {
  const btn = $("btn-zstack");
  if (btn) btn.addEventListener("click", openZstackDialog);
  const viewBtn = $("btn-zstack-3d-view");
  if (viewBtn) {
    viewBtn.addEventListener("click", openZstack3dFromToolbar);
    // One-shot probe on page load: if the backend already has a computed
    // stack from a previous session, enable the button. After this, state
    // transitions are driven locally by compute()/resetStack()/openDialog.
    viewBtn.disabled = true;
    (async () => {
      try {
        const sr = await apiFetch("/zstack/status");
        if (!sr.ok) return;
        const status = await sr.json();
        viewBtn.disabled = !status.has_result;
      } catch {}
    })();
  }
}
