// fringe-trend.js — In-session trend chart (M4.5).
//
// Renders a small inline-SVG line chart of PV (nm) and RMS (nm) over
// time for the captures in the current session. No dependencies.
//
// Usage:
//   import { renderTrend } from './fringe-trend.js';
//   renderTrend(document.getElementById('fringe-trend-host'),
//               fr.sessionCaptures,
//               { groupBy: 'none' });

const COLORS = {
  pv: "#ff9f0a",
  rms: "#4fc3f7",
  axis: "rgba(255,255,255,0.45)",
  grid: "rgba(255,255,255,0.08)",
  group: ["#4fc3f7", "#ff9f0a", "#30d158", "#bf5af2", "#5e5ce6", "#ff453a"],
};

function _esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function _emptyState(host, msg) {
  host.innerHTML = `<div style="display:flex;height:100%;align-items:center;justify-content:center;opacity:0.6;font-size:12px;padding:24px;text-align:center">${_esc(msg)}</div>`;
}

/**
 * Render a PV/RMS trend chart into the given container.
 *
 * @param {HTMLElement} containerEl Host element. Will be cleared.
 * @param {Array} captures Array of capture summaries (from
 *   /fringe/session/captures or fr.sessionCaptures). Each must have
 *   `pv_nm`, `rms_nm`, `captured_at`. Optional: `calibration_snapshot.name`,
 *   `origin`.
 * @param {Object} [opts] Optional rendering options.
 * @param {string} [opts.groupBy] One of "none", "calibration", "origin".
 *   When set, draws one line per group; legend lists each group.
 */
