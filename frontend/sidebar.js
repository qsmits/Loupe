import { apiFetch } from './api.js';
import { state, DETECTION_TYPES, camBounds } from './state.js';
import { redraw, resizeCanvas, showStatus, getStatus, canvas, listEl } from './render.js';
import { constraintsForAnnotation, CONSTRAINT_ICONS, CONSTRAINT_LABELS } from './constraints.js';
import { measurementLabel } from './format.js';
import { imageWidth, imageHeight, setImageSize, fitToWindow } from './viewport.js';
import { renderGearResultsPanel } from './gear.js';
import { loadReticleList, getReticleCategories, loadReticle, unloadReticle, setReticleRotation } from './reticle.js';

const _mctx = () => ({
  calibration: state.calibration,
  annotations: state.annotations,
  origin: state.origin,
  imageWidth, imageHeight,
  canvasWidth: canvas.width,
  canvasHeight: canvas.height,
});

// Shared eye-icon markup used by the per-row and global visibility toggles.
// kept in one place so the two controls stay visually identical.
const EYE_OPEN_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
  '<circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>' +
  '<path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>' +
  '<line x1="1" y1="1" x2="23" y2="23"/></svg>';

export function updateGlobalVisButton() {
  const btn = document.getElementById("btn-vis-all");
  if (!btn) return;
  const off = state._hideAllAnnotations;
  btn.innerHTML = off ? EYE_OFF_SVG : EYE_OPEN_SVG;
  btn.title = off ? "Show all annotations" : "Hide all annotations";
  btn.classList.toggle("active", off);
}

export function initGlobalVisToggle() {
  const btn = document.getElementById("btn-vis-all");
  if (!btn) return;
  btn.addEventListener("click", () => {
    state._hideAllAnnotations = !state._hideAllAnnotations;
    updateGlobalVisButton();
    redraw();
  });
  updateGlobalVisButton();
}

// ── Sidebar rendering ──────────────────────────────────────────────────────────
function _createMeasurementRow(ann, number) {
  const row = document.createElement("div");
  row.className = "measurement-item" + (state.selected.has(ann.id) ? " selected" : "");
  if (ann.hidden) row.classList.add("annotation-hidden");
  row.dataset.id = ann.id;
  const numSpan = document.createElement("span");
  numSpan.className = "measurement-number";
  numSpan.textContent = number;
  const nameInput = document.createElement("input");
  nameInput.className = "measurement-name";
  nameInput.type = "text";
  nameInput.placeholder = "Label…";
  const valSpan = document.createElement("span");
  valSpan.className = "measurement-value";
  if (ann.type === "comment") {
    const txt = String(ann.text || "").replace(/\n/g, " ");
    valSpan.textContent = txt.length > 40 ? txt.slice(0, 37) + "…" : txt;
    valSpan.style.color = "#fbbf24";
  } else {
    valSpan.textContent = measurementLabel(ann, _mctx());
  }
  // Visibility toggle — hides the annotation in the canvas without deleting it.
  // Useful when a calibration line (or anything else) is cluttering the view
  // but you still want to keep the underlying data.
  const visBtn = document.createElement("button");
  visBtn.className = "vis-btn";
  visBtn.dataset.id = ann.id;
  visBtn.innerHTML = ann.hidden ? EYE_OFF_SVG : EYE_OPEN_SVG;
  visBtn.title = ann.hidden ? "Show on canvas" : "Hide on canvas";
  visBtn.addEventListener("click", e => {
    e.stopPropagation();
    ann.hidden = !ann.hidden;
    renderSidebar();
    redraw();
  });
  const delBtn = document.createElement("button");
  delBtn.className = "del-btn";
  delBtn.dataset.id = ann.id;
  delBtn.textContent = "✕";
  row.append(numSpan, nameInput, valSpan, visBtn, delBtn);
  // Constraint chips
  const annConstraints = constraintsForAnnotation(ann.id);
  if (annConstraints.length > 0) {
    const chipContainer = document.createElement("span");
    chipContainer.className = "constraint-chips";
    for (const c of annConstraints) {
      const chip = document.createElement("span");
      chip.className = "constraint-chip";
      if (c.status === 'conflict') chip.classList.add('conflict');
      if (!c.enabled) chip.classList.add('disabled');
      const icon = CONSTRAINT_ICONS[c.type] || '?';
      const otherRef = c.refs.find(r => r.annId !== ann.id) || c.refs[1];
      const otherAnn = state.annotations.find(a => a.id === otherRef.annId);
      const otherName = otherAnn ? (otherAnn.name || '#' + otherAnn.id) : '?';
      chip.textContent = `${icon}→${otherName}`;
      chip.title = `${CONSTRAINT_LABELS[c.type] || c.type} → ${otherName}`;
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        state.selected = new Set([ann.id, otherRef.annId]);
        renderSidebar();
        redraw();
      });
      chip.addEventListener("mouseenter", () => {
        state._hoveredConstraintId = c.id;
        redraw();
      });
      chip.addEventListener("mouseleave", () => {
        state._hoveredConstraintId = null;
        redraw();
      });
      chipContainer.appendChild(chip);
    }
    row.appendChild(chipContainer);
  }
  nameInput.value = ann.name || "";
  nameInput.addEventListener("input", e => { ann.name = e.target.value; });
  nameInput.addEventListener("click", e => { e.stopPropagation(); });
  row.addEventListener("click", () => {
    const wasSelected = state.selected.has(ann.id);
    state.selected = new Set([ann.id]);
    state._flashExpiry = Date.now() + 400;
    renderSidebar();
    redraw();
    if (wasSelected) {
      const label = measurementLabel(ann, _mctx());
      if (!label) return;
      const text = ann.name ? `${ann.name}: ${label}` : label;
      navigator.clipboard.writeText(text).then(() => {
        const flashRow = listEl.querySelector(`.measurement-item[data-id="${ann.id}"]`);
        if (flashRow) { flashRow.classList.add("copied"); setTimeout(() => flashRow.classList.remove("copied"), 600); }
      }).catch(() => {});
    }
  });
  return row;
}

