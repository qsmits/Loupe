import { apiFetch, getSessionId } from './api.js';
import { state, TRANSIENT_TYPES, camBounds } from './state.js';
import { canvas, ctx, img, showStatus, redraw, resizeCanvas } from './render.js';
import { renderSidebar, loadCameraInfo, loadUiConfig, loadTolerances,
         updateCalibrationButton, checkStartupWarning, updateFreezeUI,
         loadCameraList, renderInspectionTable, updateTemplateDisplay,
         updateDxfControlsVisibility, initGlobalVisToggle } from './sidebar.js';
import { deleteAnnotation, addAnnotation, elevateSelected, clearDetections, clearMeasurements, clearDxfOverlay, clearAll } from './annotations.js';
import { assembleTemplate, downloadTemplate, readTemplateFile } from './template.js';
import { setTool } from './tools.js';
import { initSubModeSelector } from './sub-mode-selector.js';
import { initDxfHandlers, measurementsAsDxf } from './dxf.js';
import { doFreeze, initDetectHandlers } from './detect.js';
import { initCompareHandlers } from './compare.js';
import { saveSession, loadSession, exportAnnotatedImage, exportCsv, exportDxf, autoSave, tryAutoRestore } from './session.js';
import { viewport, clampPan, fitToWindow, setImageSize, imageWidth, imageHeight } from './viewport.js';
import { cacheImageData } from './subpixel-js.js';
import { showContextMenu, hideContextMenu } from './events-context-menu.js';
import { undo, redo, initKeyboard } from './events-keyboard.js';
import { initMouseHandlers } from './events-mouse.js';
import { loadSpcParts, loadSpcFeatures, loadSpcData } from './spc.js';
import { initLensCal, openLensCalDialog } from './lens-cal.js';
import { initTiltCal, openTiltCalDialog, hasPerspectiveCorrection, undoPerspectiveCorrection } from './tilt-cal.js';
import { initCalProfiles, openCalProfiles } from './cal-profiles.js';
import { isBrowserCameraActive, startBrowserCamera, stopBrowserCamera } from './browser-camera.js';
import { finalizeArcFit } from './tools.js';
import { initZstack } from './zstack.js';
import { initStitch } from './stitch.js';
import { initSuperRes } from './superres.js';
import { initDeflectometry } from './deflectometry.js';
import { loadReticle, unloadReticle, saveCustomReticle } from './reticle.js';
import { initReticlePanel } from './sidebar.js';
import { initGear } from './gear.js';
import { initFringe } from './fringe.js';
import { initModes, getActiveMode } from './modes.js';
import { enterMaskEditSession, isCrossModeActive } from './cross-mode.js';

// ─── Dropdown helpers ─────��──────────────────────────────────────────────────
function closeAllDropdowns() {
  ["dropdown-detect","dropdown-overlay","dropdown-clear","dropdown-camera","dropdown-fringe-settings","dropdown-fringe-export"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  ["btn-menu-detect","btn-menu-overlay","btn-menu-clear","btn-menu-camera","btn-menu-fringe-settings","btn-menu-fringe-export"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove("open");
  });
  // Close strip flyouts
  ["strip-flyout-measure","strip-flyout-setup"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
}

function toggleStripFlyout(flyoutId) {
  const flyout = document.getElementById(flyoutId);
  if (!flyout) return;
  const wasOpen = !flyout.hidden;
  closeAllDropdowns();
  if (!wasOpen) flyout.hidden = false;
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
initModes();

// Cross-mode mask editing: enter mask-edit session when microscope activates with crossMode
document.addEventListener('mode-switched', (e) => {
  if (e.detail.mode === 'microscope' && isCrossModeActive()) {
    setTimeout(() => enterMaskEditSession(), 0);
  }
});

// ── Dropdown menu wiring ───────────────────────────��─────────────────────────
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
document.getElementById("btn-menu-note")?.addEventListener("click", e => {
  e.stopPropagation();
  closeAllDropdowns();
  setTool("comment");
});
document.getElementById("btn-menu-camera").addEventListener("click", e => {
  e.stopPropagation();
  toggleDropdown("btn-menu-camera", "dropdown-camera");
  loadCameraInfo();
  loadCameraList();
});
document.getElementById("btn-menu-fringe-settings")?.addEventListener("click", e => {
  e.stopPropagation();
  toggleDropdown("btn-menu-fringe-settings", "dropdown-fringe-settings");
});
document.getElementById("btn-menu-fringe-export")?.addEventListener("click", e => {
  e.stopPropagation();
  toggleDropdown("btn-menu-fringe-export", "dropdown-fringe-export");
});

document.getElementById("btn-clear-detections")?.addEventListener("click", () => { closeAllDropdowns(); clearDetections(); });
document.getElementById("btn-clear-measurements")?.addEventListener("click", () => { closeAllDropdowns(); clearMeasurements(); });
document.getElementById("btn-clear-dxf")?.addEventListener("click", () => { closeAllDropdowns(); clearDxfOverlay(); });
document.getElementById("btn-clear-all")?.addEventListener("click", () => { closeAllDropdowns(); clearAll(); });

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

// ── Strip flyout groups ───────────────────────────────────────────────────────
document.getElementById("btn-strip-measure")?.addEventListener("click", e => {
  e.stopPropagation();
  toggleStripFlyout("strip-flyout-measure");
});
document.getElementById("btn-strip-setup")?.addEventListener("click", e => {
  e.stopPropagation();
  toggleStripFlyout("strip-flyout-setup");
});

// Tools in flyouts: use event delegation on each flyout
document.querySelectorAll(".strip-flyout .flyout-item[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => {
    setTool(btn.dataset.tool);
    closeAllDropdowns();
  });
});