export function renderTrend(containerEl, captures, opts = {}) {
  if (!containerEl) return;
  const groupBy = opts.groupBy || "none";

  const usable = (Array.isArray(captures) ? captures : [])
    .filter(c => Number.isFinite(c.pv_nm) || Number.isFinite(c.rms_nm))
    .map((c, i) => ({
      ...c,
      _index: i + 1,
      _ts: c.captured_at ? Date.parse(c.captured_at) : i,
      pv_nm: Number(c.pv_nm),
      rms_nm: Number(c.rms_nm),
    }))
    .sort((a, b) => (a._ts || 0) - (b._ts || 0));

  if (usable.length < 2) {
    _emptyState(containerEl,
      "Not enough data yet \u2014 capture at least two interferograms to see a trend.");
    return;
  }

  // Determine y-range from PV (the larger of the two; PV >= RMS in well-
  // behaved cases). Auto-scale with a small headroom.
  let yMax = 0;
  for (const c of usable) {
    if (Number.isFinite(c.pv_nm)) yMax = Math.max(yMax, c.pv_nm);
    if (Number.isFinite(c.rms_nm)) yMax = Math.max(yMax, c.rms_nm);
  }
  if (yMax <= 0) yMax = 1;
  yMax *= 1.1;

  const W = Math.max(360, containerEl.clientWidth - 8);
  const H = 220;
  const pad = { left: 50, right: 16, top: 14, bottom: 32 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  // X coords: capture index 1..N evenly spaced.
  const _x = (i) => pad.left + (plotW * (i - 1)) / Math.max(1, usable.length - 1);
  const _y = (v) => pad.top + plotH * (1 - Math.max(0, Math.min(1, v / yMax)));

  // Grouping.
  let groups;  // { key: [captures...] }
  if (groupBy === "calibration") {
    groups = {};
    for (const c of usable) {
      const k = c.calibration_snapshot?.name || "(no calibration)";
      (groups[k] ??= []).push(c);
    }
  } else if (groupBy === "origin") {
    groups = {};
    for (const c of usable) {
      const k = c.origin || "capture";
      (groups[k] ??= []).push(c);
    }
  } else {
    groups = null;
  }

  const _path = (caps, key) => {
    if (caps.length < 2) return "";
    let d = "";
    caps.forEach((c, i) => {
      const v = c[key];
      if (!Number.isFinite(v)) return;
      const x = _x(c._index);
      const y = _y(v);
      d += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1) + " ";
    });
    return d.trim();
  };

  // Grid + axis labels.
  let gridLines = "";
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const yv = (yMax * i) / yTicks;
    const y = _y(yv);
    gridLines += `<line x1="${pad.left}" y1="${y}" x2="${pad.left + plotW}" y2="${y}" stroke="${COLORS.grid}"/>`;
    gridLines += `<text x="${pad.left - 6}" y="${y + 3}" fill="${COLORS.axis}" font-size="10" text-anchor="end">${yv.toFixed(0)}</text>`;
  }
  // X labels: capture index. Show up to ~6 labels.
  const xLabelStride = Math.max(1, Math.ceil(usable.length / 6));
  let xLabels = "";
  for (let i = 1; i <= usable.length; i += xLabelStride) {
    xLabels += `<text x="${_x(i)}" y="${pad.top + plotH + 14}" fill="${COLORS.axis}" font-size="10" text-anchor="middle">#${i}</text>`;
  }

  // Lines.
  let lines = "";
  let legend = "";
  if (!groups) {
    const pvD = _path(usable, "pv_nm");
    const rmsD = _path(usable, "rms_nm");
    if (pvD) lines += `<path d="${pvD}" fill="none" stroke="${COLORS.pv}" stroke-width="2"/>`;
    if (rmsD) lines += `<path d="${rmsD}" fill="none" stroke="${COLORS.rms}" stroke-width="2"/>`;
    legend = `
      <g font-size="10" fill="${COLORS.axis}">
        <rect x="${pad.left}" y="2" width="10" height="3" fill="${COLORS.pv}"/>
        <text x="${pad.left + 14}" y="6">PV (nm)</text>
        <rect x="${pad.left + 70}" y="2" width="10" height="3" fill="${COLORS.rms}"/>
        <text x="${pad.left + 84}" y="6">RMS (nm)</text>
      </g>`;
  } else {
    const keys = Object.keys(groups);
    keys.forEach((k, gi) => {
      const color = COLORS.group[gi % COLORS.group.length];
      const pvD = _path(groups[k], "pv_nm");
      const rmsD = _path(groups[k], "rms_nm");
      if (pvD) lines += `<path d="${pvD}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="3,2"/>`;
      if (rmsD) lines += `<path d="${rmsD}" fill="none" stroke="${color}" stroke-width="2"/>`;
    });
    legend = `<g font-size="10" fill="${COLORS.axis}">` +
      keys.map((k, i) => {
        const color = COLORS.group[i % COLORS.group.length];
        const x = pad.left + i * 140;
        return `<rect x="${x}" y="2" width="10" height="3" fill="${color}"/>` +
               `<text x="${x + 14}" y="6">${_esc(k)}</text>`;
      }).join("") + `</g>`;
  }

  // Tooltip points (for hover): one circle per capture per metric, transparent
  // until hovered via a JS handler we wire below.
  let points = "";
  for (const c of usable) {
    if (Number.isFinite(c.pv_nm)) {
      points += `<circle class="fringe-trend-pt" cx="${_x(c._index)}" cy="${_y(c.pv_nm)}" r="3" fill="${COLORS.pv}" opacity="0.85"`
              + ` data-tt="#${c._index} \u00B7 PV ${c.pv_nm.toFixed(1)} nm \u00B7 ${_esc(c.captured_at || "")}" />`;
    }
    if (Number.isFinite(c.rms_nm)) {
      points += `<circle class="fringe-trend-pt" cx="${_x(c._index)}" cy="${_y(c.rms_nm)}" r="3" fill="${COLORS.rms}" opacity="0.85"`
              + ` data-tt="#${c._index} \u00B7 RMS ${c.rms_nm.toFixed(1)} nm \u00B7 ${_esc(c.captured_at || "")}" />`;
    }
  }

  containerEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
       style="display:block;width:100%;height:auto;font-family:-apple-system,Segoe UI,sans-serif">
    ${legend}
    ${gridLines}
    <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="${COLORS.axis}"/>
    <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" stroke="${COLORS.axis}"/>
    ${xLabels}
    <text x="14" y="${pad.top + plotH / 2}" fill="${COLORS.axis}" font-size="10" transform="rotate(-90 14,${pad.top + plotH / 2})" text-anchor="middle">nm</text>
    ${lines}
    ${points}
  </svg>
  <div id="fringe-trend-tooltip" style="position:absolute;display:none;pointer-events:none;background:#1c1c1e;color:#e8e8e8;padding:4px 8px;border-radius:4px;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,0.5)"></div>`;

  // Wire hover tooltips.
  const tip = containerEl.querySelector("#fringe-trend-tooltip");
  containerEl.style.position = "relative";
  containerEl.querySelectorAll(".fringe-trend-pt").forEach(node => {
    node.addEventListener("mouseenter", () => {
      tip.textContent = node.getAttribute("data-tt") || "";
      tip.style.display = "block";
    });
    node.addEventListener("mousemove", (e) => {
      const rect = containerEl.getBoundingClientRect();
      tip.style.left = (e.clientX - rect.left + 8) + "px";
      tip.style.top = (e.clientY - rect.top + 8) + "px";
    });
    node.addEventListener("mouseleave", () => {
      tip.style.display = "none";
    });
  });
}
