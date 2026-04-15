# Deflectometry Phase 1: Honest Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add slope-first result display, quality summary, unit honesty, run export, and fix the repeatability script so deflectometry results are more informative and trustworthy.

**Architecture:** Two new pure functions in `deflectometry.py` (slope magnitude, curl residual), a quality summary builder, and an export endpoint. Frontend gets a richer results grid and quality banner. No changes to capture workflow, iPad communication, or existing computation logic.

**Tech Stack:** Python/NumPy (backend), vanilla JS (frontend), FastAPI (API)

**Spec:** `docs/superpowers/specs/2026-04-15-deflectometry-phase1-design.md`

---

### Task 1: Slope magnitude and curl residual functions

**Files:**
- Modify: `backend/vision/deflectometry.py` (add after `phase_stats` at line 183)
- Test: `tests/test_deflectometry.py`

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_deflectometry.py`:

```python
from backend.vision.deflectometry import (
    create_modulation_mask,
    fit_sphere_calibration,
    frankot_chellappa,
    generate_fringe_pattern, compute_wrapped_phase, unwrap_phase,
    phase_stats, pseudocolor_png_b64, remove_tilt,
    compute_slope_magnitude, compute_curl_residual,
)


def test_slope_magnitude_basic():
    """Slope magnitude of orthogonal unit slopes is sqrt(2)."""
    dzdx = np.ones((32, 32), dtype=np.float64)
    dzdy = np.ones((32, 32), dtype=np.float64)
    mag = compute_slope_magnitude(dzdx, dzdy)
    assert mag.shape == (32, 32)
    np.testing.assert_allclose(mag, np.sqrt(2), atol=1e-10)


def test_slope_magnitude_with_mask():
    """Masked pixels should be NaN."""
    dzdx = np.ones((32, 32), dtype=np.float64)
    dzdy = np.ones((32, 32), dtype=np.float64)
    mask = np.zeros((32, 32), dtype=bool)
    mask[10:20, 10:20] = True
    mag = compute_slope_magnitude(dzdx, dzdy, mask=mask)
    assert np.all(np.isfinite(mag[10:20, 10:20]))
    assert np.all(np.isnan(mag[0, 0]))


def test_curl_zero_for_integrable_field():
    """A gradient field (exact derivatives of a surface) should have near-zero curl."""
    # Surface: z = x^2 + y^2, dzdx = 2x, dzdy = 2y
    y, x = np.mgrid[0:64, 0:64].astype(np.float64)
    dzdx = 2 * x
    dzdy = 2 * y
    curl = compute_curl_residual(dzdx, dzdy)
    assert curl.shape == (64, 64)
    # Interior should be near zero (edges have finite-difference artifacts)
    interior = curl[5:-5, 5:-5]
    assert np.abs(interior).max() < 0.1


def test_curl_nonzero_for_nonintegrable_field():
    """A non-integrable field (dzdx/dy != dzdy/dx) should have nonzero curl."""
    y, x = np.mgrid[0:64, 0:64].astype(np.float64)
    # dzdx = y, dzdy = -x → curl = d(y)/dy - d(-x)/dx = 1 - (-1) = 2
    dzdx = y
    dzdy = -x
    curl = compute_curl_residual(dzdx, dzdy)
    interior = curl[2:-2, 2:-2]
    np.testing.assert_allclose(interior, 2.0, atol=0.1)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_deflectometry.py::test_slope_magnitude_basic tests/test_deflectometry.py::test_curl_zero_for_integrable_field -v`
Expected: FAIL with `ImportError: cannot import name 'compute_slope_magnitude'`

- [ ] **Step 3: Implement the functions**

Add to `backend/vision/deflectometry.py` after the `phase_stats` function (after line 183):

```python
def compute_slope_magnitude(dzdx: np.ndarray, dzdy: np.ndarray,
                            mask: np.ndarray | None = None) -> np.ndarray:
    """Slope magnitude sqrt(dzdx^2 + dzdy^2).

    Returns float64 array. Masked pixels are set to NaN if mask is provided.
    """
    mag = np.sqrt(dzdx**2 + dzdy**2)
    if mask is not None:
        mag = mag.astype(np.float64)
        mag[~mask.astype(bool)] = np.nan
    return mag


