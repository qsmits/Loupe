import { state, undoStack, redoStack, takeSnapshot, _deviationHitBoxes, pushUndo, TRANSIENT_TYPES } from './state.js';
import { canvas, ctx, img, showStatus, redraw, resizeCanvas,
         drawLine, drawOrigin, drawAreaPreview } from './render.js';
import { renderSidebar, loadCameraInfo, loadUiConfig, loadTolerances,
         updateCalibrationButton, checkStartupWarning, updateFreezeUI,
         loadCameraList, renderInspectionTable } from './sidebar.js';
import { addAnnotation, deleteAnnotation, deleteSelected, elevateSelected, isDetection, clearDetections, clearMeasurements, clearDxfOverlay, clearAll } from './annotations.js';
import { setTool, handleToolClick, handleSelectDown, handleDrag,
         canvasPoint, snapPoint, collectDxfSnapPoints,
         projectConstrained, hitTestDxfEntity } from './tools.js';
import { fitCircle, fitLine, fitCircleAlgebraic, distPointToSegment } from './math.js';
import { exitDxfAlignMode, initDxfHandlers,
         openFeatureTolPopover } from './dxf.js';
import { doFreeze, initDetectHandlers } from './detect.js';
import { saveSession, loadSession, exportAnnotatedImage, exportCsv, autoSave, tryAutoRestore } from './session.js';
import { viewport, screenToImage, clampPan, fitToWindow, zoomOneToOne, imageWidth, imageHeight } from './viewport.js';

// ── Context menu ──────────────────────────────────────────────────────────
const ctxMenu = document.getElementById("context-menu");

function showContextMenu(x, y, items) {
  ctxMenu.innerHTML = "";
  for (const item of items) {
    if (item === "---") {
      const d = document.createElement("div");
      d.className = "ctx-divider";
      ctxMenu.appendChild(d);
    } else {
      const btn = document.createElement("button");
      btn.className = "ctx-item";
      btn.textContent = item.label;
      btn.addEventListener("click", () => { ctxMenu.hidden = true; item.action(); });
      ctxMenu.appendChild(btn);
    }
  }
  // Position, keeping on screen
  ctxMenu.hidden = false;
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.min(x, window.innerWidth - rect.width - 5) + "px";
  ctxMenu.style.top = Math.min(y, window.innerHeight - rect.height - 5) + "px";
}

function hideContextMenu() { ctxMenu.hidden = true; }

document.addEventListener("click", hideContextMenu);

