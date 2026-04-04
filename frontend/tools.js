import { apiFetch } from './api.js';
import { refinePointJS } from './subpixel-js.js';
import { state, TOOL_STATUS, pushUndo } from './state.js';
import { redraw, canvas, showStatus, getLineEndpoints, lineAngleDeg, listEl } from './render.js';
import { dxfToCanvas } from './render-dxf.js';
import { addAnnotation, applyCalibration, elevateAnnotation } from './annotations.js';
import { fitCircle, fitCircleAlgebraic, splineArcLength, parseDistanceInput, distPointToSegment } from './math.js';
import { renderSidebar } from './sidebar.js';
import { viewport, screenToImage, imageWidth, imageHeight } from './viewport.js';
import { hitTestAnnotation, hitTestDxfEntity } from './hit-test.js';

// Re-export for backward compatibility (other modules import these from tools.js)
export { hitTestAnnotation, hitTestDxfEntity } from './hit-test.js';

export function setTool(name) {
  state.tool = name;
  state.pendingPoints = [];
  state.pendingCenterCircle = null;
  state.pendingRefLine = null;
  state.pendingCircleRef = null;
  state.snapTarget = null;
  // Exit any modal modes that would intercept clicks
  if (state.dxfAlignMode) {
    state.dxfAlignMode = false;
    state.dxfAlignStep = 0;
    state.dxfAlignPick = null;
    state.dxfAlignHover = null;
    document.getElementById("btn-auto-align")?.classList.remove("active");
  }
  if (state.dxfDragMode) {
    state.dxfDragMode = false;
    state.dxfDragOrigin = null;
    document.getElementById("btn-dxf-move")?.classList.remove("active");
  }
  if (state._originMode) {
    state._originMode = false;
    document.getElementById("btn-set-origin")?.classList.remove("active");
  }
  if (state.inspectionPickTarget) {
    state.inspectionPickTarget = null;
    state.inspectionPickPoints = [];
    state.inspectionPickFit = null;
  }
  document.querySelectorAll("#tool-strip .strip-btn[data-tool]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tool === name);
  });
  _updateStripGroups(name);
  showStatus(TOOL_STATUS[name] ?? name);
  canvas.style.cursor = name === "pan" ? "grab" : name === "select" ? "default" : "crosshair";
  redraw();
}

const _MEASURE_TOOLS = new Set([
  "distance","angle","circle","arc-fit","arc-measure","center-dist",
  "para-dist","perp-dist","area","pt-circle-dist","intersect","slot-dist","spline",
]);
const _TOOL_LABELS = {
  "distance":"Distance","angle":"Angle","circle":"Circle","arc-fit":"Fit Arc",
  "arc-measure":"Arc Meas","center-dist":"Center Dist","para-dist":"Para Dist",
  "perp-dist":"Perp Dist","area":"Area","pt-circle-dist":"Pt-Circle",
  "intersect":"Intersect","slot-dist":"Slot Dist","spline":"Spline",
  "calibrate":"Calibrate",
};

function _updateStripGroups(name) {
  const measureBtn = document.getElementById("btn-strip-measure");
  const setupBtn   = document.getElementById("btn-strip-setup");
  const optsBar    = document.getElementById("tool-options-bar");
  if (measureBtn) {
    const inGroup = _MEASURE_TOOLS.has(name);
    measureBtn.textContent = inGroup ? (_TOOL_LABELS[name] ?? name) + " ▾" : "Measure ▾";
    measureBtn.classList.toggle("active", inGroup);
  }
  if (setupBtn) {
    setupBtn.classList.toggle("active", name === "calibrate");
  }
  if (optsBar) {
    const showOpts = name === "arc-measure" || name === "circle";
    optsBar.hidden = !showOpts;
    const arcOpts = document.getElementById("tool-opts-arc-measure");
    const circleOpts = document.getElementById("tool-opts-circle");
    if (arcOpts) arcOpts.hidden = name !== "arc-measure";
    if (circleOpts) circleOpts.hidden = name !== "circle";
  }
}

export function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  const screenX = (e.clientX - r.left) * (canvas.width / r.width);
  const screenY = (e.clientY - r.top) * (canvas.height / r.height);
  return screenToImage(screenX, screenY);
}

// Returns the nearest line-like annotation whose body is within 10px of pt, or null.
export function findSnapLine(pt) {
  for (let i = state.annotations.length - 1; i >= 0; i--) {
    const ann = state.annotations[i];
    if (ann.type === "parallelism") continue;
    const ep = getLineEndpoints(ann);
    if (!ep) continue;
    if (distPointToSegment(pt, ep.a, ep.b) < 10 / viewport.zoom) return ann;
  }
  return null;
}

// ── Snap-to-annotation ──────────────────────────────────────────────────
export const SNAP_RADIUS = 8;