export function renderSidebar() {
  listEl.innerHTML = "";

  // Partition annotations into: skip, origin, grouped, ungrouped
  const skip = new Set(["edges-overlay", "preprocessed-overlay", "dxf-overlay"]);
  const visible = state.annotations.filter(a => !skip.has(a.type));

  // Separate detections from measurements
  const detections = visible.filter(a => DETECTION_TYPES.has(a.type));
  const measurements = visible.filter(a => !DETECTION_TYPES.has(a.type));

  // Build groups from state.measurementGroups (measurements only)
  const groupMap = new Map();  // groupName → [ann, ...]
  const ungrouped = [];
  for (const ann of measurements) {
    const groupName = state.measurementGroups[ann.id];
    if (groupName) {
      if (!groupMap.has(groupName)) groupMap.set(groupName, []);
      groupMap.get(groupName).push(ann);
    } else {
      // Only show measurement-purpose annotations in the main sidebar
      const isMeasurement = !ann.purpose || ann.purpose === 'measurement';
      if (isMeasurement) ungrouped.push(ann);
    }
  }

  let i = 0;

  // Render groups first
  for (const [groupName, members] of groupMap) {
    const header = document.createElement("div");
    header.className = "meas-group-header";
    const chevronSpan = document.createElement("span");
    chevronSpan.className = "meas-group-chevron";
    chevronSpan.textContent = "▾";
    const labelSpan = document.createElement("span");
    labelSpan.className = "meas-group-label";
    labelSpan.textContent = groupName;
    const countSpan = document.createElement("span");
    countSpan.className = "meas-group-count";
    countSpan.textContent = `(${members.length})`;
    header.append(chevronSpan, labelSpan, countSpan);
    header.style.cursor = "pointer";
    let collapsed = false;
    header.addEventListener("click", () => {
      collapsed = !collapsed;
      header.querySelector(".meas-group-chevron").textContent = collapsed ? "▸" : "▾";
      let sibling = header.nextElementSibling;
      while (sibling && !sibling.classList.contains("meas-group-header")) {
        if (sibling.classList.contains("meas-group-member")) sibling.hidden = collapsed;
        sibling = sibling.nextElementSibling;
      }
    });
    // Double-click to rename group
    header.addEventListener("dblclick", e => {
      e.stopPropagation();
      const labelSpan = header.querySelector(".meas-group-label");
      const input = document.createElement("input");
      input.type = "text";
      input.value = groupName;
      input.style.cssText = "width:80px; font-size:10px; padding:0 2px; background:var(--surface-3); color:var(--text); border:1px solid var(--border);";
      input.addEventListener("blur", () => {
        const newName = input.value.trim();
        if (newName && newName !== groupName) {
          for (const m of members) {
            state.measurementGroups[m.id] = newName;
          }
        }
        renderSidebar();
      });
      input.addEventListener("keydown", ev => { if (ev.key === "Enter") input.blur(); });
      labelSpan.replaceWith(input);
      input.focus(); input.select();
    });
    listEl.appendChild(header);

    for (const ann of members) {
      if (ann.type === "origin") continue;
      const number = String.fromCodePoint(9312 + i);
      i++;
      const row = _createMeasurementRow(ann, number);
      row.classList.add("meas-group-member");
      if (ann.purpose === 'drawing' || ann.purpose === 'helper') {
        const suffix = document.createElement("span");
        suffix.className = "purpose-suffix";
        suffix.textContent = ` (${ann.purpose})`;
        row.appendChild(suffix);
      }
      listEl.appendChild(row);
    }
    // Group end divider
    const divider = document.createElement("div");
    divider.className = "meas-group-end";
    listEl.appendChild(divider);
  }

  // Render ungrouped annotations
  for (const ann of ungrouped) {
    if (ann.type === "origin") {
      const row = document.createElement("div");
      row.className = "measurement-item" + (state.selected.has(ann.id) ? " selected" : "");
      const originNum = document.createElement("span");
      originNum.className = "measurement-number";
      originNum.textContent = "⊙";
      const originLabel = document.createElement("span");
      originLabel.className = "measurement-name";
      originLabel.style.cssText = "flex:1;font-size:12px;color:var(--muted)";
      originLabel.textContent = "Origin";
      const originDel = document.createElement("button");
      originDel.className = "del-btn";
      originDel.dataset.id = ann.id;
      originDel.textContent = "✕";
      row.append(originNum, originLabel, originDel);
      row.addEventListener("click", e => {
        if (e.target.classList.contains("del-btn")) return;
        state.selected = new Set([ann.id]);
        state._flashExpiry = Date.now() + 400;
        renderSidebar();
        redraw();
      });
      listEl.appendChild(row);
      continue;
    }
    const number = String.fromCodePoint(9312 + i);
    i++;
    listEl.appendChild(_createMeasurementRow(ann, number));
  }

  // Render detections (non-elevated) in a separate section
  if (detections.length > 0) {
    const detHeader = document.createElement("div");
    detHeader.className = "meas-group-header";
    detHeader.style.color = "var(--muted)";
    const detChevron = document.createElement("span");
    detChevron.className = "meas-group-chevron";
    detChevron.textContent = "▾";
    const detLabel = document.createElement("span");
    detLabel.className = "meas-group-label";
    detLabel.textContent = "Detections";
    const detCount = document.createElement("span");
    detCount.className = "meas-group-count";
    detCount.textContent = `(${detections.length})`;
    detHeader.append(detChevron, detLabel, detCount);
    detHeader.style.cursor = "pointer";
    let detCollapsed = false;
    detHeader.addEventListener("click", () => {
      detCollapsed = !detCollapsed;
      detHeader.querySelector(".meas-group-chevron").textContent = detCollapsed ? "▸" : "▾";
      let sib = detHeader.nextElementSibling;
      while (sib && !sib.classList.contains("meas-group-header")) {
        if (sib.classList.contains("det-row")) sib.hidden = detCollapsed;
        sib = sib.nextElementSibling;
      }
    });
    listEl.appendChild(detHeader);

    for (const ann of detections) {
      const row = document.createElement("div");
      row.className = "measurement-item det-row";
      row.dataset.id = ann.id;
      if (state.selected.has(ann.id)) row.classList.add("selected");
      const typeName = ann.type.replace("detected-", "").replace("-merged", "").replace("-partial", "");
      const label = measurementLabel(ann, _mctx()) || typeName;
      const detNumSpan = document.createElement("span");
      detNumSpan.className = "measurement-number";
      detNumSpan.style.color = "var(--muted)";
      detNumSpan.textContent = "⚬";
      const detValSpan = document.createElement("span");
      detValSpan.className = "measurement-value";
      detValSpan.style.cssText = "color:var(--muted);flex:1";
      detValSpan.textContent = label;
      const elevateBtn = document.createElement("button");
      elevateBtn.className = "elevate-btn";
      elevateBtn.dataset.id = ann.id;
      elevateBtn.title = "Elevate to measurement";
      elevateBtn.textContent = "↑";
      const detDelBtn = document.createElement("button");
      detDelBtn.className = "del-btn";
      detDelBtn.dataset.id = ann.id;
      detDelBtn.textContent = "✕";
      row.append(detNumSpan, detValSpan, elevateBtn, detDelBtn);
      elevateBtn.addEventListener("click", e => {
        e.stopPropagation();
        state.selected = new Set([ann.id]);
        document.dispatchEvent(new CustomEvent("elevate-selected"));
      });
      row.addEventListener("click", () => {
        state.selected = new Set([ann.id]);
        state._flashExpiry = Date.now() + 400;
        renderSidebar();
        redraw();
      });
      listEl.appendChild(row);
    }
  }

  // Show selection count in status bar when multiple selected
  if (state.selected.size > 1) {
    const detCount = [...state.selected].filter(id => {
      const a = state.annotations.find(x => x.id === id);
      return a && DETECTION_TYPES.has(a.type);
    }).length;
    const measCount = state.selected.size - detCount;
    let msg = `${state.selected.size} selected`;
    if (detCount > 0 && measCount > 0) {
      msg = `${detCount} detection${detCount > 1 ? "s" : ""}, ${measCount} measurement${measCount > 1 ? "s" : ""} selected`;
    } else if (detCount > 0) {
      msg = `${detCount} detection${detCount > 1 ? "s" : ""} selected`;
    } else if (measCount > 0) {
      msg = `${measCount} measurement${measCount > 1 ? "s" : ""} selected`;
    }
    showStatus(msg);
  }

  updateTemplateDisplay();
  renderGearResultsPanel();
  updateReticlePanel();
}

