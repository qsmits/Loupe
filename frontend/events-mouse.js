// ── Canvas mouse events ──────────────────────────────────────────────────────
import { apiFetch } from './api.js';
import { state, _deviationHitBoxes, _labelHitBoxes, pushUndo } from './state.js';
import { canvas, ctx, img, showStatus, redraw, resizeCanvas,
         drawLine, drawOrigin, drawAreaPreview, drawSplinePreview, dxfToCanvas } from './render.js';
import { renderSidebar, renderInspectionTable } from './sidebar.js';
import { addAnnotation, deleteSelected, elevateSelected, isDetection,
         mergeSelectedLines, clearDetections, clearMeasurements,
         clearDxfOverlay, clearAll } from './annotations.js';
import { setTool, handleToolClick, handleSelectDown, handleDrag,
         canvasPoint, snapPoint, collectDxfSnapPoints,
         projectConstrained, hitTestDxfEntity, findSnapLine,
         promptArcFitChoice, finalizeArcFit, finalizeArea, finalizeSpline, finalizeFitLine } from './tools.js';
import { fitCircle } from './math.js';
import { exitDxfAlignMode, openFeatureTolPopover } from './dxf.js';
import { viewport, screenToImage, clampPan, fitToWindow, zoomOneToOne,
         imageWidth, imageHeight } from './viewport.js';
import { showContextMenu, hideContextMenu } from './events-context-menu.js';
import { _hitTestGuidedResult, _findConnectedEntities, _annotationPrimaryPoint,
         _nearestSegmentDist, _updatePickFit, _finalizePickInspection } from './events-inspection.js';
import { drawLoupe } from './render-hud.js';
import { isLensCalMode, lensCalClick, lensCalMouseMove } from './lens-cal.js';
import { isTiltCalMode, tiltCalClick, tiltCalMouseMove } from './tilt-cal.js';
import { refinePointJS } from './subpixel-js.js';
import { openCommentEditor } from './comment-editor.js';
import { hitTestAnnotation } from './hit-test.js';
import { handleGearPickClick } from './gear.js';

// ── Sub-pixel snap preview (debounced) ────────────────────────────────────────
let _subpixelDebounce = null;
const _SNAP_PREVIEW_TOOLS = new Set([
  "distance", "angle", "circle", "arc-fit", "arc-measure",
  "perp-dist", "para-dist", "area", "calibrate", "spline", "fit-line",
]);

function _updateSubpixelPreview(pt, altKey = false) {
  // Only show preview when frozen, tool is a measurement tool, method is enabled, and Alt not held
  if (!state.frozen || !_SNAP_PREVIEW_TOOLS.has(state.tool) ||
      state.settings.subpixelMethod === "none" || altKey) {
    if (state._subpixelSnapTarget) { state._subpixelSnapTarget = null; redraw(); }
    return;
  }

  const method = state.settings.subpixelMethod;
  const baseRadius = state.settings.subpixelSearchRadius || 10;
  const zoomScale = Math.max(1, viewport.zoom);
  const searchRadius = Math.max(2, Math.round(baseRadius / zoomScale));

  if (method === "parabola-js" || method === "gaussian-js") {
    // Client-side: synchronous, no debounce needed
    const result = refinePointJS(pt.x, pt.y, searchRadius, method);
    state._subpixelSnapTarget = result ? { x: result.x, y: result.y } : null;
    redraw();
    return;
  }

  // Server-side: debounce to ~25 fps
  clearTimeout(_subpixelDebounce);
  _subpixelDebounce = setTimeout(async () => {
    try {
      const resp = await apiFetch("/refine-point", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: pt.x, y: pt.y, search_radius: searchRadius, subpixel: method }),
      });
      if (resp.ok) {
        const r = await resp.json();
        state._subpixelSnapTarget = (r.magnitude > 20) ? { x: r.x, y: r.y } : null;
        redraw();
      }
    } catch { /* ignore network errors */ }
  }, 40);
}

/** Run a drawing callback inside the viewport transform (for preview overlays after redraw) */
function withViewport(fn) {
  ctx.save();
  ctx.scale(viewport.zoom, viewport.zoom);
  ctx.translate(-viewport.panX, -viewport.panY);
  try { fn(); } finally { ctx.restore(); }
}

