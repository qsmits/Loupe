# Sub-Pixel Edge Refinement

## Goal

Improve measurement accuracy from ~5µm to ~1µm by replacing integer-pixel
edge locations with gradient-based sub-pixel positions. Pluggable algorithm
architecture so users can choose the best method for their edge profile.

## Context

Currently, Canny edge detection produces integer-pixel edge locations. All
downstream processing (guided inspection corridor fitting, auto-detection
line/circle fitting, manual point placement) operates on these integer
coordinates. While algebraic fitting (eigenvector lines, least-squares circles)
returns float results, the input precision caps effective accuracy at ~±0.3px
(~2µm at 152 px/mm calibration).

Sub-pixel refinement interpolates the true edge position within each pixel
using the image gradient. This is the industry standard approach — every
major metrology competitor (Mitutoyo, Keyence, Zeiss, Hexagon, OGP) has it.

## Design

### 1. Core module: `backend/vision/subpixel.py`

A single-responsibility module with a pluggable algorithm interface.

#### Public API

```python
def refine_subpixel(
    edge_xy: np.ndarray,   # Nx2 integer edge coordinates
    gray: np.ndarray,       # Grayscale image (uint8)
    method: str = "parabola",
) -> np.ndarray:
    """Refine edge pixel locations to sub-pixel precision.
    Returns Nx2 float64 array of refined coordinates."""

def refine_single_point(
    point: tuple[float, float],  # (x, y) click location
    gray: np.ndarray,
    search_radius: int = 10,
    method: str = "parabola",
) -> tuple[float, float, float]:
    """Find and refine the strongest edge near a click point.
    Returns (x, y, magnitude). Magnitude indicates edge strength
    (caller decides threshold for snap vs. no-snap)."""

def available_methods() -> list[str]:
    """Return list of supported method names."""
```

#### Algorithm: `parabola` (default)

The gradient-perpendicular parabola fit. Industry standard for metrology.

**Important:** The `gray` input must be the **raw grayscale** conversion
(`cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)`), NOT the `preprocess()` output.
Bilateral filtering blurs edge gradients and degrades sub-pixel precision.
CLAHE is acceptable (enhances local contrast without shifting edges), but
the bilateral passes must be skipped for the refinement input. Callers that
have only the preprocessed image should pass the original frame and let this
module convert it.

**Sobel kernel:** Use `ksize=5` (or Scharr operator) for smoother, more
rotationally symmetric gradients. The default `ksize=3` is noisy and
degrades sub-pixel accuracy.

1. Compute Sobel gradient (gx, gy) once for the entire image (ksize=5)
2. Gradient magnitude: `mag = sqrt(gx² + gy²)`
3. Gradient direction: `theta = atan2(gy, gx)` (perpendicular to edge)
4. For each edge pixel, sample 5 points along the gradient direction at
   offsets -2, -1, 0, +1, +2 pixels (bilinear interpolation for non-integer
   sample positions)
5. Read gradient magnitude at each sample
6. Fit parabola `f(t) = at² + bt + c` to the 5 samples (least squares or
   analytic 3-point from central samples)
7. Peak location: `t_peak = -b / (2a)`
8. Clamp `t_peak` to ±1.0 (the true peak can legitimately be up to ~0.7px
   from the Canny pixel when it lands on the edge shoulder; ±0.5 is overly
   conservative and discards valid refinements)
9. Refined position: `(x + t_peak * cos(theta), y + t_peak * sin(theta))`

All steps vectorized over all edge points using NumPy. No Python loops.

**Performance:** One Sobel pass (~5ms for 2592x1944) + vectorized refinement
(~10-20ms for ~50K edge pixels). Total: ~15-25ms per frame.

#### Algorithm: `gaussian`

Error-function fit on the intensity profile. Better for soft/blurred edges.

1. Same Sobel gradient computation for edge direction
2. Sample 7-9 points along gradient direction (wider window than parabola)
3. Read **intensity** (not gradient magnitude) at each sample
4. Fit an error function (erf) to the intensity profile:
   `I(t) = a * erf((t - t₀) / σ) + b`
   where `t₀` is the sub-pixel edge position and `σ` is the edge width