// ── Template display ───────────────────────────────────────────────────────────
export function updateTemplateDisplay() {
  const el = document.getElementById("template-info");
  const nameEl = document.getElementById("template-name-display");
  if (el && nameEl) {
    if (state._templateLoaded && state._templateName) {
      nameEl.textContent = state._templateName;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
}

// ── Tolerances config ──────────────────────────────────────────────────────────
export async function loadTolerances() {
  try {
    const r = await apiFetch("/config/tolerances");
    if (!r.ok) return;
    const cfg = await r.json();
    state.tolerances.warn = cfg.tolerance_warn;
    state.tolerances.fail = cfg.tolerance_fail;
    const warnInput = document.getElementById("tol-warn-input");
    const failInput = document.getElementById("tol-fail-input");
    if (warnInput) warnInput.value = cfg.tolerance_warn;
    if (failInput) failInput.value = cfg.tolerance_fail;
  } catch (_) {}
}

// ── UI config & calibration button ─────────────────────────────────────────────
export async function loadUiConfig() {
  try {
    const data = await apiFetch("/config/ui").then(r => r.json());
    document.documentElement.className = `theme-${data.theme || "macos-dark"}`;
    const themeSelect = document.getElementById("theme-select");
    if (themeSelect) themeSelect.value = data.theme || "macos-dark";
    if (data.hosted) {
      state._hosted = true;
      // In hosted mode use client-side JS snapping — no server round-trip.
      state.settings.subpixelMethod = "parabola-js";
      const sel = document.getElementById("subpixel-method-select");
      if (sel) {
        sel.value = "parabola-js";
        // Hide server-side options to avoid confusion; JS options remain available
        ["parabola", "gaussian"].forEach(v => {
          const opt = sel.querySelector(`option[value="${v}"]`);
          if (opt) opt.hidden = true;
        });
      }
      // Hide hardware-dependent features in hosted mode
      ["btn-stitch", "btn-superres", "btn-zstack", "btn-zstack-3d-view"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = "none";
      });
    }
    // Start the MJPEG stream only when we know there's a camera
    const streamImg = document.getElementById("stream-img");
    if (streamImg && !streamImg.src.includes("/stream") && !data.hosted) {
      streamImg.src = "/stream";
    }
    if (!data.hosted && data.subpixel_method) {
      // Prefer the JS equivalent if a server-side method is configured
      const jsMethod = data.subpixel_method === "gaussian" ? "gaussian-js"
                     : data.subpixel_method === "parabola" ? "parabola-js"
                     : data.subpixel_method;
      state.settings.subpixelMethod = jsMethod;
      const sel = document.getElementById("subpixel-method-select");
      if (sel) sel.value = jsMethod;
    }
  } catch (_) {
    // non-fatal: default theme class is already on <html>
  }
}

export function updateCalibrationButton() {
  const indicator = document.getElementById("cal-indicator");
  const statusLine = document.getElementById("cal-status-line");
  const badge = document.getElementById("cal-badge");
  if (state.calibration) {
    const scale = (1000 / state.calibration.pixelsPerMm).toFixed(3);
    if (indicator) indicator.hidden = true;
    if (statusLine) statusLine.textContent = `${scale} µm/px`;
    if (badge) {
      badge.textContent = `${scale} µm/px`;
      badge.classList.remove("uncalibrated");
      badge.classList.add("calibrated");
    }
  } else {
    if (indicator) { indicator.hidden = false; indicator.dataset.label = "NOT CALIBRATED"; }
    if (statusLine) statusLine.textContent = "Not calibrated";
    if (badge) {
      badge.textContent = "NOT CALIBRATED";
      badge.classList.remove("calibrated");
      badge.classList.add("uncalibrated");
    }
  }
}

// ── Camera info ────────────────────────────────────────────────────────────────
export async function loadCameraInfo() {
  try {
    const r = await apiFetch("/camera/info");
    const d = await r.json();
    // Set image dimensions from camera resolution so annotations are always
    // in camera-pixel coordinates, even before freeze. This prevents the
    // coordinate shift that occurs when doFreeze sets imageWidth/imageHeight.
    if (d.width > 0 && d.height > 0 && (d.width !== imageWidth || d.height !== imageHeight)) {
      setImageSize(d.width, d.height);
      // Fit viewport so the full camera frame is visible, then redraw.
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0) fitToWindow(rect.width, rect.height);
      resizeCanvas();
    }
    // Cache camera info for ROI "Set from view"
    state._cameraInfo = d;

    // Populate settings dialog camera info
    const modelEl = document.getElementById("settings-model");
    const serialEl = document.getElementById("settings-serial");
    if (modelEl) modelEl.textContent = d.model;
    if (serialEl) serialEl.textContent = d.serial;

    // Pixel format: initialise dropdown and state
    const fmtSelect = document.getElementById("pixel-format-select");
    if (fmtSelect) {
      const fmt = d.pixel_format && d.pixel_format !== "n/a" ? d.pixel_format : null;
      if (fmt) {
        fmtSelect.value = fmt;
        state.settings.pixelFormat = fmt;
      } else {
        fmtSelect.disabled = true;  // OpenCV fallback — format not configurable
      }
    }

    // White balance — initialise sliders and enable/disable based on availability
    const wbAvailable = d.pixel_format && d.pixel_format !== "n/a";
    const wbManual = wbAvailable && (d.wb_manual_supported ?? true);
    ["red", "green", "blue"].forEach(ch => {
      const slider = document.getElementById(`wb-${ch}-slider`);
      const display = document.getElementById(`wb-${ch}-value`);
      if (slider) {
        slider.value = d[`wb_${ch}`] ?? 1.0;
        if (display) display.textContent = parseFloat(slider.value).toFixed(2);
        slider.disabled = !wbManual;
      }
    });
    const wbAutoBtn = document.getElementById("btn-wb-auto");
    if (wbAutoBtn) wbAutoBtn.disabled = !wbAvailable;

    // ── Camera dropdown (top bar) ──
    const el = id => document.getElementById(id);

    // Resolution display
    if (el("camera-res-display")) el("camera-res-display").textContent = `${d.width} × ${d.height}`;

    // Exposure & gain (top bar) — log-scale slider + number input.
    // Bounds come from the camera so the slider actually spans the usable range.
    if (d.exposure_min != null && d.exposure_max != null && d.exposure_max > d.exposure_min) {
      camBounds.expMin = d.exposure_min;
      camBounds.expMax = d.exposure_max;
    }
    if (d.gain_min != null && d.gain_max != null && d.gain_max > d.gain_min) {
      camBounds.gainMin = d.gain_min;
      camBounds.gainMax = d.gain_max;
    }

    const expUs = Math.max(camBounds.expMin, Math.min(camBounds.expMax, Math.round(d.exposure || camBounds.expMin)));
    if (el("exp-slider-top")) {
      el("exp-slider-top").value = Math.round(
        Math.log(expUs / camBounds.expMin) / Math.log(camBounds.expMax / camBounds.expMin) * 1000
      );
    }
    if (el("exp-input-top") && document.activeElement !== el("exp-input-top")) {
      el("exp-input-top").min = Math.round(camBounds.expMin);
      el("exp-input-top").max = Math.round(camBounds.expMax);
      el("exp-input-top").value = expUs;
    }

    const gainLo = camBounds.gainMin > 0 ? camBounds.gainMin : 0.01;
    const gainHi = camBounds.gainMax;
    const gainVal = Math.max(gainLo, Math.min(gainHi, Number(d.gain) || gainLo));
    const gainDigits = gainHi > 50 ? 2 : 1;
    if (el("gain-slider-top")) {
      el("gain-slider-top").min = 0;
      el("gain-slider-top").max = 1000;
      el("gain-slider-top").step = 1;
      el("gain-slider-top").value = Math.round(
        Math.log(gainVal / gainLo) / Math.log(gainHi / gainLo) * 1000
      );
    }
    if (el("gain-input-top") && document.activeElement !== el("gain-input-top")) {
      el("gain-input-top").min = camBounds.gainMin;
      el("gain-input-top").max = gainHi;
      // Pick a sensible step for the number field based on range magnitude.
      el("gain-input-top").step = gainHi > 50 ? 0.1 : 0.01;
      el("gain-input-top").value = gainVal.toFixed(gainDigits);
    }

    // Pixel format (top bar)
    if (el("pixel-format-top")) {
      const fmt = d.pixel_format && d.pixel_format !== "n/a" ? d.pixel_format : null;
      if (fmt) el("pixel-format-top").value = fmt;
    }

    // Gamma
    if (el("gamma-slider") && d.gamma != null) {
      el("gamma-slider").value = d.gamma;
      if (d.gamma_min != null) el("gamma-slider").min = d.gamma_min;
      if (d.gamma_max != null) el("gamma-slider").max = d.gamma_max;
    }
    if (el("gamma-value") && d.gamma != null) el("gamma-value").textContent = d.gamma.toFixed(1);

    // WB sliders (top bar)
    ["red", "green", "blue"].forEach(ch => {
      const sliderTop = el(`wb-${ch}-slider-top`);
      const displayTop = el(`wb-${ch}-value-top`);
      if (sliderTop) sliderTop.value = d[`wb_${ch}`] ?? 1.0;
      if (displayTop) displayTop.textContent = parseFloat(sliderTop?.value ?? 1.0).toFixed(2);
    });

    // Capability-based visibility
    const sup = d.supports || {};
    if (el("gamma-row")) el("gamma-row").hidden = !sup.gamma;
    // Auto Exposure is always available — implemented client-side in main.js
    // as a histogram-driven bisection loop. Works even on cameras that don't
    // expose a hardware ExposureAuto feature.
    if (el("wb-section")) el("wb-section").hidden = !sup.wb_manual;
    if (el("btn-wb-auto-top")) el("btn-wb-auto-top").hidden = !(sup.wb_auto ?? true);
    if (el("roi-section")) el("roi-section").hidden = !sup.roi;

    // ROI info
    if (el("roi-info") && d.roi) {
      const roi = d.roi;
      const isFullFrame = roi.offset_x === 0 && roi.offset_y === 0 &&
        roi.width === d.sensor_width && roi.height === d.sensor_height;
      el("roi-info").textContent = isFullFrame
        ? "Full frame"
        : `${roi.width}×${roi.height} @ (${roi.offset_x}, ${roi.offset_y})`;
    } else if (el("roi-info")) {
      el("roi-info").textContent = "Full frame";
    }

    if (d.no_camera === true && !state._noCamera) {
      state._noCamera = true;
      document.body.classList.add("no-camera");
      showStatus("No camera — image only");
      updateDropOverlay();
    }
  } catch { /* camera unavailable */ }
}