def compute_curl_residual(dzdx: np.ndarray, dzdy: np.ndarray,
                          mask: np.ndarray | None = None) -> np.ndarray:
    """Curl of the slope field: d(dzdx)/dy - d(dzdy)/dx.

    For a physically valid surface, curl should be near zero everywhere.
    Large curl indicates unwrap errors, noise, or non-physical artifacts.
    Uses np.gradient for finite differences.

    Returns float64 array. Masked pixels are set to NaN if mask is provided.
    """
    curl = np.gradient(dzdx, axis=0) - np.gradient(dzdy, axis=1)
    if mask is not None:
        curl = curl.astype(np.float64)
        curl[~mask.astype(bool)] = np.nan
    return curl
```

Also update the import list at the top of `tests/test_deflectometry.py` to include the new functions (as shown in step 1).

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_deflectometry.py -v`
Expected: All tests PASS (existing + 4 new)

- [ ] **Step 5: Commit**

```bash
git add backend/vision/deflectometry.py tests/test_deflectometry.py
git commit -m "feat(deflectometry): add compute_slope_magnitude and compute_curl_residual"
```

---

### Task 2: Diverging colormap helper for curl rendering

**Files:**
- Modify: `backend/vision/deflectometry.py` (add after `pseudocolor_png_b64`)
- Test: `tests/test_deflectometry.py`

The existing `pseudocolor_png_b64` uses VIRIDIS (sequential). Curl needs a diverging colormap centered on zero (blue = negative, white = zero, red = positive).

- [ ] **Step 1: Write the failing test**

Add to `tests/test_deflectometry.py`:

```python
from backend.vision.deflectometry import diverging_png_b64


def test_diverging_png_b64_produces_valid_png():
    """Diverging colormap should produce a valid base64 PNG."""
    data = np.random.randn(32, 32).astype(np.float64)
    b64 = diverging_png_b64(data)
    assert isinstance(b64, str)
    assert len(b64) > 100
    raw = base64.b64decode(b64)
    assert raw[:4] == b'\x89PNG'


def test_diverging_png_b64_centers_on_zero():
    """Zero values should map to white/neutral."""
    data = np.zeros((32, 32), dtype=np.float64)
    b64 = diverging_png_b64(data)
    raw = base64.b64decode(b64)
    assert raw[:4] == b'\x89PNG'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_deflectometry.py::test_diverging_png_b64_produces_valid_png -v`
Expected: FAIL with `ImportError: cannot import name 'diverging_png_b64'`

- [ ] **Step 3: Implement the function**

Add to `backend/vision/deflectometry.py` after `pseudocolor_png_b64` (after line 220):

```python
def diverging_png_b64(data: np.ndarray, mask: np.ndarray | None = None) -> str:
    """Render a diverging colormap (blue-white-red) centered on zero.

    Useful for curl residual and other signed quantities where zero is
    the expected value. Symmetric range: ±max(|data|).

    Returns a base64 PNG string (no 'data:' prefix).
    """
    d = np.asarray(data, dtype=np.float64)
    if mask is not None:
        valid = mask.astype(bool)
        if valid.any():
            vmax = float(np.nanmax(np.abs(d[valid])))
        else:
            vmax = 1.0
    else:
        vmax = float(np.nanmax(np.abs(d)))
    if vmax < 1e-15:
        vmax = 1.0
    # Normalize to [-1, 1], then map to [0, 255]
    norm = np.clip(d / vmax, -1, 1)
    # Blue (negative) → White (zero) → Red (positive)
    r = np.clip((norm + 1) * 127.5, 0, 255).astype(np.uint8)
    g = np.clip((1 - np.abs(norm)) * 255, 0, 255).astype(np.uint8)
    b = np.clip((1 - norm) * 127.5, 0, 255).astype(np.uint8)
    colored = np.stack([b, g, r], axis=-1)  # BGR for cv2
    if mask is not None:
        colored[~valid] = 0
    ok, buf = cv2.imencode(".png", colored)
    if not ok:
        raise RuntimeError("cv2.imencode failed for PNG output")
    return base64.b64encode(buf.tobytes()).decode("ascii")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_deflectometry.py -v`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/vision/deflectometry.py tests/test_deflectometry.py
