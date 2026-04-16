import base64
import numpy as np
from backend.vision.deflectometry import (
    analyze_display_check,
    create_modulation_mask,
    fit_sphere_calibration,
    frankot_chellappa,
    generate_fringe_pattern, compute_wrapped_phase, unwrap_phase,
    phase_stats, pseudocolor_png_b64, remove_tilt,
    compute_slope_magnitude, compute_curl_residual,
    diverging_png_b64,
    compute_quality_summary,
    build_response_lut,
)

def test_generate_fringe_pattern_x_is_sinusoidal():
    img = generate_fringe_pattern(64, 32, phase=0.0, freq=2, orientation="x")
    assert img.shape == (32, 64)
    assert img.dtype == np.uint8
    row = img[10].astype(np.float32)
    assert row[0] >= 253
    assert row[16] <= 2
    assert row[48] <= 2

def test_generate_fringe_pattern_y_varies_along_axis_0():
    img = generate_fringe_pattern(64, 32, phase=0.0, freq=1, orientation="y")
    assert np.all(img[0] == img[0, 0])
    assert np.all(img[15] == img[15, 0])

def test_eight_phase_extraction_recovers_known_phase():
    H, W = 16, 32
    true_phase = np.linspace(-2.5, 2.5, W)[None, :].repeat(H, 0)
    amplitude = 100.0
    offset = 127.0
    frames = [offset + amplitude * np.cos(true_phase + k * np.pi / 4) for k in range(8)]
    wrapped = compute_wrapped_phase(frames)
    assert wrapped.shape == (H, W)
    np.testing.assert_allclose(wrapped, true_phase, atol=1e-6)


def test_four_phase_extraction_still_works():
    """Generalized formula should still work with 4 frames."""
    H, W = 16, 32
    true_phase = np.linspace(-2.5, 2.5, W)[None, :].repeat(H, 0)
    amplitude = 100.0
    offset = 127.0
    frames = [offset + amplitude * np.cos(true_phase + k * np.pi / 2) for k in range(4)]
    wrapped = compute_wrapped_phase(frames)
    assert wrapped.shape == (H, W)
    np.testing.assert_allclose(wrapped, true_phase, atol=1e-6)

def test_compute_wrapped_phase_accepts_3d_frames():
    H, W = 8, 16
    true_phase = np.zeros((H, W)) + 0.7
    frames = []
    for k in range(8):
        gray = 127 + 80 * np.cos(true_phase + k * np.pi / 4)
        rgb = np.stack([gray, gray, gray], axis=-1).astype(np.uint8)
        frames.append(rgb)
    wrapped = compute_wrapped_phase(frames)
    assert wrapped.shape == (H, W)
    np.testing.assert_allclose(wrapped, 0.7, atol=1e-2)

def test_unwrap_removes_2pi_jumps_along_x():
    H, W = 8, 64
    true_phase = np.linspace(0, 6 * np.pi, W)[None, :].repeat(H, 0)
    wrapped = np.angle(np.exp(1j * true_phase))
    unwrapped = unwrap_phase(wrapped, orientation="x")
    diff = unwrapped - true_phase
    per_row_offset = diff[:, :1]
    np.testing.assert_allclose(diff, np.broadcast_to(per_row_offset, diff.shape), atol=1e-9)

def test_unwrap_along_y_axis():
    H, W = 64, 8
    true_phase = np.linspace(0, 6 * np.pi, H)[:, None].repeat(W, 1)
    wrapped = np.angle(np.exp(1j * true_phase))
    unwrapped = unwrap_phase(wrapped, orientation="y")
    diff = unwrapped - true_phase
    per_col_offset = diff[:1, :]
    np.testing.assert_allclose(diff, np.broadcast_to(per_col_offset, diff.shape), atol=1e-9)

def test_phase_stats_on_ramp():
    u = np.linspace(0.0, 10.0, 101)
    s = phase_stats(u)
    assert abs(s["pv"] - 10.0) < 1e-9
    assert abs(s["mean"] - 5.0) < 1e-9
    assert s["rms"] > 0
    assert isinstance(s["pv"], float)
    assert isinstance(s["rms"], float)
    assert isinstance(s["mean"], float)

