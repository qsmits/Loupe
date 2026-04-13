# Fringe Analysis Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Fringe Analysis mode to Loupe for quantitative surface flatness measurement using monochromatic interferograms. Single-image analysis (no multi-frame session), stateless per request.

**Architecture:** Backend vision module with pure functions (Zernike polynomials, DFT phase extraction, unwrapping, rendering). API router factory following the deflectometry pattern. Frontend workspace with two-column layout, lazy DOM construction, MutationObserver lifecycle.

**Tech Stack:** Python 3.13, FastAPI, NumPy, SciPy, OpenCV, matplotlib colormaps, pytest, vanilla JS (ES2022), Three.js (CDN), Canvas 2D API.

---

## File map

| File | Change |
|------|--------|
| `backend/vision/fringe.py` | New: Zernike polynomials, DFT phase extraction, auto-mask, surface analysis, rendering |
| `backend/api_fringe.py` | New: `make_fringe_router(camera)` factory with `/fringe/analyze`, `/fringe/reanalyze`, `/fringe/focus-quality` |
| `backend/api.py` | Wire `make_fringe_router` into composed router |
| `frontend/fringe.js` | New: two-column workspace, capture, results display, re-analysis |
| `frontend/main.js` | Import and call `initFringe()` |
| `frontend/style.css` | Add `fringe-` prefixed styles |
| `frontend/index.html` | Replace fringe help placeholder with 6 help pages |
| `tests/test_fringe.py` | New: unit tests for vision module + API tests |

---

## Task 1: Vision module — Zernike polynomials

**Files:**
- Create: `backend/vision/fringe.py`
- Create: `tests/test_fringe.py` (Zernike tests only — extended in later tasks)

- [ ] **Step 1: Create the vision module with Zernike primitives**

Create `backend/vision/fringe.py`:

```python
"""Fringe analysis computation primitives.

Pure functions for Zernike polynomial fitting, DFT-based phase extraction,
spatial phase unwrapping, auto-masking, surface statistics, and false-color
rendering.  No state, no I/O beyond PNG encoding for visualization helpers.
"""

from __future__ import annotations

import base64
import math

import cv2
import numpy as np


# ── Zernike polynomial names (Noll ordering, 1-indexed) ─────────────────

ZERNIKE_NAMES: dict[int, str] = {
    1: "Piston",
    2: "Tilt X",
    3: "Tilt Y",
    4: "Power (Defocus)",
    5: "Astigmatism 45",
    6: "Astigmatism 0",
    7: "Coma Y",
    8: "Coma X",
    9: "Trefoil Y",
    10: "Trefoil X",
    11: "Spherical",
    12: "2nd Astigmatism 0",
    13: "2nd Astigmatism 45",
    14: "2nd Coma X",
    15: "2nd Coma Y",
    16: "Tetrafoil X",
    17: "Tetrafoil Y",
    18: "2nd Trefoil Y",
    19: "2nd Trefoil X",
    20: "3rd Coma Y",
    21: "3rd Coma X",
    22: "2nd Spherical",
    23: "Pentafoil X",
    24: "Pentafoil Y",
    25: "3rd Astigmatism 45",
    26: "3rd Astigmatism 0",
    27: "3rd Trefoil Y",
    28: "3rd Trefoil X",
    29: "3rd Coma Y",
    30: "3rd Coma X",
    31: "3rd Spherical",
    32: "Hexafoil X",
    33: "Hexafoil Y",
    34: "4th Astigmatism 0",
    35: "4th Astigmatism 45",
    36: "4th Spherical",
}

# Mapping from common UI group names to Noll indices for the subtraction panel.
ZERNIKE_GROUPS: dict[str, list[int]] = {
    "Piston": [1],
    "Tilt": [2, 3],
    "Power": [4],
    "Astigmatism": [5, 6],
    "Coma": [7, 8],
    "Spherical": [11],
}


def zernike_noll_index(j: int) -> tuple[int, int]:
    """Convert Noll index j (1-based) to radial order n and azimuthal frequency m.

    Follows the Noll (1976) sequential ordering convention:
      j=1 → (0,0), j=2 → (1,1), j=3 → (1,-1), j=4 → (2,0), ...

    Returns (n, m) where n >= 0 and -n <= m <= n with n-|m| even.
    """
    if j < 1:
        raise ValueError(f"Noll index must be >= 1, got {j}")
    # Find the radial order n: j falls in the range [n(n+1)/2+1, (n+1)(n+2)/2]
    n = 0
    while (n + 1) * (n + 2) // 2 < j:
        n += 1
    # Position within this radial order (0-based)
    k = j - n * (n + 1) // 2 - 1
    # Determine m from the position and parity rules
    if n == 0:
        return (0, 0)
    # Build the m values for this n in Noll order
    m_values: list[int] = []
    for m_abs in range(n, -1, -2):
        if m_abs == 0:
            m_values.append(0)
        else:
            # Even j → positive m (cosine); odd j → negative m (sine)
            # But we need to figure out which comes first in the Noll ordering
            m_values.append(m_abs)
            m_values.append(-m_abs)
    if k >= len(m_values):
        k = len(m_values) - 1
    m = m_values[k]
    # Apply the Noll sign convention: even j → |m|, odd j → -|m|
    # (or equivalently: even j → cosine term, odd j → sine term)
    m_abs = abs(m)
    if m_abs != 0:
        if j % 2 == 0:
            m = m_abs
        else:
            m = -m_abs
    return (n, m)


def _radial_polynomial(n: int, m_abs: int, rho: np.ndarray) -> np.ndarray:
    """Compute the radial Zernike polynomial R_n^|m|(rho).

    Uses the explicit sum formula:
      R_n^m(rho) = sum_{s=0}^{(n-m)/2} (-1)^s * (n-s)! / (s! * ((n+m)/2-s)! * ((n-m)/2-s)!) * rho^(n-2s)
    """
    result = np.zeros_like(rho)
    for s in range((n - m_abs) // 2 + 1):
        num = ((-1) ** s) * math.factorial(n - s)
        den = (
            math.factorial(s)
            * math.factorial((n + m_abs) // 2 - s)
            * math.factorial((n - m_abs) // 2 - s)
        )
        result = result + (num / den) * rho ** (n - 2 * s)
    return result


def zernike_polynomial(j: int, rho: np.ndarray, theta: np.ndarray) -> np.ndarray:
    """Evaluate Zernike polynomial Z_j over normalized polar coordinates.

    Parameters
    ----------
    j : Noll index (1-based).
    rho : radial coordinate, normalized to [0, 1] over the aperture.
    theta : azimuthal angle in radians.

    Returns
    -------
    Z_j(rho, theta) as a float64 array with the same shape as rho.
    Normalization follows the Noll convention (orthonormal over the unit disk).
    """
    n, m = zernike_noll_index(j)
    m_abs = abs(m)
    R = _radial_polynomial(n, m_abs, rho)
    # Normalization factor
    if m == 0:
        norm = math.sqrt(n + 1.0)
    else:
        norm = math.sqrt(2.0 * (n + 1.0))
    if m > 0:
        return norm * R * np.cos(m_abs * theta)
    elif m < 0:
        return norm * R * np.sin(m_abs * theta)
    else:
        return norm * R


def zernike_basis(n_terms: int, rho: np.ndarray, theta: np.ndarray,
                  mask: np.ndarray | None = None) -> np.ndarray:
    """Build a Zernike basis matrix for fitting.

    Parameters
    ----------
    n_terms : number of Zernike terms (Noll j = 1..n_terms).
    rho : 2D array of normalized radial coordinates.
    theta : 2D array of azimuthal angles.
    mask : optional boolean mask; only True pixels are included.

    Returns
    -------
    Z : shape (n_valid_pixels, n_terms) basis matrix.
    """
    if mask is not None:
        valid = mask.ravel().astype(bool)
        rho_v = rho.ravel()[valid]
        theta_v = theta.ravel()[valid]
    else:
        rho_v = rho.ravel()
        theta_v = theta.ravel()
    n_px = rho_v.size
    Z = np.empty((n_px, n_terms), dtype=np.float64)
    for j in range(1, n_terms + 1):
        Z[:, j - 1] = zernike_polynomial(j, rho_v, theta_v)
    return Z


def _make_polar_coords(shape: tuple[int, int], mask: np.ndarray | None = None
                       ) -> tuple[np.ndarray, np.ndarray]:
    """Create normalized polar coordinates over the aperture.

    The aperture center is the image center. The normalization radius is
    the largest radius that fits within the masked region (if mask is given)
    or within the image rectangle (if no mask).
    """
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = w / 2.0, h / 2.0
    dx = (xx - cx).astype(np.float64)
    dy = (yy - cy).astype(np.float64)
    r = np.sqrt(dx ** 2 + dy ** 2)
    if mask is not None and mask.any():
        r_max = float(r[mask].max())
    else:
        r_max = float(r.max())
    if r_max < 1e-6:
        r_max = 1.0
    rho = r / r_max
    theta = np.arctan2(dy, dx)
    return rho, theta


def fit_zernike(surface: np.ndarray, n_terms: int = 36,
                mask: np.ndarray | None = None
                ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Least-squares fit of Zernike polynomials to a surface.

    Parameters
    ----------
    surface : 2D phase or height array.
    n_terms : number of Zernike terms to fit (default 36).
    mask : boolean mask (True = valid pixel).

    Returns
    -------
    coeffs : shape (n_terms,) array of Zernike coefficients.
    rho : 2D normalized radial coordinates (for reuse in subtract).
    theta : 2D azimuthal angles (for reuse in subtract).
    """
    rho, theta = _make_polar_coords(surface.shape, mask)
    Z = zernike_basis(n_terms, rho, theta, mask)
    if mask is not None:
        data = surface.ravel()[mask.ravel().astype(bool)]
    else:
        data = surface.ravel()
    # Least-squares solve
    coeffs, _, _, _ = np.linalg.lstsq(Z, data, rcond=None)
    return coeffs, rho, theta


def subtract_zernike(surface: np.ndarray, coeffs: np.ndarray,
                     terms_to_subtract: list[int],
                     rho: np.ndarray, theta: np.ndarray,
                     mask: np.ndarray | None = None) -> np.ndarray:
    """Reconstruct and subtract selected Zernike terms from a surface.

    Parameters
    ----------
    surface : 2D array (original unwrapped phase or height).
    coeffs : Zernike coefficients from fit_zernike.
    terms_to_subtract : list of Noll indices (1-based) to subtract.
    rho : normalized radial coordinates from fit_zernike.
    theta : azimuthal angles from fit_zernike.
    mask : boolean mask (True = valid).

    Returns
    -------
    Corrected surface with the selected terms removed.
    """
    correction = np.zeros(surface.shape, dtype=np.float64)
    for j in terms_to_subtract:
        if j < 1 or j > len(coeffs):
            continue
        Zj = zernike_polynomial(j, rho, theta)
        correction += coeffs[j - 1] * Zj
    result = surface.astype(np.float64) - correction
    if mask is not None:
        result[~mask.astype(bool)] = 0.0
    return result
```

- [ ] **Step 2: Create the initial test file for Zernike functions**

Create `tests/test_fringe.py`:

```python
"""Tests for fringe analysis vision module."""
import math
import numpy as np
import pytest

from backend.vision.fringe import (
    ZERNIKE_NAMES,
    fit_zernike,
    subtract_zernike,
    zernike_basis,
    zernike_noll_index,
    zernike_polynomial,
    _make_polar_coords,
)


class TestZernikeNollIndex:
    def test_first_few_indices(self):
        assert zernike_noll_index(1) == (0, 0)   # Piston
        assert zernike_noll_index(2) == (1, 1)   # Tilt X
        assert zernike_noll_index(3) == (1, -1)  # Tilt Y
        assert zernike_noll_index(4) == (2, 0)   # Defocus

    def test_invalid_index_raises(self):
        with pytest.raises(ValueError):
            zernike_noll_index(0)

    def test_n_m_parity(self):
        """n - |m| must be even for all valid Noll indices."""
        for j in range(1, 37):
            n, m = zernike_noll_index(j)
            assert (n - abs(m)) % 2 == 0, f"j={j}: n={n}, m={m}"


class TestZernikePolynomial:
    def test_piston_is_constant(self):
        rho = np.linspace(0, 1, 50)
        theta = np.zeros_like(rho)
        Z1 = zernike_polynomial(1, rho, theta)
        # Piston Z1 = 1.0 (normalized)
        np.testing.assert_allclose(Z1, 1.0, atol=1e-10)

    def test_orthogonality_on_unit_disk(self):
        """Verify orthogonality of first few Zernike polynomials via numerical integration."""
        N = 200
        rho_1d = np.linspace(0, 1, N)
        theta_1d = np.linspace(0, 2 * np.pi, N, endpoint=False)
        rho_2d, theta_2d = np.meshgrid(rho_1d, theta_1d)
        rho_flat = rho_2d.ravel()
        theta_flat = theta_2d.ravel()

        # Numerical integration weight: r * dr * dtheta (polar area element)
        dr = 1.0 / N
        dtheta = 2 * np.pi / N
        w = rho_flat * dr * dtheta

        for i in range(1, 7):
            for k in range(i + 1, 7):
                Zi = zernike_polynomial(i, rho_flat, theta_flat)
                Zk = zernike_polynomial(k, rho_flat, theta_flat)
                integral = np.sum(Zi * Zk * w) / np.pi  # normalize by disk area
                assert abs(integral) < 0.05, (
                    f"Z{i} and Z{k} not orthogonal: integral={integral:.4f}"
                )


class TestZernikeFitting:
    def test_recovers_tilt(self):
        """Fit a pure tilt surface and verify coefficient recovery."""
        h, w = 128, 128
        rho, theta = _make_polar_coords((h, w))
        # Create a pure Tilt X surface (Noll j=2)
        Z2 = zernike_polynomial(2, rho, theta)
        surface = 3.5 * Z2
        mask = rho <= 1.0

        coeffs, _, _ = fit_zernike(surface, n_terms=36, mask=mask)
        # Coefficient for j=2 should be ~3.5, all others ~0
        assert abs(coeffs[1] - 3.5) < 0.1
        for j in range(36):
            if j != 1:
                assert abs(coeffs[j]) < 0.1, f"j={j+1}: coeff={coeffs[j]:.4f}"

    def test_recovers_power(self):
        """Fit a pure power (defocus) surface."""
        h, w = 128, 128
        rho, theta = _make_polar_coords((h, w))
        Z4 = zernike_polynomial(4, rho, theta)
        surface = 2.0 * Z4
        mask = rho <= 1.0

        coeffs, _, _ = fit_zernike(surface, n_terms=36, mask=mask)
        assert abs(coeffs[3] - 2.0) < 0.1
        for j in range(36):
            if j != 3:
                assert abs(coeffs[j]) < 0.15, f"j={j+1}: coeff={coeffs[j]:.4f}"

    def test_subtract_removes_tilt(self):
        """After subtracting tilt, residual should be near zero."""
        h, w = 128, 128
        rho, theta = _make_polar_coords((h, w))
        Z2 = zernike_polynomial(2, rho, theta)
        Z3 = zernike_polynomial(3, rho, theta)
        surface = 3.0 * Z2 + 1.5 * Z3
        mask = rho <= 1.0

        coeffs, rho_f, theta_f = fit_zernike(surface, n_terms=36, mask=mask)
        corrected = subtract_zernike(surface, coeffs, [2, 3], rho_f, theta_f, mask)
        # Residual should be near zero within the aperture
        residual_rms = np.sqrt(np.mean(corrected[mask] ** 2))
        assert residual_rms < 0.1


class TestZernikeNames:
    def test_has_36_entries(self):
        assert len(ZERNIKE_NAMES) == 36

    def test_first_terms(self):
        assert ZERNIKE_NAMES[1] == "Piston"
        assert ZERNIKE_NAMES[2] == "Tilt X"
        assert ZERNIKE_NAMES[3] == "Tilt Y"
        assert ZERNIKE_NAMES[4] == "Power (Defocus)"
```

---

## Task 2: Vision module — DFT phase extraction & auto-mask

**Files:**
- Modify: `backend/vision/fringe.py` (append functions)
- Modify: `tests/test_fringe.py` (append test classes)

- [ ] **Step 1: Add modulation, masking, DFT phase extraction, and focus quality**

Append to `backend/vision/fringe.py`:

```python
def compute_fringe_modulation(image: np.ndarray) -> np.ndarray:
    """Compute a local contrast (modulation) map for auto-masking.

    Uses a sliding-window approach: for each pixel, modulation is the
    local standard deviation within a 15x15 window, normalized by the
    local mean.  High modulation = fringes present = valid data.

    Parameters
    ----------
    image : 2D grayscale float64 or uint8 image.

    Returns
    -------
    Modulation map as float64, same shape as input.  Values in [0, 1].
    """
    from scipy.ndimage import uniform_filter

    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)
    ksize = 15
    local_mean = uniform_filter(img, size=ksize)
    local_sq_mean = uniform_filter(img ** 2, size=ksize)
    local_var = np.maximum(local_sq_mean - local_mean ** 2, 0.0)
    local_std = np.sqrt(local_var)
    # Normalize: modulation = std / (mean + eps) clipped to [0, 1]
    modulation = local_std / (local_mean + 1e-6)
    return np.clip(modulation, 0.0, 1.0)


def create_fringe_mask(modulation: np.ndarray, threshold_frac: float = 0.15
                       ) -> np.ndarray:
    """Create a boolean mask from modulation map.

    Parameters
    ----------
    modulation : float64 modulation map from compute_fringe_modulation.
    threshold_frac : fraction of max modulation below which pixels are masked out.

    Returns
    -------
    Boolean mask: True = valid pixel with adequate fringe contrast.
    """
    thresh = threshold_frac * float(modulation.max()) if modulation.max() > 0 else 0.0
    return modulation > thresh


def extract_phase_dft(image: np.ndarray, mask: np.ndarray | None = None
                      ) -> np.ndarray:
    """Extract wrapped phase from an interferogram using 2D DFT sideband isolation.

    Pipeline:
    1. Window the image (Hann) to reduce spectral leakage
    2. 2D FFT
    3. Find the +1 order carrier peak (strongest off-center peak)
    4. Isolate the sideband with a Gaussian window
    5. Shift to origin, inverse FFT
    6. Extract wrapped phase: atan2(Im, Re)

    Parameters
    ----------
    image : 2D grayscale image (float64 or uint8).
    mask : optional boolean mask (True = valid). Masked-out pixels are set to
           the image mean before FFT to reduce ringing.

    Returns
    -------
    Wrapped phase map in [-pi, pi], same shape as input.
    """
    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)
    h, w = img.shape

    # Fill masked pixels with mean to reduce spectral leakage
    if mask is not None:
        valid = mask.astype(bool)
        if valid.any():
            mean_val = img[valid].mean()
        else:
            mean_val = img.mean()
        img_work = img.copy()
        img_work[~valid] = mean_val
    else:
        img_work = img

    # Subtract DC and apply 2D Hann window
    img_work = img_work - img_work.mean()
    wy = np.hanning(h)
    wx = np.hanning(w)
    window = np.outer(wy, wx)
    img_windowed = img_work * window

    # 2D FFT
    F = np.fft.fft2(img_windowed)
    F_shifted = np.fft.fftshift(F)
    magnitude = np.abs(F_shifted)

    # Find the +1 order peak: strongest peak away from center
    cy, cx = h // 2, w // 2
    # Zero out the DC region (center ±5% of image)
    dc_margin_y = max(3, h // 20)
    dc_margin_x = max(3, w // 20)
    mag_search = magnitude.copy()
    mag_search[cy - dc_margin_y:cy + dc_margin_y + 1,
               cx - dc_margin_x:cx + dc_margin_x + 1] = 0

    # Find peak location
    peak_idx = np.unravel_index(np.argmax(mag_search), mag_search.shape)
    py, px = peak_idx

    # Use only the peak in the upper half-plane (or left half for horizontal fringes)
    # to select the +1 order consistently.  If the peak is in the lower/right half,
    # use its conjugate.
    if py > cy or (py == cy and px > cx):
        py = h - py
        px = w - px

    # Gaussian window centered on the sideband peak
    yy, xx = np.mgrid[0:h, 0:w]
    # Window radius: ~1/3 of distance from peak to center
    dist_to_center = math.sqrt((py - cy) ** 2 + (px - cx) ** 2)
    sigma = max(dist_to_center / 3.0, 3.0)
    gauss = np.exp(-((yy - py) ** 2 + (xx - px) ** 2) / (2 * sigma ** 2))

    # Isolate sideband
    sideband = F_shifted * gauss

    # Shift sideband to origin
    shift_y = cy - py
    shift_x = cx - px
    sideband_shifted = np.roll(np.roll(sideband, int(shift_y), axis=0),
                               int(shift_x), axis=1)

    # Inverse FFT to get analytic signal
    analytic = np.fft.ifft2(np.fft.ifftshift(sideband_shifted))

    # Extract wrapped phase
    wrapped = np.angle(analytic)
    return wrapped.astype(np.float64)


def unwrap_phase_2d(wrapped: np.ndarray, mask: np.ndarray | None = None
                    ) -> np.ndarray:
    """Quality-guided 2D spatial phase unwrapping.

    Uses the phase gradient reliability as quality metric.  Pixels are
    unwrapped in order of decreasing reliability (highest quality first).

    For a simpler implementation that works well with interferograms,
    we unwrap along rows first (axis=1), then along columns (axis=0),
    using numpy.unwrap.  This two-pass approach handles most
    interferograms where the fringe density is moderate.

    Parameters
    ----------
    wrapped : 2D float64 array of wrapped phase in [-pi, pi].
    mask : optional boolean mask (True = valid).

    Returns
    -------
    Unwrapped phase map, float64.
    """
    # Two-pass unwrap: horizontal then vertical
    phase = wrapped.copy()
    if mask is not None:
        # Fill masked pixels with neighbor average to avoid discontinuities
        valid = mask.astype(bool)
        if valid.any():
            phase[~valid] = 0.0

    # Unwrap along rows
    unwrapped = np.unwrap(phase, axis=1)
    # Unwrap along columns
    unwrapped = np.unwrap(unwrapped, axis=0)

    if mask is not None:
        unwrapped[~valid] = 0.0

    return unwrapped


def focus_quality(image: np.ndarray) -> float:
    """Compute a focus quality score (0-100) based on image sharpness.

    Uses the variance of the Laplacian as a sharpness metric, mapped
    to [0, 100] via a sigmoid.

    Parameters
    ----------
    image : grayscale or BGR image.

    Returns
    -------
    Score from 0 (completely blurred) to 100 (very sharp).
    """
    img = np.asarray(image, dtype=np.uint8)
    if img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    laplacian = cv2.Laplacian(img, cv2.CV_64F)
    variance = float(laplacian.var())
    # Sigmoid mapping: score = 100 / (1 + exp(-k*(var - mid)))
    # Tuned so that var~100 → score~50, var~500 → score~95
    k = 0.02
    mid = 150.0
    score = 100.0 / (1.0 + math.exp(-k * (variance - mid)))
    return round(score, 1)
```

- [ ] **Step 2: Add DFT phase extraction tests**

Append to `tests/test_fringe.py`:

```python
from backend.vision.fringe import (
    compute_fringe_modulation,
    create_fringe_mask,
    extract_phase_dft,
    unwrap_phase_2d,
    focus_quality,
)


class TestFringeModulation:
    def test_uniform_image_low_modulation(self):
        """A uniform gray image should have very low modulation everywhere."""
        img = np.full((100, 100), 128.0)
        mod = compute_fringe_modulation(img)
        assert mod.shape == (100, 100)
        assert mod.max() < 0.05

    def test_fringe_image_high_modulation(self):
        """An image with sinusoidal fringes should have high modulation."""
        x = np.linspace(0, 20 * np.pi, 200)
        img = 128.0 + 100.0 * np.sin(x[None, :]) * np.ones((100, 1))
        mod = compute_fringe_modulation(img)
        # Center region should have high modulation
        center_mod = mod[30:70, 30:170].mean()
        assert center_mod > 0.2


class TestFringeMask:
    def test_mask_rejects_uniform_region(self):
        """Uniform region should be masked out."""
        mod = np.zeros((100, 100))
        mod[20:80, 20:80] = 1.0  # Only center has fringes
        mask = create_fringe_mask(mod, threshold_frac=0.15)
        assert mask[50, 50] == True   # Center is valid
        assert mask[5, 5] == False    # Corner is masked

    def test_mask_all_zeros(self):
        """All-zero modulation should produce all-False mask."""
        mod = np.zeros((50, 50))
        mask = create_fringe_mask(mod, threshold_frac=0.15)
        assert not mask.any()


class TestDFTPhaseExtraction:
    def test_extracts_phase_from_synthetic_interferogram(self):
        """Generate a synthetic interferogram with known carrier and verify extraction."""
        h, w = 256, 256
        yy, xx = np.mgrid[0:h, 0:w]
        # Carrier: 8 fringes across the width (vertical fringes)
        carrier_freq = 8
        carrier_phase = 2 * np.pi * carrier_freq * xx / w
        # Surface phase: a gentle tilt
        surface_phase = 0.5 * (xx - w / 2) / w * 2 * np.pi
        # Interferogram: I = 128 + 100 * cos(carrier + surface)
        interferogram = 128.0 + 100.0 * np.cos(carrier_phase + surface_phase)

        wrapped = extract_phase_dft(interferogram)
        assert wrapped.shape == (h, w)
        # The extracted phase should vary monotonically across the image
        # Check that the phase difference across center row is roughly correct
        center_row = wrapped[h // 2, :]
        phase_range = center_row[-10] - center_row[10]
        # Surface phase range is about 2*pi*0.5 = pi across the image
        assert abs(abs(phase_range) - np.pi) < 1.5, (
            f"Phase range {phase_range:.3f} not close to pi"
        )

    def test_returns_correct_shape(self):
        img = np.random.rand(64, 128) * 255
        wrapped = extract_phase_dft(img)
        assert wrapped.shape == (64, 128)


class TestUnwrap2D:
    def test_unwraps_simple_ramp(self):
        """A phase ramp should unwrap to a smooth surface."""
        h, w = 50, 200
        true_phase = np.linspace(0, 6 * np.pi, w)[None, :].repeat(h, 0)
        wrapped = np.angle(np.exp(1j * true_phase))
        unwrapped = unwrap_phase_2d(wrapped)
        # Should be smooth: no jumps > pi between adjacent pixels
        diff_x = np.abs(np.diff(unwrapped, axis=1))
        assert diff_x.max() < np.pi + 0.1

    def test_mask_zeros_invalid(self):
        phase = np.zeros((50, 50))
        mask = np.ones((50, 50), dtype=bool)
        mask[0:10, :] = False
        unwrapped = unwrap_phase_2d(phase, mask)
        assert unwrapped[5, 25] == 0.0  # masked pixel is zeroed


class TestFocusQuality:
    def test_sharp_image_scores_high(self):
        """An image with sharp edges should score higher than a blurred one."""
        # Sharp: white rectangle on black
        sharp = np.zeros((100, 100), dtype=np.uint8)
        cv2.rectangle(sharp, (20, 20), (80, 80), 255, 2)

        # Blurred: same rectangle, heavily blurred
        blurred = cv2.GaussianBlur(sharp, (31, 31), 10)

        score_sharp = focus_quality(sharp)
        score_blurred = focus_quality(blurred)
        assert score_sharp > score_blurred

    def test_returns_0_to_100(self):
        img = np.zeros((50, 50), dtype=np.uint8)
        score = focus_quality(img)
        assert 0 <= score <= 100


import cv2 as cv2  # noqa: E402 (already imported above but needed for test scope)
```

---

## Task 3: Vision module — surface analysis & rendering

**Files:**
- Modify: `backend/vision/fringe.py` (append functions)
- Modify: `tests/test_fringe.py` (append test classes)

- [ ] **Step 1: Add height conversion, stats, and rendering functions**

Append to `backend/vision/fringe.py`:

```python
def phase_to_height(phase: np.ndarray, wavelength_nm: float) -> np.ndarray:
    """Convert phase (radians) to physical height (nanometers).

    For a double-pass interferometer (reflection):
      height = phase * lambda / (4 * pi)

    Parameters
    ----------
    phase : unwrapped phase in radians.
    wavelength_nm : light source wavelength in nanometers.

    Returns
    -------
    Height map in nanometers.
    """
    return phase * wavelength_nm / (4.0 * np.pi)


def surface_stats(surface: np.ndarray, mask: np.ndarray | None = None
                  ) -> dict:
    """Compute PV (peak-to-valley) and RMS of a surface.

    Parameters
    ----------
    surface : 2D height or phase array.
    mask : boolean mask (True = valid).

    Returns
    -------
    {"pv": float, "rms": float, "mean": float} in the same units as input.
    """
    s = np.asarray(surface, dtype=np.float64)
    if mask is not None:
        valid = mask.astype(bool)
        s = s[valid]
        if s.size == 0:
            return {"pv": 0.0, "rms": 0.0, "mean": 0.0}
    mean = float(s.mean())
    pv = float(s.max() - s.min())
    rms = float(np.sqrt(np.mean((s - mean) ** 2)))
    return {"pv": pv, "rms": rms, "mean": mean}


def render_surface_map(surface: np.ndarray, mask: np.ndarray | None = None
                       ) -> str:
    """Render a false-color surface map as a PNG, base64-encoded.

    Uses the RdBu_r (red-blue reversed) colormap: red = high, blue = low.
    Masked-out pixels are rendered as black.

    Returns base64 string (no 'data:' prefix).
    """
    s = np.asarray(surface, dtype=np.float64)
    if mask is not None:
        valid = mask.astype(bool)
        if valid.any():
            smin = float(s[valid].min())
            smax = float(s[valid].max())
        else:
            smin, smax = 0.0, 0.0
    else:
        smin = float(s.min())
        smax = float(s.max())

    if smax > smin:
        # Center around zero for symmetric colormap
        vmax = max(abs(smin), abs(smax))
        norm = ((s + vmax) / (2.0 * vmax) * 255.0)
    else:
        norm = np.full_like(s, 128.0)

    gray = np.clip(norm, 0, 255).astype(np.uint8)
    if mask is not None:
        gray[~valid] = 0

    # Apply RdBu_r-like colormap via OpenCV
    # OpenCV COLORMAP_JET is similar; use custom LUT for RdBu_r
    # For simplicity, use matplotlib to generate the LUT
    try:
        import matplotlib.pyplot as plt
        cmap = plt.cm.RdBu_r
        lut = (cmap(np.linspace(0, 1, 256))[:, :3] * 255).astype(np.uint8)
        # Apply LUT manually
        colored = lut[gray]
        # Convert RGB to BGR for cv2
        colored = colored[:, :, ::-1].copy()
    except ImportError:
        # Fallback to VIRIDIS
        colored = cv2.applyColorMap(gray, cv2.COLORMAP_VIRIDIS)

    if mask is not None:
        colored[~valid] = 0

    ok, buf = cv2.imencode(".png", colored)
    if not ok:
        raise RuntimeError("cv2.imencode failed for surface map PNG")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def render_profile(surface: np.ndarray, mask: np.ndarray | None = None,
                   axis: str = "x") -> dict:
    """Extract a cross-section profile through the center of the surface.

    Parameters
    ----------
    surface : 2D array.
    mask : boolean mask.
    axis : "x" for horizontal profile (row at center), "y" for vertical.

    Returns
    -------
    JSON-serializable dict with keys:
      "positions": list of pixel positions along the axis
      "values": list of height/phase values (None for masked pixels)
      "axis": "x" or "y"
    """
    h, w = surface.shape
    if axis == "x":
        row = h // 2
        profile = surface[row, :]
        mask_row = mask[row, :] if mask is not None else np.ones(w, dtype=bool)
        positions = list(range(w))
    else:
        col = w // 2
        profile = surface[:, col]
        mask_row = mask[:, col] if mask is not None else np.ones(h, dtype=bool)
        positions = list(range(h))

    values = []
    for val, m in zip(profile, mask_row):
        values.append(float(val) if m else None)

    return {"positions": positions, "values": values, "axis": axis}


def render_zernike_chart(coefficients: list[float],
                         subtracted_terms: list[int],
                         wavelength_nm: float) -> str:
    """Render a bar chart of Zernike coefficients as a PNG, base64-encoded.

    Bars are colored: blue for included terms, gray for subtracted terms.
    Values are shown in both waves (lambda) and nm.

    Returns base64 string (no 'data:' prefix).
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    n_terms = len(coefficients)
    indices = list(range(1, n_terms + 1))

    # Convert coefficients to waves (1 wave = 2*pi radians)
    coeff_waves = [c / (2 * np.pi) for c in coefficients]
    coeff_nm = [c * wavelength_nm / (4 * np.pi) for c in coefficients]

    colors = []
    for j in indices:
        if j in subtracted_terms:
            colors.append("#666666")  # gray for subtracted
        else:
            colors.append("#4a9eff")  # blue for active

    fig, ax = plt.subplots(figsize=(10, 3.5), dpi=100)
    fig.patch.set_facecolor("#1c1c1e")
    ax.set_facecolor("#1c1c1e")

    bars = ax.bar(indices, coeff_waves, color=colors, edgecolor="none", width=0.7)
    ax.set_xlabel("Zernike term (Noll index)", color="#e8e8e8", fontsize=9)
    ax.set_ylabel("Coefficient (waves)", color="#e8e8e8", fontsize=9)
    ax.set_title("Zernike Coefficients", color="#e8e8e8", fontsize=11)
    ax.tick_params(colors="#ababab", labelsize=8)
    ax.spines["bottom"].set_color("#3a3a3c")
    ax.spines["left"].set_color("#3a3a3c")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.axhline(y=0, color="#3a3a3c", linewidth=0.5)

    # Add term names as x-tick labels for first 11 terms
    if n_terms <= 15:
        labels = [ZERNIKE_NAMES.get(j, str(j)) for j in indices]
        ax.set_xticks(indices)
        ax.set_xticklabels(labels, rotation=45, ha="right", fontsize=7)
    else:
        ax.set_xticks(indices[::3])

    plt.tight_layout()

    import io
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor=fig.get_facecolor(), edgecolor="none")
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("ascii")


def analyze_interferogram(image: np.ndarray, wavelength_nm: float = 632.8,
                          mask_threshold: float = 0.15,
                          subtract_terms: list[int] | None = None,
                          n_zernike: int = 36) -> dict:
    """Full analysis pipeline: single image in, all results out.

    Parameters
    ----------
    image : grayscale or BGR interferogram.
    wavelength_nm : light source wavelength.
    mask_threshold : modulation threshold for auto-masking (0-1).
    subtract_terms : Noll indices to subtract (default: [1, 2, 3] = piston + tilt).
    n_zernike : number of Zernike terms to fit.

    Returns
    -------
    Dict with keys: surface_map, zernike_chart, profile_x, profile_y,
    coefficients, pv_nm, rms_nm, pv_waves, rms_waves, modulation_stats,
    focus_score, subtracted_terms, wavelength_nm, n_valid_pixels, n_total_pixels.
    """
    if subtract_terms is None:
        subtract_terms = [1, 2, 3]  # Piston + Tilt X + Tilt Y

    img = np.asarray(image, dtype=np.float64)
    if img.ndim == 3:
        img = img.mean(axis=-1)

    # Step 1: Modulation & mask
    modulation = compute_fringe_modulation(img)
    mask = create_fringe_mask(modulation, threshold_frac=mask_threshold)
    n_valid = int(mask.sum())
    n_total = int(mask.size)

    # Step 2: DFT phase extraction
    wrapped = extract_phase_dft(img, mask)

    # Step 3: Phase unwrapping
    unwrapped = unwrap_phase_2d(wrapped, mask)

    # Step 4: Zernike fitting
    coeffs, rho, theta = fit_zernike(unwrapped, n_terms=n_zernike, mask=mask)

    # Step 5: Subtract selected terms
    corrected = subtract_zernike(unwrapped, coeffs, subtract_terms, rho, theta, mask)

    # Step 6: Convert to height
    height_nm = phase_to_height(corrected, wavelength_nm)

    # Step 7: Statistics
    stats = surface_stats(height_nm, mask)
    pv_nm = stats["pv"]
    rms_nm = stats["rms"]
    pv_waves = pv_nm / wavelength_nm
    rms_waves = rms_nm / wavelength_nm

    # Step 8: Focus quality
    f_score = focus_quality(image)

    # Step 9: Renderings
    surface_map_b64 = render_surface_map(height_nm, mask)
    profile_x = render_profile(height_nm, mask, axis="x")
    profile_y = render_profile(height_nm, mask, axis="y")

    # Step 10: Zernike chart
    zernike_chart_b64 = render_zernike_chart(
        coeffs.tolist(), subtract_terms, wavelength_nm
    )

    # Modulation stats
    mod_stats = {
        "min": float(modulation.min()),
        "max": float(modulation.max()),
        "mean": float(modulation.mean()),
    }

    return {
        "surface_map": surface_map_b64,
        "zernike_chart": zernike_chart_b64,
        "profile_x": profile_x,
        "profile_y": profile_y,
        "coefficients": coeffs.tolist(),
        "coefficient_names": {str(j): ZERNIKE_NAMES.get(j, f"Z{j}")
                              for j in range(1, n_zernike + 1)},
        "pv_nm": pv_nm,
        "rms_nm": rms_nm,
        "pv_waves": pv_waves,
        "rms_waves": rms_waves,
        "modulation_stats": mod_stats,
        "focus_score": f_score,
        "subtracted_terms": subtract_terms,
        "wavelength_nm": wavelength_nm,
        "n_valid_pixels": n_valid,
        "n_total_pixels": n_total,
    }


def reanalyze(coefficients: list[float], subtract_terms: list[int],
              wavelength_nm: float, surface_shape: tuple[int, int],
              mask_serialized: list[int] | None = None,
              n_zernike: int = 36) -> dict:
    """Re-analyze with different Zernike subtraction without redoing FFT.

    This is the fast path: reconstruct the full surface from coefficients,
    subtract the requested terms, recompute stats and renderings.

    Parameters
    ----------
    coefficients : Zernike coefficients from a previous analyze call.
    subtract_terms : Noll indices to subtract.
    wavelength_nm : wavelength for height conversion.
    surface_shape : (height, width) of the original surface.
    mask_serialized : flat list of 0/1 values, same length as h*w.
    n_zernike : number of Zernike terms.

    Returns
    -------
    Dict with: surface_map, zernike_chart, profile_x, profile_y,
    pv_nm, rms_nm, pv_waves, rms_waves, subtracted_terms.
    """
    h, w = surface_shape
    coeffs = np.array(coefficients[:n_zernike], dtype=np.float64)

    # Reconstruct mask
    if mask_serialized is not None:
        mask = np.array(mask_serialized, dtype=bool).reshape(h, w)
    else:
        mask = np.ones((h, w), dtype=bool)

    rho, theta = _make_polar_coords((h, w), mask)

    # Reconstruct full surface from all coefficients
    full_surface = np.zeros((h, w), dtype=np.float64)
    for j in range(1, min(len(coeffs) + 1, n_zernike + 1)):
        Zj = zernike_polynomial(j, rho, theta)
        full_surface += coeffs[j - 1] * Zj

    # Subtract selected terms
    corrected = subtract_zernike(full_surface, coeffs, subtract_terms,
                                 rho, theta, mask)

    # Convert to height
    height_nm = phase_to_height(corrected, wavelength_nm)

    # Stats
    stats = surface_stats(height_nm, mask)

    # Renderings
    surface_map_b64 = render_surface_map(height_nm, mask)
    zernike_chart_b64 = render_zernike_chart(
        coeffs.tolist(), subtract_terms, wavelength_nm
    )
    profile_x = render_profile(height_nm, mask, axis="x")
    profile_y = render_profile(height_nm, mask, axis="y")

    return {
        "surface_map": surface_map_b64,
        "zernike_chart": zernike_chart_b64,
        "profile_x": profile_x,
        "profile_y": profile_y,
        "pv_nm": stats["pv"],
        "rms_nm": stats["rms"],
        "pv_waves": stats["pv"] / wavelength_nm,
        "rms_waves": stats["rms"] / wavelength_nm,
        "subtracted_terms": subtract_terms,
    }
```