// Lens Cal button in setup flyout
document.getElementById("btn-lens-cal-open")?.addEventListener("click", () => {
  closeAllDropdowns();
  openLensCalDialog();
});

// Perspective correction button in setup flyout
document.getElementById("btn-tilt-cal-open")?.addEventListener("click", () => {
  closeAllDropdowns();
  openTiltCalDialog();
});

const _undoPerspBtn = document.getElementById("btn-tilt-cal-undo");
if (_undoPerspBtn) {
  _undoPerspBtn.addEventListener("click", async () => {
    closeAllDropdowns();
    await undoPerspectiveCorrection();
    _undoPerspBtn.hidden = true;
  });
  document.addEventListener("perspective-correction-changed", () => {
    _undoPerspBtn.hidden = !hasPerspectiveCorrection();
  });
}

// Cal Profiles button in setup flyout
document.getElementById("btn-cal-profiles-open")?.addEventListener("click", () => {
  closeAllDropdowns();
  openCalProfiles();
});

// Arc-measure point-order toggle
document.getElementById("btn-arc-order-sequential")?.addEventListener("click", () => {
  state.arcMeasureMode = "sequential";
  document.getElementById("btn-arc-order-sequential").classList.add("active");
  document.getElementById("btn-arc-order-ends-first").classList.remove("active");
  state.pendingPoints = [];
  redraw();
});
document.getElementById("btn-arc-order-ends-first")?.addEventListener("click", () => {
  state.arcMeasureMode = "ends-first";
  document.getElementById("btn-arc-order-ends-first").classList.add("active");
  document.getElementById("btn-arc-order-sequential").classList.remove("active");
  state.pendingPoints = [];
  redraw();
});

// Circle mode toggle
document.getElementById("btn-circle-mode-3pt")?.addEventListener("click", () => {
  state.circleMode = "3-point";
  document.getElementById("btn-circle-mode-3pt").classList.add("active");
  document.getElementById("btn-circle-mode-center-edge").classList.remove("active");
  state.pendingPoints = [];
  redraw();
});
document.getElementById("btn-circle-mode-center-edge")?.addEventListener("click", () => {
  state.circleMode = "center-edge";
  document.getElementById("btn-circle-mode-center-edge").classList.add("active");
  document.getElementById("btn-circle-mode-3pt").classList.remove("active");
  state.pendingPoints = [];
  redraw();
});

// ── Close dropdowns on click-outside ─────────────────────────────────────────
document.addEventListener("click", e => {
  // Don't close if clicking inside a dropdown or strip flyout (e.g. adjusting sliders)
  if (e.target.closest(".dropdown") || e.target.closest(".strip-group")) return;
  closeAllDropdowns();
});

