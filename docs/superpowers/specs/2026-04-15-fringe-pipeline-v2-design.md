# Fringe Pipeline v2 — Confidence, Form Removal, Carrier & Unwrap Diagnostics

## Goal

Make the fringe analysis pipeline more transparent and manufacturing-oriented. Users should know when a result is trustworthy, see where it's uncertain, and remove form using concepts that match how they think about parts (flatness, not Zernike decomposition).

## Current State

The pipeline works: carrier detection → complex demodulation → quality-guided unwrapping → Zernike fitting → subtraction → surface map. But it's a black box — it either produces a result or it doesn't, and the user has no way to judge intermediate quality. Form removal is Zernike-only with optics terminology.

## What's Changing

### 1. Confidence Metrics (Backend)

Four summary scores computed during `analyze_interferogram()` and returned in the result dict:

| Metric | Source | How computed | Badge thresholds |
|--------|--------|-------------|-----------------|
| `carrier_confidence` | `_analyze_carrier()` | Normalize existing `peak_ratio` to 0–100. Map: >10→100, 5–10→linear 70–100, 2–5→linear 30–70, <2→linear 0–30. | Green ≥70, Amber ≥30, Red <30 |
| `modulation_coverage` | `compute_fringe_modulation()` | % of mask pixels where modulation > threshold_frac. | Green ≥80%, Amber ≥50%, Red <50% |
| `unwrap_confidence` | `unwrap_phase_2d()` | % of valid pixels that didn't need 2π-jump correction and aren't in the edge contamination zone. | Green ≥95%, Amber ≥85%, Red <85% |
| `overall_confidence` | Derived | `min(carrier, modulation, unwrap)` — weakest link. | Same thresholds |

#### Confidence Maps

Three pre-rendered false-color PNGs (same dimensions as surface map), returned in `confidence_maps` dict:

- **`modulation_map`** — already rendered. Fringe contrast per pixel, 0–1, viridis colormap.
- **`unwrap_risk_map`** — new. Red channel intensity = risk. Pixels where 2π-jump correction fired are fully red. Pixels in the edge contamination zone (within ~1 fringe period of mask boundary) are orange. Transparent elsewhere.
- **`confidence_composite`** — new. Per-pixel `min(modulation_normalized, unwrap_quality)` mapped to green (high) → yellow (moderate) → red (low). Used as the toggleable overlay on the surface map.

#### Changes to `fringe.py`

**`unwrap_phase_2d()`** — return a second value: a uint8 risk mask.
- 0 = reliable pixel
- 1 = 2π-jump corrected pixel
- 2 = edge contamination zone (within `int(fringe_period_px)` of mask boundary, computed by eroding the mask and taking the difference)

Currently the median filter correction (line 804) modifies pixels silently. Change to also record which pixels were corrected.

**New function: `compute_confidence()`**
- Input: carrier analysis dict, modulation array, unwrap risk mask, valid pixel mask
- Output: `{ carrier_confidence, modulation_coverage, unwrap_confidence, overall_confidence }`
- Pure computation, no rendering.

**New function: `render_confidence_maps()`**
- Input: modulation array, unwrap risk mask, valid pixel mask, surface dimensions
- Output: dict of three base64 PNGs (modulation_map already exists — extract and reuse `render_modulation_map`)
- The `confidence_composite` map: for each valid pixel, compute `quality = min(modulation / median_modulation, 1.0) * (1.0 if risk==0 else 0.3 if risk==2 else 0.0)`. Map to RdYlGn colormap.

**`analyze_interferogram()`** — call `compute_confidence()` and `render_confidence_maps()` after the unwrap stage. Add results to the return dict.

**Unwrap statistics** added to result dict:
- `unwrap_stats.n_corrected` — pixels that needed 2π-jump correction
- `unwrap_stats.n_edge_risk` — pixels in edge contamination zone
- `unwrap_stats.n_reliable` — `n_valid - n_corrected - n_edge_risk`

#### Changes to `api_fringe.py`

No new endpoints. The result dict grows with:
```python
{
    # ... existing fields ...
    "confidence": {
        "carrier": float,       # 0–100
        "modulation": float,    # 0–100 (coverage percentage)
        "unwrap": float,        # 0–100
        "overall": float,       # 0–100
    },
    "confidence_maps": {
        "modulation": str,      # base64 PNG
        "unwrap_risk": str,     # base64 PNG
        "composite": str,       # base64 PNG
    },
    "unwrap_stats": {
        "n_corrected": int,
        "n_edge_risk": int,
        "n_reliable": int,
    },
}
```

### 2. Confidence UI (Frontend)

#### Summary Badges