export function snapPoint(rawPt, bypass = false) {
  if (bypass) return { pt: rawPt, snapped: false };
  if (state.tool === "select") return { pt: rawPt, snapped: false };
  const targets = [];
  state.annotations.forEach(ann => {
    if (["edges-overlay", "preprocessed-overlay", "dxf-overlay", "detected-line", "center-dist"].includes(ann.type)) return;
    if (["distance", "perp-dist", "para-dist", "parallelism"].includes(ann.type)) {
      targets.push(ann.a, ann.b);
    } else if (ann.type === "calibration") {
      if (ann.x1 !== undefined) {
        targets.push({ x: ann.x1, y: ann.y1 }, { x: ann.x2, y: ann.y2 });
      }
    } else if (["circle", "arc-fit", "detected-circle"].includes(ann.type)) {
      targets.push({ x: ann.cx, y: ann.cy });
    } else if (ann.type === "spline") {
      (ann.points || []).forEach(p => targets.push(p));
    } else if (ann.type === "origin") {
      targets.push({ x: ann.x, y: ann.y });
    } else if (ann.type === "area") {
      (ann.points || []).forEach(p => targets.push(p));
    }
  });
  for (const t of targets) {
    if (Math.hypot(t.x - rawPt.x, t.y - rawPt.y) <= SNAP_RADIUS / viewport.zoom) {
      return { pt: { x: t.x, y: t.y }, snapped: true };
    }
  }
  return { pt: rawPt, snapped: false };
}