// ─��� Freeze button ───���───────────────────────────────��─────────────────────────
document.getElementById("btn-freeze").addEventListener("click", async () => {
  if (state.frozen) {
    // Unfreeze — restore live stream
    if (isBrowserCameraActive()) {
      document.getElementById("browser-cam-video").style.opacity = "1";
    } else if (!state._hosted) {
      img.src = "/stream?" + Date.now();
      img.style.opacity = "1";
    }
    state.frozen = false;
    state.frozenBackground = null;
    state._gradientOverlayImg = null;
    state.showGradientOverlay = false;
    state._subpixelSnapTarget = null;
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

  const loadingEl = document.getElementById("loading-overlay");
  loadingEl.hidden = false;
  try {
    const formData = new FormData();
    formData.append("file", file);
    const r = await apiFetch("/load-image", { method: "POST", body: formData });
    if (!r.ok) { alert("Could not load image"); return; }
    const { width, height } = await r.json();
    state.frozenSize = { w: width, h: height };
    setImageSize(width, height);
    viewport.zoom = 1;
    viewport.panX = 0;
    viewport.panY = 0;

    const url = URL.createObjectURL(file);
    const loadedImg = new Image();
    loadedImg.onload = async () => {
      loadingEl.hidden = true;
      state.frozenBackground = loadedImg;
      img.style.opacity = "0";
      // MJPEG stream continues in background (changing src breaks canvas sizing)
      state.frozen = true;
      cacheImageData(loadedImg, width, height);
      updateFreezeUI();
      resizeCanvas();
      showStatus("Loaded image");
    };
    loadedImg.src = url;
  } catch {
    loadingEl.hidden = true;
  }
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

  const loadingEl = document.getElementById("loading-overlay");
  loadingEl.hidden = false;
  try {
    const formData = new FormData();
    formData.append("file", file);
    const r = await apiFetch("/load-image", { method: "POST", body: formData });
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
      loadingEl.hidden = true;
      state.frozenBackground = loadedImg;
      img.style.opacity = "0";
      // MJPEG stream continues in background (changing src breaks canvas sizing)
      state.frozen = true;
      cacheImageData(loadedImg, width, height);
      updateFreezeUI();
      resizeCanvas();
      showStatus("Loaded image");
    };
    loadedImg.src = url;
  } catch {
    loadingEl.hidden = true;
  }
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
  if (state.dxfRotateMode) {
    state.dxfRotateMode = false; state.dxfRotateOrigin = null;
    document.getElementById("btn-dxf-rotate")?.classList.remove("active");
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

// ── Save Run ──────────────────────────────────────────────────────────────────
document.getElementById("btn-save-run")?.addEventListener("click", async () => {
  if (state.inspectionResults.length === 0) return;

  const partName = prompt("Part name:", state._templateName || state.dxfFilename || "");
  if (!partName) return;

  document.body.style.cursor = "progress";
  try {
    // Create or get part
    const partResp = await apiFetch("/parts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: partName,
        dxf_filename: state.dxfFilename || "",
        template_name: state._templateName || "",
      }),
    });
    if (partResp.status === 403) {
      showStatus("Run storage not available in hosted mode");
      return;
    }
    if (!partResp.ok) throw new Error(await partResp.text());
    const part = await partResp.json();

    // Save the run
    const runResp = await apiFetch(`/parts/${part.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        results: state.inspectionResults,
        operator: "",
      }),
    });
    if (!runResp.ok) throw new Error(await runResp.text());
    const run = await runResp.json();

    showStatus(`Run #${run.run_id} saved for "${partName}"`);
    loadSpcParts();  // refresh SPC dashboard after saving a run
  } catch (err) {
    showStatus("Failed to save run: " + err.message);
  } finally {
    document.body.style.cursor = "";
  }
});

// ── Export PNG ──────��────────────────────────────────��────────────────────────
document.getElementById("btn-export").addEventListener("click", exportAnnotatedImage);

// ── Export CSV / DXF ────────────────────────────────────��─────────────────────
document.getElementById("btn-export-csv").addEventListener("click", exportCsv);
document.getElementById("btn-export-dxf")?.addEventListener("click", exportDxf);
document.getElementById("btn-measurements-as-dxf")?.addEventListener("click", () => {
  closeAllDropdowns();
  measurementsAsDxf();
});

// Crosshair toggle removed — crosshair is now a reticle preset in the Overlay menu

// Grid toggle removed — grid reticle presets available in Overlay menu

// ── Gradient overlay toggle ──────────────────────────────────────────────────
document.getElementById("btn-gradient-overlay")?.addEventListener("change", async (e) => {
  state.showGradientOverlay = e.target.checked;
  if (e.target.checked && state.frozen && !state._gradientOverlayImg) {
    try {
      const resp = await apiFetch("/gradient-overlay", { method: "POST" });
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

// Calibrate tool is now wired via data-tool="calibrate" in the Setup flyout.
// Clicking the cal-badge in the status bar also enters calibration mode.
document.getElementById("cal-badge")?.addEventListener("click", () => setTool("calibrate"));

// ── Help dialog ──────────────────────────────────────────────────────────────
const helpDialog = document.getElementById("help-dialog");

document.getElementById("btn-help")?.addEventListener("click", () => {
  helpDialog.hidden = false;
});
document.getElementById("btn-help-close").addEventListener("click", () => {
  helpDialog.hidden = true;
});

// Close help dialog on Escape
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !helpDialog.hidden) {
    e.preventDefault();
    e.stopPropagation();
    helpDialog.hidden = true;
  }
}, true);

// Close help dialog on backdrop click
helpDialog.addEventListener("click", e => {
  if (e.target === helpDialog) helpDialog.hidden = true;
});

// ── Help mode tab switching ──
function switchHelpMode(mode) {
  // Update tab active state
  document.querySelectorAll(".help-mode-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.helpMode === mode);
  });
  // Show/hide nav sections and items by data-help-modes
  document.querySelectorAll(".help-nav-section[data-help-modes], .help-nav-item[data-help-modes]").forEach(el => {
    const modes = el.dataset.helpModes.split(",").map(s => s.trim());
    el.hidden = !modes.includes(mode);
  });
  // Auto-select first visible nav item
  const firstVisible = document.querySelector(".help-nav-item[data-help-modes]:not([hidden])");
  if (firstVisible) {
    document.querySelectorAll(".help-nav-item").forEach(i => i.classList.remove("active"));
    document.querySelectorAll(".help-page").forEach(p => { p.hidden = true; });
    firstVisible.classList.add("active");
    document.getElementById("help-page-" + firstVisible.dataset.page).hidden = false;
  }
}

document.querySelectorAll(".help-mode-tab").forEach(tab => {
  tab.addEventListener("click", () => switchHelpMode(tab.dataset.helpMode));
});

// Nav item page switching (existing logic)
document.querySelectorAll(".help-nav-item").forEach(item => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".help-nav-item").forEach(i => i.classList.remove("active"));
    document.querySelectorAll(".help-page").forEach(p => { p.hidden = true; });
    item.classList.add("active");
    document.getElementById("help-page-" + item.dataset.page).hidden = false;
  });
});

// Initialize: show only "general" tab items on first open
switchHelpMode("general");

// ── Settings dialog ────────────────────────────────────��──────────────────────
const settingsDialog = document.getElementById("settings-dialog");
const fmtStatusEl = document.getElementById("settings-status");

document.getElementById("btn-settings").addEventListener("click", () => {
  settingsDialog.hidden = false;
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
    document.querySelectorAll(".settings-panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`settings-${tab.dataset.tab}-panel`).classList.add("active");
  });
});

