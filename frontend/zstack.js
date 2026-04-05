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
      <div style="padding:14px 18px">
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

          <div id="zstack-profile-section" hidden style="margin-top:12px;padding:8px 10px;background:#161616;border:1px solid #2a2a2a;border-radius:3px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
              <strong style="font-size:12px">Profile</strong>
              <button class="detect-btn" id="btn-zstack-profile-draw" style="margin-left:8px">Draw profile</button>
              <button class="detect-btn" id="btn-zstack-profile-clear">Clear</button>
              <span id="zstack-profile-status" style="opacity:0.75;font-size:11px"></span>
            </div>
            <canvas id="zstack-profile-chart" style="width:100%;height:200px;background:#0b0b0b;border:1px solid #333;display:block"></canvas>
            <div id="zstack-profile-readout" style="margin-top:6px;font-size:12px;opacity:0.9;font-variant-numeric:tabular-nums"></div>
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
    // Re-fetch the profile against the new level so the chart matches
    // whatever the user is looking at.
    if (zs.profile.p0 && zs.profile.p1) fetchProfile();
  });

  // Profile controls
  $("btn-zstack-profile-draw").addEventListener("click", () => {
    if (!zs.computed) return;
    zs.profile.active = true;
    zs.profile.p0 = null;
    zs.profile.p1 = null;
    $("zstack-profile-section").hidden = false;
    $("zstack-heightmap-img").style.cursor = "crosshair";
    setProfileStatus("Click two points on the height map.");
  });
  $("btn-zstack-profile-clear").addEventListener("click", clearProfile);

  const hmImg = $("zstack-heightmap-img");
  hmImg.addEventListener("click", onHeightmapClick);
  hmImg.addEventListener("load", () => {
    if (zs.profile.data) drawProfileOverlay();
  });
  // Re-render overlay on resize so the SVG line tracks the image.
  window.addEventListener("resize", () => {
    if (zs.profile.data) drawProfileOverlay();
    if (zs.profile.data) drawProfileChart();
  });

  const chart = $("zstack-profile-chart");
  chart.addEventListener("mousedown", onChartMouseDown);
  window.addEventListener("mousemove", onChartMouseMove);
  window.addEventListener("mouseup", onChartMouseUp);
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
}

function onHeightmapClick(e) {
  if (!zs.profile.active || !zs.computed) return;
  const img = e.currentTarget;
  const rect = img.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  // <img> is rendered at 100% of its column; scale CSS-px → full-res image-px.
  const scaleX = zs.computed.width / rect.width;
  const scaleY = zs.computed.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;
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

async function fetchProfile() {
  const p0 = zs.profile.p0, p1 = zs.profile.p1;
  if (!p0 || !p1) return;
  const detrend = $("zstack-detrend") ? $("zstack-detrend").value : "none";
  const body = {
    x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y,
    detrend,
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
  } catch (err) {
    setProfileStatus("Profile error: " + err.message);
  }
}

function drawProfileOverlay() {
  const svg = $("zstack-profile-overlay");
  const img = $("zstack-heightmap-img");
  if (!svg || !img || !zs.profile.data || !zs.computed) return;
  const data = zs.profile.data;
  const rect = img.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const sx = rect.width / zs.computed.width;
  const sy = rect.height / zs.computed.height;
  const xs = data.x_px, ys = data.y_px;
  if (!xs || !ys || xs.length < 2) return;
  const x0 = xs[0] * sx, y0 = ys[0] * sy;
  const x1 = xs[xs.length - 1] * sx, y1 = ys[ys.length - 1] * sy;
  svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  svg.innerHTML =
    `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#ffcc00" stroke-width="2" />` +
    `<circle cx="${x0}" cy="${y0}" r="4" fill="#ffcc00" stroke="#000" stroke-width="1" />` +
    `<circle cx="${x1}" cy="${y1}" r="4" fill="#ffcc00" stroke="#000" stroke-width="1" />`;
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
    dot.style.cssText = "width:42px;height:42px;border:1px solid #555;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:11px;background:#1a1a1a;color:#aaa";
    dot.textContent = `#${i + 1}`;
    wrap.appendChild(dot);
  }
}

async function startSession() {
  const r = await apiFetch("/zstack/start", { method: "POST" });
  if (!r.ok) { showStatus("Z-stack start failed"); return false; }
  const data = await r.json();
  zs.sessionId = data.session_id;
  zs.frameCount = 0;
  zs.computed = null;
  // Probe HDR capability of the active camera
  try {
    const sr = await apiFetch("/zstack/status");
    if (sr.ok) {
      const sdata = await sr.json();
      zs.hdrSupported = !!sdata.hdr_supported;
      if (Array.isArray(sdata.hdr_default_stops) && sdata.hdr_default_stops.length >= 2) {
        zs.hdrStops = sdata.hdr_default_stops;
      }
    }
  } catch {}
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
  const resultEl = $("zstack-result");
  if (resultEl) resultEl.hidden = true;
  renderThumbs();
  updateCount();
  updateInstruction();
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
    $("zstack-composite-img").src = zs.computed.compositeUrl;
    $("zstack-heightmap-img").src = zs.computed.heightmapUrl;
    $("zstack-composite-dl").href = zs.computed.compositeUrl;
    $("zstack-heightmap-dl").href = zs.computed.heightmapUrl;
    $("zstack-zrange").textContent =
      `Z ${zs.computed.minZ.toFixed(3)} → ${zs.computed.maxZ.toFixed(3)} mm`;
    $("zstack-result").hidden = false;
    showStatus(`Z-stack built: ${zs.frameCount} frames, Z range ${(zs.computed.maxZ - zs.computed.minZ).toFixed(3)} mm`);
  } finally {
    if (btn) { btn.disabled = zs.frameCount < 3; btn.textContent = "Build height map"; }
  }
}

async function resetStack() {
  await apiFetch("/zstack/reset", { method: "POST" });
  zs.frameCount = 0;
  zs.computed = null;
  clearProfile();
  const resultEl = $("zstack-result");
  if (resultEl) resultEl.hidden = true;
  renderThumbs();
  updateCount();
  updateInstruction();
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
  await startSession();
}

function closeDialog() {
  const dlg = $("zstack-dialog");
  if (dlg) dlg.hidden = true;
  window.removeEventListener("keydown", onZstackKey, true);
}

export function initZstack() {
  const btn = $("btn-zstack");
  if (btn) btn.addEventListener("click", openZstackDialog);
}
