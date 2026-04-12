#!/usr/bin/env python3
"""Deflectometry repeatability analysis.

Captures N runs back-to-back without touching the setup, saves all raw
frames and diagnostics, then analyses run-to-run variation to separate
systematic errors from random noise and unwrap failures.

Prerequisites: server running, iPad paired, flat field done.

Usage:
    .venv/bin/python scripts/dev/deflectometry_repeatability.py [--runs 10] [--freq 16]
"""

import argparse
import json
import os
import sys
import time

import cv2
import numpy as np
from urllib.request import urlopen, Request as UrlRequest
from urllib.error import HTTPError

BASE = "http://localhost:8000"
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "poc_output", "deflectometry_repeatability")


def api(method, path, json_body=None):
    url = BASE + path
    if json_body is not None:
        data = json.dumps(json_body).encode()
        req = UrlRequest(url, data=data, headers={"Content-Type": "application/json"}, method=method.upper())
    else:
        req = UrlRequest(url, method=method.upper())
    try:
        with urlopen(req) as resp:
            return json.loads(resp.read())
    except HTTPError as e:
        print(f"  ERROR {e.code}: {e.read().decode()}")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--freq", type=int, default=16)
    args = parser.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)

    # Check status
    status = api("get", "/deflectometry/status")
    if not status.get("ipad_connected"):
        print("iPad not connected. Pair first.")
        sys.exit(1)
    print(f"Session: {status['session_id']}, flat field: {status.get('has_flat_field')}")
    if not status.get("has_flat_field"):
        print("WARNING: no flat field captured. Results will include backlight/vignetting errors.")

    # Import deflectometry functions for local analysis
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
    from backend.vision.deflectometry import (
        compute_modulation, compute_wrapped_phase, unwrap_phase, remove_tilt, phase_stats,
    )

    all_stats_x = []
    all_stats_y = []
    all_unw_x = []
    all_unw_y = []
    all_mod_x = []
    all_mod_y = []

    print(f"\nCapturing {args.runs} runs (freq={args.freq})...\n")

    for run in range(args.runs):
        print(f"--- Run {run + 1}/{args.runs} ---")

        # Capture
        api("post", "/deflectometry/capture-sequence", json_body={"freq": args.freq})
        print("  Captured 8 frames")

        # Get diagnostics (saves raw frames too)
        diag = api("post", "/deflectometry/diagnostics")
        print(f"  Frames saved to {diag['frames_saved_to']}")

        # Copy raw frames to per-run directory
        run_dir = os.path.join(OUT_DIR, f"run_{run:03d}")
        os.makedirs(run_dir, exist_ok=True)

        src_dir = diag["frames_saved_to"]
        for fname in os.listdir(src_dir):
            if fname.endswith(".png"):
                src = os.path.join(src_dir, fname)
                dst = os.path.join(run_dir, fname)
                import shutil
                shutil.copy2(src, dst)

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

        mod_x = compute_modulation(frames_x)
        mod_y = compute_modulation(frames_y)
        wrap_x = compute_wrapped_phase(frames_x)
        wrap_y = compute_wrapped_phase(frames_y)
        unw_x = remove_tilt(unwrap_phase(wrap_x, orientation="x"))
        unw_y = remove_tilt(unwrap_phase(wrap_y, orientation="y"))

        sx = phase_stats(unw_x)
        sy = phase_stats(unw_y)
        all_stats_x.append(sx)
        all_stats_y.append(sy)
        all_unw_x.append(unw_x)
        all_unw_y.append(unw_y)
        all_mod_x.append(mod_x)
        all_mod_y.append(mod_y)

        print(f"  X: PV={sx['pv']:.3f}  RMS={sx['rms']:.3f}  mod_mean={mod_x.mean():.1f}")
        print(f"  Y: PV={sy['pv']:.3f}  RMS={sy['rms']:.3f}  mod_mean={mod_y.mean():.1f}")

        # Small delay between runs to let LCD fully settle
        if run < args.runs - 1:
            time.sleep(0.5)

    # ── Analysis ──
    print("\n" + "=" * 60)
    print("REPEATABILITY ANALYSIS")
    print("=" * 60)

    pvx = [s["pv"] for s in all_stats_x]
    pvy = [s["pv"] for s in all_stats_y]
    rmsx = [s["rms"] for s in all_stats_x]
    rmsy = [s["rms"] for s in all_stats_y]

    print(f"\nPV X:  mean={np.mean(pvx):.3f}  std={np.std(pvx):.3f}  min={np.min(pvx):.3f}  max={np.max(pvx):.3f}")
    print(f"PV Y:  mean={np.mean(pvy):.3f}  std={np.std(pvy):.3f}  min={np.min(pvy):.3f}  max={np.max(pvy):.3f}")
    print(f"RMS X: mean={np.mean(rmsx):.3f}  std={np.std(rmsx):.3f}  min={np.min(rmsx):.3f}  max={np.max(rmsx):.3f}")
    print(f"RMS Y: mean={np.mean(rmsy):.3f}  std={np.std(rmsy):.3f}  min={np.min(rmsy):.3f}  max={np.max(rmsy):.3f}")

    # Pixel-wise standard deviation across runs (measures random noise)
    stack_x = np.stack(all_unw_x, axis=0)  # (N, H, W)
    stack_y = np.stack(all_unw_y, axis=0)
    pixstd_x = stack_x.std(axis=0)
    pixstd_y = stack_y.std(axis=0)

    print(f"\nPixel-wise std across {args.runs} runs (random noise):")
    print(f"  X: mean={pixstd_x.mean():.4f}  median={np.median(pixstd_x):.4f}  max={pixstd_x.max():.4f} rad")
    print(f"  Y: mean={pixstd_y.mean():.4f}  median={np.median(pixstd_y):.4f}  max={pixstd_y.max():.4f} rad")

    # Check for unwrap failures: runs where PV jumps significantly
    median_pvx = np.median(pvx)
    median_pvy = np.median(pvy)
    unwrap_fails_x = [i for i, p in enumerate(pvx) if p > median_pvx * 2]
    unwrap_fails_y = [i for i, p in enumerate(pvy) if p > median_pvy * 2]

    if unwrap_fails_x:
        print(f"\n  UNWRAP SUSPECT (X): runs {unwrap_fails_x} have PV > 2x median ({median_pvx:.3f})")
    if unwrap_fails_y:
        print(f"  UNWRAP SUSPECT (Y): runs {unwrap_fails_y} have PV > 2x median ({median_pvy:.3f})")
    if not unwrap_fails_x and not unwrap_fails_y:
        print("\n  No obvious unwrap failures detected.")

    # Modulation analysis
    mod_x_means = [m.mean() for m in all_mod_x]
    mod_y_means = [m.mean() for m in all_mod_y]
    print(f"\nModulation (fringe contrast):")
    print(f"  X: mean={np.mean(mod_x_means):.1f}  std={np.std(mod_x_means):.1f}")
    print(f"  Y: mean={np.mean(mod_y_means):.1f}  std={np.std(mod_y_means):.1f}")

    # Low-modulation pixel fraction (threshold: 10% of max modulation)
    thresh_x = np.max([m.max() for m in all_mod_x]) * 0.1
    thresh_y = np.max([m.max() for m in all_mod_y]) * 0.1
    low_mod_frac_x = [float((m < thresh_x).mean()) for m in all_mod_x]
    low_mod_frac_y = [float((m < thresh_y).mean()) for m in all_mod_y]
    print(f"  Low-modulation pixel fraction (<10% of max):")
    print(f"    X: {np.mean(low_mod_frac_x)*100:.1f}%")
    print(f"    Y: {np.mean(low_mod_frac_y)*100:.1f}%")

    # Save summary
    summary = {
        "runs": args.runs,
        "freq": args.freq,
        "has_flat_field": status.get("has_flat_field", False),
        "pv_x": pvx, "pv_y": pvy,
        "rms_x": rmsx, "rms_y": rmsy,
        "pixel_std_x_mean": float(pixstd_x.mean()),
        "pixel_std_y_mean": float(pixstd_y.mean()),
        "pixel_std_x_median": float(np.median(pixstd_x)),
        "pixel_std_y_median": float(np.median(pixstd_y)),
        "modulation_x_means": mod_x_means,
        "modulation_y_means": mod_y_means,
        "low_mod_frac_x": float(np.mean(low_mod_frac_x)),
        "low_mod_frac_y": float(np.mean(low_mod_frac_y)),
        "unwrap_suspects_x": unwrap_fails_x,
        "unwrap_suspects_y": unwrap_fails_y,
    }
    summary_path = os.path.join(OUT_DIR, "summary.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"\nSummary saved to {summary_path}")

    # Save pixel-wise std maps as images
    from backend.vision.deflectometry import pseudocolor_png_b64
    import base64
    for name, arr in [("pixstd_x", pixstd_x), ("pixstd_y", pixstd_y)]:
        norm = arr - arr.min()
        mx = norm.max()
        if mx > 0:
            norm = (norm / mx * 255).astype(np.uint8)
        else:
            norm = np.zeros_like(arr, dtype=np.uint8)
        colored = cv2.applyColorMap(norm, cv2.COLORMAP_VIRIDIS)
        cv2.imwrite(os.path.join(OUT_DIR, f"{name}.png"), colored)

    print(f"Pixel-std maps saved to {OUT_DIR}/pixstd_*.png")
    print("\nDone.")


if __name__ == "__main__":
    main()
