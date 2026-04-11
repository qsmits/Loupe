import { apiFetch } from './api.js';
import { state, pushUndo } from './state.js';
import { redraw, canvas, img, showStatus } from './render.js';
import { addAnnotation } from './annotations.js';
import { renderSidebar, updateDxfControlsVisibility, updateFreezeUI, renderInspectionTable } from './sidebar.js';
import { exportInspectionCsv, exportInspectionPdf } from './session.js';
import { serverSubpixelMethod } from './subpixel-js.js';

// ── Shared alignment helper ───────────────────────────────────────────────

/**
 * Apply alignment result from /align-dxf-edges to a DXF overlay annotation.
 * Computes the correct offset from the anchor point.
 */
export function applyAlignmentResult(ann, result) {
  ann.scale = result.scale ?? ann.scale;
  ann.angle = result.angle_deg ?? 0;
  const cosA = Math.cos(ann.angle * Math.PI / 180);
  const sinA = Math.sin(ann.angle * Math.PI / 180);
  const xr = result.dxf_cx * cosA - result.dxf_cy * sinA;
  const yr = result.dxf_cx * sinA + result.dxf_cy * cosA;
  const cx = xr * ann.scale;
  const cy = -yr * ann.scale;
  ann.offsetX = result.img_cx - cx;
  ann.offsetY = result.img_cy - cy;
}

// ── Per-feature tolerance popover ──────────────────────────────────────────
let _ftolActiveHandle = null;

export function enterDxfAlignMode() {
  state.dxfAlignMode = true;
  state.dxfAlignStep = 0;
  state.dxfAlignPick = null;
  state.dxfAlignHover = null;
  if (state._dxfOriginMode) {
    state._dxfOriginMode = false;
    document.getElementById("btn-dxf-set-origin")?.classList.remove("active");
  }
  showStatus("Click a DXF feature to anchor…");
}