5. Use a vectorized closed-form approximation: compute the second derivative
   of the intensity profile (finite differences on the 7–9 samples), find
   its zero-crossing via linear interpolation between sign changes. This
   gives `t₀` without an iterative solver. Falls back to the central sample
   if no clean zero-crossing is found.
6. `t₀` is the sub-pixel offset; clamp to ±1.0
7. Refined position computed same as parabola

**Trade-off vs. parabola:** More robust for out-of-focus or heavily smoothed
edges where the gradient peak is broad and flat (parabola fit becomes
ill-conditioned). Slightly slower (~2x) due to the wider sampling window
(7–9 vs. 5 points) but still vectorized. Performance: ~30-50ms for ~50K
edge points. Less accurate than parabola for sharp EDM edges where the
transition is steep and well-resolved.

**Note:** A per-point `scipy.optimize.curve_fit` approach was considered but
rejected — fitting 50K four-parameter erf models is too slow (~2-5 seconds).
The second-derivative zero-crossing is a vectorized approximation that gives
comparable accuracy for typical edge profiles.

#### Algorithm: `none`

Passthrough — returns input unchanged. For debugging and comparison.

#### Adding new algorithms

Add a new function `_refine_<name>(edge_xy, gray, gx, gy, mag)` and register
it in the dispatch dict. No other code changes needed.

### 2. Guided inspection integration

**File:** `backend/vision/guided_inspection.py`

In `_inspect_line()` and `_inspect_arc_circle()`, after collecting corridor
edge pixels and before RANSAC/inlier filtering:

```python
if subpixel != "none":
    corridor_pts = refine_subpixel(corridor_pts, gray, method=subpixel)
```

The `subpixel` parameter flows from the API request body through
`inspect_features()`. Default: `"parabola"`.

The shadow-aware histogram peak detection and RANSAC filtering operate on
the refined points. Since refinement only shifts points by ±0.5px, the
corridor width (±15px) and RANSAC thresholds are unaffected.

**Override:** When the frontend sends `subpixel: "none"`, the raw pixel-level
pipeline runs as before. This is triggered by Alt-clicking "Run Inspection".

### 3. Manual measurement snap

**New endpoint:** `POST /refine-point`

Request: `{ "x": float, "y": float, "search_radius": int, "subpixel": str }`
Response: `{ "x": float, "y": float, "magnitude": float }`

Created inside `make_inspection_router()` (needs `frame_store` access).

Uses `refine_single_point()`:
1. Get the full frozen frame from `frame_store`, convert to raw grayscale
2. Compute Sobel gradient on the full frame (or cache it — same frame is
   reused for multiple clicks until the next freeze)
3. Search the `(2*radius+1)²` window around (x, y) for the pixel with the
   highest gradient magnitude
4. Refine that pixel to sub-pixel using the selected method. The gradient
   is already computed on the full frame, so no window-border artifacts.
5. Return the refined position and the magnitude

**Frontend behavior** (in `events-mouse.js` mousedown for measurement tools):
- If frozen and tool is a measurement tool and not Alt-held:
  - Call `POST /refine-point` with the click position
  - If `magnitude > threshold`: use refined (x, y) as the measurement point
  - Otherwise: use raw click position (no strong edge nearby)
- Show diamond handle marker for sub-pixel-snapped points (vs. circle for raw)

**Latency:** ~5-10ms round-trip. Imperceptible for click-based interaction.

### 4. Auto-detection integration

**Files:** `backend/vision/detection.py` detection functions

Add optional `subpixel: str = "none"` parameter to:
- `detect_lines_contour()`
- `detect_circles()`
- `detect_arcs_partial()`

**Two-phase approach:** Canny + Hough/contour detection run as-is on the
binary edge image (these algorithms require integer pixel masks — you cannot
pass float coordinates to `cv2.HoughLinesP` or `cv2.findContours`). Sub-pixel
refinement applies *after* features are identified, on the edge points
belonging to each detected feature before the final algebraic fit.

