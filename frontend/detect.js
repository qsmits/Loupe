import { state } from './state.js';
import { redraw, showStatus, img, canvas, resizeCanvas } from './render.js';
import { addAnnotation } from './annotations.js';
import { updateFreezeUI } from './sidebar.js';

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
  ["canny-low","canny-high","hough-p2","circle-min-r","circle-max-r","line-sensitivity","line-min-length"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => {
      const valEl = document.getElementById(id + "-val");
      if (valEl) valEl.textContent = el.value;
    });
  });

  // btn-run-edges: detect and display edge overlay
  document.getElementById("btn-run-edges").addEventListener("click", async () => {
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
  });

  // btn-show-preprocessed: display preprocessed image overlay
  document.getElementById("btn-show-preprocessed").addEventListener("click", async () => {
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
  });

  // btn-run-circles: detect and display circles
  document.getElementById("btn-run-circles").addEventListener("click", async () => {
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
  });

  // btn-run-lines: detect and display lines using Hough
  document.getElementById("btn-run-lines")?.addEventListener("click", async () => {
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
  });

  // btn-detect-lines-merged: detect merged/contour lines
  document.getElementById("btn-detect-lines-merged")?.addEventListener("click", async () => {
    const r = await fetch("/detect-lines-merged", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    if (!r.ok) { showStatus("Freeze a frame first"); return; }
    const lines = await r.json();
    state.annotations = state.annotations.filter(a => a.type !== "detected-line-merged");
    lines.forEach(l => addAnnotation({ type: "detected-line-merged",
      x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 }));
    redraw();
  });

  // btn-detect-arcs-partial: detect partial arcs
  document.getElementById("btn-detect-arcs-partial")?.addEventListener("click", async () => {
    const r = await fetch("/detect-arcs-partial", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    if (!r.ok) { showStatus("Freeze a frame first"); return; }
    const arcs = await r.json();
    state.annotations = state.annotations.filter(a => a.type !== "detected-arc-partial");
    arcs.forEach(a => addAnnotation({ type: "detected-arc-partial",
      cx: a.cx, cy: a.cy, r: a.r, start_deg: a.start_deg, end_deg: a.end_deg }));
    redraw();
  });
}
