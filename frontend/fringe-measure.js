// fringe-measure.js — Surface map measurement tools for fringe mode.
import { fr, $ } from './fringe.js';

// ── Utility functions ──────────────────────────────────────────────────

export function setMeasureReadout(text) {
  const el = $("fringe-measure-readout");
  if (el) el.textContent = text;
}

export function clearMeasureSvg() {
  const svg = $("fringe-measure-svg");
  if (svg) svg.innerHTML = "";
}

export function fmtNm(v) {
  if (v === null || v === undefined) return "masked";
  const abs = Math.abs(v);
  if (abs >= 1000) return (v / 1000).toFixed(2) + " µm";
  return v.toFixed(1) + " nm";
}

export function getHeightAt(nx, ny) {
  if (!fr.heightGrid || !fr.maskGrid) return null;
  const col = Math.min(fr.gridCols - 1, Math.max(0, Math.floor(nx * fr.gridCols)));
  const row = Math.min(fr.gridRows - 1, Math.max(0, Math.floor(ny * fr.gridRows)));
  const idx = row * fr.gridCols + col;
  if (!fr.maskGrid[idx]) return null;
  return fr.heightGrid[idx];
}

export function surfaceMouseCoords(e) {
  const imgEl = $("fringe-surface-img");
  if (!imgEl) return null;
  const imgRect = imgEl.getBoundingClientRect();
  const nx = (e.clientX - imgRect.left) / imgRect.width;
  const ny = (e.clientY - imgRect.top) / imgRect.height;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  return { nx, ny };
}

export function findPeakValley() {
  if (!fr.heightGrid || !fr.maskGrid) return null;
  let peakIdx = -1, valleyIdx = -1;
  let peakVal = -Infinity, valleyVal = Infinity;
  for (let i = 0; i < fr.heightGrid.length; i++) {
    if (!fr.maskGrid[i]) continue;
    const v = fr.heightGrid[i];
    if (v > peakVal) { peakVal = v; peakIdx = i; }
    if (v < valleyVal) { valleyVal = v; valleyIdx = i; }
  }
  if (peakIdx < 0 || valleyIdx < 0) return null;
  return {
    peak: {
      nx: ((peakIdx % fr.gridCols) + 0.5) / fr.gridCols,
      ny: (Math.floor(peakIdx / fr.gridCols) + 0.5) / fr.gridRows,
      h: peakVal,
    },
    valley: {
      nx: ((valleyIdx % fr.gridCols) + 0.5) / fr.gridCols,
      ny: (Math.floor(valleyIdx / fr.gridCols) + 0.5) / fr.gridRows,
      h: valleyVal,
    },
  };
}

export function drawPeakValleyMarkers() {
  const pv = findPeakValley();
  if (!pv) return;
  const svg = $("fringe-measure-svg");
  const imgEl = $("fringe-surface-img");
  if (!svg || !imgEl) return;
  if (fr.measureMode) return; // don't draw when measurement mode is active

  const w = imgEl.clientWidth;
  const h = imgEl.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const px = pv.peak.nx * w, py = pv.peak.ny * h;
  const vx = pv.valley.nx * w, vy = pv.valley.ny * h;

  svg.innerHTML = `
    <g>
      <polygon points="${px},${py - 10} ${px - 6},${py} ${px + 6},${py}"
        fill="#ff4d6d" stroke="#000" stroke-width="0.5"/>
      <text x="${px + 10}" y="${py - 2}" fill="#ff4d6d" font-size="10"
        font-weight="600" stroke="#000" stroke-width="2" paint-order="stroke">▲ ${fmtNm(pv.peak.h)}</text>
      <polygon points="${vx},${vy + 10} ${vx - 6},${vy} ${vx + 6},${vy}"
        fill="#4a9eff" stroke="#000" stroke-width="0.5"/>
      <text x="${vx + 10}" y="${vy + 14}" fill="#4a9eff" font-size="10"
        font-weight="600" stroke="#000" stroke-width="2" paint-order="stroke">▼ ${fmtNm(pv.valley.h)}</text>
    </g>
  `;
}

// ── Measurement tool handlers ──────────────────────────────────────────

export function drawCursorCrosshair(nx, ny) {
  const svg = $("fringe-measure-svg");
  const imgEl = $("fringe-surface-img");
  if (!svg || !imgEl) return;
  const w = imgEl.clientWidth;
  const h = imgEl.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const x = nx * w;
  const y = ny * h;
  const height = getHeightAt(nx, ny);
  const label = height !== null ? fmtNm(height) : "—";
  // Position label to avoid clipping at edges
  const labelX = x + 12;
  const labelY = y - 12;
  svg.innerHTML = `
    <line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#fff" stroke-width="0.5" opacity="0.5"/>
    <line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#fff" stroke-width="0.5" opacity="0.5"/>
    <circle cx="${x}" cy="${y}" r="4" fill="none" stroke="#0a84ff" stroke-width="1.5"/>
    <rect x="${labelX - 2}" y="${labelY - 13}" width="${label.length * 7 + 8}" height="17"
          rx="3" fill="rgba(0,0,0,0.8)"/>
    <text x="${labelX + 2}" y="${labelY}" fill="#0a84ff" font-size="11" font-weight="600">${label}</text>
  `;
}

