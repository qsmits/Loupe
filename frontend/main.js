import { state, TRANSIENT_TYPES } from './state.js';
import { canvas, ctx, img, showStatus, redraw, resizeCanvas } from './render.js';
import { renderSidebar, loadCameraInfo, loadUiConfig, loadTolerances,
         updateCalibrationButton, checkStartupWarning, updateFreezeUI,
         loadCameraList } from './sidebar.js';
import { deleteAnnotation, elevateSelected, clearDetections, clearMeasurements, clearDxfOverlay, clearAll } from './annotations.js';
import { setTool } from './tools.js';
import { initDxfHandlers } from './dxf.js';
import { doFreeze, initDetectHandlers } from './detect.js';
import { saveSession, loadSession, exportAnnotatedImage, exportCsv, exportDxf, autoSave, tryAutoRestore } from './session.js';
import { viewport, clampPan, fitToWindow, setImageSize, imageWidth, imageHeight } from './viewport.js';
import { showContextMenu, hideContextMenu } from './events-context-menu.js';
import { undo, redo, initKeyboard } from './events-keyboard.js';
import { initMouseHandlers } from './events-mouse.js';

// ─── Dropdown helpers ─────��──────────────────────────────────────────────────
function closeAllDropdowns() {
  ["dropdown-measure","dropdown-detect","dropdown-overlay","dropdown-clear"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  ["btn-menu-measure","btn-menu-detect","btn-menu-overlay","btn-menu-clear"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove("open");
  });
  const popup = document.getElementById("overflow-popup");
  if (popup) popup.hidden = true;
}

function toggleDropdown(btnId, dropId) {
  const drop = document.getElementById(dropId);
  const wasOpen = !drop.hidden;
  closeAllDropdowns();
  if (!wasOpen) {
    drop.hidden = false;
    document.getElementById(btnId).classList.add("open");
  }
}

// ── Init event modules ───────────────────────────────���────────────────────────
initMouseHandlers();
initKeyboard(closeAllDropdowns);

// ── Tool strip buttons + camera collapse ─────────────────────────────────────
const cameraSectionHeader = document.getElementById("camera-section-header");
const cameraSectionBody   = document.getElementById("camera-section-body");
if (cameraSectionHeader && cameraSectionBody) {
  cameraSectionHeader.addEventListener("click", () => {
    const isOpen = cameraSectionHeader.classList.toggle("open");
    cameraSectionBody.style.display = isOpen ? "" : "none";
  });
}

// ── Dropdown menu wiring ───────────────────────────��─────────────────────────
document.getElementById("btn-menu-measure").addEventListener("click", e => {
  e.stopPropagation();
  toggleDropdown("btn-menu-measure", "dropdown-measure");
});
document.getElementById("btn-menu-detect").addEventListener("click", e => {
  e.stopPropagation();
  toggleDropdown("btn-menu-detect", "dropdown-detect");
});
document.getElementById("btn-menu-overlay").addEventListener("click", e => {
  e.stopPropagation();
  toggleDropdown("btn-menu-overlay", "dropdown-overlay");
});
document.getElementById("btn-menu-clear").addEventListener("click", e => {
  e.stopPropagation();
  toggleDropdown("btn-menu-clear", "dropdown-clear");
});

document.getElementById("btn-clear-detections")?.addEventListener("click", () => { closeAllDropdowns(); clearDetections(); });
document.getElementById("btn-clear-measurements")?.addEventListener("click", () => { closeAllDropdowns(); clearMeasurements(); });
document.getElementById("btn-clear-dxf")?.addEventListener("click", () => { closeAllDropdowns(); clearDxfOverlay(); });
document.getElementById("btn-clear-all")?.addEventListener("click", () => { closeAllDropdowns(); clearAll(); });

document.querySelectorAll("#dropdown-measure .dropdown-item[data-tool]").forEach(item => {
  item.addEventListener("click", () => {
    setTool(item.dataset.tool);
    closeAllDropdowns();
  });
});

["btn-load-dxf","btn-export","btn-export-csv","btn-crosshair","btn-set-origin"]
  .forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", closeAllDropdowns, true);
  });

["btn-run-edges","btn-show-preprocessed","btn-run-circles","btn-run-lines"]
  .forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", closeAllDropdowns, true);
  });

