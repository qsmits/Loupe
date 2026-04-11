// frontend/gear.js
// Gear analysis click flow + POST + results panel rendering.
// Canvas overlay rendering lives in render.js (drawGearAnalysis).
import { state } from "./state.js";
import { showStatus, redraw } from "./render.js";
import { hitTestAnnotation } from "./hit-test.js";
import { apiFetch } from "./api.js";
import { setDxfOverlayFromEntities } from "./dxf.js";

// Dialog state: the picked tip/root circles, held while the modal is open.
let _gearDialogCircles = null;

export function initGear() {
  const btn = document.getElementById("btn-analyze-gear");
  if (btn) btn.addEventListener("click", startGearAnalysis);

  // Modal wiring — only if the dialog is in the DOM.
  const dlg = document.getElementById("gear-generate-dialog");
  if (!dlg) return;

  document.getElementById("btn-gear-gen-close")?.addEventListener("click", closeGearDialog);
  dlg.addEventListener("click", (e) => { if (e.target === dlg) closeGearDialog(); });

  const profileSel = document.getElementById("gear-gen-profile");
  profileSel?.addEventListener("change", updateGearDialogProfileRows);

  const nInput = document.getElementById("gear-gen-n");
  const addInput = document.getElementById("gear-gen-addendum");
  nInput?.addEventListener("input", updateGearDialogDerivedInfo);
  addInput?.addEventListener("input", updateGearDialogDerivedInfo);

  document.getElementById("btn-gear-gen-widths")?.addEventListener("click", runAnalyzeGearFromDialog);
  document.getElementById("btn-gear-gen-overlay")?.addEventListener("click", runGenerateGearOverlayFromDialog);
  document.getElementById("btn-gear-gen-detect-n")?.addEventListener("click", detectToothCountFromDialog);
}

// Called when the user clicks the "Gear" button in the top bar.
export function startGearAnalysis() {
  if (!state.frozen) {
    showStatus("Freeze a frame first");
    return;
  }
  state.gearPickMode = "pick-tip";
  state.gearPickBuffer = {};
  showStatus("Click the TIP (outer) circle annotation");
}

// Called from the mouse-down handler when a gear pick mode is active.
// Returns true if the click was consumed and normal tool dispatch should skip.
export function handleGearPickClick(pt) {
  if (!state.gearPickMode) return false;

  // Find a circle annotation under the click (topmost first).
  let hit = null;
  for (let i = state.annotations.length - 1; i >= 0; i--) {
    const a = state.annotations[i];
    if (a.type !== "circle" && a.type !== "arc-fit") continue;
    if (hitTestAnnotation(a, pt)) { hit = a; break; }
  }

  if (!hit) {
    showStatus("That is not a circle annotation — click a fitted circle");
    return true;
  }

  if (state.gearPickMode === "pick-tip") {
    state.gearPickBuffer.tipCircle = hit;
    state.gearPickMode = "pick-root";
    showStatus("Now click the ROOT (inner) circle annotation");
    redraw();
    return true;
  }

  if (state.gearPickMode === "pick-root") {
    if (hit === state.gearPickBuffer.tipCircle) {
      showStatus("Pick a different circle for the root");
      return true;
    }
    state.gearPickBuffer.rootCircle = hit;
    state.gearPickMode = null;
    state.gearPickHover = null;
    document.querySelector("#overlay-canvas").style.cursor = "default";
    openGearGenerateDialog(state.gearPickBuffer.tipCircle, state.gearPickBuffer.rootCircle);
    state.gearPickBuffer = null;
    return true;
  }

  return false;
}

// ── Modal ────────────────────────────────────────────────────────────────

function openGearGenerateDialog(tipCircle, rootCircle) {
  if (tipCircle.r <= rootCircle.r) {
    showStatus("The first circle must be the TIP (outer) circle — start over");
    return;
  }
  _gearDialogCircles = { tipCircle, rootCircle };

  const dlg = document.getElementById("gear-generate-dialog");
  if (!dlg) {
    showStatus("Gear dialog missing from DOM");
    return;
  }
  setGearDialogStatus("");
  updateGearDialogProfileRows();
  updateGearDialogDerivedInfo();
  dlg.hidden = false;
  document.getElementById("gear-gen-n")?.focus();
}