export function handlePoint2PointClick(coords) {
  const h = getHeightAt(coords.nx, coords.ny);
  if (h === null) { setMeasureReadout("Clicked on masked area"); return; }

  fr.measurePoints.push({ ...coords, h });

  if (fr.measurePoints.length === 1) {
    setMeasureReadout(`Point 1: ${fmtNm(h)} — click second point`);
    drawMeasurePoints();
  } else {
    const p1 = fr.measurePoints[0];
    const p2 = fr.measurePoints[1];
    const delta = p2.h - p1.h;
    setMeasureReadout(`Δh = ${fmtNm(delta)}  (${fmtNm(p1.h)} → ${fmtNm(p2.h)})`);
    drawMeasurePoints();
    fr.measurePoints = [];
  }
}

export function drawMeasurePoints() {
  const svg = $("fringe-measure-svg");
  const imgEl = $("fringe-surface-img");
  if (!svg || !imgEl) return;
  const w = imgEl.clientWidth;
  const h = imgEl.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  let html = "";
  for (let i = 0; i < fr.measurePoints.length; i++) {
    const p = fr.measurePoints[i];
    const x = p.nx * w;
    const y = p.ny * h;
    const color = i === 0 ? "#ff4d6d" : "#7cff7c";
    const label = i === 0 ? "1" : "2";
    html += `<circle cx="${x}" cy="${y}" r="6" fill="none" stroke="${color}" stroke-width="2"/>`;
    html += `<text x="${x + 10}" y="${y - 6}" fill="${color}" font-size="12" font-weight="bold">${label}: ${fmtNm(p.h)}</text>`;
  }

  if (fr.measurePoints.length === 2) {
    const p1 = fr.measurePoints[0];
    const p2 = fr.measurePoints[1];
    html += `<line x1="${p1.nx * w}" y1="${p1.ny * h}" x2="${p2.nx * w}" y2="${p2.ny * h}"
              stroke="#fff" stroke-width="1" stroke-dasharray="4,3" opacity="0.7"/>`;
    const mx = (p1.nx + p2.nx) / 2 * w;
    const my = (p1.ny + p2.ny) / 2 * h;
    const delta = p2.h - p1.h;
    html += `<rect x="${mx - 2}" y="${my - 16}" width="${fmtNm(delta).length * 7 + 10}" height="18"
              rx="3" fill="rgba(0,0,0,0.75)"/>`;
    html += `<text x="${mx + 4}" y="${my - 2}" fill="#fff" font-size="11" font-weight="600">Δ ${fmtNm(delta)}</text>`;
  }

  svg.innerHTML = html;
}

export function handleLineProfileClick(coords) {
  const h = getHeightAt(coords.nx, coords.ny);
  if (h === null) { setMeasureReadout("Clicked on masked area"); return; }

  fr.measurePoints.push({ ...coords, h });

  if (fr.measurePoints.length === 1) {
    setMeasureReadout("Click second point to draw profile line");
    drawMeasurePoints();
  } else {
    const p1 = fr.measurePoints[0];
    const p2 = fr.measurePoints[1];
    drawProfileLine(p1, p2);
    fr.measurePoints = [];
  }
}

export function drawProfileLine(p1, p2) {
  const nSamples = 200;
  const samples = [];
  for (let i = 0; i <= nSamples; i++) {
    const t = i / nSamples;
    const nx = p1.nx + t * (p2.nx - p1.nx);
    const ny = p1.ny + t * (p2.ny - p1.ny);
    const h = getHeightAt(nx, ny);
    samples.push(h);
  }

  const svg = $("fringe-measure-svg");
  const imgEl = $("fringe-surface-img");
  if (svg && imgEl) {
    const w = imgEl.clientWidth;
    const h = imgEl.clientHeight;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const x1 = p1.nx * w, y1 = p1.ny * h;
    const x2 = p2.nx * w, y2 = p2.ny * h;
    svg.innerHTML = `
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
        stroke="#0a84ff" stroke-width="2" opacity="0.8"/>
      <circle cx="${x1}" cy="${y1}" r="5" fill="#ff4d6d" stroke="#000" stroke-width="1"/>
      <circle cx="${x2}" cy="${y2}" r="5" fill="#7cff7c" stroke="#000" stroke-width="1"/>
    `;
  }

  const valid = samples.filter(v => v !== null);
  if (valid.length < 2) {
    setMeasureReadout("Not enough valid points on line");
    return;
  }
  let lineMin = Infinity, lineMax = -Infinity;
  for (const v of valid) { if (v < lineMin) lineMin = v; if (v > lineMax) lineMax = v; }
  const linePV = lineMax - lineMin;
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const rms = Math.sqrt(valid.reduce((a, v) => a + (v - mean) ** 2, 0) / valid.length);
  setMeasureReadout(`Line PV: ${fmtNm(linePV)}  RMS: ${fmtNm(rms)}`);

  drawLineProfileChart(samples);
}