// ── Overflow popup ────────────────────────────────────────────────────────────
const overflowBtn   = document.getElementById("btn-overflow");
const overflowPopup = document.getElementById("overflow-popup");

if (overflowBtn && overflowPopup) {
  overflowBtn.addEventListener("click", e => {
    e.stopPropagation();
    const wasOpen = !overflowPopup.hidden;
    closeAllDropdowns(); // close any open dropdown first
    if (!wasOpen) overflowPopup.hidden = false;
  });

  document.querySelectorAll("#overflow-popup .strip-btn[data-tool]").forEach(btn => {
    btn.addEventListener("click", () => {
      setTool(btn.dataset.tool);
      overflowPopup.hidden = true;
    });
  });
}

// ── Close dropdowns on click-outside ─────────────────────────────────────────
document.addEventListener("click", e => {
  // Don't close if clicking inside a dropdown (e.g. adjusting sliders)
  if (e.target.closest(".dropdown")) return;
  closeAllDropdowns();
});

// ─��� Freeze button ───���───────────────────────────────��─────────────────────────
document.getElementById("btn-freeze").addEventListener("click", async () => {
  if (state.frozen) {
    // Unfreeze
    img.style.opacity = "1";
    state.frozen = false;
    state.frozenBackground = null;
    state._gradientOverlayImg = null;
    state.showGradientOverlay = false;
    const gradChk = document.getElementById("btn-gradient-overlay");
    if (gradChk) gradChk.checked = false;
    // Restore fit-to-window zoom (not zoom=1, which would show a 1:1 crop
    // when camera resolution exceeds display size)
    const rect = canvas.getBoundingClientRect();
    fitToWindow(rect.width, rect.height);
    updateFreezeUI();
    resizeCanvas();
  } else {
    await doFreeze();
  }
});

// ── Load image ──────────────────────────────────────���─────────────────────────
document.getElementById("btn-load").addEventListener("click", () => {
  document.getElementById("file-input").click();
});

document.getElementById("file-input").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("file", file);
  const r = await fetch("/load-image", { method: "POST", body: formData });
  if (!r.ok) { alert("Could not load image"); return; }
  const { width, height } = await r.json();
  state.frozenSize = { w: width, h: height };
  setImageSize(width, height);
  // Reset viewport for new image
  viewport.zoom = 1;
  viewport.panX = 0;
  viewport.panY = 0;

  const url = URL.createObjectURL(file);
  const loadedImg = new Image();
  loadedImg.onload = async () => {
    state.frozenBackground = loadedImg;
    img.style.opacity = "0";
    state.frozen = true;
    updateFreezeUI();
    resizeCanvas();
    showStatus("Loaded image");
  };
  loadedImg.src = url;
  e.target.value = "";
});

// ── Undo/redo buttons ─────────────────────────────────────────────────────────
document.getElementById("btn-undo")?.addEventListener("click", undo);
document.getElementById("btn-redo")?.addEventListener("click", redo);

// ── Elevate from sidebar ─────────────────────────────────────────────────────
document.addEventListener("elevate-selected", () => elevateSelected());

// ── Zoom badge presets ───────────────────────────────────────────────────────
const zoomBadge = document.getElementById("zoom-badge");
const zoomPresets = document.getElementById("zoom-presets");
if (zoomBadge && zoomPresets) {
  zoomBadge.addEventListener("click", e => {
    e.stopPropagation();
    zoomPresets.hidden = !zoomPresets.hidden;
  });
  document.addEventListener("click", () => { zoomPresets.hidden = true; });
  zoomPresets.addEventListener("click", e => e.stopPropagation());
  zoomPresets.querySelectorAll(".zoom-preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const rect = canvas.getBoundingClientRect();
      const val = btn.dataset.zoom;
      if (val === "fit") {
        fitToWindow(rect.width, rect.height);
      } else {
        const z = parseFloat(val);
        // Center the view when jumping to a preset
        const visibleW = rect.width / z;
        const visibleH = rect.height / z;
        viewport.zoom = z;
        viewport.panX = (imageWidth - visibleW) / 2;
        viewport.panY = (imageHeight - visibleH) / 2;
      }
      clampPan(rect.width, rect.height);
      resizeCanvas();
      zoomPresets.hidden = true;
    });
  });
}