export function updateDropOverlay() {
  const overlay = document.getElementById("drop-overlay");
  if (!overlay) return;
  overlay.classList.toggle("visible", state._noCamera && !state.frozen && !state.browserCamera?.active);
}

export function updateFreezeUI() {
  const btn = document.getElementById("btn-freeze");
  if (state.frozen) {
    btn.textContent = "❄ Frozen";
    btn.classList.replace("freeze-live", "freeze-frozen");
    showStatus("● Frozen");
  } else {
    btn.textContent = "❄ Live";
    btn.classList.replace("freeze-frozen", "freeze-live");
    showStatus("● Live");
  }
  updateDropOverlay();
}

// ── Startup warning ────────────────────────────────────────────────────────────
export async function checkStartupWarning() {
  try {
    const r = await apiFetch("/camera/startup-warning");
    const d = await r.json();
    if (d.warning) {
      const prev = { text: getStatus() };
      showStatus(d.warning);
      setTimeout(() => {
        showStatus(prev.text);
      }, 8000);
    }
  } catch (_) {
    // Non-fatal: silently ignore network or parse errors
  }
}

export async function loadCameraList() {
  const sel = document.getElementById("camera-select");
  const selTop = document.getElementById("camera-select-top");
  try {
    const [camerasResp, infoResp] = await Promise.all([
      apiFetch("/cameras"),
      apiFetch("/camera/info"),
    ]);
    const cameras = await camerasResp.json();
    const info = await infoResp.json();
    const activeDeviceId = state.browserCamera?.deviceId;
    const currentId = state.browserCamera?.active
      ? (activeDeviceId ? `browser-cam-${activeDeviceId}` : "browser-cam")
      : (info.device_id ?? "");
    // Group cameras by backend so the dropdown visually separates the "real"
    // scientific camera from webcams and browser devices. Aravis cameras come
    // from /cameras with non-"Webcam" vendors; OpenCV entries have id starting
    // with "opencv-"; the rest are browser devices we synthesize locally.
    const sciCams = cameras.filter(c => !c.id.startsWith("opencv-"));
    const webCams = cameras.filter(c => c.id.startsWith("opencv-"));
    const browserDevices = state.browserCameraDevices;
    const browserEntries = browserDevices && browserDevices.length > 0
      ? browserDevices.map(d => ({ id: `browser-cam-${d.deviceId}`, label: d.label }))
      : [{ id: "browser-cam", label: "Default webcam" }];

    // When no hardware cameras are available and browser cam isn't active yet,
    // a placeholder forces the user to make a real selection — without it the
    // browser-cam entry is pre-selected and change never fires.
    const needsPlaceholder = cameras.length === 0 && !state.browserCamera?.active;

    const groups = [
      ["Scientific cameras", sciCams],
      ["Webcams", webCams],
      ["Browser cameras", browserEntries],
    ];

    for (const target of [sel, selTop]) {
      if (!target) continue;
      target.innerHTML = "";
      if (needsPlaceholder) {
        const ph = document.createElement("option");
        ph.value = "";
        ph.disabled = true;
        ph.selected = true;
        ph.textContent = "Select camera…";
        target.appendChild(ph);
      }
      for (const [label, entries] of groups) {
        if (entries.length === 0) continue;
        const og = document.createElement("optgroup");
        og.label = label;
        for (const c of entries) {
          const opt = document.createElement("option");
          opt.value = c.id;
          opt.textContent = c.label;
          if (!needsPlaceholder && c.id === currentId) opt.selected = true;
          og.appendChild(opt);
        }
        target.appendChild(og);
      }
      target.disabled = false;
    }
  } catch {
    for (const target of [sel, selTop]) {
      if (!target) continue;
      target.innerHTML = "";
      const opt = document.createElement("option");
      opt.textContent = "Unavailable";
      target.appendChild(opt);
      target.disabled = true;
    }
  }
}

