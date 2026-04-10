"""Gear tooth width analysis via polar-strip silhouette sampling.

Given a grayscale image of a gear, its center, tip radius, root radius, and
tooth count, find the angular position of each tooth's left and right flank
where the gear silhouette crosses the pitch circle diameter, with sub-pixel
precision.

Instead of sampling a single 1-D ring at the PCD, this version samples a 2-D
polar strip symmetric around the PCD and classifies each angular column by
the fraction of its radial samples that are material. A dark mark, scratch,
or reflection sitting inside a tooth flank no longer fools the detector
because the *rest* of the column at that angle is still material.

Pure function. No global state. No I/O.
"""
from __future__ import annotations

import numpy as np
import cv2


def analyze_gear(
    gray: np.ndarray,
    cx: float,
    cy: float,
    tip_r: float,
    root_r: float,
    n_teeth: int,
) -> dict:
    """Analyze a gear and return per-tooth angular widths at the PCD.

    Args:
        gray: 2-D uint8 grayscale image.
        cx, cy: gear center in image pixel coords.
        tip_r, root_r: tip (addendum) and root (dedendum) circle radii in px.
        n_teeth: expected number of teeth (6..300).

    Returns:
        dict with:
            pcd_radius_px: float
            teeth: list of per-tooth entries sorted by center angle, each:
                index: int (1-based)
                l_angle_deg: float in [0, 360)
                r_angle_deg: float in [0, 360)
                center_angle_deg: float in [0, 360)
                angular_width_deg: float (positive, wrap-safe)
            material_is_dark: bool  (polarity used)

    Raises:
        ValueError: if inputs are out of range or image is not 2-D.
    """
    if gray.ndim != 2:
        raise ValueError("gray must be a 2-D array")
    if not (6 <= n_teeth <= 300):
        raise ValueError(f"n_teeth out of range [6, 300]: {n_teeth}")
    if tip_r <= 0 or root_r <= 0:
        raise ValueError("radii must be positive")
    if tip_r <= root_r:
        raise ValueError(f"tip_r ({tip_r}) must be greater than root_r ({root_r})")

    pcd_r = (tip_r + root_r) / 2.0
    K = 7200  # 0.05 deg per sample

    # Polar strip symmetric around the PCD. Sampling across a band of radii
    # (instead of a single ring) is what makes flank detection insensitive to
    # dark markings, reflections, or small damage on the tooth face: at any
    # given angle, the column is classified as "inside tooth" when most of
    # its radial samples are material, so a single bad pixel does nothing.
    band_half = 0.35 * (tip_r - root_r)
    band_lo = pcd_r - band_half
    band_hi = pcd_r + band_half
    R = max(8, int(round(band_hi - band_lo)))

    # Build (R, K) polar grid and sample with bilinear interpolation.
    angles = np.linspace(0.0, 2 * np.pi, K, endpoint=False)
    radii = np.linspace(band_lo, band_hi, R)
    cos_t = np.cos(angles).astype(np.float32).reshape(1, K)
    sin_t = np.sin(angles).astype(np.float32).reshape(1, K)
    radii_f = radii.astype(np.float32).reshape(R, 1)
    xs = (cx + radii_f * cos_t).astype(np.float32)
    ys = (cy + radii_f * sin_t).astype(np.float32)
    strip = cv2.remap(
        gray, xs, ys,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )  # (R, K) uint8

    # Global Otsu on the whole strip. The strip is an annular crop tightly
    # around the PCD, so its histogram is a clean bimodal mix of material
    # and background — a single global threshold is fine.
    strip_u8 = np.ascontiguousarray(strip).astype(np.uint8)
    otsu_t, _ = cv2.threshold(
        strip_u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )
    otsu_t = float(otsu_t)

    # Column-wise "material fraction" profile for each polarity. Inside a
    # tooth the column is entirely inside the silhouette (~1.0). Between
    # teeth the column is entirely background (~0.0). At a flank the
    # fraction transitions smoothly, which also gives clean sub-pixel
    # crossings.
    mat_dark = (strip < otsu_t).astype(np.float32)
    mat_light = (strip >= otsu_t).astype(np.float32)
    prof_dark = mat_dark.sum(axis=0) / float(R)
    prof_light = mat_light.sum(axis=0) / float(R)

    # 5-tap circular boxcar smoothing suppresses single-pixel noise in the
    # fraction profile without shifting flank positions.
    def circ_smooth(p: np.ndarray) -> np.ndarray:
        padded = np.concatenate([p[-2:], p, p[:2]])
        kernel = np.ones(5, dtype=np.float32) / 5.0
        return np.convolve(padded, kernel, mode="valid")

    prof_dark_s = circ_smooth(prof_dark)
    prof_light_s = circ_smooth(prof_light)
    assert prof_dark_s.shape == (K,)
    assert prof_light_s.shape == (K,)

    # Binarize at 0.5 (majority of the strip classified as material). The
    # 0.5 cut is the natural silhouette midpoint in a symmetric band.
    TH = 0.5

    def find_runs(binary: np.ndarray) -> list[tuple[int, int]]:
        """Return (start_idx, end_idx_exclusive) pairs; wrap-around merged."""
        runs: list[tuple[int, int]] = []
        in_run = False
        start = 0
        for i in range(K):
            if binary[i] and not in_run:
                in_run = True
                start = i
            elif not binary[i] and in_run:
                in_run = False
                runs.append((start, i))
        if in_run:
            runs.append((start, K))
        if len(runs) >= 2 and runs[0][0] == 0 and runs[-1][1] == K:
            first = runs.pop(0)
            last = runs.pop(-1)
            runs.append((last[0], first[1] + K))
        return runs

    def run_length(r: tuple[int, int]) -> int:
        return r[1] - r[0]

    def run_center_mod(r: tuple[int, int]) -> float:
        return ((r[0] + r[1]) / 2.0) % K

    def score_polarity(runs: list[tuple[int, int]]) -> float:
        if len(runs) < n_teeth:
            return float("inf")
        top = sorted(runs, key=run_length, reverse=True)[:n_teeth]
        top.sort(key=run_center_mod)
        centers = [run_center_mod(r) for r in top]
        gaps = []
        for i in range(n_teeth):
            g = (centers[(i + 1) % n_teeth] - centers[i]) % K
            gaps.append(g)
        return float(np.std(gaps))

    binary_dark = prof_dark_s >= TH
    binary_light = prof_light_s >= TH
    runs_dark = find_runs(binary_dark)
    runs_light = find_runs(binary_light)

    score_dark = score_polarity(runs_dark)
    score_light = score_polarity(runs_light)

    if score_dark == float("inf") and score_light == float("inf"):
        return {
            "pcd_radius_px": float(pcd_r),
            "teeth": [],
            "material_is_dark": True,
            "error": (
                f"Could not find {n_teeth} teeth "
                f"(found {max(len(runs_dark), len(runs_light))})"
            ),
        }

    if score_dark <= score_light:
        chosen = runs_dark
        chosen_profile = prof_dark_s
        material_is_dark = True
    else:
        chosen = runs_light
        chosen_profile = prof_light_s
        material_is_dark = False

    top = sorted(chosen, key=run_length, reverse=True)[:n_teeth]
    top.sort(key=run_center_mod)

    # Sub-pixel crossings: linear interp on the smoothed fraction profile
    # at the same 0.5 level used for binarization.
    def subpix_crossing(k_before: int, k_after: int, threshold: float) -> float:
        v0 = float(chosen_profile[k_before % K])
        v1 = float(chosen_profile[k_after % K])
        if v1 == v0:
            return float(k_before)
        frac = (threshold - v0) / (v1 - v0)
        return k_before + frac

    teeth = []
    for idx, (start, end) in enumerate(top):
        l_frac = subpix_crossing(start - 1, start, TH)
        r_frac = subpix_crossing(end - 1, end, TH)

        l_angle = (2 * np.pi * l_frac / K) % (2 * np.pi)
        r_angle = (2 * np.pi * r_frac / K) % (2 * np.pi)

        width = r_angle - l_angle
        if width < 0:
            width += 2 * np.pi

        center_angle = (l_angle + width / 2.0) % (2 * np.pi)

        teeth.append({
            "index": idx + 1,
            "l_angle_deg": float(np.degrees(l_angle)),
            "r_angle_deg": float(np.degrees(r_angle)),
            "center_angle_deg": float(np.degrees(center_angle)),
            "angular_width_deg": float(np.degrees(width)),
        })

    return {
        "pcd_radius_px": float(pcd_r),
        "teeth": teeth,
        "material_is_dark": material_is_dark,
    }