async function onMouseDown(e) {
  if (e.button !== 0 && e.button !== 1) return;
  document.getElementById("label-tooltip")?.setAttribute("hidden", "");

  // Minimap click-to-jump
  if (e.button === 0 && state.frozenBackground && imageWidth > 0) {
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const fitZoom = Math.min(rect.width / imageWidth, rect.height / imageHeight);
    if (viewport.zoom > fitZoom * 1.05) {
      const padding = 8;
      const maxW = 180, maxH = 120;
      const aspect = imageWidth / imageHeight;
      let mmW, mmH;
      if (aspect > maxW / maxH) { mmW = maxW; mmH = maxW / aspect; }
      else { mmH = maxH; mmW = maxH * aspect; }
      const mmX = padding;
      const mmY = rect.height - mmH - padding;

      if (screenX >= mmX && screenX <= mmX + mmW && screenY >= mmY && screenY <= mmY + mmH) {
        // Convert click position in minimap to image coordinates
        const imgX = ((screenX - mmX) / mmW) * imageWidth;
        const imgY = ((screenY - mmY) / mmH) * imageHeight;
        // Center viewport on clicked position
        const visibleW = rect.width / viewport.zoom;
        const visibleH = rect.height / viewport.zoom;
        viewport.panX = imgX - visibleW / 2;
        viewport.panY = imgY - visibleH / 2;
        clampPan(rect.width, rect.height);
        resizeCanvas();
        return;
      }
    }
  }

  // Pan: middle-mouse always, or left-click in pan tool. Only meaningful in
  // frozen mode (live camera fills the viewport so panning just shifts the
  // annotations out from under the image).
  if (e.button === 1 || (e.button === 0 && state.tool === "pan")) {
    if (!state.frozen) {
      e.preventDefault();
      return;
    }
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
  if (state.dxfRotateMode) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (ann) {
      const pt = canvasPoint(e);
      // The rotation pivot in canvas space = dxfToCanvas(0, 0, ann), which
      // evaluates to (ann.offsetX, ann.offsetY) when originAngle is 0. Use
      // the helper so we stay correct if a rotated origin is in play.
      const pivot = dxfToCanvas(0, 0, ann);
      const dx = pt.x - pivot.x;
      const dy = pt.y - pivot.y;
      // Ignore clicks right on top of the pivot — angle is undefined and
      // the user almost certainly didn't mean to start a rotation there.
      if (Math.hypot(dx, dy) < 4) return;
      pushUndo();
      state.dxfRotateOrigin = {
        pivotX: pivot.x, pivotY: pivot.y,
        startAngleRad: Math.atan2(dy, dx),
        annAngleStart: ann.angle ?? 0,
      };
    }
    return;
  }
  const pt = canvasPoint(e);
  // Gear analysis pick mode short-circuits tool dispatch.
  if (state.gearPickMode && e.button === 0) {
    if (handleGearPickClick(pt)) {
      e.preventDefault();
      return;
    }
  }
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
  if (isLensCalMode()) { lensCalClick(pt); return; }
  if (isTiltCalMode()) { tiltCalClick(pt); return; }
  if (state._dxfOriginMode) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (ann) { ann.offsetX = pt.x; ann.offsetY = pt.y; redraw(); }
    state._dxfOriginMode = false;
    document.getElementById("btn-dxf-set-origin")?.classList.remove("active");
    showStatus(state.frozen ? "Frozen" : "Live");
    return;
  }
  // Hit-test deviation labels — open per-feature tolerance popover if clicked
  // Hit boxes are in image space (recorded inside viewport transform)
  if (state.showDeviations && _deviationHitBoxes.length) {
    for (const box of _deviationHitBoxes) {
      if (box.handle && pt.x >= box.x && pt.x <= box.x + box.w && pt.y >= box.y && pt.y <= box.y + box.h) {
        openFeatureTolPopover(box.handle, e.clientX, e.clientY);
        e.stopPropagation();
        return;
      }
    }
  }
  // Label drag (guided results + regular measurements)
  // Hit boxes are recorded in image space (inside viewport transform),
  // so compare against pt (image-space mouse position), not screen pixels.
  if (state.tool === "select" && !e.shiftKey && _labelHitBoxes.length > 0) {
    for (const box of _labelHitBoxes) {
      if (pt.x >= box.x && pt.x <= box.x + box.w && pt.y >= box.y && pt.y <= box.y + box.h) {
        // Check guided result first
        if (box.handle) {
          const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
          const result = dxfAnn?.guidedResults?.find(r => r.handle === box.handle);
          if (result) {
            const offset = result.labelOffset || { dx: 0, dy: 0 };
            state._labelDrag = { handle: box.handle, startX: pt.x, startY: pt.y,
                                 origDx: offset.dx, origDy: offset.dy };
            return;
          }
        }
        // Check regular measurement annotation
        if (box.annId) {
          const ann = state.annotations.find(a => a.id === box.annId);
          if (ann) {
            const offset = ann.labelOffset || { dx: 0, dy: 0 };
            state._labelDrag = { annId: box.annId, startX: pt.x, startY: pt.y,
                                 origDx: offset.dx, origDy: offset.dy };
            // Comments: clicking the label selects the annotation too.
            if (ann.type === "comment") {
              state.selected = new Set([ann.id]);
              renderSidebar();
              redraw();
            }
            return;
          }
        }
      }
    }
  }
  // During point-pick: Shift+click on a DXF feature adds it to the pick target
  // (must check BEFORE the regular point-placement to intercept Shift+click)
  if (state.inspectionPickTarget && e.shiftKey) {
    const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
    if (dxfAnn) {
      const entity = hitTestDxfEntity(pt, dxfAnn);
      if (entity) {
        const newEntities = entity.parent_handle
          ? dxfAnn.entities.filter(en => en.parent_handle === entity.parent_handle)
          : [entity];
        const existingHandles = new Set(state.inspectionPickTarget.map(t => t.handle));
        for (const ne of newEntities) {
          if (!existingHandles.has(ne.handle)) {
            state.inspectionPickTarget.push(ne);
          }
        }
        const n = state.inspectionPickTarget.length;
        showStatus(`${n} segments selected. Click points along the edge. Double-click or Enter to finish.`);
        redraw();
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

  // DXF feature click-to-select for point-pick (works with or without prior inspection)
  if (state.tool === "select") {
    const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
    if (dxfAnn) {
      const entity = hitTestDxfEntity(pt, dxfAnn);
      if (entity) {
        // Normal click: start new pick with this entity (or its compound/connected group)
        // (Shift+click to add is handled above, before point-placement)
        const parentHandle = entity.parent_handle;
        if (parentHandle) {
          const group = dxfAnn.entities.filter(en => en.parent_handle === parentHandle);
          state.inspectionPickTarget = group;
        } else {
          // Auto-discover connected standalone entities via shared endpoints
          state.inspectionPickTarget = _findConnectedEntities(entity, dxfAnn.entities);
        }
        state.inspectionPickPoints = [];
        state.inspectionPickFit = null;
        const featureCount = state.inspectionPickTarget.length;
        const msg = featureCount > 1
          ? `${featureCount} segments selected. Click points along the edge. Double-click or Enter to finish. Shift+click DXF to add more.`
          : "Click points along the edge. Double-click or Enter to finish. Shift+click DXF to add more.";
        showStatus(msg);
        redraw();
        return;
      }
    }
    handleSelectDown(pt, e);
    return;
  }
  await handleToolClick(pt, e);
}

function onMouseUp() {
  if (state._panStart) {
    state._panStart = null;
    canvas.style.cursor = state.tool === "pan" ? "grab" : "";
    return;
  }
  if (state._labelDrag) {
    state._labelDrag = null;
    return;
  }
  if (state.dxfDragMode) {
    state.dxfDragOrigin = null;
    return;
  }
  if (state.dxfRotateMode) {
    state.dxfRotateOrigin = null;
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

export function initMouseHandlers() {
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mouseup", onMouseUp);

  canvas.addEventListener("dblclick", e => {
    if (state.inspectionPickTarget) {
      e.preventDefault();
      _finalizePickInspection();
      return;
    }
    // Double-click on a comment annotation → reopen editor to edit text.
    {
      const pt = canvasPoint(e);
      for (let i = state.annotations.length - 1; i >= 0; i--) {
        const ann = state.annotations[i];
        if (ann.type !== "comment") continue;
        if (hitTestAnnotation(ann, pt)) {
          e.preventDefault();
          openCommentEditor({ x: ann.x, y: ann.y }, ann);
          return;
        }
      }
    }
    // Multi-point tools: dblclick fires after 2 mousedowns (which each added a point).
    // Pop the duplicate from the second mousedown before finalizing.
    if (state.tool === "spline" && state.pendingPoints.length >= 3) {
      e.preventDefault();
      state.pendingPoints.pop();
      finalizeSpline();
      return;
    }
    if (state.tool === "arc-fit" && state.pendingPoints.length >= 4) {
      e.preventDefault();
      state.pendingPoints.pop();
      promptArcFitChoice();
      return;
    }
    if (state.tool === "area" && state.pendingPoints.length >= 4) {
      e.preventDefault();
      state.pendingPoints.pop();
      finalizeArea();
      return;
    }
    if (state.tool === "fit-line" && state.pendingPoints.length >= 3) {
      e.preventDefault();
      state.pendingPoints.pop();
      finalizeFitLine();
      return;
    }
  });

  // ── Mousemove ────────────────────────────────────────────────────────────────
  canvas.addEventListener("mousemove", e => {
    const pt = canvasPoint(e);
    const rawPt = pt;
    state.mousePos = pt;
    lensCalMouseMove(pt);
    tiltCalMouseMove(pt);
    _updateSubpixelPreview(pt, e.altKey);
    drawLoupe(isLensCalMode() || isTiltCalMode());
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
    // Gear pick mode: hover-highlight circle annotations so the user can
    // see which targets are valid instead of clicking blind.
    if (state.gearPickMode) {
      let hitId = null;
      for (let i = state.annotations.length - 1; i >= 0; i--) {
        const a = state.annotations[i];
        if (a.type !== "circle" && a.type !== "arc-fit") continue;
        if (hitTestAnnotation(a, pt)) { hitId = a.id; break; }
      }
      if (state.gearPickHover !== hitId) {
        state.gearPickHover = hitId;
        canvas.style.cursor = hitId ? "pointer" : "default";
        redraw();
      }
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
    if (state.dxfRotateMode && state.dxfRotateOrigin) {
      const ann = state.annotations.find(a => a.type === "dxf-overlay");
      if (ann) {
        const o = state.dxfRotateOrigin;
        const dx = pt.x - o.pivotX;
        const dy = pt.y - o.pivotY;
        if (Math.hypot(dx, dy) >= 1e-6) {
          const nowRad = Math.atan2(dy, dx);
          let deltaDeg = (nowRad - o.startAngleRad) * 180 / Math.PI;
          // Canvas Y is down, so CW drag on screen → positive deltaDeg,
          // and the overlay's annAngle convention is DXF-frame degrees
          // (rendered via `rotate(-annAngle)` after the Y-flip), which
          // makes CW on screen correspond to increasing annAngle.
          let next = o.annAngleStart + deltaDeg;
          if (e.shiftKey) next = Math.round(next * 2) / 2; // snap to 0.5°
          ann.angle = ((next % 360) + 360) % 360;
          // Keep the nudge-button display in sync if it exists.
          const disp = document.getElementById("dxf-angle-display");
          if (disp) disp.textContent = ann.angle.toFixed(1) + "°";
          redraw();
        }
      }
      return;
    }
    if (state._labelDrag) {
      const newOffset = {
        dx: state._labelDrag.origDx + (pt.x - state._labelDrag.startX),
        dy: state._labelDrag.origDy + (pt.y - state._labelDrag.startY),
      };
      if (state._labelDrag.handle) {
        const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
        const result = dxfAnn?.guidedResults?.find(r => r.handle === state._labelDrag.handle);
        if (result) result.labelOffset = newOffset;
      } else if (state._labelDrag.annId) {
        const ann = state.annotations.find(a => a.id === state._labelDrag.annId);
        if (ann) ann.labelOffset = newOffset;
      }
      redraw();
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

    // Label tooltip on hover (hit boxes are in image space)
    const tooltip = document.getElementById("label-tooltip");
    if (tooltip) {
      let hoveredBox = null;
      for (const box of _labelHitBoxes) {
        if (pt.x >= box.x && pt.x <= box.x + box.w && pt.y >= box.y && pt.y <= box.y + box.h) {
          hoveredBox = box;
          break;
        }
      }
      if (hoveredBox) {
        const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
        const r = dxfAnn?.guidedResults?.find(res => res.handle === hoveredBox.handle);
        if (r) {
          const mode = state.featureModes[r.handle] || state.featureModes[r.parent_handle] || "die";
          const lines = [];
          lines.push(`Feature: ${r.handle} (${r.type})`);
          if (r.parent_handle) lines.push(`Group: ${r.parent_handle}`);
          lines.push(`Mode: ${mode.charAt(0).toUpperCase() + mode.slice(1)}`);
          lines.push("");
          if (r.perp_dev_mm != null) {
            lines.push(`Deviation: \u22a5 ${r.perp_dev_mm.toFixed(4)} mm`);
            if (r.angle_error_deg != null) lines.push(`Angle: ${r.angle_error_deg.toFixed(2)}\xb0`);
            if (r.profile_mm != null) lines.push(`Profile: \u23e5 ${r.profile_mm.toFixed(4)} mm`);
          }
          if (r.center_dev_mm != null) lines.push(`Center dev: ${r.center_dev_mm.toFixed(4)} mm`);
          if (r.radius_dev_mm != null) lines.push(`Radius dev: ${r.radius_dev_mm.toFixed(4)} mm`);
          lines.push("");
          lines.push(`Tolerance: warn \xb1${r.tolerance_warn}  fail \xb1${r.tolerance_fail}`);
          lines.push(`Result: ${r.pass_fail?.toUpperCase() ?? "?"}`);
          lines.push(`Source: ${r.source ?? "auto"}`);
          tooltip.textContent = lines.join("\n");
          tooltip.style.left = (e.clientX + 12) + "px";
          tooltip.style.top = (e.clientY - 10) + "px";
          tooltip.hidden = false;
        } else {
          tooltip.hidden = true;
        }
      } else {
        tooltip.hidden = true;
      }
    }

    if (state.tool !== "select" && state.tool !== "calibrate" && state.tool !== "center-dist") {
      const { pt: snappedPt, snapped } = snapPoint(rawPt, e.altKey);
      state.snapTarget = (snapped && !e.altKey) ? snappedPt : null;
      // Angle tool: highlight the line that would be captured on click.
      if (state.tool === "angle") {
        const hover = findSnapLine(pt);
        // Don't highlight the already-captured first line.
        state.hoverRefLine = (hover && hover !== state.pendingRefLine) ? hover : null;
      } else if (state.hoverRefLine) {
        state.hoverRefLine = null;
      }
      redraw();
    }
    if (state.pendingPoints.length > 0 && state.tool !== "select"
        && state.tool !== "arc-fit"
        && state.tool !== "perp-dist"
        && state.tool !== "para-dist"
        && state.tool !== "area"
        && state.tool !== "spline") {
      const { pt: snappedPt, snapped } = snapPoint(rawPt, e.altKey);
      state.snapTarget = (snapped && !e.altKey) ? snappedPt : null;
      redraw();
      const last = state.pendingPoints[state.pendingPoints.length - 1];
      withViewport(() => {
        const pw = px => px / viewport.zoom;
        if (state.tool === "circle" && state.pendingPoints.length === 2) {
          try {
            const preview = fitCircle(state.pendingPoints[0], state.pendingPoints[1], snappedPt);
            ctx.beginPath();
            ctx.arc(preview.cx, preview.cy, preview.r, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(251,146,60,0.6)";
            ctx.lineWidth = pw(1.5);
            ctx.setLineDash([pw(5), pw(4)]);
            ctx.stroke();
            ctx.setLineDash([]);
          } catch {
            // collinear — no preview
          }
        } else if (state.tool === "arc-measure" && state.pendingPoints.length === 2) {
          // In sequential mode pendingPoints = [p1, p2] and the mouse is p3.
          // In ends-first mode pendingPoints = [end1, end2] and the mouse is the mid point.
          let p1, p2, p3;
          if (state.arcMeasureMode === "ends-first") {
            [p1, p2, p3] = [state.pendingPoints[0], snappedPt, state.pendingPoints[1]];
          } else {
            [p1, p2, p3] = [state.pendingPoints[0], state.pendingPoints[1], snappedPt];
          }
          const ax = p2.x - p1.x, ay = p2.y - p1.y;
          const bx = p3.x - p1.x, by = p3.y - p1.y;
          const D = 2 * (ax * by - ay * bx);
          if (Math.abs(D) >= 1e-6) {
            const ux = (by * (ax*ax + ay*ay) - ay * (bx*bx + by*by)) / D;
            const uy = (ax * (bx*bx + by*by) - bx * (ax*ax + ay*ay)) / D;
            const pcx = p1.x + ux, pcy = p1.y + uy;
            const pr  = Math.hypot(ux, uy);
            const pa1 = Math.atan2(p1.y - pcy, p1.x - pcx);
            const pa2 = Math.atan2(p2.y - pcy, p2.x - pcx);
            const pa3 = Math.atan2(p3.y - pcy, p3.x - pcx);
            // Draw the arc from p1 to p3 in the direction that passes through p2.
            const twoPi = 2 * Math.PI;
            const norm = x => ((x % twoPi) + twoPi) % twoPi;
            const ccw13 = norm(pa3 - pa1);
            const ccw12 = norm(pa2 - pa1);
            const ccw    = ccw12 < ccw13;  // CCW sweep passes through p2?
            ctx.beginPath();
            ctx.arc(pcx, pcy, pr, pa1, pa3, !ccw);
            ctx.strokeStyle = "rgba(191,90,242,0.6)";
            ctx.lineWidth = pw(1.5);
            ctx.setLineDash([pw(5), pw(4)]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        } else {
          drawLine(last, snappedPt, "rgba(251,146,60,0.5)", 1);
        }
      });
    }

    // Constrained rubber-band for perp-dist and para-dist
    if ((state.tool === "perp-dist" || state.tool === "para-dist")
        && state.pendingPoints.length === 1 && state.pendingRefLine) {
      const { pt: snappedPt, snapped } = snapPoint(rawPt, e.altKey);
      state.snapTarget = (snapped && !e.altKey) ? snappedPt : null;
      redraw();
      withViewport(() => {
        const b = projectConstrained(snappedPt, state.pendingPoints[0], state.pendingRefLine,
                                     state.tool === "perp-dist");
        drawLine(state.pendingPoints[0], b, "rgba(251,146,60,0.5)", 1);
      });
    }

    // Area polygon preview
    if (state.tool === "area" && state.pendingPoints.length >= 1) {
      const { pt: snappedPt, snapped } = snapPoint(rawPt, e.altKey);
      state.snapTarget = (snapped && !e.altKey) ? snappedPt : null;
      redraw();
      withViewport(() => {
        drawAreaPreview(state.pendingPoints, snappedPt);
      });
    }

    // Spline preview
    if (state.tool === "spline" && state.pendingPoints.length >= 1) {
      const { pt: snappedPt, snapped } = snapPoint(rawPt, e.altKey);
      state.snapTarget = (snapped && !e.altKey) ? snappedPt : null;
      redraw();
      withViewport(() => {
        drawSplinePreview(state.pendingPoints, snappedPt);
      });
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
        if (state.calibration.displayUnit === "\u00b5m") {
          coordEl.textContent =
            `X: ${(rx / ppm * 1000).toFixed(1)} \u00b5m  Y: ${(ry / ppm * 1000).toFixed(1)} \u00b5m`;
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
    document.getElementById("label-tooltip")?.setAttribute("hidden", "");
    const lc = document.getElementById("loupe-canvas");
    if (lc) lc.hidden = true;
  });

  // ── Context menu (right-click) ──────────────────────────────────────────────
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
              // If compound feature, select the whole group
              const ph = entity.parent_handle;
              if (ph) {
                state.inspectionPickTarget = dxfAnn.entities.filter(e => e.parent_handle === ph);
              } else {
                state.inspectionPickTarget = [entity];
              }
              state.inspectionPickPoints = [];
              state.inspectionPickFit = null;
              const n = state.inspectionPickTarget.length;
              showStatus(n > 1
                ? `Compound feature (${n} segments). Click points along the edge. Double-click or Enter to finish.`
                : "Click points along the edge. Double-click or Enter to finish.");
              redraw();
            }
          }},
        ];
        const currentMode = state.featureModes[hitResult.handle] || "die";
        items.push("---");
        items.push({
          label: currentMode === "die" ? "Set as Punch" : "Set as Die",
          action: () => {
            state.featureModes[hitResult.handle] = currentMode === "die" ? "punch" : "die";
            renderInspectionTable();
            redraw();
            showStatus(`Feature ${hitResult.handle}: ${state.featureModes[hitResult.handle]}`);
          }
        });
        if (hitResult.labelOffset && (hitResult.labelOffset.dx !== 0 || hitResult.labelOffset.dy !== 0)) {
          items.push({ label: "Reset label position", action: () => {
            delete hitResult.labelOffset;
            redraw();
          }});
        }
        showContextMenu(e.clientX, e.clientY, items);
        return;
      }
    }

    // Right-click on a DXF entity (for Punch/Die setting, even without inspection)
    if (dxfAnn) {
      const dxfEntity = hitTestDxfEntity(pt, dxfAnn);
      if (dxfEntity) {
        // Find the group: parent_handle group OR connected standalone entities
        const connectedGroup = dxfEntity.parent_handle
          ? dxfAnn.entities.filter(e => e.parent_handle === dxfEntity.parent_handle)
          : _findConnectedEntities(dxfEntity, dxfAnn.entities);
        const handle = dxfEntity.parent_handle || dxfEntity.handle;
        const currentMode = state.featureModes[handle] || "die";
        const groupHandles = connectedGroup.map(e => e.handle);

        const items = [
          {
            label: currentMode === "die" ? `Set as Punch (${groupHandles.length} seg)` : `Set as Die (${groupHandles.length} seg)`,
            action: () => {
              const newMode = currentMode === "die" ? "punch" : "die";
              for (const h of groupHandles) state.featureModes[h] = newMode;
              if (dxfEntity.parent_handle) state.featureModes[dxfEntity.parent_handle] = newMode;
              renderInspectionTable();
              redraw();
              showStatus(`Feature ${handle}: ${newMode}`);
            }
          },
          { label: "Measure manually", action: () => {
            state.inspectionPickTarget = connectedGroup;
            state.inspectionPickPoints = [];
            state.inspectionPickFit = null;
            const n = state.inspectionPickTarget.length;
            showStatus(n > 1
              ? `${n} segments. Click points along edge. Double-click or Enter to finish.`
              : "Click points along edge. Double-click or Enter to finish.");
            redraw();
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
      // Merge lines option (when 2+ line-type annotations selected)
      const lineTypes = new Set(["detected-line", "detected-line-merged", "distance"]);
      const selectedLines = [...state.selected].filter(id => {
        const a = state.annotations.find(x => x.id === id);
        return a && lineTypes.has(a.type);
      });
      if (selectedLines.length >= 2) {
        items.push({ label: `Merge ${selectedLines.length} lines`, action: mergeSelectedLines });
      }
      // Group/ungroup option
      if (state.selected.size >= 2) {
        items.push({ label: "Group selected…", action: () => {
          const name = prompt("Group name:", "Feature");
          if (!name) return;
          for (const id of state.selected) {
            state.measurementGroups[id] = name;
          }
          renderSidebar();
        }});
      }
      // Check if selected items are in a group — offer ungroup
      const groupedSelected = [...state.selected].filter(id => state.measurementGroups[id]);
      if (groupedSelected.length > 0) {
        items.push({ label: "Ungroup", action: () => {
          for (const id of groupedSelected) {
            delete state.measurementGroups[id];
          }
          renderSidebar();
        }});
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
    const hasDxfResults = dxfAnn && dxfAnn.guidedResults && dxfAnn.guidedResults.length > 0;
    showContextMenu(e.clientX, e.clientY, [
      ...(hasDxfResults ? [
        { label: "Clear inspection results", action: () => {
          const ann = state.annotations.find(a => a.type === "dxf-overlay");
          if (ann) ann.guidedResults = [];
          state.inspectionResults = [];
          state.inspectionFrame = null;
          renderInspectionTable();
          redraw();
          showStatus("Cleared inspection results");
        }},
        "---",
      ] : []),
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

    // Apply zoom factor — minimum is fit-to-window (image fills canvas)
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const minZoom = (imageWidth > 0 && imageHeight > 0)
      ? Math.min(rect.width / imageWidth, rect.height / imageHeight)
      : 0.5;
    // Max zoom must always allow reaching at least 4× past 1:1 pixel level.
    // For large images (e.g. 15000px on a 1400px canvas) 1:1 = zoom≈10.7,
    // so a hardcoded cap of 10 would prevent the user from ever reaching 100%.
    const oneToOneZoom = imageWidth > 0 ? Math.max(imageWidth / rect.width, imageHeight / rect.height) : 1;
    const maxZoom = Math.max(10, oneToOneZoom * 4);
    viewport.zoom = Math.max(minZoom, Math.min(maxZoom, viewport.zoom * factor));

    // Adjust pan so image point stays under cursor
    viewport.panX = imgPt.x - screenX / viewport.zoom;
    viewport.panY = imgPt.y - screenY / viewport.zoom;

    // At minimum zoom (fit-to-window), reset pan to origin
    if (viewport.zoom <= minZoom + 0.001) {
      viewport.panX = 0;
      viewport.panY = 0;
    }

    clampPan(rect.width, rect.height);
    resizeCanvas();
  }, { passive: false });
}