// ── Tool click handler ─────────────────────────────────────────────────────
export async function handleToolClick(rawPt, e = {}) {
  const { pt: snappedPt, snapped: annotationSnapped } = (state.tool !== "calibrate" && state.tool !== "center-dist")
    ? snapPoint(rawPt, e.altKey ?? false)
    : { pt: rawPt, snapped: false };
  let pt = snappedPt;

  // Sub-pixel edge snap — skip when annotation-snap already fired (prefer
  // exact endpoint over nearby edge), skip for center-dist, select, pan.
  // Alt key bypasses both annotation-snap and subpixel.
  if (state.frozen && !e.altKey && !annotationSnapped &&
      state.settings.subpixelMethod !== "none" &&
      state.tool !== "select" && state.tool !== "pan" &&
      state.tool !== "center-dist") {
    const method = state.settings.subpixelMethod;
    const baseRadius = state.settings.subpixelSearchRadius || 10;
    const zoomScale = Math.max(1, viewport.zoom);
    const searchRadius = Math.max(2, Math.round(baseRadius / zoomScale));
    if (method === "parabola-js" || method === "gaussian-js") {
      const result = refinePointJS(pt.x, pt.y, searchRadius, method);
      if (result) pt = { x: result.x, y: result.y, snapped: true };
    } else {
      try {
        const resp = await apiFetch("/refine-point", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ x: pt.x, y: pt.y, search_radius: searchRadius, subpixel: method }),
        });
        if (resp.ok) {
          const refined = await resp.json();
          if (refined.magnitude > 20) pt = { x: refined.x, y: refined.y, snapped: true };
        }
      } catch { /* network error — use unrefined point */ }
    }
  }

  const tool = state.tool;

  if (tool === "calibrate") {
    // First click: check if user clicked near a circle's edge (circle calibration)
    if (state.pendingPoints.length === 0) {
      const circle = snapToCircle(pt);
      if (circle) {
        // Circle calibration flow
        state.pendingCenterCircle = circle; // highlight it
        redraw();
        const dist = prompt("Enter known diameter (e.g. '5.000 mm' or '200 µm'):");
        state.pendingCenterCircle = null;
        if (dist) {
          const parsed = parseDistanceInput(dist);
          if (parsed) {
            let cx, cy, r;
            if (circle.type === "circle") {
              cx = circle.cx; cy = circle.cy; r = circle.r;
            } else {
              const sx = canvas.width / circle.frameWidth;
              const sy = canvas.height / circle.frameHeight;
              cx = circle.x * sx; cy = circle.y * sy; r = circle.radius * sx;
            }
            applyCalibration({ type: "calibration", cx, cy, r, knownValue: parsed.value, unit: parsed.unit });
            // Promote the detected circle to a measurement so it isn't left as a raw detection underneath the calibration line.
            if (circle.type !== "circle") elevateAnnotation(circle.id);
            setTool("select");
          }
        }
        redraw();
        return;
      }
    }
    // Two-point calibration flow
    state.pendingPoints.push(pt);
    updateToolStatus();
    if (state.pendingPoints.length === 2) {
      const [p1, p2] = state.pendingPoints;
      const dist = prompt("Distance between these two points (e.g. '1.000 mm' or '500 µm'):");
      state.pendingPoints = [];
      if (dist) {
        const parsed = parseDistanceInput(dist);
        if (parsed) {
          applyCalibration({ type: "calibration", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
                             knownValue: parsed.value, unit: parsed.unit });
          setTool("select");
        }
      }
    }
    redraw();
    return;
  }

  if (tool === "distance") {
    state.pendingPoints.push(pt);
    if (state.pendingPoints.length === 2) {
      const [a, b] = state.pendingPoints;
      addAnnotation({ type: "distance", a, b });
      state.pendingPoints = [];
    }
    updateToolStatus();
    redraw();
    return;
  }

  if (tool === "angle") {
    state.pendingPoints.push(pt);
    if (state.pendingPoints.length === 3) {
      const [p1, vertex, p3] = state.pendingPoints;
      addAnnotation({ type: "angle", p1, vertex, p3 });
      state.pendingPoints = [];
    }
    updateToolStatus();
    redraw();
    return;
  }

  if (tool === "circle") {
    if (state.circleMode === "center-edge") {
      state.pendingPoints.push(pt);
      if (state.pendingPoints.length === 2) {
        const [center, edge] = state.pendingPoints;
        const r = Math.hypot(edge.x - center.x, edge.y - center.y);
        addAnnotation({ type: "circle", cx: center.x, cy: center.y, r,
          p1: center, p2: edge, p3: edge });
        state.pendingPoints = [];
      }
    } else {
      state.pendingPoints.push(pt);
      if (state.pendingPoints.length === 3) {
        const [p1, p2, p3] = state.pendingPoints;
        try {
          const { cx, cy, r } = fitCircle(p1, p2, p3);
          addAnnotation({ type: "circle", cx, cy, r });
        } catch {
          alert("Those three points are collinear — can't fit a circle.");
        }
        state.pendingPoints = [];
      }
    }
    updateToolStatus();
    redraw();
    return;
  }

  if (tool === "arc-fit") {
    state.pendingPoints.push(pt);
    updateToolStatus();
    redraw();
    return;
  }

  if (tool === "spline") {
    state.pendingPoints.push(pt);
    updateToolStatus();
    redraw();
    return;
  }

  if (tool === "arc-measure") {
    state.pendingPoints.push(pt);
    if (state.pendingPoints.length === 3) {
      // In "ends-first" mode: clicks are [end1, end2, mid]; reorder to [end1, mid, end2]
      let [p1, p2, p3] = state.pendingPoints;
      if (state.arcMeasureMode === "ends-first") [p1, p2, p3] = [p1, p3, p2];
      const ax = p2.x - p1.x, ay = p2.y - p1.y;
      const bx = p3.x - p1.x, by = p3.y - p1.y;
      const D = 2 * (ax * by - ay * bx);
      if (Math.abs(D) < 1e-6) {
        alert("Points are collinear — cannot fit arc");
        state.pendingPoints = [];
        redraw();
        return;
      }
      const ux = (by * (ax*ax + ay*ay) - ay * (bx*bx + by*by)) / D;
      const uy = (ax * (bx*bx + by*by) - bx * (ax*ax + ay*ay)) / D;
      const cx = p1.x + ux, cy = p1.y + uy;
      const r  = Math.hypot(ux, uy);
      const a1 = Math.atan2(p1.y - cy, p1.x - cx) * 180 / Math.PI;
      const a3 = Math.atan2(p3.y - cy, p3.x - cx) * 180 / Math.PI;
      let span = Math.abs(a3 - a1) % 360;
      if (span > 180) span = 360 - span;
      const chord = Math.hypot(p3.x - p1.x, p3.y - p1.y);
      addAnnotation({ type: "arc-measure", cx, cy, r, p1, p2, p3, span_deg: span, chord_px: chord });
      state.pendingPoints = [];
    }
    updateToolStatus();
    redraw();
    return;
  }

  if (tool === "area") {
    state.pendingPoints.push(pt);
    updateToolStatus();
    redraw();
    return;
  }

  if (tool === "perp-dist") {
    if (!state.pendingRefLine) {
      // Step 1: pick reference line
      const refAnn = findSnapLine(pt);
      if (!refAnn) return; // no line nearby — ignore click
      state.pendingRefLine = refAnn;
      showStatus("Perp — click start point");
      redraw();
      return;
    }
    if (state.pendingPoints.length === 0) {
      // Step 2: place start point
      state.pendingPoints = [pt];
      showStatus("Perp — click end point");
      redraw();
      return;
    }
    // Step 3: place end point (constrained perpendicular)
    const a = state.pendingPoints[0];
    const b = projectConstrained(pt, a, state.pendingRefLine, true);
    addAnnotation({ type: "perp-dist", a, b });
    setTool("select");
    return;
  }

  if (tool === "para-dist") {
    if (!state.pendingRefLine) {
      // Step 1: pick reference line
      const refAnn = findSnapLine(pt);
      if (!refAnn) return; // no line nearby — ignore
      state.pendingRefLine = refAnn;
      showStatus("Para — click a line to measure parallelism, or a free point to draw a parallel line");
      redraw();
      return;
    }
    // Step 2: check if click is on a different line (Mode A — parallelism measurement)
    const clickedLine = findSnapLine(pt);
    if (clickedLine && clickedLine.id !== state.pendingRefLine.id) {
      const epRef = getLineEndpoints(state.pendingRefLine);
      const epOther = getLineEndpoints(clickedLine);
      let diff = Math.abs(lineAngleDeg(state.pendingRefLine) - lineAngleDeg(clickedLine)) % 180;
      if (diff > 90) diff = 180 - diff;
      const a = { x: (epRef.a.x + epRef.b.x) / 2, y: (epRef.a.y + epRef.b.y) / 2 };
      const b = { x: (epOther.a.x + epOther.b.x) / 2, y: (epOther.a.y + epOther.b.y) / 2 };
      addAnnotation({ type: "parallelism", a, b, angleDeg: diff });
      setTool("select");
      return;
    }
    // Mode B — parallel constraint: free point clicked
    if (state.pendingPoints.length === 0) {
      state.pendingPoints = [pt];
      showStatus("Para — click end point");
      redraw();
      return;
    }
    // Mode B step 2: constrained endpoint
    const a = state.pendingPoints[0];
    const b = projectConstrained(pt, a, state.pendingRefLine, false);
    addAnnotation({ type: "para-dist", a, b });
    setTool("select");
    return;
  }

  if (tool === "center-dist") {
    const circle = snapToCircle(pt);
    if (!circle) return; // no circle nearby — ignore click
    if (state.pendingCenterCircle === null) {
      // First pick: highlight this circle
      state.pendingCenterCircle = circle;
      showStatus("Click a second circle");
      redraw();
    } else {
      // Second pick: create the annotation
      const a = (() => {
        if (state.pendingCenterCircle.type === "circle") {
          return { x: state.pendingCenterCircle.cx, y: state.pendingCenterCircle.cy };
        }
        const sx = canvas.width / state.pendingCenterCircle.frameWidth;
        const sy = canvas.height / state.pendingCenterCircle.frameHeight;
        return { x: state.pendingCenterCircle.x * sx, y: state.pendingCenterCircle.y * sy };
      })();
      const b = (() => {
        if (circle.type === "circle") {
          return { x: circle.cx, y: circle.cy };
        }
        const sx = canvas.width / circle.frameWidth;
        const sy = canvas.height / circle.frameHeight;
        return { x: circle.x * sx, y: circle.y * sy };
      })();
      const circleA = state.pendingCenterCircle;
      state.pendingCenterCircle = null;
      addAnnotation({
        type: "center-dist", a, b,
        circleAId: circleA.id ?? null,
        circleBId: circle.id ?? null,
      });
      setTool("select");
    }
    return;
  }
  if (tool === "pt-circle-dist") {
    if (!state.pendingCircleRef) {
      const circle = snapToCircle(pt);
      if (!circle) {
        showStatus("Click a circle first");
        return;
      }
      state.pendingCircleRef = { circleId: circle.id };
      showStatus("Now click a point to measure from");
      redraw();
      return;
    }
    const { circleId } = state.pendingCircleRef;
    state.pendingCircleRef = null;
    addAnnotation({ type: "pt-circle-dist", circleId, px: pt.x, py: pt.y });
    setTool("select");
    return;
  }
  if (tool === "intersect") {
    const snapped = findSnapLine(pt);
    if (!state.pendingRefLine) {
      if (!snapped) return;
      state.pendingRefLine = snapped;
      showStatus("Now click a second line");
      redraw();
      return;
    }
    if (!snapped) return;
    if (snapped.id === state.pendingRefLine.id) return;
    const lineAId = state.pendingRefLine.id;
    const lineBId = snapped.id;
    state.pendingRefLine = null;
    addAnnotation({ type: "intersect", lineAId, lineBId });
    setTool("select");
    return;
  }
  if (tool === "slot-dist") {
    const snapped = findSnapLine(pt);
    if (!state.pendingRefLine) {
      if (!snapped) return;
      state.pendingRefLine = snapped;
      showStatus("Now click a second line");
      redraw();
      return;
    }
    if (!snapped) return;
    if (snapped.id === state.pendingRefLine.id) return;
    const lineAId = state.pendingRefLine.id;
    const lineBId = snapped.id;
    state.pendingRefLine = null;
    addAnnotation({ type: "slot-dist", lineAId, lineBId });
    setTool("select");
    return;
  }
}

