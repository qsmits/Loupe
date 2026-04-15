# Fringe Pipeline v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add confidence reporting, form removal options, and carrier/unwrap diagnostics to the fringe analysis pipeline.

**Architecture:** Backend changes are in `fringe.py` — instrument existing pipeline stages to produce confidence metrics and risk masks, add plane-fit form removal, extend carrier analysis with alternates/SNR. Frontend changes are in `fringe-results.js` — add confidence badges, surface map overlay toggles, extended diagnostics tab, form model selector, and reframed subtraction pills. No new endpoints — existing result dict grows with new fields.

**Tech Stack:** Python (numpy, scipy, cv2, matplotlib), vanilla JS ES modules.

---

## File Structure

### Backend
- **Modify:** `backend/vision/fringe.py` — `unwrap_phase_2d()` returns risk mask, new `compute_confidence()` and `render_confidence_maps()`, enhanced `_analyze_carrier()`, plane-fit in `analyze_interferogram()` and `reanalyze()`
- **Modify:** `backend/api_fringe.py` — `AnalyzeBody` and `ReanalyzeBody` gain `form_model` field
- **Test:** `tests/test_fringe.py` — new test classes for confidence, plane fit, carrier diagnostics, unwrap risk

### Frontend
- **Modify:** `frontend/fringe-results.js` — confidence badges, overlay toggles, diagnostics tab expansion, form model selector, pill relabeling
- **Modify:** `frontend/style.css` — badge colors, overlay toggle styles

---

### Task 1: Unwrap Risk Mask — Instrument `unwrap_phase_2d()`

**Files:**
- Modify: `backend/vision/fringe.py:753-811`
- Test: `tests/test_fringe.py`

Change `unwrap_phase_2d()` to return a risk mask alongside the unwrapped phase. Track which pixels needed 2π-jump correction and which are in the edge contamination zone.

- [ ] **Step 1: Write the failing test**

```python
# In tests/test_fringe.py, add after class TestUnwrap2D (line ~275):

class TestUnwrapRiskMask:
    """unwrap_phase_2d returns (unwrapped, risk_mask) tuple."""

    def test_returns_tuple(self):
        """unwrap_phase_2d returns a 2-tuple."""
        from backend.vision.fringe import unwrap_phase_2d
        wrapped = np.random.uniform(-np.pi, np.pi, (64, 64))
        result = unwrap_phase_2d(wrapped)
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_risk_mask_shape(self):
        """Risk mask has same shape as input."""
        from backend.vision.fringe import unwrap_phase_2d
        wrapped = np.random.uniform(-np.pi, np.pi, (64, 64))
        _, risk = unwrap_phase_2d(wrapped)
        assert risk.shape == wrapped.shape
        assert risk.dtype == np.uint8

    def test_clean_unwrap_has_zero_risk(self):
        """A smooth ramp produces no risk pixels."""
        from backend.vision.fringe import unwrap_phase_2d
        # Smooth phase ramp — no discontinuities
        y = np.linspace(0, 4 * np.pi, 64)
        phase = np.tile(y, (64, 1))
        wrapped = np.angle(np.exp(1j * phase))
        _, risk = unwrap_phase_2d(wrapped)
        # Most pixels should be 0 (reliable)
        assert np.mean(risk == 0) > 0.9

    def test_edge_contamination_zone(self):
        """Pixels near mask boundary are flagged as edge risk (value 2)."""
        from backend.vision.fringe import unwrap_phase_2d
        wrapped = np.random.uniform(-np.pi, np.pi, (64, 64))
        mask = np.zeros((64, 64), dtype=bool)
        mask[10:54, 10:54] = True
        _, risk = unwrap_phase_2d(wrapped, mask=mask, fringe_period_px=5.0)
        # Edge zone pixels should exist
        assert np.any(risk == 2)
        # Interior pixels should not be edge risk
        assert risk[30, 30] != 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_fringe.py::TestUnwrapRiskMask -v`
Expected: FAIL — `unwrap_phase_2d` returns ndarray not tuple

- [ ] **Step 3: Implement the changes**

In `backend/vision/fringe.py`, modify `unwrap_phase_2d()`:

**Signature change** (line 753):
```python
def unwrap_phase_2d(wrapped: np.ndarray, mask: np.ndarray | None = None,
                    quality: np.ndarray | None = None,
                    fringe_period_px: float | None = None) -> tuple[np.ndarray, np.ndarray]:
```

**After existing unwrapping logic (after line ~800), before the median filter section:**
```python
    # Initialize risk mask
    risk_mask = np.zeros(wrapped.shape, dtype=np.uint8)
```

**Replace the median filter correction (lines 804-805) with:**
```python
    # Median filter to detect and correct 2π-jump errors
    med = median_filter(unwrapped, size=9)
    jump_diff = unwrapped - med
    jump_pixels = np.abs(jump_diff) > np.pi
    unwrapped -= 2.0 * np.pi * np.round(jump_diff / (2.0 * np.pi))
    risk_mask[jump_pixels] = 1  # Mark corrected pixels
```

**After the jump correction, add edge contamination detection:**
```python
    # Edge contamination zone: pixels within ~1 fringe period of mask boundary
    if fringe_period_px and fringe_period_px > 1 and mask is not None:
        kernel_size = max(3, int(fringe_period_px))
        kernel = np.ones((kernel_size, kernel_size), dtype=np.uint8)
        eroded = cv2.erode(mask.astype(np.uint8), kernel)
        edge_zone = mask.astype(bool) & ~eroded.astype(bool)
        risk_mask[edge_zone & (risk_mask == 0)] = 2

    return unwrapped, risk_mask
```

**Update all return statements** in the function to return `(unwrapped, risk_mask)`. There are early returns for edge cases — each needs a risk mask:
- Line ~775 (empty mask): `return np.zeros_like(phase, dtype=np.float64), np.zeros(wrapped.shape, dtype=np.uint8)`

- [ ] **Step 4: Update all callers of `unwrap_phase_2d()`**

In `analyze_interferogram()` (line ~1306), change:
```python
unwrapped = unwrap_phase_2d(wrapped, mask, quality=modulation)
```
to:
```python
unwrapped, unwrap_risk = unwrap_phase_2d(wrapped, mask, quality=modulation,
                                          fringe_period_px=carrier_info.get("fringe_period_px"))
```

Store `unwrap_risk` for use in later tasks (confidence computation).

- [ ] **Step 5: Fix existing unwrap tests**

Existing `TestUnwrap2D` tests expect `unwrap_phase_2d()` to return an ndarray. Update them to unpack the tuple:

In each test method in `TestUnwrap2D`, change patterns like:
```python
result = unwrap_phase_2d(...)
```
to:
```python
result, _ = unwrap_phase_2d(...)
```

- [ ] **Step 6: Run tests**

Run: `.venv/bin/pytest tests/test_fringe.py -v`
Expected: ALL pass

- [ ] **Step 7: Commit**

```bash
git add backend/vision/fringe.py tests/test_fringe.py
git commit -m "feat(fringe): unwrap_phase_2d returns risk mask (jump corrections + edge contamination)"
```

---

### Task 2: Confidence Metrics — `compute_confidence()`

**Files:**
- Modify: `backend/vision/fringe.py` (add new function after `_analyze_carrier`)
- Test: `tests/test_fringe.py`

Add a pure-computation function that produces the four confidence scores from pipeline data.

- [ ] **Step 1: Write the failing test**

```python
class TestConfidenceMetrics:
    """compute_confidence produces carrier/modulation/unwrap/overall scores."""

    def test_high_confidence(self):
        """Good data produces high confidence scores."""
        from backend.vision.fringe import compute_confidence
        carrier = {"peak_ratio": 15.0}
        modulation = np.full((64, 64), 0.8)  # high modulation everywhere
        risk_mask = np.zeros((64, 64), dtype=np.uint8)  # no risk
        mask = np.ones((64, 64), dtype=bool)
        result = compute_confidence(carrier, modulation, risk_mask, mask, threshold_frac=0.15)
        assert result["carrier"] > 70
        assert result["modulation"] > 70
        assert result["unwrap"] > 95
        assert result["overall"] > 70

    def test_low_carrier_confidence(self):
        """Low peak ratio → low carrier confidence."""
        from backend.vision.fringe import compute_confidence
        carrier = {"peak_ratio": 1.5}
        modulation = np.full((64, 64), 0.8)
        risk_mask = np.zeros((64, 64), dtype=np.uint8)
        mask = np.ones((64, 64), dtype=bool)
        result = compute_confidence(carrier, modulation, risk_mask, mask, threshold_frac=0.15)
        assert result["carrier"] < 30
        assert result["overall"] < 30  # weakest link

    def test_low_modulation_coverage(self):
        """Low modulation in most pixels → low modulation score."""
        from backend.vision.fringe import compute_confidence
        carrier = {"peak_ratio": 15.0}
        modulation = np.full((64, 64), 0.01)  # very low
        risk_mask = np.zeros((64, 64), dtype=np.uint8)
        mask = np.ones((64, 64), dtype=bool)
        result = compute_confidence(carrier, modulation, risk_mask, mask, threshold_frac=0.15)
        assert result["modulation"] < 30

    def test_many_unwrap_corrections(self):
        """Many corrected pixels → low unwrap confidence."""
        from backend.vision.fringe import compute_confidence
        carrier = {"peak_ratio": 15.0}
        modulation = np.full((64, 64), 0.8)
        risk_mask = np.ones((64, 64), dtype=np.uint8)  # all corrected
        mask = np.ones((64, 64), dtype=bool)
        result = compute_confidence(carrier, modulation, risk_mask, mask, threshold_frac=0.15)
        assert result["unwrap"] < 10
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_fringe.py::TestConfidenceMetrics -v`
Expected: FAIL — `compute_confidence` not found

- [ ] **Step 3: Implement `compute_confidence()`**

Add to `backend/vision/fringe.py` (after `_analyze_carrier`, around line 440):

```python
def compute_confidence(carrier_info: dict, modulation: np.ndarray,
                       risk_mask: np.ndarray, mask: np.ndarray,
                       threshold_frac: float = 0.15) -> dict:
    """Compute per-stage confidence scores (0–100) from pipeline data.

    Returns dict with keys: carrier, modulation, unwrap, overall.
    """
    # Carrier confidence: normalize peak_ratio to 0–100
    pr = carrier_info.get("peak_ratio", 0)
    if pr >= 10:
        carrier_score = 100.0
    elif pr >= 5:
        carrier_score = 70 + (pr - 5) * 6  # 70–100 linear over 5–10
    elif pr >= 2:
        carrier_score = 30 + (pr - 2) * (40 / 3)  # 30–70 linear over 2–5
    else:
        carrier_score = max(0, pr * 15)  # 0–30 linear over 0–2

    # Modulation coverage: % of mask pixels with modulation above threshold
    valid = mask.astype(bool)
    n_valid = int(np.sum(valid))
    if n_valid > 0:
        median_mod = float(np.median(modulation[valid]))
        thresh = threshold_frac * max(median_mod, 0.01)
        n_good_mod = int(np.sum(modulation[valid] > thresh))
        mod_coverage = 100.0 * n_good_mod / n_valid
    else:
        mod_coverage = 0.0

    # Unwrap confidence: % of valid pixels that are reliable (risk == 0)
    if n_valid > 0:
        n_reliable = int(np.sum((risk_mask[valid] == 0)))
        unwrap_score = 100.0 * n_reliable / n_valid
    else:
        unwrap_score = 0.0

    # Overall: weakest link
    overall = min(carrier_score, mod_coverage, unwrap_score)

    return {
        "carrier": round(carrier_score, 1),
        "modulation": round(mod_coverage, 1),
        "unwrap": round(unwrap_score, 1),
        "overall": round(overall, 1),
    }
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/pytest tests/test_fringe.py::TestConfidenceMetrics -v`
Expected: ALL pass

- [ ] **Step 5: Commit**

```bash
git add backend/vision/fringe.py tests/test_fringe.py
git commit -m "feat(fringe): add compute_confidence() for per-stage quality scoring"
```

---

### Task 3: Confidence Maps — `render_confidence_maps()`

**Files:**
- Modify: `backend/vision/fringe.py` (add rendering function)
- Test: `tests/test_fringe.py`

Render the unwrap risk map and confidence composite as base64 PNGs.

- [ ] **Step 1: Write the failing test**

