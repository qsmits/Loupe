// ── Calibration profiles ──────────────────────────────────────────────────────
// Stores named calibration presets in localStorage so users can switch between
// objectives/magnifications without re-calibrating each session.
// Each profile captures both scale (pixelsPerMm) and lens distortion (lensK1).
import { state } from './state.js';
import { updateCalibrationButton } from './sidebar.js';
import { redraw } from './render.js';
import { applyLensCorrection } from './lens-cal.js';

const STORAGE_KEY = "loupe_cal_profiles";

function _loadProfiles() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}

function _saveProfiles(profiles) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
}

function _renderList(panel, profiles) {
  const list = panel.querySelector("#cal-profiles-list");
  if (!list) return;
  if (profiles.length === 0) {
    list.innerHTML = '<div class="cal-profiles-empty">No saved profiles yet.</div>';
    return;
  }
  list.innerHTML = profiles.map((p, i) => {
    const umPerPx = (1000 / p.pixelsPerMm).toFixed(2);
    const lensTag = p.lensK1 ? ` <span class="cal-profile-lens" title="k₁ = ${p.lensK1.toExponential(2)}">lens ✓</span>` : "";
    return `<div class="cal-profile-item">
      <span class="cal-profile-name" title="${p.name}">${p.name}</span>
      <span class="cal-profile-scale">${umPerPx} µm/px${lensTag}</span>
      <button class="cal-profile-load" data-index="${i}">Load</button>
      <button class="cal-profile-del" data-index="${i}" title="Delete">✕</button>
    </div>`;
  }).join("");

  list.querySelectorAll(".cal-profile-load").forEach(btn => {
    btn.addEventListener("click", async () => {
      const p = profiles[parseInt(btn.dataset.index)];
      state.calibration = { pixelsPerMm: p.pixelsPerMm, displayUnit: p.displayUnit };
      updateCalibrationButton();
      redraw();
      if (p.lensK1) {
        if (!state.frozenBackground) {
          // Store k1 for later — lens warp will be applied when image is frozen
          state.lensK1 = p.lensK1;
        } else {
          await applyLensCorrection(p.lensK1);
        }
      }
    });
  });
  list.querySelectorAll(".cal-profile-del").forEach(btn => {
    btn.addEventListener("click", () => {
      profiles.splice(parseInt(btn.dataset.index), 1);
      _saveProfiles(profiles);
      _renderList(panel, profiles);
    });
  });
}

// Build a name that doesn't collide with any existing profile name. Appends
// " (2)", " (3)", … until a free slot is found. Used on import so no existing
// profile is ever overwritten silently.
function _uniqueName(base, existing) {
  const taken = new Set(existing.map(p => p.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10000; i++) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

function _exportProfiles() {
  const profiles = _loadProfiles();
  const payload = {
    schema: "loupe-cal-profiles",
    version: 1,
    exported_at: new Date().toISOString(),
    profiles,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `loupe-cal-profiles-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function _importProfilesFromFile(file, panel) {
  let text;
  try { text = await file.text(); }
  catch { alert("Could not read file."); return; }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { alert("Not a valid JSON file."); return; }

  // Accept either the versioned export format or a bare array (so a
  // hand-edited or legacy file also imports cleanly).
  const incoming = Array.isArray(parsed) ? parsed
                 : Array.isArray(parsed?.profiles) ? parsed.profiles
                 : null;
  if (!incoming) { alert("File doesn't look like an exported profiles list."); return; }

  const existing = _loadProfiles();
  let added = 0, skipped = 0;
  for (const p of incoming) {
    if (!p || typeof p.name !== "string" || typeof p.pixelsPerMm !== "number" || p.pixelsPerMm <= 0) {
      skipped++;
      continue;
    }
    existing.push({
      name: _uniqueName(p.name.trim() || "Imported", existing),
      pixelsPerMm: p.pixelsPerMm,
      displayUnit: p.displayUnit || "mm",
      lensK1: Number(p.lensK1) || 0,
    });
    added++;
  }
  _saveProfiles(existing);
  _renderList(panel, existing);
  const msg = `Imported ${added} profile${added === 1 ? "" : "s"}` +
              (skipped ? ` (${skipped} skipped — missing name or scale)` : "");
  alert(msg);
}

export function initCalProfiles() {
  const panel = document.getElementById("cal-profiles-panel");
  if (!panel) return;

  panel.querySelector("#btn-cal-profiles-close").addEventListener("click", () => {
    panel.hidden = true;
  });

  panel.querySelector("#btn-cal-profiles-save").addEventListener("click", () => {
    const nameInput = panel.querySelector("#cal-profile-name");
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    if (!state.calibration?.pixelsPerMm) {
      alert("No calibration active — calibrate first (press C, click two points, enter distance).");
      return;
    }
    const profiles = _loadProfiles();
    profiles.push({
      name,
      pixelsPerMm: state.calibration.pixelsPerMm,
      displayUnit: state.calibration.displayUnit || "mm",
      lensK1: state.lensK1 || 0,
    });
    _saveProfiles(profiles);
    nameInput.value = "";
    _renderList(panel, profiles);
  });

  panel.querySelector("#btn-cal-profiles-export").addEventListener("click", _exportProfiles);

  const fileInput = panel.querySelector("#cal-profiles-import-input");
  panel.querySelector("#btn-cal-profiles-import").addEventListener("click", () => {
    fileInput.value = "";  // allow re-selecting the same file back-to-back
    fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (file) await _importProfilesFromFile(file, panel);
  });
}

export function openCalProfiles() {
  const panel = document.getElementById("cal-profiles-panel");
  if (!panel) return;
  _renderList(panel, _loadProfiles());
  panel.hidden = false;
}