export function handleSelectDown(pt, e) {
  // Single-select: try drag handles first (only if exactly 1 selected)
  if (state.selected.size === 1) {
    const selId = [...state.selected][0];
    const ann = state.annotations.find(a => a.id === selId);
    if (ann) {
      const hk = hitTestHandle(ann, pt);
      if (hk) {
        state.dragState = { annotationId: ann.id, handleKey: hk, startX: pt.x, startY: pt.y };
        return;
      }
    }
  }

  // Hit-test all annotations (reverse order = top first)
  for (let i = state.annotations.length - 1; i >= 0; i--) {
    const ann = state.annotations[i];
    if (hitTestAnnotation(ann, pt)) {
      if (e.shiftKey) {
        // Shift+click: toggle in/out of selection
        const newSet = new Set(state.selected);
        if (newSet.has(ann.id)) newSet.delete(ann.id);
        else newSet.add(ann.id);
        state.selected = newSet;
      } else {
        // Normal click: replace selection, start body drag
        state.selected = new Set([ann.id]);
        state.dragState = { annotationId: ann.id, handleKey: "body", startX: pt.x, startY: pt.y };
      }
      renderSidebar();
      redraw();
      return;
    }
  }

  // Clicked empty space
  if (e.shiftKey) return; // Shift+click on empty: preserve selection

  // Start drag-select rectangle
  state._selectRect = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
  state.selected = new Set();
  renderSidebar();
  redraw();
}