// ── Undo / Redo ─────────────────────────────────────────────────────────────
function undo() {
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

function redo() {
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

// ─── Dropdown helpers ────────────────────────────────────────────────────────
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

// ── Canvas mouse events ──────────────────────────────────────────────────────
function onMouseDown(e) {
  if (e.button !== 0 && e.button !== 1) return;
  // Pan: middle-mouse always, or left-click in pan tool
  if (e.button === 1 || (e.button === 0 && state.tool === "pan")) {
    e.preventDefault();
    state._panStart = { x: e.clientX, y: e.clientY, panX: viewport.panX, panY: viewport.panY };
    canvas.style.cursor = "grabbing";
    return;
  }
  if (state.dxfDragMode) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (ann) {
      const pt = canvasPoint(e);
      state.dxfDragOrigin = {
        mouseX: pt.x, mouseY: pt.y,
        annOffsetX: ann.offsetX, annOffsetY: ann.offsetY,
      };
    }
    return;
  }
  const pt = canvasPoint(e);
  if (state.dxfAlignMode) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (!ann) { exitDxfAlignMode(); return; }

    if (state.dxfAlignStep === 0) {
      const target = state.dxfAlignHover;
      if (!target) return;
      state.dxfAlignPick = target;
      state.dxfAlignStep = 1;
      showStatus("Click the image point to align to…");
    } else {
      const imagePt = e.altKey ? pt : snapPoint(pt, false).pt;
      pushUndo();
      ann.offsetX += imagePt.x - state.dxfAlignPick.canvas.x;
      ann.offsetY += imagePt.y - state.dxfAlignPick.canvas.y;
      exitDxfAlignMode();
      showStatus("DXF aligned");
      redraw();
    }
    return;
  }
  if (state._originMode) {
    pushUndo();
    // Remove any existing origin annotation
    state.annotations = state.annotations.filter(a => a.type !== "origin");
    state.origin = { x: pt.x, y: pt.y, angle: 0 };
    addAnnotation({ type: "origin", x: pt.x, y: pt.y, angle: 0 });
    state._originMode = false;
    document.getElementById("btn-set-origin").classList.remove("active");
    return;
  }
  if (state._dxfOriginMode) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (ann) { ann.offsetX = pt.x; ann.offsetY = pt.y; redraw(); }
    state._dxfOriginMode = false;
    document.getElementById("btn-dxf-set-origin")?.classList.remove("active");
    showStatus(state.frozen ? "Frozen" : "Live");
    return;
  }
  // Hit-test deviation labels — open per-feature tolerance popover if clicked
  if (state.showDeviations && _deviationHitBoxes.length) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top)  * scaleY;
    for (const box of _deviationHitBoxes) {
      if (box.handle && cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h) {
        openFeatureTolPopover(box.handle, e.clientX, e.clientY);
        e.stopPropagation();
        return;
      }
    }
  }
  // Point-pick mode: add a measurement point
  if (state.inspectionPickTarget) {
    state.inspectionPickPoints.push(pt);
    _updatePickFit();
    redraw();
    return;
  }

  // DXF feature click-to-select for point-pick (when inspection results exist)
  if (state.tool === "select") {
    const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
    if (dxfAnn && dxfAnn.guidedResults) {
      const entity = hitTestDxfEntity(pt, dxfAnn);
      if (entity) {
        state.inspectionPickTarget = entity;
        state.inspectionPickPoints = [];
        state.inspectionPickFit = null;
        showStatus("Click points along the edge. Double-click or Enter to finish. Escape to cancel.");
        redraw();
        return;
      }
    }
    handleSelectDown(pt, e);
    return;
  }
  handleToolClick(pt, e);
}

function _hitTestGuidedResult(pt, dxfAnn) {
  const threshold = 10 / viewport.zoom;
  let best = null, bestDist = threshold;
  for (const r of (dxfAnn.guidedResults || [])) {
    if (!r.matched || !r.fit) continue;
    let dist = Infinity;
    if (r.fit.type === "line") {
      dist = distPointToSegment(pt, { x: r.fit.x1, y: r.fit.y1 }, { x: r.fit.x2, y: r.fit.y2 });
    } else if (r.fit.cx != null) {
      dist = Math.abs(Math.hypot(pt.x - r.fit.cx, pt.y - r.fit.cy) - r.fit.r);
    }
    if (dist < bestDist) { bestDist = dist; best = r; }
  }
  return best;
}

function _annotationPrimaryPoint(ann) {
  // Frame-scaled types
  if (ann.frameWidth) {
    const sx = imageWidth / ann.frameWidth;
    const sy = imageHeight / ann.frameHeight;
    if (ann.cx != null) return { x: ann.cx * sx, y: ann.cy * sy };
    if (ann.x1 != null) return { x: (ann.x1 + ann.x2) / 2 * sx, y: (ann.y1 + ann.y2) / 2 * sy };
    if (ann.x != null) return { x: ann.x * sx, y: ann.y * sy };
  }
  // Canvas-space types
  if (ann.a && ann.b) return { x: (ann.a.x + ann.b.x) / 2, y: (ann.a.y + ann.b.y) / 2 };
  if (ann.cx != null) return { x: ann.cx, y: ann.cy };
  if (ann.vertex) return { x: ann.vertex.x, y: ann.vertex.y };
  if (ann.x != null) return { x: ann.x, y: ann.y };
  if (ann.points) {
    const cx = ann.points.reduce((s, p) => s + p.x, 0) / ann.points.length;
    const cy = ann.points.reduce((s, p) => s + p.y, 0) / ann.points.length;
    return { x: cx, y: cy };
  }
  return null;
}