function scaleText() {
  const cal = state.calibration;
  if (!cal) return "Uncalibrated";
  const pxPerUnit = cal.displayUnit === "µm"
    ? cal.pixelsPerMm / 1000
    : cal.pixelsPerMm;
  return `1 px = ${(1/pxPerUnit).toFixed(3)} ${cal.displayUnit}`;
}

export function updateCameraInfo() {
  const el = document.getElementById("scale-display");
  if (el) el.textContent = scaleText();
}

export function updateDxfControlsVisibility() {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  const group = document.getElementById("dxf-controls-group");
  if (group) group.hidden = !ann;
  if (ann) {
    const display = document.getElementById("dxf-angle-display");
    if (display) display.textContent = `${(ann.angle ?? 0).toFixed(1)}°`;
    const scaleInput = document.getElementById("dxf-scale");
    if (scaleInput) scaleInput.value = (ann.scale ?? 1).toFixed(3);
    const fH = document.getElementById("btn-dxf-flip-h");
    if (fH) fH.classList.toggle("active", ann.flipH ?? false);
    const fV = document.getElementById("btn-dxf-flip-v");
    if (fV) fV.classList.toggle("active", ann.flipV ?? false);
  }
  const autoAlignBtn = document.getElementById("btn-auto-align");
  if (autoAlignBtn) {
    autoAlignBtn.disabled = !ann;
    autoAlignBtn.title = !ann ? "Load a DXF first" : "Auto-align DXF to image (edge or circle matching)";
  }
  const inspBtn = document.getElementById("btn-run-inspection");
  if (inspBtn) {
    inspBtn.disabled = !ann;
    inspBtn.title = !ann ? "Load a DXF and detect features first" : "Run DXF inspection";
  }
  const moveBtn = document.getElementById("btn-dxf-move");
  if (moveBtn) {
    moveBtn.disabled = !ann;
    moveBtn.title = !ann ? "Load a DXF first" : "Drag to reposition DXF overlay";
  }
}