```python
class TestConfidenceMaps:
    """render_confidence_maps produces base64 PNG strings."""

    def test_returns_dict_with_expected_keys(self):
        from backend.vision.fringe import render_confidence_maps
        modulation = np.random.uniform(0, 1, (64, 64)).astype(np.float32)
        risk_mask = np.zeros((64, 64), dtype=np.uint8)
        mask = np.ones((64, 64), dtype=bool)
        result = render_confidence_maps(modulation, risk_mask, mask)
        assert "unwrap_risk" in result
        assert "composite" in result

    def test_outputs_are_valid_base64_png(self):
        import base64
        from backend.vision.fringe import render_confidence_maps
        modulation = np.random.uniform(0, 1, (64, 64)).astype(np.float32)
        risk_mask = np.zeros((64, 64), dtype=np.uint8)
        mask = np.ones((64, 64), dtype=bool)
        result = render_confidence_maps(modulation, risk_mask, mask)
        for key in ("unwrap_risk", "composite"):
            raw = base64.b64decode(result[key])
            assert raw[:4] == b"\x89PNG"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_fringe.py::TestConfidenceMaps -v`
Expected: FAIL — `render_confidence_maps` not found

- [ ] **Step 3: Implement `render_confidence_maps()`**

Add to `backend/vision/fringe.py` (after `render_modulation_map`, around line 1120):

```python
def render_confidence_maps(modulation: np.ndarray, risk_mask: np.ndarray,
                           mask: np.ndarray) -> dict:
    """Render confidence maps as base64 PNGs.

    Returns dict with keys:
    - 'unwrap_risk': red overlay showing corrected + edge-risk pixels
    - 'composite': green-yellow-red per-pixel confidence
    """
    h, w = modulation.shape

    # ── Unwrap risk map ──
    risk_rgb = np.zeros((h, w, 3), dtype=np.uint8)
    risk_rgb[risk_mask == 1] = [0, 0, 255]   # Red for corrected (BGR)
    risk_rgb[risk_mask == 2] = [0, 128, 255]  # Orange for edge contamination (BGR)
    if mask is not None:
        risk_rgb[~mask.astype(bool)] = [40, 40, 40]

    # ── Confidence composite ──
    valid = mask.astype(bool) if mask is not None else np.ones((h, w), dtype=bool)
    # Per-pixel quality: combine modulation and unwrap risk
    median_mod = float(np.median(modulation[valid])) if valid.any() else 0.01
    mod_norm = np.clip(modulation / max(median_mod, 0.01), 0, 1)
    # Risk penalty: reliable=1.0, edge=0.3, corrected=0.0
    risk_factor = np.ones((h, w), dtype=np.float32)
    risk_factor[risk_mask == 1] = 0.0
    risk_factor[risk_mask == 2] = 0.3
    quality = mod_norm * risk_factor

    # Map to green (1.0) → yellow (0.5) → red (0.0)
    composite_rgb = np.zeros((h, w, 3), dtype=np.uint8)
    # BGR: green channel
    composite_rgb[:, :, 1] = np.clip(quality * 255, 0, 255).astype(np.uint8)
    # BGR: red channel — high when quality is low
    composite_rgb[:, :, 2] = np.clip((1.0 - quality) * 255, 0, 255).astype(np.uint8)
    composite_rgb[:, :, 0] = 30  # slight blue
    if mask is not None:
        composite_rgb[~valid] = [40, 40, 40]

    # Resize if large
    max_dim = 512
    def _resize(img):
        if max(img.shape[:2]) > max_dim:
            scale = max_dim / max(img.shape[:2])
            new_h, new_w = max(1, int(img.shape[0] * scale)), max(1, int(img.shape[1] * scale))
            return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
        return img

    _, risk_buf = cv2.imencode(".png", _resize(risk_rgb))
    _, comp_buf = cv2.imencode(".png", _resize(composite_rgb))

    return {
        "unwrap_risk": base64.b64encode(risk_buf.tobytes()).decode("ascii"),
        "composite": base64.b64encode(comp_buf.tobytes()).decode("ascii"),
    }
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/pytest tests/test_fringe.py::TestConfidenceMaps -v`
Expected: ALL pass

- [ ] **Step 5: Commit**

```bash
git add backend/vision/fringe.py tests/test_fringe.py
git commit -m "feat(fringe): add render_confidence_maps() for unwrap risk and composite overlays"
```

---

### Task 4: Enhanced Carrier Analysis — Alternates, SNR, DC Margin

**Files:**
- Modify: `backend/vision/fringe.py:376-437` (`_analyze_carrier`)
- Test: `tests/test_fringe.py`

Extend `_analyze_carrier()` to return alternate peaks, SNR in dB, and DC margin.

- [ ] **Step 1: Write the failing test**

```python
class TestCarrierDiagnostics:
    """_analyze_carrier returns enhanced diagnostics."""

    def _make_fringe(self, period=20):
        x = np.arange(256)
        img = (128 + 80 * np.sin(2 * np.pi * x / period)).astype(np.uint8)
        return np.tile(img, (256, 1))

    def test_snr_db_present(self):
        from backend.vision.fringe import _analyze_carrier
        img = self._make_fringe()
        result = _analyze_carrier(img)
        assert "snr_db" in result
        assert result["snr_db"] > 0

    def test_dc_margin_present(self):
        from backend.vision.fringe import _analyze_carrier
        img = self._make_fringe()
        result = _analyze_carrier(img)
        assert "dc_margin_px" in result
        assert result["dc_margin_px"] > 0

    def test_alternate_peaks_present(self):
        from backend.vision.fringe import _analyze_carrier
        img = self._make_fringe()
        result = _analyze_carrier(img)
        assert "alternate_peaks" in result
        assert isinstance(result["alternate_peaks"], list)
        assert len(result["alternate_peaks"]) <= 3

    def test_high_snr_for_clean_fringes(self):
        from backend.vision.fringe import _analyze_carrier
        img = self._make_fringe()
        result = _analyze_carrier(img)
        assert result["snr_db"] > 10  # clean synthetic fringes should have high SNR
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_fringe.py::TestCarrierDiagnostics -v`
Expected: FAIL — `snr_db` key not in result dict

- [ ] **Step 3: Implement enhanced carrier analysis**

In `backend/vision/fringe.py`, modify `_analyze_carrier()` (around line 376).

After the existing `peak_ratio` computation (line ~426), before the return dict, add:

```python
    # SNR: carrier peak vs noise floor (median of non-DC, non-carrier region)
    noise_floor = float(np.median(mag_search[mag_search > 0])) if np.any(mag_search > 0) else 1e-10
    snr_db = float(10 * np.log10(max(carrier_peak_val / max(noise_floor, 1e-10), 1e-10)))

    # DC margin: distance from carrier peak to DC mask boundary
    dc_margin = max(3, min(h, w) // 80)
    dc_margin_px = float(np.sqrt((py - cy) ** 2 + (px - cx) ** 2) - dc_margin)
    dc_margin_px = max(0, dc_margin_px)

    # Alternate peaks: top 3 remaining peaks after masking carrier + conjugate + DC
    alternate_peaks = []
    for _ in range(3):
        if not np.any(mag_search > 0):
            break
        alt_idx = np.unravel_index(np.argmax(mag_search), mag_search.shape)
        alt_y, alt_x = int(alt_idx[0]), int(alt_idx[1])
        alt_val = float(mag_search[alt_y, alt_x])
        if alt_val <= 0:
            break
        alt_dist = float(np.sqrt((alt_y - cy) ** 2 + (alt_x - cx) ** 2))
        alt_ratio = carrier_peak_val / max(alt_val, 1e-10)
        alternate_peaks.append({
            "y": alt_y, "x": alt_x,
            "distance_px": round(alt_dist, 1),
            "peak_ratio": round(alt_ratio, 2),
        })
        # Mask this peak for next iteration
        ay_lo, ay_hi = max(0, alt_y - 5), min(h, alt_y + 6)
        ax_lo, ax_hi = max(0, alt_x - 5), min(w, alt_x + 6)
        mag_search[ay_lo:ay_hi, ax_lo:ax_hi] = 0
```

Add these fields to the return dict:

```python
    return {
        # ... existing fields ...
        "snr_db": round(snr_db, 1),
        "dc_margin_px": round(dc_margin_px, 1),
        "alternate_peaks": alternate_peaks,
    }
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/pytest tests/test_fringe.py -v`
Expected: ALL pass

- [ ] **Step 5: Commit**

```bash
git add backend/vision/fringe.py tests/test_fringe.py
git commit -m "feat(fringe): enhanced carrier diagnostics — alternates, SNR, DC margin"
```

---

### Task 5: Plane Fit Form Removal

**Files:**
- Modify: `backend/vision/fringe.py:1242-1436` (`analyze_interferogram`) and `reanalyze()`
- Modify: `backend/api_fringe.py:50-67` (AnalyzeBody, ReanalyzeBody)
- Test: `tests/test_fringe.py`

Add `form_model="plane"` as an alternative to Zernike subtraction.

- [ ] **Step 1: Write the failing test**

```python
class TestPlaneFormRemoval:
    """form_model='plane' uses best-fit plane instead of Zernike subtraction."""

    def _make_fringe_image(self, h=256, w=256, period=20):
        x = np.arange(w)
        row = (128 + 80 * np.sin(2 * np.pi * x / period)).astype(np.uint8)
        return np.tile(row, (h, 1))

    def test_plane_model_returns_result(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        result = analyze_interferogram(img, form_model="plane")
        assert "pv_nm" in result
        assert "form_model" in result
        assert result["form_model"] == "plane"

    def test_plane_model_has_plane_fit(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        result = analyze_interferogram(img, form_model="plane")
        assert "plane_fit" in result
        assert "a" in result["plane_fit"]
        assert "b" in result["plane_fit"]
        assert "c" in result["plane_fit"]

    def test_zernike_model_is_default(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        result = analyze_interferogram(img)
        assert result["form_model"] == "zernike"

    def test_plane_model_different_from_zernike(self):
        """Plane and Zernike form removal produce different PV/RMS values."""
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        r_zernike = analyze_interferogram(img, form_model="zernike")
        r_plane = analyze_interferogram(img, form_model="plane")
        # They should both produce valid results but with different values
        assert r_zernike["pv_nm"] != r_plane["pv_nm"] or r_zernike["rms_nm"] != r_plane["rms_nm"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_fringe.py::TestPlaneFormRemoval -v`
Expected: FAIL — `analyze_interferogram() got an unexpected keyword argument 'form_model'`

- [ ] **Step 3: Implement plane fit in `analyze_interferogram()`**

In `backend/vision/fringe.py`, modify `analyze_interferogram()` signature (line 1242):

```python
def analyze_interferogram(image: np.ndarray, wavelength_nm: float = 632.8,
                          mask_threshold: float = 0.15,
                          subtract_terms: list[int] | None = None,
                          n_zernike: int = 36,
                          use_full_mask: bool = False,
                          custom_mask: np.ndarray | None = None,
                          carrier_override: tuple[int, int] | None = None,
                          on_progress: Callable[[str, float, str], None] | None = None,
                          form_model: str = "zernike") -> dict:
```

After Step 4 (Zernike fitting, line ~1310), replace Step 5 (subtraction) with:

```python
    # Step 5: Form removal
    if form_model == "plane":
        # Plane fit: subtract best-fit plane (ignoring Zernike terms)
        corrected = _subtract_plane(unwrapped, mask)
        plane_coeffs = _fit_plane(unwrapped, mask)  # for diagnostics
    else:
        # Zernike subtraction (current behavior)
        corrected = subtract_zernike(unwrapped, coeffs, subtract_terms, rho, theta, mask)
        # Residual plane subtraction if tilt terms were subtracted
        if subtract_terms and (2 in subtract_terms or 3 in subtract_terms):
            corrected = _subtract_plane(corrected, mask)
        plane_coeffs = None
```

Add a `_fit_plane()` function (near `_subtract_plane`, around line 284):

```python
def _fit_plane(surface: np.ndarray, mask: np.ndarray | None = None) -> dict:
    """Fit a least-squares plane and return coefficients for diagnostics."""
    h, w = surface.shape
    yy, xx = np.mgrid[0:h, 0:w]
    if mask is not None:
        valid = mask.astype(bool)
        xs, ys, zs = xx[valid], yy[valid], surface[valid]
    else:
        xs, ys, zs = xx.ravel(), yy.ravel(), surface.ravel()

    if len(zs) < 3:
        return {"a": 0, "b": 0, "c": 0, "tilt_x_nm": 0, "tilt_y_nm": 0}

    A = np.column_stack([xs, ys, np.ones(len(xs))])
    coeffs, _, _, _ = np.linalg.lstsq(A, zs, rcond=None)
    return {
        "a": float(coeffs[0]),
        "b": float(coeffs[1]),
        "c": float(coeffs[2]),
        "tilt_x_nm": float(coeffs[0] * w),
        "tilt_y_nm": float(coeffs[1] * h),
    }
```

Add `form_model` and `plane_fit` to the result dict (line ~1406):

```python
    result = {
        # ... existing fields ...
        "form_model": form_model,
        "plane_fit": plane_coeffs,  # None for zernike model
    }
```

- [ ] **Step 4: Add `form_model` to API models**

In `backend/api_fringe.py`, add to `AnalyzeBody` (line ~57):
```python
    form_model: str = Field(default="zernike", pattern="^(zernike|plane)$")
```

