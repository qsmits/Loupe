import { state } from './state.js';
import { redraw, showStatus, getStatus, measurementLabel, listEl, cameraInfoEl } from './render.js';

// ── Sidebar rendering ──────────────────────────────────────────────────────────
export function renderSidebar() {
  listEl.innerHTML = "";
  let i = 0;
  state.annotations.forEach(ann => {
    if (ann.type === "edges-overlay" || ann.type === "preprocessed-overlay") return;
    if (ann.type === "dxf-overlay") return;  // DXF overlay is drawn on canvas, not in sidebar
    // Origin annotation: rendered without a measurement number
    if (ann.type === "origin") {
      const row = document.createElement("div");
      row.className = "measurement-item" + (ann.id === state.selected ? " selected" : "");
      row.innerHTML = `
        <span class="measurement-number">⊙</span>
        <span class="measurement-name" style="flex:1;font-size:12px;color:var(--muted)">Origin</span>
        <button class="del-btn" data-id="${ann.id}">✕</button>`;
      row.addEventListener("click", e => {
        if (e.target.classList.contains("del-btn")) return;
        state.selected = ann.id;
        renderSidebar();
        redraw();
      });
      listEl.appendChild(row);
      return; // skip i++
    }
    const number = String.fromCodePoint(9312 + i);
    i++;
    const row = document.createElement("div");
    row.className = "measurement-item" + (ann.id === state.selected ? " selected" : "");
    row.dataset.id = ann.id;
    row.innerHTML = `
      <span class="measurement-number">${number}</span>
      <input class="measurement-name" type="text" placeholder="Label…">
      <span class="measurement-value">${measurementLabel(ann)}</span>
      <button class="del-btn" data-id="${ann.id}">✕</button>`;
    row.querySelector(".measurement-name").value = ann.name;
    row.querySelector(".measurement-name").addEventListener("input", e => {
      ann.name = e.target.value;
    });
    row.querySelector(".measurement-name").addEventListener("click", e => {
      e.stopPropagation();
    });
    row.addEventListener("click", () => {
      const wasSelected = state.selected === ann.id;
      state.selected = ann.id;
      renderSidebar();
      redraw();
      if (wasSelected) {
        const label = measurementLabel(ann);
        if (!label) return; // origin or unknown — nothing to copy
        const text = ann.name ? `${ann.name}: ${label}` : label;
        navigator.clipboard.writeText(text).then(() => {
          // Flash the newly re-rendered row
          const flashRow = listEl.querySelector(`.measurement-item[data-id="${ann.id}"]`);
          if (flashRow) {
            flashRow.classList.add("copied");
            setTimeout(() => flashRow.classList.remove("copied"), 600);
          }
        }).catch(() => { /* clipboard unavailable — silent no-op */ });
      }
    });
    listEl.appendChild(row);
  });
}

// ── Tolerances config ──────────────────────────────────────────────────────────
export async function loadTolerances() {
  try {
    const r = await fetch("/config/tolerances");
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
    const data = await fetch("/config/ui").then(r => r.json());
    document.getElementById("app-title").textContent = data.app_name || "Microscope";
    document.title = data.app_name || "Microscope";
    document.documentElement.className = `theme-${data.theme || "macos-dark"}`;
    const nameInput = document.getElementById("app-name-input");
    if (nameInput) nameInput.value = data.app_name || "Microscope";
    const themeSelect = document.getElementById("theme-select");
    if (themeSelect) themeSelect.value = data.theme || "macos-dark";
  } catch (_) {
    // non-fatal: default theme class is already on <html>
  }
}

export function updateCalibrationButton() {
  const btn = document.getElementById("btn-calibration");
  if (!btn) return;
  if (state.calibration) {
    const scale = (1000 / state.calibration.pixelsPerMm).toFixed(3);
    btn.textContent = `${scale} µm/px`;
    btn.classList.remove("uncalibrated");
    btn.classList.add("calibrated");
  } else {
    btn.textContent = "NOT CALIBRATED";
    btn.classList.remove("calibrated");
    btn.classList.add("uncalibrated");
  }
}

// ── Camera info ────────────────────────────────────────────────────────────────
export async function loadCameraInfo() {
  try {
    const r = await fetch("/camera/info");
    const d = await r.json();
    cameraInfoEl.innerHTML =
      `<div>${d.model}</div>` +
      `<div style="color:var(--muted)">${d.width}×${d.height}</div>` +
      `<div id="scale-display">${state.calibration ? scaleText() : "Uncalibrated"}</div>`;
    document.getElementById("exp-slider").value = d.exposure;
    document.getElementById("exp-value").textContent = `${d.exposure} µs`;
    document.getElementById("gain-slider").value = d.gain;
    document.getElementById("gain-value").textContent = `${d.gain} dB`;
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

    if (d.no_camera === true && !state._noCamera) {
      state._noCamera = true;
      document.body.classList.add("no-camera");
      showStatus("No camera — image only");
      updateDropOverlay();
    }
  } catch { cameraInfoEl.textContent = "Camera unavailable"; }
}

function updateDropOverlay() {
  const overlay = document.getElementById("drop-overlay");
  if (!overlay) return;
  overlay.classList.toggle("visible", state._noCamera && !state.frozen);
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
    const r = await fetch("/camera/startup-warning");
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
  try {
    const [camerasResp, infoResp] = await Promise.all([
      fetch("/cameras"),
      fetch("/camera/info"),
    ]);
    const cameras = await camerasResp.json();
    const info = await infoResp.json();
    const currentId = info.device_id ?? "";
    sel.innerHTML = cameras.map(c =>
      `<option value="${c.id}"${c.id === currentId ? " selected" : ""}>${c.label}</option>`
    ).join("");
    sel.disabled = cameras.length <= 1 && cameras[0]?.id === "opencv-0";
  } catch {
    sel.innerHTML = "<option>Unavailable</option>";
    sel.disabled = true;
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
  const dxfCircleCount = ann?.entities?.filter(e => e.type === "circle").length ?? 0;
  const autoAlignBtn = document.getElementById("btn-auto-align");
  if (autoAlignBtn) {
    autoAlignBtn.disabled = dxfCircleCount < 2;
    autoAlignBtn.title = dxfCircleCount < 2 ? "At least 2 DXF circles required" : "";
  }
  const inspBtn = document.getElementById("btn-run-inspection");
  if (inspBtn) inspBtn.disabled = !ann;
  const moveBtn = document.getElementById("btn-dxf-move");
  if (moveBtn) moveBtn.disabled = !ann;
}