// ── Sidebar resize ───────────────────────────────────────────────────────────
const sidebarResize = document.getElementById("sidebar-resize");
const sidebar = document.getElementById("sidebar");
if (sidebarResize && sidebar) {
  let resizing = false;
  sidebarResize.addEventListener("mousedown", e => {
    e.preventDefault();
    resizing = true;
    document.body.style.cursor = "col-resize";
  });
  document.addEventListener("mousemove", e => {
    if (!resizing) return;
    const newWidth = document.body.clientWidth - e.clientX;
    sidebar.style.width = Math.max(140, Math.min(500, newWidth)) + "px";
    resizeCanvas();
  });
  document.addEventListener("mouseup", () => {
    if (resizing) {
      resizing = false;
      document.body.style.cursor = "";
    }
  });
}

// ── Drag-and-drop image load (no-camera mode) ─────────────────────────────────
const viewerEl = document.getElementById("viewer");
const dropOverlayEl = document.getElementById("drop-overlay");

viewerEl.addEventListener("dragover", e => {
  if (!state._noCamera) return;
  e.preventDefault();
  dropOverlayEl.classList.add("drag-active");
});

viewerEl.addEventListener("dragleave", e => {
  if (!state._noCamera) return;
  if (viewerEl.contains(e.relatedTarget)) return;
  dropOverlayEl.classList.remove("drag-active");
});

viewerEl.addEventListener("drop", async e => {
  if (!state._noCamera) return;
  e.preventDefault();
  dropOverlayEl.classList.remove("drag-active");
  const file = e.dataTransfer.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("file", file);
  const r = await fetch("/load-image", { method: "POST", body: formData });
  if (!r.ok) { alert("Could not load image"); return; }
  const { width, height } = await r.json();
  state.frozenSize = { w: width, h: height };
  setImageSize(width, height);
  viewport.zoom = 1;
  viewport.panX = 0;
  viewport.panY = 0;

  const url = URL.createObjectURL(file);
  const loadedImg = new Image();
  loadedImg.onload = () => {
    state.frozenBackground = loadedImg;
    img.style.opacity = "0";
    state.frozen = true;
    updateFreezeUI();
    resizeCanvas();
    showStatus("Loaded image");
  };
  loadedImg.src = url;
});

// ── Coordinate origin ───���──────────────────────────────────────────────────────
document.getElementById("btn-set-origin").addEventListener("click", () => {
  // Exit other modal modes first
  if (state.dxfAlignMode) {
    state.dxfAlignMode = false; state.dxfAlignStep = 0;
    state.dxfAlignPick = null; state.dxfAlignHover = null;
    document.getElementById("btn-auto-align")?.classList.remove("active");
  }
  if (state.dxfDragMode) {
    state.dxfDragMode = false; state.dxfDragOrigin = null;
    document.getElementById("btn-dxf-move")?.classList.remove("active");
  }
  if (state.inspectionPickTarget) {
    state.inspectionPickTarget = null;
    state.inspectionPickPoints = [];
    state.inspectionPickFit = null;
  }
  state._originMode = !state._originMode;
  document.getElementById("btn-set-origin").classList.toggle("active", state._originMode);
});

// ── Session save button ───────────────────────────────────────────────────────
document.getElementById("btn-save-session").addEventListener("click", saveSession);

// ── Session load file input ────────���──────────────────────────────────────────
document.getElementById("btn-load-session")?.addEventListener("click", () => {
  document.getElementById("session-file-input").click();
});

document.getElementById("session-file-input").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    loadSession(ev.target.result);
    e.target.value = ""; // reset so the same file can be re-loaded
  };
  reader.readAsText(file);
});