function closeGearDialog() {
  const dlg = document.getElementById("gear-generate-dialog");
  if (dlg) dlg.hidden = true;
  _gearDialogCircles = null;
  setGearDialogStatus("");
}

function setGearDialogStatus(msg) {
  const el = document.getElementById("gear-gen-status");
  if (el) el.textContent = msg || "";
}

function updateGearDialogProfileRows() {
  const profile = document.getElementById("gear-gen-profile")?.value;
  const rollingRow = document.getElementById("gear-gen-rolling-row");
  const pressureRow = document.getElementById("gear-gen-pressure-row");
  if (rollingRow) rollingRow.hidden = profile !== "cycloidal";
  if (pressureRow) pressureRow.hidden = profile !== "involute";
}

// Compute the module from picked tip circle, current N, and addendum_coef, and
// display it so the user sees the derived value before clicking a button.
function updateGearDialogDerivedInfo() {
  const infoEl = document.getElementById("gear-gen-module-info");
  if (!infoEl) return;
  if (!_gearDialogCircles) { infoEl.textContent = "—"; return; }

  const n = parseInt(document.getElementById("gear-gen-n")?.value || "0", 10);
  const addendum = parseFloat(document.getElementById("gear-gen-addendum")?.value || "1.0");
  if (!Number.isFinite(n) || n < 6 || !Number.isFinite(addendum) || addendum <= 0) {
    infoEl.textContent = "—";
    return;
  }

  const ppm = state.calibration?.pixelsPerMm;
  const { tipCircle } = _gearDialogCircles;
  const r_tip_px = tipCircle.r;

  if (ppm && ppm > 0) {
    const r_tip_mm = r_tip_px / ppm;
    const m = (2 * r_tip_mm) / (n + 2 * addendum);
    infoEl.textContent = `m = ${m.toFixed(4)} mm   (tip Ø ${(2 * r_tip_mm).toFixed(3)} mm)`;
  } else {
    const m_px = (2 * r_tip_px) / (n + 2 * addendum);
    infoEl.textContent = `m ≈ ${m_px.toFixed(2)} px (no calibration)`;
  }
}

