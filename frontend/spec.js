// frontend/spec.js — per-measurement tolerance spec evaluation (pure, no DOM).
// spec = { nominal, upper, lower } in the measurement's base unit; lower ≤ 0.

/**
 * @param {number} value - measurement's raw numeric value, in its base unit
 *   (mm/px/°/mm²/px² — see format.js::measurementNumeric).
 * @param {{nominal:number, upper?:number, lower?:number}|null} spec
 * @returns {{deviation:number, pass:boolean}|null}
 */
export function evaluateSpec(value, spec) {
  if (value == null || !Number.isFinite(value)) return null;
  if (!spec || !Number.isFinite(spec.nominal)) return null;
  const upper = Number.isFinite(spec.upper) ? spec.upper : 0;
  const lower = Number.isFinite(spec.lower) ? spec.lower : 0;
  const deviation = value - spec.nominal;
  return { deviation, pass: deviation >= lower && deviation <= upper };
}

/**
 * @param {number} deviation - in `unit`
 * @param {string} unit - the measurement's base unit ('mm', '°', etc.)
 * @param {string} displayUnit - the user's preferred display unit ('mm' | 'µm')
 * @returns {string} e.g. "▲+0.025 mm" / "▼−0.075 mm" / "▲+25.3 µm"
 */
export function formatDeviation(deviation, unit, displayUnit) {
  let v = deviation, u = unit;
  if (unit === 'mm' && displayUnit === 'µm') { v = deviation * 1000; u = 'µm'; }
  const digits = u === 'µm' ? 1 : u === '°' ? 2 : 3;
  const arrow = v >= 0 ? '▲+' : '▼−';
  return `${arrow}${Math.abs(v).toFixed(digits)} ${u}`;
}
