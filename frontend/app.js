// ── State ──────────────────────────────────────────────────────────────────
const state = {
  tool: "select",
  frozen: false,
  crosshair: false,
  calibration: null,   // { pixelsPerMm, displayUnit }
  annotations: [],     // [{type, ...data, id}]
  selected: null,      // annotation id
  pendingPoints: [],   // clicks accumulated for current tool
  pendingCenterCircle: null,
  pendingRefLine: null,   // reference line for perp-dist / para-dist
  pendingCircleRef: null, // reference circle for pt-circle-dist
  origin: null,           // { x, y } canvas-coord origin for coordinate readout
  dragState: null,     // { annotationId, handleKey, startX, startY }
  snapTarget: null,    // { x, y } canvas-coord of current snap target, or null
  mousePos: { x: 0, y: 0 },
  dxfAlignMode: false,
  dxfAlignStep: 0,
  dxfAlignPick: null,
  dxfAlignHover: null,
  showDeviations: false,
  tolerances: { warn: 0.10, fail: 0.25 },
  featureTolerances: {},   // { [dxfHandle]: { warn, fail } } — per-feature overrides
  nextId: 1,
  settings: {
    crosshairColor: "#ffffff",
    crosshairOpacity: 0.4,
    pixelFormat: "BayerRG8",
  },
};

const undoStack = [];
const redoStack = [];
const UNDO_LIMIT = 50;

let _noCamera = false;
let _deviationHitBoxes = [];   // populated each drawDeviations call; used for click hit-testing

function takeSnapshot() {
  return JSON.stringify({
    annotations: state.annotations,
    calibration: state.calibration,
    origin: state.origin,
  });
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(takeSnapshot());
  const snap = JSON.parse(undoStack.pop());
  state.annotations = snap.annotations;
  state.calibration = snap.calibration;
  state.origin = snap.origin;
  state.selected = state.annotations.find(a => a.id === state.selected?.id)?.id ?? null;
  renderSidebar(); redraw();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(takeSnapshot());
  const snap = JSON.parse(redoStack.pop());
  state.annotations = snap.annotations;
  state.calibration = snap.calibration;
  state.origin = snap.origin;
  state.selected = state.annotations.find(a => a.id === state.selected?.id)?.id ?? null;
  renderSidebar(); redraw();
}

function pushUndo() {
  if (undoStack.length >= UNDO_LIMIT) undoStack.shift();
  undoStack.push(takeSnapshot());
  redoStack.length = 0;
}

// ── TOOL_STATUS map and setTool helper ─────────────────────────────────────
const TOOL_STATUS = {
  "select":      "Select",
  "calibrate":   "Click — place two points or select a circle",
  "distance":    "Click — place point 1",
  "angle":       "Click — place point 1",
  "circle":      "Click — place point 1",
  "arc-fit":     "Click — place points (double-click to confirm)",
  "center-dist": "Click — select a circle",
  "detect":      "Click — detect features",
  "perp-dist":   "Click — select a reference line",
  "para-dist":   "Click — select a reference line",
  "area":        "Click — place points (double-click to confirm)",
  "pt-circle-dist": "Click — select a circle to measure from",
  "intersect":      "Click — select a reference line",
  "slot-dist":      "Click — select a reference line",
  "arc-measure":    "Click — place 3 points on arc (double-click or 3rd click to confirm)",
};

function setTool(name) {
  state.tool = name;
  state.pendingPoints = [];
  state.pendingCenterCircle = null;
  state.pendingRefLine = null;
  state.pendingCircleRef = null;
  state.snapTarget = null;
  document.querySelectorAll("#tool-strip .strip-btn[data-tool]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tool === name);
  });
  statusEl.textContent = TOOL_STATUS[name] ?? name;
  canvas.style.cursor = name === "select" ? "default" : "crosshair";
  redraw();
}

// ── DOM refs ───────────────────────────────────────────────────────────────
const img       = document.getElementById("stream-img");
const canvas    = document.getElementById("overlay-canvas");
const ctx       = canvas.getContext("2d");
const statusEl  = document.getElementById("status-text");
const listEl    = document.getElementById("measurement-list");
const cameraInfoEl = document.getElementById("camera-info");

// ── Canvas sizing ──────────────────────────────────────────────────────────
function resizeCanvas() {
  const r = img.getBoundingClientRect();
  const vr = img.parentElement.getBoundingClientRect();
  canvas.style.left   = (r.left - vr.left) + "px";
  canvas.style.top    = (r.top  - vr.top)  + "px";
  canvas.style.width  = r.width  + "px";
  canvas.style.height = r.height + "px";
  canvas.width  = Math.round(r.width);
  canvas.height = Math.round(r.height);
  redraw();
}

new ResizeObserver(resizeCanvas).observe(img);
img.addEventListener("load", resizeCanvas);
window.addEventListener("resize", resizeCanvas);

// ── Tool selection ─────────────────────────────────────────────────────────
// Tool buttons are now .strip-btn elements in #tool-strip (see Init section below)

// ── Canvas mouse events ────────────────────────────────────────────────────
canvas.addEventListener("mousedown", onMouseDown);
canvas.addEventListener("mouseup",   onMouseUp);

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onMouseDown(e) {
  const pt = canvasPoint(e);
  if (state.dxfAlignMode) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (!ann) { exitDxfAlignMode(); return; }

    if (state.dxfAlignStep === 0) {
      const target = state.dxfAlignHover;
      if (!target) return;
      state.dxfAlignPick = target;
      state.dxfAlignStep = 1;
      statusEl.textContent = "Click the image point to align to…";
    } else {
      const imagePt = e.altKey ? pt : snapPoint(pt, false).pt;
      pushUndo();
      ann.offsetX += imagePt.x - state.dxfAlignPick.canvas.x;
      ann.offsetY += imagePt.y - state.dxfAlignPick.canvas.y;
      exitDxfAlignMode();
      statusEl.textContent = "DXF aligned";
      redraw();
    }
    return;
  }
  if (_originMode) {
    pushUndo();
    // Remove any existing origin annotation
    state.annotations = state.annotations.filter(a => a.type !== "origin");
    state.origin = { x: pt.x, y: pt.y, angle: 0 };
    addAnnotation({ type: "origin", x: pt.x, y: pt.y, angle: 0 });
    _originMode = false;
    document.getElementById("btn-set-origin").classList.remove("active");
    return;
  }
  if (_dxfOriginMode) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (ann) { ann.offsetX = pt.x; ann.offsetY = pt.y; redraw(); }
    _dxfOriginMode = false;
    document.getElementById("btn-dxf-set-origin")?.classList.remove("active");
    statusEl.textContent = state.frozen ? "Frozen" : "Live";
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
  if (state.tool === "select") { handleSelectDown(pt, e); return; }
  handleToolClick(pt, e);
}

function onMouseUp() {
  if (state.dragState !== null) pushUndo();
  state.dragState = null;
}

