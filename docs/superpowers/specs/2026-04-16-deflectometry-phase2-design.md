# Deflectometry Phase 2: Calibration, Profiles, and Masks

**Date:** 2026-04-16
**Status:** Approved
**Prerequisite:** Phase 1 complete (slope-first results, quality summary, export-run, repeatability fix)
**Reference:** `docs/deflectometry-sofast-comparison.md` Phase 2

## Goal

Make deflectometry measurements more repeatable and trustworthy by adding setup
profiles, a measured display response curve, a display sanity check, and
user-drawn part masks. These borrow SOFAST's calibration separation concepts
while keeping the workflow lightweight for a bench tool.

## Non-Goals

- Geometric slope solver (Phase 3 of the SOFAST comparison)
- Per-pixel spatial response calibration (flat-field already covers spatial uniformity)
- Multi-frequency capture
- Changes to the capture sequence or iPad WebSocket protocol (except new pattern types)
- PDF export

---

## Design

### 1. Setup Profiles

Persist measurement configuration so setups can be reproduced between sessions.

**Profile schema:**

```json
{
  "name": "25mm flat on V-block",
  "display": {
    "model": "iPad Air 13\" M3",
    "pixel_pitch_mm": 0.0962
  },
  "capture": {
    "freq": 16,
    "averages": 3,
    "gamma": 2.2
  },
  "processing": {
    "mask_threshold": 0.02,
    "smooth_sigma": 0.0
  },
  "geometry": {
    "notes": "150mm working distance, f/2.8, 50mm mirror"
  },
  "calibration": {
    "cal_factor": 0.00123,
    "sphere_diameter_mm": 25.0
  }
}
```

**Storage:** `config.json` under `deflectometry_profiles` (list) and
`deflectometry_active_profile` (string, name of last loaded profile).

**What is NOT stored in profiles:** Flat-field data, response curves, reference
phases. These are large binary data tied to specific optical conditions and
must be re-captured each session.