export function exitDxfAlignMode() {
  state.dxfAlignMode = false;
  state.dxfAlignStep = 0;
  state.dxfAlignPick = null;
  state.dxfAlignHover = null;
  showStatus(state.frozen ? "Frozen" : "Live");
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

export function openFeatureTolPopover(handle, screenX, screenY) {
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

function updateExportButtons() {
  const hasResults = state.inspectionResults.length > 0;
  const csvBtn = document.getElementById("btn-export-inspection-csv");
  const pdfBtn = document.getElementById("btn-export-inspection-pdf");
  if (csvBtn) {
    csvBtn.disabled = !hasResults;
    csvBtn.title = !hasResults ? "Run inspection first" : "Export inspection results as CSV";
  }
  if (pdfBtn) {
    pdfBtn.disabled = !hasResults;
    pdfBtn.title = !hasResults ? "Run inspection first" : "Export inspection report as PDF";
  }
}

export function initDxfHandlers() {
  // Update export buttons when inspection state changes (e.g. session load)
  document.addEventListener('inspection-state-changed', () => updateExportButtons());

  // btn-load-dxf click (app.js ~2549)
  document.getElementById("btn-load-dxf").addEventListener("click", () => {
    document.getElementById("dxf-input").click();
  });

  // dxf-input change (app.js ~2553–2590)
  document.getElementById("dxf-input").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const r = await apiFetch("/load-dxf", { method: "POST", body: formData });
      if (!r.ok) { alert("Could not load DXF: " + await r.text()); e.target.value = ""; return; }
      const entities = await r.json();
      // Default scale: use calibration (px/mm) if available, otherwise 1 px/unit
      const cal = state.calibration;
      const autoScale = cal?.pixelsPerMm;
      const scale = autoScale ?? 1;
      const dxfScaleInput = document.getElementById("dxf-scale");
      if (dxfScaleInput) dxfScaleInput.value = scale.toFixed(3);
      state.annotations = state.annotations.filter(a => a.type !== "dxf-overlay");
      state.inspectionResults = [];
      state.inspectionFrame = null;
      state._templateLoaded = false;
      state._templateName = null;
      state.dxfFilename = file.name.replace(/\.dxf$/i, "");
      renderInspectionTable();
      updateExportButtons();
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
      updateDxfControlsVisibility();
      document.dispatchEvent(new CustomEvent("dxf-state-changed"));
      redraw();

      // Auto-align if calibrated and frozen
      if (cal?.pixelsPerMm && state.frozen) {
        showStatus("Auto-aligning DXF…");
        try {
          const smoothing = parseInt(document.getElementById("adv-smoothing")?.value || "2");
          const alignResp = await apiFetch("/align-dxf-edges", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              entities,
              pixels_per_mm: cal.pixelsPerMm,
              smoothing,
            }),
          });
          if (alignResp.ok) {
            const result = await alignResp.json();
            const ann = state.annotations.find(a => a.type === "dxf-overlay");
            if (ann) {
              applyAlignmentResult(ann, result);
              showStatus(`DXF auto-aligned (score ${(result.score * 100).toFixed(0)}%)`);
            }
          } else {
            showStatus("Auto-align failed — use Move DXF to position manually");
          }
        } catch (_) {
          showStatus("Auto-align failed — use Move DXF to position manually");
        }
        redraw();
      } else {
        enterDxfAlignMode();
      }
      e.target.value = "";
    } catch (err) {
      alert("Could not load DXF: " + err.message);
      e.target.value = "";
    }
  });

  // dxf-scale input (app.js ~2592–2601)
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

  // btn-dxf-set-origin click (app.js ~2603–2612)
  document.getElementById("btn-dxf-set-origin")?.addEventListener("click", () => {
    state._dxfOriginMode = true;
    document.getElementById("btn-dxf-set-origin")?.classList.add("active");
    showStatus("Click canvas to place DXF origin");
  });

  document.getElementById("btn-dxf-realign")?.addEventListener("click", enterDxfAlignMode);

  document.getElementById("btn-dxf-clear")?.addEventListener("click", () => {
    state.annotations = state.annotations.filter(a => a.type !== "dxf-overlay");
    state.inspectionResults = [];
    state.inspectionFrame = null;
    state.dxfFilename = null;
    state._templateLoaded = false;
    state._templateName = null;
    renderInspectionTable();
    updateExportButtons();
    const dxfPanelEl2 = document.getElementById("dxf-panel");
    if (dxfPanelEl2) dxfPanelEl2.style.display = "none";
    updateDxfControlsVisibility();
    redraw();
  });

  // btn-dxf-flip-h and btn-dxf-flip-v clicks
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

  // btn-dxf-rotate (rotation buttons ±1°, ±5°)
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

  // dxf-scale change (commit on blur/enter)
  document.getElementById("dxf-scale")?.addEventListener("change", () => {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (!ann) return;
    const val = parseFloat(document.getElementById("dxf-scale").value);
    if (!isFinite(val) || val <= 0) return;
    pushUndo();
    ann.scale = val;
    redraw();
  });

  // btn-align-dxf (auto-align) click
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

    const cal = state.calibration;
    if (!cal?.pixelsPerMm) { setStatus("Calibration required for alignment", true); return; }

    if (!state.frozen) {
      await ensureFrozen();
    }

    // Check if DXF has circles for circle-based alignment
    const dxfHasCircles = ann.entities.some(e => e.type === "circle");
    let circles = dxfHasCircles ? getDetectedCirclesForAlignment() : [];

    if (dxfHasCircles && circles.length === 0) {
      setStatus("Running circle detection…");
      const detectResp = await apiFetch("/detect-circles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ min_radius: 8, max_radius: 500 }),
      });
      if (detectResp.ok) {
        const detected = await detectResp.json();
        if (detected.length > 0) {
          const fw = state.frozenSize?.w || canvas.width;
          const fh = state.frozenSize?.h || canvas.height;
          pushUndo();
          state.annotations = state.annotations.filter(a => a.type !== "detected-circle");
          detected.forEach(c => addAnnotation({
            type: "detected-circle", x: c.x, y: c.y, radius: c.radius,
            frameWidth: fw, frameHeight: fh,
          }));
          circles = getDetectedCirclesForAlignment();
          redraw();
        }
      }
    }

    // Try circle-based alignment first, fall back to edge-based
    setStatus("Aligning…");
    try {
      let result;
      let usedEdges = false;

      if (circles.length >= 2 && dxfHasCircles) {
        // Circle-based alignment
        const r = await apiFetch("/align-dxf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entities: ann.entities,
            circles,
            pixels_per_mm: cal.pixelsPerMm,
          }),
        });
        if (r.ok) {
          result = await r.json();
          if (result.confidence === "failed") result = null;
        }
      }

      if (!result) {
        // Edge-based alignment (works without circles)
        usedEdges = true;
        const smoothing = parseInt(document.getElementById("adv-smoothing")?.value || "2");
        const r = await apiFetch("/align-dxf-edges", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entities: ann.entities,
            pixels_per_mm: cal.pixelsPerMm,
            smoothing,
          }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          setStatus(err.detail ?? "Alignment failed", true);
          return;
        }
        result = await r.json();
      }

      pushUndo();
      if (result.flip_h != null) ann.flipH = result.flip_h;
      if (result.flip_v != null) ann.flipV = result.flip_v;

      if (result.img_cx != null) {
        // Edge-based alignment: use shared helper
        applyAlignmentResult(ann, result);
      } else {
        // Circle-based alignment: tx/ty are offsetX/offsetY directly
        ann.angle = result.angle_deg ?? 0;
        ann.scale = result.scale ?? cal.pixelsPerMm;
        ann.offsetX = result.tx;
        ann.offsetY = result.ty;
      }
      updateDxfControlsVisibility();

      state.showDeviations = true;
      const devBtn = document.getElementById("btn-show-deviations");
      if (devBtn) {
        devBtn.removeAttribute("disabled");
        devBtn.textContent = "Deviations: on";
      }

      if (usedEdges) {
        setStatus(`Aligned (edge matching, score ${(result.score * 100).toFixed(0)}%)`);
      } else if (result.confidence === "high") {
        setStatus(`Aligned — ${result.inlier_count}/${result.total_dxf_circles} circles matched`);
      } else if (result.confidence === "low") {
        setStatus(`⚠ Low confidence — only ${result.inlier_count}/${result.total_dxf_circles} matched`, true);
      } else {
        setStatus("⚠ Alignment failed", true);
      }
      redraw();
    } catch (err) {
      setStatus("Network error: " + err.message, true);
    }
  });

  // btn-run-inspection: call /inspect-guided corridor-based API
  document.getElementById("btn-run-inspection")?.addEventListener("click", async () => {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (!ann) return;
    const cal = state.calibration;
    if (!cal?.pixelsPerMm) { showStatus("Calibrate first"); return; }

    const btnEl = document.getElementById("btn-run-inspection");
    const origText = btnEl?.textContent;
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = "Inspecting…"; }
    document.body.style.cursor = "progress";
    canvas.style.cursor = "progress";

    try {
      // If template is loaded, auto-align before inspecting
      if (state._templateLoaded && state.frozen) {
        showStatus("Auto-aligning DXF...");
        const smoothing = parseInt(document.getElementById("adv-smoothing")?.value || "2");
        try {
          const alignResp = await apiFetch("/align-dxf-edges", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              entities: ann.entities,
              pixels_per_mm: state.calibration.pixelsPerMm,
              smoothing,
            }),
          });
          if (alignResp.ok) {
            const alignResult = await alignResp.json();
            applyAlignmentResult(ann, alignResult);
            redraw();
            showStatus("Aligned. Running inspection...");
          } else {
            showStatus("Auto-align failed, running inspection on current position...");
          }
        } catch (err) {
          showStatus("Auto-align error, running inspection on current position...");
        }
      }

      const inspectableTypes = ["line", "polyline_line", "arc", "polyline_arc", "circle"];
      const resp = await apiFetch("/inspect-guided", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entities: ann.entities.filter(e => inspectableTypes.includes(e.type)),
          pixels_per_mm: cal.pixelsPerMm,
          tx: ann.offsetX,
          ty: ann.offsetY,
          angle_deg: ann.angle ?? 0,
          flip_h: ann.flipH ?? false,
          flip_v: ann.flipV ?? false,
          corridor_px: 15,
          smoothing: parseInt(document.getElementById("adv-smoothing")?.value || "1"),
          canny_low: parseInt(document.getElementById("canny-low")?.value || "50"),
          canny_high: parseInt(document.getElementById("canny-high")?.value || "130"),
          tolerance_warn: state.tolerances.warn,
          tolerance_fail: state.tolerances.fail,
          feature_tolerances: state.featureTolerances,
          subpixel: serverSubpixelMethod(state.settings.subpixelMethod),
        }),
      });

      if (!resp.ok) {
        const d = await resp.json().catch(() => null);
        showStatus(d?.detail || "Inspection failed");
        return;
      }

      const results = await resp.json();
      ann.guidedResults = results;

      // Populate state.inspectionResults for session/export
      state.inspectionResults = results.map(r => ({
        handle: r.handle,
        type: r.type,
        parent_handle: r.parent_handle,
        matched: r.matched,
        deviation_mm: r.perp_dev_mm ?? r.center_dev_mm ?? null,
        angle_error_deg: r.angle_error_deg ?? null,
        tolerance_warn: r.tolerance_warn ?? state.tolerances.warn,
        tolerance_fail: r.tolerance_fail ?? state.tolerances.fail,
        pass_fail: r.pass_fail,
        source: "auto",
        tp_dev_mm: r.tp_dev_mm ?? null,
        dx_px: r.dx_px ?? null,
        dy_px: r.dy_px ?? null,
        center_dev_mm: r.center_dev_mm ?? null,
        radius_dev_mm: r.radius_dev_mm ?? null,
        profile_mm: r.profile_mm ?? null,
      }));

      // Capture inspection frame
      try {
        const offscreen = document.createElement("canvas");
        offscreen.width = canvas.width;
        offscreen.height = canvas.height;
        const octx = offscreen.getContext("2d");
        octx.drawImage(img, 0, 0, offscreen.width, offscreen.height);
        octx.drawImage(canvas, 0, 0);
        state.inspectionFrame = offscreen.toDataURL("image/jpeg", 0.85);
      } catch (_) { state.inspectionFrame = null; }

      const matched = results.filter(r => r.matched).length;
      showStatus(`Inspection complete — ${matched}/${results.length} features matched`);
      state.showDeviations = true;

      renderInspectionTable();
      updateExportButtons();
      redraw();
    } catch (err) {
      showStatus("Inspection error: " + err.message);
    } finally {
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = origText; }
      document.body.style.cursor = "";
      canvas.style.cursor = "";
    }
  });

  // btn-dxf-move: toggle drag-to-translate mode
  document.getElementById("btn-dxf-move")?.addEventListener("click", () => {
    const ann = state.annotations.find(a => a.type === "dxf-overlay");
    if (!ann) return;
    state.dxfDragMode = !state.dxfDragMode;
    state.dxfDragOrigin = null;
    document.getElementById("btn-dxf-move")?.classList.toggle("active", state.dxfDragMode);
    // Close the dropdown menu
    const dropdown = document.getElementById("btn-dxf-move")?.closest(".dropdown");
    if (dropdown) dropdown.hidden = true;
    showStatus(state.dxfDragMode ? "Drag to reposition DXF overlay" : (state.frozen ? "Frozen" : "Live"));
  });

  const btnExportCsv = document.getElementById("btn-export-inspection-csv");
  if (btnExportCsv) {
    btnExportCsv.addEventListener("click", () => {
      exportInspectionCsv();
    });
  }

  const btnExportPdf = document.getElementById("btn-export-inspection-pdf");
  if (btnExportPdf) {
    btnExportPdf.addEventListener("click", () => {
      exportInspectionPdf();
    });
  }

  // btn-deviations click
  document.getElementById("btn-show-deviations")?.addEventListener("click", () => {
    state.showDeviations = !state.showDeviations;
    document.getElementById("btn-show-deviations").textContent =
      state.showDeviations ? "Deviations: on" : "Deviations: off";
    redraw();
  });

  // ftol-set, ftol-reset, ftol-close buttons (app.js ~2937–2961)
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
}