export function drawLineProfileChart(samples) {
  const canvas = $("fringe-line-profile-chart");
  if (!canvas) return;
  canvas.hidden = false;

  const container = canvas.parentElement;
  if (container) canvas.width = container.clientWidth - 24;
  canvas.height = 150;

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = "#1c1c1e";
  ctx.fillRect(0, 0, w, h);

  const valid = samples.map((v, i) => v !== null ? { i, v } : null).filter(Boolean);
  if (valid.length < 2) return;

  const vMin = Math.min(...valid.map(d => d.v));
  const vMax = Math.max(...valid.map(d => d.v));
  const vRange = vMax - vMin || 1;

  const padL = 60, padR = 16, padT = 20, padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  ctx.strokeStyle = "#3a3a3c";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#ababab";
  ctx.font = "9px -apple-system, sans-serif";
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    const v = vMax - (vRange * i) / 4;
    ctx.fillText(fmtNm(v), 2, y + 3);
  }

  ctx.fillStyle = "#e8e8e8";
  ctx.font = "11px -apple-system, sans-serif";
  ctx.fillText("Line Profile", padL, 14);

  ctx.strokeStyle = "#4a9eff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (v === null) { started = false; continue; }
    const x = padL + (i / (samples.length - 1)) * plotW;
    const y = padT + ((vMax - v) / vRange) * plotH;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

export function handleAreaClick(coords) {
  fr.measurePoints.push(coords);

  if (fr.measurePoints.length === 1) {
    setMeasureReadout("Click second corner for area stats");
  } else {
    const p1 = fr.measurePoints[0];
    const p2 = fr.measurePoints[1];
    computeAreaStats(p1, p2);
    fr.measurePoints = [];
  }
}

export function computeAreaStats(p1, p2) {
  const x0 = Math.min(p1.nx, p2.nx);
  const y0 = Math.min(p1.ny, p2.ny);
  const x1 = Math.max(p1.nx, p2.nx);
  const y1 = Math.max(p1.ny, p2.ny);

  const col0 = Math.max(0, Math.floor(x0 * fr.gridCols));
  const col1 = Math.min(fr.gridCols - 1, Math.floor(x1 * fr.gridCols));
  const row0 = Math.max(0, Math.floor(y0 * fr.gridRows));
  const row1 = Math.min(fr.gridRows - 1, Math.floor(y1 * fr.gridRows));

  // M1.6: when fr.useTrustedOnly is on, restrict inclusion to the
  // trusted subset of the analysis mask.
  const m = fr.useTrustedOnly && fr.trustedMaskGrid ? fr.trustedMaskGrid : fr.maskGrid;
  const useTrusted = fr.useTrustedOnly && !!fr.trustedMaskGrid;

  const values = [];
  for (let r = row0; r <= row1; r++) {
    for (let c = col0; c <= col1; c++) {
      const idx = r * fr.gridCols + c;
      if (m[idx]) values.push(fr.heightGrid[idx]);
    }
  }

  const svg = $("fringe-measure-svg");
  const imgEl = $("fringe-surface-img");
  if (svg && imgEl) {
    const w = imgEl.clientWidth;
    const h = imgEl.clientHeight;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.innerHTML = `
      <rect x="${x0 * w}" y="${y0 * h}" width="${(x1 - x0) * w}" height="${(y1 - y0) * h}"
        fill="rgba(10,132,255,0.1)" stroke="#0a84ff" stroke-width="1.5" stroke-dasharray="5,3"/>
    `;
  }

  // Cache last area corners so we can refresh on trusted-only toggle.
  fr.lastAreaRect = { p1: { nx: p1.nx, ny: p1.ny }, p2: { nx: p2.nx, ny: p2.ny } };

  if (values.length < 2) {
    setMeasureReadout("Not enough valid pixels in area");
    return;
  }

  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const pv = max - min;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const rms = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);

  const trustedTag = useTrusted
    ? ' <span class="fringe-stat-trusted" style="color:#ff9f0a;font-weight:600" title="Computed from trusted pixels only">(trusted)</span>'
    : "";
  const readout = $("fringe-measure-readout");
  if (readout) {
    readout.innerHTML = `Area PV: ${fmtNm(pv)}  RMS: ${fmtNm(rms)}  (${values.length} px)${trustedTag}`;
  } else {
    setMeasureReadout(`Area PV: ${fmtNm(pv)}  RMS: ${fmtNm(rms)}  (${values.length} px)`);
  }

  // M4.1: tag the recorded area measurement with the active workflow mode.
  if (!Array.isArray(fr.measurements)) fr.measurements = [];
  fr.measurements.push({
    kind: "area",
    mode: fr.mode || "surface",
    captured_at: new Date().toISOString(),
    x0, y0, x1, y1,
    pv_nm: pv,
    rms_nm: rms,
    n_pixels: values.length,
    trusted_only: useTrusted,
  });
}