A compact row below the existing PV/RMS/Strehl stats in the results area:

```
● Carrier: Good   ● Modulation: 85%   ● Unwrap: 98%
```

Each badge: colored dot (green/amber/red) + label + value. Clicking a badge opens the Diagnostics tab.

Implementation: add a `<div id="fringe-confidence-badges">` in the results column, populated by `renderResults()` when `data.confidence` exists.

#### Surface Map Overlay Toggle

A button group above the surface map image:

```
[Surface] [Confidence] [Modulation]
```

- **Surface** — default, shows the surface map (current behavior).
- **Confidence** — swaps `<img>` src to the `confidence_composite` PNG.
- **Modulation** — swaps to the `modulation` PNG.

Simple image swap — no canvas compositing, just changing the `src` attribute. The three buttons are a radio-style toggle group. Active button gets `var(--accent)` background.

#### Diagnostics Tab

New tab in the results tab bar:

```
[Surface Map] [Profiles] [Zernike] [PSF] [MTF] [Diagnostics]
```

The tab contains three sections, each collapsible:

**Carrier Analysis:**
- FFT image (already returned as `fft_image`) displayed at ~300px width
- Primary carrier: period, angle, SNR, DC margin
- Alternate peaks listed (if any within 6 dB of primary)
- Color-coded confidence badge

**Modulation:**
- Modulation map image
- Stats: min/mean/max modulation, coverage %
- Color-coded confidence badge

**Unwrap Quality:**
- Unwrap risk map image
- Stats: n_corrected, n_edge_risk, n_reliable, confidence %
- Color-coded confidence badge

**Overall Assessment:**
One-line rule-based recommendation at the top of the tab:
- Overall ≥70: "Result is reliable."
- Overall 30–70: "[Weakest stage] is marginal — [specific advice]."
- Overall <30: "[Weakest stage] is poor — [specific advice]."

Specific advice by stage:
- Carrier <30: "Fringe pattern is weak or ambiguous. Improve fringe contrast or adjust the optical flat angle."
- Modulation <30: "Less than half the aperture has usable fringes. Check illumination and flat contact."
- Unwrap <85: "Phase unwrapping had difficulty in some regions. Check surface map for discontinuities."

### 3. Form Removal

#### Backend — Plane Fit Model

New parameter `form_model` on analyze and reanalyze endpoints:

- `"zernike"` (default) — current behavior. Subtract selected Zernike terms.
- `"plane"` — best-fit plane removal only. `ax + by + c` least-squares fit over valid pixels, then subtract.

The existing `_subtract_plane()` function (line 284) does exactly this. For `form_model="plane"`, it becomes the primary form removal instead of a residual correction.

When `form_model="plane"`:
1. Fit Zernikes (for reporting/charting only — not subtracted)
2. Fit and subtract best-fit plane from the unwrapped surface
3. Compute PV/RMS on the plane-subtracted residual
4. Render surface map, profiles, etc. from the residual

When `form_model="zernike"`:
1. Current behavior unchanged

The reanalyze endpoint also accepts `form_model`. Since plane fit needs the full reconstructed surface (not just coefficients), `reanalyze()` must reconstruct from all Zernike terms first, then apply the plane fit. This is already feasible — the reanalyze endpoint reconstructs the surface from coefficients.

#### API Changes

`AnalyzeBody` and `ReanalyzeBody` gain:
```python
form_model: str = "zernike"  # "zernike" | "plane"
```

Result dict gains:
```python
{
    "form_model": str,          # echo back which model was used
    "plane_fit": {              # only present when form_model="plane" or always for diagnostics
        "a": float,             # x-slope (nm/px)
        "b": float,             # y-slope (nm/px)
        "c": float,             # offset (nm)
        "tilt_x_nm": float,     # total tilt across image width
        "tilt_y_nm": float,     # total tilt across image height
    },
}
```

#### Frontend — Reframed Pills + Form Model Selector

**Form model selector** — a dropdown above the subtraction pills:

```
Form: [Plane ▾]   or   Form: [Zernike ▾]
```

When "Plane" is selected: pills are hidden. Switching triggers reanalyze with `form_model: "plane"`.

When "Zernike" is selected: pills are shown with new labels:

| Current | New label | Terms | Notes |
|---------|-----------|-------|-------|
| (hidden) | Piston | [1] | Always subtracted |
| Tilt (locked) | Tilt | [2, 3] | Default on, can now be unlocked |
| Power | Curvature | [4] | Toggle |
| Astig | Twist | [5, 6] | Toggle |
| Coma | Coma | [7, 8] | Name kept |
| Spherical | Spherical | [11] | Name kept |