// ── Clear all annotations ───���─────────────────────────────────────────────────
document.getElementById("btn-clear")?.addEventListener("click", () => {
  if (confirm("Clear all annotations?")) {
    state.annotations = state.annotations.filter(a => a.type === "dxf-overlay");
    state.featureTolerances = {};
    state.selected = new Set();
    state.calibration = null; // calibration annotation was filtered out above
    updateCalibrationButton();
    state.pendingPoints = [];
    state.pendingCenterCircle = null;
    state.pendingRefLine = null;
    state.origin = null;
    // DXF panel: keep visible (DXF overlay is preserved). Do NOT hide it.
    if (state._dxfOriginMode) {
      state._dxfOriginMode = false;
      document.getElementById("btn-dxf-set-origin")?.classList.remove("active");
      showStatus(state.frozen ? "Frozen" : "Live");
    }
    if (state._originMode) {
      state._originMode = false;
      document.getElementById("btn-set-origin").classList.remove("active");
    }
    const coordEl = document.getElementById("coord-display");
    if (coordEl) coordEl.textContent = "";
    renderSidebar();
    redraw();
  }
});

// ── Export PNG ──────��────────────────────────────────��────────────────────────
document.getElementById("btn-export").addEventListener("click", exportAnnotatedImage);

// ── Export CSV / DXF ────────────────────────────────────��─────────────────────
document.getElementById("btn-export-csv").addEventListener("click", exportCsv);
document.getElementById("btn-export-dxf")?.addEventListener("click", exportDxf);

// ── Crosshair toggle ──────────────────────────────────────────────────────────
document.getElementById("btn-crosshair").addEventListener("click", () => {
  state.crosshair = !state.crosshair;
  document.getElementById("btn-crosshair").classList.toggle("active", state.crosshair);
  redraw();
});

// ── Grid toggle ────────────────────────────────────────���──────────────────────
document.getElementById("btn-grid")?.addEventListener("click", () => {
  state.showGrid = !state.showGrid;
  document.getElementById("btn-grid")?.classList.toggle("active", state.showGrid);
  showStatus(state.showGrid ? "Grid on" : "Grid off");
  redraw();
});

// ── Gradient overlay toggle ──────────────────────────────────────────────────
document.getElementById("btn-gradient-overlay")?.addEventListener("change", async (e) => {
  state.showGradientOverlay = e.target.checked;
  if (e.target.checked && state.frozen && !state._gradientOverlayImg) {
    try {
      const resp = await fetch("/gradient-overlay", { method: "POST" });
      if (resp.ok) {
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const img2 = new Image();
        img2.onload = () => {
          state._gradientOverlayImg = img2;
          URL.revokeObjectURL(url);
          redraw();
        };
        img2.src = url;
      }
    } catch (err) { console.error("Gradient overlay failed:", err); }
  }
  redraw();
});

// ── Calibration button ────────────────────────────────────────────────────────
document.getElementById("btn-calibration").addEventListener("click", () => setTool("calibrate"));

// ── Help dialog ───────────────────────────────────────���───────────────────────
document.getElementById("btn-help")?.addEventListener("click", () => {
  document.getElementById("help-dialog").hidden = false;
});
document.getElementById("btn-help-close").addEventListener("click", () => {
  document.getElementById("help-dialog").hidden = true;
});

// ── Settings dialog ────────────────────────────────────��──────────────────────
const settingsDialog = document.getElementById("settings-dialog");
const fmtStatusEl = document.getElementById("settings-status");

document.getElementById("btn-settings").addEventListener("click", () => {
  settingsDialog.hidden = false;
  loadCameraInfo();
  loadCameraList();
});

document.getElementById("btn-settings-close").addEventListener("click", () => {
  settingsDialog.hidden = true;
});

// Backdrop click: close only when clicking outside dialog content
settingsDialog.addEventListener("click", e => {
  if (e.target === settingsDialog) settingsDialog.hidden = true;
});

// Tab switching
document.querySelectorAll(".settings-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".settings-panel").forEach(p => p.style.display = "none");
    tab.classList.add("active");
    document.getElementById(`settings-${tab.dataset.tab}-panel`).style.display = "block";
  });
});

// General tab Save button
document.getElementById("btn-save-general").addEventListener("click", async () => {
  const appName = document.getElementById("app-name-input").value.trim() || "Microscope";
  const theme   = document.getElementById("theme-select").value;
  try {
    await fetch("/config/ui", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ app_name: appName, theme }),
    });
    document.getElementById("app-title").textContent = appName;
    document.title = appName;
    document.documentElement.className = `theme-${theme}`;
    document.getElementById("settings-status").textContent = "Saved.";
    setTimeout(() => { document.getElementById("settings-status").textContent = ""; }, 2000);
  } catch (_) {
    document.getElementById("settings-status").textContent = "Save failed.";
  }
});