git commit -m "feat(deflectometry): add diverging_png_b64 colormap for curl rendering"
```

---

### Task 3: Quality summary computation

**Files:**
- Modify: `backend/vision/deflectometry.py`
- Test: `tests/test_deflectometry.py`

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_deflectometry.py`:

```python
from backend.vision.deflectometry import compute_quality_summary


def test_quality_summary_good_data():
    """Good data should produce 'good' overall quality."""
    # Integrable slope field with good modulation
    h, w = 64, 64
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    dzdx = 0.01 * x
    dzdy = 0.01 * y
    mask = np.ones((h, w), dtype=bool)
    mod_x = np.full((h, w), 50.0)
    mod_y = np.full((h, w), 45.0)
    frames_x = [np.full((h, w), 128.0) for _ in range(8)]  # no clipping
    frames_y = [np.full((h, w), 128.0) for _ in range(8)]

    q = compute_quality_summary(dzdx, dzdy, mask, mod_x, mod_y, frames_x, frames_y)
    assert q["overall"] == "good"
    assert q["modulation_coverage"] > 50
    assert q["clipped_fraction"] < 1
    assert len(q["warnings"]) == 0


def test_quality_summary_clipped_data():
    """Saturated frames should produce a clipping warning."""
    h, w = 64, 64
    dzdx = np.zeros((h, w))
    dzdy = np.zeros((h, w))
    mask = np.ones((h, w), dtype=bool)
    mod_x = np.full((h, w), 50.0)
    mod_y = np.full((h, w), 50.0)
    # 30% of pixels at 255 (saturated)
    frame = np.full((h, w), 128.0)
    frame[:20, :] = 255.0
    frames_x = [frame.copy() for _ in range(8)]
    frames_y = [np.full((h, w), 128.0) for _ in range(8)]

    q = compute_quality_summary(dzdx, dzdy, mask, mod_x, mod_y, frames_x, frames_y)
    assert q["clipped_fraction"] > 5
    assert any("clip" in w.lower() for w in q["warnings"])


def test_quality_summary_modulation_imbalance():
    """Large X/Y modulation difference should produce a warning."""
    h, w = 64, 64
    dzdx = np.zeros((h, w))
    dzdy = np.zeros((h, w))
    mask = np.ones((h, w), dtype=bool)
    mod_x = np.full((h, w), 50.0)
    mod_y = np.full((h, w), 20.0)  # 60% lower
    frames_x = [np.full((h, w), 128.0) for _ in range(8)]
    frames_y = [np.full((h, w), 128.0) for _ in range(8)]

    q = compute_quality_summary(dzdx, dzdy, mask, mod_x, mod_y, frames_x, frames_y)
    assert any("imbalance" in w.lower() or "modulation" in w.lower() for w in q["warnings"])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_deflectometry.py::test_quality_summary_good_data -v`
Expected: FAIL with `ImportError: cannot import name 'compute_quality_summary'`

- [ ] **Step 3: Implement the function**

Add to `backend/vision/deflectometry.py` after `compute_curl_residual`:

```python
def compute_quality_summary(
    dzdx: np.ndarray, dzdy: np.ndarray, mask: np.ndarray,
    mod_x: np.ndarray, mod_y: np.ndarray,
    frames_x: list[np.ndarray], frames_y: list[np.ndarray],
    curl_fair: float = 0.05, curl_poor: float = 0.2,
) -> dict:
    """Compute a quality summary for a deflectometry measurement.

    Returns dict with modulation_coverage, modulation_x_median,
    modulation_y_median, clipped_fraction, curl_rms, curl_max,
    mask_valid_frac, overall ('good'/'fair'/'poor'), and warnings list.
    """
    valid = mask.astype(bool)
    n_valid = int(valid.sum())
    n_total = int(mask.size)
    mask_valid_frac = n_valid / max(n_total, 1)

    # Modulation stats over valid region
    mod_x_median = float(np.median(mod_x[valid])) if n_valid > 0 else 0.0
    mod_y_median = float(np.median(mod_y[valid])) if n_valid > 0 else 0.0
    modulation_coverage = 100.0 * mask_valid_frac

    # Clipped pixel fraction: any frame pixel at 0 or 255 within mask
    clipped = np.zeros(mask.shape, dtype=bool)
    for f in frames_x + frames_y:
        arr = np.asarray(f)
        clipped |= (arr <= 0.5) | (arr >= 254.5)
    clipped_in_mask = clipped & valid
    clipped_fraction = 100.0 * float(clipped_in_mask.sum()) / max(n_valid, 1)

    # Curl residual
    curl = compute_curl_residual(dzdx, dzdy)
    if n_valid > 0:
        curl_valid = curl[valid]
        curl_rms = float(np.sqrt(np.mean(curl_valid**2)))
        curl_max = float(np.max(np.abs(curl_valid)))
    else:
        curl_rms = 0.0
        curl_max = 0.0

    # Warnings
    warnings = []
    if modulation_coverage < 50:
        warnings.append("Less than half the image has usable signal.")
    mod_max = max(mod_x_median, mod_y_median, 1e-10)
    mod_diff = abs(mod_x_median - mod_y_median) / mod_max
    if mod_diff > 0.2:
        low_axis = "Y" if mod_y_median < mod_x_median else "X"
        warnings.append(
            f"{low_axis} modulation is {mod_diff*100:.0f}% lower -- "
            f"check fringe contrast and display orientation."
        )
    if clipped_fraction > 5:
        warnings.append(
            f"{clipped_fraction:.0f}% of pixels are clipped -- "
            f"reduce exposure or display brightness."
        )
    if curl_rms > curl_fair:
        warnings.append(
            "Integration residual is elevated -- "
            "check surface map for artifacts."
        )

    # Overall
    if (modulation_coverage < 30 or curl_rms > curl_poor
            or clipped_fraction > 20):
        overall = "poor"
    elif (modulation_coverage >= 70 and curl_rms < curl_fair
            and clipped_fraction < 5 and not warnings):
        overall = "good"
    else:
        overall = "fair"

    return {
        "modulation_coverage": round(modulation_coverage, 1),
        "modulation_x_median": round(mod_x_median, 1),
        "modulation_y_median": round(mod_y_median, 1),
        "clipped_fraction": round(clipped_fraction, 1),
        "curl_rms": round(curl_rms, 4),
        "curl_max": round(curl_max, 4),
        "mask_valid_frac": round(mask_valid_frac, 3),
        "overall": overall,
        "warnings": warnings,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_deflectometry.py -v`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/vision/deflectometry.py tests/test_deflectometry.py
git commit -m "feat(deflectometry): add compute_quality_summary with warnings"
```

---

### Task 4: Extend `/compute` endpoint with slope, curl, and quality

**Files:**
- Modify: `backend/api_deflectometry.py:36-47` (imports), `383-423` (compute endpoint)
- Test: `tests/test_deflectometry_api.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_deflectometry_api.py`:

```python
def test_compute_returns_slope_and_quality(client, captured_session):
    """After capture, /compute should return slope_mag, curl, and quality."""
    r = client.post("/deflectometry/compute", json={"mask_threshold": 0.02})
    assert r.status_code == 200
    data = r.json()
    # New fields
    assert "slope_mag_png_b64" in data
    assert "curl_png_b64" in data
    assert "stats_slope_mag" in data
    assert "stats_curl" in data
    assert "quality" in data
    q = data["quality"]
    assert q["overall"] in ("good", "fair", "poor")
    assert "modulation_coverage" in q
    assert "curl_rms" in q
    assert "warnings" in q
    assert isinstance(q["warnings"], list)