**Tilt unlock:** Currently Tilt is locked on and cannot be disabled. Change to default-on but toggleable. The `locked: true` property in `SUBTRACT_PILLS` becomes `locked: false`. Tilt pill starts active but can be clicked off.

Switching pills triggers the existing reanalyze flow.

### 4. Carrier Diagnostics

#### Backend — Enhanced Carrier Info

Extend the `carrier` dict returned by `_analyze_carrier()`:

```python
"carrier": {
    # ... existing fields ...
    "snr_db": float,           # carrier peak power vs noise floor in dB
    "dc_margin_px": float,     # distance from carrier peak to DC mask boundary
    "alternate_peaks": [       # top 3 alternate candidates
        {
            "y": int,
            "x": int,
            "distance_px": float,
            "peak_ratio": float,
        },
        # ... up to 3
    ],
}
```

**How `snr_db` is computed:** `10 * log10(carrier_peak_value / median(fft_magnitude))` over the valid (non-DC) region.

**How `dc_margin_px` is computed:** Euclidean distance from the carrier peak to the nearest pixel in the DC mask region (the `h//80, w//80` margin).

**How alternate peaks are found:** After masking the primary carrier peak (±5px neighborhood) and its conjugate (already done for `peak_ratio` computation), find the next 3 local maxima in the FFT magnitude. Return their positions and peak ratios relative to noise.

#### Frontend — Carrier Section in Diagnostics Tab

Covered in Section 2. The FFT image is already returned. Alternate peaks are rendered as gray numbered circles on the image. The carrier stats (period, angle, SNR, DC margin, alternates) are shown as text below.

No changes to the FFT image rendering on the backend — the alternate peak markers are drawn frontend-side on a canvas overlay on the FFT `<img>`, same pattern as the fringe ROI canvas.

### 5. Unwrap Quality

#### Backend Changes

**`unwrap_phase_2d()` signature change:**

Current: `unwrap_phase_2d(wrapped, mask, quality=None)` → `ndarray`

New: `unwrap_phase_2d(wrapped, mask, quality=None, fringe_period_px=None)` → `(ndarray, ndarray)`

Second return value: `risk_mask` (uint8, same shape as input):
- 0 = reliable
- 1 = 2π-jump corrected
- 2 = edge contamination zone

**Edge contamination detection:**
```python
if fringe_period_px and fringe_period_px > 1:
    kernel_size = int(fringe_period_px)
    eroded = cv2.erode(mask.astype(np.uint8), np.ones((kernel_size, kernel_size), np.uint8))
    edge_zone = mask & ~eroded.astype(bool)
    risk_mask[edge_zone & (risk_mask == 0)] = 2
```

**2π-jump correction tracking:**

Currently (line 804):
```python
diff = unwrapped - median_filtered
unwrapped[np.abs(diff) > np.pi] -= np.round(diff[...] / (2*np.pi)) * (2*np.pi)
```

Change to also record:
```python
jump_mask = np.abs(diff) > np.pi
risk_mask[jump_mask] = 1
```

#### No Changes to Unwrap Algorithm

The quality-guided Goldstein/Zebker implementation stays as-is. These changes only instrument it.

## Files Changed

### Backend
- `backend/vision/fringe.py` — `unwrap_phase_2d()` returns risk mask, new `compute_confidence()` and `render_confidence_maps()` functions, `analyze_interferogram()` returns enriched result, `_analyze_carrier()` returns alternate peaks + SNR + DC margin, plane fit form model support in subtraction
- `backend/api_fringe.py` — `AnalyzeBody` and `ReanalyzeBody` gain `form_model` field, result schema documented

### Frontend
- `frontend/fringe-results.js` — confidence badges, surface map overlay toggles, Diagnostics tab, form model selector, reframed pill labels, tilt unlock
- `frontend/style.css` — badge styling, diagnostics tab layout, overlay toggle styling

## What's NOT Changing

- Core carrier detection algorithm (`_find_carrier`)
- Core unwrap algorithm (quality-guided Goldstein/Zebker)
- Demodulation method (spatial-domain complex demodulation)
- Backend API structure (no new endpoints)
- Averaging workflow
- Mask handling (polygon or auto)
- PSF/MTF computation
- Session save/load format (new fields are optional in the result dict)
- Cross-mode mask editing (just built)

## What's NOT In Scope

- Subpixel carrier estimation — current integer-pixel peak is sufficient, no user complaints
- Adaptive demodulation bandwidth — current fixed Gaussian works
- Robust averaging (median, trimmed mean) — separate feature
- Per-pixel standard deviation across captures — requires multi-frame infrastructure
- Recipe/template system — separate feature
- Tolerance-based pass/fail — separate feature