// Tolerances tab Save button
document.getElementById("btn-save-tolerances")?.addEventListener("click", async () => {
  const warn = parseFloat(document.getElementById("tol-warn-input")?.value);
  const fail = parseFloat(document.getElementById("tol-fail-input")?.value);
  const statusEl3 = document.getElementById("tolerances-status");
  if (!isFinite(warn) || !isFinite(fail) || warn <= 0 || fail <= 0 || warn >= fail) {
    if (statusEl3) { statusEl3.textContent = "Warn must be > 0 and < Fail"; statusEl3.style.color = "var(--danger)"; }
    return;
  }
  try {
    const r = await fetch("/config/tolerances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tolerance_warn: warn, tolerance_fail: fail }),
    });
    if (r.ok) {
      state.tolerances.warn = warn;
      state.tolerances.fail = fail;
      if (statusEl3) { statusEl3.textContent = "Saved"; statusEl3.style.color = "var(--success)"; }
      if (state.showDeviations) redraw();
    } else {
      if (statusEl3) { statusEl3.textContent = "Save failed"; statusEl3.style.color = "var(--danger)"; }
    }
  } catch (err) {
    if (statusEl3) { statusEl3.textContent = "Error: " + err.message; statusEl3.style.color = "var(--danger)"; }
  }
});

// Sub-pixel method dropdown
const subpixelSelect = document.getElementById("subpixel-method-select");
if (subpixelSelect) {
  fetch("/subpixel-methods").then(r => r.json()).then(methods => {
    subpixelSelect.innerHTML = methods.map(m =>
      `<option value="${m}"${m === state.settings.subpixelMethod ? " selected" : ""}>${
        m === "none" ? "None (pixel-level)" :
        m === "parabola" ? "Parabola (default)" :
        m === "gaussian" ? "Gaussian (soft edges)" : m
      }</option>`
    ).join("");
  });
  subpixelSelect.addEventListener("change", () => {
    state.settings.subpixelMethod = subpixelSelect.value;
  });
}

// Sub-pixel snap radius slider
const radiusSlider = document.getElementById("subpixel-radius-slider");
const radiusValue = document.getElementById("subpixel-radius-value");
if (radiusSlider) {
  radiusSlider.value = state.settings.subpixelSearchRadius;
  if (radiusValue) radiusValue.textContent = state.settings.subpixelSearchRadius;
  radiusSlider.addEventListener("input", () => {
    state.settings.subpixelSearchRadius = parseInt(radiusSlider.value);
    if (radiusValue) radiusValue.textContent = radiusSlider.value;
  });
}

// Crosshair swatches
document.querySelectorAll(".swatch").forEach(swatch => {
  swatch.addEventListener("click", () => {
    document.querySelectorAll(".swatch").forEach(s => s.classList.remove("active"));
    swatch.classList.add("active");
    state.settings.crosshairColor = swatch.dataset.color;
    redraw();
  });
});

// Crosshair opacity
document.getElementById("crosshair-opacity").addEventListener("input", e => {
  const pct = parseInt(e.target.value);
  document.getElementById("crosshair-opacity-value").textContent = `${pct}%`;
  state.settings.crosshairOpacity = pct / 100;
  redraw();
});

// Pixel format select
document.getElementById("pixel-format-select").addEventListener("change", async e => {
  const fmt = e.target.value;
  const prev = state.settings.pixelFormat;
  fmtStatusEl.textContent = "Applying…";
  try {
    const r = await fetch("/camera/pixel-format", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pixel_format: fmt }),
    });
    if (!r.ok) throw new Error(await r.text());
    state.settings.pixelFormat = fmt;
    fmtStatusEl.textContent = "Done";
    setTimeout(() => { fmtStatusEl.textContent = ""; }, 2000);
  } catch (err) {
    fmtStatusEl.textContent = `Error: ${err.message}`;
    e.target.value = prev;  // revert dropdown
  }
});