// ── Step tool (mean height difference between two regions) ─────────────
//
// Step tool — measures the mean height difference between two rectangular
// regions on a fringe-analyzed surface. It's a post-processing step on
// an already-unwrapped height map, so its correctness inherits from the
// underlying single-analysis unwrap. Valid for:
//   - smooth surfaces where the 2D unwrap is unambiguous (flats, bumps)
//   - sharp steps smaller than λ/4 (~158 nm for He-Ne)
// It is NOT valid for larger step heights: single-shot single-wavelength
// interferometry cannot resolve the integer-λ/2 ambiguity, and no amount
// of post-processing recovers the correct step from the wrapped data.
// When |step| > λ/4 the readout shows an aliasing warning; the displayed
// number could equally correspond to step ± n·λ/2 for any integer n.
//
// Uncertainty: the ±σ we report is an "effective-N" standard error of the
// mean, derived from the region RMS and the number of *independent* grid
// cells (not the raw cell count). The demodulation LPF correlates neighbor
// pixels over roughly π·(2.5·fringe_period_px)² of original-image area, so
// the naive RMS/√N would be wildly over-optimistic. We divide N by the
// number of grid cells per LPF correlation area to get an effective N,
// then compute σ_mean = RMS / √N_eff and σ_step = √(σ_A² + σ_B²).
// This is still just a scatter-based indicator — it doesn't include
// carrier-estimation bias, unwrap errors, or systematic tilt/curvature.

const STEP_COLORS = ["#00d4ff", "#ff9944"];

// Gaussian LPF σ used by the backend demodulator (in original-image pixels)
// is roughly `lpf_sigma_frac` × fringe_period_px. Legacy default (and
// "auto" mode) is 2.5; M2.5 lets the user override via the analyze body.
//
// M2.6 — anisotropic LPF preserves correlation-area geometric mean, so the
// isotropic-equivalent area (π·σ_iso²) is the right input here.
// σ_iso = lpf_sigma_frac × fringe_period_px when the multiplier is in
// "auto"; otherwise the user-set value. Per-axis: σ_along ≈ 0.71·sigma_frac
// ·period, σ_across ≈ 1.41·sigma_frac·period, so √(0.71·1.41) ≈ 1.0 and
// the correlation *area* (π·σ_along·σ_across) matches the isotropic case.
// The shape is now elliptical along the carrier, but for SEM-of-mean over
// a rectangular ROI the area-based effective-N estimate remains correct
// (within the worst-case orientation we already tolerate).
const LPF_SIGMA_FACTOR_LEGACY = 2.5;

function _normRect(p1, p2) {
  return {
    x0: Math.min(p1.nx, p2.nx),
    y0: Math.min(p1.ny, p2.ny),
    x1: Math.max(p1.nx, p2.nx),
    y1: Math.max(p1.ny, p2.ny),
  };
}

/**
 * Estimate how many grid cells fall inside one LPF correlation area.
 * Returns 1.0 if we can't compute it (no carrier info) — which makes the
 * effective-N SEM degenerate to the naive RMS/√N.
 */
function _corrCellsPerLpf() {
  const lr = fr.lastResult;
  if (!lr || !lr.carrier || !fr.gridCols || !fr.gridRows) return 1.0;
  const period = Number(lr.carrier.fringe_period_px);
  const imgW = Number(lr.image_width || lr.surface_width);
  const imgH = Number(lr.image_height || lr.surface_height);
  if (!(period > 1) || !(imgW > 0) || !(imgH > 0)) return 1.0;

  // M2.5/M2.6: read the actually-applied LPF multiplier from the server
  // echo. tuning.lpf_sigma_frac === null means "auto" (legacy 2.5). The
  // anisotropic LPF preserves correlation-area geometric mean, so this
  // isotropic-equivalent computation remains correct.
  const tuning = lr.tuning || {};
  const sigmaFrac = (tuning.lpf_sigma_frac != null && Number.isFinite(Number(tuning.lpf_sigma_frac)))
    ? Number(tuning.lpf_sigma_frac)
    : LPF_SIGMA_FACTOR_LEGACY;

  const sigma = sigmaFrac * period;                    // original-image px (σ_iso)
  const corrAreaPx = Math.PI * sigma * sigma;          // original-image px²
  const cellArea = (imgW * imgH) / (fr.gridCols * fr.gridRows);
  if (!(cellArea > 0)) return 1.0;
  return Math.max(1, corrAreaPx / cellArea);
}

/**
 * Compute mean/RMS/N over valid pixels inside a normalized rectangle.
 *
 * Returns:
 *   mean      — arithmetic mean of height values (nm)
 *   rms       — RMS of deviations from mean (nm), aka region scatter
 *   n         — raw count of valid grid cells in the rectangle
 *   nEff      — effective number of *independent* cells, = n / corr_cells_per_lpf.
 *               Clamped to ≥1 so the SEM never blows up on tiny regions.
 *   sem       — RMS / √nEff  (effective-N standard error of the mean, nm)
 *   semNaive  — RMS / √n     (the over-optimistic version, kept for debug only)
 */