**API:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/deflectometry/profiles` | GET | List all profile names and their contents |
| `/deflectometry/profiles` | POST | Save profile (body: full profile object; overwrites if name exists) |
| `/deflectometry/profiles/{name}` | DELETE | Delete a profile |
| `/deflectometry/profiles/load` | POST | Load a profile into the current session — sets freq, gamma, mask threshold, smooth sigma, cal_factor, pixel pitch on the session and returns the profile |

**Frontend:**

- Dropdown in the deflectometry settings area listing saved profiles
- "Save Profile" button captures the current UI state (freq, gamma, mask
  threshold, smooth sigma, pixel pitch, display model) plus the session's
  cal_factor into a profile. Prompts for a name.
- "Load Profile" populates all sliders/inputs and pushes cal_factor into the
  session state.
- "Delete" option in the dropdown or a small X button per entry.
- Loading a profile does NOT trigger re-capture or re-compute — it just sets
  the UI defaults for the next operation.

### 2. Display Response Calibration

Replace the assumed gamma value with a measured display+camera transfer
function. The capture takes ~15-30 seconds and runs automatically.

**The problem:** `generate_fringe_pattern()` applies `value^(1/gamma)` as
inverse gamma correction. The real transfer function of the display+camera
system is not a pure power law — it varies by display model, brightness
setting, camera exposure, and ambient light. A measured curve is more accurate.

**Capture workflow:**

1. User clicks "Calibrate Display" button.
2. Backend projects 12 grayscale steps (0, 23, 46, ..., 255) on the iPad via
   the existing WebSocket, capturing one frame per step through the mirror.
3. For each captured frame, extract the median intensity within a central ROI
   (center 50% of frame, or modulation-valid region if a prior capture exists).
4. Fit a monotonic response curve: commanded display value → observed camera
   intensity.
5. Build a 256-entry inverse LUT (observed → commanded) by interpolating the
   measured points.
6. Store the LUT in session memory.

**Backend changes:**

`backend/vision/deflectometry.py`:
- New function `build_response_lut(commanded, observed, n=256)` — pure
  function. Takes arrays of commanded (display) and observed (camera)
  intensities, fits a monotonic interpolation, returns forward LUT (commanded →
  observed) and inverse LUT (observed → commanded). Both are 256-entry uint8
  arrays.

`backend/api_deflectometry.py`:
- New endpoint `POST /deflectometry/calibrate-display` — orchestrates the
  capture loop: for each grayscale step, send a `"solid"` WebSocket message
  with the target intensity, wait for ack, capture a frame, extract median.
  Calls `build_response_lut()`, stores the inverse LUT in the session, returns
  the curve data (commanded/observed pairs) for frontend visualization.
- Session gets a new field: `inverse_lut` (None or 256-entry array).

`generate_fringe_pattern()`:
- New optional parameter `inverse_lut`. When provided, apply
  `inverse_lut[round(value * 255)]` instead of `value^(1/gamma)`.
- When `inverse_lut` is None, fall back to gamma correction as before.

`frontend/deflectometry-screen.html`:
- The `"solid"` message type already supports arbitrary fill. No changes needed
  — the backend sends `{type: "solid", color: [v, v, v]}` for each grayscale
  step. If the current solid message only supports "white"/"black", extend it
  to accept an RGB array.

**Frontend:**

- "Calibrate Display" button alongside "Flat Field" and "Capture Reference".
- Badge indicator: `defl-badge-display-cal` — lights up when response curve is
  captured.
- The curve data (12 points) shown as a small sparkline or text summary
  (e.g., "Display response captured — 12 points, max deviation from gamma 2.2:
  8%"). Nice-to-have, not critical.

**Fallback:** If no response curve is captured, gamma correction works as
before. The response calibration is an upgrade, not a requirement.

**Interaction with flat-field:** Complementary. Flat-field corrects spatial
non-uniformity (brightness varies across the frame). Response calibration
corrects temporal nonlinearity (the relationship between commanded and observed
intensity). When generating patterns: use the inverse LUT for linearization.
When processing captures: apply flat-field correction.

### 3. Display-Screen Sanity Check

A one-button pre-flight check that verifies the iPad display is fully visible,
correctly oriented, and properly scaled in the camera's field of view.

**What it catches:**
- iPad not fullscreen (browser chrome, home indicator, notch cropping)
- Wrong orientation (landscape vs portrait mismatch)
- Display zoom or accessibility scaling active
- Mirror/iPad misalignment (rotation)

**Capture workflow:**

1. User clicks "Check Display" button.
2. Backend sends a new pattern type via WebSocket: `"sanity"` — renders 4
   bright corner markers (white squares, ~20px) and a bright border rectangle
   (1px line) on a black background.
3. Capture one frame through the mirror.
4. Detect the corner markers and analyze geometry.

**Backend changes:**

`frontend/deflectometry-screen.html`:
- New pattern type `"sanity"` — draws 4 corner squares and a border rectangle
  on the canvas.

`backend/vision/deflectometry.py`:
- New function `analyze_display_check(frame, expected_aspect_ratio)` — pure
  function. Thresholds the frame to find bright blobs, identifies the 4
  corners by position (top-left, top-right, bottom-left, bottom-right),
  computes bounding rect, rotation, coverage, and crop. Returns:
  ```python
  {
      "corners_found": 4,
      "corners_expected": 4,
      "all_visible": True,
      "rotation_deg": 0.3,
      "coverage_fraction": 0.72,
      "bounding_rect": {"x": 42, "y": 18, "w": 1180, "h": 820},
      "crop": {"left": 0, "right": 0, "top": 0, "bottom": 0},
      "status": "good",
      "warnings": []
  }
  ```

`backend/api_deflectometry.py`:
- New endpoint `POST /deflectometry/check-display` — sends the sanity pattern,
  captures a frame, calls `analyze_display_check()`, returns the result.

**Warning rules:**

| Condition | Warning |
|-----------|---------|
| Missing corner(s) | "Display edge not visible — check that browser is fullscreen" |
| Rotation > 2° | "Display appears rotated N° — check mirror/iPad alignment" |
| Coverage < 30% | "Mirror covers less than 30% of the display — consider repositioning" |
| Asymmetric crop | "Display cropped on [side] — check for browser UI elements" |

**Status classification:**
- `good`: all 4 corners found, rotation < 1°, no crop
- `fair`: all 4 corners found but rotation 1-3° or minor crop
- `poor`: missing corners, rotation > 3°, or significant crop

**Frontend:**
- "Check Display" button near the calibration buttons.
- Result shown as a status line: green/amber/red badge with summary text.
- No persistent storage — this is a pre-flight check, run before measuring.

**Corner detection approach:** White squares on a black background through a
specular reflection will have high contrast. Threshold → connected components →
filter by size (reject noise) → sort by position. No need for sophisticated
feature detection.

### 4. Part Masks via Cross-Mode

Reuse the existing cross-mode polygon mask editing from fringe mode. Users draw
include/exclude polygons on a deflectometry frame, and those polygons are AND'd
with the automatic modulation mask during compute.

**Frontend changes (`deflectometry.js`):**

- "Edit Mask" button in the deflectometry panel.
- Clicking it:
  1. Captures the current camera frame as a blob (same pattern as fringe:
     freeze → fetch `/frame` → blob).
  2. Calls `initCrossMode()` with the image blob, existing mask polygons
     (`df.maskPolygons`), and a callback.
  3. Switches to microscope mode for polygon drawing.
  4. On Apply, the callback stores polygons in `df.maskPolygons` and draws a
     mask overlay on the deflectometry preview.
- "Clear Mask" button resets `df.maskPolygons` to empty.
- Mask overlay rendered on the deflectometry preview image (dimmed excluded
  areas), same visual pattern as fringe mode.

**State:** `df.maskPolygons` added to the deflectometry module state. Same
format as fringe: `[{vertices: [{x, y}, ...], include: true/false}, ...]`.

**Backend changes (`api_deflectometry.py`):**

- `ComputeBody`, `HeightmapBody`, and `DiagnosticsBody` get a new optional
  field: `mask_polygons` (list of `{vertices, include}`).
- During compute, after building the modulation mask, rasterize the user
  polygons to a binary mask at frame dimensions and AND it with the modulation
  mask. Exclude polygons punch holes regardless of modulation.

**Polygon rasterization:** The fringe pipeline already rasterizes polygons to
masks. Extract the rasterization logic to a shared utility
(e.g., `backend/vision/mask_utils.py`) or, if the code is small enough,
replicate it in the deflectometry compute path.

**Interaction with modulation mask:** User mask is AND'd with modulation mask.
Include polygon = only pixels inside the polygon AND above modulation threshold
are valid. Exclude polygon = pixels inside are always invalid. This is the same
semantics as fringe mode.

---

## File Map

| File | Change |
|------|--------|
| `backend/config.py` | Add `deflectometry_profiles` and `deflectometry_active_profile` to defaults |
| `backend/api_deflectometry.py` | Profile CRUD endpoints, `/calibrate-display`, `/check-display`, `mask_polygons` on compute/heightmap/diagnostics |
| `backend/vision/deflectometry.py` | `build_response_lut()`, `analyze_display_check()` |
| `backend/vision/mask_utils.py` | Shared polygon → binary mask rasterization (extracted from fringe or new) |
| `frontend/deflectometry.js` | Profile dropdown/save/load, calibrate display button + badge, check display button + result, edit mask button + cross-mode wiring, mask overlay |
| `frontend/deflectometry-screen.html` | `"sanity"` pattern type, extend `"solid"` for arbitrary grayscale |
| `frontend/style.css` | Badge styles for new indicators (reuse existing pattern) |
| `tests/test_deflectometry_api.py` | Tests for profile CRUD, display calibration endpoint, display check, mask_polygons on compute |

## Out of Scope

- Geometric slope solver (Phase 3)
- Per-pixel spatial response calibration
- Multi-frequency capture
- PDF export
- Changes to the capture workflow or phase shifting logic
- 3D view mask clipping (port from fringe later)
- Session persistence of flat-field or reference data
- Camera intrinsics/lens calibration integration into deflectometry

## Testing

- Profile CRUD: save, load, delete, overwrite, list. Verify loaded profile
  populates session state correctly.
- Response calibration: unit test `build_response_lut()` with known gamma
  curve, verify inverse LUT recovers linear input. Integration test for the
  endpoint with synthetic frames.
- Display check: unit test `analyze_display_check()` with synthetic corner
  images (all corners, missing corners, rotated). Verify warning generation.
- Part masks: verify polygon rasterization produces correct binary mask.
  Verify AND with modulation mask. Integration test: compute with mask_polygons
  should produce different stats than without.

## Resolved Questions

1. **Solid message format:** Verified — `renderSolid(value)` already accepts
   any integer 0-255. No changes needed to `deflectometry-screen.html` for the
   grayscale ramp capture.

2. **Response curve visualization:** Start with badge + text summary. Add
   chart later if useful.

3. **Profile naming collisions:** Silently overwrite (same as fringe wavelength
   presets). The user explicitly typed the name.
