// ── Undo / Redo / Keyboard shortcuts ─────────────────────────────────────────
import { state, undoStack, redoStack, takeSnapshot } from './state.js';
import { canvas, showStatus, redraw, resizeCanvas } from './render.js';
import { renderSidebar } from './sidebar.js';
import { deleteSelected, elevateSelected } from './annotations.js';
import { setTool, promptArcFitChoice, finalizeArcFit, finalizeArea, finalizeSpline, finalizeFitLine, nudgeSelected } from './tools.js';
import { exitDxfAlignMode } from './dxf.js';
import { saveSession } from './session.js';
import { viewport, fitToWindow, zoomOneToOne, clampPan } from './viewport.js';
import { hideContextMenu } from './events-context-menu.js';
import { _finalizePickInspection } from './events-inspection.js';

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(takeSnapshot());
  const snap = JSON.parse(undoStack.pop());
  state.annotations = snap.annotations;
  state.calibration = snap.calibration;
  state.origin = snap.origin;
  state.selected = new Set(
    [...state.selected].filter(id => state.annotations.some(a => a.id === id))
  );
  state._dirty = true;
  state._savedManually = false;
  renderSidebar(); redraw();
}

export function redo() {
  if (!redoStack.length) return;
  undoStack.push(takeSnapshot());
  const snap = JSON.parse(redoStack.pop());
  state.annotations = snap.annotations;
  state.calibration = snap.calibration;
  state.origin = snap.origin;
  state.selected = new Set(
    [...state.selected].filter(id => state.annotations.some(a => a.id === id))
  );
  state._dirty = true;
  state._savedManually = false;
  renderSidebar(); redraw();
}

let _spacebarPrevTool = null;  // non-null while spacebar is held

export function initKeyboard(closeAllDropdowns) {
  document.addEventListener("keyup", e => {
    if (e.key === " " && _spacebarPrevTool !== null) {
      setTool(_spacebarPrevTool);
      _spacebarPrevTool = null;
    }
  });

  document.addEventListener("keydown", e => {
    // Help dialog shortcut — works even when an input is focused
    if (e.key === "?") {
      const anyDialogOpen = document.querySelector(".dialog-overlay:not([hidden])") !== null;
      if (!anyDialogOpen) document.getElementById("help-dialog").hidden = false;
      return;
    }
    // All other shortcuts are blocked when an input/select/textarea/dialog is focused
    if (document.activeElement.closest("input, select, textarea") !== null || document.querySelector(".dialog-overlay:not([hidden])") !== null) return;

    // Spacebar — temporary pan while held (Figma / CAD convention)
    if (e.key === " " && !e.repeat) {
      e.preventDefault();
      if (state.tool !== "pan") {
        _spacebarPrevTool = state.tool;
        setTool("pan");
      }
      return;
    }
    if (e.key === " ") { e.preventDefault(); return; }  // suppress repeat scroll

    if (e.key === "Enter") {
      if (state.inspectionPickTarget) { _finalizePickInspection(); return; }
      if (state.tool === "spline" && state.pendingPoints.length >= 2) { finalizeSpline(); return; }
      if (state.tool === "arc-fit" && state.pendingPoints.length >= 3) { promptArcFitChoice(); return; }
      if (state.tool === "area" && state.pendingPoints.length >= 3) { finalizeArea(); return; }
      if (state.tool === "fit-line" && state.pendingPoints.length >= 2) { finalizeFitLine(); return; }
    }
    if ((e.key === "Delete" || e.key === "Backspace") && state.selected.size > 0) {
      deleteSelected();
      return;
    }
    if (e.key === "Escape") {
      document.getElementById("arc-fit-chooser").hidden = true;
      if (state.inspectionPickTarget) {
        state.inspectionPickTarget = null;
        state.inspectionPickPoints = [];
        state.inspectionPickFit = null;
        showStatus("Point-pick cancelled");
        redraw();
        return;
      }
      if (state.gearPickMode) {
        state.gearPickMode = null;
        state.gearPickBuffer = null;
        showStatus("Gear analysis cancelled");
        redraw();
        return;
      }
      hideContextMenu();
      closeAllDropdowns();
      if (state.dxfDragMode) {
        state.dxfDragMode = false;
        state.dxfDragOrigin = null;
        document.getElementById("btn-dxf-move")?.classList.remove("active");
        showStatus(state.frozen ? "Frozen" : "Live");
      }
      if (state.dxfAlignMode) { exitDxfAlignMode(); redraw(); return; }
      state.pendingPoints = [];
      state.pendingCenterCircle = null;
      if (state._dxfOriginMode) {
        state._dxfOriginMode = false;
        document.getElementById("btn-dxf-set-origin")?.classList.remove("active");
        showStatus(state.frozen ? "Frozen" : "Live");
      }
      setTool("select");
      if (state._originMode) {
        state._originMode = false;
        document.getElementById("btn-set-origin").classList.remove("active");
      }
      return;
    }
    const ctrlOrMeta = e.ctrlKey || e.metaKey;
    if (ctrlOrMeta && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (ctrlOrMeta && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (e.key === "u" && state.selected.size > 0) {
      elevateSelected();
      return;
    }
    if (e.key === "0" && state.frozen) {
      const rect = canvas.getBoundingClientRect();
      fitToWindow(rect.width, rect.height);
      resizeCanvas();
      return;
    }
    if (e.key === "1" && state.frozen) {
      const rect = canvas.getBoundingClientRect();
      zoomOneToOne(rect.width, rect.height);
      resizeCanvas();
      return;
    }
    if (e.key === "`" && !e.ctrlKey && !e.metaKey) {
      state.showGrid = !state.showGrid;
      document.getElementById("btn-grid")?.classList.toggle("active", state.showGrid);
      showStatus(state.showGrid ? "Grid on" : "Grid off");
      redraw();
      return;
    }
    if (e.key.startsWith("Arrow")) {
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp"   ? -step : e.key === "ArrowDown"  ? step : 0;
      if (state.selected.size > 0) {
        e.preventDefault();
        nudgeSelected(dx, dy);
        renderSidebar();
        redraw();
      } else if (state.frozen) {
        e.preventDefault();
        viewport.panX += dx;
        viewport.panY += dy;
        const rect = canvas.getBoundingClientRect();
        clampPan(rect.width, rect.height);
        resizeCanvas();
      }
      return;
    }

    // Consolidated 6-entry measure menu: shortcuts only target the top-level
    // tool (the default sub-mode of each group). Sub-mode switching happens
    // via the segmented selector below the tool strip.
    const toolKeys = { v: "select", c: "calibrate", e: "detect", h: "pan",
                       d: "distance",   // Distance group (default: Direct)
                       a: "angle",      // Angle group
                       o: "circle",     // Circle/Arc group (default: 3-point)
                       l: "fit-line",   // Flatness group
                       r: "area",       // Area group (default: Polygon)
                       i: "intersect",  // Intersect
                       t: "comment",    // Note / comment annotation
                     };
    const toolName = toolKeys[e.key.toLowerCase()];
    if (toolName) {
      setTool(toolName);
      return;
    }
    if (e.key.toLowerCase() === "s") {
      saveSession();
      return;
    }
  });
}
