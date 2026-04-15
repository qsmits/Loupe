# Deflectometry Phase 1: Honest Results and Slope-First Display

**Date:** 2026-04-15
**Status:** Draft, pending review
**Prerequisite reading:** `docs/deflectometry-sofast-comparison.md`

## Goal

Make deflectometry results more informative, more honest about what they
represent, and easier to diagnose when something goes wrong. No new
calibration workflows or geometric solvers -- just better use of data we
already compute.

## Non-Goals

- Geometric slope solver (Phase 3 of the comparison doc)
- Multi-frequency capture
- Display response calibration
- Setup profiles / session persistence
- Any changes to the capture workflow or iPad communication

## Background

The current pipeline captures 16 frames (8 x-fringes, 8 y-fringes), extracts
wrapped phase via generalized N-step formula, unwraps along fringe axes,
removes tilt, and integrates via Frankot-Chellappa to produce a height map.

The results tab shows two phase map images (X and Y) with PV/RMS/mean stats,
a 3D surface view, and a diagnostics tab with raw frames, modulation, wrapped
and unwrapped phase images.

Three things are missing:

1. **Slope is the native measurement, but we only show integrated height.**
   Phase maps are labeled "Phase X" and "Phase Y" but they _are_ the slope
   fields. We don't show slope magnitude, slope direction, or the curl
   residual that reveals integration quality.

2. **Units are ambiguous.** When uncalibrated, stats show radians. When
   calibrated via sphere, stats show micrometers. But the user can't easily
   tell which regime they're in, and "radians" for a height value is
   misleading -- it's phase-proxy height, not a physical angle.

3. **There's no quality summary.** The diagnostics tab has raw data but no
   interpretation. A user seeing a bad result has to manually inspect
   modulation maps and frame statistics to guess what went wrong.

---

## Design

### 1. Slope-First Results Tab

**Current state:** The "Phase Maps" tab shows two images (Phase X, Phase Y)
with stats.

**New state:** Rename tab to "Slope & Phase". Add four result views in a
2x2 grid above the existing phase maps:

| | Left | Right |
|---|---|---|
| **Row 1** | Slope X (existing phase_x, relabeled) | Slope Y (existing phase_y, relabeled) |
| **Row 2** | Slope Magnitude | Curl Residual |

**Slope Magnitude** is `sqrt(dzdx^2 + dzdy^2)` rendered as a pseudocolor
image. This shows where the surface has the steepest features -- useful for
spotting local defects.