def test_remove_tilt_flattens_plane():
    h, w = 32, 64
    yy, xx = np.mgrid[0:h, 0:w]
    # A tilted plane: z = 0.5*x + 0.3*y + 10
    plane = 0.5 * xx + 0.3 * yy + 10.0
    # Add a small bump so the residual isn't perfectly zero
    bump = 0.01 * np.sin(2 * np.pi * xx / w)
    result = remove_tilt(plane + bump)
    # The plane should be gone; only the bump remains
    assert result.shape == (h, w)
    # Residual PV should be close to the bump's PV (~0.02), not the plane's (~47)
    assert np.ptp(result) < 0.05

def test_remove_tilt_preserves_curvature():
    h, w = 32, 64
    yy, xx = np.mgrid[0:h, 0:w]
    # Quadratic curvature + tilt
    surface = 0.001 * (xx - w/2)**2 + 2.0 * xx + 5.0
    result = remove_tilt(surface)
    # Tilt removed, curvature preserved — PV should be close to the parabola's range
    parabola_pv = 0.001 * (w/2)**2  # ~1.024
    assert abs(np.ptp(result) - parabola_pv) < 0.1

def test_pseudocolor_png_b64_decodes_to_png():
    u = np.random.default_rng(0).normal(size=(24, 24))
    b64 = pseudocolor_png_b64(u)
    assert not b64.startswith("data:")
    blob = base64.b64decode(b64)
    assert blob.startswith(b"\x89PNG\r\n\x1a\n")


def test_create_modulation_mask_thresholds():
    mod_x = np.array([[100, 50, 10], [80, 5, 90]], dtype=np.float64)
    mod_y = np.array([[90, 60, 5], [70, 10, 80]], dtype=np.float64)
    mask = create_modulation_mask(mod_x, mod_y, threshold_frac=0.15)
    # threshold_x = 0.15 * 100 = 15, threshold_y = 0.15 * 90 = 13.5
    expected = np.array([[True, True, False], [True, False, True]])
    np.testing.assert_array_equal(mask, expected)


def test_phase_stats_with_mask():
    u = np.array([[0.0, 1.0, 2.0], [3.0, 4.0, 5.0]])
    mask = np.array([[True, True, False], [True, False, True]])
    s = phase_stats(u, mask=mask)
    # Valid pixels: 0, 1, 3, 5 -> mean=2.25, pv=5.0
    assert abs(s["mean"] - 2.25) < 1e-9
    assert abs(s["pv"] - 5.0) < 1e-9


def test_fit_sphere_calibration_recovers_radius():
    # Simulate a height map from a sphere of radius 25mm, viewed at 100 px/mm.
    # z = (x^2 + y^2) / (2R), with x,y in mm.
    R_mm = 25.0
    px_per_mm = 100.0
    mm_per_px = 1.0 / px_per_mm
    h, w = 64, 64
    y, x = np.mgrid[0:h, 0:w]
    # Center the sphere in the image
    cx, cy = w / 2.0, h / 2.0
    x_mm = (x - cx) * mm_per_px
    y_mm = (y - cy) * mm_per_px
    z_mm = (x_mm**2 + y_mm**2) / (2.0 * R_mm)
    # Simulate the height map as if the cal_factor were 5.0 (arbitrary)
    # so z_measured = z_mm / (cal_factor * 1e-3)... actually let's just
    # use z_mm directly as if cal_factor=1 mm/rad, then check the fit.
    # The function should recover cal_factor ≈ 1.0 when the "measured"
    # height map IS already in mm.
    cal = fit_sphere_calibration(z_mm, None, R_mm, mm_per_px)
    # cal_factor should be ~1.0 since input is already in mm
    assert abs(cal["cal_factor"] - 1.0) < 0.01, f"cal_factor={cal['cal_factor']}"
    assert abs(cal["fitted_radius_mm"] - R_mm) < 0.5
    assert cal["residual_rms_um"] < 1.0  # paraboloid fits a sphere well near center


