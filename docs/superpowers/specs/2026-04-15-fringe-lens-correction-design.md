# Fringe Mode Lens Distortion Correction

## Goal

Apply lens distortion correction to fringe analysis so carrier detection, demodulation, Zernike fitting, and mask boundaries all operate on undistorted geometry. Users with fixed setups can save and recall fringe lens profiles.

## Current State

Microscope mode has full lens calibration (`lens-cal.js`) using golden-section search to fit a Brown-Conrady k1 coefficient, plus perspective correction (`tilt-cal.js`). The correction is applied client-side and the corrected frame is uploaded to the backend. Fringe mode has no lens correction — analysis operates on potentially distorted images, contaminating Zernike coefficients (especially coma and spherical) with lens artifacts.

The fringe lens is typically different from the microscope lens (lower magnification), so microscope mode's k1 doesn't apply. Fringe mode needs its own calibration.

## What's Changing

### 1. Backend: Undistort in Pipeline

Add `lens_k1: float = 0.0` to `analyze_interferogram()`. When non-zero, undistort the image as the first pipeline step before carrier detection.

**Implementation:**

```python
if lens_k1:
    h, w = img.shape[:2]
    cx, cy = w / 2, h / 2
    diag_sq = (w * w + h * h) / 4
    k1_raw = lens_k1 / diag_sq
    f = max(w, h)
    K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], dtype=np.float64)
    dist = np.array([k1_raw, 0, 0, 0, 0], dtype=np.float64)
    map1, map2 = cv2.initUndistortRectifyMap(K, dist, None, K, (w, h), cv2.CV_32FC1)
    img = cv2.remap(img, map1, map2, cv2.INTER_LINEAR)
```

**K1 normalization convention:** The frontend's golden-section search (`lens-cal.js`) stores k1 in normalized form where `k1_raw = k1_norm / ((w² + h²) / 4)`. The backend must apply the same denormalization to match. The search range is [-0.8, 0.8] in normalized units.

**Where it applies:**
- `analyze_interferogram()` — undistort raw image before all pipeline stages
- `/snapshot` endpoint — optional `lens_k1` query parameter for undistorted mask preview
- `reanalyze-carrier` endpoint — passes `lens_k1` through since it re-runs the full pipeline

**Where it does NOT apply:**
- `/fringe/reanalyze` — works from Zernike coefficients, not raw image
- Existing microscope-mode lens correction (untouched)

**Performance:** `cv2.initUndistortRectifyMap` + `cv2.remap` is ~2-3ms. No caching needed.

### 2. API Changes

`AnalyzeBody` gains:
```python
lens_k1: float = Field(default=0.0)
```

`ReanalyzeCarrierBody` gains:
```python
lens_k1: float = Field(default=0.0)
```

`/snapshot` gains optional query parameter:
```
GET /snapshot?lens_k1=0.35
```

No new endpoints.

### 3. Frontend: Cross-Mode Lens Calibration

#### Flow

1. User clicks "Calibrate Lens" in fringe panel
2. Switch to microscope mode (fringe lens stays mounted)
3. User places graph paper or repeating target, freezes when ready
4. Standard lens cal workflow: measure same feature at 3+ positions across field
5. Golden-section search fits k1
6. On "Apply", k1 returns to fringe mode via callback
7. User is prompted to save as a named profile

#### Cross-Mode Integration

Extend `cross-mode.js` to support `source: 'fringe-lens-cal'`:

- `initCrossMode()` already accepts arbitrary source strings
- `enterMaskEditSession()` currently assumes mask editing unconditionally — add a source check:
  - `source === 'fringe'` → mask edit session (current behavior)
  - `source === 'fringe-lens-cal'` → lens cal session (new)