function onMouseUp() {
  if (state._panStart) {
    state._panStart = null;
    canvas.style.cursor = state.tool === "pan" ? "grab" : "";
    return;
  }
  if (state.dxfDragMode) {
    state.dxfDragOrigin = null;
    return;
  }
  if (state._selectRect) {
    const r = state._selectRect;
    const minX = Math.min(r.x1, r.x2), maxX = Math.max(r.x1, r.x2);
    const minY = Math.min(r.y1, r.y2), maxY = Math.max(r.y1, r.y2);
    if (maxX - minX > 5 && maxY - minY > 5) {
      const ids = [];
      for (const ann of state.annotations) {
        const cp = _annotationPrimaryPoint(ann);
        if (cp && cp.x >= minX && cp.x <= maxX && cp.y >= minY && cp.y <= maxY) {
          ids.push(ann.id);
        }
      }
      state.selected = new Set(ids);
      if (ids.length > 0) showStatus(`${ids.length} selected`);
    }
    state._selectRect = null;
    renderSidebar();
    redraw();
    return;
  }
  if (state.dragState !== null) pushUndo();
  state.dragState = null;
}

canvas.addEventListener("mousedown", onMouseDown);
canvas.addEventListener("mouseup", onMouseUp);

// ── Point-pick helpers ────────────────────────────────────────────────────────
function _updatePickFit() {
  const pts = state.inspectionPickPoints;
  const target = state.inspectionPickTarget;
  if (!target) return;
  state.inspectionPickFit = null;
  const etype = target.type;
  if ((etype === "line" || etype === "polyline_line") && pts.length >= 2) {
    state.inspectionPickFit = fitLine(pts);
  } else if ((etype === "arc" || etype === "polyline_arc" || etype === "circle") && pts.length >= 3) {
    const result = fitCircleAlgebraic(pts);
    if (result) state.inspectionPickFit = { type: "circle", cx: result.cx, cy: result.cy, r: result.r };
  }
}

async function _finalizePickInspection() {
  const target = state.inspectionPickTarget;
  const pts = state.inspectionPickPoints;
  if (!target || pts.length < 2) {
    showStatus("Need at least 2 points");
    return;
  }
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (!ann) return;
  const cal = state.calibration;
  if (!cal?.pixelsPerMm) return;

  try {
    const resp = await fetch("/fit-feature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity: target,
        points: pts.map(p => [p.x, p.y]),
        pixels_per_mm: cal.pixelsPerMm,
        tx: ann.offsetX, ty: ann.offsetY,
        angle_deg: ann.angle ?? 0,
        flip_h: ann.flipH ?? false, flip_v: ann.flipV ?? false,
        tolerance_warn: state.tolerances.warn,
        tolerance_fail: state.tolerances.fail,
      }),
    });
    if (!resp.ok) { showStatus("Fit failed"); return; }
    const result = await resp.json();
    result.source = "manual";

    // Replace or add to guided results
    if (ann.guidedResults) {
      const idx = ann.guidedResults.findIndex(r => r.handle === target.handle);
      if (idx >= 0) ann.guidedResults[idx] = result;
      else ann.guidedResults.push(result);
    }

    // Update state.inspectionResults
    const sr = {
      handle: result.handle, type: result.type, parent_handle: result.parent_handle,
      matched: result.matched, deviation_mm: result.perp_dev_mm ?? result.center_dev_mm,
      angle_error_deg: result.angle_error_deg,
      tolerance_warn: result.tolerance_warn, tolerance_fail: result.tolerance_fail,
      pass_fail: result.pass_fail, source: "manual",
    };
    const sIdx = state.inspectionResults.findIndex(r => r.handle === target.handle);
    if (sIdx >= 0) state.inspectionResults[sIdx] = sr;
    else state.inspectionResults.push(sr);

    showStatus(`Manual measurement: ${result.pass_fail?.toUpperCase() ?? "done"}`);
    renderInspectionTable();
  } catch (err) {
    showStatus("Fit error: " + err.message);
  }

  state.inspectionPickTarget = null;
  state.inspectionPickPoints = [];
  state.inspectionPickFit = null;
  redraw();
}

canvas.addEventListener("dblclick", e => {
  if (state.inspectionPickTarget) {
    e.preventDefault();
    _finalizePickInspection();
  }
});

