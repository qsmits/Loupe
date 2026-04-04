// ── Undo / Redo / Keyboard shortcuts ─────────────────────────────────────────
import { state, undoStack, redoStack, takeSnapshot } from './state.js';
import { canvas, showStatus, redraw, resizeCanvas } from './render.js';
import { renderSidebar } from './sidebar.js';
import { deleteSelected, elevateSelected } from './annotations.js';
import { setTool, finalizeArcFit, finalizeArea, finalizeSpline } from './tools.js';
import { exitDxfAlignMode } from './dxf.js';
import { saveSession } from './session.js';
import { viewport, fitToWindow, zoomOneToOne } from './viewport.js';
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

export function initKeyboard(closeAllDropdowns) {
  document.addEventListener("keydown", e => {
    // Help dialog shortcut — works even when an input is focused
    if (e.key === "?") {
      const anyDialogOpen = document.querySelector(".dialog-overlay:not([hidden])") !== null;
      if (!anyDialogOpen) document.getElementById("help-dialog").hidden = false;
      return;
    }
    // All other shortcuts are blocked when an input/select/textarea/dialog is focused
    if (document.activeElement.closest("input, select, textarea") !== null || document.querySelector(".dialog-overlay:not([hidden])") !== null) return;

    if (e.key === "Enter") {
      if (state.inspectionPickTarget) { _finalizePickInspection(); return; }
      if (state.tool === "spline" && state.pendingPoints.length >= 2) { finalizeSpline(); return; }
      if (state.tool === "arc-fit" && state.pendingPoints.length >= 3) { finalizeArcFit(); return; }
      if (state.tool === "area" && state.pendingPoints.length >= 3) { finalizeArea(); return; }
    }
    if ((e.key === "Delete" || e.key === "Backspace") && state.selected.size > 0) {
      deleteSelected();
      return;
    }
    if (e.key === "Escape") {
      if (state.inspectionPickTarget) {
        state.inspectionPickTarget = null;
        state.inspectionPickPoints = [];
        state.inspectionPickFit = null;
        showStatus("Point-pick cancelled");
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
    const toolKeys = { v: "select", c: "calibrate", d: "distance", a: "angle",
                       o: "circle", f: "arc-fit", m: "center-dist", e: "detect",
                       p: "perp-dist", l: "para-dist", r: "area", b: "spline",
                       g: "pt-circle-dist", i: "intersect", w: "slot-dist", h: "pan" };
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
