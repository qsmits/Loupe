import { state, pushUndo } from './state.js';
import { redraw, canvas, showStatus } from './render.js';
import { addAnnotation } from './annotations.js';
import { renderSidebar, updateDxfControlsVisibility, updateFreezeUI } from './sidebar.js';

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

export function initDxfHandlers() {
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
