// modes.js — Mode switching: Microscope / Deflectometry / Fringe Analysis.
//
// Controls visibility of mode root containers and top-bar items.
// Each mode module registers itself; switching hides the current
// container and shows the new one.

const MODES = ["microscope", "deflectometry", "fringe"];
let activeMode = "microscope";

function $(id) { return document.getElementById(id); }

/** Switch to a mode by id. Hides current, shows target, toggles top-bar items. */
export function switchMode(modeId) {
  if (!MODES.includes(modeId)) return;
  activeMode = modeId;

  // Toggle mode containers
  for (const m of MODES) {
    const el = $("mode-" + m);
    if (el) el.hidden = m !== modeId;
  }

  // Toggle microscope-only top-bar items
  document.querySelectorAll(".microscope-only").forEach(el => {
    el.hidden = modeId !== "microscope";
  });

  // Toggle fringe-only top-bar items
  document.querySelectorAll(".fringe-only").forEach(el => {
    el.hidden = modeId !== "fringe";
  });

  // Toggle microscope-only bottom elements (tool strip, sidebar)
  const toolStrip = $("tool-strip");
  const sidebar = $("sidebar");
  if (toolStrip) toolStrip.hidden = modeId !== "microscope";
  if (sidebar) sidebar.hidden = modeId !== "microscope";

  document.dispatchEvent(new CustomEvent('mode-switched', { detail: { mode: modeId } }));
}

export function getActiveMode() {
  return activeMode;
}

/** Wire up the mode switcher <select>. Call once from main.js. */
export function initModes() {
  const sel = $("mode-switcher");
  if (!sel) return;
  sel.addEventListener("change", () => switchMode(sel.value));
}