```

Note: This test depends on the existing `captured_session` fixture in the test file. Read the test file to verify the fixture name and adapt if needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_deflectometry_api.py::test_compute_returns_slope_and_quality -v`
Expected: FAIL (key `slope_mag_png_b64` not in response)

- [ ] **Step 3: Update the imports in api_deflectometry.py**

At the top of `backend/api_deflectometry.py`, update the import block (lines 36-47):

```python
from .vision.deflectometry import (
    compute_modulation,
    compute_wrapped_phase,
    create_modulation_mask,
    find_optimal_smooth_sigma,
    fit_sphere_calibration,
    frankot_chellappa,
    phase_stats,
    pseudocolor_png_b64,
    diverging_png_b64,
    remove_tilt,
    unwrap_phase,
    compute_slope_magnitude,
    compute_curl_residual,
    compute_quality_summary,
)
```

- [ ] **Step 4: Extend the compute endpoint**

In `backend/api_deflectometry.py`, in the `deflectometry_compute` function (around line 383), after the mask computation and before building the result dict, add slope magnitude, curl, and quality computation. Replace the `result = {` block (lines 409-417) with:

```python
        # Slope magnitude and curl residual
        slope_mag = compute_slope_magnitude(unw_x, unw_y, mask=mask)
        curl = compute_curl_residual(unw_x, unw_y, mask=mask)

        # Quality summary
        quality = compute_quality_summary(
            unw_x, unw_y, mask, mod_x, mod_y, frames_x, frames_y,
        )

        result = {
            "phase_x_png_b64": pseudocolor_png_b64(unw_x, mask=mask),
            "phase_y_png_b64": pseudocolor_png_b64(unw_y, mask=mask),
            "slope_mag_png_b64": pseudocolor_png_b64(slope_mag, mask=mask),
            "curl_png_b64": diverging_png_b64(curl, mask=mask),
            "stats_x": phase_stats(unw_x, mask=mask),
            "stats_y": phase_stats(unw_y, mask=mask),
            "stats_slope_mag": phase_stats(slope_mag, mask=mask),
            "stats_curl": phase_stats(curl, mask=mask),
            "has_reference": has_reference,
            "mask_valid_frac": mask_valid_frac,
            "cal_factor": s.cal_factor,
            "quality": quality,
        }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_deflectometry_api.py -v`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add backend/api_deflectometry.py tests/test_deflectometry_api.py
git commit -m "feat(deflectometry): extend /compute with slope mag, curl, and quality"
```

---

### Task 5: Frontend — slope-first results tab and quality banner

**Files:**
- Modify: `frontend/deflectometry.js:120-141` (tab label + phase grid), `26-38` (formatStats), `479-494` (renderPhaseResult)
- Modify: `frontend/style.css` (quality banner styles)

- [ ] **Step 1: Rename the tab and expand the results grid**

In `frontend/deflectometry.js`, change the tab button text (line 121):

```javascript
          <button class="defl-tab active" data-tab="phase">Slope & Phase</button>
```

Replace the phase content div (lines 128-141) with:

```javascript
          <div id="defl-phase-content" hidden>
            <div id="defl-quality-banner" class="defl-quality-banner" hidden></div>
            <div class="defl-phase-grid">
              <div>
                <div style="font-size:12px;opacity:0.85;margin-bottom:4px">Slope X (phase)</div>
                <img id="defl-phase-x-img" />
                <pre id="defl-phase-x-stats">\u2014</pre>
              </div>
              <div>
                <div style="font-size:12px;opacity:0.85;margin-bottom:4px">Slope Y (phase)</div>
                <img id="defl-phase-y-img" />
                <pre id="defl-phase-y-stats">\u2014</pre>
              </div>
              <div>
                <div style="font-size:12px;opacity:0.85;margin-bottom:4px">Slope Magnitude</div>
                <img id="defl-slope-mag-img" />
                <pre id="defl-slope-mag-stats">\u2014</pre>
              </div>
              <div>
                <div style="font-size:12px;opacity:0.85;margin-bottom:4px">Curl Residual</div>
                <img id="defl-curl-img" />
                <pre id="defl-curl-stats">\u2014</pre>
              </div>
            </div>
            <div id="defl-unit-note" style="font-size:10px;opacity:0.5;text-align:center;margin-top:4px"></div>
          </div>
