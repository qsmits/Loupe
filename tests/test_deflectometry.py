import base64
import numpy as np
from backend.vision.deflectometry import (
    create_modulation_mask,
    fit_sphere_calibration,
    frankot_chellappa,
    generate_fringe_pattern, compute_wrapped_phase, unwrap_phase,
    phase_stats, pseudocolor_png_b64, remove_tilt,
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
