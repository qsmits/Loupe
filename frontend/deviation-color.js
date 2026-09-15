// deviation-color.js — pure stroke-color logic for guided inspection
// results. Extracted from render-dxf.js so behavior is unit-testable
// without a DOM (render-dxf.js imports render.js, which reads
// `document.getElementById` at module scope).
//
// Node-importable: no DOM access. Imports state.js only (a plain object,
// no DOM dependency of its own).
import { state } from './state.js';

const GREEN = "#32d74b";
const AMBER = "#ff9f0a";
const RED   = "#ff453a";

/**
 * Stroke color for one guided-inspection result's fitted geometry.
 *
 * Trusts the backend's `pass_fail` verdict directly rather than
 * recomputing pass/warn/fail from `tolerance_warn`/`tolerance_fail` +
 * `state.tolerances` here. Those fields still hold the plain global
 * thresholds even for a feature judged by a DXF drawing spec or a
 * per-drawing default tolerance — recomputing from them would silently
 * re-derive a DIFFERENT (wrong) verdict than the one actually applied.
 *
 * The one thing `pass_fail` does NOT carry is the punch/die "reworkable"
 * distinction: a radius deviation in the direction that can still be
 * machined down/out is shown amber even when the verdict is 'fail', while
 * the unreworkable direction is shown red. That nuance predates this
 * function's extraction and is preserved exactly.
 */
export function deviationColor(r) {
  if (r.pass_fail === "pass") return GREEN;

  const mode = state.featureModes[r.handle] || state.featureModes[r.parent_handle] || "die";
  const radiusDev = r.radius_dev_mm;

  if (radiusDev != null) {
    const reworkable = (mode === "die" && radiusDev < 0)
                    || (mode === "punch" && radiusDev > 0);
    return reworkable ? AMBER : RED;
  }

  return r.pass_fail === "fail" ? RED : AMBER;
}