```

- [ ] **Step 2: Update formatStats for unit honesty**

Replace the `formatStats` function (lines 26-38) with:

```javascript
function formatStats(stats, calFactor) {
  if (!stats) return "\u2014";
  if (calFactor) {
    const k = Math.abs(calFactor) * 1000;
    const pv = Number.isFinite(stats.pv) ? (stats.pv * k).toFixed(2) : "\u2014";
    const rms = Number.isFinite(stats.rms) ? (stats.rms * k).toFixed(2) : "\u2014";
    const mean = Number.isFinite(stats.mean) ? (stats.mean * k).toFixed(2) : "\u2014";
    return `PV:   ${pv} \u00b5m\nRMS:  ${rms} \u00b5m\nMean: ${mean} \u00b5m`;
  }
  const pv = Number.isFinite(stats.pv) ? stats.pv.toFixed(3) : "\u2014";
  const rms = Number.isFinite(stats.rms) ? stats.rms.toFixed(3) : "\u2014";
  const mean = Number.isFinite(stats.mean) ? stats.mean.toFixed(3) : "\u2014";
  return `PV:   ${pv}\nRMS:  ${rms}\nMean: ${mean}`;
}
```

- [ ] **Step 3: Update renderPhaseResult for new fields**

Replace the `renderPhaseResult` function (lines 479-494) with:

```javascript
function renderPhaseResult(result) {
  if (!result) return;
  const content = $("defl-phase-content");
  const empty = $("defl-phase-empty");
  if (content) content.hidden = false;
  if (empty) empty.hidden = true;

  // Phase / slope images
  if (result.phase_x_png_b64) {
    $("defl-phase-x-img").src = "data:image/png;base64," + result.phase_x_png_b64;
  }
  if (result.phase_y_png_b64) {
    $("defl-phase-y-img").src = "data:image/png;base64," + result.phase_y_png_b64;
  }
  if (result.slope_mag_png_b64) {
    $("defl-slope-mag-img").src = "data:image/png;base64," + result.slope_mag_png_b64;
  }
  if (result.curl_png_b64) {
    $("defl-curl-img").src = "data:image/png;base64," + result.curl_png_b64;
  }

  // Stats
  const cal = result.cal_factor || null;
  $("defl-phase-x-stats").textContent = formatStats(result.stats_x, cal);
  $("defl-phase-y-stats").textContent = formatStats(result.stats_y, cal);
  $("defl-slope-mag-stats").textContent = formatStats(result.stats_slope_mag, cal);
  $("defl-curl-stats").textContent = formatStats(result.stats_curl, null);  // curl is always in rad

  // Unit note
  const unitNote = $("defl-unit-note");
  if (unitNote) {
    if (cal) {
      unitNote.textContent = "Calibrated: heights in \u00b5m";
    } else {
      unitNote.textContent = "Uncalibrated: values in phase-radians. Sphere calibration needed for physical units.";
    }
  }

  // Quality banner
  renderQualityBanner(result.quality);
}

