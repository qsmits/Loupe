import { apiFetch } from './api.js';
import { refinePointJS } from './subpixel-js.js';
import { state, TOOL_STATUS, pushUndo } from './state.js';
import { redraw, canvas, showStatus, getLineEndpoints, lineAngleDeg, listEl } from './render.js';
import { dxfToCanvas } from './render-dxf.js';
import { addAnnotation, applyCalibration, elevateAnnotation } from './annotations.js';
import { fitCircle, fitCircleAlgebraic, fitLine, splineArcLength, parseDistanceInput, distPointToSegment, polygonArea, catmullRomControlPoints } from './math.js';
import { renderSidebar } from './sidebar.js';
import { viewport, screenToImage, imageWidth, imageHeight } from './viewport.js';
import { hitTestAnnotation, hitTestDxfEntity } from './hit-test.js';
import { openCommentEditor } from './comment-editor.js';
import { solveConstraints } from './constraint-solver.js';

// Re-export for backward compatibility (other modules import these from tools.js)
export { hitTestAnnotation, hitTestDxfEntity } from './hit-test.js';

// Optional hook set by sub-mode-selector.js to keep the segmented control in sync.
let _subModeSelectorSync = null;
export function registerSubModeSelectorSync(fn) { _subModeSelectorSync = fn; }