Add to `ReanalyzeBody` (line ~67):
```python
    form_model: str = Field(default="zernike", pattern="^(zernike|plane)$")
```

Pass `form_model` through to `analyze_interferogram()` in the endpoint functions.

In `fringe_analyze()` (line ~85), add to the `analyze_interferogram` call:
```python
    form_model=body.form_model,
```

In `fringe_analyze_stream()` (line ~147), add to the `analyze_interferogram` call:
```python
    form_model=body.form_model,
```

- [ ] **Step 5: Add plane fit support to `reanalyze()`**

Find the `reanalyze()` function in `fringe.py`. It reconstructs the surface from Zernike coefficients. Add `form_model` parameter:

When `form_model="plane"`: after reconstructing from all coefficients, apply `_subtract_plane()` instead of `subtract_zernike()`.

- [ ] **Step 6: Run tests**

Run: `.venv/bin/pytest tests/test_fringe.py -v`
Expected: ALL pass

- [ ] **Step 7: Commit**

```bash
git add backend/vision/fringe.py backend/api_fringe.py tests/test_fringe.py
git commit -m "feat(fringe): plane fit form removal model as alternative to Zernike subtraction"
```

---

### Task 6: Wire Confidence + Unwrap Stats into Pipeline Result

**Files:**
- Modify: `backend/vision/fringe.py:1242-1436` (`analyze_interferogram`)
- Test: `tests/test_fringe.py`

Call `compute_confidence()` and `render_confidence_maps()` from the main pipeline and include their output in the result dict.

- [ ] **Step 1: Write the failing test**

```python
class TestPipelineConfidence:
    """analyze_interferogram returns confidence metrics and maps."""

    def _make_fringe_image(self, h=256, w=256, period=20):
        x = np.arange(w)
        row = (128 + 80 * np.sin(2 * np.pi * x / period)).astype(np.uint8)
        return np.tile(row, (h, 1))

    def test_confidence_in_result(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        result = analyze_interferogram(img)
        assert "confidence" in result
        for key in ("carrier", "modulation", "unwrap", "overall"):
            assert key in result["confidence"]
            assert 0 <= result["confidence"][key] <= 100

    def test_confidence_maps_in_result(self):
        import base64
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        result = analyze_interferogram(img)
        assert "confidence_maps" in result
        for key in ("unwrap_risk", "composite"):
            assert key in result["confidence_maps"]
            raw = base64.b64decode(result["confidence_maps"][key])
            assert raw[:4] == b"\x89PNG"

    def test_unwrap_stats_in_result(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        result = analyze_interferogram(img)
        assert "unwrap_stats" in result
        for key in ("n_corrected", "n_edge_risk", "n_reliable"):
            assert key in result["unwrap_stats"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_fringe.py::TestPipelineConfidence -v`
Expected: FAIL — `confidence` key not in result

- [ ] **Step 3: Wire confidence into `analyze_interferogram()`**

In `analyze_interferogram()`, after the unwrap step (which now returns `unwrap_risk`) and before renderings, add:

```python
    # Step 5b: Confidence metrics
    confidence = compute_confidence(carrier_info, modulation, unwrap_risk, mask,
                                    threshold_frac=mask_threshold)
    confidence_maps = render_confidence_maps(modulation, unwrap_risk, mask)

    # Unwrap statistics
    valid_mask = mask.astype(bool) if mask is not None else np.ones(unwrapped.shape, dtype=bool)
    n_valid = int(np.sum(valid_mask))
    n_corrected = int(np.sum(unwrap_risk[valid_mask] == 1))
    n_edge_risk = int(np.sum(unwrap_risk[valid_mask] == 2))
    unwrap_stats = {
        "n_corrected": n_corrected,
        "n_edge_risk": n_edge_risk,
        "n_reliable": n_valid - n_corrected - n_edge_risk,
    }
```

Add to the result dict:

```python
    result = {
        # ... existing fields ...
        "confidence": confidence,
        "confidence_maps": confidence_maps,
        "unwrap_stats": unwrap_stats,
    }
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/pytest tests/test_fringe.py -v`
Expected: ALL pass

- [ ] **Step 5: Commit**

```bash
git add backend/vision/fringe.py tests/test_fringe.py
git commit -m "feat(fringe): wire confidence metrics, maps, and unwrap stats into pipeline result"
```

---

### Task 7: Frontend — Confidence Badges

**Files:**
- Modify: `frontend/fringe-results.js:40-65` (summary bar HTML)
- Modify: `frontend/fringe-results.js:210-260` (renderResults)
- Modify: `frontend/style.css`

Add confidence badges below the PV/RMS/Strehl summary bar.

- [ ] **Step 1: Add badge HTML to `buildResultsHtml()`**

In `frontend/fringe-results.js`, after the summary bar closing `</div>` (line 65), before the carrier row (line 67), add:

```html
        <div class="fringe-confidence-row" id="fringe-confidence-row" hidden>
          <span class="fringe-conf-badge" id="fringe-conf-carrier" title="Carrier detection confidence">
            <span class="fringe-conf-dot"></span> Carrier: <span class="fringe-conf-val">--</span>
          </span>
          <span class="fringe-conf-badge" id="fringe-conf-modulation" title="Fringe modulation coverage">
            <span class="fringe-conf-dot"></span> Modulation: <span class="fringe-conf-val">--</span>
          </span>
          <span class="fringe-conf-badge" id="fringe-conf-unwrap" title="Phase unwrap reliability">
            <span class="fringe-conf-dot"></span> Unwrap: <span class="fringe-conf-val">--</span>
          </span>
        </div>
```

- [ ] **Step 2: Populate badges in `renderResults()`**

In `renderResults()`, after the summary bar population (around line 260), add:

```javascript
  // Confidence badges
  if (data.confidence) {
    const confRow = $("fringe-confidence-row");
    if (confRow) confRow.hidden = false;

    const badgeColor = (score) => score >= 70 ? "#30d158" : score >= 30 ? "#ff9f0a" : "#ff453a";
    const badgeLabel = (score) => score >= 70 ? "Good" : score >= 30 ? "Fair" : "Low";

    for (const key of ["carrier", "modulation", "unwrap"]) {
      const badge = $(`fringe-conf-${key}`);
      if (!badge) continue;
      const score = data.confidence[key];
      const dot = badge.querySelector(".fringe-conf-dot");
      const val = badge.querySelector(".fringe-conf-val");
      if (dot) dot.style.background = badgeColor(score);
      if (val) {
        if (key === "modulation") {
          val.textContent = Math.round(score) + "%";
        } else if (key === "unwrap") {
          val.textContent = Math.round(score) + "%";
        } else {
          val.textContent = badgeLabel(score);
        }
      }
    }
  }
```