// General tab Save button
document.getElementById("btn-save-general").addEventListener("click", async () => {
  const theme   = document.getElementById("theme-select").value;
  try {
    const resp = await apiFetch("/config/ui", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ theme }),
    });
    if (resp.status === 403) {
      // Hosted mode — apply locally only
      document.documentElement.className = `theme-${theme}`;
      document.getElementById("settings-status").textContent = "Applied (local only)";
    } else if (resp.ok) {
      document.documentElement.className = `theme-${theme}`;
      document.getElementById("settings-status").textContent = "Saved.";
      setTimeout(() => { document.getElementById("settings-status").textContent = ""; }, 2000);
    } else {
      document.getElementById("settings-status").textContent = "Failed to save";
    }
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
    const r = await apiFetch("/config/tolerances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tolerance_warn: warn, tolerance_fail: fail }),
    });
    if (r.status === 403) {
      // Apply locally
      state.tolerances.warn = warn;
      state.tolerances.fail = fail;
      if (statusEl3) { statusEl3.textContent = "Applied (local only)"; statusEl3.style.color = "var(--success)"; }
      if (state.showDeviations) redraw();
    } else if (r.ok) {
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
  apiFetch("/subpixel-methods").then(r => r.json()).then(methods => {
    subpixelSelect.innerHTML = "";
    for (const m of methods) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.selected = m === state.settings.subpixelMethod;
      opt.textContent = m === "none" ? "None (pixel-level)" :
        m === "parabola" ? "Parabola (default)" :
        m === "gaussian" ? "Gaussian (soft edges)" : m;
      subpixelSelect.appendChild(opt);
    }
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
    if (state.activeReticle && state.activeReticle.crosshair) {
      state.reticleColorOverride = swatch.dataset.color;
    }
    redraw();
  });
});

// Crosshair opacity
document.getElementById("crosshair-opacity").addEventListener("input", e => {
  const pct = parseInt(e.target.value);
  document.getElementById("crosshair-opacity-value").textContent = `${pct}%`;
  state.settings.crosshairOpacity = pct / 100;
  if (state.activeReticle && state.activeReticle.crosshair) {
    state.reticleOpacityOverride = pct / 100;
  }
  redraw();
});

// ── Camera dropdown controls ────────────────────────────────────────────────
// Log-scale mapping for exposure and gain. Bounds are camera-specific and get
// refreshed from /camera/info whenever the camera panel is opened. Each slider
// step is ~constant perceptual brightness change across the full range.
const CAM_SLIDER_MAX = 1000;

function logSliderToVal(pos, lo, hi) {
  if (hi <= lo) return lo;
  const p = Math.max(0, Math.min(CAM_SLIDER_MAX, Number(pos))) / CAM_SLIDER_MAX;
  return lo * Math.pow(hi / lo, p);
}
function logValToSlider(val, lo, hi) {
  if (hi <= lo) return 0;
  const v = Math.max(lo, Math.min(hi, Number(val)));
  return Math.round(Math.log(v / lo) / Math.log(hi / lo) * CAM_SLIDER_MAX);
}

// Exposure mapping uses whole µs.
function expSliderToUs(pos) {
  return Math.max(1, Math.round(logSliderToVal(pos, camBounds.expMin, camBounds.expMax)));
}
function expUsToSlider(us) {
  return logValToSlider(us, camBounds.expMin, camBounds.expMax);
}

// Gain mapping preserves camera-native units (dB or linear multiplier).
// Guard against camMin==0 which would break log scaling — use a tiny floor.
function gainSliderToVal(pos) {
  const lo = camBounds.gainMin > 0 ? camBounds.gainMin : 0.01;
  return logSliderToVal(pos, lo, camBounds.gainMax);
}
function gainValToSlider(v) {
  const lo = camBounds.gainMin > 0 ? camBounds.gainMin : 0.01;
  return logValToSlider(v, lo, camBounds.gainMax);
}
// How many decimal places to show in the gain number input. Linear-multiplier
// cameras (Baumer, gain_max ≈ 251) want 2 digits; dB cameras (max ≈ 24) want 1.
function gainDecimals() { return camBounds.gainMax > 50 ? 2 : 1; }

let _expPushTimer = null;
function pushExposure(us) {
  clearTimeout(_expPushTimer);
  _expPushTimer = setTimeout(async () => {
    try {
      await apiFetch("/camera/exposure", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: us }),
      });
    } catch (err) { console.error("Failed to set exposure:", err); }
  }, 40);
}

// Exposure slider (log scale)
document.getElementById("exp-slider-top")?.addEventListener("input", e => {
  const us = expSliderToUs(e.target.value);
  const inp = document.getElementById("exp-input-top");
  if (inp && document.activeElement !== inp) inp.value = us;
  pushExposure(us);
});

// Exposure number input — authoritative manual entry
document.getElementById("exp-input-top")?.addEventListener("input", e => {
  const us = Math.max(camBounds.expMin, Math.min(camBounds.expMax,
    parseFloat(e.target.value) || camBounds.expMin));
  const slider = document.getElementById("exp-slider-top");
  if (slider) slider.value = expUsToSlider(us);
  pushExposure(us);
});

let _gainPushTimer = null;
function pushGain(v) {
  clearTimeout(_gainPushTimer);
  _gainPushTimer = setTimeout(async () => {
    try {
      await apiFetch("/camera/gain", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: v }),
      });
    } catch (err) { console.error("Failed to set gain:", err); }
  }, 40);
}

// Gain slider (log scale, camera-native units)
document.getElementById("gain-slider-top")?.addEventListener("input", e => {
  const v = gainSliderToVal(e.target.value);
  const inp = document.getElementById("gain-input-top");
  if (inp && document.activeElement !== inp) inp.value = v.toFixed(gainDecimals());
  pushGain(v);
});

// Gain number input (camera-native units)
document.getElementById("gain-input-top")?.addEventListener("input", e => {
  const lo = camBounds.gainMin, hi = camBounds.gainMax;
  const v = Math.max(lo, Math.min(hi, parseFloat(e.target.value) || lo));
  const slider = document.getElementById("gain-slider-top");
  if (slider) slider.value = gainValToSlider(v);
  pushGain(v);
});

// Gamma slider (debounced)
let _gammaDebounce = null;
document.getElementById("gamma-slider")?.addEventListener("input", e => {
  const v = parseFloat(e.target.value);
  document.getElementById("gamma-value").textContent = v.toFixed(1);
  clearTimeout(_gammaDebounce);
  _gammaDebounce = setTimeout(async () => {
    try {
      await apiFetch("/camera/gamma", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: v }) });
    } catch (err) { console.error("Failed to set gamma:", err); }
  }, 200);
});

