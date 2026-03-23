"""
Visual detection test runner.

Usage:
    python tests/run_visual.py

Reads every JPEG from snapshots/, runs detection, writes annotated results
to tests/output/. Open that folder in Finder to review.

Each snapshot produces:
    <name>_circles.jpg   — circles at 4 sensitivity levels side by side
    <name>_edges.jpg     — Canny edge overlay at 3 threshold pairs
    <name>_lines.jpg     — HoughLinesP line segments at 3 threshold levels
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

SNAPSHOTS = ROOT / "snapshots"
OUTPUT = ROOT / "tests" / "output"

# ── helpers ────────────────────────────────────────────────────────────────


def label(img: np.ndarray, text: str) -> np.ndarray:
    """Draw a white label with black shadow in the top-left corner."""
    out = img.copy()
    for dx, dy, color in [(-1, -1, (0, 0, 0)), (0, 0, (255, 255, 255))]:
        cv2.putText(
            out, text,
            (10 + dx, 28 + dy),
            cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2,
        )
    return out


def hstack(*imgs: np.ndarray) -> np.ndarray:
    """Stack images horizontally, all resized to the same height."""
    h = imgs[0].shape[0]
    resized = []
    for im in imgs:
        if im.shape[0] != h:
            scale = h / im.shape[0]
            im = cv2.resize(im, None, fx=scale, fy=scale)
        resized.append(im)
    return np.hstack(resized)


def enhance(gray: np.ndarray) -> np.ndarray:
    """CLAHE with a larger tile to avoid amplifying fine texture."""
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(16, 16))
    return clahe.apply(gray)


def denoise(gray: np.ndarray) -> np.ndarray:
    """Bilateral filter: smooths surface texture while preserving sharp edges."""
    return cv2.bilateralFilter(gray, d=9, sigmaColor=75, sigmaSpace=75)


# ── per-algorithm render functions ─────────────────────────────────────────


def render_circles(frame: np.ndarray, param2: int, min_radius: int, max_radius: int) -> np.ndarray:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = enhance(gray)
    gray = denoise(gray)
    gray = cv2.GaussianBlur(gray, (5, 5), 1)
    result = cv2.HoughCircles(
        gray, cv2.HOUGH_GRADIENT,
        dp=1.2, minDist=50,
        param1=100, param2=param2,
        minRadius=min_radius, maxRadius=max_radius,
    )
    vis = frame.copy()
    n = 0
    if result is not None:
        for x, y, r in np.round(result[0]).astype(int):
            cv2.circle(vis, (x, y), r, (0, 220, 0), 2)
            cv2.circle(vis, (x, y), 3, (0, 0, 255), -1)
            n += 1
    return label(vis, f"circles p2={param2}  n={n}")


def render_edges(frame: np.ndarray, t1: int, t2: int) -> np.ndarray:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = enhance(gray)
    gray = denoise(gray)
    edges = cv2.Canny(gray, t1, t2)
    vis = frame.copy()
    vis[edges > 0] = (0, 220, 255)
    return label(vis, f"edges {t1}/{t2}")


def render_preprocessed(frame: np.ndarray) -> np.ndarray:
    """Show the image the detector actually sees after preprocessing."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = enhance(gray)
    gray = denoise(gray)
    bgr = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    return label(bgr, "preprocessed (CLAHE+bilateral)")


def render_lines(frame: np.ndarray, canny_lo: int, canny_hi: int, threshold: int, min_length: int, max_gap: int) -> np.ndarray:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = enhance(gray)
    gray = denoise(gray)
    edges = cv2.Canny(gray, canny_lo, canny_hi)
    lines = cv2.HoughLinesP(
        edges, rho=1, theta=np.pi / 180,
        threshold=threshold,
        minLineLength=min_length,
        maxLineGap=max_gap,
    )
    vis = frame.copy()
    n = 0
    if lines is not None:
        for x1, y1, x2, y2 in lines[:, 0]:
            cv2.line(vis, (x1, y1), (x2, y2), (0, 100, 255), 2)
            n += 1
    return label(vis, f"lines C={canny_lo}/{canny_hi} thr={threshold} minL={min_length} n={n}")


# ── main ───────────────────────────────────────────────────────────────────


def process(img_path: Path) -> None:
    frame = cv2.imread(str(img_path))
    if frame is None:
        print(f"  skip (unreadable): {img_path.name}")
        return

    name = img_path.stem
    h, w = frame.shape[:2]
    # Reasonable radius bounds based on image size
    min_r = max(10, w // 60)
    max_r = w // 2

    # --- preprocessed view ---
    cv2.imwrite(str(OUTPUT / f"{name}_preprocessed.jpg"), render_preprocessed(frame))

    # --- circles: focus on p2=30-55 range where bilateral helps most ---
    panels = [
        render_circles(frame, param2=30, min_radius=min_r, max_radius=max_r),
        render_circles(frame, param2=40, min_radius=min_r, max_radius=max_r),
        render_circles(frame, param2=50, min_radius=min_r, max_radius=max_r),
        render_circles(frame, param2=55, min_radius=min_r, max_radius=max_r),
    ]
    cv2.imwrite(str(OUTPUT / f"{name}_circles.jpg"), hstack(*panels))

    # --- edges ---
    panels = [
        render_edges(frame, 30, 90),
        render_edges(frame, 50, 150),
        render_edges(frame, 80, 200),
    ]
    cv2.imwrite(str(OUTPUT / f"{name}_edges.jpg"), hstack(*panels))

    # --- lines: vary Canny thresholds AND HoughLinesP params ---
    panels = [
        # Loose: catch shorter segments like tick marks
        render_lines(frame, canny_lo=40, canny_hi=100, threshold=20, min_length=15, max_gap=5),
        # Medium
        render_lines(frame, canny_lo=60, canny_hi=140, threshold=40, min_length=30, max_gap=8),
        # Tight: only long strong lines
        render_lines(frame, canny_lo=80, canny_hi=200, threshold=60, min_length=50, max_gap=10),
    ]
    cv2.imwrite(str(OUTPUT / f"{name}_lines.jpg"), hstack(*panels))

    print(f"  {name} → circles / edges / lines")


def main() -> None:
    OUTPUT.mkdir(exist_ok=True)
    images = sorted(SNAPSHOTS.glob("*.jpg"))
    if not images:
        print("No snapshots found. Capture some via the server first.")
        sys.exit(1)

    print(f"Processing {len(images)} snapshot(s)…")
    for p in images:
        process(p)
    print(f"\nDone. Results in: {OUTPUT}")
    print("Open with:  open tests/output/")


if __name__ == "__main__":
    main()
