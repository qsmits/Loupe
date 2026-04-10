// frontend/gear.js
// Gear analysis click flow + POST + results panel rendering.
// Canvas overlay rendering lives in render.js (drawGearAnalysis).
import { state } from "./state.js";
import { showStatus, redraw } from "./render.js";
import { hitTestAnnotation } from "./hit-test.js";
import { apiFetch } from "./api.js";

export function initGear() {
  const btn = document.getElementById("btn-analyze-gear");
  if (btn) btn.addEventListener("click", startGearAnalysis);
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
    promptForToothCountAndRun();
    return true;
  }

  return false;
}

function promptForToothCountAndRun() {
  const nStr = window.prompt("How many teeth on this gear?", "17");
  if (!nStr) {
    state.gearPickBuffer = null;
    showStatus("Gear analysis cancelled");
    return;
  }
  const n = parseInt(nStr, 10);
  if (!Number.isFinite(n) || n < 6 || n > 300) {
    showStatus("Tooth count must be between 6 and 300");
    state.gearPickBuffer = null;
    return;
  }

  const { tipCircle, rootCircle } = state.gearPickBuffer;
  // Use the tip circle's center as the gear center (larger fit = more stable).
  const cx = tipCircle.cx;
  const cy = tipCircle.cy;
  const tip_r = tipCircle.r;
  const root_r = rootCircle.r;

  if (tip_r <= root_r) {
    showStatus("The first circle must be the TIP (outer) circle — start over");
    state.gearPickBuffer = null;
    return;
  }

  showStatus("Analyzing gear…");

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
        showStatus(`Gear analysis: ${result.error}`);
        state.gearPickBuffer = null;
        return;
      }
      state.gearAnalysis = { ...result, cx, cy };
      state.gearPickBuffer = null;
      showStatus(`Gear analysis: ${result.teeth.length} teeth measured`);
      renderGearResultsPanel();
      redraw();
    })
    .catch((err) => {
      console.error(err);
      showStatus(`Gear analysis failed: ${err.message}`);
      state.gearPickBuffer = null;
    });
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