// Auto Exposure (software) — iteratively adjusts exposure to drive mean luma
// toward ~128. Works on any camera regardless of hardware ExposureAuto support.
// Uses the same luma sampling as the histogram strip.
async function measureMeanLuma() {
  const streamImg = document.getElementById("stream-img");
  if (!streamImg || !streamImg.naturalWidth) return null;
  const c = document.createElement("canvas");
  c.width = 160; c.height = 90;
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(streamImg, 0, 0, c.width, c.height);
  const data = cx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    n++;
  }
  return n > 0 ? sum / n : null;
}

async function setExposureAndWait(us) {
  await apiFetch("/camera/exposure", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: us }),
  });
  // Wait long enough for the new exposure to take effect AND for a fresh MJPEG
  // frame to arrive. Need: exposure time (frame must integrate) + ~2 frame
  // periods (@30 fps) for the stream to push the updated image.
  const need = Math.max(120, Math.ceil(us / 1000) + 100);
  await new Promise(r => setTimeout(r, need));
}

// Upper bound for exposure during auto-search. If mid-gray can't be reached
// with ≤200 ms exposure at current gain, the answer is "raise gain" or "add
// light", not "climb into multi-second territory while the user stares at a
// frozen UI". This bounds total auto-exposure time to ~5 iterations × ~350 ms.
const AUTO_EXP_MAX_US = 200_000;

document.getElementById("btn-auto-exposure")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-auto-exposure");
  const origLabel = btn.textContent;
  btn.disabled = true;
  try {
    const target = 128;          // mid-gray
    const tolerance = 8;         // ±8/255 ≈ ±3%
    const maxIters = 5;
    const searchMax = Math.min(AUTO_EXP_MAX_US, camBounds.expMax);
    const searchMin = camBounds.expMin;
    let us = parseFloat(document.getElementById("exp-input-top").value) || searchMin;
    us = Math.max(searchMin, Math.min(searchMax, us));
    let lastMean = null;
    let cappedLow = false, cappedHigh = false;
    for (let i = 0; i < maxIters; i++) {
      btn.textContent = `Adjusting ${i + 1}/${maxIters}…`;
      await setExposureAndWait(us);
      const mean = await measureMeanLuma();
      if (mean == null) break;
      lastMean = mean;
      if (Math.abs(mean - target) <= tolerance) break;
      // Scale exposure by target/mean, damped 0.33×..3× per iteration to
      // dodge overshoot on nonlinear sensors.
      const ratio = Math.max(1 / 3, Math.min(3, target / Math.max(1, mean)));
      const next = Math.round(us * ratio);
      if (next >= searchMax) { us = searchMax; cappedHigh = true; break; }
      if (next <= searchMin) { us = searchMin; cappedLow = true; break; }
      us = next;
    }
    // Sync the UI to whatever we landed on.
    const slider = document.getElementById("exp-slider-top");
    const inp = document.getElementById("exp-input-top");
    if (slider) slider.value = expUsToSlider(us);
    if (inp) inp.value = us;
    // Push the final exposure once more in case the loop exited on the cap
    // without calling setExposureAndWait at the new value.
    if (cappedHigh || cappedLow) {
      await apiFetch("/camera/exposure", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: us }),
      });
    }
    // User-facing diagnosis if we couldn't converge.
    if (cappedHigh) {
      showStatus(`Auto Exposure: too dark (mean ${Math.round(lastMean ?? 0)}/128). Raise gain or add light.`);
    } else if (cappedLow) {
      showStatus(`Auto Exposure: too bright (mean ${Math.round(lastMean ?? 255)}/128). Lower gain or reduce light.`);
    }
  } catch (err) {
    console.error("Auto exposure failed:", err);
    showStatus("Auto Exposure failed — see console.");
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel;
  }
});

// Auto WB (top bar)
document.getElementById("btn-wb-auto-top")?.addEventListener("click", async () => {
  try {
    const r = await apiFetch("/camera/white-balance/auto", { method: "POST" });
    if (!r.ok) throw new Error(await r.text());
    const ratios = await r.json();
    ["red", "green", "blue"].forEach(ch => {
      // Update top bar sliders
      const sliderTop = document.getElementById(`wb-${ch}-slider-top`);
      const displayTop = document.getElementById(`wb-${ch}-value-top`);
      if (sliderTop) sliderTop.value = ratios[ch];
      if (displayTop) displayTop.textContent = ratios[ch].toFixed(2);
      // Sync settings dialog sliders
      const slider = document.getElementById(`wb-${ch}-slider`);
      const display = document.getElementById(`wb-${ch}-value`);
      if (slider) slider.value = ratios[ch];
      if (display) display.textContent = ratios[ch].toFixed(2);
    });
  } catch (err) { console.error("Auto WB failed:", err); }
});

// WB RGB sliders (top bar, debounced)
let _wbTopDebounce = {};
["red", "green", "blue"].forEach(ch => {
  document.getElementById(`wb-${ch}-slider-top`)?.addEventListener("input", e => {
    const val = parseFloat(e.target.value);
    document.getElementById(`wb-${ch}-value-top`).textContent = val.toFixed(2);
    // Sync settings dialog slider
    const slider = document.getElementById(`wb-${ch}-slider`);
    const display = document.getElementById(`wb-${ch}-value`);
    if (slider) slider.value = val;
    if (display) display.textContent = val.toFixed(2);
    clearTimeout(_wbTopDebounce[ch]);
    _wbTopDebounce[ch] = setTimeout(async () => {
      try {
        await apiFetch("/camera/white-balance/ratio", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: ch.charAt(0).toUpperCase() + ch.slice(1),
            value: val,
          }),
        });
      } catch (err) { console.error("WB ratio update failed:", err); }
    }, 150);
  });
});