export function regionStats(rect) {
  if (!fr.heightGrid || !fr.maskGrid || !fr.gridCols || !fr.gridRows) {
    return { mean: null, rms: null, n: 0, nEff: 0, sem: null, semNaive: null };
  }
  // M1.6: when fr.useTrustedOnly is on, restrict inclusion to the
  // trusted subset of the analysis mask.
  const m = fr.useTrustedOnly && fr.trustedMaskGrid ? fr.trustedMaskGrid : fr.maskGrid;

  const col0 = Math.max(0, Math.floor(rect.x0 * fr.gridCols));
  const col1 = Math.min(fr.gridCols - 1, Math.floor(rect.x1 * fr.gridCols));
  const row0 = Math.max(0, Math.floor(rect.y0 * fr.gridRows));
  const row1 = Math.min(fr.gridRows - 1, Math.floor(rect.y1 * fr.gridRows));

  let sum = 0, n = 0;
  for (let r = row0; r <= row1; r++) {
    for (let c = col0; c <= col1; c++) {
      const idx = r * fr.gridCols + c;
      if (m[idx]) { sum += fr.heightGrid[idx]; n++; }
    }
  }
  if (n === 0) return { mean: null, rms: null, n: 0, nEff: 0, sem: null, semNaive: null };
  const mean = sum / n;

  let sq = 0;
  for (let r = row0; r <= row1; r++) {
    for (let c = col0; c <= col1; c++) {
      const idx = r * fr.gridCols + c;
      if (m[idx]) {
        const d = fr.heightGrid[idx] - mean;
        sq += d * d;
      }
    }
  }
  const rms = Math.sqrt(sq / n);
  const semNaive = n > 1 ? rms / Math.sqrt(n) : rms;
  const corrCells = _corrCellsPerLpf();
  const nEff = Math.max(1, n / corrCells);
  const sem = rms / Math.sqrt(nEff);
  return { mean, rms, n, nEff, sem, semNaive };
}

function _fmtSigned(v) {
  if (v === null || v === undefined) return "\u2014";
  const s = v >= 0 ? "+" : "";
  return s + fmtNm(v);
}

function _pointInRect(nx, ny, rect) {
  return nx >= rect.x0 && nx <= rect.x1 && ny >= rect.y0 && ny <= rect.y1;
}

export function drawStepRegions(previewRect) {
  const svg = $("fringe-measure-svg");
  const imgEl = $("fringe-surface-img");
  if (!svg || !imgEl) return;
  const w = imgEl.clientWidth;
  const h = imgEl.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  let html = "";
  for (let i = 0; i < fr.stepRegions.length; i++) {
    const r = fr.stepRegions[i];
    const color = STEP_COLORS[i];
    const label = i === 0 ? "A" : "B";
    const x = r.x0 * w, y = r.y0 * h;
    const rw = (r.x1 - r.x0) * w, rh = (r.y1 - r.y0) * h;
    const fill = i === 0 ? "rgba(0,212,255,0.12)" : "rgba(255,153,68,0.12)";
    html += `<rect x="${x}" y="${y}" width="${rw}" height="${rh}"
              fill="${fill}" stroke="${color}" stroke-width="1.75" stroke-dasharray="5,3"/>`;
    html += `<rect x="${x + 2}" y="${y + 2}" width="16" height="14" rx="2"
              fill="rgba(0,0,0,0.75)" stroke="${color}" stroke-width="1"/>`;
    html += `<text x="${x + 10}" y="${y + 13}" text-anchor="middle" fill="${color}"
              font-size="11" font-weight="700">${label}</text>`;
  }
  if (previewRect) {
    const idx = fr.stepRegions.length; // which slot is being drawn
    const color = STEP_COLORS[idx] || "#ffffff";
    const fill = idx === 0 ? "rgba(0,212,255,0.10)" : "rgba(255,153,68,0.10)";
    const x = previewRect.x0 * w, y = previewRect.y0 * h;
    const rw = (previewRect.x1 - previewRect.x0) * w;
    const rh = (previewRect.y1 - previewRect.y0) * h;
    html += `<rect x="${x}" y="${y}" width="${rw}" height="${rh}"
              fill="${fill}" stroke="${color}" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.7"/>`;
  }
  svg.innerHTML = html;
}

