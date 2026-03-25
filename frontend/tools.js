import { state, TOOL_STATUS } from './state.js';
import { redraw, canvas, showStatus, getLineEndpoints, lineAngleDeg, dxfToCanvas, listEl } from './render.js';
import { addAnnotation, applyCalibration } from './annotations.js';
import { fitCircle, parseDistanceInput, distPointToSegment } from './math.js';
import { renderSidebar } from './sidebar.js';
import { screenToImage, imageWidth, imageHeight } from './viewport.js';

export function setTool(name) {
  state.tool = name;
  state.pendingPoints = [];
  state.pendingCenterCircle = null;
  state.pendingRefLine = null;
  state.pendingCircleRef = null;
  state.snapTarget = null;
  document.querySelectorAll("#tool-strip .strip-btn[data-tool]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tool === name);
  });
  showStatus(TOOL_STATUS[name] ?? name);
  canvas.style.cursor = name === "select" ? "default" : "crosshair";
  redraw();
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
    if (distPointToSegment(pt, ep.a, ep.b) < 10) return ann;
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
    } else if (ann.type === "origin") {
      targets.push({ x: ann.x, y: ann.y });
    } else if (ann.type === "area") {
      (ann.points || []).forEach(p => targets.push(p));
    }
  });
  for (const t of targets) {
    if (Math.hypot(t.x - rawPt.x, t.y - rawPt.y) <= SNAP_RADIUS) {
      return { pt: { x: t.x, y: t.y }, snapped: true };
    }
  }
  return { pt: rawPt, snapped: false };
}

