import { state } from './state.js';
import { redraw, showStatus, img, canvas, resizeCanvas } from './render.js';
import { addAnnotation } from './annotations.js';
import { updateFreezeUI } from './sidebar.js';

// ── Detection busy indicator ──────────────────────────────────────────────
function withBusy(btn, label, fn) {
  return async () => {
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = label + "…";
    showStatus(label + "…");
    document.body.style.cursor = "progress";
    canvas.style.cursor = "progress";
    try {
      await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
      document.body.style.cursor = "";
      canvas.style.cursor = "";
    }
  };
}

// ── Freeze / Live ──────────────────────────────────────────────────────────
export async function ensureFrozen() {
  if (!state.frozen) await doFreeze();
}

export async function doFreeze() {
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

// ── Detect tool event handlers ──────────────────────────────────────────────
export function initDetectHandlers() {
  // Slider input handlers: update the display value on input
  ["canny-low","canny-high","hough-p2","circle-min-r","circle-max-r","line-sensitivity","line-min-length","adv-smoothing","adv-min-length","adv-nms-dist","adv-min-span"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => {
      const valEl = document.getElementById(id + "-val");
      if (valEl) valEl.textContent = el.value;
    });
  });

  // btn-run-edges: detect and display edge overlay
  const btnEdges = document.getElementById("btn-run-edges");
  btnEdges.addEventListener("click", withBusy(btnEdges, "Detecting edges", async () => {
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
  }));

  // btn-show-preprocessed: display preprocessed image overlay
  const btnPreproc = document.getElementById("btn-show-preprocessed");
  btnPreproc.addEventListener("click", withBusy(btnPreproc, "Preprocessing", async () => {
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
  }));

  // btn-run-circles: detect and display circles
  const btnCircles = document.getElementById("btn-run-circles");
  btnCircles.addEventListener("click", withBusy(btnCircles, "Detecting circles", async () => {
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
  }));

  // btn-run-lines: detect and display lines using Hough
  const btnLines = document.getElementById("btn-run-lines");
  if (btnLines) btnLines.addEventListener("click", withBusy(btnLines, "Detecting lines", async () => {
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
  }));

  // btn-detect-lines-merged: detect merged/contour lines
  const btnMergedLines = document.getElementById("btn-detect-lines-merged");
  if (btnMergedLines) btnMergedLines.addEventListener("click", withBusy(btnMergedLines, "Detecting lines", async () => {
    await ensureFrozen();
    const t1 = parseInt(document.getElementById("canny-low").value);
    const t2 = parseInt(document.getElementById("canny-high").value);
    const smoothing = parseInt(document.getElementById("adv-smoothing").value);
    const minLen = parseInt(document.getElementById("adv-min-length").value);
    const nmsDist = parseInt(document.getElementById("adv-nms-dist").value);
    const r = await fetch("/detect-lines-merged", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold1: t1, threshold2: t2, min_length: minLen, nms_dist: nmsDist, smoothing }) });
    if (!r.ok) { const d = await r.json().catch(() => null); showStatus(d?.detail || "Line detection failed (HTTP " + r.status + ")"); return; }
    const lines = await r.json();
    const fw = state.frozenSize?.w || canvas.width;
    const fh = state.frozenSize?.h || canvas.height;
    state.annotations = state.annotations.filter(a => a.type !== "detected-line-merged");
    lines.forEach(l => addAnnotation({ type: "detected-line-merged",
      x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, frameWidth: fw, frameHeight: fh }));
    redraw();
  }));

  // btn-detect-arcs-partial: detect partial arcs
  const btnArcs = document.getElementById("btn-detect-arcs-partial");
  if (btnArcs) btnArcs.addEventListener("click", withBusy(btnArcs, "Detecting arcs", async () => {
    await ensureFrozen();
    const t1 = parseInt(document.getElementById("canny-low").value);
    const t2 = parseInt(document.getElementById("canny-high").value);
    const smoothing = parseInt(document.getElementById("adv-smoothing").value);
    const minSpan = parseInt(document.getElementById("adv-min-span").value);
    const r = await fetch("/detect-arcs-partial", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold1: t1, threshold2: t2, min_span_deg: minSpan, smoothing }) });
    if (!r.ok) { const d = await r.json().catch(() => null); showStatus(d?.detail || "Arc detection failed (HTTP " + r.status + ")"); return; }
    const arcs = await r.json();
    const fw = state.frozenSize?.w || canvas.width;
    const fh = state.frozenSize?.h || canvas.height;
    state.annotations = state.annotations.filter(a => a.type !== "detected-arc-partial");
    // Filter out arcs that overlap with already-detected circles
    const existingCircles = state.annotations.filter(a => a.type === "detected-circle");
    const filteredArcs = arcs.filter(a => {
      return !existingCircles.some(c => {
        const dist = Math.hypot(a.cx - c.x, a.cy - c.y);
        const rRatio = Math.abs(a.r - c.radius) / (Math.max(a.r, c.radius) + 1e-6);
        return dist < 20 && rRatio < 0.2;  // same center within 20px and radius within 20%
      });
    });
    filteredArcs.forEach(a => addAnnotation({ type: "detected-arc-partial",
      cx: a.cx, cy: a.cy, r: a.r, start_deg: a.start_deg, end_deg: a.end_deg,
      frameWidth: fw, frameHeight: fh }));
    redraw();
  }));
}