export function hitTestHandle(ann, pt) {
  const RADIUS = 8 / viewport.zoom;
  const handles = getHandles(ann);
  for (const [key, hp] of Object.entries(handles)) {
    if (Math.hypot(pt.x - hp.x, pt.y - hp.y) < RADIUS) return key;
  }
  return null;
}

export function getHandles(ann) {
  if (ann.type === "center-dist") return {};  // linked — no movable handles
  if (ann.type === "distance" ||
      ann.type === "perp-dist" || ann.type === "para-dist" ||
      ann.type === "parallelism") return { a: ann.a, b: ann.b };
  if (ann.type === "angle")    return { p1: ann.p1, vertex: ann.vertex, p3: ann.p3 };
  if (ann.type === "circle")   return { center: { x: ann.cx, y: ann.cy }, edge: { x: ann.cx + ann.r, y: ann.cy } };
  if (ann.type === "calibration") {
    if (ann.x1 !== undefined) return { a: { x: ann.x1, y: ann.y1 }, b: { x: ann.x2, y: ann.y2 } };
    else return { a: { x: ann.cx - ann.r, y: ann.cy }, b: { x: ann.cx + ann.r, y: ann.cy } };
  }
  if (ann.type === "area") {
    const handles = {};
    ann.points.forEach((p, i) => { handles[`v${i}`] = p; });
    return handles;
  }
  if (ann.type === "origin") {
    const angle = ann.angle ?? 0;
    const axisLen = 30;
    return {
      center: { x: ann.x, y: ann.y },
      axis: {
        x: ann.x + Math.cos(angle) * axisLen,
        y: ann.y + Math.sin(angle) * axisLen,
      },
    };
  }
  if (ann.type === "arc-measure") return { p1: ann.p1, p2: ann.p2, p3: ann.p3 };
  if (ann.type === "arc-fit") return { center: { x: ann.cx, y: ann.cy }, edge: { x: ann.cx + ann.r, y: ann.cy } };
  if (ann.type === "spline") {
    const handles = {};
    (ann.points || []).forEach((p, i) => { handles[`v${i}`] = p; });
    return handles;
  }
  if (ann.type === "pt-circle-dist") return { pt: { x: ann.px, y: ann.py } };
  if (ann.type === "intersect") return {};
  if (ann.type === "slot-dist") return {};
  return {};
}

// ── Circle snap ─────────────────────────────────────────────────────────────
// Returns the circle annotation whose edge is closest to pt, if within 20px.
// Handles both "circle" (canvas coords) and "detected-circle" (frame coords).
export function snapToCircle(pt) {
  let best = null, bestDist = 20 / viewport.zoom;
  state.annotations.forEach(ann => {
    let cx, cy, r;
    if (ann.type === "circle") {
      cx = ann.cx; cy = ann.cy; r = ann.r;
    } else if (ann.type === "detected-circle") {
      const sx = imageWidth / ann.frameWidth;
      const sy = imageHeight / ann.frameHeight;
      cx = ann.x * sx; cy = ann.y * sy; r = ann.radius * sx;
    } else {
      return;
    }
    const edgeDist = Math.abs(Math.hypot(pt.x - cx, pt.y - cy) - r);
    if (edgeDist < bestDist) { bestDist = edgeDist; best = ann; }
  });
  return best;
}

