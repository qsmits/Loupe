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

  const values = [];
  for (let r = row0; r <= row1; r++) {
    for (let c = col0; c <= col1; c++) {
      const idx = r * fr.gridCols + c;
      if (fr.maskGrid[idx]) values.push(fr.heightGrid[idx]);
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

  if (values.length < 2) {
    setMeasureReadout("Not enough valid pixels in area");
    return;
  }

  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const pv = max - min;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const rms = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);

  setMeasureReadout(`Area PV: ${fmtNm(pv)}  RMS: ${fmtNm(rms)}  (${values.length} px)`);
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
      if (fr.measureMode) return; // measurement mode handles its own clicks
      if (smZoom <= 1) return;
      smDragging = true; smDragX = e.clientX - smPanX; smDragY = e.clientY - smPanY;
      viewport.style.cursor = "grabbing";
    });
    window.addEventListener("mousemove", (e) => {
      if (!smDragging) return;
      smPanX = e.clientX - smDragX; smPanY = e.clientY - smDragY;
      applySm();
    });
    window.addEventListener("mouseup", () => {
      smDragging = false; viewport.style.cursor = fr.measureMode ? "crosshair" : "grab";
    });
  }

  // Measurement toolbar
  document.querySelectorAll(".fringe-measure-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".fringe-measure-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const mode = btn.dataset.mode || null;
      fr.measureMode = mode;
      fr.measurePoints = [];
      const viewport = $("fringe-surface-viewport");
      if (viewport) viewport.style.cursor = mode ? "crosshair" : "grab";
      clearMeasureSvg();
      setMeasureReadout("");
      const chart = $("fringe-line-profile-chart");
      if (chart) chart.hidden = true;
      if (!mode) drawPeakValleyMarkers(); // restore markers in pan mode
    });
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