// ── Mousemove ────────────────────────────────────────────────────────────────
canvas.addEventListener("mousemove", e => {
  const pt = canvasPoint(e);
  const rawPt = pt;
  state.mousePos = pt;
  if (state._panStart) {
    const dx = (e.clientX - state._panStart.x);
    const dy = (e.clientY - state._panStart.y);
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    viewport.panX = state._panStart.panX - dx * scale / viewport.zoom;
    viewport.panY = state._panStart.panY - dy * scale / viewport.zoom;
    clampPan(rect.width, rect.height);
    resizeCanvas();
    return;
  }
  if (state.dxfDragMode && state.dxfDragOrigin) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (ann) {
      ann.offsetX = state.dxfDragOrigin.annOffsetX + (pt.x - state.dxfDragOrigin.mouseX);
      ann.offsetY = state.dxfDragOrigin.annOffsetY + (pt.y - state.dxfDragOrigin.mouseY);
      redraw();
    }
    return;
  }
  if (state.dxfAlignMode) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (ann) {
      const pts = collectDxfSnapPoints(ann);
      const SNAP_R = 12;
      let best = null, bestD = Infinity;
      for (const p of pts) {
        const d = Math.hypot(pt.x - p.canvas.x, pt.y - p.canvas.y);
        if (d < bestD) { bestD = d; best = p; }
      }
      state.dxfAlignHover = (bestD < SNAP_R) ? best : null;
    }
    if (state.dxfAlignStep === 1) {
      const { pt: snappedPt, snapped } = snapPoint(rawPt, e.altKey);
      state.snapTarget = (snapped && !e.altKey) ? snappedPt : null;
    } else {
      state.snapTarget = null;
    }
    redraw();
    return;
  }
  if (state._selectRect) {
    const pt2 = canvasPoint(e);
    state._selectRect.x2 = pt2.x;
    state._selectRect.y2 = pt2.y;
    redraw();
    return;
  }
  if (state.dragState) { handleDrag(pt); return; }
  if (state.tool !== "select" && state.tool !== "calibrate" && state.tool !== "center-dist") {
    const { pt: snappedPt, snapped } = snapPoint(rawPt, e.altKey);
    state.snapTarget = (snapped && !e.altKey) ? snappedPt : null;
    redraw();
  }
  if (state.pendingPoints.length > 0 && state.tool !== "select"
      && state.tool !== "arc-fit"
      && state.tool !== "perp-dist"
      && state.tool !== "para-dist"
      && state.tool !== "area") {
    const { pt: snappedPt, snapped } = snapPoint(rawPt, e.altKey);
    state.snapTarget = (snapped && !e.altKey) ? snappedPt : null;
    redraw();
    const last = state.pendingPoints[state.pendingPoints.length - 1];
    if (state.tool === "circle" && state.pendingPoints.length === 2) {
      try {
        const preview = fitCircle(state.pendingPoints[0], state.pendingPoints[1], snappedPt);
        ctx.save();
        ctx.beginPath();
        ctx.arc(preview.cx, preview.cy, preview.r, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(251,146,60,0.6)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      } catch {
        // collinear — no preview
      }
    } else if (state.tool === "arc-measure" && state.pendingPoints.length === 2) {
      const [p1, p2] = state.pendingPoints;
      const p3 = snappedPt;
      const ax = p2.x - p1.x, ay = p2.y - p1.y;
      const bx = p3.x - p1.x, by = p3.y - p1.y;
      const D = 2 * (ax * by - ay * bx);
      if (Math.abs(D) >= 1e-6) {
        const ux = (by * (ax*ax + ay*ay) - ay * (bx*bx + by*by)) / D;
        const uy = (ax * (bx*bx + by*by) - bx * (ax*ax + ay*ay)) / D;
        const pcx = p1.x + ux, pcy = p1.y + uy;
        const pr  = Math.hypot(ux, uy);
        const pa1 = Math.atan2(p1.y - pcy, p1.x - pcx);
        const pa3 = Math.atan2(p3.y - pcy, p3.x - pcx);
        ctx.save();
        ctx.beginPath();
        ctx.arc(pcx, pcy, pr, pa1, pa3);
        ctx.strokeStyle = "rgba(191,90,242,0.6)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    } else {
      drawLine(last, snappedPt, "rgba(251,146,60,0.5)", 1);
    }
  }

  // Constrained rubber-band for perp-dist and para-dist
  if ((state.tool === "perp-dist" || state.tool === "para-dist")
      && state.pendingPoints.length === 1 && state.pendingRefLine) {
    const { pt: snappedPt, snapped } = snapPoint(rawPt, e.altKey);
    state.snapTarget = (snapped && !e.altKey) ? snappedPt : null;
    redraw();
    const b = projectConstrained(snappedPt, state.pendingPoints[0], state.pendingRefLine,
                                 state.tool === "perp-dist");
    drawLine(state.pendingPoints[0], b, "rgba(251,146,60,0.5)", 1);
  }

  // Area polygon preview
  if (state.tool === "area" && state.pendingPoints.length >= 1) {
    const { pt: snappedPt, snapped } = snapPoint(rawPt, e.altKey);
    state.snapTarget = (snapped && !e.altKey) ? snappedPt : null;
    redraw();
    drawAreaPreview(state.pendingPoints, snappedPt);
  }

  // Coordinate readout HUD
  const coordEl = document.getElementById("coord-display");
  if (coordEl && state.origin) {
    const rawDx = pt.x - state.origin.x;
    const rawDy = pt.y - state.origin.y;
    // Project into user frame: dot with X unit (cos θ, sin θ) and Y unit (sin θ, -cos θ)
    // Y unit is 90° CCW on screen (canvas Y-down), so Y+ points up when angle=0
    const a = state.origin.angle ?? 0;
    const rx =  Math.cos(a) * rawDx + Math.sin(a) * rawDy;
    const ry =  Math.sin(a) * rawDx - Math.cos(a) * rawDy;
    if (!state.calibration) {
      coordEl.textContent = `X: ${rx.toFixed(0)} px  Y: ${ry.toFixed(0)} px`;
    } else {
      const ppm = state.calibration.pixelsPerMm;
      if (state.calibration.displayUnit === "µm") {
        coordEl.textContent =
          `X: ${(rx / ppm * 1000).toFixed(1)} µm  Y: ${(ry / ppm * 1000).toFixed(1)} µm`;
      } else {
        coordEl.textContent =
          `X: ${(rx / ppm).toFixed(3)} mm  Y: ${(ry / ppm).toFixed(3)} mm`;
      }
    }
  }
  if (state._originMode) {
    redraw();
    ctx.save();
    ctx.globalAlpha = 0.5;
    drawOrigin({ x: pt.x, y: pt.y, angle: state.origin?.angle ?? 0 }, false);
    ctx.restore();
  }
  if (state.tool === "select") {
    state.snapTarget = null;
  }
});