async function detectToothCountFromDialog() {
  if (!_gearDialogCircles) return;
  const { tipCircle, rootCircle } = _gearDialogCircles;

  const btn = document.getElementById("btn-gear-gen-detect-n");
  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Detecting…"; }
  setGearDialogStatus("Detecting tooth count…");

  try {
    const r = await apiFetch("/detect-gear-teeth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cx: tipCircle.cx,
        cy: tipCircle.cy,
        r_tip: tipCircle.r,
        r_root: rootCircle.r,
      }),
    });
    if (!r.ok) {
      const txt = await r.text();
      setGearDialogStatus(`Detect failed: ${txt}`);
      return;
    }
    const result = await r.json();
    const nInput = document.getElementById("gear-gen-n");
    if (nInput) {
      nInput.value = String(result.n_teeth);
      nInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    // SNR < 0.02 means the spectrum is flat enough to be untrustworthy;
    // still fill the field but warn the user so they can sanity-check.
    if (result.snr < 0.02) {
      setGearDialogStatus(`Detected N=${result.n_teeth} (low SNR ${result.snr.toFixed(3)} — verify)`);
    } else {
      setGearDialogStatus(`Detected N=${result.n_teeth} (SNR ${result.snr.toFixed(3)})`);
    }
  } catch (err) {
    console.error(err);
    setGearDialogStatus(`Detect failed: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

function runAnalyzeGearFromDialog() {
  if (!_gearDialogCircles) return;
  const n = parseInt(document.getElementById("gear-gen-n")?.value || "0", 10);
  if (!Number.isFinite(n) || n < 6 || n > 300) {
    setGearDialogStatus("Tooth count must be between 6 and 300");
    return;
  }

  const { tipCircle, rootCircle } = _gearDialogCircles;
  const cx = tipCircle.cx;
  const cy = tipCircle.cy;
  const tip_r = tipCircle.r;
  const root_r = rootCircle.r;

  setGearDialogStatus("Analyzing gear…");

  apiFetch("/analyze-gear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cx, cy, tip_r, root_r, n_teeth: n }),
  })
    .then((r) => {
      if (!r.ok) return r.text().then((t) => { throw new Error(`HTTP ${r.status}: ${t}`); });
      return r.json();
    })
    .then((result) => {
      if (result.error) {
        setGearDialogStatus(`Gear analysis: ${result.error}`);
        return;
      }
      state.gearAnalysis = { ...result, cx, cy };
      closeGearDialog();
      showStatus(`Gear analysis: ${result.teeth.length} teeth measured`);
      renderGearResultsPanel();
      redraw();
    })
    .catch((err) => {
      console.error(err);
      setGearDialogStatus(`Gear analysis failed: ${err.message}`);
    });
}

async function runGenerateGearOverlayFromDialog() {
  if (!_gearDialogCircles) return;

  const ppm = state.calibration?.pixelsPerMm;
  if (!ppm || ppm <= 0) {
    setGearDialogStatus("Calibrate first — overlay generation needs a px/mm scale");
    return;
  }

  const n = parseInt(document.getElementById("gear-gen-n")?.value || "0", 10);
  if (!Number.isFinite(n) || n < 6 || n > 300) {
    setGearDialogStatus("Tooth count must be between 6 and 300");
    return;
  }
  const profile = document.getElementById("gear-gen-profile")?.value || "cycloidal";
  const addendum = parseFloat(document.getElementById("gear-gen-addendum")?.value || "1.0");
  const dedendum = parseFloat(document.getElementById("gear-gen-dedendum")?.value || "1.25");
  const rollingCoef = parseFloat(document.getElementById("gear-gen-rolling")?.value || "0.5");
  const pressureDeg = parseFloat(document.getElementById("gear-gen-pressure")?.value || "20");
  const rotationDeg = parseFloat(document.getElementById("gear-gen-rotation")?.value || "0");
  const ptsFlank = parseInt(document.getElementById("gear-gen-pts-flank")?.value || "6", 10);
  const ptsTip = parseInt(document.getElementById("gear-gen-pts-tip")?.value || "3", 10);
  const ptsRoot = parseInt(document.getElementById("gear-gen-pts-root")?.value || "2", 10);

  if (!Number.isFinite(addendum) || addendum <= 0 ||
      !Number.isFinite(dedendum) || dedendum <= 0) {
    setGearDialogStatus("Addendum and dedendum must be positive numbers");
    return;
  }
  if (!Number.isInteger(ptsFlank) || ptsFlank < 4 ||
      !Number.isInteger(ptsTip)   || ptsTip   < 2 ||
      !Number.isInteger(ptsRoot)  || ptsRoot  < 2) {
    setGearDialogStatus("Sampling density must be integers: flank ≥ 4, tip ≥ 2, root ≥ 2");
    return;
  }

  const { tipCircle, rootCircle } = _gearDialogCircles;
  const r_tip_mm = tipCircle.r / ppm;
  const module_mm = (2 * r_tip_mm) / (n + 2 * addendum);

  // If the user hasn't set a rotation, auto-detect it via DFT phase of the
  // pitch-circle intensity profile. Edge-based template matching doesn't
  // work on rotationally symmetric geometry, but the N-th harmonic of the
  // radial intensity profile gives the tooth phase directly. A rotation
  // the user has typed in wins — we only auto-detect when the field is 0.
  let effectiveRotationDeg = rotationDeg;
  if (rotationDeg === 0) {
    setGearDialogStatus("Detecting gear rotation…");
    try {
      const phaseBody = {
        cx: tipCircle.cx,
        cy: tipCircle.cy,
        r_tip: tipCircle.r,
        r_root: rootCircle.r,
        n_teeth: n,
        pixels_per_mm: ppm,
        profile,
        addendum_coef: addendum,
        rolling_radius_coef: rollingCoef,
        pressure_angle_deg: pressureDeg,
      };
      const pr = await apiFetch("/auto-phase-gear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(phaseBody),
      });
      if (pr.ok) {
        const pj = await pr.json();
        // SNR below ~0.02 means the pitch-circle profile has no clean
        // N-tooth harmonic — the estimate isn't trustworthy. Fall back to
        // 0 and let the user align manually.
        if (pj.snr >= 0.02 && Number.isFinite(pj.rotation_deg)) {
          effectiveRotationDeg = pj.rotation_deg;
          const rotInput = document.getElementById("gear-gen-rotation");
          if (rotInput) rotInput.value = pj.rotation_deg.toFixed(2);
        }
      }
    } catch (err) {
      console.warn("auto-phase-gear failed, using rotation=0", err);
    }
  }

  // Generate the gear in its own local DXF frame with the center at (0, 0),
  // then place the overlay so DXF origin lands at the picked tip-circle
  // pixel center. Because dxf_to_image_px rotates around DXF (0,0), this
  // makes the overlay's rotation pivot equal to the gear center — which is
  // what the user expects when they nudge rotation or drag-rotate, and what
  // the future common-mode refine loop needs as a stable reference frame.
  const body = {
    n_teeth: n,
    profile,
    module: module_mm,
    cx: 0,
    cy: 0,
    addendum_coef: addendum,
    dedendum_coef: dedendum,
    rotation_deg: effectiveRotationDeg,
    layer: "GEAR",
    points_per_flank: ptsFlank,
    points_per_tip: ptsTip,
    points_per_root: ptsRoot,
  };
  if (profile === "cycloidal") body.rolling_radius_coef = rollingCoef;
  else body.pressure_angle_deg = pressureDeg;

  setGearDialogStatus("Generating overlay…");

  try {
    const r = await apiFetch("/generate-gear-dxf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`HTTP ${r.status}: ${txt}`);
    }
    const entities = await r.json();

    closeGearDialog();
    await setDxfOverlayFromEntities(entities, {
      filename: `generated ${profile} gear (N=${n})`,
      offsetX: tipCircle.cx,
      offsetY: tipCircle.cy,
      scale: ppm,
      readyMessage: `Generated ${profile} gear overlay — ${entities.length} segments. Use Rotate DXF to align.`,
      // Skip auto-align: edge-based template matching doesn't work on
      // rotationally symmetric geometry, and applyAlignmentResult would
      // overwrite offsetX/Y and move the pivot off the gear center.
      skipAutoAlign: true,
    });
  } catch (err) {
    console.error(err);
    setGearDialogStatus(`Overlay generation failed: ${err.message}`);
  }
}

// Render the results table into the sidebar panel.
export function renderGearResultsPanel() {
  const panel = document.getElementById("gear-results-panel");
  const body = document.getElementById("gear-results-body");
  const countEl = document.getElementById("gear-results-count");
  if (!panel || !body) return;

  if (!state.gearAnalysis || !state.gearAnalysis.teeth || state.gearAnalysis.teeth.length === 0) {
    panel.setAttribute("hidden", "");
    body.replaceChildren();
    if (countEl) countEl.textContent = "";
    return;
  }
  panel.removeAttribute("hidden");

  const teeth = state.gearAnalysis.teeth.slice();
  const bestWidth = Math.max(...teeth.map((t) => t.angular_width_deg));
  const pcdRadiusPx = state.gearAnalysis.pcd_radius_px;
  const pxPerMm = state.calibration ? state.calibration.pixelsPerMm : null;

  if (countEl) countEl.textContent = `${teeth.length} teeth`;

  const table = document.createElement("table");
  table.className = "inspection-table gear-results-table";

  const thead = document.createElement("thead");
  const hrow = document.createElement("tr");
  const headers = ["#", "Width °", "Δ° vs best"];
  if (pxPerMm) headers.push("Δµm @ PCD");
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const sorted = teeth.slice().sort((a, b) => a.index - b.index);
  for (const t of sorted) {
    const row = document.createElement("tr");

    const idxTd = document.createElement("td");
    idxTd.textContent = `T${t.index}`;
    row.appendChild(idxTd);

    const wTd = document.createElement("td");
    wTd.textContent = t.angular_width_deg.toFixed(3);
    row.appendChild(wTd);

    const dDeg = t.angular_width_deg - bestWidth;
    const dDegTd = document.createElement("td");
    dDegTd.textContent = dDeg.toFixed(3);
    row.appendChild(dDegTd);

    if (pxPerMm) {
      const dUmTd = document.createElement("td");
      const dUm = (dDeg * Math.PI / 180) * pcdRadiusPx / pxPerMm * 1000;
      dUmTd.textContent = dUm.toFixed(1);
      row.appendChild(dUmTd);
    }

    tbody.appendChild(row);
  }
  table.appendChild(tbody);

  body.replaceChildren(table);
}