Specifically:
- **`detect_lines_contour()`**: After Douglas-Peucker identifies line segments
  from contours, refine the contour points within each segment before
  computing the final endpoint coordinates.
- **`detect_circles()`**: After contour extraction and circularity filtering,
  refine the contour points before `fit_circle_algebraic()`.
- **`detect_arcs_partial()`**: Same — refine contour points before arc fitting.
- **`detect_lines()` (Hough)**: Not applicable — HoughLinesP returns line
  parameters directly, not fitted edge points. Sub-pixel refinement does not
  apply to this path.

**Default: off** (`"none"`). Enabled by a "Sub-pixel" checkbox in the
detection panel. When checked, uses `state.settings.subpixelMethod`.

**Rationale for off-by-default:** Sub-pixel refinement amplifies whatever
edges it finds. On clean EDM edges it improves accuracy. On noisy images
(3D prints, bad lighting) it can make false detections more confident.

### 5. Configuration and UI

**Config** (`config.json`):
```json
{ "subpixel_method": "parabola" }
```
Add `"subpixel_method": "parabola"` to `_DEFAULTS` in `backend/config.py`
so existing installations get the default on first load.

**Settings dialog** (General section, not Camera):
- "Sub-pixel method" dropdown: populated from `GET /subpixel-methods`
- Options: "None (pixel-level)", "Parabola (default)", "Gaussian (soft edges)"

**Detection panel**:
- Checkbox: "Sub-pixel" next to detection buttons
- When checked, detection requests include the configured method

**New endpoint:** `GET /subpixel-methods`
- Returns: `["none", "parabola", "gaussian"]`
- Used to populate the settings dropdown

### 6. Visual feedback

- **Diamond handle** on measurement points that were sub-pixel snapped
  (vs. the existing circle handle for raw points). Annotation points that
  are currently stored as bare `{x, y}` gain an optional `snapped: true`
  flag: `{x, y, snapped: true}`. This is backward-compatible — existing
  annotations without the flag render normally. Drawn in
  `render-annotations.js` by checking the flag on each point.
- **Status bar message** when a point is snapped: "Snapped to sub-pixel edge"
  (brief, auto-clears).

### 7. Testing strategy

#### Unit tests (`tests/test_subpixel.py`)

- **Synthetic edge image:** Create a grayscale image with a known edge at
  a sub-pixel position (e.g., a smooth step function shifted by 0.3px).
  Verify that `refine_subpixel` returns positions within ±0.05px of the
  true edge.
- **Diagonal edge:** Edge at 30° angle. Verify refinement accuracy is
  orientation-independent.
- **Circle edge:** Synthetic circle at known sub-pixel center. Verify
  refined points produce a better circle fit than raw integer points.
- **Method consistency:** `none` returns exact input. `parabola` and
  `gaussian` return points within ±1.0px of input (clamp check).
- **Edge cases:** Points at image border (no room to sample). Points with
  zero gradient (flat area). Empty input array.
- **`refine_single_point`:** Synthetic image with one strong edge. Verify
  the returned point is on the edge and magnitude is high. Click far from
  any edge → magnitude is low.

#### Integration tests (`tests/test_guided_inspection.py`)

- Existing guided inspection tests with `subpixel="parabola"` — verify
  results are still valid (deviations may change slightly but should still
  pass/fail correctly).
- Compare deviation precision: same test with `"none"` vs. `"parabola"` —
  parabola should produce tighter fits (lower residuals).

#### Manual testing with Mitutoyo reference scale

1. **Repeatability:** Measure same 1mm gap 10 times. Compare σ before/after.
2. **Known distance:** Calibrate on 0-10mm, measure 1mm and 5mm gaps.
3. **Line straightness:** Detect a graduation line, check RMS deviation.

## What this does NOT include

- Lens distortion correction (separate feature, not needed for single-mag)
- New edge detection algorithms (still Canny — sub-pixel refines its output)
- Changes to DXF alignment (alignment uses template matching, not edge points)
- UI for visualizing gradient magnitude or edge direction