canvas.addEventListener("mouseleave", () => {
  const coordEl = document.getElementById("coord-display");
  if (coordEl) coordEl.textContent = "";
});

canvas.addEventListener("contextmenu", e => {
  e.preventDefault();
  hideContextMenu();

  // Check if right-click hits a guided inspection result
  const pt = canvasPoint(e);
  const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
  if (dxfAnn && dxfAnn.guidedResults) {
    const hitResult = _hitTestGuidedResult(pt, dxfAnn);
    if (hitResult) {
      const items = [
        { label: `Delete "${hitResult.handle}" result`, action: () => {
          dxfAnn.guidedResults = dxfAnn.guidedResults.filter(r => r.handle !== hitResult.handle);
          state.inspectionResults = state.inspectionResults.filter(r => r.handle !== hitResult.handle);
          renderInspectionTable();
          redraw();
          showStatus(`Deleted result for ${hitResult.handle}`);
        }},
        { label: "Re-measure manually", action: () => {
          const entity = dxfAnn.entities.find(en => en.handle === hitResult.handle);
          if (entity) {
            state.inspectionPickTarget = entity;
            state.inspectionPickPoints = [];
            state.inspectionPickFit = null;
            showStatus("Click points along the edge. Double-click or Enter to finish.");
            redraw();
          }
        }},
      ];
      showContextMenu(e.clientX, e.clientY, items);
      return;
    }
  }

  if (state.selected.size > 0) {
    // Right-click with selection active
    const items = [];
    const hasDetections = [...state.selected].some(id => {
      const ann = state.annotations.find(a => a.id === id);
      return ann && isDetection(ann);
    });
    if (hasDetections) {
      items.push({ label: "Elevate to measurement", action: elevateSelected });
    }
    items.push({ label: `Delete (${state.selected.size})`, action: deleteSelected });
    if (state.selected.size === 1) {
      const ann = state.annotations.find(a => a.id === [...state.selected][0]);
      if (ann && !isDetection(ann)) {
        items.push("---");
        if (ann.type === "arc-measure") {
          items.push({ label: "Convert to circle", action: () => {
            pushUndo();
            const idx = state.annotations.findIndex(a => a.id === ann.id);
            if (idx === -1) return;
            const circle = {
              type: "circle",
              id: state.nextId++,
              name: ann.name || "",
              cx: ann.cx, cy: ann.cy, r: ann.r,
            };
            state.annotations.splice(idx, 1, circle);
            state.selected = new Set([circle.id]);
            renderSidebar();
            redraw();
            showStatus("Converted arc to circle");
          }});
        }
        items.push({ label: "Rename", action: () => {
          const row = document.querySelector(`.measurement-item[data-id="${ann.id}"]`);
          if (row) row.querySelector(".measurement-name")?.focus();
        }});
      }
    }
    showContextMenu(e.clientX, e.clientY, items);
    return;
  }

  // Right-click on empty canvas
  showContextMenu(e.clientX, e.clientY, [
    { label: "Clear detections", action: clearDetections },
    { label: "Clear measurements", action: clearMeasurements },
    { label: "Clear DXF overlay", action: clearDxfOverlay },
    "---",
    { label: "Clear all", action: clearAll },
  ]);
});