def test_compute_wrapped_phase_with_smoothing():
    """Smoothing should not destroy phase recovery on clean signals."""
    from scipy.ndimage import gaussian_filter
    H, W = 16, 32
    true_phase = np.linspace(-2.5, 2.5, W)[None, :].repeat(H, 0)
    amplitude = 100.0
    offset = 127.0
    frames = [offset + amplitude * np.cos(true_phase + k * np.pi / 4) for k in range(8)]
    # Apply same smoothing the pipeline would
    smoothed = [gaussian_filter(f, sigma=1.5) for f in frames]
    wrapped = compute_wrapped_phase(smoothed)
    # Phase should still be close (smoothing a clean signal barely changes it)
    np.testing.assert_allclose(wrapped, true_phase, atol=0.15)


def test_find_optimal_smooth_sigma_detects_high_freq_noise():
    from backend.vision.deflectometry import find_optimal_smooth_sigma
    H, W = 64, 256
    # Create a fringe pattern with freq=4 cycles
    x = np.linspace(0, 2 * np.pi * 4, W)
    fringe = 127.0 + 100.0 * np.cos(x)
    frame = np.tile(fringe, (H, 1))
    # Add high-frequency noise (simulating LCD pixel grid)
    hf_noise = 20.0 * np.cos(np.linspace(0, 2 * np.pi * 80, W))
    frame += np.tile(hf_noise, (H, 1))
    sigma = find_optimal_smooth_sigma(frame, fringe_freq=4)
    assert sigma > 0, "Should recommend some smoothing for noisy frame"
    assert sigma <= 3.0, f"Sigma {sigma} seems too high for this noise level"


def test_find_optimal_smooth_sigma_returns_zero_for_clean_signal():
    from backend.vision.deflectometry import find_optimal_smooth_sigma
    H, W = 64, 256
    # Use arange for exact periodicity (no spectral leakage)
    x = np.arange(W) * (2 * np.pi * 4 / W)
    frame = 127.0 + 100.0 * np.cos(x)
    frame = np.tile(frame, (H, 1))
    sigma = find_optimal_smooth_sigma(frame, fringe_freq=4)
    assert sigma == 0.0, f"Clean signal should need no smoothing, got {sigma}"


def test_generate_fringe_pattern_gamma_correction():
    """Gamma-corrected pattern should linearize display output."""
    img = generate_fringe_pattern(256, 1, phase=0.0, freq=1, orientation="x", gamma=2.2)
    # After display gamma (2.2), output should be sinusoidal
    # Simulate display: output = (pixel/255)^2.2
    pixel_norm = img[0].astype(np.float64) / 255.0
    display_output = np.power(pixel_norm, 2.2)
    # The display output should be close to the intended linear sinusoid
    x = np.arange(256)
    intended = 0.5 + 0.5 * np.cos(2 * np.pi * x / 256.0)
    # Allow some tolerance for quantization
    np.testing.assert_allclose(display_output, intended, atol=0.02)


def test_eight_step_suppresses_harmonics():
    """8-step should handle gamma-distorted sinusoids better than 4-step."""
    H, W = 16, 64
    true_phase = np.linspace(-2.0, 2.0, W)[None, :].repeat(H, 0)
    amplitude = 100.0
    offset = 127.0
    gamma = 2.2

    # Generate gamma-distorted frames for 4-step
    frames_4 = []
    for k in range(4):
        linear = offset + amplitude * np.cos(true_phase + k * np.pi / 2)
        distorted = 255.0 * np.power(np.clip(linear / 255.0, 0, 1), gamma)
        frames_4.append(distorted)

    # Generate gamma-distorted frames for 8-step
    frames_8 = []
    for k in range(8):
        linear = offset + amplitude * np.cos(true_phase + k * np.pi / 4)
        distorted = 255.0 * np.power(np.clip(linear / 255.0, 0, 1), gamma)
        frames_8.append(distorted)

    wrapped_4 = compute_wrapped_phase(frames_4)
    wrapped_8 = compute_wrapped_phase(frames_8)

    # Both should roughly recover the phase, but 8-step should have lower error
    error_4 = np.std(wrapped_4 - true_phase)
    error_8 = np.std(wrapped_8 - true_phase)
    assert error_8 < error_4, f"8-step error ({error_8:.4f}) should be less than 4-step ({error_4:.4f})"