// ── Use measurements as reference overlay ────────────────────────────────────
/**
 * Convert the current measurement annotations into a DXF-format entity list
 * and inject them as a dxf-overlay — bypassing the file export/import cycle.
 *
 * Supported types:
 *   distance / perp-dist / para-dist / slot-dist → "line"
 *   circle / arc-fit (full)                      → "circle"
 *   arc-fit (arc segment)                        → "arc"
 *   arc-measure                                  → "arc"
 *   spline                                       → "polyline_line" segments (alignment only)
 *
 * The overlay is placed so entities render exactly where the measurements are,
 * then auto-align runs (if frozen) to snap it to the actual part edges.
 */
export async function measurementsAsDxf() {
  const cal = state.calibration;
  if (!cal?.pixelsPerMm) {
    showStatus("Calibrate first — reference overlay needs a px/mm scale");
    return;
  }

  const ppm = cal.pixelsPerMm;
  const originX = state.origin?.x ?? 0;
  const originY = state.origin?.y ?? 0;

  // Convert pixel coords → mm with Y-flip (canvas Y-down → DXF Y-up)
  const toX = px => (px - originX) / ppm;
  const toY = py => -(py - originY) / ppm;

  const entities = [];
  let handleN = 0;
  const nextHandle = () => `ref_${++handleN}`;
  const layer = "measurements";

  const LINE_TYPES = new Set(["distance", "perp-dist", "para-dist", "slot-dist"]);

  for (const ann of state.annotations) {
    if (LINE_TYPES.has(ann.type)) {
      const { a, b } = ann;
      if (!a || !b) continue;
      entities.push({
        type: "line",
        x1: toX(a.x), y1: toY(a.y), x2: toX(b.x), y2: toY(b.y),
        handle: nextHandle(), layer,
      });
    } else if (ann.type === "circle") {
      if (!ann.r || ann.r <= 0) continue;
      entities.push({
        type: "circle",
        cx: toX(ann.cx), cy: toY(ann.cy), radius: ann.r / ppm,
        handle: nextHandle(), layer,
      });
    } else if (ann.type === "arc-measure") {
      if (!ann.r || !ann.p1 || !ann.p3) continue;
      const cx_mm = toX(ann.cx), cy_mm = toY(ann.cy);
      // Compute angles from the two endpoint pixels — already in DXF (Y-up) frame
      // because toX/toY already flipped Y.
      const start_deg = Math.atan2(toY(ann.p1.y) - cy_mm, toX(ann.p1.x) - cx_mm) * 180 / Math.PI;
      const end_deg   = Math.atan2(toY(ann.p3.y) - cy_mm, toX(ann.p3.x) - cx_mm) * 180 / Math.PI;
      entities.push({
        type: "arc",
        cx: cx_mm, cy: cy_mm, radius: ann.r / ppm,
        start_angle: start_deg, end_angle: end_deg,
        handle: nextHandle(), layer,
      });
    } else if (ann.type === "arc-fit") {
      if (!ann.r || ann.r <= 0) continue;
      if (ann.startAngle === undefined) {
        // Full circle
        entities.push({
          type: "circle",
          cx: toX(ann.cx), cy: toY(ann.cy), radius: ann.r / ppm,
          handle: nextHandle(), layer,
        });
      } else {
        // Arc: convert canvas angles (radians, Y-down) → DXF degrees (Y-up).
        // Negating flips Y; for anticlockwise=false (canvas CW = DXF CCW), swap start/end.
        let dxfStart = -ann.endAngle * 180 / Math.PI;
        let dxfEnd   = -ann.startAngle * 180 / Math.PI;
        if (ann.anticlockwise) [dxfStart, dxfEnd] = [dxfEnd, dxfStart];
        entities.push({
          type: "arc",
          cx: toX(ann.cx), cy: toY(ann.cy), radius: ann.r / ppm,
          start_angle: dxfStart, end_angle: dxfEnd,
          handle: nextHandle(), layer,
        });
      }
    } else if (ann.type === "spline") {
      const pts = ann.points;
      if (!pts || pts.length < 2) continue;
      const h = nextHandle();
      for (let i = 0; i < pts.length - 1; i++) {
        entities.push({
          type: "polyline_line",
          x1: toX(pts[i].x), y1: toY(pts[i].y),
          x2: toX(pts[i + 1].x), y2: toY(pts[i + 1].y),
          handle: `${h}_s${i}`, layer,
        });
      }
    }
  }

  if (entities.length === 0) {
    showStatus("No supported measurements — add distances, circles, arcs, or splines first");
    return;
  }

  setDxfOverlayFromEntities(entities, {
    filename: "from measurements",
    offsetX: originX,
    offsetY: originY,
    scale: ppm,
    readyMessage: `Reference overlay created — ${entities.length} entities`,
    alignedMessagePrefix: "Reference overlay ready",
    fallbackMessage: "Reference overlay set — use Move DXF to fine-tune position",
  });
}