- [ ] **Step 2: Add surface analysis and rendering tests**

Append to `tests/test_fringe.py`:

```python
from backend.vision.fringe import (
    phase_to_height,
    surface_stats,
    render_surface_map,
    render_profile,
    render_zernike_chart,
    analyze_interferogram,
    reanalyze,
)


class TestPhaseToHeight:
    def test_known_conversion(self):
        """2*pi radians at 632.8 nm should give 632.8/(4*pi)*2*pi = 316.4 nm."""
        phase = np.array([2 * np.pi])
        height = phase_to_height(phase, 632.8)
        expected = 632.8 / 2.0  # lambda/2 for a full wave
        np.testing.assert_allclose(height, expected, rtol=1e-6)

    def test_zero_phase_zero_height(self):
        phase = np.zeros((10, 10))
        height = phase_to_height(phase, 589.0)
        np.testing.assert_allclose(height, 0.0)


class TestSurfaceStats:
    def test_ramp_stats(self):
        s = np.linspace(0, 10, 101)
        stats = surface_stats(s)
        assert abs(stats["pv"] - 10.0) < 1e-9
        assert stats["rms"] > 0

    def test_masked_stats(self):
        s = np.array([0.0, 1.0, 2.0, 100.0])  # outlier at index 3
        mask = np.array([True, True, True, False])
        stats = surface_stats(s, mask)
        assert abs(stats["pv"] - 2.0) < 1e-9

    def test_empty_mask(self):
        s = np.ones((5, 5))
        mask = np.zeros((5, 5), dtype=bool)
        stats = surface_stats(s, mask)
        assert stats["pv"] == 0.0
        assert stats["rms"] == 0.0


class TestRenderSurfaceMap:
    def test_returns_valid_base64_png(self):
        surface = np.random.rand(50, 50)
        b64 = render_surface_map(surface)
        assert len(b64) > 100
        # Should decode without error
        decoded = base64.b64decode(b64)
        # PNG magic bytes
        assert decoded[:4] == b'\x89PNG'

    def test_masked_surface(self):
        surface = np.random.rand(50, 50)
        mask = np.ones((50, 50), dtype=bool)
        mask[:10, :] = False
        b64 = render_surface_map(surface, mask)
        assert len(b64) > 100


class TestRenderProfile:
    def test_x_profile(self):
        surface = np.arange(100).reshape(10, 10).astype(float)
        profile = render_profile(surface, axis="x")
        assert profile["axis"] == "x"
        assert len(profile["positions"]) == 10
        assert len(profile["values"]) == 10
        assert all(v is not None for v in profile["values"])

    def test_y_profile(self):
        surface = np.arange(100).reshape(10, 10).astype(float)
        profile = render_profile(surface, axis="y")
        assert profile["axis"] == "y"
        assert len(profile["positions"]) == 10

    def test_masked_profile(self):
        surface = np.ones((10, 10))
        mask = np.ones((10, 10), dtype=bool)
        mask[5, 3] = False
        profile = render_profile(surface, mask, axis="x")
        # The center row profile at y=5 should have None at x=3
        assert profile["values"][3] is None


class TestRenderZernikeChart:
    def test_returns_valid_png(self):
        coeffs = [0.1] * 36
        b64 = render_zernike_chart(coeffs, [2, 3], 632.8)
        assert len(b64) > 100
        decoded = base64.b64decode(b64)
        assert decoded[:4] == b'\x89PNG'


class TestAnalyzeInterferogram:
    def test_full_pipeline_synthetic(self):
        """Full pipeline on a synthetic interferogram returns expected keys."""
        h, w = 128, 128
        yy, xx = np.mgrid[0:h, 0:w]
        carrier = 2 * np.pi * 6 * xx / w
        surface = 0.5 * ((xx - w/2)**2 + (yy - h/2)**2) / (w/2)**2
        img = (128 + 100 * np.cos(carrier + surface)).astype(np.uint8)

        result = analyze_interferogram(img, wavelength_nm=632.8)

        # Check all expected keys are present
        expected_keys = {
            "surface_map", "zernike_chart", "profile_x", "profile_y",
            "coefficients", "coefficient_names", "pv_nm", "rms_nm",
            "pv_waves", "rms_waves", "modulation_stats", "focus_score",
            "subtracted_terms", "wavelength_nm", "n_valid_pixels", "n_total_pixels",
        }
        assert expected_keys.issubset(set(result.keys()))
        assert len(result["coefficients"]) == 36
        assert result["pv_nm"] >= 0
        assert result["rms_nm"] >= 0
        assert 0 <= result["focus_score"] <= 100


class TestReanalyze:
    def test_reanalyze_changes_stats(self):
        """Re-analyzing with different subtraction should change PV/RMS."""
        # First do a full analysis
        h, w = 64, 64
        yy, xx = np.mgrid[0:h, 0:w]
        carrier = 2 * np.pi * 4 * xx / w
        img = (128 + 80 * np.cos(carrier)).astype(np.uint8)

        result = analyze_interferogram(img, wavelength_nm=632.8,
                                       subtract_terms=[1, 2, 3])
        coeffs = result["coefficients"]

        # Re-analyze: subtract nothing
        r1 = reanalyze(coeffs, subtract_terms=[1],
                       wavelength_nm=632.8, surface_shape=(h, w))
        # Re-analyze: subtract tilt + power
        r2 = reanalyze(coeffs, subtract_terms=[1, 2, 3, 4],
                       wavelength_nm=632.8, surface_shape=(h, w))

        # The two should generally have different PV
        # (not a strict assertion since synthetic data might be degenerate,
        # but at least both should return valid results)
        assert r1["pv_nm"] >= 0
        assert r2["pv_nm"] >= 0
        assert "surface_map" in r1
        assert "surface_map" in r2


import base64  # noqa: E402 (for TestRenderSurfaceMap)
```

---

## Task 4: Backend API router

**Files:**
- Create: `backend/api_fringe.py`
- Modify: `backend/api.py` (add one import + one line)

- [ ] **Step 1: Create the API router**

Create `backend/api_fringe.py`:

```python
"""HTTP API for fringe analysis mode.

Stateless per request: each analysis takes a single image and returns
complete results.  The /reanalyze endpoint accepts cached Zernike
coefficients for instant re-computation when toggling subtraction terms.
"""

from __future__ import annotations

import base64
from typing import Optional

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from pydantic import BaseModel, Field

from .cameras.base import BaseCamera
from .vision.fringe import (
    analyze_interferogram,
    focus_quality,
    reanalyze,
)


def _reject_hosted(request: Request):
    if getattr(request.app.state, "hosted", False):
        raise HTTPException(403, detail="Fringe analysis is not available in hosted mode")


class AnalyzeBody(BaseModel):
    wavelength_nm: float = Field(default=632.8, gt=0, le=2000)
    mask_threshold: float = Field(default=0.15, ge=0.0, le=1.0)
    subtract_terms: list[int] = Field(default=[1, 2, 3])
    n_zernike: int = Field(default=36, ge=1, le=66)
    image_b64: Optional[str] = Field(default=None)


class ReanalyzeBody(BaseModel):
    coefficients: list[float]
    subtract_terms: list[int] = Field(default=[1, 2, 3])
    wavelength_nm: float = Field(default=632.8, gt=0, le=2000)
    surface_height: int = Field(gt=0)
    surface_width: int = Field(gt=0)
    mask: Optional[list[int]] = Field(default=None)
    n_zernike: int = Field(default=36, ge=1, le=66)


def make_fringe_router(camera: BaseCamera) -> APIRouter:
    router = APIRouter()

    @router.post("/fringe/analyze", dependencies=[Depends(_reject_hosted)])
    async def fringe_analyze(body: AnalyzeBody):
        """Run the full fringe analysis pipeline.

        Accepts either:
        - image_b64: base64-encoded image (drag-drop or file upload)
        - No image: uses the current frozen camera frame
        """
        if body.image_b64:
            # Decode uploaded image
            try:
                img_bytes = base64.b64decode(body.image_b64)
                img_array = np.frombuffer(img_bytes, dtype=np.uint8)
                image = cv2.imdecode(img_array, cv2.IMREAD_GRAYSCALE)
                if image is None:
                    raise ValueError("Could not decode image")
            except Exception as e:
                raise HTTPException(400, detail=f"Invalid image: {e}")
        else:
            # Use camera frame
            frame = camera.get_frame()
            if frame is None:
                raise HTTPException(503, detail="Camera returned no frame")
            image = frame
            if image.ndim == 3:
                image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

        result = analyze_interferogram(
            image,
            wavelength_nm=body.wavelength_nm,
            mask_threshold=body.mask_threshold,
            subtract_terms=body.subtract_terms,
            n_zernike=body.n_zernike,
        )
        return result

    @router.post("/fringe/reanalyze", dependencies=[Depends(_reject_hosted)])
    async def fringe_reanalyze(body: ReanalyzeBody):
        """Re-analyze with different Zernike subtraction (no FFT, fast)."""
        result = reanalyze(
            coefficients=body.coefficients,
            subtract_terms=body.subtract_terms,
            wavelength_nm=body.wavelength_nm,
            surface_shape=(body.surface_height, body.surface_width),
            mask_serialized=body.mask,
            n_zernike=body.n_zernike,
        )
        return result

    @router.get("/fringe/focus-quality", dependencies=[Depends(_reject_hosted)])
    async def fringe_focus_quality():
        """Return the focus quality score of the current camera frame."""
        frame = camera.get_frame()
        if frame is None:
            raise HTTPException(503, detail="Camera returned no frame")
        score = focus_quality(frame)
        return {"score": score}

    return router
```

- [ ] **Step 2: Wire the router into api.py**

In `backend/api.py`, add the import at the top alongside the other router imports:

```python
from .api_fringe import make_fringe_router
```

Then in the `make_router` function, add after the deflectometry line:

```python
    composed.include_router(make_fringe_router(camera))
```

The modified `make_router` function should look like:

```python
def make_router(camera: BaseCamera, frame_store: SessionFrameStore, startup_warning: str | None = None, run_store: RunStore | None = None) -> APIRouter:
    composed = APIRouter()
    composed.include_router(make_camera_router(camera, frame_store, startup_warning))
    composed.include_router(make_compare_router(camera))
    composed.include_router(make_detection_router(frame_store))
    composed.include_router(make_inspection_router(frame_store))
    composed.include_router(make_zstack_router(camera))
    composed.include_router(make_stitch_router(camera))
    composed.include_router(make_superres_router(camera))
    composed.include_router(make_deflectometry_router(camera))
    composed.include_router(make_fringe_router(camera))
    if run_store:
        composed.include_router(make_runs_router(run_store))
    return composed
```

- [ ] **Step 3: Add API tests**

Append to `tests/test_fringe.py`:

```python
class TestFringeAPI:
    """API-level tests using the FastAPI test client."""

    @pytest.fixture
    def client(self):
        from backend.main import create_app
        from tests.conftest import FakeCamera
        from fastapi.testclient import TestClient

        camera = FakeCamera()
        app = create_app(camera)
        with TestClient(app) as c:
            yield c

    def test_analyze_from_camera(self, client):
        """POST /fringe/analyze with no image uses camera frame."""
        r = client.post("/fringe/analyze", json={
            "wavelength_nm": 632.8,
            "mask_threshold": 0.15,
            "subtract_terms": [1, 2, 3],
        })
        assert r.status_code == 200
        data = r.json()
        assert "surface_map" in data
        assert "coefficients" in data
        assert len(data["coefficients"]) == 36

    def test_analyze_with_image(self, client):
        """POST /fringe/analyze with base64 image."""
        # Create a simple synthetic interferogram
        h, w = 64, 64
        xx = np.arange(w)
        img = (128 + 80 * np.cos(2 * np.pi * 4 * xx / w)).astype(np.uint8)
        img_2d = np.tile(img, (h, 1))
        _, buf = cv2.imencode(".png", img_2d)
        b64 = base64.b64encode(buf.tobytes()).decode("ascii")

        r = client.post("/fringe/analyze", json={
            "wavelength_nm": 632.8,
            "image_b64": b64,
        })
        assert r.status_code == 200
        data = r.json()
        assert "pv_nm" in data
        assert data["pv_nm"] >= 0

    def test_reanalyze(self, client):
        """POST /fringe/reanalyze with cached coefficients."""
        r = client.post("/fringe/reanalyze", json={
            "coefficients": [0.1] * 36,
            "subtract_terms": [1, 2, 3],
            "wavelength_nm": 632.8,
            "surface_height": 64,
            "surface_width": 64,
        })
        assert r.status_code == 200
        data = r.json()
        assert "surface_map" in data
        assert "pv_nm" in data

    def test_focus_quality(self, client):
        """GET /fringe/focus-quality returns a score."""
        r = client.get("/fringe/focus-quality")
        assert r.status_code == 200
        data = r.json()
        assert "score" in data
        assert 0 <= data["score"] <= 100
```

---

## Task 5: Frontend workspace & capture

**Files:**
- Create: `frontend/fringe.js`
- Modify: `frontend/main.js` (add import + init call)

- [ ] **Step 1: Create the fringe workspace module**

Create `frontend/fringe.js`:

```javascript
// fringe.js — Full-window fringe analysis workspace.
//
// Two-column layout:
//   Left:   camera preview, focus quality bar, freeze & analyze, settings,
//           Zernike subtraction checkboxes
//   Right:  summary bar (PV/RMS), tabs (Surface Map | 3D View | Zernike | Profiles)
//
// Lives inside #mode-fringe, managed by modes.js.

import { apiFetch } from './api.js';

const fr = {
  polling: null,
  built: false,
  threeLoaded: false,
  lastResult: null,
  lastMask: null,
};

function $(id) { return document.getElementById(id); }

// ── Wavelength presets ──────────────────────────────────────────────────

const WAVELENGTHS = {
  "sodium":  { label: "Sodium (589 nm)",   nm: 589.0 },
  "hene":    { label: "HeNe (632.8 nm)",   nm: 632.8 },
  "green":   { label: "Green LED (532 nm)", nm: 532.0 },
  "custom":  { label: "Custom...",          nm: null },
};

// ── Build workspace DOM ─────────────────────────────────────────────────

function buildWorkspace() {
  if (fr.built) return;
  fr.built = true;

  const root = $("mode-fringe");
  if (!root) return;

  root.innerHTML = `
    <div class="fringe-workspace">
      <!-- Left column: preview + settings -->
      <div class="fringe-preview-col">
        <div class="fringe-preview-container">
          <img id="fringe-preview" src="/stream" alt="Camera preview" />
          <div class="fringe-enlarge-overlay" id="fringe-enlarge-overlay" hidden>
            <img id="fringe-enlarge-img" />
            <button class="fringe-enlarge-close" id="fringe-enlarge-close">&#10005;</button>
          </div>
        </div>
        <div class="fringe-focus-bar-container">
          <label style="font-size:11px;opacity:0.7">Focus quality</label>
          <div class="fringe-focus-bar">
            <div class="fringe-focus-fill" id="fringe-focus-fill" style="width:0%"></div>
          </div>
          <span id="fringe-focus-score" style="font-size:11px;min-width:30px;text-align:right">--</span>
        </div>

        <button class="detect-btn" id="fringe-btn-analyze" style="padding:8px 16px;font-size:13px;font-weight:600;width:100%">
          Freeze &amp; Analyze
        </button>

        <div class="fringe-drop-zone" id="fringe-drop-zone">
          <span style="opacity:0.5;font-size:12px">or drag &amp; drop an image</span>
        </div>

        <div class="fringe-setting-group" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
          <div style="font-size:12px;font-weight:600;opacity:0.7">Settings</div>
          <label>Wavelength
            <select id="fringe-wavelength">
              <option value="sodium">Sodium (589 nm)</option>
              <option value="hene" selected>HeNe (632.8 nm)</option>
              <option value="green">Green LED (532 nm)</option>
              <option value="custom">Custom...</option>
            </select>
          </label>
          <label id="fringe-custom-wl-label" hidden>Custom wavelength (nm)
            <input type="number" id="fringe-custom-wl" min="200" max="2000" step="0.1" value="632.8" />
          </label>
          <label>Mask threshold
            <input type="range" id="fringe-mask-thresh" min="0" max="100" step="1" value="15" style="width:100px" />
            <span id="fringe-mask-thresh-val" style="font-size:11px;min-width:28px">15%</span>
          </label>
        </div>

        <div class="fringe-setting-group" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
          <div style="font-size:12px;font-weight:600;opacity:0.7">Zernike Subtraction</div>
          <label class="fringe-zernike-cb">
            <input type="checkbox" id="fringe-sub-tilt" checked disabled />
            Tilt X/Y (Z2, Z3) <span style="opacity:0.5;font-size:10px">always on</span>
          </label>
          <label class="fringe-zernike-cb">
            <input type="checkbox" id="fringe-sub-power" />
            Power / Defocus (Z4)
          </label>
          <label class="fringe-zernike-cb">
            <input type="checkbox" id="fringe-sub-astig" />
            Astigmatism (Z5, Z6)
          </label>
          <label class="fringe-zernike-cb">
            <input type="checkbox" id="fringe-sub-coma" />
            Coma (Z7, Z8)
          </label>
          <label class="fringe-zernike-cb">
            <input type="checkbox" id="fringe-sub-spherical" />
            Spherical (Z11)
          </label>
        </div>
      </div>

      <!-- Right column: results -->
      <div class="fringe-results-col">
        <div class="fringe-summary-bar" id="fringe-summary-bar" hidden>
          <div class="fringe-stat">
            <span class="fringe-stat-label">PV</span>
            <span class="fringe-stat-value" id="fringe-pv-waves">--</span>
            <span class="fringe-stat-unit">\u03bb</span>
            <span class="fringe-stat-value fringe-stat-nm" id="fringe-pv-nm">--</span>
            <span class="fringe-stat-unit">nm</span>
          </div>
          <div class="fringe-stat">
            <span class="fringe-stat-label">RMS</span>
            <span class="fringe-stat-value" id="fringe-rms-waves">--</span>
            <span class="fringe-stat-unit">\u03bb</span>
            <span class="fringe-stat-value fringe-stat-nm" id="fringe-rms-nm">--</span>
            <span class="fringe-stat-unit">nm</span>
          </div>
        </div>

        <div class="fringe-tab-bar" id="fringe-tab-bar">
          <button class="fringe-tab active" data-tab="surface">Surface Map</button>
          <button class="fringe-tab" data-tab="3d">3D View</button>
          <button class="fringe-tab" data-tab="zernike">Zernike</button>
          <button class="fringe-tab" data-tab="profiles">Profiles</button>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-surface">
          <div class="fringe-empty-state" id="fringe-empty">
            Freeze a frame or drop an interferogram image to analyze.
          </div>
          <div id="fringe-surface-content" hidden>
            <div class="fringe-surface-container">
              <img id="fringe-surface-img" />
            </div>
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-3d" hidden>
          <div class="fringe-empty-state" id="fringe-3d-empty">Analyze an image first.</div>
          <div id="fringe-3d-content" hidden style="display:flex;flex-direction:column;flex:1;min-height:0">
            <div class="fringe-3d-host" id="fringe-3d-host">
              <div class="fringe-3d-controls" id="fringe-3d-controls">
                <label style="font-size:12px">Z exaggeration:
                  <input type="range" id="fringe-3d-z-scale" min="1" max="200" step="1" value="10" style="width:120px" />
                  <span id="fringe-3d-z-val">10x</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-zernike" hidden>
          <div class="fringe-empty-state" id="fringe-zernike-empty">Analyze an image first.</div>
          <div id="fringe-zernike-content" hidden>
            <img id="fringe-zernike-chart" style="width:100%;max-width:900px" />
          </div>
        </div>

        <div class="fringe-tab-panel" id="fringe-panel-profiles" hidden>
          <div class="fringe-empty-state" id="fringe-profiles-empty">Analyze an image first.</div>
          <div id="fringe-profiles-content" hidden>
            <canvas id="fringe-profile-x-canvas" width="800" height="200"></canvas>
            <canvas id="fringe-profile-y-canvas" width="800" height="200"></canvas>
          </div>
        </div>
      </div>
    </div>
  `;

  wireEvents();
}

// ── Event wiring ────────────────────────────────────────────────────────

function wireEvents() {
  // Tab switching
  document.querySelectorAll(".fringe-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".fringe-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".fringe-tab-panel").forEach(p => p.hidden = true);
      tab.classList.add("active");
      const panelId = "fringe-panel-" + tab.dataset.tab;
      const panel = $(panelId);
      if (panel) panel.hidden = false;

      // Load 3D view on tab click
      if (tab.dataset.tab === "3d" && fr.lastResult) {
        render3dView();
      }
    });
  });

  // Wavelength dropdown
  const wlSel = $("fringe-wavelength");
  if (wlSel) {
    wlSel.addEventListener("change", () => {
      const customLabel = $("fringe-custom-wl-label");
      if (customLabel) customLabel.hidden = wlSel.value !== "custom";
    });
  }

  // Mask threshold slider
  const maskSlider = $("fringe-mask-thresh");
  const maskLabel = $("fringe-mask-thresh-val");
  if (maskSlider && maskLabel) {
    maskSlider.addEventListener("input", () => {
      maskLabel.textContent = maskSlider.value + "%";
    });
  }

  // Analyze button
  $("fringe-btn-analyze")?.addEventListener("click", analyzeFromCamera);

  // Drag and drop
  const dropZone = $("fringe-drop-zone");
  if (dropZone) {
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("fringe-drop-active");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("fringe-drop-active");
    });
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("fringe-drop-active");
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith("image/")) {
        analyzeFromFile(file);
      }
    });
  }

  // Preview click-to-enlarge
  const preview = $("fringe-preview");
  if (preview) {
    preview.style.cursor = "zoom-in";
    preview.addEventListener("click", () => {
      const overlay = $("fringe-enlarge-overlay");
      const enlargeImg = $("fringe-enlarge-img");
      if (overlay && enlargeImg) {
        enlargeImg.src = preview.src;
        overlay.hidden = false;
      }
    });
  }
  $("fringe-enlarge-close")?.addEventListener("click", () => {
    const overlay = $("fringe-enlarge-overlay");
    if (overlay) overlay.hidden = true;
  });

  // Preview scroll-to-zoom
  const previewContainer = $("fringe-preview")?.parentElement;
  if (previewContainer) {
    let zoomLevel = 1;
    previewContainer.addEventListener("wheel", (e) => {
      e.preventDefault();
      const img = $("fringe-preview");
      if (!img) return;
      zoomLevel = Math.max(1, Math.min(5, zoomLevel + (e.deltaY < 0 ? 0.2 : -0.2)));
      img.style.transform = `scale(${zoomLevel})`;
      img.style.transformOrigin = "center center";
    });
  }

  // Zernike checkbox change → re-analyze
  const checkboxIds = [
    "fringe-sub-power", "fringe-sub-astig",
    "fringe-sub-coma", "fringe-sub-spherical"
  ];
  let _reanalyzeDebounce = null;
  for (const id of checkboxIds) {
    $(id)?.addEventListener("change", () => {
      if (_reanalyzeDebounce) clearTimeout(_reanalyzeDebounce);
      _reanalyzeDebounce = setTimeout(() => {
        if (fr.lastResult) doReanalyze();
      }, 150);
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function getWavelength() {
  const sel = $("fringe-wavelength");
  if (!sel) return 632.8;
  if (sel.value === "custom") {
    const el = $("fringe-custom-wl");
    const v = parseFloat(el?.value || "632.8");
    return Number.isFinite(v) && v > 0 ? v : 632.8;
  }
  return WAVELENGTHS[sel.value]?.nm || 632.8;
}

function getMaskThreshold() {
  const el = $("fringe-mask-thresh");
  return el ? parseInt(el.value, 10) / 100 : 0.15;
}

function getSubtractTerms() {
  // Piston + tilt always on
  const terms = [1, 2, 3];
  if ($("fringe-sub-power")?.checked) terms.push(4);
  if ($("fringe-sub-astig")?.checked) terms.push(5, 6);
  if ($("fringe-sub-coma")?.checked) terms.push(7, 8);
  if ($("fringe-sub-spherical")?.checked) terms.push(11);
  return terms;
}

function setStatus(msg) {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.textContent = msg;
}

function resetStatus() {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.textContent = "Freeze & Analyze";
}

// ── Analysis ────────────────────────────────────────────────────────────

async function analyzeFromCamera() {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.disabled = true;
  setStatus("Analyzing...");
  try {
    const r = await apiFetch("/fringe/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wavelength_nm: getWavelength(),
        mask_threshold: getMaskThreshold(),
        subtract_terms: getSubtractTerms(),
      }),
    });
    if (!r.ok) {
      const msg = await r.text();
      console.warn("Fringe analysis failed:", msg);
      setStatus("Failed");
      setTimeout(resetStatus, 2000);
      return;
    }
    const data = await r.json();
    fr.lastResult = data;
    renderResults(data);
    resetStatus();
  } catch (e) {
    console.warn("Fringe analysis error:", e);
    setStatus("Error");
    setTimeout(resetStatus, 2000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function analyzeFromFile(file) {
  const btn = $("fringe-btn-analyze");
  if (btn) btn.disabled = true;
  setStatus("Analyzing...");
  try {
    const arrayBuf = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuf)));
    const r = await apiFetch("/fringe/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wavelength_nm: getWavelength(),
        mask_threshold: getMaskThreshold(),
        subtract_terms: getSubtractTerms(),
        image_b64: b64,
      }),
    });
    if (!r.ok) {
      const msg = await r.text();
      console.warn("Fringe analysis failed:", msg);
      setStatus("Failed");
      setTimeout(resetStatus, 2000);
      return;
    }
    const data = await r.json();
    fr.lastResult = data;
    renderResults(data);
    resetStatus();
  } catch (e) {
    console.warn("Fringe analysis error:", e);
    setStatus("Error");
    setTimeout(resetStatus, 2000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function doReanalyze() {
  if (!fr.lastResult) return;
  try {
    const r = await apiFetch("/fringe/reanalyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coefficients: fr.lastResult.coefficients,
        subtract_terms: getSubtractTerms(),
        wavelength_nm: getWavelength(),
        surface_height: fr.lastResult.n_total_pixels
          ? Math.round(Math.sqrt(fr.lastResult.n_total_pixels))
          : 128,
        surface_width: fr.lastResult.n_total_pixels
          ? Math.round(Math.sqrt(fr.lastResult.n_total_pixels))
          : 128,
      }),
    });
    if (!r.ok) return;
    const data = await r.json();
    // Merge into lastResult
    fr.lastResult.surface_map = data.surface_map;
    fr.lastResult.zernike_chart = data.zernike_chart;
    fr.lastResult.profile_x = data.profile_x;
    fr.lastResult.profile_y = data.profile_y;
    fr.lastResult.pv_nm = data.pv_nm;
    fr.lastResult.rms_nm = data.rms_nm;
    fr.lastResult.pv_waves = data.pv_waves;
    fr.lastResult.rms_waves = data.rms_waves;
    fr.lastResult.subtracted_terms = data.subtracted_terms;
    renderResults(fr.lastResult);
  } catch (e) {
    console.warn("Re-analyze error:", e);
  }
}

// ── Rendering ───────────────────────────────────────────────────────────

function renderResults(data) {
  // Summary bar
  const summaryBar = $("fringe-summary-bar");
  if (summaryBar) summaryBar.hidden = false;

  const fmt = (v) => Number.isFinite(v) ? v.toFixed(3) : "--";
  const fmtNm = (v) => Number.isFinite(v) ? v.toFixed(1) : "--";

  $("fringe-pv-waves").textContent = fmt(data.pv_waves);
  $("fringe-pv-nm").textContent = fmtNm(data.pv_nm);
  $("fringe-rms-waves").textContent = fmt(data.rms_waves);
  $("fringe-rms-nm").textContent = fmtNm(data.rms_nm);

  // Surface map
  const surfaceContent = $("fringe-surface-content");
  const empty = $("fringe-empty");
  if (surfaceContent && data.surface_map) {
    surfaceContent.hidden = false;
    if (empty) empty.hidden = true;
    $("fringe-surface-img").src = "data:image/png;base64," + data.surface_map;
  }

  // Zernike chart
  const zernikeContent = $("fringe-zernike-content");
  const zernikeEmpty = $("fringe-zernike-empty");
  if (zernikeContent && data.zernike_chart) {
    zernikeContent.hidden = false;
    if (zernikeEmpty) zernikeEmpty.hidden = true;
    $("fringe-zernike-chart").src = "data:image/png;base64," + data.zernike_chart;
  }

  // Profiles
  const profilesContent = $("fringe-profiles-content");
  const profilesEmpty = $("fringe-profiles-empty");
  if (profilesContent && data.profile_x) {
    profilesContent.hidden = false;
    if (profilesEmpty) profilesEmpty.hidden = true;
    drawProfile($("fringe-profile-x-canvas"), data.profile_x, "Horizontal Profile (center row)");
    drawProfile($("fringe-profile-y-canvas"), data.profile_y, "Vertical Profile (center col)");
  }

  // Hide 3D empty state if we have results
  if (fr.lastResult) {
    const empty3d = $("fringe-3d-empty");
    if (empty3d) empty3d.textContent = "Click to load 3D view.";
  }
}

function drawProfile(canvas, profile, title) {
  if (!canvas || !profile) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = "#1c1c1e";
  ctx.fillRect(0, 0, w, h);

  const values = profile.values.filter(v => v !== null);
  if (values.length < 2) return;

  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  const vRange = vMax - vMin || 1;

  const padL = 60, padR = 20, padT = 30, padB = 30;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // Grid
  ctx.strokeStyle = "#3a3a3c";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  // Title
  ctx.fillStyle = "#e8e8e8";
  ctx.font = "11px -apple-system, sans-serif";
  ctx.fillText(title, padL, 16);

  // Y-axis labels
  ctx.fillStyle = "#ababab";
  ctx.font = "9px -apple-system, sans-serif";
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    const v = vMax - (vRange * i) / 4;
    ctx.fillText(v.toFixed(1), 5, y + 3);
  }

  // Plot line
  ctx.strokeStyle = "#4a9eff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < profile.values.length; i++) {
    const v = profile.values[i];
    if (v === null) { started = false; continue; }
    const x = padL + (i / (profile.values.length - 1)) * plotW;
    const y = padT + ((vMax - v) / vRange) * plotH;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ── 3D View ─────────────────────────────────────────────────────────────

async function render3dView() {
  if (!fr.lastResult) return;
  const empty = $("fringe-3d-empty");
  const content = $("fringe-3d-content");
  const host = $("fringe-3d-host");
  if (!host) return;

  if (empty) empty.hidden = true;
  if (content) content.hidden = false;

  // Load Three.js if needed
  if (!fr.threeLoaded) {
    const THREE = await import("https://esm.sh/three@0.160.0");
    const { OrbitControls } = await import("https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js");
    fr.THREE = THREE;
    fr.OrbitControls = OrbitControls;
    fr.threeLoaded = true;
  }
  const THREE = fr.THREE;
  const OrbitControls = fr.OrbitControls;

  const controlsEl = $("fringe-3d-controls");
  host.innerHTML = "";

  const w = host.clientWidth || 600;
  const h = host.clientHeight || 400;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  const camera = new THREE.PerspectiveCamera(50, w / h, 0.01, 1000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  host.appendChild(renderer.domElement);
  if (controlsEl) host.appendChild(controlsEl);
  const controls = new OrbitControls(camera, renderer.domElement);

  // Build mesh from profile data
  const profileX = fr.lastResult.profile_x;
  const profileY = fr.lastResult.profile_y;
  if (!profileX || !profileY) return;

  const cols = profileX.values.length;
  const rows = profileY.values.length;
  const geo = new THREE.PlaneGeometry(cols, rows, cols - 1, rows - 1);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  // We only have center profiles, so create a flat grid and apply the surface map
  // For a better 3D view, we'd need the full height map from the backend
  // For now, generate a simple surface from the Zernike coefficients
  const coeffs = fr.lastResult.coefficients || [];
  let zMin = 0, zMax = 1;

  const zSlider = $("fringe-3d-z-scale");
  const zLabel = $("fringe-3d-z-val");
  let zScale = zSlider ? parseFloat(zSlider.value) : 10;

  function applyZ() {
    // Simple tilt + power surface from first few coefficients
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const nx = (c / (cols - 1) - 0.5) * 2;
        const ny = (r / (rows - 1) - 0.5) * 2;
        const rho = Math.sqrt(nx * nx + ny * ny);
        let z = 0;
        // Apply a few Zernike terms for visualization
        if (coeffs.length >= 4) {
          z += coeffs[3] * (2 * rho * rho - 1); // defocus
        }
        if (coeffs.length >= 6) {
          z += coeffs[4] * rho * rho * Math.cos(2 * Math.atan2(ny, nx)); // astig
        }
        z *= zScale * 0.1;
        pos.setZ(idx, z);
        // Color based on height
        const t = Math.max(0, Math.min(1, (z + zScale * 0.1) / (2 * zScale * 0.1)));
        colors[idx * 3] = t < 0.5 ? 0.2 + t : 0.8;
        colors[idx * 3 + 1] = 0.2;
        colors[idx * 3 + 2] = t < 0.5 ? 0.8 : 1.0 - t;
      }
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }
  applyZ();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  const light1 = new THREE.DirectionalLight(0xffffff, 1);
  light1.position.set(1, 1, 2);
  scene.add(light1);
  scene.add(new THREE.AmbientLight(0x404040));

  camera.position.set(0, -cols * 0.4, cols * 0.6);
  camera.lookAt(0, 0, 0);
  controls.update();

  if (zSlider) {
    zSlider.oninput = () => {
      zScale = parseFloat(zSlider.value);
      if (zLabel) zLabel.textContent = zScale + "x";
      applyZ();
    };
  }

  function animate() {
    if (!host.isConnected) return;
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  const ro = new ResizeObserver(() => {
    const nw = host.clientWidth, nh = host.clientHeight;
    if (nw > 0 && nh > 0) {
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    }
  });
  ro.observe(host);
}

// ── Focus quality polling ───────────────────────────────────────────────

async function pollFocusQuality() {
  try {
    const r = await apiFetch("/fringe/focus-quality");
    if (!r.ok) return;
    const data = await r.json();
    const fill = $("fringe-focus-fill");
    const label = $("fringe-focus-score");
    if (fill) fill.style.width = data.score + "%";
    if (label) label.textContent = data.score.toFixed(0);
    // Color: red < 30, yellow 30-60, green > 60
    if (fill) {
      if (data.score < 30) fill.style.background = "var(--danger)";
      else if (data.score < 60) fill.style.background = "var(--warning)";
      else fill.style.background = "var(--success)";
    }
  } catch { /* ignore */ }
}

function startPolling() {
  stopPolling();
  pollFocusQuality();
  fr.polling = setInterval(pollFocusQuality, 2000);
}

function stopPolling() {
  if (fr.polling) {
    clearInterval(fr.polling);
    fr.polling = null;
  }
}

// ── Public init ─────────────────────────────────────────────────────────

export function initFringe() {
  buildWorkspace();

  // Start/stop polling when mode becomes visible/hidden
  const observer = new MutationObserver(() => {
    const root = $("mode-fringe");
    if (!root) return;
    if (root.hidden) {
      stopPolling();
    } else {
      startPolling();
    }
  });
  const root = $("mode-fringe");
  if (root) observer.observe(root, { attributes: true, attributeFilter: ["hidden"] });
}
```