// Pixel format (top bar)
document.getElementById("pixel-format-top")?.addEventListener("change", async e => {
  const fmt = e.target.value;
  try {
    const r = await apiFetch("/camera/pixel-format", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pixel_format: fmt }),
    });
    if (!r.ok) throw new Error(await r.text());
    state.settings.pixelFormat = fmt;
  } catch (err) {
    console.error("Pixel format change failed:", err);
    await loadCameraInfo(); // revert
  }
});

// Camera select (top bar)
document.getElementById("camera-select-top")?.addEventListener("change", async e => {
  const camera_id = e.target.value;
  if (!camera_id) return;

  if (camera_id === "browser-cam" || camera_id.startsWith("browser-cam-")) {
    const deviceId = camera_id.startsWith("browser-cam-")
      ? camera_id.slice("browser-cam-".length) : null;
    await startBrowserCamera(deviceId);
    return;
  }

  // Switching away from browser camera — stop it first
  if (isBrowserCameraActive()) stopBrowserCamera();

  e.target.disabled = true;
  try {
    const r = await apiFetch("/camera/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ camera_id }),
    });
    if (!r.ok) throw new Error(await r.text());
    // Reconnect the MJPEG stream — the persistent HTTP connection still
    // points at the old reader thread's frame pipeline and won't auto-pick-up
    // the new camera until a fresh /stream request is made.
    img.src = "/stream?" + Date.now();
    await loadCameraInfo();
    await loadCameraList();
  } catch (err) {
    console.error("Camera switch failed:", err);
    await loadCameraList();
  }
  e.target.disabled = false;
});

// ROI Set from view
document.getElementById("btn-roi-set")?.addEventListener("click", async () => {
  const info = state._cameraInfo;
  if (!info) { showStatus("Camera info not loaded"); return; }

  // ROI from current viewport: freeze first, zoom into the area you want, then click
  if (viewport.zoom <= 1.05) {
    showStatus("Zoom into the area of interest first (freeze → zoom → Set from view)");
    return;
  }

  const currentRoi = info.roi || { offset_x: 0, offset_y: 0 };
  const wInc = info.roi_width_inc || 4;
  const hInc = info.roi_height_inc || 4;
  let ox = Math.max(0, currentRoi.offset_x + Math.round(viewport.panX));
  let oy = Math.max(0, currentRoi.offset_y + Math.round(viewport.panY));
  let w = Math.round(canvas.clientWidth / viewport.zoom);
  let h = Math.round(canvas.clientHeight / viewport.zoom);
  w = Math.max(wInc, Math.round(w / wInc) * wInc);
  h = Math.max(hInc, Math.round(h / hInc) * hInc);
  ox = Math.round(ox / wInc) * wInc;
  oy = Math.round(oy / hInc) * hInc;
  ox = Math.min(ox, info.sensor_width - w);
  oy = Math.min(oy, info.sensor_height - h);

  showStatus("Setting ROI...");
  try {
    const resp = await apiFetch("/camera/roi", {
      method: "PUT", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ offset_x: ox, offset_y: oy, width: w, height: h }),
    });
    if (resp.ok) {
      const result = await resp.json();
      showStatus(`ROI set: ${result.width}×${result.height} at (${result.offset_x}, ${result.offset_y})`);
      // Reconnect MJPEG stream (connection drops during ROI change)
      img.src = "/stream?" + Date.now();
      await loadCameraInfo();
    } else {
      const err = await resp.text();
      showStatus(`ROI failed: ${err}`);
    }
  } catch (err) { showStatus(`ROI failed: ${err.message}`); }
});