**Lens cal session behavior:**
- Action bar: "Calibrating fringe lens" with "Done" and "Cancel"
- Mode switcher hidden
- The existing lens cal dialog (`lens-cal.js`) is opened automatically on session entry — it provides the measurement UI, sample list, spread stats, and k1 fitting
- Detection buttons, DXF, guided inspection — hidden/disabled
- User freezes live feed themselves when graph paper is positioned (standard microscope freeze button)
- The lens cal dialog's own "Apply" button is intercepted: instead of applying to the microscope frame, it captures the fitted k1 and returns it to fringe
- "Cancel" on the action bar (or lens cal dialog's own cancel) returns to fringe with no change

The stash/restore mechanism works the same — stash microscope state on entry, restore on exit.

#### Differences from Mask Editing Cross-Mode

| Aspect | Mask editing | Lens calibration |
|--------|-------------|-----------------|
| Snapshot | Auto-captured from fringe preview | Not needed — user freezes manually |
| Tool | Area drawing tool forced | Distance tool (for lens cal samples) |
| Image | Fringe preview frozen as background | Live feed, user freezes when ready |
| Return value | Polygon array | Single k1 float |
| Sidebar | Hidden | Shows lens cal panel only |

### 4. Frontend: Fringe Panel UI

Add to the fringe panel, near the mask controls:

```
Lens: [None ▾] [Calibrate]
```

- **Dropdown** (`<select id="fringe-lens-profile">`): Lists saved fringe lens profiles + "None". Selecting a profile sets `fr.lensK1` and triggers re-analysis if results exist.
- **Calibrate button**: Enters cross-mode lens cal session.

`fr.lensK1` is passed in every `/fringe/analyze`, `/fringe/analyze-stream`, and `/fringe/reanalyze-carrier` request as `lens_k1`.

### 5. Frontend: Fringe Lens Profiles

Separate from microscope cal profiles. Stored in localStorage under key `"loupe_fringe_lens_profiles"`.

**Data structure:**
```javascript
{ name: string, k1: number }
```

Simple — no pixelsPerMm or displayUnit since those aren't relevant for fringe lens cal.

**Functions:**
- `loadFringeLensProfiles()` → array from localStorage
- `saveFringeLensProfile(name, k1)` → append/update and persist
- `deleteFringeLensProfile(name)` → remove and persist
- `renderFringeLensDropdown()` → populate the `<select>` with saved profiles + "None"

After calibration completes, a small inline prompt appears: "Save as: [___] [Save]". User enters a name and saves. The dropdown updates to show the new profile selected.

### 6. Mask Preview Undistortion

When "Edit Mask" is clicked with `fr.lensK1` active, the snapshot must be undistorted so mask polygons align with the corrected geometry the pipeline will analyze.

The `/snapshot` endpoint gains an optional `lens_k1` query parameter. When present, the snapshot is undistorted server-side before returning the JPEG. The mask edit handler passes `fr.lensK1`:

```javascript
const resp = await apiFetch(`/snapshot${fr.lensK1 ? `?lens_k1=${fr.lensK1}` : ""}`);
```

Mask polygons are drawn on the undistorted image and sent as normalized coordinates — no additional transform needed since the pipeline also operates on the undistorted frame.

## Files Changed

### Backend
- `backend/vision/fringe.py` — undistort step at top of `analyze_interferogram()`, new `lens_k1` parameter
- `backend/api_fringe.py` — `AnalyzeBody` and `ReanalyzeCarrierBody` gain `lens_k1`, pass through to pipeline
- `backend/api.py` — `/snapshot` endpoint gains optional `lens_k1` query parameter

### Frontend
- `frontend/cross-mode.js` — source-aware session entry: route `'fringe-lens-cal'` to lens cal flow instead of mask edit
- `frontend/fringe-panel.js` — "Lens: [dropdown] [Calibrate]" UI, calibrate button handler, pass `lens_k1` in snapshot request for mask editing
- `frontend/fringe-results.js` — pass `lens_k1` in analyze/reanalyze-carrier request bodies
- `frontend/fringe-lens-profiles.js` — new module for fringe lens profile CRUD + dropdown rendering
- `frontend/style.css` — minor styling for lens dropdown row

### Unchanged
- `frontend/lens-cal.js` — existing lens cal workflow used as-is
- `frontend/cal-profiles.js` — microscope profiles untouched
- `frontend/tilt-cal.js` — perspective correction not involved
- Fringe analysis algorithm — carrier, demod, unwrap, Zernike all unchanged
- `/fringe/reanalyze` — works from coefficients

## What's NOT In Scope

- Higher-order distortion terms (k2, k3, tangential) — k1-only matches existing microscope cal
- OpenCV checkerboard calibration — overkill for this use case
- Persistent server-side k1 storage — stateless pass-with-request for now
- Perspective correction for fringe mode — not needed (fringe lens typically doesn't have tilt issues)
- Combined lens+perspective transform optimization
- Database-backed profile storage (future multi-user feature)
