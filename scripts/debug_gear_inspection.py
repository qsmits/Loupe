"""End-to-end reproduction of gear fit-line failure.

Loads gear_N.png + session JSON (the user's hand-drawn tip/root circles),
generates a cycloidal gear with tooth_index metadata exactly like the
/generate-gear-dxf endpoint does, runs inspect_features, and draws:
    - nominal projected silhouette (cyan, thin)
    - fit lines returned by the inspector (yellow/red, color-coded by match)
    - Canny edge pixels (dim white)
    - gear center crosshair

to a debug PNG so we can see whether fit lines lock onto the silhouette
or get pulled into interior tooth surface texture.

Usage:
    .venv/bin/python scripts/debug_gear_inspection.py snapshots/gear_1 17 --phase 16
    .venv/bin/python scripts/debug_gear_inspection.py snapshots/gear_2 8
    .venv/bin/python scripts/debug_gear_inspection.py snapshots/gear_3_stitched 40
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.vision.gear_geometry import generate_cycloidal_gear  # noqa: E402
from backend.vision.guided_inspection import inspect_features  # noqa: E402
from backend.vision.detection import preprocess  # noqa: E402


def build_gear_entities(n_teeth, module_mm, cx_mm, cy_mm, rotation_deg,
                        addendum=1.0, dedendum=1.25, rolling=0.5):
    """Replicate /generate-gear-dxf — returns entities in mm (DXF) space
    with tooth_index/region metadata."""
    poly, period_length, period_regions = generate_cycloidal_gear(
        n_teeth=n_teeth,
        module=module_mm,
        rolling_radius_coef=rolling,
        addendum_coef=addendum,
        dedendum_coef=dedendum,
        points_per_flank=30,
        points_per_tip=10,
        points_per_root=6,
        return_regions=True,
    )
    phi = math.radians(rotation_deg)
    c, s = math.cos(phi), math.sin(phi)
    world = [
        (cx_mm + c * x - s * y, cy_mm + s * x + c * y)
        for (x, y) in poly
    ]
    parent = f"gear_cycloidal_N{n_teeth}"
    entities = []
    for i in range(len(world) - 1):
        x1, y1 = world[i]
        x2, y2 = world[i + 1]
        entities.append({
            "type": "polyline_line",
            "x1": float(x1), "y1": float(y1),
            "x2": float(x2), "y2": float(y2),
            "handle": f"{parent}_s{i}",
            "parent_handle": parent,
            "segment_index": i,
            "tooth_index": i // period_length,
            "region": period_regions[i % period_length],
            "layer": "GEAR",
        })
    return entities


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("basename")
    ap.add_argument("n_teeth", type=int)
    ap.add_argument("--profile", default="cycloidal")
    ap.add_argument("--phase", type=float, default=0.0,
                    help="gear rotation in degrees (image +CW)")
    ap.add_argument("--addendum", type=float, default=1.0)
    ap.add_argument("--corridor", type=float, default=20.0)
    ap.add_argument("--canny-low", type=int, default=50)
    ap.add_argument("--canny-high", type=int, default=150)
    ap.add_argument("--smoothing", type=int, default=1)
    ap.add_argument("--auto", action="store_true",
                    help="Auto-detect gear tip/root from the image mask "
                         "instead of trusting the session JSON circles.")
    args = ap.parse_args()

    base = Path(args.basename)
    png_path = base.with_suffix(".png")
    json_path = base.with_suffix(".json")
    img = cv2.imread(str(png_path), cv2.IMREAD_COLOR)
    if img is None:
        print(f"ERROR: could not read {png_path}")
        return 1
    session = json.loads(json_path.read_text())
    cal = session.get("calibration") or {}
    ppm = cal.get("pixelsPerMm")
    if not ppm:
        print("ERROR: session has no calibration.pixelsPerMm")
        return 1

    if args.auto:
        from scripts.validate_gear_geometry import autodetect_tip_root
        tip_cx_px, tip_cy_px, tip_r_px, root_r_px = autodetect_tip_root(png_path)
        print(f"auto-detected tip cx={tip_cx_px:.1f} cy={tip_cy_px:.1f} r={tip_r_px:.1f}  root r={root_r_px:.1f}")
    else:
        annos = session.get("annotations", [])
        circles = sorted(
            [a for a in annos if a.get("type") == "circle"],
            key=lambda a: a["r"],
            reverse=True,
        )
        if len(circles) < 2:
            print("ERROR: session needs at least 2 circle annotations")
            return 1
        tip, root = circles[0], circles[1]
        tip_cx_px, tip_cy_px, tip_r_px = tip["cx"], tip["cy"], tip["r"]
        root_r_px = root["r"]

    print(f"ppm={ppm:.3f}  tip=({tip_cx_px:.1f},{tip_cy_px:.1f}) r={tip_r_px:.1f}  root r={root_r_px:.1f}")

    # Derive module from tip radius exactly like the frontend does.
    r_tip_mm = tip_r_px / ppm
    module_mm = (2 * r_tip_mm) / (args.n_teeth + 2 * args.addendum)
    # Derive dedendum so the synthetic root matches the picked root (same
    # trick scripts/validate_gear_geometry.py uses).
    r_pitch_mm = args.n_teeth * module_mm / 2.0
    r_root_mm = root_r_px / ppm
    dedendum_derived = (r_pitch_mm - r_root_mm) / module_mm
    if 0.5 <= dedendum_derived <= 2.0:
        dedendum = dedendum_derived
    else:
        dedendum = 1.25
    print(f"module={module_mm * 1000:.2f} µm  r_pitch={r_pitch_mm:.3f} mm  dedendum={dedendum:.3f}")

    # Build the entities in the SAME frame the frontend uses: gear center
    # in DXF is (0, 0), then offsetX/Y in the overlay puts DXF (0, 0) at
    # the tip-circle pixel center. inspect_features projects via
    # dxf_to_image_px(x, y, ppm, tx, ty, angle) with tx = tip_cx_px.
    entities = build_gear_entities(
        n_teeth=args.n_teeth,
        module_mm=module_mm,
        cx_mm=0.0, cy_mm=0.0,
        rotation_deg=args.phase,
        addendum=args.addendum,
        dedendum=dedendum,
    )
    print(f"generated {len(entities)} gear line segments")

    results = inspect_features(
        img,
        entities,
        pixels_per_mm=ppm,
        tx=tip_cx_px,
        ty=tip_cy_px,
        angle_deg=0.0,  # rotation already baked into the entity coords
        flip_h=False,
        flip_v=False,
        corridor_px=args.corridor,
        canny_low=args.canny_low,
        canny_high=args.canny_high,
        smoothing=args.smoothing,
        subpixel="none",
    )

    matched = [r for r in results if r.get("matched")]
    unmatched = [r for r in results if not r.get("matched")]
    print(f"matched: {len(matched)} / {len(results)}")
    if unmatched:
        reasons = {}
        for r in unmatched:
            reasons[r["reason"]] = reasons.get(r["reason"], 0) + 1
        print(f"unmatched reasons: {reasons}")

    # Deviation stats for matched.
    devs = [abs(r["perp_dev_mm"]) for r in matched if r.get("perp_dev_mm") is not None]
    if devs:
        devs_um = [d * 1000 for d in devs]
        print(
            f"|perp_dev| µm: min={min(devs_um):.1f} median={np.median(devs_um):.1f} "
            f"mean={np.mean(devs_um):.1f} p90={np.percentile(devs_um, 90):.1f} "
            f"max={max(devs_um):.1f}"
        )

    # ── Visualize ───────────────────────────────────────────────────────
    vis = img.copy()

    # Dim Canny edges (white, faint)
    gray = preprocess(img, smoothing=args.smoothing)
    edges = cv2.Canny(gray, args.canny_low, args.canny_high)
    ys, xs = np.where(edges > 0)
    vis[ys, xs] = (200, 200, 200)

    # tip & root circles in faint gray
    cv2.circle(vis, (int(round(tip_cx_px)), int(round(tip_cy_px))),
               int(round(tip_r_px)), (140, 140, 140), 1, cv2.LINE_AA)
    cv2.circle(vis, (int(round(tip_cx_px)), int(round(tip_cy_px))),
               int(round(root_r_px)), (140, 140, 140), 1, cv2.LINE_AA)

    # Nominal projected entities (cyan)
    for ent in entities:
        x1 = ent["x1"] * ppm + tip_cx_px
        y1 = ent["y1"] * ppm + tip_cy_px
        x2 = ent["x2"] * ppm + tip_cx_px
        y2 = ent["y2"] * ppm + tip_cy_px
        cv2.line(vis, (int(round(x1)), int(round(y1))),
                 (int(round(x2)), int(round(y2))),
                 (255, 255, 0), 1, cv2.LINE_AA)

    # Fit lines — color by deviation. Green = pass, orange = warn, red = fail.
    # Also draw the actual fit endpoints returned by the inspector.
    for r in results:
        if not r.get("matched"):
            continue
        fit = r.get("fit")
        if not fit:
            continue
        dev_um = (r["perp_dev_mm"] or 0.0) * 1000
        if abs(dev_um) < 25:
            color = (0, 255, 0)  # green
        elif abs(dev_um) < 75:
            color = (0, 165, 255)  # orange
        else:
            color = (0, 0, 255)  # red
        cv2.line(vis,
                 (int(round(fit["x1"])), int(round(fit["y1"]))),
                 (int(round(fit["x2"])), int(round(fit["y2"]))),
                 color, 2, cv2.LINE_AA)

    out_path = base.with_name(f"{base.name}_debug_inspect_N{args.n_teeth}_ph{int(round(args.phase))}.png")
    cv2.imwrite(str(out_path), vis)
    print(f"wrote {out_path}")

    # Also write a per-tooth CSV so we can see which segments failed.
    csv_path = base.with_name(f"{base.name}_debug_inspect_N{args.n_teeth}_ph{int(round(args.phase))}.csv")
    with csv_path.open("w") as f:
        f.write("handle,tooth_index,region,matched,perp_dev_um,reason\n")
        for ent, r in zip(entities, results):
            dev_um = (r["perp_dev_mm"] or 0.0) * 1000 if r.get("perp_dev_mm") is not None else ""
            f.write(f"{ent['handle']},{ent['tooth_index']},{ent['region']},"
                    f"{r.get('matched')},{dev_um},{r.get('reason') or ''}\n")
    print(f"wrote {csv_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