// ── Inspection result table ────────────────────────────────────────────────────
export function renderInspectionTable() {
  const panel = document.getElementById("inspection-panel");
  if (!panel) return;

  if (!state.inspectionResults || state.inspectionResults.length === 0) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  const countEl = document.getElementById("inspection-count");
  const tbody = document.getElementById("inspection-tbody");
  if (!tbody) return;

  // Group results
  const groups = new Map();  // groupKey → []
  for (const r of state.inspectionResults) {
    const key = r.parent_handle || r.handle;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  // Summary
  const total = state.inspectionResults.length;
  const failed = state.inspectionResults.filter(r => r.pass_fail === "fail").length;
  const warned = state.inspectionResults.filter(r => r.pass_fail === "warn").length;
  const matched = state.inspectionResults.filter(r => r.matched).length;
  if (countEl) {
    countEl.textContent = failed > 0
      ? `${matched}/${total} matched — ${failed} FAIL`
      : warned > 0
        ? `${matched}/${total} matched — ${warned} WARN`
        : `${matched}/${total} matched — all PASS`;
  }

  tbody.innerHTML = "";
  let featureNum = 0;

  for (const [groupKey, results] of groups) {
    // Determine group name
    const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
    const entity = dxfAnn?.entities?.find(e => e.handle === groupKey || e.parent_handle === groupKey);
    const layer = entity?.layer;
    const defaultName = (layer && layer !== "0") ? layer : groupKey;
    const groupName = state.featureNames[groupKey] || defaultName;

    // Worst-case result
    const worstResult = results.some(r => r.pass_fail === "fail") ? "fail"
      : results.some(r => r.pass_fail === "warn") ? "warn"
      : results.some(r => r.matched) ? "pass" : "unmatched";

    const segCount = results.length;

    // Group header row
    const headerTr = document.createElement("tr");
    headerTr.className = "insp-group-header";
    const badgeClass = worstResult === "fail" ? "badge-fail"
      : worstResult === "warn" ? "badge-warn"
      : worstResult === "pass" ? "badge-pass" : "badge-unmatched";

    const mode = state.featureModes[groupKey] || "die";
    const modeLabel = mode === "punch" ? "P" : "D";
    const modeClass = mode === "punch" ? "mode-punch" : "mode-die";

    const nameTd = document.createElement("td");
    nameTd.colSpan = 4;
    nameTd.className = "insp-group-name";
    const inspChevron = document.createElement("span");
    inspChevron.className = "insp-chevron";
    inspChevron.textContent = "▾";
    const inspMode = document.createElement("span");
    inspMode.className = `insp-mode ${modeClass}`;
    inspMode.title = mode === "punch" ? "Punch (outer)" : "Die (cavity)";
    inspMode.textContent = modeLabel;
    const inspGroupLabel = document.createElement("span");
    inspGroupLabel.className = "insp-group-label";
    inspGroupLabel.textContent = groupName;
    const inspGroupCount = document.createElement("span");
    inspGroupCount.className = "insp-group-count";
    inspGroupCount.textContent = `(${segCount})`;
    nameTd.append(inspChevron, inspMode, inspGroupLabel, inspGroupCount);
    const badgeTd = document.createElement("td");
    const inspBadge = document.createElement("span");
    inspBadge.className = `insp-badge ${badgeClass}`;
    inspBadge.textContent = worstResult === "unmatched" ? "—" : worstResult.toUpperCase();
    badgeTd.appendChild(inspBadge);
    headerTr.append(nameTd, badgeTd);

    // Hover: highlight all handles in group
    headerTr.addEventListener("mouseenter", () => {
      state.inspectionHoverHandle = groupKey;
      redraw();
    });
    headerTr.addEventListener("mouseleave", () => {
      state.inspectionHoverHandle = null;
      redraw();
    });

    // Click to collapse/expand
    let collapsed = false;
    headerTr.style.cursor = "pointer";
    headerTr.addEventListener("click", () => {
      collapsed = !collapsed;
      headerTr.querySelector(".insp-chevron").textContent = collapsed ? "▸" : "▾";
      // Toggle visibility of detail rows. When expanding a gear-style
      // group, per-segment drill-down rows (class "insp-tooth-detail")
      // stay hidden — the user must click a tooth row to see them.
      // Also reset any open tooth chevrons back to their collapsed glyph.
      let sibling = headerTr.nextElementSibling;
      while (sibling && !sibling.classList.contains("insp-group-header")) {
        if (collapsed) {
          sibling.hidden = true;
        } else {
          if (sibling.classList.contains("insp-tooth-detail")) {
            sibling.hidden = true;
          } else {
            sibling.hidden = false;
            const tchev = sibling.querySelector(".insp-tooth-chevron");
            if (tchev) tchev.textContent = "▸";
          }
        }
        sibling = sibling.nextElementSibling;
      }
    });

    // Double-click to rename
    headerTr.addEventListener("dblclick", e => {
      e.stopPropagation();
      const labelSpan = headerTr.querySelector(".insp-group-label");
      const input = document.createElement("input");
      input.type = "text";
      input.value = state.featureNames[groupKey] || defaultName;
      input.style.cssText = "width:80px; font-size:10px; padding:0 2px; background:var(--surface-3); color:var(--text); border:1px solid var(--border);";
      input.addEventListener("blur", () => {
        const val = input.value.trim();
        if (val && val !== defaultName) state.featureNames[groupKey] = val;
        else delete state.featureNames[groupKey];
        renderInspectionTable();
      });
      input.addEventListener("keydown", ev => {
        if (ev.key === "Enter") input.blur();
        if (ev.key === "Escape") { delete state.featureNames[groupKey]; renderInspectionTable(); }
      });
      labelSpan.replaceWith(input);
      input.focus();
      input.select();
    });

    tbody.appendChild(headerTr);

    // ── Per-tooth aggregation (gears only) ────────────────────────────
    // If every entity in this group carries a `tooth_index`, render one
    // row per tooth showing the worst-case deviation, with drill-down
    // into the per-segment rows on click. This keeps a 17-tooth gear
    // inspection at ~17 rows instead of ~650.
    const entitiesByHandle = new Map();
    for (const e of (dxfAnn?.entities || [])) entitiesByHandle.set(e.handle, e);
    const resultMeta = results.map(r => {
      const e = entitiesByHandle.get(r.handle);
      return {
        r,
        tooth: e && typeof e.tooth_index === "number" ? e.tooth_index : null,
        region: e?.region || null,
      };
    });
    const hasToothIndex = resultMeta.length > 0 && resultMeta.every(m => m.tooth !== null);

    if (hasToothIndex) {
      // Bucket by tooth.
      const byTooth = new Map();  // tooth_index → [meta]
      for (const m of resultMeta) {
        if (!byTooth.has(m.tooth)) byTooth.set(m.tooth, []);
        byTooth.get(m.tooth).push(m);
      }
      const sortedTeeth = [...byTooth.keys()].sort((a, b) => a - b);

      const rankPF = pf => (pf === "fail" ? 2 : pf === "warn" ? 1 : 0);

      for (const tooth of sortedTeeth) {
        const bucket = byTooth.get(tooth);
        // Worst-case by pass/fail, tie-break by |deviation_mm|.
        let worst = null;
        for (const m of bucket) {
          if (!m.r.matched) continue;
          if (worst === null) { worst = m; continue; }
          const aP = rankPF(m.r.pass_fail);
          const bP = rankPF(worst.r.pass_fail);
          if (aP > bP) { worst = m; continue; }
          if (aP < bP) continue;
          const ad = Math.abs(m.r.deviation_mm ?? 0);
          const bd = Math.abs(worst.r.deviation_mm ?? 0);
          if (ad > bd) worst = m;
        }

        const toothTr = document.createElement("tr");
        toothTr.className = "insp-tooth-row";
        toothTr.style.cursor = "pointer";

        const worstPF = worst ? worst.r.pass_fail : null;
        let tBadgeClass, tBadgeText;
        if (!worst) { tBadgeClass = "badge-unmatched"; tBadgeText = "—"; }
        else if (worstPF === "fail") { tBadgeClass = "badge-fail"; tBadgeText = "FAIL"; }
        else if (worstPF === "warn") { tBadgeClass = "badge-warn"; tBadgeText = "WARN"; }
        else { tBadgeClass = "badge-pass"; tBadgeText = "PASS"; }

        const nameTd2 = document.createElement("td");
        nameTd2.className = "insp-handle";
        const chev = document.createElement("span");
        chev.className = "insp-chevron insp-tooth-chevron";
        chev.textContent = "▸";
        chev.style.marginRight = "4px";
        nameTd2.appendChild(chev);
        nameTd2.appendChild(document.createTextNode(`T${tooth}`));

        const typeTd = document.createElement("td");
        typeTd.className = "insp-type";
        typeTd.textContent = worst?.region || "";

        const devTd = document.createElement("td");
        devTd.className = "insp-dev";
        if (worst && worst.r.deviation_mm != null) {
          devTd.textContent = worst.r.deviation_mm.toFixed(4) + " mm";
        } else {
          devTd.textContent = "—";
        }

        const tolTd = document.createElement("td");
        tolTd.className = "insp-tol";
        if (worst) tolTd.textContent = `±${worst.r.tolerance_warn}/${worst.r.tolerance_fail}`;

        const statusTd = document.createElement("td");
        const tBadge = document.createElement("span");
        tBadge.className = `insp-badge ${tBadgeClass}`;
        tBadge.textContent = tBadgeText;
        statusTd.appendChild(tBadge);
        const cntSpan = document.createElement("span");
        cntSpan.className = "insp-group-count";
        cntSpan.textContent = ` (${bucket.length})`;
        statusTd.appendChild(cntSpan);

        toothTr.append(nameTd2, typeTd, devTd, tolTd, statusTd);

        // Hover: highlight all handles in this tooth.
        const toothHandles = bucket.map(m => m.r.handle);
        toothTr.addEventListener("mouseenter", () => {
          state.inspectionHoverHandle = toothHandles;
          redraw();
        });
        toothTr.addEventListener("mouseleave", () => {
          state.inspectionHoverHandle = null;
          redraw();
        });

        // Track detail rows so we can toggle them when the tooth row is clicked.
        const detailRows = [];

        toothTr.addEventListener("click", () => {
          if (detailRows.length === 0) return;
          const hidden = detailRows[0].hidden;
          for (const dr of detailRows) dr.hidden = !hidden;
          chev.textContent = hidden ? "▾" : "▸";
        });

        tbody.appendChild(toothTr);

        // Per-segment drill-down rows (hidden by default).
        for (const m of bucket) {
          const r = m.r;
          featureNum++;
          const tr = document.createElement("tr");
          tr.className = "insp-detail-row insp-tooth-detail";
          tr.hidden = true;

          let deviationText = "—";
          if (r.matched && r.deviation_mm != null) deviationText = r.deviation_mm.toFixed(4) + " mm";

          let badgeClass2, badgeText;
          if (!r.matched) { badgeClass2 = "badge-unmatched"; badgeText = "—"; }
          else if (r.pass_fail === "pass") { badgeClass2 = "badge-pass"; badgeText = "PASS"; }
          else if (r.pass_fail === "warn") { badgeClass2 = "badge-warn"; badgeText = "WARN"; }
          else { badgeClass2 = "badge-fail"; badgeText = "FAIL"; }

          const handleTd = document.createElement("td");
          handleTd.className = "insp-handle";
          handleTd.style.paddingLeft = "20px";
          handleTd.textContent = `s${r.handle.match(/_s(\d+)$/)?.[1] ?? r.handle}`;
          const typeTd2 = document.createElement("td");
          typeTd2.className = "insp-type";
          typeTd2.textContent = m.region || "";
          const devTd2 = document.createElement("td");
          devTd2.className = "insp-dev";
          devTd2.textContent = deviationText;
          const tolTd2 = document.createElement("td");
          tolTd2.className = "insp-tol";
          tolTd2.textContent = `±${r.tolerance_warn}/${r.tolerance_fail}`;
          const statusTd2 = document.createElement("td");
          const b2 = document.createElement("span");
          b2.className = `insp-badge ${badgeClass2}`;
          b2.textContent = badgeText;
          statusTd2.appendChild(b2);
          tr.append(handleTd, typeTd2, devTd2, tolTd2, statusTd2);

          tr.addEventListener("mouseenter", () => {
            state.inspectionHoverHandle = r.handle;
            redraw();
          });
          tr.addEventListener("mouseleave", () => {
            state.inspectionHoverHandle = null;
            redraw();
          });

          tbody.appendChild(tr);
          detailRows.push(tr);
        }
      }
      // Skip the default flat-list rendering for this group.
      continue;
    }

    // Detail rows for each result in group (non-gear groups)
    for (const r of results) {
      featureNum++;
      const tr = document.createElement("tr");
      tr.className = "insp-detail-row";

      let deviationText = "—";
      if (r.matched && r.deviation_mm != null) {
          deviationText = r.deviation_mm.toFixed(4) + " mm";
          if (r.tp_dev_mm != null) {
              deviationText += `  TP \u2300${r.tp_dev_mm.toFixed(4)}`;
          }
          if (r.profile_mm != null) {
              deviationText += `  \u23e5${r.profile_mm.toFixed(4)}`;
          }
      }

      let deviationTitle = "";
      if (r.profile_mm != null) {
          deviationTitle += `Profile of a line: \u23e5${r.profile_mm.toFixed(4)} mm\n`;
      }
      if (r.tp_dev_mm != null && r.dx_px != null) {
          const angle = state.origin?.angle ?? 0;
          const cosA = Math.cos(-angle);
          const sinA = Math.sin(-angle);
          const ppm = state.calibration?.pixelsPerMm || 1;
          const datumDx = (r.dx_px * cosA - r.dy_px * sinA) / ppm;
          const datumDy = -(r.dx_px * sinA + r.dy_px * cosA) / ppm;  // Y-flip: image Y-down → drawing Y-up
          deviationTitle += `True Position: \u2300${r.tp_dev_mm.toFixed(4)} mm\n` +
              `Center: ${r.deviation_mm.toFixed(4)} mm\n` +
              `Datum X: ${datumDx >= 0 ? "+" : ""}${datumDx.toFixed(4)} mm\n` +
              `Datum Y: ${datumDy >= 0 ? "+" : ""}${datumDy.toFixed(4)} mm`;
      }

      let badgeClass2, badgeText;
      if (!r.matched) {
        badgeClass2 = "badge-unmatched"; badgeText = "—";
      } else if (r.pass_fail === "pass") {
        badgeClass2 = "badge-pass"; badgeText = "PASS";
      } else if (r.pass_fail === "warn") {
        badgeClass2 = "badge-warn"; badgeText = "WARN";
      } else {
        badgeClass2 = "badge-fail"; badgeText = "FAIL";
      }

      const sourceText = r.source === "manual" ? "M" : "";

      const handleTd = document.createElement("td");
      handleTd.className = "insp-handle";
      const numSpan2 = document.createElement("span");
      numSpan2.className = "insp-num";
      numSpan2.textContent = featureNum;
      handleTd.appendChild(numSpan2);
      handleTd.appendChild(document.createTextNode(r.handle));
      const typeTd = document.createElement("td");
      typeTd.className = "insp-type";
      typeTd.textContent = r.type.replace("polyline_", "p_");
      const devTd = document.createElement("td");
      devTd.className = "insp-dev";
      devTd.title = deviationTitle;
      devTd.textContent = deviationText;
      const tolTd = document.createElement("td");
      tolTd.className = "insp-tol";
      tolTd.textContent = `±${r.tolerance_warn}/${r.tolerance_fail}`;
      const statusTd = document.createElement("td");
      const badge2 = document.createElement("span");
      badge2.className = `insp-badge ${badgeClass2}`;
      badge2.textContent = badgeText;
      statusTd.appendChild(badge2);
      if (sourceText) {
        const srcSpan = document.createElement("span");
        srcSpan.className = "insp-source";
        srcSpan.textContent = sourceText;
        statusTd.appendChild(srcSpan);
      }
      tr.append(handleTd, typeTd, devTd, tolTd, statusTd);

      // Hover: highlight just this handle
      tr.addEventListener("mouseenter", () => {
        state.inspectionHoverHandle = r.handle;
        redraw();
      });
      tr.addEventListener("mouseleave", () => {
        state.inspectionHoverHandle = null;
        redraw();
      });

      // Click unmatched to enter point-pick
      if (!r.matched) {
        tr.style.cursor = "pointer";
        tr.title = "Click to measure manually";
        tr.addEventListener("click", () => {
          const ann = state.annotations.find(a => a.type === "dxf-overlay");
          if (!ann) return;
          const entity = ann.entities.find(e => e.handle === r.handle);
          if (!entity) return;
          const ph = entity.parent_handle;
          if (ph) {
            state.inspectionPickTarget = ann.entities.filter(e => e.parent_handle === ph);
          } else {
            state.inspectionPickTarget = [entity];
          }
          state.inspectionPickPoints = [];
          state.inspectionPickFit = null;
          const n = state.inspectionPickTarget.length;
          showStatus(n > 1
            ? `${n} segments. Click points along edge. Double-click or Enter to finish.`
            : "Click points along edge. Double-click or Enter to finish.");
          redraw();
        });
      }

      tbody.appendChild(tr);
    }
  }

  // Show/hide Save Run button
  const saveRunBtn = document.getElementById("btn-save-run");
  if (saveRunBtn) saveRunBtn.hidden = state.inspectionResults.length === 0;

  // Wire collapse toggle (idempotent)
  const toggle = document.getElementById("inspection-toggle");
  const wrap = document.getElementById("inspection-table-wrap");
  const chevron = document.getElementById("inspection-chevron");
  if (toggle && !toggle._m4wired) {
    toggle._m4wired = true;
    toggle.addEventListener("click", () => {
      const c = wrap.hidden;
      wrap.hidden = !c;
      if (chevron) chevron.textContent = c ? "▾" : "▸";
    });
  }

  // Show selection count in status bar
  if (state.selected.size > 1) {
    const detCount = [...state.selected].filter(id => {
      const a = state.annotations.find(x => x.id === id);
      return a && DETECTION_TYPES.has(a.type);
    }).length;
    const measCount = state.selected.size - detCount;
    let msg = `${state.selected.size} selected`;
    if (detCount > 0 && measCount > 0) {
      msg = `${detCount} detection${detCount > 1 ? "s" : ""}, ${measCount} measurement${measCount > 1 ? "s" : ""} selected`;
    } else if (detCount > 0) {
      msg = `${detCount} detection${detCount > 1 ? "s" : ""} selected`;
    } else if (measCount > 0) {
      msg = `${measCount} measurement${measCount > 1 ? "s" : ""} selected`;
    }
    showStatus(msg);
  }
}

// ── Reticle panel ─────────────────────────────────────────────────────────────

export function updateReticlePanel() {
  const controls = document.getElementById('reticle-menu-controls');
  const angleEl = document.getElementById('reticle-menu-angle');

  if (angleEl) {
    angleEl.textContent = `${(state.reticleRotationDeg || 0).toFixed(1)}°`;
  }
  if (controls) {
    controls.hidden = !state.activeReticle || !!state.activeReticle.crosshair;
  }

  // Sync dropdown value if reticle was unloaded externally
  if (!state.activeReticle) {
    _syncReticleSelects('');
  }
}

/** Populate a <select> element with reticle categories (including crosshair). */
function _populateReticleSelect(select, categories) {
  select.innerHTML = '<option value="">None</option>';
  for (const [cat, items] of Object.entries(categories)) {
    const group = document.createElement('optgroup');
    group.label = cat.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = `${cat}/${item.file}`;
      opt.textContent = item.name;
      group.appendChild(opt);
    }
    select.appendChild(group);
  }
}

