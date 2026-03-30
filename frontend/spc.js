// spc.js — SPC dashboard: trend chart (Canvas 2D), Cpk summary, part/feature selectors.

import { apiFetch } from './api.js';

/**
 * Draw a deviation-vs-run trend chart on a Canvas element.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{run_id:number, deviation_mm:number}>} history
 * @param {{tol_warn:number, tol_fail:number}} tols — tolerance thresholds
 */
export function drawTrendChart(canvas, history, tols = {}) {
  const tolWarn = tols.tol_warn ?? 0.10;
  const tolFail = tols.tol_fail ?? 0.25;

  // Auto-size canvas to container
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = 180;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.height = cssH + "px";

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  // Margins
  const mTop = 15, mRight = 10, mBottom = 25, mLeft = 45;
  const plotW = cssW - mLeft - mRight;
  const plotH = cssH - mTop - mBottom;

  // Clear
  ctx.fillStyle = "#1c1c1e";
  ctx.fillRect(0, 0, cssW, cssH);

  if (!history || history.length === 0) {
    ctx.fillStyle = "#888";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText("No data", cssW / 2, cssH / 2);
    return;
  }

  // Compute Y range: symmetric around zero
  const maxDev = Math.max(...history.map(h => Math.abs(h.deviation_mm)));
  const yExtent = Math.max(tolFail * 1.2, maxDev) * 1.1;

  // Helpers: data → pixel
  const xScale = (i) => mLeft + (history.length === 1 ? plotW / 2 : (i / (history.length - 1)) * plotW);
  const yScale = (v) => mTop + plotH / 2 - (v / yExtent) * (plotH / 2);

  // ── Tolerance band fills ──
  // Green zone: 0 ± warn
  ctx.fillStyle = "rgba(50, 215, 75, 0.08)";
  ctx.fillRect(mLeft, yScale(tolWarn), plotW, yScale(-tolWarn) - yScale(tolWarn));

  // Amber zone: warn to fail (top)
  ctx.fillStyle = "rgba(255, 159, 10, 0.08)";
  ctx.fillRect(mLeft, yScale(tolFail), plotW, yScale(tolWarn) - yScale(tolFail));
  // Amber zone: warn to fail (bottom)
  ctx.fillRect(mLeft, yScale(-tolWarn), plotW, yScale(-tolFail) - yScale(-tolWarn));

  // ── Dashed tolerance lines ──
  ctx.setLineDash([4, 3]);

  // Warn lines (amber)
  ctx.strokeStyle = "rgba(255, 159, 10, 0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mLeft, yScale(tolWarn));
  ctx.lineTo(mLeft + plotW, yScale(tolWarn));
  ctx.moveTo(mLeft, yScale(-tolWarn));
  ctx.lineTo(mLeft + plotW, yScale(-tolWarn));
  ctx.stroke();

  // Fail lines (red)
  ctx.strokeStyle = "rgba(255, 69, 58, 0.6)";
  ctx.beginPath();
  ctx.moveTo(mLeft, yScale(tolFail));
  ctx.lineTo(mLeft + plotW, yScale(tolFail));
  ctx.moveTo(mLeft, yScale(-tolFail));
  ctx.lineTo(mLeft + plotW, yScale(-tolFail));
  ctx.stroke();

  ctx.setLineDash([]);

  // Zero line
  ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mLeft, yScale(0));
  ctx.lineTo(mLeft + plotW, yScale(0));
  ctx.stroke();

  // ── Data line ──
  ctx.strokeStyle = "#0a84ff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < history.length; i++) {
    const x = xScale(i);
    const y = yScale(history[i].deviation_mm);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // ── Colored dots ──
  for (let i = 0; i < history.length; i++) {
    const x = xScale(i);
    const dev = history[i].deviation_mm;
    const absDev = Math.abs(dev);
    const y = yScale(dev);

    if (absDev >= tolFail) ctx.fillStyle = "#ff453a";
    else if (absDev >= tolWarn) ctx.fillStyle = "#ff9f0a";
    else ctx.fillStyle = "#32d74b";

    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Y-axis labels ──
  ctx.fillStyle = "#888";
  ctx.font = "10px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  const yLabels = [tolFail, tolWarn, 0, -tolWarn, -tolFail];
  for (const v of yLabels) {
    const label = v === 0 ? "0" : (v > 0 ? "+" : "") + v.toFixed(2);
    ctx.fillText(label, mLeft - 4, yScale(v));
  }

  // ── X-axis labels (run numbers) ──
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const step = Math.max(1, Math.floor(history.length / 8));
  for (let i = 0; i < history.length; i += step) {
    ctx.fillText(String(history[i].run_id), xScale(i), mTop + plotH + 6);
  }
  // Always show last
  if ((history.length - 1) % step !== 0) {
    ctx.fillText(String(history[history.length - 1].run_id), xScale(history.length - 1), mTop + plotH + 6);
  }
}

