// zstack.js — Manual Z-stack (depth-from-focus) workflow UI.
//
// Mirrors the Keyence VHX-900 "3D" workflow: the user manually advances
// the Z axis by a fixed amount between captures, collects 3-15+ frames,
// then the backend builds an all-in-focus composite and a colourised
// height map.  The composite can optionally replace the current frozen
// background so normal measurement tools operate on a sharp image.

import { apiFetch } from './api.js';
import { state } from './state.js';
import { img, showStatus, resizeCanvas } from './render.js';
import { setImageSize, viewport } from './viewport.js';
import { cacheImageData } from './subpixel-js.js';
import { updateFreezeUI } from './sidebar.js';
import { openZstack3dView } from './zstack-3d.js';

// Local UI state (scoped — does NOT touch core `state`)
const zs = {
  sessionId: null,
  frameCount: 0,
  zStepMm: 0.05,
  suggestedMin: 10,
  suggestedMax: 15,
  computed: null, // { compositeUrl, heightmapUrl, minZ, maxZ, width, height }
};

function $(id) { return document.getElementById(id); }

function buildDialog() {
  if ($("zstack-dialog")) return;

  const dlg = document.createElement("div");
  dlg.id = "zstack-dialog";
  dlg.className = "dialog-overlay";
  dlg.hidden = true;
  dlg.innerHTML = `
    <div class="dialog-content" style="max-width:780px">
      <div class="dialog-header">
        <span class="dialog-title">3D Z-Stack (Depth-from-Focus)</span>
        <button class="dialog-close" id="btn-zstack-close">✕</button>
      </div>
      <div style="padding:14px 18px">
        <p style="margin:0 0 10px;opacity:0.85;font-size:13px">
          Manually advance the Z axis by a fixed amount between captures,
          just like the Keyence VHX "3D" mode. Collect 10–15 frames for
          best results, then build the height map.
        </p>

        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <label style="font-size:13px">Z step (mm):</label>
          <input type="number" id="zstack-step" step="0.001" min="0.001" value="0.05"
                 style="width:100px" />
          <span id="zstack-instruction" style="opacity:0.8;font-size:12px"></span>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
          <button class="detect-btn" id="btn-zstack-capture">Capture frame</button>
          <button class="detect-btn" id="btn-zstack-compute" disabled>Build height map</button>
          <button class="detect-btn" id="btn-zstack-reset">Reset</button>
          <span id="zstack-count" style="align-self:center;opacity:0.85;font-size:12px">0 / suggested 10–15</span>
        </div>

        <div id="zstack-thumbs" style="display:flex;flex-wrap:wrap;gap:4px;max-height:70px;overflow-y:auto;margin-bottom:10px"></div>

        <div id="zstack-result" hidden>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px">
            <div style="flex:1;min-width:260px">
              <div style="font-size:12px;opacity:0.85;margin-bottom:4px">All-in-focus composite</div>
              <img id="zstack-composite-img" style="width:100%;border:1px solid #444;background:#111" />
              <a id="zstack-composite-dl" download="zstack-composite.png" class="detect-btn" style="display:inline-block;margin-top:6px;text-decoration:none">Download PNG</a>
            </div>
            <div style="flex:1;min-width:260px">
              <div style="font-size:12px;opacity:0.85;margin-bottom:4px">
                Height map
                (<span id="zstack-zrange">—</span>)
              </div>
              <img id="zstack-heightmap-img" style="width:100%;border:1px solid #444;background:#111" />
              <a id="zstack-heightmap-dl" download="zstack-heightmap.png" class="detect-btn" style="display:inline-block;margin-top:6px;text-decoration:none">Download PNG</a>
            </div>
          </div>
          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="detect-btn" id="btn-zstack-use-composite">Use composite as working image</button>
            <button class="detect-btn" id="btn-zstack-open-3d">Open 3D view</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);

  $("btn-zstack-close").addEventListener("click", closeDialog);
  $("zstack-step").addEventListener("input", e => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v > 0) {
      zs.zStepMm = v;
      updateInstruction();
    }
  });
  $("btn-zstack-capture").addEventListener("click", captureFrame);
  $("btn-zstack-compute").addEventListener("click", compute);
  $("btn-zstack-reset").addEventListener("click", resetStack);
  $("btn-zstack-use-composite").addEventListener("click", useCompositeAsWorkingImage);
  $("btn-zstack-open-3d").addEventListener("click", () => { openZstack3dView(); });
}

function updateInstruction() {
  const el = $("zstack-instruction");
  if (!el) return;
  if (zs.frameCount === 0) {
    el.textContent = "Focus at the lowest point, then click Capture.";
  } else {
    el.textContent = `Move Z up by ${zs.zStepMm} mm, then click Capture.`;
  }
}

function updateCount() {
  const el = $("zstack-count");
  if (el) el.textContent = `${zs.frameCount} / suggested ${zs.suggestedMin}–${zs.suggestedMax}`;
  const computeBtn = $("btn-zstack-compute");
  if (computeBtn) computeBtn.disabled = zs.frameCount < 3;
}

function renderThumbs() {
  const wrap = $("zstack-thumbs");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (let i = 0; i < zs.frameCount; i++) {
    const dot = document.createElement("div");
    dot.style.cssText = "width:42px;height:42px;border:1px solid #555;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:11px;background:#1a1a1a;color:#aaa";
    dot.textContent = `#${i + 1}`;
    wrap.appendChild(dot);
  }
}