/**
 * Shared helper: replace any existing dxf-overlay with a new one from an
 * in-memory entity list, update the dxf panel chrome, and (if frozen) run
 * edge-based auto-align. Used by `measurementsAsDxf` and the gear overlay
 * generator in gear.js. Keeps both callers in sync with the file-load path
 * in dxf-input's change handler (same field names, same event dispatch).
 *
 * @param {Array} entities   DXF-format entity dicts (mm, Y-up).
 * @param {Object} opts
 * @param {string} opts.filename            displayed in the DXF panel
 * @param {number} opts.offsetX             overlay origin x (image px)
 * @param {number} opts.offsetY             overlay origin y (image px)
 * @param {number} opts.scale               pixels per mm
 * @param {string} opts.readyMessage        status shown after creation
 * @param {string} [opts.alignedMessagePrefix]
 * @param {string} [opts.fallbackMessage]
 * @param {boolean} [opts.skipAutoAlign]    if true, don't run /align-dxf-edges
 */
export async function setDxfOverlayFromEntities(entities, opts) {
  const ppm = opts.scale;
  const dxfScaleInput = document.getElementById("dxf-scale");
  if (dxfScaleInput) dxfScaleInput.value = ppm.toFixed(3);
  state.annotations = state.annotations.filter(a => a.type !== "dxf-overlay");
  state.inspectionResults = [];
  state.inspectionFrame = null;
  state._templateLoaded = false;
  state._templateName = null;
  state.dxfFilename = opts.filename;
  renderInspectionTable();
  updateExportButtons();
  addAnnotation({
    type: "dxf-overlay",
    entities,
    offsetX: opts.offsetX,
    offsetY: opts.offsetY,
    scale: ppm,
    angle: 0,
    scaleManual: false,
    flipH: false,
    flipV: false,
  });
  const dxfPanelEl = document.getElementById("dxf-panel");
  if (dxfPanelEl) dxfPanelEl.style.display = "";
  updateDxfControlsVisibility();
  document.dispatchEvent(new CustomEvent("dxf-state-changed"));
  showStatus(opts.readyMessage);
  redraw();

  if (opts.skipAutoAlign || !state.frozen) return;

  showStatus("Auto-aligning overlay…");
  try {
    const smoothing = parseInt(document.getElementById("adv-smoothing")?.value || "1");
    const alignResp = await apiFetch("/align-dxf-edges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entities, pixels_per_mm: ppm, smoothing }),
    });
    if (alignResp.ok) {
      const result = await alignResp.json();
      const ann = state.annotations.find(a => a.type === "dxf-overlay");
      if (ann) {
        applyAlignmentResult(ann, result);
        const prefix = opts.alignedMessagePrefix || "Overlay aligned";
        showStatus(`${prefix} (score ${(result.score * 100).toFixed(0)}%)`);
      }
    } else {
      showStatus(opts.fallbackMessage || "Overlay set — use Move DXF to fine-tune position");
    }
  } catch (_) {
    showStatus(opts.fallbackMessage || "Overlay set — use Move DXF to fine-tune position");
  }
  redraw();
}