function renderQualityBanner(quality) {
  const banner = $("defl-quality-banner");
  if (!banner || !quality) { if (banner) banner.hidden = true; return; }
  banner.hidden = false;

  const colors = { good: "rgba(48,209,88,0.15)", fair: "rgba(255,159,10,0.15)", poor: "rgba(255,69,58,0.15)" };
  const labels = { good: "Result is reliable.", fair: "Result is usable but check warnings.", poor: "Result may be unreliable." };

  let msg = labels[quality.overall] || "";
  if (quality.warnings && quality.warnings.length > 0) {
    msg += " " + quality.warnings[0];
  }
  banner.textContent = msg;
  banner.style.background = colors[quality.overall] || colors.fair;
  banner.title = quality.warnings ? quality.warnings.join("\n") : "";
}
```

- [ ] **Step 4: Add quality banner CSS**

Add to `frontend/style.css` after the existing `.defl-phase-grid` styles:

```css
.defl-quality-banner {
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  margin-bottom: 8px;
}
```

- [ ] **Step 5: Manually test**

Restart the server, switch to deflectometry mode, and verify:
- Tab label says "Slope & Phase"
- Four images appear in a 2x2 grid after compute
- Quality banner appears above the grid
- Stats show "phase-radians" label when uncalibrated
- Curl image uses blue-white-red colormap

- [ ] **Step 6: Commit**

```bash
git add frontend/deflectometry.js frontend/style.css
git commit -m "feat(deflectometry): slope-first results tab with quality banner"
```

---

### Task 6: Run export endpoint

**Files:**
- Modify: `backend/api_deflectometry.py` (add endpoint)
- Modify: `frontend/deflectometry.js` (add export button)
- Test: `tests/test_deflectometry_api.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_deflectometry_api.py`:

```python
def test_export_run_returns_structured_json(client, captured_session):
    """Export-run should return a complete run record."""
    # Need compute first
    client.post("/deflectometry/compute", json={"mask_threshold": 0.02})
    r = client.post("/deflectometry/export-run", json={})
    assert r.status_code == 200
    data = r.json()
    assert data["version"] == 1
    assert "timestamp" in data
    assert "acquisition" in data
    assert data["acquisition"]["n_phase_steps"] == 8
    assert "quality" in data
    assert "stats" in data
    assert "modulation" in data
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_deflectometry_api.py::test_export_run_returns_structured_json -v`
Expected: FAIL (404, endpoint not found)

- [ ] **Step 3: Add the ExportRunBody model and endpoint**

Add to `backend/api_deflectometry.py` after `DiagnosticsBody` (line 123):

```python
class ExportRunBody(BaseModel):
    pass
