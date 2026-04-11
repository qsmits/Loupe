"""Auto-phase detection for generated gear overlays.

Finds the rotation angle needed to align a zero-phase synthetic gear
with the real gear in an image. Uses a DFT of an intensity profile
sampled along the pitch circle and extracts the phase at frequency
`n_teeth` — that phase IS the angular offset of the tooth pattern.
Subtract the same measurement taken from a rasterized synth-gear-at-
rotation-0 and divide by n_teeth to get the rotation needed.

Why this instead of silhouette cross-correlation (the earlier attempt
in scripts/validate_gear_geometry.autophase): segmenting the gear from
the background is unreliable under microscope lighting — bright metallic
surfaces, uneven green backlight, and the central bore all defeat simple
color/saturation thresholds. Sampling raw intensity along a known circle
skips segmentation entirely and only asks "how does brightness vary with
angle", which has a clean N-tooth harmonic regardless of the absolute
brightness or contrast.

Assumes the user has already fit tip/root circles; that is what gives us
the gear center and a meaningful sample radius. The caller must also
know n_teeth.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

from .gear_geometry import generate_cycloidal_gear, generate_involute_gear


def _sample_circle(
    arr2d: np.ndarray, cx: float, cy: float, r: float, ns: int,
) -> np.ndarray:
    """Bilinearly sample arr2d along a circle of radius r at (cx, cy).

    Returns an ns-length 1D profile starting at theta=0 (+x axis) and
    proceeding CCW in math coords (= CW in image coords because y is
    flipped).
    """
    thetas = np.linspace(0, 2 * np.pi, ns, endpoint=False)
    xs = cx + r * np.cos(thetas)
    ys = cy + r * np.sin(thetas)
    x0 = np.floor(xs).astype(int)
    y0 = np.floor(ys).astype(int)
    fx = xs - x0
    fy = ys - y0
    h, w = arr2d.shape
    x0c = np.clip(x0, 0, w - 1)
    x1c = np.clip(x0 + 1, 0, w - 1)
    y0c = np.clip(y0, 0, h - 1)
    y1c = np.clip(y0 + 1, 0, h - 1)
    return (
        (1 - fy) * ((1 - fx) * arr2d[y0c, x0c] + fx * arr2d[y0c, x1c])
        + fy * ((1 - fx) * arr2d[y1c, x0c] + fx * arr2d[y1c, x1c])
    )


def estimate_gear_tooth_count(
    frame: np.ndarray,
    cx: float,
    cy: float,
    r_tip: float,
    r_root: float,
    k_min: int = 6,
    k_max: int = 300,
    ns_samples: int = 4096,
) -> tuple[int, float]:
    """Estimate the number of teeth by finding the dominant harmonic of
    the pitch-circle intensity profile.

    Returns (n_teeth, snr):
      * n_teeth = argmax |F[k]| for k in [k_min, k_max]. The pitch-circle
        profile of a gear is dominated by its N-th harmonic (one bright/
        dark cycle per tooth), so the fundamental always wins over DC
        (skipped by k_min) and higher harmonics.
      * snr = |F[n_teeth]| / |F[0]|. Below ~0.02 the spectrum is too
        flat to trust — the caller should surface a warning.

    Uses ns_samples=4096 rather than 2048 so the 300-bin max stays well
    below Nyquist even for dense gears; the cost is negligible since
    this runs once per Detect click.
    """
    if r_tip <= r_root:
        raise ValueError(f"r_tip ({r_tip}) must exceed r_root ({r_root})")
    if k_min < 1 or k_min >= k_max:
        raise ValueError(f"need 1 <= k_min < k_max, got {k_min}..{k_max}")
    if ns_samples <= 2 * k_max:
        raise ValueError(
            f"ns_samples={ns_samples} too small for k_max={k_max} "
            f"(need > 2·k_max)"
        )

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
    r_sample = 0.5 * (r_tip + r_root)
    prof = _sample_circle(gray, cx, cy, r_sample, ns_samples)
    F = np.fft.fft(prof)
    mags = np.abs(F[k_min : k_max + 1])
    n_teeth = int(k_min + int(mags.argmax()))
    dc = float(abs(F[0]))
    snr = float(mags.max() / (dc + 1e-6))
    return n_teeth, snr


def estimate_gear_phase(
    frame: np.ndarray,
    cx: float,
    cy: float,
    r_tip: float,
    r_root: float,
    n_teeth: int,
    pixels_per_mm: float,
    profile: str = "cycloidal",
    addendum_coef: float = 1.0,
    dedendum_coef: float | None = None,
    rolling_radius_coef: float = 0.5,
    pressure_angle_deg: float = 20.0,
    ns_samples: int = 2048,
) -> tuple[float, float]:
    """Estimate the rotation_deg to pass to /generate-gear-dxf so the
    resulting overlay aligns with the real gear in `frame`.

    Returns (rotation_deg, snr):
      * rotation_deg is wrapped to [0, 360/n_teeth) — only the phase
        modulo one tooth pitch is observable from the DFT harmonic.
      * snr = |F[n_teeth]| / |F[0]|, a signal strength indicator. Values
        below ~0.02 mean the sampled profile has no clear N-tooth
        harmonic and the estimate should not be trusted — the caller
        should fall back to 0 or surface a warning.

    Frame note: the DFT math here operates in the image-sampling frame
    (cx + r·cos θ, cy + r·sin θ). But the frontend draws DXF overlays
    via a Y-flipped transform (y_canvas = -y_dxf·scale), and /generate-
    gear-dxf applies rotation_deg in the pre-flip DXF-math frame. So the
    rotation that matches the real image in canvas coords is NEGATIVE of
    what the image-sampling-frame algebra produces — we negate at the
    end. Without this, the generated overlay appears rotationally
    mirrored by twice the detected angle, which no amount of manual
    nudging can fix (the two frames disagree about rotation sign, not
    just starting offset).

    The sample radius is the pitch circle (midway between root and tip).
    That's where the tooth/gap alternation is maximal: inside a tooth
    you're on metal, in a gap you're on background. Sampling closer to
    the tip loses signal in deep shadows and near the nominal root loses
    signal when the gear is slightly off-center.
    """
    if pixels_per_mm <= 0:
        raise ValueError("pixels_per_mm must be positive")
    if n_teeth < 6:
        raise ValueError(f"n_teeth must be >= 6, got {n_teeth}")
    if r_tip <= r_root:
        raise ValueError(f"r_tip ({r_tip}) must exceed r_root ({r_root})")

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
    r_sample = 0.5 * (r_tip + r_root)

    prof_real = _sample_circle(gray, cx, cy, r_sample, ns_samples)
    F_real = np.fft.fft(prof_real)
    ph_real = float(np.angle(F_real[n_teeth]))
    mag_real = float(abs(F_real[n_teeth]))
    dc = float(abs(F_real[0]))
    snr = mag_real / (dc + 1e-6)

    # Derive gear parameters the same way the frontend does: anchor on
    # tip radius, derive dedendum from the fit root so the synth gear
    # geometry matches the user-picked extents — not textbook watch-gear
    # conventions that rarely apply to arbitrary samples.
    r_tip_mm = r_tip / pixels_per_mm
    r_root_mm = r_root / pixels_per_mm
    module_mm = (2 * r_tip_mm) / (n_teeth + 2 * addendum_coef)
    if dedendum_coef is None:
        r_pitch_mm = n_teeth * module_mm / 2.0
        dc_derived = (r_pitch_mm - r_root_mm) / module_mm
        dedendum_coef = dc_derived if 0.5 <= dc_derived <= 2.0 else 1.25

    if profile == "cycloidal":
        poly = generate_cycloidal_gear(
            n_teeth=n_teeth,
            module=module_mm,
            rolling_radius_coef=rolling_radius_coef,
            addendum_coef=addendum_coef,
            dedendum_coef=dedendum_coef,
            points_per_flank=40,
            points_per_tip=15,
            points_per_root=10,
        )
    elif profile == "involute":
        poly = generate_involute_gear(
            n_teeth=n_teeth,
            module=module_mm,
            pressure_angle_deg=pressure_angle_deg,
            addendum_coef=addendum_coef,
            dedendum_coef=dedendum_coef,
            profile_shift=0.0,
            points_per_flank=40,
            points_per_tip=15,
            points_per_root=10,
        )
    else:
        raise ValueError(f"unknown profile: {profile}")

    h, w = gray.shape
    mask = np.zeros((h, w), dtype=np.uint8)
    pts = np.array(
        [(cx + x * pixels_per_mm, cy + y * pixels_per_mm) for (x, y) in poly],
        dtype=np.int32,
    ).reshape(-1, 1, 2)
    cv2.fillPoly(mask, [pts], 255)
    prof_synth = _sample_circle(
        mask.astype(np.float32), cx, cy, r_sample, ns_samples,
    )
    ph_synth = float(np.angle(np.fft.fft(prof_synth)[n_teeth]))

    # DFT phase of cos(N·θ − φ) is −φ (because of the −i in the
    # transform), so rotating the signal by α changes its effective φ by
    # N·α and its DFT phase by −N·α. To align synth to real in the
    # image-sampling frame:
    #     −N·α = ph_real − ph_synth  →  α = (ph_synth − ph_real) / N
    alpha_img = (ph_synth - ph_real) / n_teeth
    # Convert from image-sampling-frame rotation to DXF-frame rotation_deg
    # (see docstring "Frame note"). The frontend Y-flip in dxfToCanvas
    # negates tooth angles, so the DXF rotation needed is the opposite
    # of the image-sampling-frame angle.
    delta = -alpha_img
    pitch_rad = 2 * math.pi / n_teeth
    # Wrap to [0, one tooth pitch). Only the phase mod pitch is
    # observable from a single harmonic.
    delta = delta % pitch_rad
    return math.degrees(delta), snr