// ── White balance ───────────────────────────────────���─────────────────────────
document.getElementById("btn-wb-auto").addEventListener("click", async () => {
  fmtStatusEl.textContent = "Applying…";
  try {
    const r = await fetch("/camera/white-balance/auto", { method: "POST" });
    if (!r.ok) throw new Error(await r.text());
    const ratios = await r.json();
    ["red", "green", "blue"].forEach(ch => {
      const slider = document.getElementById(`wb-${ch}-slider`);
      const display = document.getElementById(`wb-${ch}-value`);
      if (slider) slider.value = ratios[ch];
      if (display) display.textContent = ratios[ch].toFixed(2);
    });
    fmtStatusEl.textContent = "Done";
    setTimeout(() => { fmtStatusEl.textContent = ""; }, 2000);
  } catch (err) {
    fmtStatusEl.textContent = `Error: ${err.message}`;
  }
});

// ── Exposure / Gain sliders ──────────────────────────────────────────────────
document.getElementById("exp-slider").addEventListener("input", async e => {
  const v = parseFloat(e.target.value);
  document.getElementById("exp-value").textContent = `${v} µs`;
  try {
    await fetch("/camera/exposure", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: v }) });
  } catch (err) { console.error("Failed to set exposure:", err); }
});

document.getElementById("gain-slider").addEventListener("input", async e => {
  const v = parseFloat(e.target.value);
  document.getElementById("gain-value").textContent = `${v} dB`;
  try {
    await fetch("/camera/gain", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: v }) });
  } catch (err) { console.error("Failed to set gain:", err); }
});

let _wbDebounce = {};
["red", "green", "blue"].forEach(ch => {
  document.getElementById(`wb-${ch}-slider`).addEventListener("input", e => {
    const val = parseFloat(e.target.value);
    document.getElementById(`wb-${ch}-value`).textContent = val.toFixed(2);
    clearTimeout(_wbDebounce[ch]);
    _wbDebounce[ch] = setTimeout(async () => {
      try {
        await fetch("/camera/white-balance/ratio", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: ch.charAt(0).toUpperCase() + ch.slice(1),
            value: val,
          }),
        });
      } catch (err) {
        console.error("WB ratio update failed:", err);
      }
    }, 150);
  });
});

// ── Camera selection ──────────────────────────────────────────────────────────
document.getElementById("camera-select").addEventListener("change", async e => {
  const camera_id = e.target.value;
  if (!camera_id) return;
  const sel = e.target;
  sel.disabled = true;
  fmtStatusEl.textContent = "Switching…";
  try {
    const r = await fetch("/camera/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ camera_id }),
    });
    if (!r.ok) throw new Error(await r.text());
    await loadCameraInfo();
    await loadCameraList();
    fmtStatusEl.textContent = "Done";
    setTimeout(() => { fmtStatusEl.textContent = ""; }, 2000);
  } catch (err) {
    fmtStatusEl.textContent = `Error: ${err.message}`;
    await loadCameraList();
  }
});

// ── Event delegation for delete buttons ───���──────────────────────────────────
document.getElementById("measurement-list").addEventListener("click", e => {
  const btn = e.target.closest(".del-btn");
  if (!btn) return;
  e.stopPropagation();
  const id = parseInt(btn.dataset.id, 10);
  deleteAnnotation(id);
});

// ── Init ──────��───────────────────────────────────��───────────────────────────
initDxfHandlers();
initDetectHandlers();

new ResizeObserver(resizeCanvas).observe(img);
img.addEventListener("load", resizeCanvas);
window.addEventListener("resize", resizeCanvas);

document.querySelectorAll("#tool-strip .strip-btn[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
});
setTool(state.tool);  // sync initial active state via setTool

loadCameraInfo();
loadUiConfig();
loadTolerances();
updateCalibrationButton();
checkStartupWarning();
resizeCanvas();

// Auto-save every 30 seconds
setInterval(autoSave, 30000);

// Offer to restore previous session
tryAutoRestore();

// Warn before closing if unsaved
window.addEventListener("beforeunload", e => {
  if (!state._savedManually && state.annotations.some(a => !TRANSIENT_TYPES.has(a.type))) {
    e.preventDefault();
    e.returnValue = "";
  }
});
updateFreezeUI();