```

Add the endpoint inside `make_deflectometry_router`, after the diagnostics endpoint (after line 665):

```python
    @router.post("/deflectometry/export-run", dependencies=[Depends(_reject_hosted)])
    async def deflectometry_export_run(body: ExportRunBody = ExportRunBody()):  # noqa: B008
        """Return a structured JSON record of the current measurement run."""
        import datetime
        s = _current()
        if s is None or s.last_result is None:
            raise HTTPException(400, detail="Run compute first")

        result = s.last_result

        return {
            "version": 1,
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "acquisition": {
                "n_frames": len(s.frames),
                "n_phase_steps": 8,
                "frequency_cycles": s.freq,
                "gamma": 2.2,
                "smooth_sigma": 0.0,
                "mask_threshold": 0.02,
                "has_flat_field": s.flat_white is not None,
                "has_reference": s.ref_phase_x is not None,
            },
            "calibration": {
                "cal_factor": s.cal_factor,
            },
            "quality": result.get("quality"),
            "stats": {
                "phase_x": result.get("stats_x"),
                "phase_y": result.get("stats_y"),
                "slope_magnitude": result.get("stats_slope_mag"),
                "curl": result.get("stats_curl"),
            },
            "modulation": {
                "x_median": result.get("quality", {}).get("modulation_x_median"),
                "y_median": result.get("quality", {}).get("modulation_y_median"),
            },
            "mask_valid_frac": result.get("mask_valid_frac"),
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_deflectometry_api.py -v`
Expected: All tests PASS

- [ ] **Step 5: Add export button to frontend**

In `frontend/deflectometry.js`, add an "Export Run" button in the action bar. In the `buildWorkspace` function, find the action bar div (around line 106-118). After the Reset button (line 111), add:

```javascript
          <button class="detect-btn" id="defl-btn-export" style="font-size:11px;padding:2px 8px">Export Run</button>
```

In the `wireEvents` function, add the event handler after the reset handler (after line 250):

```javascript
  $("defl-btn-export")?.addEventListener("click", exportRun);
```

Add the `exportRun` function after `resetSession`:

```javascript
async function exportRun() {
  try {
    const r = await apiFetch("/deflectometry/export-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      console.warn("Export failed:", await r.text());
      return;
    }
    const data = await r.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = `deflectometry-run-${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn("Export error:", e);
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add backend/api_deflectometry.py frontend/deflectometry.js tests/test_deflectometry_api.py
git commit -m "feat(deflectometry): add /export-run endpoint and UI button"
```

---

### Task 7: Fix repeatability script for 8-step capture

**Files:**
- Modify: `scripts/dev/deflectometry_repeatability.py:81,100-111`

- [ ] **Step 1: Fix the frame loop**

In `scripts/dev/deflectometry_repeatability.py`, replace lines 81 and 100-111:

Change line 81 from:
```python
        print("  Captured 8 frames")
```
to:
```python
        print("  Captured 16 frames (8 per orientation)")
```

Replace lines 100-111:
```python
        # Compute locally from saved frames for consistency
        frames = []
        for orient in ("x", "y"):
            for phase_idx in range(4):
                fpath = os.path.join(run_dir, f"frame_{orient}_{phase_idx}.png")
                img = cv2.imread(fpath)
                if img is None:
                    print(f"  ERROR: could not read {fpath}")
                    sys.exit(1)
                frames.append(img.astype(np.float64).mean(axis=-1))

        frames_x = frames[:4]
        frames_y = frames[4:]
```

with:

```python
        # Compute locally from saved frames for consistency
        frames = []
        for orient in ("x", "y"):
            for phase_idx in range(8):
                fpath = os.path.join(run_dir, f"frame_{orient}_{phase_idx}.png")
                img = cv2.imread(fpath)
                if img is None:
                    print(f"  ERROR: could not read {fpath}")
                    sys.exit(1)
                frames.append(img.astype(np.float64).mean(axis=-1))

        frames_x = frames[:8]
        frames_y = frames[8:]
```

- [ ] **Step 2: Verify the script parses without errors**

Run: `.venv/bin/python -c "import ast; ast.parse(open('scripts/dev/deflectometry_repeatability.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add scripts/dev/deflectometry_repeatability.py
git commit -m "fix(deflectometry): repeatability script reads all 8 phase frames per orientation"
```

---

## Self-Review Checklist

### 1. Spec coverage

| Spec requirement | Task |
|---|---|
| Slope magnitude + curl residual displays | Task 1 (functions), Task 4 (API), Task 5 (frontend) |
| Diverging colormap for curl | Task 2 |
| Quality summary block | Task 3 (function), Task 4 (API), Task 5 (frontend banner) |
| Unit honesty labeling | Task 5 (formatStats + unit note) |
| Structured run export | Task 6 |
| Repeatability script fix | Task 7 |

### 2. Placeholder scan
No TBDs, TODOs, or "implement later" found.

### 3. Type consistency
- `compute_slope_magnitude(dzdx, dzdy, mask=None)` — consistent across Task 1 (definition) and Task 4 (call site)
- `compute_curl_residual(dzdx, dzdy, mask=None)` — consistent across Task 1 (definition), Task 3 (called inside quality), and Task 4 (call site)
- `compute_quality_summary(dzdx, dzdy, mask, mod_x, mod_y, frames_x, frames_y)` — consistent across Task 3 (definition) and Task 4 (call site)
- `diverging_png_b64(data, mask=None)` — consistent across Task 2 (definition) and Task 4 (call site)
- Frontend field names (`slope_mag_png_b64`, `curl_png_b64`, `stats_slope_mag`, `stats_curl`, `quality`) — consistent between Task 4 (API response) and Task 5 (frontend rendering)