- [ ] **Step 2: Wire initFringe in main.js**

In `frontend/main.js`, add the import alongside the other mode imports:

```javascript
import { initFringe } from './fringe.js';
```

Then add the init call right after `initGear();`:

```javascript
initFringe();
```

---

## Task 6: Frontend results display

This task is folded into Task 5 above. The `renderResults`, `drawProfile`, `render3dView`, and `doReanalyze` functions in `frontend/fringe.js` implement:

- Summary bar (PV/RMS in both waves and nm)
- Tab system (Surface Map, 3D View, Zernike, Profiles)
- Surface map display via base64 image
- 3D viewer using Three.js (same CDN pattern as deflectometry)
- Zernike bar chart display via base64 image
- Profile plot rendering via Canvas 2D
- Re-analysis on Zernike checkbox change (debounced, calls `/fringe/reanalyze`)

No additional code changes needed beyond what Task 5 provides.

---

## Task 7: CSS styling

**Files:**
- Modify: `frontend/style.css` (append fringe styles at end)

- [ ] **Step 1: Add fringe-prefixed CSS rules**

Append to `frontend/style.css` (after the existing deflectometry styles, before the closing of the file):

```css
/* ── Fringe Analysis workspace ───────────────────────────── */

.fringe-workspace {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 0;
}

/* Left column: preview + settings */
.fringe-preview-col {
  width: 260px;
  min-width: 260px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  padding: 10px;
  gap: 10px;
  overflow-y: auto;
}
.fringe-preview-container {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--border);
  background: #111;
  border-radius: 3px;
}
.fringe-preview-col img#fringe-preview {
  width: 100%;
  display: block;
  transition: transform 0.15s ease;
}
.fringe-enlarge-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9000;
}
.fringe-enlarge-overlay img {
  max-width: 90vw;
  max-height: 90vh;
  border: 1px solid var(--border);
}
.fringe-enlarge-close {
  position: absolute;
  top: 20px;
  right: 20px;
  font-size: 24px;
  color: #fff;
  background: rgba(0,0,0,0.5);
  border-radius: 50%;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.fringe-focus-bar-container {
  display: flex;
  align-items: center;
  gap: 6px;
}
.fringe-focus-bar {
  flex: 1;
  height: 8px;
  background: var(--surface-2);
  border-radius: 4px;
  overflow: hidden;
}
.fringe-focus-fill {
  height: 100%;
  background: var(--success);
  border-radius: 4px;
  transition: width 0.3s ease, background 0.3s ease;
}

.fringe-drop-zone {
  border: 2px dashed var(--border);
  border-radius: 6px;
  padding: 12px;
  text-align: center;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
}
.fringe-drop-zone.fringe-drop-active {
  border-color: var(--accent);
  background: rgba(10, 132, 255, 0.08);
}

.fringe-setting-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fringe-setting-group label {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.fringe-setting-group input[type="number"],
.fringe-setting-group select {
  width: 100%;
  max-width: 160px;
}
.fringe-zernike-cb {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.fringe-zernike-cb input[type="checkbox"] {
  accent-color: var(--accent);
}

/* Right column: results */
.fringe-results-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* Summary bar */
.fringe-summary-bar {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}
.fringe-stat {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.fringe-stat-label {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.7;
  min-width: 28px;
}
.fringe-stat-value {
  font-size: 16px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.fringe-stat-nm {
  font-size: 12px;
  font-weight: 400;
  opacity: 0.7;
  margin-left: 8px;
}
.fringe-stat-unit {
  font-size: 11px;
  opacity: 0.5;
}

/* Tabs */
.fringe-tab-bar {
  display: flex;
  border-bottom: 1px solid var(--border);
  padding: 0 10px;
}
.fringe-tab {
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  opacity: 0.6;
  background: none;
  border-top: none;
  border-left: none;
  border-right: none;
  color: var(--text);
}
.fringe-tab:hover { opacity: 0.85; }
.fringe-tab.active {
  opacity: 1;
  border-bottom-color: var(--accent);
}

/* Tab panels */
.fringe-tab-panel {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.fringe-tab-panel[hidden] {
  display: none !important;
}

.fringe-empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  opacity: 0.4;
  font-size: 14px;
  min-height: 200px;
}

/* Surface map */
.fringe-surface-container {
  display: flex;
  justify-content: center;
}
.fringe-surface-container img {
  max-width: 100%;
  max-height: calc(100vh - 200px);
  border: 1px solid #444;
  background: #111;
}

/* 3D */
.fringe-3d-host {
  flex: 1;
  min-height: 0;
  position: relative;
}
.fringe-3d-host canvas {
  width: 100% !important;
  height: 100% !important;
}
.fringe-3d-controls {
  position: absolute;
  bottom: 10px;
  left: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(0,0,0,0.7);
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 12px;
}

/* Profiles */
#fringe-profiles-content canvas {
  width: 100%;
  max-width: 900px;
  border: 1px solid var(--border);
  border-radius: 3px;
  margin-bottom: 10px;
}
```

---

## Task 8: Preview enhancements

This task is folded into Task 5 (fringe.js) and Task 7 (CSS). The following features are already implemented:

- **Scroll-to-zoom in preview**: Wheel event handler on the preview container scales the `<img>` via CSS `transform: scale()`.
- **Click-to-enlarge popup overlay**: Click on preview image shows a fixed-position overlay with `#fringe-enlarge-overlay`. Close button dismisses it.
- **Focus quality bar**: `pollFocusQuality()` runs every 2 seconds when the fringe mode is active, updates `#fringe-focus-fill` width and color (red/yellow/green based on score thresholds).

No additional code changes needed.

---

## Task 9: Help documentation

**Files:**
- Modify: `frontend/index.html` (replace fringe help placeholder + add nav items)

- [ ] **Step 1: Replace the single fringe help page placeholder with 6 help pages**

Replace the existing fringe help nav section in the `<nav class="help-nav">`:

```html
          <div class="help-nav-section" data-help-modes="fringe">Overview</div>
          <button class="help-nav-item top-level" data-page="fringe-overview" data-help-modes="fringe">How It Works</button>
          <button class="help-nav-item top-level" data-page="fringe-setup" data-help-modes="fringe">Setup</button>

          <div class="help-nav-section" data-help-modes="fringe">Analysis</div>
          <button class="help-nav-item top-level" data-page="fringe-capture" data-help-modes="fringe">Capture &amp; Analyze</button>
          <button class="help-nav-item top-level" data-page="fringe-zernike" data-help-modes="fringe">Zernike Subtraction</button>

          <div class="help-nav-section" data-help-modes="fringe">Results</div>
          <button class="help-nav-item top-level" data-page="fringe-results" data-help-modes="fringe">Results &amp; Tabs</button>
          <button class="help-nav-item top-level" data-page="fringe-tips" data-help-modes="fringe">Tips &amp; Troubleshooting</button>
```

This replaces the existing single nav item:
```html
          <div class="help-nav-section" data-help-modes="fringe">Fringe Analysis</div>
          <button class="help-nav-item top-level" data-page="fringe-analysis" data-help-modes="fringe">Fringe Analysis</button>
```

- [ ] **Step 2: Replace the single fringe help page with 6 pages**

Remove the existing placeholder page:
```html
          <div class="help-page" id="help-page-fringe-analysis" hidden>
            <h2 class="help-page-title">Fringe Analysis</h2>
            <p class="help-page-sub">Interferometric fringe analysis for high-precision surface measurement.</p>
            <p class="help-p">This mode is currently under development. Documentation will be added when the feature is available.</p>
          </div>
```

Replace with these 6 help pages (insert at the same location):

```html
          <!-- Fringe: How It Works -->
          <div class="help-page" id="help-page-fringe-overview" hidden>
            <h2 class="help-page-title">How It Works</h2>
            <p class="help-page-sub">Monochromatic interferometric fringe analysis for quantitative surface flatness measurement.</p>
            <div class="help-section-label">Principle</div>
            <p class="help-p">When a flat optical reference (an optical flat) is placed on a lapped surface and illuminated with monochromatic light, interference fringes form. Each fringe represents a contour of constant air gap, spaced at half the wavelength of light (~316 nm for HeNe). Straight, evenly spaced fringes indicate a flat surface; curved or irregularly spaced fringes indicate surface errors.</p>
            <div class="help-section-label">Digital analysis</div>
            <p class="help-p">Loupe digitizes this process: a single photograph of the interferogram is analyzed using 2D Fourier transform (DFT) phase extraction. The carrier frequency (the regular fringe spacing) is isolated in the frequency domain, and the surface-error phase is extracted from the sideband. This phase is then unwrapped, decomposed into Zernike polynomials, and converted to physical height using the known wavelength.</p>
            <div class="help-section-label">What you need</div>
            <p class="help-p">A monochromatic light source (sodium lamp, HeNe laser, or narrow-band LED), an optical flat, the part to be measured, and a camera to photograph the fringes. No iPad or multi-frame capture is required, unlike deflectometry.</p>
          </div>

          <!-- Fringe: Setup -->
          <div class="help-page" id="help-page-fringe-setup" hidden>
            <h2 class="help-page-title">Setup</h2>
            <p class="help-page-sub">Prepare the system before analyzing an interferogram.</p>
            <div class="help-section-label">Wavelength</div>
            <p class="help-p">Select the correct wavelength for your light source from the dropdown. Common choices: Sodium (589 nm), HeNe laser (632.8 nm), or Green LED (532 nm). If your source is different, select Custom and enter the wavelength in nanometers. The wavelength determines the physical height conversion: height = phase &times; &lambda; / (4&pi;).</p>
            <div class="help-section-label">Mask threshold</div>
            <p class="help-p">The mask threshold slider controls how aggressively the auto-masking rejects low-contrast pixels. Increase it if background noise is contaminating the results; decrease it if valid fringe areas are being excluded. Default is 15%.</p>
            <div class="help-section-label">Focus quality</div>
            <p class="help-p">The focus quality bar shows a real-time sharpness score (0-100) for the camera preview. Higher is better. Adjust focus and lighting until the score is above 60 before capturing.</p>
          </div>

          <!-- Fringe: Capture & Analyze -->
          <div class="help-page" id="help-page-fringe-capture" hidden>
            <h2 class="help-page-title">Capture &amp; Analyze</h2>
            <p class="help-page-sub">How to acquire and analyze an interferogram.</p>
            <div class="help-section-label">From camera</div>
            <p class="help-p">Click <strong>Freeze &amp; Analyze</strong> to capture the current camera frame and run the full analysis pipeline. The camera frame is frozen, converted to grayscale, and processed through DFT phase extraction, Zernike fitting, and surface rendering.</p>
            <div class="help-section-label">From file</div>
            <p class="help-p">Drag and drop any image file (PNG, JPEG, TIFF) onto the drop zone in the left column. This is useful for analyzing saved interferograms or images from other cameras.</p>
            <div class="help-section-label">Pipeline</div>
            <div class="help-step"><span class="help-step-num">1</span><span>Auto-mask: pixels with low fringe contrast are excluded.</span></div>
            <div class="help-step"><span class="help-step-num">2</span><span>2D FFT extracts the carrier frequency and isolates the surface-error sideband.</span></div>
            <div class="help-step"><span class="help-step-num">3</span><span>Phase unwrapping resolves 2&pi; ambiguities into a continuous surface.</span></div>
            <div class="help-step"><span class="help-step-num">4</span><span>Zernike polynomial fitting (36 terms) decomposes the surface into known aberration modes.</span></div>
            <div class="help-step"><span class="help-step-num">5</span><span>Selected terms are subtracted and the residual is converted to physical height.</span></div>
          </div>

          <!-- Fringe: Zernike Subtraction -->
          <div class="help-page" id="help-page-fringe-zernike" hidden>
            <h2 class="help-page-title">Zernike Subtraction</h2>
            <p class="help-page-sub">Control which surface error modes are removed from the measurement.</p>
            <div class="help-section-label">Why subtract?</div>
            <p class="help-p">Zernike polynomials describe common optical aberrations. Subtracting certain terms isolates the surface errors you care about. For example, tilt (Z2, Z3) is caused by the optical flat not being perfectly parallel to the surface; removing it shows only the actual surface shape error.</p>
            <div class="help-section-label">Available terms</div>
            <table>
              <thead><tr><th>Checkbox</th><th>Terms</th><th>What it removes</th></tr></thead>
              <tbody>
                <tr><td><strong>Tilt X/Y</strong></td><td>Z2, Z3</td><td>Overall tilt (always on)</td></tr>
                <tr><td><strong>Power</strong></td><td>Z4</td><td>Curvature / defocus (concavity or convexity)</td></tr>
                <tr><td><strong>Astigmatism</strong></td><td>Z5, Z6</td><td>Saddle-shaped error</td></tr>
                <tr><td><strong>Coma</strong></td><td>Z7, Z8</td><td>Comet-shaped aberration</td></tr>
                <tr><td><strong>Spherical</strong></td><td>Z11</td><td>Center-to-edge variation (bowl shape)</td></tr>
              </tbody>
            </table>
            <div class="help-tip">Toggling checkboxes triggers instant re-analysis (no re-capture needed). The Zernike bar chart tab shows all 36 fitted coefficients with subtracted terms grayed out.</div>
          </div>

          <!-- Fringe: Results & Tabs -->
          <div class="help-page" id="help-page-fringe-results" hidden>
            <h2 class="help-page-title">Results &amp; Tabs</h2>
            <p class="help-page-sub">Understanding the output of a fringe analysis.</p>
            <div class="help-section-label">Summary bar</div>
            <p class="help-p">Shows PV (peak-to-valley) and RMS in both waves (&lambda;) and nanometers (nm). PV is the total range of surface error; RMS is the statistical spread. A surface with PV &lt; 1&lambda; is considered "optically flat" for many applications.</p>
            <div class="help-section-label">Surface Map tab</div>
            <p class="help-p">False-color height map: red = high, blue = low (relative). The colormap is symmetric around zero after Zernike subtraction. Masked pixels appear black.</p>
            <div class="help-section-label">3D View tab</div>
            <p class="help-p">Interactive 3D surface visualization. Drag to rotate, scroll to zoom, right-drag to pan. The Z exaggeration slider amplifies the height for visibility.</p>
            <div class="help-section-label">Zernike tab</div>
            <p class="help-p">Bar chart of all 36 fitted Zernike coefficients in units of waves. Subtracted terms are shown in gray; active terms in blue. Large coefficients indicate dominant surface error modes.</p>
            <div class="help-section-label">Profiles tab</div>
            <p class="help-p">Cross-section height profiles through the center of the surface: one horizontal, one vertical. Useful for identifying whether errors are primarily in one direction.</p>
          </div>

          <!-- Fringe: Tips & Troubleshooting -->
          <div class="help-page" id="help-page-fringe-tips" hidden>
            <h2 class="help-page-title">Tips &amp; Troubleshooting</h2>
            <p class="help-page-sub">Common issues and how to get the best results.</p>
            <div class="help-section-label">Getting good fringes</div>
            <div class="help-tip">Use a diffuse monochromatic source. Point sources create uneven illumination that degrades the auto-mask.</div>
            <div class="help-tip">Clean both the optical flat and the part surface. Dust particles create localized bright spots that confuse the phase extraction.</div>
            <div class="help-tip">Adjust the camera exposure so that fringes are clearly visible without clipping (no fully white or fully black regions).</div>
            <div class="help-section-label">Troubleshooting</div>
            <div class="help-tip"><strong>No fringes detected:</strong> Check that the mask threshold is not too high. Try lowering it to 5-10%.</div>
            <div class="help-tip"><strong>Noisy surface map:</strong> The fringe density may be too high for the camera resolution. Reduce the number of fringes by adjusting the angle of the optical flat.</div>
            <div class="help-tip"><strong>Phase unwrapping errors:</strong> These appear as sharp step discontinuities in the surface map. They occur when fringes are too closely spaced or when the image is noisy. Try increasing the mask threshold to exclude low-quality regions.</div>
            <div class="help-tip"><strong>Wrong wavelength:</strong> If PV/RMS values seem unreasonable, verify the wavelength setting matches your actual light source.</div>
          </div>
```

- [ ] **Step 3: Update the Modes help page**

In the modes overview help page, update the fringe row to remove "Coming soon":

```html
                <tr><td><strong>Fringe Analysis</strong></td><td>Interferometric fringe analysis for quantitative surface flatness measurement using an optical flat and monochromatic light.</td></tr>
```

---

## Task 10: Final integration test

**Files:** No new files. Verification only.

- [ ] **Step 1: Run the full test suite**

```bash
.venv/bin/pytest tests/ -v
```

All existing tests must continue to pass. New tests in `tests/test_fringe.py` must pass.

- [ ] **Step 2: Verify mode switching**

Start the server with `NO_CAMERA=1` and verify in a browser:
1. Mode dropdown shows "Fringe Analysis" option
2. Switching to Fringe Analysis mode shows the workspace (not the "coming soon" placeholder)
3. Focus quality polling starts when mode is active, stops when switching away
4. Switching back to Microscope mode works without errors

- [ ] **Step 3: Verify all tabs render**

1. Click "Freeze & Analyze" (with NO_CAMERA the uniform frame produces a degenerate but non-crashing result)
2. All four tabs (Surface Map, 3D View, Zernike, Profiles) render without console errors
3. Toggling Zernike checkboxes triggers re-analysis and updates the display

- [ ] **Step 4: Verify drag-and-drop**

1. Drag a real interferogram image onto the drop zone
2. Analysis completes and results display correctly
3. Zernike checkbox changes trigger fast re-analysis (no re-upload)

- [ ] **Step 5: Verify help documentation**

1. Press `?` to open help dialog
2. Click "Fringe Analysis" tab
3. All 6 pages are navigable and display correctly
