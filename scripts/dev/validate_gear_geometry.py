"""Visually validate gear_geometry generators against real gear snapshots.

Loads a snapshot PNG + session JSON, grabs the fitted tip/root circles,
runs generate_cycloidal_gear (and optionally involute) at a user-supplied
tooth count, projects the synthetic polyline onto the image, and writes
an overlay PNG for inspection.

Usage (from repo root):
    .venv/bin/python scripts/dev/validate_gear_geometry.py snapshots/gear_1 15
    .venv/bin/python scripts/dev/validate_gear_geometry.py snapshots/gear_2 8
    .venv/bin/python scripts/dev/validate_gear_geometry.py snapshots/gear_3_stitched 36

Takes <basename> (without extension) and tooth count N. Optional --profile
{cycloidal,involute} (default cycloidal), --rolling-coef (default 0.5),
--addendum (default 1.0), --dedendum (default 1.25).

Writes <basename>_overlay_<profile>_N<N>.png next to the input.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

# Make backend imports work when running from repo root.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.vision.gear_geometry import (  # noqa: E402
    generate_cycloidal_gear,
    generate_involute_gear,
)


def autodetect_tip_root(png_path: Path) -> tuple[float, float, float, float]:
    """Return (cx, cy, r_tip, r_root) for the centered gear in the image.

    Tries two color-space rules in sequence: (G−R < −10) catches
    purple/metallic gears on green backlight, (G−B < 5) catches
    bluish/semi-transparent gears. Takes the component closest to the
    image center, then fits tip/root circles algebraically to the outer
    10% and inner 30% of contour radii respectively.
    """
    img = cv2.imread(str(png_path), cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"could not read {png_path}")

    def segment(rule: str) -> np.ndarray:
        if rule == "gr":
            diff = img[:, :, 1].astype(int) - img[:, :, 2].astype(int)
            return (diff < -10).astype(np.uint8)
        if rule == "gb":
            diff = img[:, :, 1].astype(int) - img[:, :, 0].astype(int)
            return (diff < 5).astype(np.uint8)
        raise ValueError(rule)

    mask = segment("gr")
    if mask.sum() < 10000:
        mask = segment("gb")
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((30, 30), np.uint8))

    n, labels, stats, cents = cv2.connectedComponentsWithStats(mask)
    h, w = img.shape[:2]
    ic = np.array([w / 2, h / 2])
    best = None
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < 5000:
            continue
        d = float(np.linalg.norm(cents[i] - ic))
        score = stats[i, cv2.CC_STAT_AREA] / (1.0 + d / 100.0)
        if best is None or score > best[0]:
            best = (score, i)
    if best is None:
        raise RuntimeError("no gear component found")
    lbl = (labels == best[1]).astype(np.uint8) * 255

    contours, _ = cv2.findContours(lbl, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(contours, key=cv2.contourArea)
    pts = c[:, 0, :].astype(np.float64)

    def circle_fit(p):
        A = np.column_stack([2 * p[:, 0], 2 * p[:, 1], np.ones(len(p))])
        b = p[:, 0] ** 2 + p[:, 1] ** 2
        sol, *_ = np.linalg.lstsq(A, b, rcond=None)
        a, bb, c_ = sol
        return a, bb, math.sqrt(c_ + a * a + bb * bb)

    # Center from the contour's area moments — robust to asymmetric noise
    # blobs that would pull a naive point-mean off.
    M = cv2.moments(c)
    if M["m00"] > 0:
        cx0 = M["m10"] / M["m00"]
        cy0 = M["m01"] / M["m00"]
    else:
        cx0, cy0 = pts.mean(axis=0)
    rs = np.hypot(pts[:, 0] - cx0, pts[:, 1] - cy0)

    # Reject points whose radii are gross outliers relative to the bulk of
    # the contour (stray noise-blob pixels that attached to the main gear
    # via morphological closing). Keep the 5..95 percentile band of radii
    # for the initial "good gear contour" mask.
    r_lo_keep = np.percentile(rs, 5)
    r_hi_keep = np.percentile(rs, 95)
    keep = (rs >= r_lo_keep) & (rs <= r_hi_keep)
    good_pts = pts[keep]
    good_rs = rs[keep]

    # Fit tip to the top 10% and root to the bottom 30% of the *kept* pts.
    tip_pts = good_pts[good_rs > np.percentile(good_rs, 90)]
    root_pts = good_pts[good_rs < np.percentile(good_rs, 30)]
    cxt, cyt, r_tip = circle_fit(tip_pts)
    _, _, r_root = circle_fit(root_pts)
    return cxt, cyt, r_tip, r_root


def _gear_mask(png_path: Path) -> np.ndarray:
    img = cv2.imread(str(png_path), cv2.IMREAD_COLOR)
    # Same two-rule fallback as autodetect_tip_root: G−R catches
    # purple/metallic gears on green backlight, G−B catches bluish/
    # semi-transparent gears.
    diff_gr = img[:, :, 1].astype(int) - img[:, :, 2].astype(int)
    m = (diff_gr < -10).astype(np.uint8)
    if m.sum() < 10000:
        diff_gb = img[:, :, 1].astype(int) - img[:, :, 0].astype(int)
        m = (diff_gb < 5).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    # Keep only the centered component.
    n, labels, stats, cents = cv2.connectedComponentsWithStats(m)
    h, w = img.shape[:2]
    ic = np.array([w / 2, h / 2])
    best = None
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < 5000:
            continue
        d = float(np.linalg.norm(cents[i] - ic))
        score = stats[i, cv2.CC_STAT_AREA] / (1.0 + d / 100.0)
        if best is None or score > best[0]:
            best = (score, i)
    return (labels == best[1]).astype(np.uint8) if best else m


def _synth_polygon_mask(poly, cx, cy, shape):
    """Rasterize the synthetic polyline (already in gear-local coords,
    centered on origin) into a binary mask at (cx, cy)."""
    pts = np.array(
        [(cx + x, cy + y) for (x, y) in poly], dtype=np.int32
    ).reshape(-1, 1, 2)
    mask = np.zeros(shape[:2], dtype=np.uint8)
    cv2.fillPoly(mask, [pts], 1)
    return mask


def autophase(png_path: Path, cx: float, cy: float, r_tip: float,
              r_root: float, n_teeth: int, poly) -> float:
    """Find the phase rotation (in degrees, image coords +CW) that best
    aligns the synthetic polyline with the real gear mask.

    Strategy: sample both masks along a circle at r_probe = (r_tip+r_root)/2
    (the pitch circle — right on the tooth flank), getting a 1D binary
    profile as a function of angle. Cross-correlate.
    """
    real = _gear_mask(png_path)
    synth = _synth_polygon_mask(poly, cx, cy, real.shape)

    # Sample NS points around a circle at r_probe.
    NS = 1024
    r_probe = 0.5 * (r_tip + r_root)
    thetas = np.linspace(0, 2 * np.pi, NS, endpoint=False)
    xs = (cx + r_probe * np.cos(thetas)).astype(np.int32)
    ys = (cy + r_probe * np.sin(thetas)).astype(np.int32)
    # Clip to image bounds
    h, w = real.shape
    xs = np.clip(xs, 0, w - 1)
    ys = np.clip(ys, 0, h - 1)
    prof_real = real[ys, xs].astype(np.float32) - 0.5
    prof_synth = synth[ys, xs].astype(np.float32) - 0.5

    # Cross-correlate via FFT.
    F = np.fft.fft(prof_real)
    G = np.fft.fft(prof_synth)
    corr = np.fft.ifft(F * np.conj(G)).real

    # An N-fold symmetric gear produces N nearly-identical correlation
    # peaks spaced by NS/N samples. A global argmax can land on any of
    # them — including lag 0 when the true shift is half-pitch — which is
    # why we previously returned 0° for gear_3. Restrict the search to a
    # single pitch window [0, NS/N) so we find the correct sub-pitch shift
    # unambiguously.
    samples_per_pitch = NS / n_teeth
    search_hi = int(math.ceil(samples_per_pitch))
    k_best = int(np.argmax(corr[:search_hi]))
    shift_deg = k_best * (360.0 / NS)
    # shift_deg is already in [0, pitch_deg) by construction.
    return shift_deg


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("basename", help="snapshot basename, e.g. snapshots/gear_1")
    ap.add_argument("n_teeth", type=int)
    ap.add_argument("--profile", choices=["cycloidal", "involute"], default="cycloidal")
    ap.add_argument("--rolling-coef", type=float, default=0.5)
    ap.add_argument("--addendum", type=float, default=1.0)
    ap.add_argument("--dedendum", type=float, default=1.25)
    ap.add_argument("--pressure-angle", type=float, default=20.0)
    ap.add_argument("--phase-deg", type=float, default=0.0,
                    help="Rotate the synthetic gear by this many degrees "
                         "(image coords: +CW). Useful for phase alignment.")
    ap.add_argument("--auto", action="store_true",
                    help="Auto-detect tip/root circles from the image "
                         "(ignore the JSON annotations). Useful when the "
                         "session JSON was captured with the pre-fix Shift+P "
                         "bug and its coords don't match the saved PNG.")
    ap.add_argument("--auto-phase", action="store_true",
                    help="Find the best phase rotation by cross-correlating "
                         "a polar profile of the real gear mask with the "
                         "synthetic gear's polar profile.")
    args = ap.parse_args()

    base = Path(args.basename)
    png_path = base.with_suffix(".png")
    json_path = base.with_suffix(".json")
    if not png_path.exists():
        print(f"ERROR: {png_path} not found")
        return 1
    if not json_path.exists():
        print(f"ERROR: {json_path} not found")
        return 1

    if args.auto:
        cx, cy, r_tip, r_root = autodetect_tip_root(png_path)
        print(f"auto-detected tip:  cx={cx:.2f} cy={cy:.2f} r={r_tip:.2f}")
        print(f"auto-detected root: r={r_root:.2f}")
    else:
        session = json.loads(json_path.read_text())
        annos = session.get("annotations", [])
        circles = [a for a in annos if a.get("type") == "circle"]
        if len(circles) < 2:
            print("ERROR: session needs at least two circle annotations (tip and root)")
            return 1
        # Two biggest circles → largest = tip, second-largest = root.
        circles.sort(key=lambda a: a["r"], reverse=True)
        tip = circles[0]
        root = circles[1]
        print(f"tip circle:  cx={tip['cx']:.2f} cy={tip['cy']:.2f} r={tip['r']:.2f}")
        print(f"root circle: cx={root['cx']:.2f} cy={root['cy']:.2f} r={root['r']:.2f}")
        cx, cy = tip["cx"], tip["cy"]
        r_tip = tip["r"]
        r_root = root["r"]

    # Derive the module m from r_tip with the user-fixed addendum_coef and
    # the geometric identity r_pitch = N·m/2:
    #   r_tip = r_pitch + addendum·m = N·m/2 + addendum·m
    #   → m = 2·r_tip / (N + 2·addendum)
    # The dedendum_coef is then DERIVED from r_root rather than assumed,
    # because watch gears don't follow the industrial 1.25 convention. The
    # user-supplied --dedendum is only used as an override for cases where
    # the root fit is unreliable (tip fit is the more stable anchor).
    m = 2.0 * r_tip / (args.n_teeth + 2.0 * args.addendum)
    r_pitch = args.n_teeth * m / 2.0
    dedendum_derived = (r_pitch - r_root) / m
    # Guard against pathological dedendums (r_root above r_pitch, or
    # absurdly deep) — fall back to the user-supplied value in that case.
    if 0.5 <= dedendum_derived <= 2.0:
        dedendum_used = dedendum_derived
    else:
        dedendum_used = args.dedendum
    print(f"derived: m={m:.3f} px ({m / 455.69 * 1000:.1f} µm), "
          f"r_pitch={r_pitch:.2f} px, N={args.n_teeth}, "
          f"dedendum_coef={dedendum_used:.3f} "
          f"(raw={dedendum_derived:.3f})")

    if args.profile == "cycloidal":
        poly = generate_cycloidal_gear(
            n_teeth=args.n_teeth,
            module=m,
            rolling_radius_coef=args.rolling_coef,
            addendum_coef=args.addendum,
            dedendum_coef=dedendum_used,
            points_per_flank=80,
            points_per_tip=30,
            points_per_root=20,
        )
    else:
        poly = generate_involute_gear(
            n_teeth=args.n_teeth,
            module=m,
            pressure_angle_deg=args.pressure_angle,
            addendum_coef=args.addendum,
            dedendum_coef=dedendum_used,
            points_per_flank=80,
            points_per_tip=30,
            points_per_root=20,
        )

    phase_deg = args.phase_deg
    if args.auto_phase:
        phase_deg = autophase(png_path, cx, cy, r_tip, r_root, args.n_teeth, poly)
        print(f"auto-phase: {phase_deg:.3f} deg")

    # Rotate by phase_deg (in image coords, +x right, +y down) and translate
    # to the gear center.
    phi = math.radians(phase_deg)
    c, s = math.cos(phi), math.sin(phi)
    img_pts = np.array(
        [
            (cx + c * x - s * y, cy + s * x + c * y)
            for (x, y) in poly
        ],
        dtype=np.float32,
    )

    img = cv2.imread(str(png_path), cv2.IMREAD_COLOR)
    if img is None:
        print(f"ERROR: could not read {png_path}")
        return 1
    overlay = img.copy()

    # Draw the tip/root circles in faint gray for reference.
    cv2.circle(overlay, (int(round(cx)), int(round(cy))), int(round(r_tip)),
               (180, 180, 180), 1, lineType=cv2.LINE_AA)
    cv2.circle(overlay, (int(round(cx)), int(round(cy))), int(round(r_root)),
               (180, 180, 180), 1, lineType=cv2.LINE_AA)
    cv2.circle(overlay, (int(round(cx)), int(round(cy))), int(round(r_pitch)),
               (255, 255, 0), 1, lineType=cv2.LINE_AA)

    # Draw the synthetic gear polyline in bright yellow.
    pts = img_pts.round().astype(np.int32).reshape(-1, 1, 2)
    cv2.polylines(overlay, [pts], isClosed=True, color=(0, 255, 255),
                  thickness=2, lineType=cv2.LINE_AA)

    # Mark the gear center.
    cv2.drawMarker(overlay, (int(round(cx)), int(round(cy))),
                   (0, 0, 255), markerType=cv2.MARKER_CROSS,
                   markerSize=20, thickness=2)

    out_path = base.with_name(
        f"{base.name}_overlay_{args.profile}_N{args.n_teeth}"
        f"_phase{int(round(phase_deg))}.png"
    )
    cv2.imwrite(str(out_path), overlay)
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