export function updateStepReadout() {
  const readout = $("fringe-measure-readout");
  if (!readout) return;
  const n = fr.stepRegions.length;
  const header = "Step (A\u2212B) \u2014 valid for small steps only";
  if (n === 0) {
    setMeasureReadout(`${header}  \u2192 drag to mark Region A (reference)`);
    return;
  }
  const sA = regionStats(fr.stepRegions[0]);
  if (n === 1) {
    const aDesc = sA.n > 0
      ? `A: mean=${fmtNm(sA.mean)} \u03c3 region=${fmtNm(sA.rms)} N=${sA.n}`
      : "A: empty";
    setMeasureReadout(`${header}  \u2014  ${aDesc}  \u2192 drag Region B`);
    return;
  }
  const sB = regionStats(fr.stepRegions[1]);
  if (sA.n === 0 || sB.n === 0) {
    const which = sA.n === 0 ? "A" : "B";
    setMeasureReadout(`${header}  \u2014  Region ${which} is empty \u2014 reposition or clear (Esc)`);
    return;
  }
  const step = sA.mean - sB.mean;
  // Effective-N SEM combination. sA.sem is RMS / √N_eff, which accounts
  // for the demodulation LPF correlating neighbor cells. Still scatter-only
  // — excludes carrier/unwrap/tilt bias.
  const sigmaStep = Math.sqrt(sA.sem * sA.sem + sB.sem * sB.sem);
  const wl = (fr.lastResult && fr.lastResult.wavelength_nm) || 0;
  const inWaves = wl > 0 ? ` [${(step / wl).toFixed(3)} \u03bb]` : "";

  // λ/4 aliasing warning. Single-shot single-wavelength interferometry
  // can't distinguish step from step ± n·λ/2. The warning fires on |step|
  // > λ/4 (the conservative threshold: at λ/4 an adversarial noise step
  // already wraps, and above λ/4 even ideal unwrap can't recover the
  // correct integer-fringe offset).
  let warnHtml = "";
  const aliased = wl > 0 && Math.abs(step) > wl / 4;
  if (aliased) {
    const quarterWl = wl / 4;
    warnHtml = `  <span style="background:#ff453a;color:#fff;font-weight:700;padding:2px 6px;border-radius:3px;margin-left:6px" title="Single-shot single-wavelength interferometry cannot distinguish this from a step of step \u00b1 n\u00b7\u03bb/2. The reported number is whatever the 2D unwrap happened to produce; it is not traceable to the true step.">\u26a0 |step| &gt; \u03bb/4 (${quarterWl.toFixed(0)} nm) \u2014 may be aliased by 2\u03c0 ambiguity</span>`;
  }

  const aSemTitle = `Effective-N SEM: RMS / \u221aN_eff where N_eff corrects for the demodulation LPF (\u03c3 \u2248 2.5\u00b7fringe_period) correlating neighbor cells. Scatter-only; excludes carrier/unwrap/tilt bias.`;
  const bSemTitle = aSemTitle;
  const stepSemTitle = `Effective-N uncertainty: \u221a(\u03c3_A\u00b2 + \u03c3_B\u00b2), each using RMS / \u221aN_eff. Scatter-only \u2014 not a full metrology uncertainty.`;

  // M1.6 — trusted-only tag (matches PV/RMS summary styling).
  const useTrusted = fr.useTrustedOnly && !!fr.trustedMaskGrid;
  const trustedTag = useTrusted
    ? ' <span class="fringe-stat-trusted" style="color:#ff9f0a;font-weight:600" title="Computed from trusted pixels only">(trusted)</span>'
    : "";

  // Rendered as HTML so we can include the warning badge and help tooltips.
  const html =
    `<strong>${header}${trustedTag}</strong>` +
    `  \u2014  A: ${fmtNm(sA.mean)} ` +
    `<span title="${aSemTitle}">(\u00b1${fmtNm(sA.sem)} eff-N, \u03c3 region=${fmtNm(sA.rms)}, N=${sA.n}, N_eff=${sA.nEff.toFixed(1)})</span>` +
    `  |  B: ${fmtNm(sB.mean)} ` +
    `<span title="${bSemTitle}">(\u00b1${fmtNm(sB.sem)} eff-N, \u03c3 region=${fmtNm(sB.rms)}, N=${sB.n}, N_eff=${sB.nEff.toFixed(1)})</span>` +
    `  |  step = ${_fmtSigned(step)} ` +
    `<span title="${stepSemTitle}">\u00b1 ${fmtNm(sigmaStep)} eff-N</span>` +
    `${inWaves}` +
    warnHtml;
  readout.innerHTML = html;
}

/**
 * M1.6 — refresh whatever Step/Area measurement is currently committed.
 * Called by the trusted-only checkbox handler in fringe-results.js so that
 * a displayed Step or Area readout updates in place when the user toggles
 * the inclusion mask. No-op when no measurement is currently committed.
 */
export function refreshLastMeasurement() {
  if (fr.measureMode === "step" && Array.isArray(fr.stepRegions) && fr.stepRegions.length === 2) {
    updateStepReadout();
    return;
  }
  if (fr.measureMode === "area" && fr.lastAreaRect) {
    computeAreaStats(fr.lastAreaRect.p1, fr.lastAreaRect.p2);
  }
}

/** Called on mousedown during step mode. Returns true if handled (drag started). */
function _stepMouseDown(coords) {
  // If both rects exist and click is inside one, begin translating it.
  if (fr.stepRegions.length === 2) {
    for (let i = 0; i < 2; i++) {
      const r = fr.stepRegions[i];
      if (_pointInRect(coords.nx, coords.ny, r)) {
        fr.stepDragIdx = i;
        fr.stepDragOffset = { dx: coords.nx - r.x0, dy: coords.ny - r.y0 };
        return true;
      }
    }
  }
  return false;
}