// ROI Reset
document.getElementById("btn-roi-reset")?.addEventListener("click", async () => {
  showStatus("Resetting ROI...");
  try {
    const resp = await apiFetch("/camera/roi/reset", { method: "POST" });
    if (resp.ok) {
      showStatus("ROI reset to full frame");
      img.src = "/stream?" + Date.now();
      await loadCameraInfo();
    } else {
      const err = await resp.text();
      showStatus(`ROI reset failed: ${err}`);
    }
  } catch (err) { showStatus(`ROI reset failed: ${err.message}`); }
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
// ── Template save/load ──────────────────────────────────────────────────────
function updateTemplateButtons() {
  const btn = document.getElementById("btn-save-template");
  if (!btn) return;
  const hasDxf = state.annotations.some(a => a.type === "dxf-overlay");
  const hasCal = !!state.calibration;
  btn.style.display = (hasDxf && hasCal) ? "" : "none";
}

document.addEventListener("dxf-state-changed", () => {
  updateTemplateButtons();
  updateTemplateDisplay();
});
updateTemplateButtons();

document.getElementById("btn-save-template")?.addEventListener("click", () => {
  closeAllDropdowns();
  const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
  if (!dxfAnn || !state.calibration) {
    showStatus("Load a DXF and calibrate before saving a template");
    return;
  }
  const defaultName = state.dxfFilename || "template";
  const name = prompt("Template name:", defaultName);
  if (!name) return;

  const tmpl = assembleTemplate({
    name,
    dxfFilename: state.dxfFilename || "",
    entities: dxfAnn.entities,
    calibration: {
      pixelsPerMm: state.calibration.pixelsPerMm,
      displayUnit: state.calibration.displayUnit || "mm",
    },
    tolerances: { warn: state.tolerances.warn, fail: state.tolerances.fail },
    featureTolerances: state.featureTolerances,
    featureModes: state.featureModes,
    featureNames: state.featureNames,
    detection: {
      cannyLow: parseInt(document.getElementById("canny-low").value),
      cannyHigh: parseInt(document.getElementById("canny-high").value),
      smoothing: parseInt(document.getElementById("adv-smoothing").value),
      subpixel: state.settings.subpixelMethod,
    },
    alignment: {
      method: "edge",
      smoothing: parseInt(document.getElementById("adv-smoothing").value),
    },
  });

  downloadTemplate(tmpl);
  showStatus("Template saved: " + name);
});

// ── Save as Reticle ──────────────────────────────────────────────────────────
document.getElementById("btn-save-reticle")?.addEventListener("click", async () => {
  closeAllDropdowns();
  if (!state.calibration || !state.calibration.pixelsPerMm) {
    showStatus("Calibration required to save a reticle");
    return;
  }
  const measurable = state.annotations.filter(a =>
    !a.type.startsWith('detected-') && a.type !== 'dxf-overlay' &&
    a.type !== 'edges-overlay' && a.type !== 'preprocessed-overlay' &&
    a.type !== 'origin' && a.type !== 'comment'
  );
  if (measurable.length === 0) {
    showStatus("No annotations to convert to a reticle");
    return;
  }
  const name = prompt("Reticle name:");
  if (!name) return;
  try {
    await saveCustomReticle(name);
    showStatus(`Reticle "${name}" saved`);
  } catch (err) {
    showStatus(`Error: ${err.message}`);
  }
});

document.getElementById("btn-load-template")?.addEventListener("click", () => {
  closeAllDropdowns();
  document.getElementById("template-input").click();
});

document.getElementById("template-input")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ""; // allow re-loading same file

  try {
    const tmpl = await readTemplateFile(file);

    // Unsaved work check
    const hasWork = state.annotations.some(a => !TRANSIENT_TYPES.has(a.type));
    if (hasWork) {
      if (!confirm("Loading a template will replace your current work. Continue?")) return;
    }

    // Calibration mismatch check
    if (state.calibration && Math.abs(state.calibration.pixelsPerMm - tmpl.calibration.pixelsPerMm) > 0.1) {
      if (!confirm(`Current calibration (${state.calibration.pixelsPerMm.toFixed(2)} px/mm) differs from template (${tmpl.calibration.pixelsPerMm.toFixed(2)} px/mm). Continue?`)) return;
    }

    // Clear existing DXF overlay, inspection results, feature state
    state.annotations = state.annotations.filter(a => a.type !== "dxf-overlay");
    state.inspectionResults = [];
    state.featureTolerances = {};
    state.featureModes = {};
    state.featureNames = {};

    // Apply calibration
    state.calibration = {
      pixelsPerMm: tmpl.calibration.pixelsPerMm,
      displayUnit: tmpl.calibration.displayUnit,
    };

    // Apply tolerances
    state.tolerances.warn = tmpl.tolerances.warn;
    state.tolerances.fail = tmpl.tolerances.fail;

    // Apply feature config
    if (tmpl.featureTolerances) state.featureTolerances = { ...tmpl.featureTolerances };
    if (tmpl.featureModes) state.featureModes = { ...tmpl.featureModes };
    if (tmpl.featureNames) state.featureNames = { ...tmpl.featureNames };

    // Create DXF overlay annotation
    const dxfAnn = {
      type: "dxf-overlay",
      entities: tmpl.dxf.entities,
      offsetX: canvas.width / 2,
      offsetY: canvas.height / 2,
      scale: tmpl.calibration.pixelsPerMm,
      rotation: 0,
      flipH: false,
      flipV: false,
      id: state.nextId++,
      name: "",
    };
    state.annotations.push(dxfAnn);
    state.dxfFilename = tmpl.dxf.filename || tmpl.name;

    // Update detection slider DOM values
    const sliderUpdates = [
      ["canny-low", tmpl.detection.cannyLow],
      ["canny-high", tmpl.detection.cannyHigh],
      ["adv-smoothing", tmpl.detection.smoothing],
    ];
    for (const [id, value] of sliderUpdates) {
      if (value != null) {
        const slider = document.getElementById(id);
        if (slider) slider.value = value;
        const valSpan = document.getElementById(id + "-val");
        if (valSpan) valSpan.textContent = value;
      }
    }

    // Set template state
    state._templateLoaded = true;
    state._templateName = tmpl.name;
    updateTemplateDisplay();

    // Update DXF panel visibility
    const dxfPanel = document.getElementById("dxf-controls-group");
    if (dxfPanel) dxfPanel.hidden = false;

    // Update scale input
    const scaleInput = document.getElementById("dxf-scale");
    if (scaleInput) scaleInput.value = tmpl.calibration.pixelsPerMm.toFixed(3);

    // Update calibration button and DXF controls (enables Run Inspection button)
    updateCalibrationButton();
    updateDxfControlsVisibility();

    // Dispatch dxf-state-changed to update template button visibility
    document.dispatchEvent(new CustomEvent("dxf-state-changed"));

    renderSidebar();
    renderInspectionTable();
    redraw();
    showStatus("Template loaded: " + tmpl.name);
  } catch (err) {
    alert("Failed to load template: " + err.message);
  }
});

initDxfHandlers();
initDetectHandlers();
initCompareHandlers();
initLensCal();
initTiltCal();
initCalProfiles();
initGlobalVisToggle();
initZstack();
initStitch();
initSuperRes();
initDeflectometry();
initGear();
initFringe();
initReticlePanel();
document.getElementById("btn-arc-fit-arc")?.addEventListener("click", () => finalizeArcFit(false));
document.getElementById("btn-arc-fit-circle")?.addEventListener("click", () => finalizeArcFit(true));

