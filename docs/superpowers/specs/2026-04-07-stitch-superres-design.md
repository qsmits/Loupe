# Image Stitching & Super-Resolution Design

Date: 2026-04-07

## Overview

Two wizard-guided features that leverage manual XY micrometer stages to capture
multiple frames at known positions. Both share the same UX pattern: a step-by-step
wizard that tells the user where to move and captures on Space.

---

## Feature 1: Image Stitching

### Purpose
Combine multiple overlapping tiles captured at known XY positions into a single
large seamless image. Like the Keyence "panorama stitch" mode.

### Wizard Flow
1. **Setup:** User enters grid dimensions (cols × rows), overlap % (default 20%),
   and pixel pitch (µm/px — from calibration or manual entry).
2. **Calculate:** Wizard computes travel per step:
   `step_mm = (sensor_width_px / px_per_mm) * (1 - overlap/100)`.
   Starting position is (0, 0) — user sets their micrometers to any reference.
3. **Capture loop:** Wizard highlights the current grid cell and shows the target
   X,Y micrometer readings. User moves stage, presses Space. Serpentine scan order
   (left-to-right, then right-to-left on next row) to minimize travel.
4. **Compute:** Phase-correlation registration between adjacent tile pairs to find
   true sub-pixel shifts, then multi-band blending (Laplacian pyramid) at seams.
5. **Result:** Stitched image displayed in dialog. "Use as image" loads it into
   the main canvas for measurement.

### Backend Architecture

**`backend/vision/stitch.py`** — Pure-numpy/OpenCV stitching:
- `register_pair(img_a, img_b, expected_shift_px, overlap_px)` → `(dx, dy)` via
  `cv2.phaseCorrelate` on the overlap region.
- `stitch_grid(tiles, grid_shape, overlap_px)` → stitched BGR image.
  Uses Laplacian pyramid blending in overlap zones for seamless transitions.
  Serpentine order handled here (row flip for odd rows).

**`backend/api_stitch.py`** — `make_stitch_router(camera)`:
- `_StitchSession`: grid_shape, tiles (dict of (col,row) → ndarray), overlap_frac,
  px_per_mm, result (ndarray or None).
- `POST /stitch/start` — body: `{cols, rows, overlap_pct, px_per_mm?}`.
  Validates, resets session, returns grid info + computed step distances.
- `POST /stitch/capture` — body: `{col, row}`. Captures current frame, stores at
  grid position. Returns progress count.
- `POST /stitch/compute` — runs registration + blending, stores result.
- `GET /stitch/result.png` — encoded PNG of the stitched image.
- `GET /stitch/status` — session state, captured positions, has_result.
- `POST /stitch/reset` — clears session.

### Frontend

**`frontend/stitch.js`** — exports `initStitch()`, `openStitchDialog()`:
- Dialog follows the `dialog-overlay` / `dialog-content` CSS pattern.
- Setup panel: cols/rows spinners, overlap slider, pixel pitch input.
- Grid visualization: SVG or div grid showing captured (green) / current (yellow) /
  pending (gray) cells with coordinate labels.
- Capture instructions: "Move X to 1.234 mm, Y to 0.000 mm → press Space"
- Result panel: preview image, "Use as image" button, download PNG.
- Space key handler (like zstack) while dialog is open.

### Toolbar
Button label: "Stitch" in the top-bar-right group, between 4-up and 3D.

---

## Feature 2: Super-Resolution

### Purpose
Combine multiple sub-pixel-shifted captures into a single higher-resolution image.
The user makes tiny XY stage moves (fractions of a pixel in µm) and the software
reconstructs a 2× or 4× upsampled image.

### Wizard Flow
1. **Setup:** User selects upscale factor (2× or 4×) and enters pixel pitch (µm/px).
2. **Calculate:** For 2×: 4 captures at shifts of (0,0), (½px, 0), (0, ½px), (½px, ½px).
   For 4×: 16 captures on a 4×4 sub-pixel grid (0, ¼, ½, ¾ pixel).
   Wizard converts pixel fractions to µm using pixel pitch.
3. **Capture loop:** Shows the shift in µm from starting position. User adjusts
   micrometer, presses Space.
4. **Compute:** Estimate actual sub-pixel shifts via phase correlation (don't trust
   the micrometer to sub-µm). Shift-and-add reconstruction: place each LR frame
   onto the HR grid at its estimated position, average overlapping contributions.
5. **Result:** Upscaled image displayed. "Use as image" loads into main canvas.

### Backend Architecture

**`backend/vision/superres.py`** — Pure-numpy/OpenCV:
- `estimate_shifts(frames, ref_idx=0)` → list of `(dx, dy)` sub-pixel shifts,
  using `cv2.phaseCorrelate` against the reference frame.
- `reconstruct(frames, shifts, scale)` → upscaled BGR image.
  Shift-and-add: for each frame, map its pixels onto the `scale×` grid at the
  estimated shift, accumulate and average. Lanczos interpolation for non-integer
  mapping.

**`backend/api_superres.py`** — `make_superres_router(camera)`:
- `_SuperResSession`: scale, frames list, pixel_pitch_um, result.
- `POST /superres/start` — body: `{scale, pixel_pitch_um}`. Returns shift grid
  (the list of target shifts in µm).
- `POST /superres/capture` — captures frame, appends. Returns index + progress.
- `POST /superres/compute` — runs shift estimation + reconstruction.
- `GET /superres/result.png` — encoded PNG.
- `GET /superres/status` — session state.
- `POST /superres/reset` — clears session.

### Frontend

**`frontend/superres.js`** — exports `initSuperRes()`, `openSuperResDialog()`:
- Same dialog pattern as stitch.
- Setup: scale dropdown (2× / 4×), pixel pitch input.
- Step display: "Shift X by +2.3 µm, Y by 0.0 µm from start → press Space"
- Visual: small grid showing which sub-pixel positions are captured.
- Result: preview, "Use as image", download.

### Toolbar
Button label: "SR" in top-bar-right, next to Stitch.

---

## Shared Patterns

Both features:
- Follow the zstack dialog pattern (overlay + close button + Space capture).
- Use `camera.get_frame()` via API endpoint (consistent with existing capture flow).
- Store result as PNG accessible via GET endpoint.
- Have a "Use as image" button that loads the result into the main canvas (same as
  zstack composite → "Use as background").
- Reset on new session start.
- Keyboard: Space to capture, Escape to close dialog.

## Testing

- `tests/test_stitch.py`: synthetic tiles with known offsets, verify registration,
  verify HTTP workflow.
- `tests/test_superres.py`: synthetic sub-pixel-shifted frames, verify shift
  estimation, verify reconstruction produces larger image, HTTP workflow.