- [ ] **Step 3: Add badge CSS**

Append to `frontend/style.css`:

```css
/* ─── Fringe confidence badges ─────────────────────────── */
.fringe-confidence-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 3px 12px;
  font-size: 11px;
  opacity: 0.85;
  border-bottom: 1px solid var(--border);
}

.fringe-conf-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.fringe-conf-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
  flex-shrink: 0;
}

.fringe-conf-val {
  font-weight: 500;
}
```

- [ ] **Step 4: Wire badge clicks to open diagnostics tab**

In `wireResultsEvents()` (find the tab wiring section), add after the existing tab click handlers:

```javascript
  // Confidence badge clicks → open diagnostics tab
  for (const key of ["carrier", "modulation", "unwrap"]) {
    $(`fringe-conf-${key}`)?.addEventListener("click", () => {
      const diagTab = document.querySelector('[data-tab="diagnostics"]');
      if (diagTab) diagTab.click();
    });
  }
```

- [ ] **Step 5: Commit**

```bash
git add frontend/fringe-results.js frontend/style.css
git commit -m "feat(fringe-ui): confidence badges with color-coded dots below summary bar"
```

---

### Task 8: Frontend — Surface Map Overlay Toggles

**Files:**
- Modify: `frontend/fringe-results.js:107-123` (surface content HTML)
- Modify: `frontend/fringe-results.js:210-280` (renderResults)
- Modify: `frontend/style.css`

Add [Surface] [Confidence] [Modulation] toggle buttons above the surface map.

- [ ] **Step 1: Add overlay toggle HTML**

In `buildResultsHtml()`, find the surface content div (line ~107, `fringe-surface-content`). Add an overlay toggle row before the measure toolbar:

```html
            <div class="fringe-overlay-toggles" id="fringe-overlay-toggles" hidden>
              <button class="fringe-overlay-btn active" data-overlay="surface">Surface</button>
              <button class="fringe-overlay-btn" data-overlay="confidence">Confidence</button>
              <button class="fringe-overlay-btn" data-overlay="modulation">Modulation</button>
            </div>
```

- [ ] **Step 2: Cache confidence map data in `renderResults()`**

In `renderResults()`, after populating the surface map image, cache the confidence map URLs:

```javascript
  // Cache confidence map sources for overlay toggles
  if (data.confidence_maps) {
    const surfImg = $("fringe-surface-img");
    if (surfImg) {
      surfImg.dataset.surfaceSrc = "data:image/png;base64," + data.surface_map;
      surfImg.dataset.confidenceSrc = "data:image/png;base64," + data.confidence_maps.composite;
      surfImg.dataset.modulationSrc = "data:image/png;base64," + data.confidence_maps.modulation || data.modulation_map;
    }
    const toggles = $("fringe-overlay-toggles");
    if (toggles) toggles.hidden = false;
  }
```

Note: the modulation map is already returned as `data.modulation_map` in existing results. Use `confidence_maps.modulation` if present (from the new pipeline), otherwise fall back to `data.modulation_map`.

- [ ] **Step 3: Wire overlay toggle events**

In `wireResultsEvents()`, add:

```javascript
  // Surface map overlay toggles
  document.querySelectorAll(".fringe-overlay-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".fringe-overlay-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const surfImg = $("fringe-surface-img");
      if (!surfImg) return;
      const overlay = btn.dataset.overlay;
      const srcKey = overlay + "Src";
      if (surfImg.dataset[srcKey]) {
        surfImg.src = surfImg.dataset[srcKey];
      }
    });
  });
```

- [ ] **Step 4: Add overlay toggle CSS**

Append to `frontend/style.css`:

```css
/* ─── Fringe overlay toggles ──────────────────────────── */
.fringe-overlay-toggles {
  display: flex;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}

.fringe-overlay-btn {
  padding: 2px 8px;
  font-size: 10px;
  border-radius: 4px;
  opacity: 0.6;
}

.fringe-overlay-btn.active {
  background: var(--accent);
  opacity: 1;
}

.fringe-overlay-btn:hover:not(.active) {
  background: var(--surface-2);
  opacity: 0.8;
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/fringe-results.js frontend/style.css
git commit -m "feat(fringe-ui): surface map overlay toggles for confidence and modulation views"
```

---

### Task 9: Frontend — Extended Diagnostics Tab

**Files:**
- Modify: `frontend/fringe-results.js:173-204` (diagnostics tab HTML)
- Modify: `frontend/fringe-results.js` (renderResults diagnostics section)

Extend the existing diagnostics tab with unwrap quality section, confidence section, and overall assessment.

- [ ] **Step 1: Extend diagnostics tab HTML**

In `buildResultsHtml()`, replace the diagnostics tab panel content (lines 173-204) with expanded HTML that includes sections for carrier (existing), modulation (existing), unwrap quality (new), and overall assessment (new):

```html
        <div class="fringe-tab-panel" id="fringe-panel-diagnostics" hidden>
          <div class="fringe-empty-state" id="fringe-diag-empty">Analyze an image first.</div>
          <div id="fringe-diag-content" hidden style="padding:8px">
            <div id="fringe-diag-assessment" style="padding:8px 12px;margin-bottom:8px;border-radius:6px;font-size:12px;display:none"></div>
            <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
              <div>
                <p style="font-size:11px;opacity:0.6;margin:0 0 6px">FFT Magnitude (click to override carrier)</p>
                <canvas id="fringe-fft-canvas" width="256" height="256" style="cursor:crosshair;image-rendering:pixelated;border:1px solid var(--border)"></canvas>
                <div style="margin-top:4px">
                  <button class="detect-btn" id="fringe-btn-carrier-reset" style="padding:2px 8px;font-size:10px" hidden>
                    Reset to Auto
                  </button>
                </div>
              </div>
              <div>
                <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Modulation / Quality Map</p>
                <img id="fringe-modulation-img" style="max-width:300px;border:1px solid var(--border)" />
              </div>
              <div>
                <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Unwrap Risk Map</p>
                <img id="fringe-unwrap-risk-img" style="max-width:300px;border:1px solid var(--border)" />
              </div>
              <div style="min-width:200px">
                <p style="font-size:11px;opacity:0.6;margin:0 0 6px">Carrier Statistics</p>
                <table id="fringe-carrier-table" style="font-size:11px;border-collapse:collapse">
                  <tbody>
                    <tr><td style="padding:2px 8px;opacity:0.6">Period</td><td id="fringe-diag-period" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">Angle</td><td id="fringe-diag-angle" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">Peak ratio</td><td id="fringe-diag-ratio" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">SNR</td><td id="fringe-diag-snr" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">DC margin</td><td id="fringe-diag-dc-margin" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">Alternates</td><td id="fringe-diag-alternates" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">fx (cpp)</td><td id="fringe-diag-fx" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">fy (cpp)</td><td id="fringe-diag-fy" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">Valid pixels</td><td id="fringe-diag-valid" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">Coverage</td><td id="fringe-diag-coverage" style="padding:2px 8px">--</td></tr>
                  </tbody>
                </table>
                <p style="font-size:11px;opacity:0.6;margin:12px 0 6px">Unwrap Statistics</p>
                <table style="font-size:11px;border-collapse:collapse">
                  <tbody>
                    <tr><td style="padding:2px 8px;opacity:0.6">Reliable</td><td id="fringe-diag-reliable" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">Corrected</td><td id="fringe-diag-corrected" style="padding:2px 8px">--</td></tr>
                    <tr><td style="padding:2px 8px;opacity:0.6">Edge risk</td><td id="fringe-diag-edge-risk" style="padding:2px 8px">--</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
```