/** All reticle <select> elements — kept in sync. */
const _reticleSelects = [];

function _syncReticleSelects(value) {
  for (const sel of _reticleSelects) sel.value = value;
}

async function _onReticleSelectChange(value) {
  if (!value) {
    unloadReticle();
    // Also clear the old crosshair toggle state
    state.crosshair = false;
    document.getElementById('btn-crosshair')?.classList.remove('active');
    _syncReticleSelects('');
    return;
  }
  const [cat, file] = value.split('/');
  await loadReticle(cat, file);
  // If crosshair selected, sync the old toggle button state
  state.crosshair = (cat === 'crosshair');
  document.getElementById('btn-crosshair')?.classList.toggle('active', state.crosshair);
  if (state.crosshair) {
    state.reticleColorOverride = state.settings.crosshairColor;
    state.reticleOpacityOverride = state.settings.crosshairOpacity;
    redraw();
  }
  _syncReticleSelects(value);
}

export async function initReticlePanel() {
  const categories = await loadReticleList();

  // Wire up reticle <select> element in overlay menu
  for (const id of ['reticle-menu-select']) {
    const select = document.getElementById(id);
    if (!select) continue;
    _populateReticleSelect(select, categories);
    _reticleSelects.push(select);
    select.addEventListener('change', () => _onReticleSelectChange(select.value));
  }

  document.getElementById('reticle-menu-reset-rotation')?.addEventListener('click', () => {
    setReticleRotation(0);
  });

  document.getElementById('reticle-menu-color')?.addEventListener('input', e => {
    state.reticleColorOverride = e.target.value;
    redraw();
  });

  document.getElementById('reticle-menu-opacity')?.addEventListener('input', e => {
    state.reticleOpacityOverride = parseFloat(e.target.value);
    redraw();
  });
}