**Curl Residual** is `d(dzdx)/dy - d(dzdy)/dx`, the non-integrable component.
For a physically valid surface, curl should be near zero everywhere. Large curl
indicates:
- Unwrap errors (phase jumps that didn't get corrected)
- Measurement noise at the boundary
- Display reflection artifacts

The curl map is the single most useful diagnostic for deflectometry. If curl is
small, the integration is trustworthy. If curl is large somewhere, the height
map is unreliable in that region.

**Backend changes (`deflectometry.py`):**

```python
def compute_slope_magnitude(dzdx, dzdy, mask=None):
    """Slope magnitude sqrt(dzdx^2 + dzdy^2)."""
    mag = np.sqrt(dzdx**2 + dzdy**2)
    return mag

def compute_curl_residual(dzdx, dzdy, mask=None):
    """Curl of the slope field: d(dzdx)/dy - d(dzdy)/dx.
    Near-zero = integrable = trustworthy height map."""
    curl = np.gradient(dzdx, axis=0) - np.gradient(dzdy, axis=1)
    return curl
```

Both functions return float64 arrays. `pseudocolor_png_b64()` is already
available for rendering. Curl should use a diverging colormap (blue-white-red)
centered on zero; slope magnitude uses viridis.

**API changes (`api_deflectometry.py`):**

Add to the `/deflectometry/compute` response:

```json
{
  "slope_mag_png_b64": "<base64>",
  "curl_png_b64": "<base64>",
  "stats_slope_mag": { "pv": ..., "rms": ..., "mean": ... },
  "stats_curl": { "pv": ..., "rms": ..., "mean": ... }
}
```

**Frontend changes (`deflectometry.js`):**

- Rename "Phase Maps" tab label to "Slope & Phase"
- Rename "Phase X" / "Phase Y" labels to "Slope X (phase)" / "Slope Y (phase)"
- Add slope magnitude and curl residual images below the existing pair
- Add stats rows for slope magnitude and curl
- Curl image gets a visual indicator: green border if RMS < threshold, amber
  if marginal, red if poor (thresholds TBD empirically after testing)

### 2. Quality Summary Block

Add a quality summary to the `/deflectometry/compute` response and display it
prominently in the UI, above the slope/phase grid.

**Backend:** Compute and return a `quality` dict:

```json
{
  "quality": {
    "modulation_coverage": 85.2,
    "modulation_x_median": 42.1,
    "modulation_y_median": 38.7,
    "clipped_fraction": 0.3,
    "curl_rms": 0.012,
    "curl_max": 0.089,
    "mask_valid_frac": 0.82,
    "overall": "good",
    "warnings": [
      "Y modulation is 8% lower than X -- check fringe contrast in Y orientation"
    ]
  }
}
```

**Fields:**

- `modulation_coverage`: % of image area with both mod_x and mod_y above
  threshold (already computed as `mask_valid_frac`, but rename for clarity)
- `modulation_x_median`, `modulation_y_median`: median modulation in the valid
  region. Large asymmetry between X and Y suggests contrast or alignment issues.
- `clipped_fraction`: % of valid pixels where any captured frame was at 0 or
  255 (saturated/black). Clipping corrupts phase.
- `curl_rms`: RMS of curl residual over the valid mask. Primary integration
  quality metric.
- `curl_max`: peak absolute curl. Localized unwrap failures show up here.
- `mask_valid_frac`: fraction of total pixels that pass modulation threshold.
- `overall`: "good" / "fair" / "poor" based on weakest metric.
- `warnings`: list of human-readable strings explaining what's marginal.

**Warning generation rules:**

| Condition | Warning |
|---|---|
| `modulation_coverage < 50%` | "Less than half the image has usable signal" |
| `abs(mod_x_median - mod_y_median) / max(mod_x_median, mod_y_median) > 0.2` | "X/Y modulation imbalance -- check fringe contrast" |
| `clipped_fraction > 5%` | "N% of pixels are clipped -- reduce exposure or display brightness" |
| `curl_rms > threshold_fair` | "Integration residual is elevated -- check surface map for artifacts" |

**Overall score logic:**

- `good`: modulation_coverage >= 70%, curl_rms < fair_threshold, clipped < 5%
- `poor`: modulation_coverage < 30%, or curl_rms > poor_threshold, or clipped > 20%
- `fair`: everything else

Curl thresholds will be determined empirically -- start with fair = 0.05 rad,
poor = 0.2 rad, and adjust based on real measurements.

**Frontend:** Display as a compact colored banner above the results grid:

```
[green] Result is reliable.   or
[amber] Fair -- Y modulation is lower than X. Check fringe contrast in Y orientation.   or
[red]   Poor -- 23% of pixels are clipped. Reduce exposure or display brightness.
```

Click the banner to expand the full quality breakdown table (all fields listed
above). Follows the same pattern as the fringe mode confidence badges.

### 3. Unit Honesty

**Current problem:** When uncalibrated, stats show "rad" as the unit. This is
technically the unit of the unwrapped phase, but calling an integrated height
value "radians" is confusing. When calibrated, stats show "um" -- but there's
no visual cue that calibration was applied or how.

**Changes:**

- When **uncalibrated**: label stats as "Phase-rad (uncalibrated)" and add a
  subtle note below the stats: "Sphere calibration needed for physical units."
  The 3D view title changes from "Height" to "Relative Height (uncalibrated)".

- When **calibrated**: label stats as "um" and show the calibration info:
  "Cal: sphere D=25.0mm, factor=X.XX um/rad, fit RMS=X.XX um".
  This appears as a small info line below the stats, so the user can trace
  where the calibration came from.

- The `quality.warnings` list includes a reminder when uncalibrated:
  "No sphere calibration -- heights are in phase-radians, not physical units."

**No code-level changes to the computation** -- this is purely labeling and
display.

### 4. Structured Run Diagnostics Export

**Current state:** The diagnostics tab shows images and frame stats, but
there's no way to save a complete record of a measurement run.

**New endpoint:** `POST /deflectometry/export-run`

Returns a JSON document capturing everything about the run:

```json
{
  "version": 1,
  "timestamp": "2026-04-15T14:32:00Z",
  "acquisition": {
    "n_frames": 16,
    "n_phase_steps": 8,
    "frequency_cycles": 16,
    "gamma": 2.2,
    "smooth_sigma": 0.0,
    "mask_threshold": 0.02,
    "has_flat_field": true,
    "has_reference": false
  },
  "display": {
    "device": "iPad Air",
    "pixel_pitch_mm": 0.0962
  },
  "calibration": {
    "cal_factor": null,
    "sphere_diameter_mm": null,
    "px_per_mm": null
  },
  "quality": { ... },
  "stats": {
    "phase_x": { "pv": ..., "rms": ..., "mean": ... },
    "phase_y": { ... },
    "slope_magnitude": { ... },
    "curl": { ... },
    "height": { ... }
  },
  "frame_stats": [ ... ],
  "modulation": {
    "x": { "min": ..., "max": ..., "mean": ..., "median": ... },
    "y": { ... }
  }
}
```

**Frontend:** Add "Export Run" button next to the existing action bar. Downloads
the JSON as `deflectometry-run-YYYY-MM-DDTHH-MM-SS.json`.

No images in the export -- it's metadata and statistics only. The diagnostics
endpoint already saves frame PNGs to disk; the run export complements that with
the structured record.

### 5. Repeatability Script Fix

**Current bug:** `scripts/dev/deflectometry_repeatability.py` reads only 4
phase frames per orientation (indices 0-3) but the backend captures 8. The
script silently discards half the data.

**Fix:**
- Update the frame loop from `range(4)` to `range(8)`
- Use the existing `compute_wrapped_phase()` which already handles N-step
  generalization
- Update comments and print statements to reflect 8-step capture (16 total
  frames)
- No functional changes to the analysis logic -- just reading all available
  frames

---

## File Map

| File | Change |
|---|---|
| `backend/vision/deflectometry.py` | Add `compute_slope_magnitude()`, `compute_curl_residual()`, `compute_quality_summary()`, diverging colormap helper |
| `backend/api_deflectometry.py` | Extend `/compute` response, add `/export-run` endpoint |
| `frontend/deflectometry.js` | Rename tab, add slope mag + curl images, quality banner, unit labels, export button |
| `frontend/style.css` | Quality banner styles (reuse fringe confidence pattern) |
| `scripts/dev/deflectometry_repeatability.py` | Fix 4-step to 8-step frame reading |

## Out of Scope

- Changes to the capture sequence or iPad WebSocket protocol
- Camera calibration integration
- Multi-frequency capture
- Display geometry calibration
- Setup profiles or session persistence
- PDF export (can be added later, same pattern as fringe mode)
- Changes to the 3D view rendering (mask clipping could be ported from fringe
  mode later, but is not part of this spec)

## Testing

- Existing deflectometry tests should continue to pass (no behavioral changes
  to existing functions)
- New unit tests for `compute_slope_magnitude()`, `compute_curl_residual()`,
  `compute_quality_summary()`
- Manual verification with real captures after hardware setup
- Curl residual on a known-good flat should be near zero
- Curl residual with an intentional unwrap error (e.g., low modulation region)
  should show the error clearly

## Open Questions

1. **Curl colormap range:** Should it auto-scale or use a fixed range? Auto-scale
   shows relative variation but makes it hard to compare runs. Fixed range is
   more comparable but might clip extreme values. Recommend: auto-scale with
   the RMS value printed, so the number is comparable even if the visual isn't.

2. **Curl threshold values:** The fair/poor thresholds for curl_rms need to be
   determined empirically. Starting values (0.05 / 0.2 rad) are guesses.
   We'll tune after seeing real data.

3. **Slope magnitude colormap:** Viridis or a perceptual grayscale? Viridis is
   consistent with the phase maps; grayscale might be more intuitive for
   "steepness." Recommend: viridis for consistency.