- [ ] **Step 2: Populate extended diagnostics in `renderResults()`**

In the diagnostics rendering section of `renderResults()`, add after existing carrier stats population:

```javascript
  // Enhanced carrier diagnostics
  if (data.carrier) {
    const c = data.carrier;
    const snrEl = $("fringe-diag-snr");
    if (snrEl) snrEl.textContent = c.snr_db != null ? c.snr_db.toFixed(1) + " dB" : "--";
    const dcEl = $("fringe-diag-dc-margin");
    if (dcEl) dcEl.textContent = c.dc_margin_px != null ? c.dc_margin_px.toFixed(0) + " px" : "--";
    const altEl = $("fringe-diag-alternates");
    if (altEl) {
      const alts = c.alternate_peaks || [];
      altEl.textContent = alts.length > 0
        ? alts.map((a, i) => `#${i + 1}: ${a.peak_ratio.toFixed(1)}x`).join(", ")
        : "none";
    }
  }

  // Unwrap risk map
  if (data.confidence_maps) {
    const riskImg = $("fringe-unwrap-risk-img");
    if (riskImg && data.confidence_maps.unwrap_risk) {
      riskImg.src = "data:image/png;base64," + data.confidence_maps.unwrap_risk;
    }
  }

  // Unwrap statistics
  if (data.unwrap_stats) {
    const us = data.unwrap_stats;
    const relEl = $("fringe-diag-reliable");
    if (relEl) relEl.textContent = us.n_reliable.toLocaleString();
    const corEl = $("fringe-diag-corrected");
    if (corEl) corEl.textContent = us.n_corrected.toLocaleString();
    const edgeEl = $("fringe-diag-edge-risk");
    if (edgeEl) edgeEl.textContent = us.n_edge_risk.toLocaleString();
  }

  // Overall assessment
  if (data.confidence) {
    const assessEl = $("fringe-diag-assessment");
    if (assessEl) {
      const c = data.confidence;
      const weakest = Object.entries(c).filter(([k]) => k !== "overall")
        .sort((a, b) => a[1] - b[1])[0];
      let msg, bg;
      if (c.overall >= 70) {
        msg = "Result is reliable.";
        bg = "rgba(48,209,88,0.15)";
      } else if (c.overall >= 30) {
        const advice = {
          carrier: "Fringe pattern may be weak. Consider adjusting flat angle for better contrast.",
          modulation: "Modulation is marginal. Check illumination and flat contact.",
          unwrap: "Some unwrap uncertainty. Check surface map for discontinuities.",
        };
        msg = `${weakest[0].charAt(0).toUpperCase() + weakest[0].slice(1)} is marginal — ${advice[weakest[0]] || "review diagnostics."}`;
        bg = "rgba(255,159,10,0.15)";
      } else {
        const advice = {
          carrier: "Fringe pattern is weak or ambiguous. Improve fringe contrast or adjust the optical flat angle.",
          modulation: "Less than half the aperture has usable fringes. Check illumination and flat contact.",
          unwrap: "Phase unwrapping had difficulty. Check surface map for discontinuities.",
        };
        msg = `${weakest[0].charAt(0).toUpperCase() + weakest[0].slice(1)} is poor — ${advice[weakest[0]] || "review diagnostics."}`;
        bg = "rgba(255,69,58,0.15)";
      }
      assessEl.textContent = msg;
      assessEl.style.background = bg;
      assessEl.style.display = "block";
    }
  }
```

- [ ] **Step 3: Commit**

```bash
git add frontend/fringe-results.js
git commit -m "feat(fringe-ui): extended diagnostics tab with unwrap risk, stats, and overall assessment"
```

---

### Task 10: Frontend — Form Model Selector + Reframed Pills

**Files:**
- Modify: `frontend/fringe-results.js:12-28` (SUBTRACT_PILLS, pillState, getSubtractTerms)
- Modify: `frontend/fringe-results.js:73-78` (subtract row HTML)
- Modify: `frontend/fringe-results.js` (wireResultsEvents, reanalyze handlers)
- Modify: `frontend/style.css`

Replace pill labels with manufacturing language, add form model dropdown, and wire reanalyze with `form_model`.

- [ ] **Step 1: Update pill definitions**

In `frontend/fringe-results.js`, replace `SUBTRACT_PILLS` (lines 12-18):

```javascript
const SUBTRACT_PILLS = [
  { id: "tilt",      terms: [2, 3],  label: "Tilt",      locked: false },
  { id: "power",     terms: [4],     label: "Curvature",  locked: false },
  { id: "astig",     terms: [5, 6],  label: "Twist",      locked: false },
  { id: "coma",      terms: [7, 8],  label: "Coma",       locked: false },
  { id: "spherical", terms: [11],    label: "Spherical",  locked: false },
];
```

Note: Tilt is no longer locked (but still default-on via `pillState`).

- [ ] **Step 2: Add form model state**

After `pillState` (line 20), add:

```javascript
let formModel = "zernike"; // "zernike" | "plane"
```

Export a getter:

```javascript
export function getFormModel() { return formModel; }
```

- [ ] **Step 3: Update subtract row HTML**

In `buildResultsHtml()`, replace the subtract row (lines 73-78) with:

```javascript
  const pillButtons = SUBTRACT_PILLS.map(p => {
    const classes = ["fringe-pill"];
    if (pillState[p.id]) classes.push("active");
    return `<button class="${classes.join(" ")}" data-pill="${p.id}">${p.label}</button>`;
  }).join("\n          ");