// Projects rawPt onto the ray from a in the direction perpendicular (perp=true)
// or parallel (perp=false) to refAnn. Returns the snapped endpoint { x, y }.
export function projectConstrained(rawPt, a, refAnn, perp) {
  const ep = getLineEndpoints(refAnn);
  if (!ep) return rawPt;
  const rdx = ep.b.x - ep.a.x, rdy = ep.b.y - ep.a.y;
  const len = Math.hypot(rdx, rdy);
  if (len < 1e-10) return rawPt;
  // unit parallel vector of reference line
  const px = rdx / len, py = rdy / len;
  // unit direction we want to constrain b along:
  // if perp=true → use the perpendicular (-py, px); if false → use parallel (px, py)
  const ux = perp ? -py : px;
  const uy = perp ? px  : py;
  const t = (rawPt.x - a.x) * ux + (rawPt.y - a.y) * uy;
  return { x: a.x + t * ux, y: a.y + t * uy };
}

export function handleDrag(pt) {
  if (!state.dragState) return;
  const { annotationId, handleKey } = state.dragState;
  const ann = state.annotations.find(a => a.id === annotationId);
  if (!ann) return;

  const dx = pt.x - state.dragState.startX;
  const dy = pt.y - state.dragState.startY;
  state.dragState.startX = pt.x;
  state.dragState.startY = pt.y;

  if (ann.type === "center-dist") { /* linked to circles — drag ignored */ }
  else if (ann.type === "distance" ||
      ann.type === "perp-dist" || ann.type === "para-dist" ||
      ann.type === "parallelism") {
    if (handleKey === "a")    { ann.a.x += dx; ann.a.y += dy; }
    else if (handleKey === "b") { ann.b.x += dx; ann.b.y += dy; }
    else { ann.a.x+=dx; ann.a.y+=dy; ann.b.x+=dx; ann.b.y+=dy; }
  }
  else if (ann.type === "angle") {
    if (handleKey === "p1")     { ann.p1.x+=dx; ann.p1.y+=dy; }
    else if (handleKey === "p3") { ann.p3.x+=dx; ann.p3.y+=dy; }
    else if (handleKey === "vertex") { ann.vertex.x+=dx; ann.vertex.y+=dy; }
    else { ann.p1.x+=dx; ann.p1.y+=dy; ann.vertex.x+=dx; ann.vertex.y+=dy; ann.p3.x+=dx; ann.p3.y+=dy; }
  }
  else if (ann.type === "circle") {
    if (handleKey === "edge") {
      ann.r = Math.hypot(pt.x - ann.cx, pt.y - ann.cy);
    } else {
      ann.cx += dx; ann.cy += dy;
      _syncCenterDist(ann.id, ann.cx, ann.cy);
    }
  }
  else if (ann.type === "calibration") {
    if (ann.x1 !== undefined) {
      if (handleKey === "a") { ann.x1+=dx; ann.y1+=dy; }
      else if (handleKey === "b") { ann.x2+=dx; ann.y2+=dy; }
      else { ann.x1+=dx; ann.y1+=dy; ann.x2+=dx; ann.y2+=dy; }
    } else {
      ann.cx+=dx; ann.cy+=dy;
    }
  }
  else if (ann.type === "area") {
    if (handleKey === "body") {
      ann.points.forEach(p => { p.x += dx; p.y += dy; });
    } else if (handleKey.startsWith("v")) {
      const i = parseInt(handleKey.slice(1));
      ann.points[i].x += dx; ann.points[i].y += dy;
    }
  }
  else if (ann.type === "origin") {
    if (handleKey === "axis") {
      // Recompute angle from origin to current mouse position
      ann.angle = Math.atan2(pt.y - ann.y, pt.x - ann.x);
      state.origin = { x: ann.x, y: ann.y, angle: ann.angle };
    } else {
      // Move entire origin (center handle or body)
      ann.x += dx; ann.y += dy;
      state.origin = { x: ann.x, y: ann.y, angle: ann.angle ?? 0 };
    }
  }
  else if (ann.type === "arc-measure") {
    if (handleKey === "p1") { ann.p1.x += dx; ann.p1.y += dy; }
    else if (handleKey === "p2") { ann.p2.x += dx; ann.p2.y += dy; }
    else if (handleKey === "p3") { ann.p3.x += dx; ann.p3.y += dy; }
    else { ann.p1.x+=dx; ann.p1.y+=dy; ann.p2.x+=dx; ann.p2.y+=dy; ann.p3.x+=dx; ann.p3.y+=dy; ann.cx+=dx; ann.cy+=dy; }
    // Re-fit circle through the 3 points (unless body drag)
    if (handleKey !== "body") {
      const [p1, p2, p3] = [ann.p1, ann.p2, ann.p3];
      const ax = p2.x - p1.x, ay = p2.y - p1.y;
      const bx = p3.x - p1.x, by = p3.y - p1.y;
      const D = 2 * (ax * by - ay * bx);
      if (Math.abs(D) > 1e-6) {
        const ux = (by * (ax*ax + ay*ay) - ay * (bx*bx + by*by)) / D;
        const uy = (ax * (bx*bx + by*by) - bx * (ax*ax + ay*ay)) / D;
        ann.cx = p1.x + ux;
        ann.cy = p1.y + uy;
        ann.r = Math.hypot(ux, uy);
        let span = Math.abs(Math.atan2(p3.y - ann.cy, p3.x - ann.cx) - Math.atan2(p1.y - ann.cy, p1.x - ann.cx)) * 180 / Math.PI;
        if (span > 180) span = 360 - span;
        ann.span_deg = span;
        ann.chord_px = Math.hypot(p3.x - p1.x, p3.y - p1.y);
      }
    }
  }
  else if (ann.type === "arc-fit") {
    if (handleKey === "edge") {
      ann.r = Math.hypot(pt.x - ann.cx, pt.y - ann.cy);
    } else {
      ann.cx += dx; ann.cy += dy;
    }
  }
  else if (ann.type === "spline") {
    if (handleKey === "body") {
      (ann.points || []).forEach(p => { p.x += dx; p.y += dy; });
    } else if (handleKey.startsWith("v")) {
      const i = parseInt(handleKey.slice(1));
      ann.points[i].x += dx; ann.points[i].y += dy;
    }
    ann.length_px = splineArcLength(ann.points);
  }
  else if (ann.type === "pt-circle-dist") {
    ann.px += dx; ann.py += dy;
  }

  renderSidebar();
  redraw();
}

