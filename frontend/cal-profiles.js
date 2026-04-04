// ── Calibration profiles ──────────────────────────────────────────────────────
// Stores named calibration presets in localStorage so users can switch between
// objectives/magnifications without re-calibrating each session.
import { state } from './state.js';
import { updateCalibrationButton } from './sidebar.js';
import { redraw } from './render.js';

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
    return `<div class="cal-profile-item">
      <span class="cal-profile-name" title="${p.name}">${p.name}</span>
      <span class="cal-profile-scale">${umPerPx} µm/px</span>
      <button class="cal-profile-load" data-index="${i}">Load</button>
      <button class="cal-profile-del" data-index="${i}" title="Delete">✕</button>
    </div>`;
  }).join("");

  list.querySelectorAll(".cal-profile-load").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = profiles[parseInt(btn.dataset.index)];
      state.calibration = { pixelsPerMm: p.pixelsPerMm, displayUnit: p.displayUnit };
      updateCalibrationButton();
      redraw();
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
    });
    _saveProfiles(profiles);
    nameInput.value = "";
    _renderList(panel, profiles);
  });
}

export function openCalProfiles() {
  const panel = document.getElementById("cal-profiles-panel");
  if (!panel) return;
  _renderList(panel, _loadProfiles());
  panel.hidden = false;
}