/** Reset any in-progress step drag state. */
export function resetStepDrag() {
  fr.stepDragIdx = -1;
  fr.stepDragOffset = null;
}

/** Clear all step regions and readout. */
export function clearStepMeasurement() {
  fr.stepRegions = [];
  fr.measurePoints = [];
  resetStepDrag();
  clearMeasureSvg();
  if (fr.measureMode === "step") {
    updateStepReadout();
  }
}

export function resetSurfaceZoom() {
  if (fr.resetSurfaceZoom) fr.resetSurfaceZoom();
}

// ── Event wiring ───────────────────────────────────────────────────────

export function wireMeasureEvents() {
  // Surface map zoom/pan
  const viewport = $("fringe-surface-viewport");
  if (viewport) {
    let smZoom = 1, smPanX = 0, smPanY = 0, smDragging = false, smDragX = 0, smDragY = 0;
    const applySm = () => {
      const wrapper = $("fringe-surface-wrapper");
      if (wrapper) wrapper.style.transform = `translate(${smPanX}px,${smPanY}px) scale(${smZoom})`;
    };
    // Expose reset so new results can clear zoom/pan state
    fr.resetSurfaceZoom = () => {
      smZoom = 1; smPanX = 0; smPanY = 0;
      applySm();
    };
    viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const prev = smZoom;
      smZoom = Math.max(0.2, Math.min(10, smZoom + (e.deltaY < 0 ? 0.3 : -0.3)));
      if (smZoom <= 1) { smPanX = 0; smPanY = 0; }
      else {
        // Zoom toward cursor: keep the point under the mouse fixed
        const rect = viewport.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const ratio = smZoom / prev;
        smPanX = mx - ratio * (mx - smPanX);
        smPanY = my - ratio * (my - smPanY);
      }
      applySm();
    });
    viewport.addEventListener("mousedown", (e) => {
      e.preventDefault(); // prevent native image drag
      if (fr.measureMode === "step") {
        // Step tool: mousedown either starts dragging an existing region or begins drawing a new one.
        const coords = surfaceMouseCoords(e);
        if (!coords) return;
        if (_stepMouseDown(coords)) {
          // translate-drag initiated; nothing else to do here
        } else if (fr.stepRegions.length < 2) {
          // Start drawing a new rectangle
          fr.measurePoints = [coords];
        } else {
          // Clicking outside both existing rects with two already drawn: restart.
          fr.stepRegions = [];
          fr.measurePoints = [coords];
          drawStepRegions(null);
          updateStepReadout();
        }
        return;
      }
      if (fr.measureMode) return; // other measurement modes handle their own clicks
      if (smZoom <= 1) return;
      smDragging = true; smDragX = e.clientX - smPanX; smDragY = e.clientY - smPanY;
      viewport.style.cursor = "grabbing";
    });
    window.addEventListener("mousemove", (e) => {
      if (!smDragging) return;
      smPanX = e.clientX - smDragX; smPanY = e.clientY - smDragY;
      applySm();
    });
    window.addEventListener("mouseup", (e) => {
      smDragging = false; viewport.style.cursor = fr.measureMode ? "crosshair" : "grab";
      if (fr.measureMode !== "step") return;

      // Finish a translate-drag.
      if (fr.stepDragIdx >= 0) {
        resetStepDrag();
        drawStepRegions(null);
        updateStepReadout();
        return;
      }
      // Commit a new rectangle drawn with mousedown..mouseup.
      if (fr.measurePoints.length === 1) {
        const coords = surfaceMouseCoords(e);
        if (!coords) {
          // released outside viewport — abort this draw
          fr.measurePoints = [];
          drawStepRegions(null);
          return;
        }
        const rect = _normRect(fr.measurePoints[0], coords);
        // Ignore trivially small rects (accidental click).
        if ((rect.x1 - rect.x0) < 0.005 || (rect.y1 - rect.y0) < 0.005) {
          fr.measurePoints = [];
          drawStepRegions(null);
          return;
        }
        fr.stepRegions.push(rect);
        fr.measurePoints = [];
        drawStepRegions(null);
        updateStepReadout();
        // M4.1: when a Step measurement is committed (both regions defined),
        // tag the recorded measurement with the active workflow mode so
        // saved/exported values carry their mode of origin.
        if (fr.stepRegions.length === 2) {
          if (!Array.isArray(fr.measurements)) fr.measurements = [];
          fr.measurements.push({
            kind: "step",
            mode: fr.mode || "surface",
            captured_at: new Date().toISOString(),
            regions: [{ ...fr.stepRegions[0] }, { ...fr.stepRegions[1] }],
          });
        }
      }
    });
  }

  // Measurement toolbar
  document.querySelectorAll(".fringe-measure-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".fringe-measure-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const prevMode = fr.measureMode;
      const mode = btn.dataset.mode || null;
      fr.measureMode = mode;
      fr.measurePoints = [];
      // Forget any cached area rectangle when leaving area mode.
      if (mode !== "area") fr.lastAreaRect = null;
      resetStepDrag();
      const viewport = $("fringe-surface-viewport");
      if (viewport) viewport.style.cursor = mode ? "crosshair" : "grab";
      const chart = $("fringe-line-profile-chart");
      if (chart) chart.hidden = true;

      if (mode === "step") {
        // Keep any existing step regions visible; just refresh.
        drawStepRegions(null);
        updateStepReadout();
      } else if (prevMode === "step" && mode !== "step") {
        // Switching away from step: leave regions drawn & readable but inert.
        // (No-op; SVG already reflects final state.)
      } else {
        // Normal modes: clear overlays/readout and, in pan, restore PV markers.
        clearMeasureSvg();
        setMeasureReadout("");
        if (!mode) drawPeakValleyMarkers();
      }
    });
  });

  // Esc clears in-progress/committed step measurement.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && fr.measureMode === "step") {
      clearStepMeasurement();
    }
  });

  // Surface measurement mouse events
  if (viewport) {
    viewport.addEventListener("mousemove", (e) => {
      const coords = surfaceMouseCoords(e);
      if (!coords) return;

      if (fr.measureMode === "cursor") {
        const h = getHeightAt(coords.nx, coords.ny);
        setMeasureReadout(h !== null ? `Height: ${fmtNm(h)}` : "Masked");
        drawCursorCrosshair(coords.nx, coords.ny);
      } else if (fr.measureMode === "area" && fr.measurePoints.length === 1) {
        const p1 = fr.measurePoints[0];
        const svg = $("fringe-measure-svg");
        const imgEl = $("fringe-surface-img");
        if (svg && imgEl) {
          const w = imgEl.clientWidth;
          const h = imgEl.clientHeight;
          svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
          const x0 = Math.min(p1.nx, coords.nx) * w;
          const y0 = Math.min(p1.ny, coords.ny) * h;
          const rw = Math.abs(coords.nx - p1.nx) * w;
          const rh = Math.abs(coords.ny - p1.ny) * h;
          svg.innerHTML = `<rect x="${x0}" y="${y0}" width="${rw}" height="${rh}"
            fill="rgba(10,132,255,0.1)" stroke="#0a84ff" stroke-width="1.5" stroke-dasharray="5,3"/>`;
        }
      } else if (fr.measureMode === "step") {
        if (fr.stepDragIdx >= 0 && fr.stepDragOffset) {
          // Translate an existing region, clamped to [0,1].
          const r = fr.stepRegions[fr.stepDragIdx];
          const w = r.x1 - r.x0, h = r.y1 - r.y0;
          let nx0 = coords.nx - fr.stepDragOffset.dx;
          let ny0 = coords.ny - fr.stepDragOffset.dy;
          nx0 = Math.max(0, Math.min(1 - w, nx0));
          ny0 = Math.max(0, Math.min(1 - h, ny0));
          r.x0 = nx0; r.y0 = ny0; r.x1 = nx0 + w; r.y1 = ny0 + h;
          drawStepRegions(null);
          updateStepReadout();
        } else if (fr.measurePoints.length === 1) {
          // Rubber-band preview while drawing a new rectangle.
          const preview = _normRect(fr.measurePoints[0], coords);
          drawStepRegions(preview);
        }
      } else if (fr.measureMode === "lineProfile" && fr.measurePoints.length === 1) {
        const p1 = fr.measurePoints[0];
        const svg = $("fringe-measure-svg");
        const imgEl = $("fringe-surface-img");
        if (svg && imgEl) {
          const w = imgEl.clientWidth;
          const h = imgEl.clientHeight;
          svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
          svg.innerHTML = `
            <line x1="${p1.nx * w}" y1="${p1.ny * h}" x2="${coords.nx * w}" y2="${coords.ny * h}"
              stroke="#0a84ff" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.6"/>
            <circle cx="${p1.nx * w}" cy="${p1.ny * h}" r="5" fill="#ff4d6d" stroke="#000" stroke-width="1"/>`;
        }
      }
    });

    viewport.addEventListener("mouseleave", () => {
      if (fr.measureMode === "cursor") {
        setMeasureReadout("");
        clearMeasureSvg();
      }
    });

    viewport.addEventListener("click", (e) => {
      if (!fr.measureMode || fr.measureMode === "cursor") return;
      if (fr.measureMode === "step") return; // step uses mousedown/mouseup drag
      const coords = surfaceMouseCoords(e);
      if (!coords) return;

      if (fr.measureMode === "point2point") {
        handlePoint2PointClick(coords);
      } else if (fr.measureMode === "lineProfile") {
        handleLineProfileClick(coords);
      } else if (fr.measureMode === "area") {
        handleAreaClick(coords);
      }
    });
  } // end if (viewport) — measurement events
}