```

And replace the HTML:

```html
        <div class="fringe-subtract-row" id="fringe-subtract-row">
          <select id="fringe-form-model" style="font-size:11px;padding:2px 4px;margin-right:4px">
            <option value="zernike">Zernike</option>
            <option value="plane">Plane</option>
          </select>
          <span id="fringe-pill-group">
            <span class="fringe-sub-label">Subtract:</span>
            ${pillButtons}
          </span>
          <div class="fringe-pill-divider"></div>
          <button class="fringe-pill" id="fringe-btn-invert" disabled>\u2195 Invert</button>
        </div>
```

- [ ] **Step 4: Wire form model selector**

In `wireResultsEvents()`, add:

```javascript
  // Form model selector
  $("fringe-form-model")?.addEventListener("change", (e) => {
    formModel = e.target.value;
    const pillGroup = $("fringe-pill-group");
    if (pillGroup) pillGroup.hidden = formModel === "plane";
    doReanalyze();
  });
```

- [ ] **Step 5: Pass form_model in reanalyze calls**

Find all calls to `/fringe/reanalyze` in `fringe-results.js`. In the `doReanalyze()` function and `invertWavefront()` function, add `form_model: getFormModel()` to the request body:

```javascript
    body: JSON.stringify({
      coefficients: fr.lastResult.coefficients,
      subtract_terms: getSubtractTerms(),
      wavelength_nm: getWavelength(),
      surface_height: fr.lastResult.surface_height,
      surface_width: fr.lastResult.surface_width,
      form_model: getFormModel(),
    }),
```

Also update the analyze call in `fringe-panel.js` to pass `form_model`:

In `analyzeFromCamera()` and `analyzeFromFile()`, add `form_model: getFormModel()` to the payload. This requires importing `getFormModel` from `fringe-results.js`.

- [ ] **Step 6: Update summary bar subtraction text**

In the summary bar rendering in `renderResults()`, update the subtraction text (around line 247):

```javascript
  if (subEl) {
    if (formModel === "plane") {
      subEl.textContent = "Plane removed";
    } else {
      const sub = getSubtractTerms();
      const names = [];
      if (sub.includes(2)) names.push("Tilt");
      if (sub.includes(4)) names.push("Curvature");
      if (sub.includes(5)) names.push("Twist");
      if (sub.includes(7)) names.push("Coma");
      if (sub.includes(11)) names.push("Sph");
      subEl.textContent = names.length ? names.join(", ") + " subtracted" : "None subtracted";
    }
  }
```

- [ ] **Step 7: Commit**

```bash
git add frontend/fringe-results.js frontend/fringe-panel.js frontend/style.css
git commit -m "feat(fringe-ui): form model selector (plane/zernike), reframed pills with manufacturing labels"
```

---

### Task 11: Backend Tests — Full Pipeline Integration

**Files:**
- Test: `tests/test_fringe.py`

Verify the full pipeline returns all new fields correctly, and that API endpoints accept the new parameters.

- [ ] **Step 1: Write integration tests**

```python
class TestPipelineV2Integration:
    """Full pipeline integration tests for v2 features."""

    def _make_fringe_image(self, h=256, w=256, period=20):
        x = np.arange(w)
        row = (128 + 80 * np.sin(2 * np.pi * x / period)).astype(np.uint8)
        return np.tile(row, (h, 1))

    def test_full_result_has_all_v2_fields(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        r = analyze_interferogram(img)
        # Confidence
        assert "confidence" in r
        assert "confidence_maps" in r
        assert "unwrap_stats" in r
        # Form model
        assert "form_model" in r
        assert r["form_model"] == "zernike"
        # Enhanced carrier
        assert "snr_db" in r["carrier"]
        assert "dc_margin_px" in r["carrier"]
        assert "alternate_peaks" in r["carrier"]

    def test_plane_model_full_pipeline(self):
        from backend.vision.fringe import analyze_interferogram
        img = self._make_fringe_image()
        r = analyze_interferogram(img, form_model="plane")
        assert r["form_model"] == "plane"
        assert r["plane_fit"] is not None
        assert "a" in r["plane_fit"]
        assert r["pv_nm"] > 0

    def test_reanalyze_with_plane_model(self):
        from backend.vision.fringe import analyze_interferogram, reanalyze
        img = self._make_fringe_image()
        r1 = analyze_interferogram(img)
        r2 = reanalyze(
            coefficients=r1["coefficients"],
            subtract_terms=[1, 2, 3],
            wavelength_nm=632.8,
            surface_height=r1["surface_height"],
            surface_width=r1["surface_width"],
            form_model="plane",
        )
        assert r2["form_model"] == "plane"
        assert "pv_nm" in r2
```

- [ ] **Step 2: Write API endpoint tests**

```python
class TestFringeAPIV2:
    """API endpoint tests for v2 features."""

    @pytest.fixture
    def client(self, fake_camera_app):
        return TestClient(fake_camera_app)

    def test_analyze_accepts_form_model(self, client):
        r = client.post("/fringe/analyze", json={"form_model": "plane"})
        assert r.status_code == 200
        data = r.json()
        assert data["form_model"] == "plane"

    def test_reanalyze_accepts_form_model(self, client):
        # First analyze to get coefficients
        r1 = client.post("/fringe/analyze", json={})
        assert r1.status_code == 200
        d = r1.json()
        r2 = client.post("/fringe/reanalyze", json={
            "coefficients": d["coefficients"],
            "subtract_terms": [1, 2, 3],
            "wavelength_nm": 632.8,
            "surface_height": d["surface_height"],
            "surface_width": d["surface_width"],
            "form_model": "plane",
        })
        assert r2.status_code == 200

    def test_analyze_returns_confidence(self, client):
        r = client.post("/fringe/analyze", json={})
        assert r.status_code == 200
        data = r.json()
        assert "confidence" in data
        assert "confidence_maps" in data
```

- [ ] **Step 3: Run all tests**

Run: `.venv/bin/pytest tests/test_fringe.py -v`
Expected: ALL pass

- [ ] **Step 4: Commit**

```bash
git add tests/test_fringe.py
git commit -m "test(fringe): integration tests for pipeline v2 — confidence, plane fit, carrier diagnostics"
```