// ── Multi-point tool finalization ─────────────────────────────────────────────

/** Show the Arc / Circle chooser. Called from dblclick and Enter handlers. */
export function promptArcFitChoice() {
  if (state.pendingPoints.length < 3) return;
  const fit = fitCircleAlgebraic(state.pendingPoints);
  if (!fit) { showStatus("Could not fit circle — points may be collinear"); return; }
  const chooser = document.getElementById("arc-fit-chooser");
  if (!chooser) { finalizeArcFit(false); return; }
  chooser.hidden = false;
}

/** Called by the Arc / Circle chooser buttons. */
export function finalizeArcFit(asCircle) {
  const chooser = document.getElementById("arc-fit-chooser");
  if (chooser) chooser.hidden = true;
  if (state.pendingPoints.length < 3) return;
  const fit = fitCircleAlgebraic(state.pendingPoints);
  if (!fit) { showStatus("Could not fit circle — points may be collinear"); return; }

  let ann;
  if (asCircle) {
    ann = { type: "arc-fit", cx: fit.cx, cy: fit.cy, r: fit.r };
  } else {
    const { startAngle, endAngle, anticlockwise } = _arcAngles(state.pendingPoints, fit.cx, fit.cy);
    ann = { type: "arc-fit", cx: fit.cx, cy: fit.cy, r: fit.r, startAngle, endAngle, anticlockwise };
  }
  addAnnotation(ann);
  state.pendingPoints = [];
  setTool("select");
}

function _arcAngles(points, cx, cy) {
  const angles = points.map(p => Math.atan2(p.y - cy, p.x - cx));
  // Sum signed angular steps to determine winding direction
  let totalDelta = 0;
  for (let i = 1; i < angles.length; i++) {
    let d = angles[i] - angles[i - 1];
    if (d > Math.PI)  d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    totalDelta += d;
  }
  return {
    startAngle: angles[0],
    endAngle:   angles[angles.length - 1],
    anticlockwise: totalDelta < 0,
  };
}

export function finalizeArea() {
  if (state.pendingPoints.length < 3) return false;
  addAnnotation({ type: "area", points: [...state.pendingPoints] });
  state.pendingPoints = [];
  setTool("select");
  return true;
}

export function finalizeSpline() {
  if (state.pendingPoints.length < 2) return false;
  const length_px = splineArcLength(state.pendingPoints);
  addAnnotation({ type: "spline", points: [...state.pendingPoints], length_px });
  state.pendingPoints = [];
  setTool("select");
  return true;
}