/**
 * Render Cpk summary stats into a container element.
 */
export function renderCpkSummary(container, spc) {
  if (!spc || spc.n < 2) {
    container.innerHTML = '<span style="color:#888">Need 2+ runs for SPC</span>';
    return;
  }

  let cpkClass = "cpk-bad";
  if (spc.cpk >= 1.33) cpkClass = "cpk-good";
  else if (spc.cpk >= 1.0) cpkClass = "cpk-marginal";

  container.innerHTML =
    `<span class="${cpkClass}">Cpk ${spc.cpk.toFixed(2)}</span>` +
    ` &nbsp; n=${spc.n} &nbsp; ` +
    `\u03BC=${spc.mean.toFixed(3)} &nbsp; ` +
    `\u03C3=${spc.std.toFixed(3)} &nbsp; ` +
    `range=${spc.range.toFixed(3)}`;
}

/**
 * Fetch parts list and populate the #spc-part-select dropdown.
 * Shows #spc-panel if parts exist. Silently handles 403.
 */
export async function loadSpcParts() {
  const sel = document.getElementById("spc-part-select");
  const panel = document.getElementById("spc-panel");
  if (!sel || !panel) return;

  try {
    const resp = await apiFetch("/parts");
    if (resp.status === 403) return;  // hosted mode
    if (!resp.ok) return;
    const parts = await resp.json();

    // Preserve current selection
    const prev = sel.value;

    sel.innerHTML = '<option value="">Select part...</option>';
    for (const p of parts) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }

    if (parts.length > 0) {
      panel.hidden = false;
    }

    // Restore selection if still valid
    if (prev && sel.querySelector(`option[value="${prev}"]`)) {
      sel.value = prev;
    }
  } catch {
    // network error — ignore silently
  }
}

/**
 * Fetch the latest run for a part and populate #spc-feature-select
 * with unique feature handles from its results.
 */
export async function loadSpcFeatures(partId) {
  const sel = document.getElementById("spc-feature-select");
  if (!sel) return;

  sel.innerHTML = '<option value="">Select feature...</option>';

  if (!partId) return;

  try {
    const resp = await apiFetch(`/parts/${partId}/runs?limit=1`);
    if (!resp.ok) return;
    const runs = await resp.json();
    if (runs.length === 0) return;

    const runResp = await apiFetch(`/runs/${runs[0].id}`);
    if (!runResp.ok) return;
    const run = await runResp.json();

    const handles = new Set();
    for (const r of (run.results || [])) {
      if (r.handle) handles.add(r.handle);
    }

    for (const h of handles) {
      const opt = document.createElement("option");
      opt.value = h;
      opt.textContent = h;
      sel.appendChild(opt);
    }
  } catch {
    // ignore
  }
}

/**
 * Fetch history + SPC stats for a part/feature handle, then render chart + summary.
 */
export async function loadSpcData(partId, handle) {
  const chartCanvas = document.getElementById("spc-chart");
  const cpkContainer = document.getElementById("spc-cpk-summary");
  if (!chartCanvas || !cpkContainer) return;

  if (!partId || !handle) {
    const dctx = chartCanvas.getContext("2d");
    dctx.clearRect(0, 0, chartCanvas.width, chartCanvas.height);
    cpkContainer.innerHTML = "";
    return;
  }

  try {
    const [histResp, spcResp] = await Promise.all([
      apiFetch(`/parts/${partId}/history/${encodeURIComponent(handle)}`),
      apiFetch(`/parts/${partId}/spc/${encodeURIComponent(handle)}`),
    ]);

    if (!histResp.ok || !spcResp.ok) return;

    const history = await histResp.json();
    const spc = await spcResp.json();

    drawTrendChart(chartCanvas, history, {
      tol_warn: spc.tol_warn ?? 0.10,
      tol_fail: spc.tol_fail ?? 0.25,
    });
    renderCpkSummary(cpkContainer, spc);
  } catch {
    // ignore
  }
}