export function setTool(name) {
  // Pan is only meaningful in frozen mode (live camera fills the viewport, so
  // panning would just shift annotations out from under the fixed image).
  if (name === "pan" && !state.frozen) {
    showStatus("Pan is only available on a frozen image");
    return;
  }
  // Block calibration until camera dimensions are known. Calibrating against
  // a stale/fallback imageWidth (e.g. canvas CSS pixels, from the render.js
  // resizeCanvas fallback) gives a scale that shifts the moment the real
  // camera resolution arrives — usually at the next freeze. Forcing the user
  // to wait is cheaper than silently producing a wrong calibration.
  if (name === "calibrate" && (!imageWidth || !imageHeight)) {
    showStatus("Camera info not ready yet — please wait a moment and try again");
    return;
  }
  state.tool = name;
  // Track the top-level measure group so the sub-mode selector can stay visible.
  const topLevel = _TOOL_TO_TOP_LEVEL[name] ?? null;
  state._topLevelTool = topLevel;
  state.pendingPoints = [];
  state.pendingCenterCircle = null;
  state.pendingRefLine = null;
  state.pendingRefLineClick = null;
  state.pendingCircleRef = null;
  state.hoverRefLine = null;
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
  if (state.dxfRotateMode) {
    state.dxfRotateMode = false;
    state.dxfRotateOrigin = null;
    document.getElementById("btn-dxf-rotate")?.classList.remove("active");
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
  if (state.gearPickMode) {
    state.gearPickMode = null;
    state.gearPickBuffer = null;
    state.gearPickHover = null;
    canvas.style.cursor = "default";
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
  "para-dist","perp-dist","area","area-shape","pt-circle-dist","intersect","slot-dist","spline","fit-line","point",
]);

// ── Top-level measure-tool groups (6-entry consolidated menu) ────────────────
// Each top-level tool has sub-modes that map to underlying tool strings.
// The first sub-mode in each group is the default.
export const MEASURE_TOP_LEVEL = {
  distance: {
    label: "Distance",
    subModes: [
      { id: "direct",       label: "Direct",        tool: "distance" },
      { id: "parallel",     label: "Parallel",      tool: "para-dist" },
      { id: "perpendicular",label: "Perpendicular", tool: "perp-dist" },
      { id: "slot",         label: "Slot",          tool: "slot-dist" },
      { id: "pt-circle",    label: "Pt-Circle",     tool: "pt-circle-dist" },
      { id: "center-center",label: "Center-Center", tool: "center-dist" },
    ],
  },
  angle: {
    label: "Angle",
    subModes: [
      // Both sub-modes trigger the same underlying tool; angle tool chooses
      // two-lines vs three-points based on whether the first click hits a line.
      { id: "two-lines",   label: "Two lines",   tool: "angle", angleMode: "two-lines" },
      { id: "three-points",label: "Three points",tool: "angle", angleMode: "three-points" },
    ],
  },
  circle: {
    label: "Circle / Arc",
    subModes: [
      { id: "3-point",       label: "3-point",     tool: "circle",      circleMode: "3-point" },
      { id: "center-edge",   label: "Center+edge", tool: "circle",      circleMode: "center-edge" },
      { id: "best-fit-circ", label: "Best-fit circle",tool: "arc-fit",  arcFitMode: "circle" },
      { id: "best-fit-arc",  label: "Best-fit arc",   tool: "arc-fit",  arcFitMode: "arc" },
      { id: "arc-sequential",label: "Arc (seq)",   tool: "arc-measure", arcMeasureMode: "sequential" },
      { id: "arc-ends-first",label: "Arc (ends)",  tool: "arc-measure", arcMeasureMode: "ends-first" },
    ],
  },
  area: {
    label: "Area",
    subModes: [
      { id: "polygon", label: "Polygon", tool: "area" },
      { id: "shape",   label: "From shape", tool: "area-shape" },
    ],
  },
  intersect: {
    label: "Intersect",
    subModes: [
      { id: "intersect", label: "Intersect", tool: "intersect" },
    ],
  },
  misc: {
    label: "Misc",
    subModes: [
      { id: "flatness", label: "Flatness", tool: "fit-line" },
      { id: "spline",   label: "Spline",   tool: "spline" },
    ],
  },
  point: {
    label: "Point",
    subModes: [
      { id: "point", label: "Point", tool: "point" },
    ],
  },
};

// Reverse lookup: underlying tool string → top-level key.
// For tools shared across groups we pick the canonical parent.
const _TOOL_TO_TOP_LEVEL = {
  "distance":       "distance",
  "para-dist":      "distance",
  "perp-dist":      "distance",
  "slot-dist":      "distance",
  "pt-circle-dist": "distance",
  "center-dist":    "distance",
  "angle":          "angle",
  "circle":         "circle",
  "arc-fit":        "circle",
  "arc-measure":    "circle",
  "fit-line":       "misc",
  "area":           "area",
  "area-shape":     "area",
  "spline":         "misc",
  "intersect":      "intersect",
  "point":          "point",
};

export function topLevelOfTool(tool) {
  return _TOOL_TO_TOP_LEVEL[tool] ?? null;
}

const _TOOL_LABELS = {
  "distance":"Distance","angle":"Angle","circle":"Circle / Arc","arc-fit":"Circle / Arc",
  "arc-measure":"Circle / Arc","center-dist":"Distance","para-dist":"Distance",
  "perp-dist":"Distance","area":"Area","pt-circle-dist":"Distance",
  "intersect":"Intersect","slot-dist":"Distance","spline":"Misc",
  "fit-line":"Misc",
  "calibrate":"Calibrate",
  "point":"Point",
};

function _updateStripGroups(name) {
  const measureBtn = document.getElementById("btn-strip-measure");
  const setupBtn   = document.getElementById("btn-strip-setup");
  const optsBar    = document.getElementById("tool-options-bar");
  if (measureBtn) {
    const inGroup = _MEASURE_TOOLS.has(name);
    const topKey = _TOOL_TO_TOP_LEVEL[name];
    const topLabel = topKey ? MEASURE_TOP_LEVEL[topKey].label : null;
    measureBtn.textContent = inGroup ? (topLabel ?? _TOOL_LABELS[name] ?? name) + " ▾" : "Measure ▾";
    measureBtn.classList.toggle("active", inGroup);
  }
  if (setupBtn) {
    setupBtn.classList.toggle("active", name === "calibrate");
  }
  if (optsBar) {
    // All measure sub-options now live in the bottom-center sub-mode selector.
    // Keep the legacy inline bar hidden.
    optsBar.hidden = true;
    const arcOpts = document.getElementById("tool-opts-arc-measure");
    const circleOpts = document.getElementById("tool-opts-circle");
    if (arcOpts) arcOpts.hidden = true;
    if (circleOpts) circleOpts.hidden = true;
  }
  if (_subModeSelectorSync) _subModeSelectorSync();
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
    } else if (ann.type === "spline" || ann.type === "fit-line") {
      (ann.points || []).forEach(p => targets.push(p));
    } else if (ann.type === "origin") {
      targets.push({ x: ann.x, y: ann.y });
    } else if (ann.type === "area") {
      (ann.points || []).forEach(p => targets.push(p));
    } else if (ann.type === "point") {
      targets.push({ x: ann.x, y: ann.y });
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
            if (circle.type !== "circle") {
              // Elevate the detection first, then calibrate without adding the
              // redundant diameter-line annotation — the circle measurement is
              // already the visual record of what was calibrated on.
              elevateAnnotation(circle.id);
              applyCalibration({ type: "calibration", cx, cy, r, knownValue: parsed.value, unit: parsed.unit });
              state.annotations = state.annotations.filter(a => a.type !== "calibration");
            } else {
              applyCalibration({ type: "calibration", cx, cy, r, knownValue: parsed.value, unit: parsed.unit });
            }
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
    // Sub-mode: user explicitly chose "two-lines" or "three-points" in the
    // sub-mode selector. Honor that choice strictly — no silent fallback.
    if (state.angleMode === "two-lines") {
      if (!state.pendingRefLine) {
        const refAnn = findSnapLine(pt);
        if (!refAnn) {
          showStatus("Angle (two lines) — click on a line");
          return;
        }
        state.pendingRefLine = refAnn;
        state.pendingRefLineClick = { x: pt.x, y: pt.y };
        showStatus("Angle — click a second line to measure the angle between them");
        redraw();
        return;
      }
      const secondAnn = findSnapLine(pt);
      if (!secondAnn || secondAnn.id === state.pendingRefLine.id) {
        showStatus("Angle (two lines) — click on a different line");
        return;
      }
      const ann = _angleFromLines(
        state.pendingRefLine, secondAnn,
        state.pendingRefLineClick, { x: pt.x, y: pt.y },
      );
      state.pendingRefLine = null;
      state.pendingRefLineClick = null;
      if (ann) {
        addAnnotation(ann);
        setTool("select");
      } else {
        showStatus("Angle — lines are parallel, no intersection");
      }
      return;
    }
    // Three-points mode.
    state.pendingPoints.push(pt);
    if (state.pendingPoints.length === 3) {
      const [p1, vertex, p3] = state.pendingPoints;
      addAnnotation({ type: "angle", p1, vertex, p3 });
      state.pendingPoints = [];
      setTool("select");
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

  if (tool === "fit-line") {
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

  if (tool === "area-shape") {
    // Click once on a closed shape (single annotation) or a segment of a closed loop
    // built from connected line/arc/spline annotations. Creates an `area` annotation.
    let hitAnn = null;
    for (let i = state.annotations.length - 1; i >= 0; i--) {
      const a = state.annotations[i];
      if (a.type === "dxf-overlay" || a.type === "edges-overlay" || a.type === "preprocessed-overlay") continue;
      if (hitTestAnnotation(a, pt)) { hitAnn = a; break; }
    }
    if (!hitAnn) {
      showStatus("Click a closed shape (or a segment of a closed loop)");
      return;
    }
    const singleVerts = _singleClosedVertices(hitAnn);
    if (singleVerts) {
      const area = polygonArea(singleVerts);
      addAnnotation({ type: "area", points: singleVerts, sourceAnnIds: [hitAnn.id] });
      state._flashExpiry = Date.now() + 400;
      showStatus(`Area captured (${area.toFixed(1)} px²)`);
      setTool("select");
      return;
    }
    const loop = _traverseLoop(hitAnn);
    if (!loop) {
      showStatus("Not a closed shape");
      return;
    }
    const area = polygonArea(loop.points);
    addAnnotation({ type: "area", points: loop.points, sourceAnnIds: loop.ids });
    state._flashExpiry = Date.now() + 400;
    showStatus(`Area captured from ${loop.ids.length} segments (${area.toFixed(1)} px²)`);
    setTool("select");
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
  if (tool === "point") {
    addAnnotation({
      type: "point",
      x: pt.x,
      y: pt.y,
      purpose: "drawing",
    });
    showStatus("Reference point placed");
    return;
  }
  if (tool === "comment") {
    // Open inline editor at click location; on commit, create annotation.
    openCommentEditor(pt, null);
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
    if (ann.hidden || state._hideAllAnnotations) continue;
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
  if (ann.type === "angle") {
    if (ann.fromLines) {
      // Radius drag handle at arc midpoint
      const a1 = Math.atan2(ann.p1.y - ann.vertex.y, ann.p1.x - ann.vertex.x);
      const a3 = Math.atan2(ann.p3.y - ann.vertex.y, ann.p3.x - ann.vertex.x);
      let delta = a3 - a1;
      while (delta >  Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      const start = delta >= 0 ? a1 : a3;
      const end   = delta >= 0 ? a3 : a1;
      let mid = start + (end - start) / 2;
      if (end < start) mid += Math.PI;
      const r = ann.arcRadius || 40 / viewport.zoom;
      return { radius: { x: ann.vertex.x + Math.cos(mid) * r, y: ann.vertex.y + Math.sin(mid) * r } };
    }
    return { p1: ann.p1, vertex: ann.vertex, p3: ann.p3 };
  }
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
  if (ann.type === "spline" || ann.type === "fit-line") {
    const handles = {};
    (ann.points || []).forEach((p, i) => { handles[`v${i}`] = p; });
    return handles;
  }
  if (ann.type === "point") return { pin: { x: ann.x, y: ann.y } };
  if (ann.type === "comment") return { pin: { x: ann.x, y: ann.y } };
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
    if (ann.fromLines) {
      if (handleKey === "radius") {
        // Set radius to the distance from vertex to the pointer.
        ann.arcRadius = Math.max(5, Math.hypot(pt.x - ann.vertex.x, pt.y - ann.vertex.y));
      } else {
        // Body drag: translate vertex and arm points together (keeps directions & radius).
        ann.p1.x+=dx; ann.p1.y+=dy;
        ann.vertex.x+=dx; ann.vertex.y+=dy;
        ann.p3.x+=dx; ann.p3.y+=dy;
      }
    }
    else if (handleKey === "p1")     { ann.p1.x+=dx; ann.p1.y+=dy; }
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
  else if (ann.type === "fit-line") {
    if (handleKey === "body") {
      ann.points.forEach(p => { p.x += dx; p.y += dy; });
      ann.cx += dx; ann.cy += dy;
      ann.x1 += dx; ann.y1 += dy;
      ann.x2 += dx; ann.y2 += dy;
    } else if (handleKey.startsWith("v")) {
      const i = parseInt(handleKey.slice(1));
      ann.points[i].x += dx; ann.points[i].y += dy;
    }
    // Recompute fit and zone
    const fit = fitLine(ann.points);
    if (fit) {
      ann.cx = fit.cx; ann.cy = fit.cy;
      ann.dx = fit.dx; ann.dy = fit.dy;
      ann.x1 = fit.x1; ann.y1 = fit.y1;
      ann.x2 = fit.x2; ann.y2 = fit.y2;
      const fnx = -fit.dy, fny = fit.dx;
      const dists = ann.points.map(p => (p.x - fit.cx) * fnx + (p.y - fit.cy) * fny);
      ann.zoneMin = Math.min(...dists);
      ann.zoneMax = Math.max(...dists);
      ann.zoneWidth = ann.zoneMax - ann.zoneMin;
    }
  }
  else if (ann.type === "pt-circle-dist") {
    ann.px += dx; ann.py += dy;
  }
  else if (ann.type === "point") {
    ann.x += dx; ann.y += dy;
  }
  else if (ann.type === "comment") {
    // Body drag (and pin handle drag) translate the pin; labelOffset is
    // modified only via the label-drag machinery.
    ann.x += dx; ann.y += dy;
  }

  // Run constraint solver after any handle mutation
  if (state.constraints.length > 0) {
    solveConstraints(state.annotations, state.constraints, ann.id);
  }

  renderSidebar();
  redraw();
}

// ── Multi-point tool finalization ─────────────────────────────────────────────

/** Finalize arc-fit directly using the current state.arcFitMode. */
export function promptArcFitChoice() {
  if (state.pendingPoints.length < 3) return;
  const fit = fitCircleAlgebraic(state.pendingPoints);
  if (!fit) { showStatus("Could not fit circle — points may be collinear"); return; }
  finalizeArcFit(state.arcFitMode === "circle");
}

/** Called by the Arc / Circle chooser buttons. */
export function finalizeArcFit(asCircle) {
  const chooser = document.getElementById("arc-fit-chooser");
  if (chooser) chooser.hidden = true;
  if (state.pendingPoints.length < 3) return;
  const fit = fitCircleAlgebraic(state.pendingPoints);
  if (!fit) { showStatus("Could not fit circle — points may be collinear"); return; }

  const savedPoints = [...state.pendingPoints];
  let ann;
  if (asCircle) {
    ann = { type: "arc-fit", cx: fit.cx, cy: fit.cy, r: fit.r, points: savedPoints };
  } else {
    const { startAngle, endAngle, anticlockwise } = _arcAngles(state.pendingPoints, fit.cx, fit.cy);
    ann = { type: "arc-fit", cx: fit.cx, cy: fit.cy, r: fit.r, startAngle, endAngle, anticlockwise, points: savedPoints };
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
  // During cross-mode mask editing, stay in area tool for continuous drawing
  if (!(window.crossMode && window.crossMode.source)) {
    setTool("select");
  }
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

export function finalizeFitLine() {
  if (state.pendingPoints.length < 2) return false;
  const fit = fitLine(state.pendingPoints);
  if (!fit) return false;
  const pts = state.pendingPoints;
  const { cx, cy, dx, dy } = fit;
  const nx = -dy, ny = dx;
  const dists = pts.map(p => (p.x - cx) * nx + (p.y - cy) * ny);
  const zoneMin = Math.min(...dists);
  const zoneMax = Math.max(...dists);
  const zoneWidth = zoneMax - zoneMin;
  addAnnotation({
    type: "fit-line", points: [...pts],
    cx, cy, dx, dy,
    x1: fit.x1, y1: fit.y1, x2: fit.x2, y2: fit.y2,
    zoneWidth, zoneMin, zoneMax,
  });
  state.pendingPoints = [];
  setTool("select");
  return true;
}

// ── Line-to-line angle ────────────────────────────────────────────────────────
// Given two line-like annotations and the points the user clicked on them,
// compute the intersection vertex and return an angle annotation.
// The arc is centered at the true intersection and passes through the
// projected click points by default; the user can drag the radius handle to
// move the arc in/out along the angle bisector.
function _angleFromLines(annA, annB, clickA, clickB) {
  const epA = getLineEndpoints(annA);
  const epB = getLineEndpoints(annB);
  if (!epA || !epB) return null;

  const dx_a = epA.b.x - epA.a.x, dy_a = epA.b.y - epA.a.y;
  const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
  const denom = dx_a * dy_b - dy_a * dx_b;
  if (Math.abs(denom) < 1e-6) return null; // parallel

  const t = ((epB.a.x - epA.a.x) * dy_b - (epB.a.y - epA.a.y) * dx_b) / denom;
  const vertex = {
    x: epA.a.x + t * dx_a,
    y: epA.a.y + t * dy_a,
  };

  // Project each click onto its line so the arm endpoint lies exactly on it.
  function _project(pt, ep) {
    const dx = ep.b.x - ep.a.x, dy = ep.b.y - ep.a.y;
    const l2 = dx*dx + dy*dy;
    if (l2 < 1e-10) return { x: ep.a.x, y: ep.a.y };
    const u = ((pt.x - ep.a.x) * dx + (pt.y - ep.a.y) * dy) / l2;
    return { x: ep.a.x + u * dx, y: ep.a.y + u * dy };
  }
  const p1 = _project(clickA, epA);
  const p3 = _project(clickB, epB);

  // Default arc radius = average distance from intersection to the two clicks.
  const rA = Math.hypot(p1.x - vertex.x, p1.y - vertex.y);
  const rB = Math.hypot(p3.x - vertex.x, p3.y - vertex.y);
  const arcRadius = (rA + rB) / 2;

  return { type: "angle", fromLines: true, vertex, p1, p3, arcRadius };
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
  if (tool === 'fit-line') {
    if (n < 2) showStatus(`Fit Line — ${n} point placed, need ${2 - n} more`);
    else       showStatus(`Fit Line — ${n} points · double-click or Enter to finish`);
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
  // Re-solve constraints after nudge
  if (state.constraints.length > 0) {
    const driverId = state.selected.size === 1 ? [...state.selected][0] : null;
    solveConstraints(state.annotations, state.constraints, driverId);
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
  } else if (ann.type === 'point') {
    ann.x += dx; ann.y += dy;
  } else if (ann.type === 'comment') {
    ann.x += dx; ann.y += dy;
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

// ── Area-shape: closed-shape detection + loop traversal ──────────────────────
// Supported "segment" types (endpoint-chainable):
//   distance, detected-line, detected-line-merged, arc-measure,
//   detected-arc-partial, spline (open), arc-fit (partial).
// Supported "single closed" types: circle, detected-circle, arc-fit (full
// circle), area, spline (closed).

function _areaShapeTol() {
  return Math.max(0.5, 1 / (viewport.zoom || 1));
}

function _singleClosedVertices(ann) {
  if (ann.type === "circle" || ann.type === "detected-circle") {
    let cx, cy, r;
    if (ann.type === "circle") { cx = ann.cx; cy = ann.cy; r = ann.r; }
    else {
      const sx = imageWidth / (ann.frameWidth || imageWidth);
      const sy = imageHeight / (ann.frameHeight || imageHeight);
      cx = ann.x * sx; cy = ann.y * sy; r = ann.radius * sx;
    }
    const n = Math.max(32, Math.ceil(2 * Math.PI * r / 2));
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * 2 * Math.PI;
      pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
    }
    return pts;
  }
  if (ann.type === "arc-fit" && ann.startAngle === undefined) {
    const n = Math.max(32, Math.ceil(2 * Math.PI * ann.r / 2));
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * 2 * Math.PI;
      pts.push({ x: ann.cx + ann.r * Math.cos(t), y: ann.cy + ann.r * Math.sin(t) });
    }
    return pts;
  }
  if (ann.type === "area") {
    return (ann.points || []).map(p => ({ x: p.x, y: p.y }));
  }
  if (ann.type === "spline" && ann.points && ann.points.length >= 3) {
    const pts = ann.points;
    const first = pts[0], last = pts[pts.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < _areaShapeTol() * 2) {
      return _sampleSpline(pts);
    }
  }
  return null;
}

function _extractEndpoints(ann) {
  if (ann.type === "distance") {
    return { a: { x: ann.a.x, y: ann.a.y }, b: { x: ann.b.x, y: ann.b.y } };
  }
  if (ann.type === "detected-line" || ann.type === "detected-line-merged") {
    const sx = imageWidth / (ann.frameWidth || imageWidth);
    const sy = imageHeight / (ann.frameHeight || imageHeight);
    return {
      a: { x: ann.x1 * sx, y: ann.y1 * sy },
      b: { x: ann.x2 * sx, y: ann.y2 * sy },
    };
  }
  if (ann.type === "arc-measure") {
    return { a: { x: ann.p1.x, y: ann.p1.y }, b: { x: ann.p3.x, y: ann.p3.y } };
  }
  if (ann.type === "detected-arc-partial") {
    const sx = imageWidth / (ann.frameWidth || imageWidth);
    const sy = imageHeight / (ann.frameHeight || imageHeight);
    const cx = ann.cx * sx, cy = ann.cy * sy, r = ann.r * sx;
    const a1 = ann.start_deg * Math.PI / 180;
    const a2 = ann.end_deg * Math.PI / 180;
    return {
      a: { x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) },
      b: { x: cx + r * Math.cos(a2), y: cy + r * Math.sin(a2) },
    };
  }
  if (ann.type === "arc-fit" && ann.startAngle !== undefined) {
    return {
      a: { x: ann.cx + ann.r * Math.cos(ann.startAngle), y: ann.cy + ann.r * Math.sin(ann.startAngle) },
      b: { x: ann.cx + ann.r * Math.cos(ann.endAngle),   y: ann.cy + ann.r * Math.sin(ann.endAngle) },
    };
  }
  if (ann.type === "spline" && ann.points && ann.points.length >= 2) {
    const first = ann.points[0];
    const last = ann.points[ann.points.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < _areaShapeTol() * 2) return null;
    return { a: { x: first.x, y: first.y }, b: { x: last.x, y: last.y } };
  }
  return null;
}

function _sampleSpline(pts) {
  const out = [];
  const n = pts.length;
  if (n < 2) return pts.slice();
  const SAMPLES = 16;
  for (let i = 0; i < n - 1; i++) {
    const { cp1x, cp1y, cp2x, cp2y } = catmullRomControlPoints(pts, i);
    const p1 = pts[i], p2 = pts[i + 1];
    for (let j = 0; j < SAMPLES; j++) {
      const t = j / SAMPLES, mt = 1 - t;
      const bx = mt*mt*mt*p1.x + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*p2.x;
      const by = mt*mt*mt*p1.y + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*p2.y;
      out.push({ x: bx, y: by });
    }
  }
  out.push({ x: pts[n - 1].x, y: pts[n - 1].y });
  return out;
}

function _sampleSegment(ann, fromPt) {
  const ep = _extractEndpoints(ann);
  if (!ep) return [];
  const fromIsA = Math.hypot(ep.a.x - fromPt.x, ep.a.y - fromPt.y) <=
                  Math.hypot(ep.b.x - fromPt.x, ep.b.y - fromPt.y);
  const start = fromIsA ? ep.a : ep.b;
  const end = fromIsA ? ep.b : ep.a;

  if (ann.type === "distance" || ann.type === "detected-line" || ann.type === "detected-line-merged") {
    return [{ x: end.x, y: end.y }];
  }
  if (ann.type === "arc-measure" || ann.type === "detected-arc-partial" ||
      (ann.type === "arc-fit" && ann.startAngle !== undefined)) {
    let cx, cy, r;
    if (ann.type === "arc-measure") { cx = ann.cx; cy = ann.cy; r = ann.r; }
    else if (ann.type === "arc-fit") { cx = ann.cx; cy = ann.cy; r = ann.r; }
    else {
      const sx = imageWidth / (ann.frameWidth || imageWidth);
      cx = ann.cx * sx;
      cy = ann.cy * (imageHeight / (ann.frameHeight || imageHeight));
      r = ann.r * sx;
    }
    const aStart = Math.atan2(start.y - cy, start.x - cx);
    const aEnd = Math.atan2(end.y - cy, end.x - cx);
    let sweep = aEnd - aStart;
    if (ann.type === "arc-measure" && ann.p2) {
      const aMid = Math.atan2(ann.p2.y - cy, ann.p2.x - cx);
      const norm = x => ((x - aStart) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      const midFwd = norm(aMid);
      const endFwd = norm(aEnd);
      if (midFwd > endFwd) sweep = endFwd - 2 * Math.PI;
      else sweep = endFwd;
    } else {
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
    }
    const absSweep = Math.abs(sweep);
    const N = Math.max(8, Math.ceil(absSweep * r / 2));
    const out = [];
    for (let i = 1; i <= N; i++) {
      const t = aStart + sweep * (i / N);
      out.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
    }
    return out;
  }
  if (ann.type === "spline") {
    const pts = fromIsA ? ann.points : ann.points.slice().reverse();
    const sampled = _sampleSpline(pts);
    return sampled.slice(1);
  }
  return [];
}

function _traverseLoop(startAnn) {
  const startEp = _extractEndpoints(startAnn);
  if (!startEp) return null;
  const tol = _areaShapeTol();

  const segs = [];
  for (const a of state.annotations) {
    if (a.id === startAnn.id) continue;
    const ep = _extractEndpoints(a);
    if (ep) segs.push({ ann: a, a: ep.a, b: ep.b });
  }

  const origin = { x: startEp.a.x, y: startEp.a.y };
  let current = { x: startEp.b.x, y: startEp.b.y };
  const chain = [startAnn.id];
  const visited = new Set([startAnn.id]);
  let prevDx = startEp.b.x - startEp.a.x;
  let prevDy = startEp.b.y - startEp.a.y;

  const MAX_STEPS = 256;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (Math.hypot(current.x - origin.x, current.y - origin.y) <= tol * 2 && chain.length >= 3) {
      const points = [{ x: origin.x, y: origin.y }];
      let cursor = { x: origin.x, y: origin.y };
      for (const id of chain) {
        const ann = state.annotations.find(a => a.id === id);
        const samp = _sampleSegment(ann, cursor);
        if (samp.length === 0) return null;
        for (const p of samp) points.push(p);
        cursor = samp[samp.length - 1];
      }
      if (points.length > 1) {
        const last = points[points.length - 1];
        if (Math.hypot(last.x - origin.x, last.y - origin.y) <= tol * 2) points.pop();
      }
      if (points.length < 3) return null;
      return { points, ids: chain.slice() };
    }

    const candidates = [];
    for (const s of segs) {
      if (visited.has(s.ann.id)) continue;
      const dA = Math.hypot(s.a.x - current.x, s.a.y - current.y);
      const dB = Math.hypot(s.b.x - current.x, s.b.y - current.y);
      if (dA <= tol * 2 || dB <= tol * 2) {
        const next = dA <= dB ? s.b : s.a;
        candidates.push({ seg: s, next, matchDist: Math.min(dA, dB) });
      }
    }
    if (candidates.length === 0) return null;

    let chosen;
    if (candidates.length === 1) {
      chosen = candidates[0];
    } else {
      let best = null;
      let bestScore = -Infinity;
      for (const c of candidates) {
        const ndx = c.next.x - current.x;
        const ndy = c.next.y - current.y;
        const cross = prevDx * ndy - prevDy * ndx;
        const score = cross - c.matchDist * 1e-3;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      chosen = best;
    }

    visited.add(chosen.seg.ann.id);
    chain.push(chosen.seg.ann.id);
    prevDx = chosen.next.x - current.x;
    prevDy = chosen.next.y - current.y;
    current = { x: chosen.next.x, y: chosen.next.y };
  }
  return null;
}