// ── Dynamic step status ───────────────────────────────────────────────────────
// Called after each point placement to keep the status bar current.
export function updateToolStatus() {
  const n = state.pendingPoints.length;
  if (n === 0) return;
  const tool = state.tool;

  // Fixed-step tools: array index = points already placed
  const steps = {
    distance:      ['Click point 2'],
    angle:         ['Click the vertex', 'Click point 3 (other arm)'],
    circle:        state.circleMode === 'center-edge'
      ? ['Click edge point']
      : ['Click point 2 of 3', 'Click point 3 of 3'],
    calibrate:     ['Click point 2'],
    'arc-measure': state.arcMeasureMode === 'ends-first'
      ? ['Click second end', 'Click arc midpoint']
      : ['Click arc midpoint', 'Click arc end'],
  };
  const names = {
    distance: 'Distance', angle: 'Angle',
    circle: state.circleMode === 'center-edge' ? 'Circle (Center+Edge)' : 'Circle (3-point)',
    calibrate: 'Calibrate', 'arc-measure': 'Arc Measure',
  };
  if (steps[tool]) {
    const msg = steps[tool][n - 1] ?? steps[tool][steps[tool].length - 1];
    showStatus(`${names[tool]} — ${msg}`);
    return;
  }
  if (tool === 'arc-fit') {
    if (n < 3) showStatus(`Fit Arc — ${n} point${n > 1 ? 's' : ''} placed, need ${3 - n} more`);
    else       showStatus(`Fit Arc — ${n} points · double-click or Enter to finish`);
    return;
  }
  if (tool === 'area') {
    if (n < 3) showStatus(`Area — ${n} point${n > 1 ? 's' : ''} placed, need ${3 - n} more`);
    else       showStatus(`Area — ${n} points · double-click or Enter to finish`);
    return;
  }
  if (tool === 'spline') {
    if (n < 2) showStatus(`Spline — ${n} anchor placed, need ${2 - n} more`);
    else       showStatus(`Spline — ${n} anchors · double-click or Enter to finish`);
    return;
  }
}

// ── Sync center-dist endpoints when a referenced circle moves ─────────────────
function _syncCenterDist(circleId, cx, cy) {
  for (const ann of state.annotations) {
    if (ann.type !== "center-dist") continue;
    if (ann.circleAId === circleId) { ann.a.x = cx; ann.a.y = cy; }
    if (ann.circleBId === circleId) { ann.b.x = cx; ann.b.y = cy; }
  }
}

// ── Nudge selected annotations (arrow key movement) ───────────────────────────
export function nudgeSelected(dx, dy) {
  if (state.selected.size === 0) return false;
  pushUndo();
  for (const id of state.selected) {
    const ann = state.annotations.find(a => a.id === id);
    if (ann) _nudgeAnn(ann, dx, dy);
  }
  return true;
}

function _nudgeAnn(ann, dx, dy) {
  if (ann.type === 'center-dist') { /* linked — nudge the circles instead */ }
  else if (['distance', 'perp-dist', 'para-dist', 'parallelism'].includes(ann.type)) {
    ann.a.x += dx; ann.a.y += dy;
    ann.b.x += dx; ann.b.y += dy;
  } else if (ann.type === 'angle') {
    ann.p1.x += dx; ann.p1.y += dy;
    ann.vertex.x += dx; ann.vertex.y += dy;
    ann.p3.x += dx; ann.p3.y += dy;
  } else if (ann.type === 'circle' || ann.type === 'arc-fit') {
    ann.cx += dx; ann.cy += dy;
    if (ann.type === 'circle') _syncCenterDist(ann.id, ann.cx, ann.cy);
  } else if (ann.type === 'calibration') {
    if (ann.x1 !== undefined) { ann.x1 += dx; ann.y1 += dy; ann.x2 += dx; ann.y2 += dy; }
    else { ann.cx += dx; ann.cy += dy; }
  } else if (ann.type === 'area' || ann.type === 'spline') {
    ann.points.forEach(p => { p.x += dx; p.y += dy; });
  } else if (ann.type === 'origin') {
    ann.x += dx; ann.y += dy;
  } else if (ann.type === 'arc-measure') {
    ann.p1.x += dx; ann.p1.y += dy;
    ann.p2.x += dx; ann.p2.y += dy;
    ann.p3.x += dx; ann.p3.y += dy;
    ann.cx += dx; ann.cy += dy;
  } else if (ann.type === 'pt-circle-dist') {
    ann.px += dx; ann.py += dy;
  }
  // intersect, slot-dist: reference-based — skip individual nudge
  // detected-*: skip
}

export function collectDxfSnapPoints(ann) {
  const pts = [];
  for (const en of ann.entities) {
    if (en.type === "line") {
      pts.push({ x: en.x1, y: en.y1 }, { x: en.x2, y: en.y2 });
    } else if (en.type === "circle" || en.type === "arc") {
      pts.push({ x: en.cx, y: en.cy });
    } else if (en.type === "polyline") {
      for (const p of en.points) pts.push({ x: p.x, y: p.y });
    }
  }
  return pts.map(p => ({ dxf: p, canvas: dxfToCanvas(p.x, p.y, ann) }));
}
