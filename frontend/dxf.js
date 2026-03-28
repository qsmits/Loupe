import { state, pushUndo } from './state.js';
import { redraw, canvas, img, showStatus } from './render.js';
import { addAnnotation } from './annotations.js';
import { renderSidebar, updateDxfControlsVisibility, updateFreezeUI, renderInspectionTable } from './sidebar.js';
import { exportInspectionCsv, exportInspectionPdf } from './session.js';

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
      state.inspectionResults = [];
      state.inspectionFrame = null;
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
      redraw();

      // Auto-align if calibrated and frozen
      if (cal?.pixelsPerMm && state.frozen) {
        showStatus("Auto-aligning DXF…");
        try {
          const smoothing = parseInt(document.getElementById("adv-smoothing")?.value || "2");
          const alignResp = await fetch("/align-dxf-edges", {
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
              // The backend returns the image-space position of the DXF center
              // and the DXF center in DXF space. We compute offsetX/offsetY by
              // reverse-engineering dxfToCanvas: we know where the DXF center
              // SHOULD land (img_cx, img_cy), and dxfToCanvas tells us where it
              // WOULD land for given offset. Solve for offset.
              //
              // dxfToCanvas(dxf_cx, dxf_cy) = (offsetX + cx, offsetY + cy)
              // where cx = xr * scale, cy = -yr * scale
              // We want: offsetX + cx = img_cx => offsetX = img_cx - cx
              //          offsetY + cy = img_cy => offsetY = img_cy - cy
              ann.angle = result.angle_deg ?? 0;
              const cosA = Math.cos(ann.angle * Math.PI / 180);
              const sinA = Math.sin(ann.angle * Math.PI / 180);
              const xr = result.dxf_cx * cosA - result.dxf_cy * sinA;
              const yr = result.dxf_cx * sinA + result.dxf_cy * cosA;
              const cx = xr * ann.scale;
              const cy = -yr * ann.scale;
              ann.offsetX = result.img_cx - cx;
              ann.offsetY = result.img_cy - cy;
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
      const detectResp = await fetch("/detect-circles", {
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
        const r = await fetch("/align-dxf", {
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
        const r = await fetch("/align-dxf-edges", {
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
      ann.angle = result.angle_deg ?? 0;
      ann.scale = result.scale ?? cal.pixelsPerMm;
      if (result.flip_h != null) ann.flipH = result.flip_h;
      if (result.flip_v != null) ann.flipV = result.flip_v;

      if (result.img_cx != null) {
        // Edge-based alignment: compute offset from anchor point
        const cosA = Math.cos(ann.angle * Math.PI / 180);
        const sinA = Math.sin(ann.angle * Math.PI / 180);
        const xr = result.dxf_cx * cosA - result.dxf_cy * sinA;
        const yr = result.dxf_cx * sinA + result.dxf_cy * cosA;
        ann.offsetX = result.img_cx - xr * ann.scale;
        ann.offsetY = result.img_cy - (-yr * ann.scale);
      } else {
        // Circle-based alignment: tx/ty are offsetX/offsetY directly
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
      const inspectableTypes = ["line", "polyline_line", "arc", "polyline_arc", "circle"];
      const resp = await fetch("/inspect-guided", {
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