// ── Tool click handler ─────────────────────────────────────────────────────
export function handleToolClick(rawPt, e = {}) {
  const { pt } = (state.tool !== "calibrate" && state.tool !== "center-dist")
    ? snapPoint(rawPt, e.altKey ?? false)
    : { pt: rawPt };
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
            setTool("select");
          }
        }
        redraw();
        return;
      }
    }
    // Two-point calibration flow
    state.pendingPoints.push(pt);
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
    redraw();
    return;
  }

  if (tool === "circle") {
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
    redraw();
    return;
  }

  if (tool === "arc-fit") {
    state.pendingPoints.push(pt);
    redraw();
    return;
  }

  if (tool === "arc-measure") {
    state.pendingPoints.push(pt);
    if (state.pendingPoints.length === 3) {
      const [p1, p2, p3] = state.pendingPoints;
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
    redraw();
    return;
  }

  if (tool === "area") {
    state.pendingPoints.push(pt);
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
      state.pendingCenterCircle = null;
      addAnnotation({ type: "center-dist", a, b });
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
  const RADIUS = 8;
  const handles = getHandles(ann);
  for (const [key, hp] of Object.entries(handles)) {
    if (Math.hypot(pt.x - hp.x, pt.y - hp.y) < RADIUS) return key;
  }
  return null;
}

export function getHandles(ann) {
  if (ann.type === "distance" || ann.type === "center-dist" ||
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
  if (ann.type === "pt-circle-dist") return { pt: { x: ann.px, y: ann.py } };
  if (ann.type === "intersect") return {};
  if (ann.type === "slot-dist") return {};
  return {};
}

export function hitTestAnnotation(ann, pt) {
  if (ann.type === "distance" || ann.type === "center-dist" ||
      ann.type === "perp-dist" || ann.type === "para-dist" ||
      ann.type === "parallelism") {
    return distPointToSegment(pt, ann.a, ann.b) < 8;
  }
  if (ann.type === "angle") {
    return distPointToSegment(pt, ann.p1, ann.vertex) < 8 ||
           distPointToSegment(pt, ann.vertex, ann.p3) < 8;
  }
  if (ann.type === "circle") {
    const d = Math.hypot(pt.x - ann.cx, pt.y - ann.cy);
    return Math.abs(d - ann.r) < 10 || d < 10;
  }
  if (ann.type === "calibration") {
    if (ann.x1 !== undefined) {
      return distPointToSegment(pt, { x: ann.x1, y: ann.y1 }, { x: ann.x2, y: ann.y2 }) < 8;
    } else {
      // Circle calibration: horizontal diameter line
      return distPointToSegment(pt, { x: ann.cx - ann.r, y: ann.cy }, { x: ann.cx + ann.r, y: ann.cy }) < 8;
    }
  }
  if (ann.type === "area") {
    // Check proximity to any edge
    const n = ann.points.length;
    for (let i = 0; i < n; i++) {
      if (distPointToSegment(pt, ann.points[i], ann.points[(i + 1) % n]) < 8) return true;
    }
    // Ray-casting point-in-polygon test
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ann.points[i].x, yi = ann.points[i].y;
      const xj = ann.points[j].x, yj = ann.points[j].y;
      if ((yi > pt.y) !== (yj > pt.y) &&
          pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }
  if (ann.type === "origin") {
    const angle = ann.angle ?? 0;
    const axisLen = 30;
    const xTip = { x: ann.x + Math.cos(angle) * axisLen, y: ann.y + Math.sin(angle) * axisLen };
    const yTip = { x: ann.x + Math.sin(angle) * axisLen, y: ann.y - Math.cos(angle) * axisLen };
    const orig = { x: ann.x, y: ann.y };
    return Math.hypot(pt.x - orig.x, pt.y - orig.y) < 10
      || distPointToSegment(pt, orig, xTip) < 6
      || distPointToSegment(pt, orig, yTip) < 6;
  }
  if (ann.type === "slot-dist") {
    const annA = state.annotations.find(a => a.id === ann.lineAId);
    const annB = state.annotations.find(a => a.id === ann.lineBId);
    if (!annA || !annB) return false;
    const epA = getLineEndpoints(annA);
    const epB = getLineEndpoints(annB);
    const midA = {
      x: (epA.a.x + epA.b.x) / 2,
      y: (epA.a.y + epA.b.y) / 2,
    };
    const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
    const lenSqB = dx_b * dx_b + dy_b * dy_b;
    if (lenSqB < 1e-10) return false;
    const t = ((midA.x - epB.a.x) * dx_b + (midA.y - epB.a.y) * dy_b) / lenSqB;
    const projA = { x: epB.a.x + t * dx_b, y: epB.a.y + t * dy_b };
    return distPointToSegment(pt, midA, projA) < 6;
  }
  if (ann.type === "intersect") {
    const annA = state.annotations.find(a => a.id === ann.lineAId);
    const annB = state.annotations.find(a => a.id === ann.lineBId);
    if (!annA || !annB) return false;
    const epA = getLineEndpoints(annA);
    const epB = getLineEndpoints(annB);
    const dA = lineAngleDeg(annA), dB = lineAngleDeg(annB);
    let diff = Math.abs(dA - dB) % 180;
    if (diff > 90) diff = 180 - diff;
    if (diff < 1) return false;
    const dx_a = epA.b.x - epA.a.x, dy_a = epA.b.y - epA.a.y;
    const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
    const denom = dx_a * dy_b - dy_a * dx_b;
    if (Math.abs(denom) < 1e-10) return false;
    const t = ((epB.a.x - epA.a.x) * dy_b - (epB.a.y - epA.a.y) * dx_b) / denom;
    const ix = epA.a.x + t * dx_a;
    const iy = epA.a.y + t * dy_a;
    const margin = Math.max(canvas.width, canvas.height);
    if (ix < -margin || ix > canvas.width + margin || iy < -margin || iy > canvas.height + margin) return false;
    return Math.hypot(pt.x - ix, pt.y - iy) < 8;
  }
  if (ann.type === "pt-circle-dist") {
    if (Math.hypot(pt.x - ann.px, pt.y - ann.py) < 8) return true;
    const circle = state.annotations.find(a => a.id === ann.circleId);
    if (!circle) return false;
    let cx, cy, r;
    if (circle.type === "circle") {
      cx = circle.cx; cy = circle.cy; r = circle.r;
    } else {
      const sx = canvas.width / circle.frameWidth;
      const sy = canvas.height / circle.frameHeight;
      cx = circle.x * sx; cy = circle.y * sy; r = circle.radius * sx;
    }
    const dist = Math.hypot(ann.px - cx, ann.py - cy);
    if (dist < 1e-6) return false;
    const edgePt = {
      x: cx + (ann.px - cx) / dist * r,
      y: cy + (ann.py - cy) / dist * r,
    };
    return distPointToSegment(pt, { x: ann.px, y: ann.py }, edgePt) < 6;
  }
  if (ann.type === "arc-measure") {
    const d = Math.hypot(pt.x - ann.cx, pt.y - ann.cy);
    // Hit on arc curve (within 8px of the radius)
    if (Math.abs(d - ann.r) < 8) {
      // Check angle is within arc span
      const a1 = Math.atan2(ann.p1.y - ann.cy, ann.p1.x - ann.cx);
      const a3 = Math.atan2(ann.p3.y - ann.cy, ann.p3.x - ann.cx);
      const ap = Math.atan2(pt.y - ann.cy, pt.x - ann.cx);
      // Use same winding logic as drawArcMeasure
      const twoPi = 2 * Math.PI;
      const norm_p = ((ap - a1) % twoPi + twoPi) % twoPi;
      const norm_3 = ((a3 - a1) % twoPi + twoPi) % twoPi;
      const ccw = !((((Math.atan2(ann.p2.y - ann.cy, ann.p2.x - ann.cx) - a1) % twoPi + twoPi) % twoPi) < norm_3);
      if (ccw ? norm_p >= (twoPi - norm_3) || norm_p === 0 : norm_p <= norm_3) return true;
    }
    // Also hit on center or control points
    if (d < 10) return true;
    if (Math.hypot(pt.x - ann.p1.x, pt.y - ann.p1.y) < 8) return true;
    if (Math.hypot(pt.x - ann.p2.x, pt.y - ann.p2.y) < 8) return true;
    if (Math.hypot(pt.x - ann.p3.x, pt.y - ann.p3.y) < 8) return true;
    return false;
  }
  if (ann.type === "detected-circle") {
    const sx = ann.frameWidth ? imageWidth / ann.frameWidth : 1;
    const sy = ann.frameHeight ? imageHeight / ann.frameHeight : 1;
    const cx = ann.x * sx, cy = ann.y * sy, r = ann.radius * sx;
    const d = Math.hypot(pt.x - cx, pt.y - cy);
    return Math.abs(d - r) < 10 || d < 10;
  }
  if (ann.type === "detected-line") {
    const sx = ann.frameWidth ? imageWidth / ann.frameWidth : 1;
    const sy = ann.frameHeight ? imageHeight / ann.frameHeight : 1;
    const x1 = ann.x1 * sx, y1 = ann.y1 * sy, x2 = ann.x2 * sx, y2 = ann.y2 * sy;
    return distPointToSegment(pt, { x: x1, y: y1 }, { x: x2, y: y2 }) < 8;
  }
  if (ann.type === "detected-line-merged") {
    const sx = ann.frameWidth ? imageWidth / ann.frameWidth : 1;
    const sy = ann.frameHeight ? imageHeight / ann.frameHeight : 1;
    const x1 = ann.x1 * sx, y1 = ann.y1 * sy, x2 = ann.x2 * sx, y2 = ann.y2 * sy;
    return distPointToSegment(pt, { x: x1, y: y1 }, { x: x2, y: y2 }) < 8;
  }
  if (ann.type === "detected-arc-partial") {
    const sx = ann.frameWidth ? imageWidth / ann.frameWidth : 1;
    const sy = ann.frameHeight ? imageHeight / ann.frameHeight : 1;
    const cx = ann.cx * sx, cy = ann.cy * sy, r = ann.r * sx;
    const dist = Math.hypot(pt.x - cx, pt.y - cy);
    if (Math.abs(dist - r) > 8) return false;
    let angle = Math.atan2(pt.y - cy, pt.x - cx) * 180 / Math.PI;
    let start = ann.start_deg, end = ann.end_deg;
    angle = ((angle % 360) + 360) % 360;
    start = ((start % 360) + 360) % 360;
    end = ((end % 360) + 360) % 360;
    if (start <= end) return angle >= start && angle <= end;
    return angle >= start || angle <= end;
  }
  return false;
}

// ── Circle snap ─────────────────────────────────────────────────────────────
// Returns the circle annotation whose edge is closest to pt, if within 20px.
// Handles both "circle" (canvas coords) and "detected-circle" (frame coords).
export function snapToCircle(pt) {
  let best = null, bestDist = 20;
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

  if (ann.type === "distance" || ann.type === "center-dist" ||
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
  else if (ann.type === "pt-circle-dist") {
    ann.px += dx; ann.py += dy;
  }

  renderSidebar();
  redraw();
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