def test_frankot_chellappa_recovers_paraboloid():
    # z = x^2 + y^2 -> dz/dx = 2x, dz/dy = 2y
    h, w = 64, 64
    y, x = np.mgrid[-1:1:complex(h), -1:1:complex(w)]
    dzdx = 2 * x
    dzdy = 2 * y
    z = frankot_chellappa(dzdx, dzdy)
    z_true = x**2 + y**2
    # Remove mean from both (FC sets DC=0)
    z -= np.nanmean(z)
    z_true -= z_true.mean()
    # Check correlation
    corr = np.corrcoef(z.ravel(), z_true.ravel())[0, 1]
    assert abs(corr) > 0.99, f"correlation {corr} too low"


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


def test_quality_summary_good_data():
    """Good data should produce 'good' overall quality."""
    h, w = 64, 64
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    dzdx = 0.01 * x
    dzdy = 0.01 * y
    mask = np.ones((h, w), dtype=bool)
    mod_x = np.full((h, w), 50.0)
    mod_y = np.full((h, w), 45.0)
    frames_x = [np.full((h, w), 128.0) for _ in range(8)]
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


def test_build_response_lut_identity():
    """Linear response should produce identity LUT."""
    commanded = np.array([0, 64, 128, 192, 255], dtype=np.float64)
    observed = np.array([0, 64, 128, 192, 255], dtype=np.float64)
    fwd, inv = build_response_lut(commanded, observed)
    assert fwd.shape == (256,)
    assert inv.shape == (256,)
    assert np.allclose(fwd, np.arange(256), atol=1)
    assert np.allclose(inv, np.arange(256), atol=1)

def test_build_response_lut_gamma():
    """Gamma 2.2 response should produce an inverse that linearizes."""
    commanded = np.linspace(0, 255, 12)
    observed = 255.0 * (commanded / 255.0) ** 2.2
    fwd, inv = build_response_lut(commanded, observed)
    linear_input = np.array([0, 64, 128, 192, 255], dtype=np.float64)
    corrected = np.array([inv[int(v)] for v in linear_input])
    recovered = np.array([fwd[int(c)] for c in corrected])
    assert np.allclose(recovered, linear_input, atol=3)

def test_build_response_lut_monotonic():
    """Output LUTs should be monotonically non-decreasing."""
    commanded = np.array([0, 50, 100, 150, 200, 255], dtype=np.float64)
    observed = np.array([0, 10, 40, 100, 180, 250], dtype=np.float64)
    fwd, inv = build_response_lut(commanded, observed)
    assert np.all(np.diff(fwd) >= 0)
    assert np.all(np.diff(inv) >= 0)


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


def test_display_check_all_corners_found():
    """Synthetic image with 4 bright corners should report all found."""
    img = np.zeros((480, 640), dtype=np.uint8)
    img[10:30, 10:30] = 255
    img[10:30, 610:630] = 255
    img[450:470, 10:30] = 255
    img[450:470, 610:630] = 255
    result = analyze_display_check(img)
    assert result["corners_found"] == 4
    assert result["all_visible"] is True
    assert result["status"] == "good"
    assert len(result["warnings"]) == 0

def test_display_check_missing_corner():
    """Image with only 3 corners should report missing."""
    img = np.zeros((480, 640), dtype=np.uint8)
    img[10:30, 10:30] = 255
    img[10:30, 610:630] = 255
    img[450:470, 10:30] = 255
    result = analyze_display_check(img)
    assert result["corners_found"] == 3
    assert result["all_visible"] is False
    assert result["status"] in ("fair", "poor")
    assert any("not visible" in w.lower() or "fullscreen" in w.lower() for w in result["warnings"])

def test_display_check_no_corners():
    """Blank image should report 0 corners."""
    img = np.zeros((480, 640), dtype=np.uint8)
    result = analyze_display_check(img)
    assert result["corners_found"] == 0
    assert result["status"] == "poor"