// ─── Dropdown helpers ────────────────────────────────────────
function closeAllDropdowns() {
  ["dropdown-measure","dropdown-detect","dropdown-overlay"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  ["btn-menu-measure","btn-menu-detect","btn-menu-overlay"].forEach(id => {
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

// ── Keyboard ───────────────────────────────────────────────────────────────
document.addEventListener("keydown", e => {
  // Help dialog shortcut — works even when an input is focused
  if (e.key === "?") {
    const anyDialogOpen = document.querySelector(".dialog-overlay:not([hidden])") !== null;
    if (!anyDialogOpen) document.getElementById("help-dialog").hidden = false;
    return;
  }
  // All other shortcuts are blocked when an input/select/textarea/dialog is focused
  if (document.activeElement.closest("input, select, textarea") !== null || document.querySelector(".dialog-overlay:not([hidden])") !== null) return;

  if ((e.key === "Delete" || e.key === "Backspace") && state.selected !== null) {
    deleteAnnotation(state.selected);
    return;
  }
  if (e.key === "Escape") {
    closeAllDropdowns();
    if (state.dxfAlignMode) { exitDxfAlignMode(); redraw(); return; }
    state.pendingPoints = [];
    state.pendingCenterCircle = null;
    if (_dxfOriginMode) {
      _dxfOriginMode = false;
      document.getElementById("btn-dxf-set-origin")?.classList.remove("active");
      statusEl.textContent = state.frozen ? "Frozen" : "Live";
    }
    setTool("select");
    if (_originMode) {
      _originMode = false;
      document.getElementById("btn-set-origin").classList.remove("active");
    }
    return;
  }
  const ctrlOrMeta = e.ctrlKey || e.metaKey;
  if (ctrlOrMeta && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (ctrlOrMeta && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
  const toolKeys = { v: "select", c: "calibrate", d: "distance", a: "angle",
                     o: "circle", f: "arc-fit", m: "center-dist", e: "detect",
                     p: "perp-dist", l: "para-dist", r: "area",
                     g: "pt-circle-dist", i: "intersect", w: "slot-dist" };
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

canvas.addEventListener("dblclick", () => {
  if (state.tool !== "arc-fit" && state.tool !== "area") return;

  const points = state.pendingPoints.slice(0, -2);
  if (state.tool === "arc-fit") {
    if (points.length < 3) {
      alert("Need at least 3 points. Keep clicking to add more, then double-click to confirm.");
      return;
    }
    const result = fitCircleAlgebraic(points);
    if (!result) {
      alert("Could not fit a circle — points may be collinear or too close together.");
      state.pendingPoints = [];
      redraw();
      return;
    }
    addAnnotation({ type: "circle", cx: result.cx, cy: result.cy, r: result.r });
    // Async refinement: snap to nearest detected circle
    (async () => {
      const ann = state.annotations[state.annotations.length - 1];
      if (!ann) return;
      const frameWidth = state.frozenSize?.w ?? canvas.width;
      const scale = frameWidth / canvas.width;
      const r_frame = result.r * scale;
      try {
        const resp = await fetch("/detect-circles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dp: 1.2,
            min_dist: 50,
            param1: 100,
            param2: 30,
            min_radius: Math.floor(r_frame * 0.8),
            max_radius: Math.ceil(r_frame * 1.2)
          })
        });
        if (!resp.ok) return;
        const data = await resp.json();
        const circles = data.circles;
        if (!circles || circles.length === 0) return;
        const cx_frame = result.cx * scale;
        const cy_frame = result.cy * scale;
        let best = null;
        let bestDist = Infinity;
        for (const c of circles) {
          const d = Math.hypot(c.x - cx_frame, c.y - cy_frame);
          if (d < bestDist) { bestDist = d; best = c; }
        }
        if (!best || bestDist > r_frame) return;
        ann.cx = best.x / scale;
        ann.cy = best.y / scale;
        ann.r  = best.radius / scale;
        redraw();
        renderSidebar();
        statusEl.textContent = "Snapped to detected circle";
      } catch {
        // Network error or parse failure — leave annotation unchanged
      }
    })();
  } else {
    // area
    if (points.length < 3) {
      alert("Need at least 3 points to define an area.");
      return;
    }
    addAnnotation({ type: "area", points });
  }
  const newRow = listEl.querySelector(".measurement-item.selected");
  if (newRow) newRow.scrollIntoView({ block: "nearest" });
  setTool("select");
});

// Returns the angle of a line annotation in degrees (-180..180).
// Uses atan2(dy, dx) on the ep.a→ep.b vector.
function lineAngleDeg(ann) {
  const ep = getLineEndpoints(ann);
  return Math.atan2(ep.b.y - ep.a.y, ep.b.x - ep.a.x) * 180 / Math.PI;
}

// Returns the nearest line-like annotation whose body is within 10px of pt, or null.
function findSnapLine(pt) {
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
const SNAP_RADIUS = 8;

function snapPoint(rawPt, bypass = false) {
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
function handleToolClick(rawPt, e = {}) {
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
      statusEl.textContent = "Perp — click start point";
      redraw();
      return;
    }
    if (state.pendingPoints.length === 0) {
      // Step 2: place start point
      state.pendingPoints = [pt];
      statusEl.textContent = "Perp — click end point";
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
      statusEl.textContent = "Para — click a line to measure parallelism, or a free point to draw a parallel line";
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
      statusEl.textContent = "Para — click end point";
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
      statusEl.textContent = "Click a second circle";
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
        statusEl.textContent = "Click a circle first";
        return;
      }
      state.pendingCircleRef = { circleId: circle.id };
      statusEl.textContent = "Now click a point to measure from";
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
      statusEl.textContent = "Now click a second line";
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
      statusEl.textContent = "Now click a second line";
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

// ── Calibration input parser ───────────────────────────────────────────────
function parseDistanceInput(input) {
  // accepts "1.5 mm", "500 µm", "0.5mm", etc.
  const m = input.trim().match(/^([0-9.]+)\s*(mm|µm|um)?$/i);
  if (!m) { alert("Could not parse distance. Use format like '1.5 mm' or '500 µm'"); return null; }
  const value = parseFloat(m[1]);
  const unit = (m[2] || "mm").replace("um", "µm").toLowerCase();
  const mm = unit === "µm" ? value / 1000 : value;
  return { value, unit, mm };
}

// ── Circle fit (circumscribed circle through 3 points) ────────────────────
function fitCircle(p1, p2, p3) {
  const ax = p1.x, ay = p1.y;
  const bx = p2.x, by = p2.y;
  const cx = p3.x, cy = p3.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-10) throw new Error("collinear");
  const sqA = ax*ax + ay*ay, sqB = bx*bx + by*by, sqC = cx*cx + cy*cy;
  const ux = (sqA*(by-cy) + sqB*(cy-ay) + sqC*(ay-by)) / d;
  const uy = (sqA*(cx-bx) + sqB*(ax-cx) + sqC*(bx-ax)) / d;
  const r  = Math.hypot(ax - ux, ay - uy);
  return { cx: ux, cy: uy, r };
}

// ── Algebraic least-squares circle fit (N ≥ 3 points) ─────────────────────
// Minimises Σ(x²+y²+Dx+Ey+F)² — linear system solved by Cramer's rule.
// Returns {cx, cy, r} or null if the fit is degenerate.
function fitCircleAlgebraic(points) {
  if (points.length < 3) return null;
  const n = points.length;
  // Centre the input to improve numerical conditioning
  let mx = 0, my = 0;
  for (const {x, y} of points) { mx += x; my += y; }
  mx /= n; my /= n;
  let sx=0, sy=0, sx2=0, sy2=0, sxy=0, sx3=0, sy3=0, sx2y=0, sxy2=0;
  for (const {x: px, y: py} of points) {
    const x = px - mx, y = py - my;
    sx+=x; sy+=y; sx2+=x*x; sy2+=y*y; sxy+=x*y;
    sx3+=x*x*x; sy3+=y*y*y; sx2y+=x*x*y; sxy2+=x*y*y;
  }
  const M = [[sx2,sxy,sx],[sxy,sy2,sy],[sx,sy,n]];
  const b = [-(sx3+sxy2), -(sx2y+sy3), -(sx2+sy2)];
  function det3(m) {
    return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
          -m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
          +m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  }
  const d = det3(M);
  if (Math.abs(d) < 1e-6) return null;
  const sub = (col, bv) => M.map((row, i) => row.map((v, j) => j === col ? bv[i] : v));
  const D = det3(sub(0, b)) / d;
  const E = det3(sub(1, b)) / d;
  const F = det3(sub(2, b)) / d;
  // cx/cy are in centred space — translate back to canvas space
  const cx = -D / 2 + mx, cy = -E / 2 + my;
  // radius uses centred cx/cy for the calculation
  const cxc = -D / 2, cyc = -E / 2;
  const r = Math.sqrt(Math.max(0, cxc*cxc + cyc*cyc - F));
  if (!isFinite(r) || r <= 0) return null;
  // Collinear points produce a near-infinite radius — treat as degenerate
  if (r > 1e6) return null;
  return { cx, cy, r };
}

// Shoelace formula — returns polygon area in pixels²
function polygonArea(pts) {
  let s = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(s) / 2;
}

// ── Annotation management ──────────────────────────────────────────────────
function addAnnotation(data) {
  pushUndo();
  const ann = { ...data, id: state.nextId++, name: data.name ?? "" };
  state.annotations.push(ann);
  state.selected = ann.id;
  renderSidebar();
}

function deleteAnnotation(id) {
  pushUndo();
  const ann = state.annotations.find(a => a.id === id);
  if (!ann) return;
  if (ann.type === "calibration") { state.calibration = null; updateCalibrationButton(); }
  if (ann.type === "dxf-overlay") { const p = document.getElementById("dxf-panel"); if (p) p.style.display = "none"; }
  if (ann.type === "origin") {
    state.origin = null;
    const coordEl = document.getElementById("coord-display");
    if (coordEl) coordEl.textContent = "";
  }
  state.annotations = state.annotations.filter(a => a.id !== id);
  if (state.selected === id) state.selected = null;
  if (state.pendingCenterCircle && state.pendingCenterCircle.id === id) state.pendingCenterCircle = null;
  renderSidebar();
  redraw();
}

function applyCalibration(ann) {
  pushUndo();
  // Remove any existing calibration annotation
  state.annotations = state.annotations.filter(a => a.type !== "calibration");
  // Compute pixelsPerMm
  let pixelDist;
  if (ann.x1 !== undefined) {
    pixelDist = Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1);
  } else {
    pixelDist = ann.r * 2; // diameter
  }
  const knownMm = ann.unit === "µm" ? ann.knownValue / 1000 : ann.knownValue;
  state.calibration = { pixelsPerMm: pixelDist / knownMm, displayUnit: ann.unit };
  // Auto-update DXF scale if not manually overridden
  const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
  if (dxfAnn && !dxfAnn.scaleManual) {
    dxfAnn.scale = state.calibration.pixelsPerMm;
    const dxfScaleEl = document.getElementById("dxf-scale");
    if (dxfScaleEl) dxfScaleEl.value = dxfAnn.scale.toFixed(3);
  }
  addAnnotation(ann);
  updateCameraInfo(); // refresh the scale display in the sidebar
  updateCalibrationButton();
}

function measurementLabel(ann) {
  const cal = state.calibration;
  if (ann.type === "distance") {
    const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    if (!cal) return `${px.toFixed(1)} px`;
    const mm = px / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `${(mm * 1000).toFixed(2)} µm`
      : `${mm.toFixed(3)} mm`;
  }
  if (ann.type === "center-dist") {
    const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    if (!cal) return `${px.toFixed(1)} px`;
    const mm = px / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `${(mm * 1000).toFixed(2)} µm`
      : `${mm.toFixed(3)} mm`;
  }
  if (ann.type === "angle") {
    const v1 = { x: ann.p1.x - ann.vertex.x, y: ann.p1.y - ann.vertex.y };
    const v2 = { x: ann.p3.x - ann.vertex.x, y: ann.p3.y - ann.vertex.y };
    const dot = v1.x*v2.x + v1.y*v2.y;
    const mag = Math.hypot(v1.x,v1.y) * Math.hypot(v2.x,v2.y);
    const deg = mag < 1e-10 ? 0 : Math.acos(Math.max(-1,Math.min(1,dot/mag))) * 180/Math.PI;
    return `${deg.toFixed(2)}°`;
  }
  if (ann.type === "circle") {
    if (!cal) return `⌀ ${(ann.r * 2).toFixed(1)} px`;
    const mm = (ann.r * 2) / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `⌀ ${(mm * 1000).toFixed(2)} µm`
      : `⌀ ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "detected-circle") {
    const sx = canvas.width / ann.frameWidth;
    const r = ann.radius * sx;
    if (!cal) return `⌀ ${(r * 2).toFixed(1)} px`;
    const mm = (r * 2) / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `⌀ ${(mm * 1000).toFixed(2)} µm`
      : `⌀ ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "detected-line") {
    const sx = canvas.width / ann.frameWidth;
    const lenPx = ann.length * sx;
    if (!cal) return `${lenPx.toFixed(1)} px`;
    const mm = lenPx / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `${(mm * 1000).toFixed(2)} µm`
      : `${mm.toFixed(3)} mm`;
  }
  if (ann.type === "calibration") {
    const prefix = ann.x1 !== undefined ? "⟷" : "⌀";
    return `${prefix} ${ann.knownValue} ${ann.unit}`;
  }
  if (ann.type === "perp-dist") {
    const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    if (!cal) return `⊥ ${px.toFixed(1)} px`;
    const mm = px / cal.pixelsPerMm;
    return cal.displayUnit === "µm" ? `⊥ ${(mm * 1000).toFixed(2)} µm`
                                    : `⊥ ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "para-dist") {
    const px = Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y);
    if (!cal) return `∥ ${px.toFixed(1)} px`;
    const mm = px / cal.pixelsPerMm;
    return cal.displayUnit === "µm" ? `∥ ${(mm * 1000).toFixed(2)} µm`
                                    : `∥ ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "parallelism") {
    return `∥ ${ann.angleDeg.toFixed(2)}°`;
  }
  if (ann.type === "area") {
    const px2 = polygonArea(ann.points);
    if (!cal) return `□ ${px2.toFixed(1)} px²`;
    const mm2 = px2 / (cal.pixelsPerMm * cal.pixelsPerMm);
    return cal.displayUnit === "µm"
      ? `□ ${(mm2 * 1e6).toFixed(2)} µm²`
      : `□ ${mm2.toFixed(4)} mm²`;
  }
  if (ann.type === "origin") return "";
  if (ann.type === "pt-circle-dist") {
    const circle = state.annotations.find(a => a.id === ann.circleId);
    if (!circle) return "⊙ ref deleted";
    let cx, cy, r;
    if (circle.type === "circle") {
      cx = circle.cx; cy = circle.cy; r = circle.r;
    } else {
      const sx = canvas.width / circle.frameWidth;
      const sy = canvas.height / circle.frameHeight;
      cx = circle.x * sx; cy = circle.y * sy; r = circle.radius * sx;
    }
    const dist = Math.hypot(ann.px - cx, ann.py - cy);
    const gapPx = dist - r;
    const cal = state.calibration;
    if (!cal) return `⊙ ${gapPx.toFixed(1)} px`;
    const mm = gapPx / cal.pixelsPerMm;
    return cal.displayUnit === "µm"
      ? `⊙ ${(mm * 1000).toFixed(2)} µm`
      : `⊙ ${mm.toFixed(3)} mm`;
  }
  if (ann.type === "intersect") {
    const annA = state.annotations.find(a => a.id === ann.lineAId);
    const annB = state.annotations.find(a => a.id === ann.lineBId);
    if (!annA || !annB) return "⊕ ref deleted";
    const epA = getLineEndpoints(annA);
    const epB = getLineEndpoints(annB);
    const dA = lineAngleDeg(annA), dB = lineAngleDeg(annB);
    let diff = Math.abs(dA - dB) % 180;
    if (diff > 90) diff = 180 - diff;
    if (diff < 1) return "∥ no intersection";
    const dx_a = epA.b.x - epA.a.x, dy_a = epA.b.y - epA.a.y;
    const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
    const denom = dx_a * dy_b - dy_a * dx_b;
    if (Math.abs(denom) < 1e-10) return "∥ no intersection";
    const t = ((epB.a.x - epA.a.x) * dy_b - (epB.a.y - epA.a.y) * dx_b) / denom;
    const ix = epA.a.x + t * dx_a;
    const iy = epA.a.y + t * dy_a;
    const margin = Math.max(canvas.width, canvas.height);
    const offScreen = ix < -margin || ix > canvas.width + margin ||
                      iy < -margin || iy > canvas.height + margin;
    const cal = state.calibration;
    const org = state.origin;
    if (org) {
      const cosA = Math.cos(-(org.angle ?? 0)), sinA = Math.sin(-(org.angle ?? 0));
      const rx = ix - org.x, ry = iy - org.y;
      const ux = rx * cosA - ry * sinA;
      const uy = rx * sinA + ry * cosA;
      if (cal) {
        const xVal = ux / cal.pixelsPerMm;
        const yVal = uy / cal.pixelsPerMm;
        const unit = cal.displayUnit === "µm" ? "µm" : "mm";
        const scale = cal.displayUnit === "µm" ? 1000 : 1;
        const xStr = (xVal * scale).toFixed(cal.displayUnit === "µm" ? 2 : 3);
        const yStr = (yVal * scale).toFixed(cal.displayUnit === "µm" ? 2 : 3);
        return offScreen
          ? `⊕ off-screen  X: ${xStr} ${unit}  Y: ${yStr} ${unit}`
          : `⊕ X: ${xStr} ${unit}  Y: ${yStr} ${unit}`;
      }
      return offScreen
        ? `⊕ off-screen  X: ${ux.toFixed(1)} px  Y: ${uy.toFixed(1)} px`
        : `⊕ X: ${ux.toFixed(1)} px  Y: ${uy.toFixed(1)} px`;
    }
    return offScreen
      ? `⊕ off-screen  (${ix.toFixed(1)}, ${iy.toFixed(1)}) px`
      : `⊕ (${ix.toFixed(1)}, ${iy.toFixed(1)}) px`;
  }
  if (ann.type === "slot-dist") {
    const annA = state.annotations.find(a => a.id === ann.lineAId);
    const annB = state.annotations.find(a => a.id === ann.lineBId);
    if (!annA || !annB) return "⟺ ref deleted";
    const epA = getLineEndpoints(annA);
    const epB = getLineEndpoints(annB);
    const midA = {
      x: (epA.a.x + epA.b.x) / 2,
      y: (epA.a.y + epA.b.y) / 2,
    };
    const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
    const lenSqB = dx_b * dx_b + dy_b * dy_b;
    if (lenSqB < 1e-10) return "⟺ 0 px";
    const t = ((midA.x - epB.a.x) * dx_b + (midA.y - epB.a.y) * dy_b) / lenSqB;
    const projA = { x: epB.a.x + t * dx_b, y: epB.a.y + t * dy_b };
    const gapPx = Math.hypot(midA.x - projA.x, midA.y - projA.y);
    const dA = lineAngleDeg(annA), dB = lineAngleDeg(annB);
    let angleDiff = Math.abs(dA - dB) % 180;
    if (angleDiff > 90) angleDiff = 180 - angleDiff;
    const angSuffix = angleDiff > 2 ? ` (±${angleDiff.toFixed(1)}°)` : "";
    const cal = state.calibration;
    if (!cal) return `⟺ ${gapPx.toFixed(1)} px${angSuffix}`;
    const mm = gapPx / cal.pixelsPerMm;
    const valStr = cal.displayUnit === "µm"
      ? `${(mm * 1000).toFixed(2)} µm`
      : `${mm.toFixed(3)} mm`;
    return `⟺ ${valStr}${angSuffix}`;
  }
  return "";
}

// ── Sidebar render ─────────────────────────────────────────────────────────
function renderSidebar() {
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
      row.querySelector(".del-btn").addEventListener("click", e => {
        e.stopPropagation();
        deleteAnnotation(ann.id);
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
    row.querySelector(".del-btn").addEventListener("click", e => {
      e.stopPropagation();
      deleteAnnotation(ann.id);
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

// ── Tolerances config ──────────────────────────────────────────────────────
async function loadTolerances() {
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

// ── UI config & calibration button ────────────────────────────────────────
async function loadUiConfig() {
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

function updateCalibrationButton() {
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

// ── Camera info ────────────────────────────────────────────────────────────
async function loadCameraInfo() {
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

    if (d.no_camera === true && !_noCamera) {
      _noCamera = true;
      document.body.classList.add("no-camera");
      statusEl.textContent = "No camera — image only";
      updateDropOverlay();
    }
  } catch { cameraInfoEl.textContent = "Camera unavailable"; }
}

function updateDropOverlay() {
  const overlay = document.getElementById("drop-overlay");
  if (!overlay) return;
  overlay.classList.toggle("visible", _noCamera && !state.frozen);
}

function updateFreezeUI() {
  const btn        = document.getElementById("btn-freeze");
  const statusText = document.getElementById("status-text");
  if (state.frozen) {
    btn.textContent = "❄ Frozen";
    btn.classList.replace("freeze-live", "freeze-frozen");
    if (statusText) statusText.textContent = "● Frozen";
  } else {
    btn.textContent = "❄ Live";
    btn.classList.replace("freeze-frozen", "freeze-live");
    if (statusText) statusText.textContent = "● Live";
  }
  if (typeof updateDropOverlay === "function") updateDropOverlay();
}

// ── Startup warning ────────────────────────────────────────────────────────
async function checkStartupWarning() {
  try {
    const r = await fetch("/camera/startup-warning");
    const d = await r.json();
    if (d.warning) {
      const prev = { text: statusEl.textContent };
      statusEl.textContent = d.warning;
      setTimeout(() => {
        statusEl.textContent = prev.text;
      }, 8000);
    }
  } catch (_) {
    // Non-fatal: silently ignore network or parse errors
  }
}

async function loadCameraList() {
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

function updateCameraInfo() {
  const el = document.getElementById("scale-display");
  if (el) el.textContent = scaleText();
}

document.getElementById("exp-slider").addEventListener("input", async e => {
  const v = parseFloat(e.target.value);
  document.getElementById("exp-value").textContent = `${v} µs`;
  try {
    await fetch("/camera/exposure", { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify({value:v}) });
  } catch (err) {
    console.error("Failed to set exposure:", err);
  }
});

document.getElementById("gain-slider").addEventListener("input", async e => {
  const v = parseFloat(e.target.value);
  document.getElementById("gain-value").textContent = `${v} dB`;
  try {
    await fetch("/camera/gain", { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify({value:v}) });
  } catch (err) {
    console.error("Failed to set gain:", err);
  }
});

// ── Redraw ─────────────────────────────────────────────────────────────────
function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state.frozenBackground) {
    ctx.drawImage(state.frozenBackground, 0, 0, canvas.width, canvas.height);
  }
  drawAnnotations();
  drawPendingPoints();
  // Snap indicator
  if (state.snapTarget && state.tool !== "select") {
    ctx.save();
    ctx.beginPath();
    ctx.arc(state.snapTarget.x, state.snapTarget.y, 6, 0, Math.PI * 2);
    ctx.strokeStyle = "#60a5fa";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }
  // Arc-fit preview: show current best-fit circle while collecting points
  if (state.tool === "arc-fit" && state.pendingPoints.length >= 3) {
    const fit = fitCircleAlgebraic(state.pendingPoints);
    if (fit) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(fit.cx, fit.cy, fit.r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(251,146,60,0.6)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
  drawCrosshair();
  // DXF alignment mode indicators
  if (state.dxfAlignMode) {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (ann) {
      if (state.dxfAlignHover) {
        const p = state.dxfAlignHover.canvas;
        ctx.save();
        ctx.strokeStyle = "#facc15";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      if (state.dxfAlignStep === 1 && state.dxfAlignPick) {
        const p = state.dxfAlignPick.canvas;
        ctx.save();
        ctx.fillStyle = "#facc15";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
        if (state.mousePos) {
          ctx.strokeStyle = "rgba(250,204,21,0.6)";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(state.mousePos.x, state.mousePos.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.restore();
      }
    }
  }
}

function drawAnnotations() {
  state.annotations.forEach(ann => {
    const sel = ann.id === state.selected;
    const pendingHighlight = state.pendingCenterCircle && ann.id === state.pendingCenterCircle.id;
    if (ann.type === "distance")        drawDistance(ann, sel);
    else if (ann.type === "center-dist") drawDistance(ann, sel);
    else if (ann.type === "perp-dist")   drawPerpDist(ann, sel);
    else if (ann.type === "para-dist")   drawParaDist(ann, sel);
    else if (ann.type === "parallelism") drawParallelism(ann, sel);
    else if (ann.type === "area")        drawArea(ann, sel);
    else if (ann.type === "origin")      drawOrigin(ann, sel);
    else if (ann.type === "angle")      drawAngle(ann, sel);
    else if (ann.type === "circle")     drawCircle(ann, pendingHighlight || sel);
    else if (ann.type === "edges-overlay")    drawEdgesOverlay(ann);
    else if (ann.type === "preprocessed-overlay") drawPreprocessedOverlay(ann);
    else if (ann.type === "dxf-overlay")      { drawDxfOverlay(ann); if (state.showDeviations) drawDeviations(ann); }
    else if (ann.type === "detected-circle") drawDetectedCircle(ann, pendingHighlight || sel);
    else if (ann.type === "detected-line")   drawDetectedLine(ann, sel);
    else if (ann.type === "calibration") drawCalibration(ann, sel);
    else if (ann.type === "pt-circle-dist") drawPtCircleDist(ann, sel);
    else if (ann.type === "intersect")      drawIntersect(ann, sel);
    else if (ann.type === "slot-dist")      drawSlotDist(ann, sel);
    else if (ann.type === "arc-measure")    drawArcMeasure(ann, sel);
  });
}

function drawArcMeasure(ann, sel) {
  const a1 = Math.atan2(ann.p1.y - ann.cy, ann.p1.x - ann.cx);
  const a3 = Math.atan2(ann.p3.y - ann.cy, ann.p3.x - ann.cx);
  ctx.save();
  ctx.strokeStyle = sel ? "#e879f9" : "#bf5af2";  // lighter purple when selected
  ctx.lineWidth = sel ? 2 : 1.5;
  ctx.beginPath();
  ctx.arc(ann.cx, ann.cy, ann.r, a1, a3);
  ctx.stroke();
  // Draw center marker
  ctx.fillStyle = sel ? "#e879f9" : "#bf5af2";
  ctx.beginPath();
  ctx.arc(ann.cx, ann.cy, 3, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();
  drawLabel(measurementLabel(ann), ann.cx + 5, ann.cy - ann.r - 5);
}

function drawLine(a, b, color, width) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawHandle(pt, color) {
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawLabel(text, x, y) {
  ctx.font = "bold 12px ui-monospace, monospace";
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  const m = ctx.measureText(text);
  ctx.fillRect(x - 2, y - 13, m.width + 4, 16);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x, y);
}

function drawDistance(ann, sel) {
  drawLine(ann.a, ann.b, sel ? "#60a5fa" : "#facc15", sel ? 2 : 1.5);
  if (sel) { drawHandle(ann.a, "#60a5fa"); drawHandle(ann.b, "#60a5fa"); }
  const mx = (ann.a.x + ann.b.x) / 2, my = (ann.a.y + ann.b.y) / 2;
  drawLabel(measurementLabel(ann), mx + 5, my - 5);
}

function drawAngle(ann, sel) {
  drawLine(ann.p1, ann.vertex, sel ? "#60a5fa" : "#a78bfa", sel ? 2 : 1.5);
  drawLine(ann.vertex, ann.p3, sel ? "#60a5fa" : "#a78bfa", sel ? 2 : 1.5);
  if (sel) { [ann.p1, ann.vertex, ann.p3].forEach(p => drawHandle(p, "#60a5fa")); }
  drawLabel(measurementLabel(ann), ann.vertex.x + 8, ann.vertex.y - 8);
}

function drawCircle(ann, sel) {
  ctx.beginPath();
  ctx.arc(ann.cx, ann.cy, ann.r, 0, Math.PI * 2);
  ctx.strokeStyle = sel ? "#60a5fa" : "#34d399";
  ctx.lineWidth = sel ? 2 : 1.5;
  ctx.stroke();
  if (sel) {
    drawHandle({ x: ann.cx, y: ann.cy }, "#60a5fa");
    drawHandle({ x: ann.cx + ann.r, y: ann.cy }, "#60a5fa");
  }
  drawLabel(measurementLabel(ann), ann.cx + 5, ann.cy - ann.r - 5);
}

function drawEdgesOverlay(ann) {
  ctx.globalAlpha = 0.7;
  ctx.drawImage(ann.image, 0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1.0;
}

function drawPreprocessedOverlay(ann) {
  ctx.globalAlpha = 0.75;
  ctx.drawImage(ann.image, 0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1.0;
}

function drawDxfOverlay(ann) {
  const { entities, offsetX, offsetY, scale, flipH = false, flipV = false, angle: annAngle = 0 } = ann;
  const originAngle = state.origin?.angle ?? 0;

  ctx.save();
  ctx.strokeStyle = "#00d4ff";
  ctx.setLineDash([6, 3]);

  // Build transform — ctx calls are applied to coordinates in REVERSE call order.
  // Desired coordinate pipeline: rotate(annAngle in DXF Y-up) → flip → scale+Y-invert → rotate(originAngle) → translate
  // Since scale(s,-s) inverts Y, ctx.rotate(-annAngle) in that space equals rotate(+annAngle) in Y-up space.
  ctx.translate(offsetX, offsetY);
  if (originAngle) ctx.rotate(originAngle);
  ctx.scale(scale, -scale);   // DXF Y-up → canvas Y-down
  if (flipH) ctx.scale(-1, 1);
  if (flipV) ctx.scale(1, -1);
  if (annAngle) ctx.rotate(-annAngle * Math.PI / 180);  // rotate in DXF Y-up space
  ctx.lineWidth = 1 / scale;  // compensate so strokes stay 1px on screen

  for (const en of entities) {
    ctx.beginPath();
    if (en.type === "line") {
      ctx.moveTo(en.x1, en.y1);
      ctx.lineTo(en.x2, en.y2);
    } else if (en.type === "circle") {
      ctx.arc(en.cx, en.cy, en.radius, 0, Math.PI * 2);
    } else if (en.type === "arc") {
      const sr = en.start_angle * Math.PI / 180;
      const er = en.end_angle * Math.PI / 180;
      // DXF arcs are CCW. The base transform (scale(s,-s)) is LEFT-handed,
      // so anticlockwise=false renders CCW visually — correct for DXF.
      // Each additional reflection (flipH XOR flipV) flips handedness,
      // inverting winding. Compensate when exactly one flip is active.
      ctx.arc(en.cx, en.cy, en.radius, sr, er, flipH !== flipV);
    } else if (en.type === "polyline") {
      if (en.points.length < 2) continue;
      ctx.moveTo(en.points[0].x, en.points[0].y);
      for (let i = 1; i < en.points.length; i++) {
        ctx.lineTo(en.points[i].x, en.points[i].y);
      }
      if (en.closed) ctx.closePath();
    }
    ctx.stroke();
  }

  ctx.restore();
}

function dxfToCanvas(x, y, ann) {
  const { offsetX, offsetY, scale, flipH = false, flipV = false, angle: annAngle = 0 } = ann;
  const originAngle = state.origin?.angle ?? 0;

  // 1. Flip in DXF space (before rotation)
  const xf = flipH ? -x : x;
  const yf = flipV ? -y : y;

  // 2. Apply DXF overlay rotation in DXF space (Y-up)
  const cosA = Math.cos(annAngle * Math.PI / 180);
  const sinA = Math.sin(annAngle * Math.PI / 180);
  const xr = xf * cosA - yf * sinA;
  const yr = xf * sinA + yf * cosA;

  // 3. Scale + Y-flip (DXF Y-up → canvas Y-down)
  let cx = xr * scale;
  let cy = -yr * scale;

  // 4. Apply canvas/origin rotation (existing behaviour)
  if (originAngle) {
    const cos2 = Math.cos(originAngle), sin2 = Math.sin(originAngle);
    [cx, cy] = [cx * cos2 - cy * sin2, cx * sin2 + cy * cos2];
  }

  return { x: offsetX + cx, y: offsetY + cy };
}

function collectDxfSnapPoints(ann) {
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

function enterDxfAlignMode() {
  state.dxfAlignMode = true;
  state.dxfAlignStep = 0;
  state.dxfAlignPick = null;
  state.dxfAlignHover = null;
  if (_dxfOriginMode) {
    _dxfOriginMode = false;
    document.getElementById("btn-dxf-set-origin")?.classList.remove("active");
  }
  statusEl.textContent = "Click a DXF feature to anchor…";
}

function exitDxfAlignMode() {
  state.dxfAlignMode = false;
  state.dxfAlignStep = 0;
  state.dxfAlignPick = null;
  state.dxfAlignHover = null;
  statusEl.textContent = state.frozen ? "Frozen" : "Live";
}

function drawDetectedCircle(ann, sel) {
  const sx = canvas.width / ann.frameWidth;
  const sy = canvas.height / ann.frameHeight;
  const cx = ann.x * sx, cy = ann.y * sy, r = ann.radius * sx;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = sel ? "#60a5fa" : "#f472b6";
  ctx.lineWidth = sel ? 2 : 1.5;
  ctx.stroke();
  if (sel) drawHandle({ x: cx, y: cy }, "#60a5fa");
  drawLabel(measurementLabel(ann), cx + 5, cy - r - 5);
}

function drawDetectedLine(ann, sel) {
  const sx = canvas.width / ann.frameWidth;
  const sy = canvas.height / ann.frameHeight;
  const x1 = ann.x1 * sx, y1 = ann.y1 * sy;
  const x2 = ann.x2 * sx, y2 = ann.y2 * sy;
  ctx.beginPath();
  ctx.strokeStyle = sel ? "#60a5fa" : "#fb923c";
  ctx.lineWidth = sel ? 2 : 1.5;
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  if (sel) { drawHandle({ x: x1, y: y1 }, "#60a5fa"); drawHandle({ x: x2, y: y2 }, "#60a5fa"); }
  drawLabel(measurementLabel(ann), (x1 + x2) / 2 + 4, (y1 + y2) / 2 - 4);
}

function drawCalibration(ann, sel) {
  const color = sel ? "#60a5fa" : "#a78bfa";
  const tickLen = 6;
  if (ann.x1 !== undefined) {
    // Two-point: line with tick marks at each end
    drawLine({ x: ann.x1, y: ann.y1 }, { x: ann.x2, y: ann.y2 }, color, sel ? 2 : 1.5);
    // Tick marks perpendicular to the line
    const angle = Math.atan2(ann.y2 - ann.y1, ann.x2 - ann.x1) + Math.PI / 2;
    const tx = Math.cos(angle) * tickLen, ty = Math.sin(angle) * tickLen;
    drawLine({ x: ann.x1 - tx, y: ann.y1 - ty }, { x: ann.x1 + tx, y: ann.y1 + ty }, color, sel ? 2 : 1.5);
    drawLine({ x: ann.x2 - tx, y: ann.y2 - ty }, { x: ann.x2 + tx, y: ann.y2 + ty }, color, sel ? 2 : 1.5);
    if (sel) { drawHandle({ x: ann.x1, y: ann.y1 }, "#60a5fa"); drawHandle({ x: ann.x2, y: ann.y2 }, "#60a5fa"); }
    const mx = (ann.x1 + ann.x2) / 2, my = (ann.y1 + ann.y2) / 2;
    drawLabel(measurementLabel(ann), mx + 4, my - 8);
  } else {
    // Circle: horizontal diameter line through center
    const x1 = ann.cx - ann.r, x2 = ann.cx + ann.r;
    drawLine({ x: x1, y: ann.cy }, { x: x2, y: ann.cy }, color, sel ? 2 : 1.5);
    // Tick marks at each end
    drawLine({ x: x1, y: ann.cy - tickLen }, { x: x1, y: ann.cy + tickLen }, color, sel ? 2 : 1.5);
    drawLine({ x: x2, y: ann.cy - tickLen }, { x: x2, y: ann.cy + tickLen }, color, sel ? 2 : 1.5);
    if (sel) { drawHandle({ x: x1, y: ann.cy }, "#60a5fa"); drawHandle({ x: x2, y: ann.cy }, "#60a5fa"); }
    drawLabel(measurementLabel(ann), ann.cx + 4, ann.cy - ann.r - 8);
  }
}

function drawPerpDist(ann, sel) {
  drawDistance(ann, sel);
  // Right-angle indicator at ann.a, oriented along the perp-dist line direction
  const dx = ann.b.x - ann.a.x, dy = ann.b.y - ann.a.y;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    const ux = dx / len, uy = dy / len;   // unit along line
    const vx = -uy, vy = ux;              // perpendicular to line
    const s = 6;
    ctx.beginPath();
    ctx.moveTo(ann.a.x + ux * s, ann.a.y + uy * s);
    ctx.lineTo(ann.a.x + ux * s + vx * s, ann.a.y + uy * s + vy * s);
    ctx.lineTo(ann.a.x + vx * s, ann.a.y + vy * s);
    ctx.strokeStyle = sel ? "#60a5fa" : "#a78bfa";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawParaDist(ann, sel) {
  drawDistance(ann, sel);
  // Two parallel tick marks centered on the line body (4px apart)
  const mx = (ann.a.x + ann.b.x) / 2, my = (ann.a.y + ann.b.y) / 2;
  const dx = ann.b.x - ann.a.x, dy = ann.b.y - ann.a.y;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    const ux = dx / len, uy = dy / len;
    const vx = -uy * 5, vy = ux * 5; // perpendicular, 5px half-length
    [-2, 2].forEach(offset => {
      const cx = mx + ux * offset, cy = my + uy * offset;
      drawLine({ x: cx - vx, y: cy - vy }, { x: cx + vx, y: cy + vy },
               sel ? "#60a5fa" : "#a78bfa", 1.5);
    });
  }
}

function drawParallelism(ann, sel) {
  ctx.save();
  ctx.setLineDash([4, 4]);
  drawLine(ann.a, ann.b, sel ? "#60a5fa" : "#facc15", sel ? 2 : 1.5);
  ctx.setLineDash([]);
  ctx.restore();
  if (sel) { drawHandle(ann.a, "#60a5fa"); drawHandle(ann.b, "#60a5fa"); }
  const mx = (ann.a.x + ann.b.x) / 2, my = (ann.a.y + ann.b.y) / 2;
  drawLabel(measurementLabel(ann), mx + 5, my - 5);
}

function drawPtCircleDist(ann, sel) {
  const circle = state.annotations.find(a => a.id === ann.circleId);
  if (!circle) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(ann.px, ann.py, 6, 0, Math.PI * 2);
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.restore();
    return;
  }
  let cx, cy, r;
  if (circle.type === "circle") {
    cx = circle.cx; cy = circle.cy; r = circle.r;
  } else {
    const sx = canvas.width / circle.frameWidth;
    const sy = canvas.height / circle.frameHeight;
    cx = circle.x * sx; cy = circle.y * sy; r = circle.radius * sx;
  }
  const dist = Math.hypot(ann.px - cx, ann.py - cy);
  if (dist < 1e-6) return;
  const edgePt = {
    x: cx + (ann.px - cx) / dist * r,
    y: cy + (ann.py - cy) / dist * r,
  };
  const color = sel ? "#60a5fa" : "#facc15";
  drawLine({ x: ann.px, y: ann.py }, edgePt, color, sel ? 2 : 1.5);
  if (sel) drawHandle({ x: ann.px, y: ann.py }, "#60a5fa");
  const mx = (ann.px + edgePt.x) / 2;
  const my = (ann.py + edgePt.y) / 2;
  drawLabel(measurementLabel(ann), mx + 5, my - 5);
}

function drawIntersect(ann, sel) {
  const annA = state.annotations.find(a => a.id === ann.lineAId);
  const annB = state.annotations.find(a => a.id === ann.lineBId);
  if (!annA || !annB) return;

  const epA = getLineEndpoints(annA);
  const epB = getLineEndpoints(annB);

  const dA = lineAngleDeg(annA), dB = lineAngleDeg(annB);
  let diff = Math.abs(dA - dB) % 180;
  if (diff > 90) diff = 180 - diff;
  if (diff < 1) return;

  const dx_a = epA.b.x - epA.a.x, dy_a = epA.b.y - epA.a.y;
  const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
  const denom = dx_a * dy_b - dy_a * dx_b;
  if (Math.abs(denom) < 1e-10) return;

  const t = ((epB.a.x - epA.a.x) * dy_b - (epB.a.y - epA.a.y) * dx_b) / denom;
  const ix = epA.a.x + t * dx_a;
  const iy = epA.a.y + t * dy_a;

  const margin = Math.max(canvas.width, canvas.height);
  if (ix < -margin || ix > canvas.width + margin ||
      iy < -margin || iy > canvas.height + margin) return;

  const color = sel ? "#60a5fa" : "#f97316";
  const ARM = 8;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = sel ? 2 : 1.5;
  ctx.moveTo(ix - ARM, iy); ctx.lineTo(ix + ARM, iy);
  ctx.moveTo(ix, iy - ARM); ctx.lineTo(ix, iy + ARM);
  ctx.stroke();
  drawLabel(measurementLabel(ann), ix + ARM + 3, iy - ARM);
}

function drawSlotDist(ann, sel) {
  const annA = state.annotations.find(a => a.id === ann.lineAId);
  const annB = state.annotations.find(a => a.id === ann.lineBId);
  if (!annA || !annB) return;

  const epA = getLineEndpoints(annA);
  const epB = getLineEndpoints(annB);

  const midA = {
    x: (epA.a.x + epA.b.x) / 2,
    y: (epA.a.y + epA.b.y) / 2,
  };

  const dx_b = epB.b.x - epB.a.x, dy_b = epB.b.y - epB.a.y;
  const lenSqB = dx_b * dx_b + dy_b * dy_b;
  if (lenSqB < 1e-10) return;
  const t = ((midA.x - epB.a.x) * dx_b + (midA.y - epB.a.y) * dy_b) / lenSqB;
  const projA = { x: epB.a.x + t * dx_b, y: epB.a.y + t * dy_b };

  const color = sel ? "#60a5fa" : "#a78bfa";
  drawLine(midA, projA, color, sel ? 2 : 1.5);

  const mx = (midA.x + projA.x) / 2;
  const my = (midA.y + projA.y) / 2;
  drawLabel(measurementLabel(ann), mx + 5, my - 5);
}

function drawArea(ann, sel) {
  ctx.beginPath();
  ann.points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.fillStyle = sel ? "rgba(96,165,250,0.12)" : "rgba(251,146,60,0.12)";
  ctx.fill();
  ctx.strokeStyle = sel ? "#60a5fa" : "rgba(251,146,60,0.7)";
  ctx.lineWidth = sel ? 2 : 1.5;
  ctx.stroke();
  if (sel) ann.points.forEach(p => drawHandle(p, "#60a5fa"));
  const cx = ann.points.reduce((s, p) => s + p.x, 0) / ann.points.length;
  const cy = ann.points.reduce((s, p) => s + p.y, 0) / ann.points.length;
  drawLabel(measurementLabel(ann), cx + 4, cy);
}

function drawAreaPreview(pts, cursor) {
  if (pts.length === 0) return;
  const all = [...pts, cursor];
  ctx.beginPath();
  all.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.fillStyle = "rgba(251,146,60,0.08)";
  ctx.fill();
  ctx.strokeStyle = "rgba(251,146,60,0.4)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawOrigin(ann, sel) {
  const color = sel ? "#60a5fa" : "#facc15";
  const angle = ann.angle ?? 0;
  const axisLen = 30;
  // X-axis direction
  const xcos = Math.cos(angle), xsin = Math.sin(angle);
  // Y-axis direction: 90° CCW as seen on screen (canvas Y is down, so use (sin θ, -cos θ))
  const ycos = xsin, ysin = -xcos;

  // X axis arrow
  const xTip = { x: ann.x + xcos * axisLen, y: ann.y + xsin * axisLen };
  drawLine({ x: ann.x, y: ann.y }, xTip, color, 1.5);
  // Arrowhead on X
  const ax = xcos * 6, ay = xsin * 6;
  const bx = -xsin * 3, by = xcos * 3;
  ctx.beginPath();
  ctx.moveTo(xTip.x, xTip.y);
  ctx.lineTo(xTip.x - ax + bx, xTip.y - ay + by);
  ctx.lineTo(xTip.x - ax - bx, xTip.y - ay - by);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  // Y axis arrow
  const yTip = { x: ann.x + ycos * axisLen, y: ann.y + ysin * axisLen };
  drawLine({ x: ann.x, y: ann.y }, yTip, color, 1.5);
  // Arrowhead on Y
  const cx2 = ycos * 6, cy2 = ysin * 6;
  const dx2 = -ysin * 3, dy2 = ycos * 3;
  ctx.beginPath();
  ctx.moveTo(yTip.x, yTip.y);
  ctx.lineTo(yTip.x - cx2 + dx2, yTip.y - cy2 + dy2);
  ctx.lineTo(yTip.x - cx2 - dx2, yTip.y - cy2 - dy2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  // Small circle at origin
  ctx.beginPath();
  ctx.arc(ann.x, ann.y, 3, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Axis labels — wrapped in save/restore to prevent ctx.font and ctx.fillStyle leaking
  ctx.save();
  ctx.font = "bold 10px ui-monospace, monospace";
  ctx.fillStyle = color;
  ctx.fillText("X", xTip.x + xcos * 8, xTip.y + xsin * 8);
  ctx.fillText("Y", yTip.x + ycos * 8, yTip.y + ysin * 8);
  ctx.restore();

  // Axis handle dot (drag target for rotation) — outside save/restore intentionally
  drawHandle(xTip, sel ? "#60a5fa" : "#facc15");
}

function drawPendingPoints() {
  state.pendingPoints.forEach(pt => drawHandle(pt, "#fb923c"));
}

canvas.addEventListener("mousemove", e => {
  const pt = canvasPoint(e);
  const rawPt = pt;
  state.mousePos = pt;
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
  if (_originMode) {
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

function drawCrosshair() {
  if (!state.crosshair) return;
  const { crosshairOpacity } = state.settings;
  const rawColor = state.settings.crosshairColor;
  const safeColor = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : "#ffffff";
  const r = parseInt(safeColor.slice(1, 3), 16);
  const g = parseInt(safeColor.slice(3, 5), 16);
  const b = parseInt(safeColor.slice(5, 7), 16);
  const cx = canvas.width / 2, cy = canvas.height / 2;
  ctx.strokeStyle = `rgba(${r},${g},${b},${crosshairOpacity})`;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, canvas.height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(canvas.width, cy); ctx.stroke();
  ctx.setLineDash([]);
}

// ── Init ───────────────────────────────────────────────────────────────────
loadCameraInfo();
loadUiConfig();            // ← added
loadTolerances();          // ← added
updateCalibrationButton(); // ← added
document.querySelectorAll("#tool-strip .strip-btn[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
});
// Set initial active state
document.querySelectorAll("#tool-strip .strip-btn[data-tool]").forEach(btn => {
  btn.classList.toggle("active", btn.dataset.tool === state.tool);
});
const cameraSectionHeader = document.getElementById("camera-section-header");
const cameraSectionBody   = document.getElementById("camera-section-body");
if (cameraSectionHeader && cameraSectionBody) {
  cameraSectionHeader.addEventListener("click", () => {
    const isOpen = cameraSectionHeader.classList.toggle("open");
    cameraSectionBody.style.display = isOpen ? "" : "none";
  });
}
checkStartupWarning();
resizeCanvas();
updateFreezeUI(); // ← set initial freeze button state

// ── Dropdown menu wiring ────────────────────────────────────────────────────
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

// ── Overflow popup ──────────────────────────────────────────────────────────
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

// ── Close dropdowns on click-outside ───────────────────────────────────────
document.addEventListener("click", closeAllDropdowns);


function handleSelectDown(pt, e) {
  // First check drag handles of selected annotation
  if (state.selected !== null) {
    const ann = state.annotations.find(a => a.id === state.selected);
    if (ann) {
      const handle = hitTestHandle(ann, pt);
      if (handle) {
        state.dragState = { annotationId: ann.id, handleKey: handle, startX: pt.x, startY: pt.y };
        return;
      }
    }
  }
  // Then check if we clicked on any annotation body
  for (let i = state.annotations.length - 1; i >= 0; i--) {
    const ann = state.annotations[i];
    if (hitTestAnnotation(ann, pt)) {
      state.selected = ann.id;
      state.dragState = { annotationId: ann.id, handleKey: "body", startX: pt.x, startY: pt.y };
      renderSidebar();
      const selRow = listEl.querySelector(".measurement-item.selected");
      if (selRow) selRow.scrollIntoView({ block: "nearest" });
      redraw();
      return;
    }
  }
  // Clicked empty space — deselect
  state.selected = null;
  renderSidebar();
  redraw();
}

function hitTestHandle(ann, pt) {
  const RADIUS = 8;
  const handles = getHandles(ann);
  for (const [key, hp] of Object.entries(handles)) {
    if (Math.hypot(pt.x - hp.x, pt.y - hp.y) < RADIUS) return key;
  }
  return null;
}

function getHandles(ann) {
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
  if (ann.type === "pt-circle-dist") return { pt: { x: ann.px, y: ann.py } };
  if (ann.type === "intersect") return {};
  if (ann.type === "slot-dist") return {};
  return {};
}

function hitTestAnnotation(ann, pt) {
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
    return dist(pt, orig) < 10
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
  return false;
}

function distPointToSegment(pt, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx*dx + dy*dy;
  if (lenSq < 1e-10) return Math.hypot(pt.x - a.x, pt.y - a.y);
  const t = Math.max(0, Math.min(1, ((pt.x-a.x)*dx + (pt.y-a.y)*dy) / lenSq));
  return Math.hypot(pt.x - (a.x + t*dx), pt.y - (a.y + t*dy));
}

// ── Circle snap ─────────────────────────────────────────────────────────────
// Returns the circle annotation whose edge is closest to pt, if within 20px.
// Handles both "circle" (canvas coords) and "detected-circle" (frame coords).
function snapToCircle(pt) {
  let best = null, bestDist = 20;
  state.annotations.forEach(ann => {
    let cx, cy, r;
    if (ann.type === "circle") {
      cx = ann.cx; cy = ann.cy; r = ann.r;
    } else if (ann.type === "detected-circle") {
      const sx = canvas.width / ann.frameWidth;
      const sy = canvas.height / ann.frameHeight;
      cx = ann.x * sx; cy = ann.y * sy; r = ann.radius * sx;
    } else {
      return;
    }
    const edgeDist = Math.abs(Math.hypot(pt.x - cx, pt.y - cy) - r);
    if (edgeDist < bestDist) { bestDist = edgeDist; best = ann; }
  });
  return best;
}

// ── Line endpoint helper ─────────────────────────────────────────────────────
// Returns { a: {x,y}, b: {x,y} } in canvas coords for any line-like annotation.
function getLineEndpoints(ann) {
  if (ann.type === "distance" || ann.type === "perp-dist" ||
      ann.type === "para-dist" || ann.type === "parallelism") {
    return { a: ann.a, b: ann.b };
  }
  if (ann.type === "calibration" && ann.x1 !== undefined) {
    return { a: { x: ann.x1, y: ann.y1 }, b: { x: ann.x2, y: ann.y2 } };
  }
  if (ann.type === "detected-line") {
    const sx = canvas.width  / ann.frameWidth;
    const sy = canvas.height / ann.frameHeight;
    return { a: { x: ann.x1 * sx, y: ann.y1 * sy },
             b: { x: ann.x2 * sx, y: ann.y2 * sy } };
  }
  return null;
}

// Projects rawPt onto the ray from a in the direction perpendicular (perp=true)
// or parallel (perp=false) to refAnn. Returns the snapped endpoint { x, y }.
function projectConstrained(rawPt, a, refAnn, perp) {
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

function handleDrag(pt) {
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
  else if (ann.type === "pt-circle-dist") {
    ann.px += dx; ann.py += dy;
  }

  renderSidebar();
  redraw();
}

// ── Freeze / Live ──────────────────────────────────────────────────────────
state.frozenSize = null;

async function ensureFrozen() {
  if (!state.frozen) await doFreeze();
}

async function doFreeze() {
  const r = await fetch("/freeze", { method: "POST" });
  if (!r.ok) return;
  const { width, height } = await r.json();
  state.frozenSize = { w: width, h: height };

  // Fetch the frozen frame as a real JPEG — drawing the MJPEG stream <img>
  // element to a canvas is unreliable (blank result on most browsers).
  const frameBlob = await fetch("/frame").then(res => res.blob());
  const frameUrl = URL.createObjectURL(frameBlob);
  state.frozenBackground = await new Promise((resolve, reject) => {
    const bmpImg = new Image();
    bmpImg.onload = () => { URL.revokeObjectURL(frameUrl); resolve(bmpImg); };
    bmpImg.onerror = reject;
    bmpImg.src = frameUrl;
  });

  img.style.opacity = "0";   // hide stream
  state.frozen = true;
  updateFreezeUI();
  resizeCanvas();  // re-read img rect after opacity change to guarantee pixel-perfect alignment
}

document.getElementById("btn-freeze").addEventListener("click", async () => {
  if (state.frozen) {
    // Unfreeze
    img.style.opacity = "1";
    state.frozen = false;
    state.frozenBackground = null;
    updateFreezeUI();
    redraw();
  } else {
    await doFreeze();
  }
});

// ── Load image ─────────────────────────────────────────────────────────────
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
    statusEl.textContent = "Loaded image";
    redraw();
  };
  loadedImg.src = url;
  e.target.value = "";
});

// ── Drag-and-drop image load (no-camera mode) ────────────────────────────
const viewerEl = document.getElementById("viewer");
const dropOverlayEl = document.getElementById("drop-overlay");

viewerEl.addEventListener("dragover", e => {
  if (!_noCamera) return;
  e.preventDefault();
  dropOverlayEl.classList.add("drag-active");
});

viewerEl.addEventListener("dragleave", e => {
  if (!_noCamera) return;
  if (viewerEl.contains(e.relatedTarget)) return;
  dropOverlayEl.classList.remove("drag-active");
});

viewerEl.addEventListener("drop", async e => {
  if (!_noCamera) return;
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
    statusEl.textContent = "Loaded image";
    redraw();
  };
  loadedImg.src = url;
});


// ── Coordinate origin ────────────────────────────────────────────────────────
let _originMode = false;

document.getElementById("btn-set-origin").addEventListener("click", () => {
  _originMode = !_originMode;
  document.getElementById("btn-set-origin").classList.toggle("active", _originMode);
});

// ── DXF Overlay ─────────────────────────────────────────────────────────────
let _dxfOriginMode = false;

document.getElementById("btn-load-dxf").addEventListener("click", () => {
  document.getElementById("dxf-input").click();
});

document.getElementById("dxf-input").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append("file", file);
  try {
    const r = await fetch("/load-dxf", { method: "POST", body: formData });
    if (!r.ok) { alert("Could not load DXF: " + await r.text()); e.target.value = ""; return; }
    const entities = await r.json();
    // Default scale: use calibration (px/mm) if available, otherwise 1 px/unit
    const cal = state.calibration;
    const autoScale = cal?.pixelsPerMm;
    const scale = autoScale ?? 1;
    const dxfScaleInput = document.getElementById("dxf-scale");
    if (dxfScaleInput) dxfScaleInput.value = scale.toFixed(3);
    state.annotations = state.annotations.filter(a => a.type !== "dxf-overlay");
    addAnnotation({
      type: "dxf-overlay",
      entities,
      offsetX: canvas.width / 2,
      offsetY: canvas.height / 2,
      scale,
      angle: 0,
      scaleManual: false,
      flipH: false,
      flipV: false,
    });
    const dxfPanelEl = document.getElementById("dxf-panel");
    if (dxfPanelEl) dxfPanelEl.style.display = "";
    enterDxfAlignMode();
    updateDxfControlsVisibility();
    redraw();
    e.target.value = "";
  } catch (err) {
    alert("Could not load DXF: " + err.message);
    e.target.value = "";
  }
});

document.getElementById("dxf-scale")?.addEventListener("input", e => {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (!ann) return;
  const v = parseFloat(e.target.value);
  if (isFinite(v) && v > 0) {
    ann.scale = v;
    ann.scaleManual = true;
    redraw();
  }
});

document.getElementById("btn-dxf-set-origin")?.addEventListener("click", () => {
  _dxfOriginMode = true;
  document.getElementById("btn-dxf-set-origin")?.classList.add("active");
  statusEl.textContent = "Click canvas to place DXF origin";
});

document.getElementById("btn-dxf-realign")?.addEventListener("click", enterDxfAlignMode);

document.getElementById("btn-dxf-clear")?.addEventListener("click", () => {
  state.annotations = state.annotations.filter(a => a.type !== "dxf-overlay");
  const dxfPanelEl2 = document.getElementById("dxf-panel");
  if (dxfPanelEl2) dxfPanelEl2.style.display = "none";
  updateDxfControlsVisibility();
  redraw();
});

["flip-h", "flip-v"].forEach(id => {
  document.getElementById(`btn-dxf-${id}`)?.addEventListener("click", () => {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (!ann) return;
    pushUndo();
    const key = id === "flip-h" ? "flipH" : "flipV";
    ann[key] = !ann[key];
    document.getElementById(`btn-dxf-${id}`)?.classList.toggle("active", ann[key]);
    updateDxfControlsVisibility();
    redraw();
  });
});

function updateDxfControlsVisibility() {
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
}

function getDetectedCirclesForAlignment() {
  return state.annotations
    .filter(a => a.type === "detected-circle")
    .map(a => ({
      x: a.x * (canvas.width / a.frameWidth),
      y: a.y * (canvas.height / a.frameHeight),
      radius: a.radius * (canvas.width / a.frameWidth),
    }));
}

function deviationColor(delta_mm, handle = null) {
  const tol = (handle && state.featureTolerances[handle]) || state.tolerances;
  if (delta_mm <= tol.warn) return "#30d158";   // green
  if (delta_mm <= tol.fail) return "#ff9f0a";   // amber
  return "#ff453a";                              // red
}

function matchDxfToDetected(ann) {
  const cal = state.calibration;
  if (!cal?.pixelsPerMm) return [];
  const ppm = cal.pixelsPerMm;

  const detected = state.annotations
    .filter(a => a.type === "detected-circle")
    .map(a => ({
      cx: a.x * (canvas.width / a.frameWidth),
      cy: a.y * (canvas.height / a.frameHeight),
      r:  a.radius * (canvas.width / a.frameWidth),
    }));

  return ann.entities
    .filter(e => e.type === "circle")
    .map(e => {
      const nominal = dxfToCanvas(e.cx, e.cy, ann);
      const r_px = e.radius * ann.scale;
      const threshold = Math.max(10, 0.5 * r_px);
      let best = null, bestDist = Infinity;
      for (const d of detected) {
        const dist = Math.hypot(d.cx - nominal.x, d.cy - nominal.y);
        if (dist < threshold && dist < bestDist) {
          bestDist = dist;
          best = d;
        }
      }
      if (!best) return { nominal, r_px, matched: false, handle: e.handle ?? null };
      const delta_xy_mm = bestDist / ppm;
      const delta_r_mm  = Math.abs(best.r - r_px) / ppm;
      return {
        nominal, r_px,
        detected: best,
        matched: true,
        delta_xy_mm,
        delta_r_mm,
        color: deviationColor(Math.max(delta_xy_mm, delta_r_mm), e.handle ?? null),
        handle: e.handle ?? null,
      };
    });
}

function drawDeviations(ann) {
  _deviationHitBoxes = [];
  const matches = matchDxfToDetected(ann);
  for (const m of matches) {
    if (!m.matched) {
      // Unmatched: muted dashed circle + crosshair at nominal
      ctx.save();
      ctx.strokeStyle = "#636366";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(m.nominal.x, m.nominal.y, m.r_px, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(m.nominal.x - 5, m.nominal.y); ctx.lineTo(m.nominal.x + 5, m.nominal.y);
      ctx.moveTo(m.nominal.x, m.nominal.y - 5); ctx.lineTo(m.nominal.x, m.nominal.y + 5);
      ctx.stroke();
      ctx.fillStyle = "#636366";
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText("not detected", m.nominal.x + m.r_px + 4, m.nominal.y);
      ctx.restore();
    } else {
      const { nominal, r_px, detected: det, delta_xy_mm, delta_r_mm, color } = m;
      ctx.save();
      // Nominal circle (dashed blue)
      ctx.strokeStyle = "#0a84ff";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.arc(nominal.x, nominal.y, r_px, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(nominal.x - 5, nominal.y); ctx.lineTo(nominal.x + 5, nominal.y);
      ctx.moveTo(nominal.x, nominal.y - 5); ctx.lineTo(nominal.x, nominal.y + 5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // Detected circle (solid, colour-coded)
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(det.cx, det.cy, det.r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(det.cx, det.cy, 2.5, 0, Math.PI * 2); ctx.fill();
      // Labels
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillStyle = color;
      const labelX = det.cx + det.r + 4;
      const labelText = `\u0394 ${delta_xy_mm.toFixed(3)} mm`;
      ctx.fillText(labelText, labelX, det.cy);
      const textW = ctx.measureText(labelText).width;
      _deviationHitBoxes.push({ handle: m.handle, x: labelX, y: det.cy - 10, w: textW, h: 14 });
      const tol = (m.handle && state.featureTolerances[m.handle]) || state.tolerances;
      if (delta_r_mm > tol.warn) {
        ctx.fillText(`Δr ${delta_r_mm.toFixed(3)} mm`, labelX, det.cy + 13);
      }
      ctx.restore();
    }
  }
}

document.getElementById("btn-auto-align")?.addEventListener("click", async () => {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (!ann) return;

  const statusEl2 = document.getElementById("align-status");
  function setStatus(msg, isError = false) {
    if (!statusEl2) return;
    statusEl2.textContent = msg;
    statusEl2.style.color = isError ? "var(--danger)" : "var(--text-secondary)";
    statusEl2.hidden = !msg;
  }

  // Ensure we have detected circles
  let circles = getDetectedCirclesForAlignment();
  if (circles.length === 0) {
    // Auto-freeze and detect
    if (!state.frozen) {
      await fetch("/freeze", { method: "POST" });
      state.frozen = true;
      updateFreezeUI();
    }
    setStatus("Running circle detection…");
    const r = await fetch("/detect-circles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ min_radius: 8, max_radius: 500 }),
    });
    if (!r.ok) { setStatus("Detection failed", true); return; }
    const detected = await r.json();
    if (detected.length === 0) {
      setStatus("No circles detected — run detection manually first", true);
      return;
    }
    // Store detected circles as annotations
    const info = await fetch("/camera/info").then(r => r.json());
    pushUndo();
    state.annotations = state.annotations.filter(a => a.type !== "detected-circle");
    detected.forEach(c => addAnnotation({
      type: "detected-circle", x: c.x, y: c.y, radius: c.radius,
      frameWidth: info.width, frameHeight: info.height,
    }));
    circles = getDetectedCirclesForAlignment();
    redraw();
  }

  const cal = state.calibration;
  if (!cal?.pixelsPerMm) { setStatus("Calibration required for alignment", true); return; }

  setStatus("Aligning…");
  try {
    const r = await fetch("/align-dxf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entities: ann.entities,
        circles,
        pixels_per_mm: cal.pixelsPerMm,
      }),
    });
    if (!r.ok) {
      const err = await r.json();
      setStatus(err.detail ?? "Alignment failed", true);
      return;
    }
    const result = await r.json();
    pushUndo();
    ann.offsetX = result.tx;
    ann.offsetY = result.ty;
    ann.angle = result.angle_deg;
    ann.flipH = result.flip_h;
    ann.flipV = result.flip_v;
    updateDxfControlsVisibility();

    // Auto-show deviation callouts now that alignment is complete
    state.showDeviations = true;
    const devBtn = document.getElementById("btn-show-deviations");
    if (devBtn) {
      devBtn.removeAttribute("disabled");
      devBtn.textContent = "Deviations: on";
    }

    if (result.confidence === "high") {
      setStatus(`Aligned — ${result.inlier_count}/${result.total_dxf_circles} features matched`);
    } else if (result.confidence === "low") {
      setStatus(`⚠ Low confidence — only ${result.inlier_count}/${result.total_dxf_circles} matched`, true);
    } else {
      setStatus("⚠ Alignment failed — result unreliable", true);
    }
    redraw();
  } catch (err) {
    setStatus("Network error: " + err.message, true);
  }
});

[-5, -1, 1, 5].forEach(delta => {
  const id = `btn-dxf-rot-${delta < 0 ? "m" : "p"}${Math.abs(delta)}`;
  document.getElementById(id)?.addEventListener("click", () => {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (!ann) return;
    pushUndo();
    ann.angle = ((ann.angle ?? 0) + delta + 360) % 360;
    updateDxfControlsVisibility();
    redraw();
  });
});

document.getElementById("dxf-scale")?.addEventListener("change", () => {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  if (!ann) return;
  const val = parseFloat(document.getElementById("dxf-scale").value);
  if (!isFinite(val) || val <= 0) return;
  pushUndo();
  ann.scale = val;
  redraw();
});

document.getElementById("btn-show-deviations")?.addEventListener("click", () => {
  state.showDeviations = !state.showDeviations;
  document.getElementById("btn-show-deviations").textContent =
    state.showDeviations ? "Deviations: on" : "Deviations: off";
  redraw();
});

// ── Per-feature tolerance popover ──────────────────────────────────────────
let _ftolActiveHandle = null;

function openFeatureTolPopover(handle, screenX, screenY) {
  _ftolActiveHandle = handle;
  const tol = state.featureTolerances[handle] || state.tolerances;
  document.getElementById("ftol-warn").value = tol.warn;
  document.getElementById("ftol-fail").value = tol.fail;
  const pop = document.getElementById("feature-tol-popover");
  pop.style.display = "block";
  pop.style.left = `${screenX + 8}px`;
  pop.style.top  = `${screenY - 20}px`;
}

function closeFeatureTolPopover() {
  document.getElementById("feature-tol-popover").style.display = "none";
  _ftolActiveHandle = null;
}

document.getElementById("ftol-set")?.addEventListener("click", () => {
  if (!_ftolActiveHandle) return;
  const warn = parseFloat(document.getElementById("ftol-warn").value);
  const fail = parseFloat(document.getElementById("ftol-fail").value);
  if (!isFinite(warn) || !isFinite(fail) || warn <= 0 || fail <= 0 || warn >= fail) {
    alert("warn must be a positive number less than fail");
    return;
  }
  state.featureTolerances[_ftolActiveHandle] = { warn, fail };
  closeFeatureTolPopover();
  redraw();
});

document.getElementById("ftol-reset")?.addEventListener("click", () => {
  if (!_ftolActiveHandle) return;
  delete state.featureTolerances[_ftolActiveHandle];
  closeFeatureTolPopover();
  redraw();
});

document.getElementById("ftol-close")?.addEventListener("click", closeFeatureTolPopover);

// ── Annotated export ───────────────────────────────────────────────────────
document.getElementById("btn-export").addEventListener("click", () => {
  let sourceCanvas;
  if (state.frozen) {
    // canvas already has frozen background + annotations painted on it
    sourceCanvas = canvas;
  } else {
    // live mode: composite the stream img under the annotation overlay
    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = canvas.width;
    sourceCanvas.height = canvas.height;
    const sctx = sourceCanvas.getContext("2d");
    sctx.drawImage(img, 0, 0, sourceCanvas.width, sourceCanvas.height);
    sctx.drawImage(canvas, 0, 0);
  }
  sourceCanvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `microscope_${new Date().toISOString().replace(/[:.]/g,"-")}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
});

// ── CSV value helper ────────────────────────────────────────────────────────
function formatCsvValue(ann) {
  const cal = state.calibration;

  function distResult(px) {
    if (!cal) return { value: px.toFixed(1), unit: "px" };
    const mm = px / cal.pixelsPerMm;
    if (cal.displayUnit === "µm") return { value: (mm * 1000).toFixed(1), unit: "µm" };
    return { value: mm.toFixed(3), unit: "mm" };
  }

  function areaResult(px2) {
    if (!cal) return { value: px2.toFixed(1), unit: "px²" };
    const mm2 = px2 / (cal.pixelsPerMm * cal.pixelsPerMm);
    if (cal.displayUnit === "µm") return { value: (mm2 * 1e6).toFixed(1), unit: "µm²" };
    return { value: mm2.toFixed(4), unit: "mm²" };
  }

  if (ann.type === "distance" || ann.type === "perp-dist" || ann.type === "para-dist") {
    return distResult(Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y));
  }
  if (ann.type === "center-dist") {
    return distResult(Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y));
  }
  if (ann.type === "angle") {
    const v1 = { x: ann.p1.x - ann.vertex.x, y: ann.p1.y - ann.vertex.y };
    const v2 = { x: ann.p3.x - ann.vertex.x, y: ann.p3.y - ann.vertex.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
    const deg = mag < 1e-10 ? 0 : Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI;
    return { value: deg.toFixed(2), unit: "°" };
  }
  if (ann.type === "circle") {
    return distResult(ann.r * 2);
  }
  if (ann.type === "arc-fit") {
    return distResult(ann.r * 2);
  }
  if (ann.type === "arc-measure") {
    const ppm = cal ? cal.pixelsPerMm : 1;
    const r_mm = ann.r / ppm;
    const chord_mm = ann.chord_px / ppm;
    const cx_mm = ann.cx / ppm;
    const cy_mm = ann.cy / ppm;
    const rStr = cal
      ? (cal.displayUnit === "µm" ? `${(r_mm * 1000).toFixed(2)} µm` : `${r_mm.toFixed(3)} mm`)
      : `${ann.r.toFixed(1)} px`;
    const chordStr = cal
      ? (cal.displayUnit === "µm" ? `${(chord_mm * 1000).toFixed(2)} µm` : `${chord_mm.toFixed(3)} mm`)
      : `${ann.chord_px.toFixed(1)} px`;
    const centerStr = cal
      ? `(${cx_mm.toFixed(3)}, ${cy_mm.toFixed(3)}) mm`
      : `(${ann.cx.toFixed(1)}, ${ann.cy.toFixed(1)}) px`;
    return `center=${centerStr}  r=${rStr}  span ${ann.span_deg.toFixed(1)}°  chord=${chordStr}`;
  }
  if (ann.type === "detected-circle") {
    const sx = canvas.width / ann.frameWidth;
    return distResult((ann.radius * sx) * 2);
  }
  if (ann.type === "area") {
    return areaResult(polygonArea(ann.points));
  }
  if (ann.type === "parallelism") {
    return { value: ann.angleDeg.toFixed(2), unit: "°" };
  }
  if (ann.type === "calibration") {
    let px;
    if (ann.x1 !== undefined) {
      px = Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1);
    } else {
      px = ann.r * 2;
    }
    return distResult(px);
  }
  return { value: "", unit: "" };
}

// ── CSV export ──────────────────────────────────────────────────────────────
document.getElementById("btn-export-csv").addEventListener("click", () => {
  const rows = [["#", "Name", "Value", "Unit", "type", "label"]];
  let i = 1;
  state.annotations.forEach(ann => {
    const label = measurementLabel(ann);
    if (!label) return;  // skip origin / overlays
    const { value, unit } = formatCsvValue(ann);
    rows.push([i++, ann.name || "", value, unit, ann.type, label]);
  });
  const csv = rows
    .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `measurements_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Session save ────────────────────────────────────────────────────────────
const TRANSIENT_TYPES = new Set([
  "edges-overlay", "preprocessed-overlay", "dxf-overlay",
  "detected-circle", "detected-line",
]);

function saveSession() {
  const session = {
    version: 1,
    savedAt: new Date().toISOString(),
    nextId: state.nextId,
    calibration: state.calibration ? { ...state.calibration } : null,
    origin: state.origin ? { ...state.origin } : null,
    featureTolerances: { ...state.featureTolerances },
    annotations: state.annotations
      .filter(a => !TRANSIENT_TYPES.has(a.type))
      .map(a => ({ ...a })),
  };
  const json = JSON.stringify(session, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ts = new Date().toISOString().slice(0, 19).replace(/-/g, "").replace("T", "-").replace(/:/g, "");
  a.download = `microscope-session-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById("btn-save-session").addEventListener("click", saveSession);

// ── Session load ────────────────────────────────────────────────────────────
function loadSession(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    showStatus("Cannot load: invalid file");
    return;
  }

  // Version check
  if (!data.version) {
    showStatus("Loaded legacy session (no version field)");
    // fall through and attempt to treat as v1
  } else if (data.version === 1) {
    // proceed
  } else {
    showStatus(`Cannot load: session format version ${data.version} is newer than this app supports`);
    return;
  }

  // Format validation
  if (!Array.isArray(data.annotations)) {
    showStatus("Cannot load: invalid file");
    return;
  }
  if (data.calibration !== null && data.calibration !== undefined) {
    const cal = data.calibration;
    if (typeof cal.pixelsPerMm !== "number" || !isFinite(cal.pixelsPerMm) || cal.pixelsPerMm <= 0) {
      showStatus("Cannot load: invalid file");
      return;
    }
    if (cal.displayUnit !== "mm" && cal.displayUnit !== "µm") {
      showStatus("Cannot load: invalid file");
      return;
    }
  }

  // Confirm overwrite if non-transient annotations exist
  const hasExisting = state.annotations.some(a => !TRANSIENT_TYPES.has(a.type));
  if (hasExisting) {
    if (!confirm("Replace current session? This cannot be undone.")) return;
  }

  // Preserve existing DXF overlay (if any)
  const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");

  // Restore state
  state.annotations = data.annotations.slice();
  if (dxfAnn) state.annotations.push(dxfAnn);

  state.calibration = data.calibration ?? null;
  state.origin = data.origin ?? null;
  state.featureTolerances = (data.featureTolerances && typeof data.featureTolerances === "object")
    ? { ...data.featureTolerances }
    : {};

  // Sync origin annotation's angle from state.origin (state.origin is authoritative)
  if (state.origin) {
    const originAnn = state.annotations.find(a => a.type === "origin");
    if (originAnn) originAnn.angle = state.origin.angle ?? 0;
  }

  if (data.nextId !== undefined && data.nextId !== null) {
    state.nextId = data.nextId;
  } else {
    const maxId = data.annotations.reduce((m, a) => Math.max(m, a.id ?? 0), 0);
    state.nextId = maxId + 1;
  }

  state.selected = null;

  const coordEl = document.getElementById("coord-display");
  if (coordEl) coordEl.textContent = "";

  // Show status only when no legacy warning was already set
  if (data.version === 1) showStatus("Session loaded");

  renderSidebar();
  redraw();
}

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

// ── Clear all annotations ──────────────────────────────────────────────────
document.getElementById("btn-clear")?.addEventListener("click", () => {
  if (confirm("Clear all annotations?")) {
    state.annotations = state.annotations.filter(a => a.type === "dxf-overlay");
    state.featureTolerances = {};
    state.selected = null;
    state.calibration = null; // calibration annotation was filtered out above
    updateCalibrationButton();
    state.pendingPoints = [];
    state.pendingCenterCircle = null;
    state.pendingRefLine = null;
    state.origin = null;
    // DXF panel: keep visible (DXF overlay is preserved). Do NOT hide it.
    if (_dxfOriginMode) {
      _dxfOriginMode = false;
      document.getElementById("btn-dxf-set-origin")?.classList.remove("active");
      statusEl.textContent = state.frozen ? "Frozen" : "Live";
    }
    if (_originMode) {
      _originMode = false;
      document.getElementById("btn-set-origin").classList.remove("active");
    }
    const coordEl = document.getElementById("coord-display");
    if (coordEl) coordEl.textContent = "";
    renderSidebar();
    redraw();
  }
});

// ── Detect tool ────────────────────────────────────────────────────────────
document.querySelector('[data-tool="detect"]')?.addEventListener("click", () => {
  document.getElementById("dropdown-detect").style.display = "block";
});

// No .tool-btn elements in the new UI; dropdown-detect is closed by closeAllDropdowns()

["canny-low","canny-high","hough-p2","circle-min-r","circle-max-r","line-sensitivity","line-min-length"].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener("input", () => {
    document.getElementById(id + "-val").textContent = el.value;
  });
});

document.getElementById("btn-run-edges").addEventListener("click", async () => {
  await ensureFrozen();
  const t1 = parseInt(document.getElementById("canny-low").value);
  const t2 = parseInt(document.getElementById("canny-high").value);
  const r = await fetch("/detect-edges", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ threshold1: t1, threshold2: t2 }),
  });
  if (!r.ok) { alert(await r.text()); return; }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const edgeImg = new Image();
  edgeImg.onload = () => {
    URL.revokeObjectURL(url);
    state.annotations = state.annotations.filter(a => a.type !== "edges-overlay");
    addAnnotation({ type: "edges-overlay", image: edgeImg });
    redraw();
  };
  edgeImg.onerror = () => { URL.revokeObjectURL(url); alert("Failed to load edge image."); };
  edgeImg.src = url;
});

document.getElementById("btn-show-preprocessed").addEventListener("click", async () => {
  await ensureFrozen();
  const r = await fetch("/preprocessed-view", { method: "POST" });
  if (!r.ok) { alert(await r.text()); return; }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const ppImg = new Image();
  ppImg.onload = () => {
    URL.revokeObjectURL(url);
    state.annotations = state.annotations.filter(a => a.type !== "preprocessed-overlay");
    addAnnotation({ type: "preprocessed-overlay", image: ppImg });
    redraw();
  };
  ppImg.onerror = () => { URL.revokeObjectURL(url); alert("Failed to load preprocessed image."); };
  ppImg.src = url;
});

document.getElementById("btn-run-circles").addEventListener("click", async () => {
  await ensureFrozen();
  const p2   = parseInt(document.getElementById("hough-p2").value);
  const minR = parseInt(document.getElementById("circle-min-r").value);
  const maxR = parseInt(document.getElementById("circle-max-r").value);
  const resp = await fetch("/detect-circles", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ dp:1.2, min_dist:50, param1:100, param2:p2, min_radius:minR, max_radius:maxR }),
  });
  if (!resp.ok) { alert(await resp.text()); return; }
  const circles = await resp.json();
  const fw = state.frozenSize?.w || canvas.width;
  const fh = state.frozenSize?.h || canvas.height;
  // Remove previous auto-detected circles, keep manual ones
  state.annotations = state.annotations.filter(a => a.type !== "detected-circle");
  circles.forEach(c => addAnnotation({
    type: "detected-circle", name: "Circle",
    x: c.x, y: c.y, radius: c.radius, frameWidth: fw, frameHeight: fh,
  }));
  redraw();
});

document.getElementById("btn-run-lines").addEventListener("click", async () => {
  await ensureFrozen();
  const sensitivity = parseInt(document.getElementById("line-sensitivity").value);
  const minLength   = parseInt(document.getElementById("line-min-length").value);
  const resp = await fetch("/detect-lines", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ threshold1: 50, threshold2: 130, hough_threshold: sensitivity, min_length: minLength, max_gap: 8 }),
  });
  if (!resp.ok) { alert(await resp.text()); return; }
  const lines = await resp.json();
  const fw = state.frozenSize?.w || canvas.width;
  const fh = state.frozenSize?.h || canvas.height;
  // Remove previous auto-detected lines, keep manual ones
  state.annotations = state.annotations.filter(a => a.type !== "detected-line");
  lines.forEach(seg => addAnnotation({
    type: "detected-line", name: "Line",
    x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2, length: seg.length,
    frameWidth: fw, frameHeight: fh,
  }));
  redraw();
});

// ── Crosshair toggle ───────────────────────────────────────────────────────
document.getElementById("btn-crosshair").addEventListener("click", () => {
  state.crosshair = !state.crosshair;
  document.getElementById("btn-crosshair").classList.toggle("active", state.crosshair);
  redraw();
});

// ── Calibration button ──────────────────────────────────────────────────────
document.getElementById("btn-calibration").addEventListener("click", () => setTool("calibrate"));

// ── Help dialog ─────────────────────────────────────────────────────────────
document.getElementById("btn-help")?.addEventListener("click", () => {
  document.getElementById("help-dialog").hidden = false;
});
document.getElementById("btn-help-close").addEventListener("click", () => {
  document.getElementById("help-dialog").hidden = true;
});

// ── Settings dialog ────────────────────────────────────────────────────────
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

// ── White balance ───────────────────────────────────────────────────────────
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

// ── Camera selection ────────────────────────────────────────────────────────
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
