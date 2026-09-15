// tolerance-format.js — pure tolerance-band formatting shared by the
// sidebar inspection table, CSV export, and PDF export, so all three
// report the SAME band for a feature instead of the sidebar showing a
// drawing spec while CSV/PDF still print the stale global ±warn/fail.
//
// Precedence: a DXF drawing spec (nominal ± its own upper/lower, in the
// dimension's own basis, Ø/R-prefixed by kind) > a per-drawing default
// tolerance (±x) > today's plain global/popover ±warn/fail band.
//
// Node-importable: no DOM access, no imports.

// Radius-kind specs must read visibly differently from diameter-kind specs
// since scoring doubles a radius-kind spec's nominal/upper/lower to a
// diameter basis before judging size (±0.01 on radius is ±0.02 on
// diameter) — the numbers shown here stay in the dimension's OWN
// (undoubled) basis, so the prefix is the only visual cue distinguishing
// the two.
const KIND_PREFIX = { diameter: "⌀", radius: "R" };  // Ø / R

/** { text, tag } for one inspection result's tolerance-band display.
 *  tag is "DWG" | "DEF" | null. */
export function formatToleranceCell(r) {
  if (r.spec) {
    const { nominal, upper, lower, kind } = r.spec;
    const prefix = KIND_PREFIX[kind] || "";
    return {
      text: `${prefix}${nominal.toFixed(3)} +${upper.toFixed(3)}/${lower.toFixed(3)}`,
      tag: "DWG",
    };
  }
  if (r.spec_source === "default" && r.default_tol_used != null) {
    return { text: `±${r.default_tol_used}`, tag: "DEF" };
  }
  return { text: `±${r.tolerance_warn}/${r.tolerance_fail}`, tag: null };
}

/** One CSV data row (array of cell values) for a single inspection result —
 *  section 1 ("DXF feature deviations") of session.js's
 *  exportInspectionCsv(). Uses formatToleranceCell so a spec/default-tol-
 *  judged feature's CSV row carries its actual band, not the stale global
 *  tolerance_warn/tolerance_fail. Matches INSPECTION_CSV_HEADERS below. */
export function buildInspectionCsvRow(r, partName, timestamp) {
  const tol = formatToleranceCell(r);
  return [
    partName,
    timestamp,
    r.handle,
    r.type,
    r.matched && r.deviation_mm != null ? r.deviation_mm.toFixed(4) : "",
    r.spec && r.size_dev_mm != null ? r.size_dev_mm.toFixed(4) : "",
    r.tp_dev_mm != null ? r.tp_dev_mm.toFixed(4) : "",
    r.angle_error_deg != null ? r.angle_error_deg.toFixed(2) : "",
    r.profile_mm != null ? r.profile_mm.toFixed(4) : "",
    tol.text,
    tol.tag || "",
    r.matched ? r.pass_fail.toUpperCase() : "UNMATCHED",
    "",
  ];
}

export const INSPECTION_CSV_HEADERS = [
  "part_name", "timestamp", "feature_id", "feature_type",
  "deviation_mm", "size_dev_mm", "tp_dev_mm", "angle_error_deg", "profile_mm",
  "tolerance", "tolerance_tag", "result", "notes",
];