async function startSession() {
  const r = await apiFetch("/zstack/start", { method: "POST" });
  if (!r.ok) { showStatus("Z-stack start failed"); return false; }
  const data = await r.json();
  zs.sessionId = data.session_id;
  zs.frameCount = 0;
  zs.computed = null;
  const resultEl = $("zstack-result");
  if (resultEl) resultEl.hidden = true;
  renderThumbs();
  updateCount();
  updateInstruction();
  return true;
}

async function captureFrame() {
  const btn = $("btn-zstack-capture");
  if (btn) btn.disabled = true;
  try {
    const r = await apiFetch("/zstack/capture", { method: "POST" });
    if (!r.ok) {
      const msg = await r.text();
      showStatus("Capture failed: " + msg);
      return;
    }
    const data = await r.json();
    zs.frameCount = data.frame_count;
    renderThumbs();
    updateCount();
    updateInstruction();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function compute() {
  const btn = $("btn-zstack-compute");
  if (btn) { btn.disabled = true; btn.textContent = "Building…"; }
  try {
    const r = await apiFetch("/zstack/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ z_step_mm: zs.zStepMm }),
    });
    if (!r.ok) {
      const msg = await r.text();
      showStatus("Compute failed: " + msg);
      return;
    }
    const data = await r.json();
    zs.computed = {
      compositeUrl: data.composite_url + "?t=" + Date.now(),
      heightmapUrl: data.heightmap_url + "?t=" + Date.now(),
      minZ: data.min_z,
      maxZ: data.max_z,
      width: data.width,
      height: data.height,
    };

    $("zstack-composite-img").src = zs.computed.compositeUrl;
    $("zstack-heightmap-img").src = zs.computed.heightmapUrl;
    $("zstack-composite-dl").href = zs.computed.compositeUrl;
    $("zstack-heightmap-dl").href = zs.computed.heightmapUrl;
    $("zstack-zrange").textContent =
      `Z ${zs.computed.minZ.toFixed(3)} → ${zs.computed.maxZ.toFixed(3)} mm`;
    $("zstack-result").hidden = false;
    showStatus(`Z-stack built: ${zs.frameCount} frames, Z range ${(zs.computed.maxZ - zs.computed.minZ).toFixed(3)} mm`);
  } finally {
    if (btn) { btn.disabled = zs.frameCount < 3; btn.textContent = "Build height map"; }
  }
}

async function resetStack() {
  await apiFetch("/zstack/reset", { method: "POST" });
  zs.frameCount = 0;
  zs.computed = null;
  const resultEl = $("zstack-result");
  if (resultEl) resultEl.hidden = true;
  renderThumbs();
  updateCount();
  updateInstruction();
}

// Replace the live/frozen view with the all-in-focus composite so existing
// measurement tools can run on the sharp stacked image.  Reuses the same
// pathway as a loaded image: populate state.frozenBackground and flip to
// the frozen UI state.
async function useCompositeAsWorkingImage() {
  if (!zs.computed) return;
  try {
    const resp = await fetch(zs.computed.compositeUrl);
    if (!resp.ok) throw new Error("failed to fetch composite");
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const loadedImg = await new Promise((resolve, reject) => {
      const bmp = new Image();
      bmp.onload = () => resolve(bmp);
      bmp.onerror = () => reject(new Error("decode failed"));
      bmp.src = url;
    });

    // Upload to backend so detection/inspection operate on the composite
    const fd = new FormData();
    fd.append("file", blob, "zstack-composite.png");
    const up = await apiFetch("/load-image", { method: "POST", body: fd });
    if (!up.ok) throw new Error("upload failed");
    const { width, height } = await up.json();

    state.frozenSize = { w: width, h: height };
    setImageSize(width, height);
    viewport.zoom = 1;
    viewport.panX = 0;
    viewport.panY = 0;
    state.frozenBackground = loadedImg;
    img.style.opacity = "0";
    state.frozen = true;
    cacheImageData(loadedImg, width, height);
    updateFreezeUI();
    resizeCanvas();
    showStatus("Composite loaded as working image");
    closeDialog();
  } catch (err) {
    showStatus("Use composite failed: " + err.message);
  }
}

export async function openZstackDialog() {
  buildDialog();
  const dlg = $("zstack-dialog");
  dlg.hidden = false;
  await startSession();
}

function closeDialog() {
  const dlg = $("zstack-dialog");
  if (dlg) dlg.hidden = true;
}

export function initZstack() {
  const btn = $("btn-zstack");
  if (btn) btn.addEventListener("click", openZstackDialog);
}