new ResizeObserver(resizeCanvas).observe(img);
img.addEventListener("load", resizeCanvas);
window.addEventListener("resize", resizeCanvas);

document.querySelectorAll("#tool-strip .strip-btn[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
});
initSubModeSelector();   // wires the segmented control under the tool strip
setTool(state.tool);  // sync initial active state via setTool

loadCameraInfo();
loadUiConfig();
loadTolerances();
updateCalibrationButton();
checkStartupWarning();
resizeCanvas();

// ── SPC Dashboard wiring ──────────────────────────────────────────────────────
loadSpcParts();

document.getElementById("spc-part-select")?.addEventListener("change", (e) => {
  loadSpcFeatures(e.target.value);
  // Clear chart when part changes
  const chart = document.getElementById("spc-chart");
  const summary = document.getElementById("spc-cpk-summary");
  if (chart) chart.getContext("2d").clearRect(0, 0, chart.width, chart.height);
  if (summary) summary.innerHTML = "";
});

document.getElementById("spc-feature-select")?.addEventListener("change", (e) => {
  const partId = document.getElementById("spc-part-select")?.value;
  if (partId && e.target.value) loadSpcData(partId, e.target.value);
});

document.getElementById("spc-header")?.addEventListener("click", () => {
  const body = document.getElementById("spc-body");
  const header = document.getElementById("spc-header");
  if (!body || !header) return;
  const collapsed = body.hidden;
  body.hidden = !collapsed;
  header.textContent = collapsed ? "SPC Dashboard \u25BE" : "SPC Dashboard \u25B8";
});

// Auto-save every 30 seconds
setInterval(autoSave, 30000);

// Offer to restore previous session
tryAutoRestore();

// Warn before closing if unsaved
window.addEventListener("beforeunload", e => {
  // Best-effort session cleanup (frees server memory)
  try {
    fetch("/session", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-Session-ID": getSessionId(),
      },
      keepalive: true,
    });
  } catch { /* ignore */ }

  // Existing dirty-state warning
  if (!state._savedManually && state.annotations.some(a => !TRANSIENT_TYPES.has(a.type))) {
    e.preventDefault();
    e.returnValue = "";
  }
});
updateFreezeUI();

// ── Camera signal histogram ────────────────────────────────────────────────
// Samples the live stream image at ~1 Hz whenever the camera panel is open
// and draws a luma histogram + min/mean/max/clip stats. Pure client-side —
// no backend round-trips.
(function initCameraHistogram() {
  const hist = document.getElementById("camera-histogram");
  const stats = document.getElementById("camera-signal-stats");
  const panel = document.getElementById("dropdown-camera");
  const streamImg = document.getElementById("stream-img");
  if (!hist || !stats || !panel || !streamImg) return;

  const hctx = hist.getContext("2d");
  const sample = document.createElement("canvas");
  sample.width = 160;
  sample.height = 90;
  const sctx = sample.getContext("2d", { willReadFrequently: true });

  function tick() {
    if (panel.hidden) return;
    if (streamImg.hidden || streamImg.style.display === "none") {
      stats.textContent = "— stream not visible —";
      hctx.clearRect(0, 0, hist.width, hist.height);
      return;
    }
    if (!streamImg.naturalWidth) return;
    try {
      sctx.drawImage(streamImg, 0, 0, sample.width, sample.height);
      const data = sctx.getImageData(0, 0, sample.width, sample.height).data;
      const bins = new Uint32Array(32);
      let lo = 255, hi = 0, sum = 0, n = 0;
      let clipLo = 0, clipHi = 0;
      for (let i = 0; i < data.length; i += 4) {
        // Rec.709 luma
        const y = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) | 0;
        bins[y >> 3]++;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
        sum += y;
        n++;
        if (y === 0) clipLo++;
        else if (y >= 254) clipHi++;
      }
      const mean = n > 0 ? sum / n : 0;
      const clipLoPct = n > 0 ? (100 * clipLo / n) : 0;
      const clipHiPct = n > 0 ? (100 * clipHi / n) : 0;

      // Draw histogram
      const W = hist.width, H = hist.height;
      hctx.clearRect(0, 0, W, H);
      let max = 0;
      for (let i = 0; i < bins.length; i++) if (bins[i] > max) max = bins[i];
      const barW = W / bins.length;
      hctx.fillStyle = "#4a9eff";
      for (let i = 0; i < bins.length; i++) {
        const h = max > 0 ? Math.round((bins[i] / max) * (H - 2)) : 0;
        hctx.fillRect(i * barW + 0.5, H - h - 1, barW - 1, h);
      }
      // Mean marker
      hctx.fillStyle = "#ffcc00";
      hctx.fillRect(Math.round((mean / 255) * W), 0, 1, H);

      // Stats text with inline clip warnings
      const loMark = clipLoPct > 1 ? `<span class="clip-lo">clip↓${clipLoPct.toFixed(0)}%</span>` : "";
      const hiMark = clipHiPct > 1 ? `<span class="clip-hi">clip↑${clipHiPct.toFixed(0)}%</span>` : "";
      stats.innerHTML =
        `min ${lo} · mean ${mean.toFixed(0)} · max ${hi}` +
        (loMark || hiMark ? `<br>${loMark} ${hiMark}` : "");
    } catch (err) {
      // Cross-origin or image not yet decoded — quietly skip
      stats.textContent = "—";
    }
  }
  setInterval(tick, 1000);
})();