// ── Scroll-wheel zoom ─────────────────────────────────────────────────────
canvas.addEventListener("wheel", e => {
  e.preventDefault();

  if (!state.frozen) {
    showStatus("Freeze frame to enable zoom");
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const screenX = (e.clientX - rect.left) * (canvas.width / rect.width);
  const screenY = (e.clientY - rect.top) * (canvas.height / rect.height);

  // Image point under cursor before zoom
  const imgPt = screenToImage(screenX, screenY);

  // Apply zoom factor
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  viewport.zoom = Math.max(0.5, Math.min(10, viewport.zoom * factor));

  // Adjust pan so image point stays under cursor
  viewport.panX = imgPt.x - screenX / viewport.zoom;
  viewport.panY = imgPt.y - screenY / viewport.zoom;

  clampPan(rect.width, rect.height);
  resizeCanvas();
}, { passive: false });

// ── Keyboard ─────────────────────────────────────────────────────────────────
document.addEventListener("keydown", e => {
  // Help dialog shortcut — works even when an input is focused
  if (e.key === "?") {
    const anyDialogOpen = document.querySelector(".dialog-overlay:not([hidden])") !== null;
    if (!anyDialogOpen) document.getElementById("help-dialog").hidden = false;
    return;
  }
  // All other shortcuts are blocked when an input/select/textarea/dialog is focused
  if (document.activeElement.closest("input, select, textarea") !== null || document.querySelector(".dialog-overlay:not([hidden])") !== null) return;

  if (e.key === "Enter" && state.inspectionPickTarget) {
    _finalizePickInspection();
    return;
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
  const toolKeys = { v: "select", c: "calibrate", d: "distance", a: "angle",
                     o: "circle", f: "arc-fit", m: "center-dist", e: "detect",
                     p: "perp-dist", l: "para-dist", r: "area",
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

// ── Tool strip buttons + camera collapse ─────────────────────────────────────
const cameraSectionHeader = document.getElementById("camera-section-header");
const cameraSectionBody   = document.getElementById("camera-section-body");
if (cameraSectionHeader && cameraSectionBody) {
  cameraSectionHeader.addEventListener("click", () => {
    const isOpen = cameraSectionHeader.classList.toggle("open");
    cameraSectionBody.style.display = isOpen ? "" : "none";
  });
}

// ── Dropdown menu wiring ─────────────────────────────────────────────────────
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
document.addEventListener("click", closeAllDropdowns);

// ── Freeze button ─────────────────────────────────────────────────────────────
document.getElementById("btn-freeze").addEventListener("click", async () => {
  if (state.frozen) {
    // Unfreeze
    img.style.opacity = "1";
    state.frozen = false;
    state.frozenBackground = null;
    viewport.zoom = 1;
    viewport.panX = 0;
    viewport.panY = 0;
    updateFreezeUI();
    redraw();
  } else {
    await doFreeze();
  }
});

// ── Load image ────────────────────────────────────────────────────────────────
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

  const url = URL.createObjectURL(file);
  const loadedImg = new Image();
  loadedImg.onload = async () => {
    state.frozenBackground = loadedImg;
    img.style.opacity = "0";
    state.frozen = true;
    updateFreezeUI();
    showStatus("Loaded image");
    redraw();
  };
  loadedImg.src = url;
  e.target.value = "";
});

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

  const url = URL.createObjectURL(file);
  const loadedImg = new Image();
  loadedImg.onload = () => {
    state.frozenBackground = loadedImg;
    img.style.opacity = "0";
    state.frozen = true;
    updateFreezeUI();
    showStatus("Loaded image");
    redraw();
  };
  loadedImg.src = url;
});

// ── Coordinate origin ──────────────────────────────────────────────────────────
document.getElementById("btn-set-origin").addEventListener("click", () => {
  state._originMode = !state._originMode;
  document.getElementById("btn-set-origin").classList.toggle("active", state._originMode);
});

// ── Session save button ───────────────────────────────────────────────────────
document.getElementById("btn-save-session").addEventListener("click", saveSession);

// ── Session load file input ───────────────────────────────────────────────────
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

// ── Clear all annotations ─────────────────────────────────────────────────────
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

// ── Export PNG ────────────────────────────────────────────────────────────────
document.getElementById("btn-export").addEventListener("click", exportAnnotatedImage);

// ── Export CSV ────────────────────────────────────────────────────────────────
document.getElementById("btn-export-csv").addEventListener("click", exportCsv);

// ── Crosshair toggle ──────────────────────────────────────────────────────────
document.getElementById("btn-crosshair").addEventListener("click", () => {
  state.crosshair = !state.crosshair;
  document.getElementById("btn-crosshair").classList.toggle("active", state.crosshair);
  redraw();
});

// ── Calibration button ────────────────────────────────────────────────────────
document.getElementById("btn-calibration").addEventListener("click", () => setTool("calibrate"));

// ── Help dialog ───────────────────────────────────────────────────────────────
document.getElementById("btn-help")?.addEventListener("click", () => {
  document.getElementById("help-dialog").hidden = false;
});
document.getElementById("btn-help-close").addEventListener("click", () => {
  document.getElementById("help-dialog").hidden = true;
});

// ── Settings dialog ───────────────────────────────────────────────────────────
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

// ── White balance ─────────────────────────────────────────────────────────────
document.getElementById("btn-wb-auto").addEventListener("click", async () => {
  fmtStatusEl.textContent = "Applying…";
  try {
    const r = await fetch("/camera/white-balance/auto", { method: "POST" });
    if (!r.ok) throw new Error(await r.text());
    const ratios = await r.json();
    ["red", "green", "blue"].forEach(ch => {
      const slider = document.getElementById(`wb-${ch}-slider`);
      const display = document.getElementById(`wb-${ch}-value`);
      if (slider) { slider.value = ratios[ch]; display.textContent = ratios[ch].toFixed(2); }
    });
    fmtStatusEl.textContent = "Done";
    setTimeout(() => { fmtStatusEl.textContent = ""; }, 2000);
  } catch (err) {
    fmtStatusEl.textContent = `Error: ${err.message}`;
  }
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

// ── Event delegation for delete buttons ──────────────────────────────────────
document.getElementById("measurement-list").addEventListener("click", e => {
  const btn = e.target.closest(".del-btn");
  if (!btn) return;
  e.stopPropagation();
  const id = parseInt(btn.dataset.id, 10);
  deleteAnnotation(id);
});

// ── Init ──────────────────────────────────────────────────────────────────────
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
