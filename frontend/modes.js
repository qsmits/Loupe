// modes.js — low-level mode-container switching (Microscope / Deflectometry
// / Fringe). Since Track B, mode switching is driven by the tab manager
// (tab-manager.js) and by cross-mode.js's modal excursions — there is no
// user-facing mode switcher. Kept as its own module because cross-mode and
// keyboard code depend on switchMode/getActiveMode.

const MODES = ["microscope", "deflectometry", "fringe"];
let activeMode = "microscope";

function $(id) { return document.getElementById(id); }

/** Switch to a mode by id. Hides current, shows target, toggles top-bar items. */
export function switchMode(modeId) {
  if (!MODES.includes(modeId)) return;
  // Block mode switching during cross-mode mask editing
  if (document.getElementById('cross-mode-action-bar')) return;
  activeMode = modeId;

  for (const m of MODES) {
    const el = $("mode-" + m);
    if (el) el.hidden = m !== modeId;
  }

  document.querySelectorAll(".microscope-only").forEach(el => {
    el.hidden = modeId !== "microscope";
  });

  document.querySelectorAll(".fringe-only").forEach(el => {
    el.hidden = modeId !== "fringe";
  });

  const toolStrip = $("tool-strip");   // removed in the toolbar task; null-safe
  const sidebar = $("sidebar");
  if (toolStrip) toolStrip.hidden = modeId !== "microscope";
  if (sidebar) sidebar.hidden = modeId !== "microscope";

  document.dispatchEvent(new CustomEvent('mode-switched', { detail: { mode: modeId } }));
}

export function getActiveMode() {
  return activeMode;
}
