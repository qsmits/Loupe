import cv2
import numpy as np

# ── Circle detection constants ────────────────────────────────────────────────
_CIRCULARITY_THRESHOLD  = 0.65   # min 4π·area/perimeter² for closed contours
_RADIUS_STD_MAX         = 0.06   # max std(point distances from centre) / radius
_ARC_MIN_COVERAGE       = 160    # degrees of arc for open-contour fit
_ARC_MAX_RESIDUAL       = 0.06   # max mean residual / radius for arc fit
_NMS_OVERLAP            = 0.5    # IoU threshold for non-maximum suppression
_NMS_CONCENTRIC_R_RATIO = 0.7    # radii ratio below which circles are kept despite overlap
_LARGE_R_THRESHOLD      = 60     # px — selective large-kernel closing above this radius
_CLOSE_KERNEL_SMALL     = 3      # morphological close kernel for all contours
_CLOSE_KERNEL_LARGE     = 7      # extra close kernel, only used when enc. radius is large

# ── Line merging constants ────────────────────────────────────────────────────
_MERGE_ANGLE_TOL_DEG   = 5.0
_MERGE_GAP_TOL_PX      = 15
_MERGE_PERP_TOL_PX     = 10
_MERGE_HOUGH_THRESHOLD = 30
_MERGE_MIN_LENGTH      = 20
_MERGE_MAX_GAP         = 8


def _preprocess(frame: np.ndarray) -> np.ndarray:
    """
    Convert to grayscale, boost local contrast with CLAHE, then apply a
    bilateral filter to smooth surface texture while preserving sharp edges
    (circle rims, machined boundaries, tick marks).
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(16, 16))
    gray = clahe.apply(gray)
    gray = cv2.bilateralFilter(gray, d=9, sigmaColor=75, sigmaSpace=75)
    return gray


def detect_edges(frame: np.ndarray, threshold1: int, threshold2: int) -> bytes:
    """
    Run Canny edge detection on frame.
    Returns a PNG image (RGBA, edges white on transparent background) as bytes.
    """
    gray = _preprocess(frame)
    edges = cv2.Canny(gray, threshold1, threshold2)

    # Build RGBA image: edges are white, background transparent
    rgba = np.zeros((*edges.shape, 4), dtype=np.uint8)
    rgba[edges > 0] = [255, 255, 255, 255]

    ok, buf = cv2.imencode(".png", rgba)
    if not ok:
        raise RuntimeError("Failed to encode edge image as PNG")
    return buf.tobytes()


def _circle_overlap_ratio(c1: tuple, c2: tuple) -> float:
    d = np.hypot(c1[0] - c2[0], c1[1] - c2[1])
    if d >= c1[2] + c2[2]:
        return 0.0
    r_ratio = min(c1[2], c2[2]) / (max(c1[2], c2[2]) + 1e-6)
    if r_ratio < _NMS_CONCENTRIC_R_RATIO:
        return 0.0
    return 1.0 - d / (c1[2] + c2[2] + 1e-6)


def _nms_circles(circles: list) -> list:
    circles = sorted(circles, key=lambda c: c[3], reverse=True)
    kept = []
    for c in circles:
        if all(_circle_overlap_ratio(c[:3], k[:3]) < _NMS_OVERLAP for k in kept):
            kept.append(c)
    return kept


def _fit_circle_algebraic(pts: np.ndarray):
    x, y = pts[:, 0], pts[:, 1]
    A = np.column_stack([2 * x, 2 * y, np.ones(len(x))])
    b = x ** 2 + y ** 2
    result, _, _, _ = np.linalg.lstsq(A, b, rcond=None)
    cx, cy = result[0], result[1]
    r = np.sqrt(result[2] + cx ** 2 + cy ** 2)
    return cx, cy, r


def _arc_angular_coverage(pts: np.ndarray, cx: float, cy: float) -> float:
    angles = np.degrees(np.arctan2(pts[:, 1] - cy, pts[:, 0] - cx))
    angles = np.sort(angles % 360)
    if len(angles) < 2:
        return 0.0
    gaps = np.diff(angles, append=angles[0] + 360)
    return 360.0 - float(np.max(gaps))


def detect_circles(
    frame: np.ndarray,
    dp: float = 1.2,
    min_dist: int = 50,
    param1: int = 100,
    param2: int = 50,
    min_radius: int = 8,
    max_radius: int = 500,
) -> list[dict]:
    """
    Contour-based circle detection.
    Closed contours are accepted by circularity score + radius consistency.
    Open contours are fitted with algebraic least-squares and accepted by arc coverage.
    Two Canny passes (tight + loose) improve recall in poorly lit images.
    Returns list of {"x": int, "y": int, "radius": int}.
    The legacy Hough parameters (dp, min_dist, param1, param2) are accepted for API
    compatibility but are not used.
    """
    gray = _preprocess(frame)
    k_small = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_CLOSE_KERNEL_SMALL,) * 2)
    k_large = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_CLOSE_KERNEL_LARGE,) * 2)

    closed: list[tuple] = []
    arcs:   list[tuple] = []

    def _try_contour(cnt: np.ndarray) -> None:
        pts = cnt[:, 0, :].astype(np.float32)
        if len(pts) < 12:
            return
        area = cv2.contourArea(cnt)
        perimeter = cv2.arcLength(cnt, closed=True)
        if perimeter < 1:
            return
        (cx, cy), enc_r = cv2.minEnclosingCircle(cnt)

        circularity = 4 * np.pi * area / (perimeter ** 2)
        if circularity >= _CIRCULARITY_THRESHOLD:
            r = int(round(enc_r))
            if not (min_radius <= r <= max_radius):
                return
            dists = np.hypot(pts[:, 0] - cx, pts[:, 1] - cy)
            if np.std(dists) / (r + 1e-6) > _RADIUS_STD_MAX:
                return
            closed.append((int(cx), int(cy), r, round(circularity, 3)))
            return

        if not (min_radius <= enc_r <= max_radius):
            return
        try:
            fcx, fcy, fr = _fit_circle_algebraic(pts)
        except (np.linalg.LinAlgError, ValueError):
            return
        if not (min_radius <= fr <= max_radius):
            return
        residuals = np.abs(np.hypot(pts[:, 0] - fcx, pts[:, 1] - fcy) - fr)
        if np.mean(residuals) / (fr + 1e-6) > _ARC_MAX_RESIDUAL:
            return
        coverage = _arc_angular_coverage(pts, fcx, fcy)
        if coverage < _ARC_MIN_COVERAGE:
            return
        arcs.append((int(fcx), int(fcy), int(round(fr)), round(coverage, 1)))

    def _run_on_edges(base_edges: np.ndarray) -> None:
        edges_s = cv2.morphologyEx(base_edges, cv2.MORPH_CLOSE, k_small)
        edges_l = cv2.morphologyEx(base_edges, cv2.MORPH_CLOSE, k_large)
        for cnt in cv2.findContours(edges_s, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)[0]:
            _try_contour(cnt)
        for cnt in cv2.findContours(edges_l, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)[0]:
            _, enc_r = cv2.minEnclosingCircle(cnt)
            if enc_r >= _LARGE_R_THRESHOLD:
                _try_contour(cnt)

    _run_on_edges(cv2.Canny(gray, 50, 150))

    # Loose pass for faint edges; limited to small circles to avoid large false positives.
    loose_edges = cv2.Canny(gray, 20, 80)
    edges_s = cv2.morphologyEx(loose_edges, cv2.MORPH_CLOSE, k_small)
    for cnt in cv2.findContours(edges_s, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)[0]:
        _, enc_r = cv2.minEnclosingCircle(cnt)
        if enc_r < _LARGE_R_THRESHOLD:
            _try_contour(cnt)

    closed = _nms_circles(closed)
    arcs = _nms_circles(arcs)
    arcs = [a for a in arcs
            if all(_circle_overlap_ratio(a[:3], c[:3]) < _NMS_OVERLAP for c in closed)]

    return [{"x": cx, "y": cy, "radius": r} for cx, cy, r, _ in closed + arcs]


def detect_lines(
    frame: np.ndarray,
    threshold1: int,
    threshold2: int,
    hough_threshold: int,
    min_length: int,
    max_gap: int,
) -> list[dict]:
    """
    Detect line segments using Canny + HoughLinesP.
    Returns list of {"x1", "y1", "x2", "y2", "length"} dicts.
    'length' is the Euclidean length of the segment in pixels.
    """
    gray = _preprocess(frame)
    edges = cv2.Canny(gray, threshold1, threshold2)
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=hough_threshold,
        minLineLength=min_length,
        maxLineGap=max_gap,
    )
    if lines is None:
        return []
    result = []
    for x1, y1, x2, y2 in lines[:, 0]:
        length = float(np.hypot(x2 - x1, y2 - y1))
        result.append({
            "x1": int(x1), "y1": int(y1),
            "x2": int(x2), "y2": int(y2),
            "length": round(length, 1),
        })
    return result


def merge_line_segments(
    frame: np.ndarray,
    threshold1: int = 50,
    threshold2: int = 130,
    hough_threshold: int = _MERGE_HOUGH_THRESHOLD,
    min_length: int = _MERGE_MIN_LENGTH,
    max_gap: int = _MERGE_MAX_GAP,
    angle_tol_deg: float = _MERGE_ANGLE_TOL_DEG,
    gap_tol_px: float = _MERGE_GAP_TOL_PX,
    perp_tol_px: float = _MERGE_PERP_TOL_PX,
) -> list[dict]:
    """
    Detect line segments via Hough, then merge collinear fragments.
    A single straight edge always produces at most one output segment.
    T-junctions/corners producing two segments from genuinely separate edges are correct.
    Returns list of {"x1", "y1", "x2", "y2", "length"} dicts.
    """
    gray = _preprocess(frame)
    edges = cv2.Canny(gray, threshold1, threshold2)
    raw = cv2.HoughLinesP(edges, 1, np.pi/180, hough_threshold,
                          minLineLength=min_length, maxLineGap=max_gap)
    if raw is None:
        return []

    segs = []
    for x1, y1, x2, y2 in raw[:, 0]:
        angle = float(np.degrees(np.arctan2(y2-y1, x2-x1)) % 180)
        segs.append((x1, y1, x2, y2, angle))
    segs.sort(key=lambda s: s[4])

    def _perp(x1, y1, x2, y2):
        dx, dy = x2-x1, y2-y1
        return abs(dy*x1 - dx*y1) / (np.hypot(dx, dy) + 1e-6)

    clusters = []
    cur = [segs[0]]
    for s in segs[1:]:
        if abs(s[4] - cur[0][4]) <= angle_tol_deg:
            cur.append(s)
        else:
            clusters.append(cur); cur = [s]
    clusters.append(cur)

    results = []
    for cluster in clusters:
        cluster.sort(key=lambda s: _perp(*s[:4]))
        sub_clusters = [[cluster[0]]]
        for s in cluster[1:]:
            if abs(_perp(*s[:4]) - _perp(*sub_clusters[-1][0][:4])) <= perp_tol_px:
                sub_clusters[-1].append(s)
            else:
                sub_clusters.append([s])

        for sub in sub_clusters:
            rx1, ry1, rx2, ry2 = sub[0][:4]
            rlen = np.hypot(rx2-rx1, ry2-ry1) + 1e-6
            ux, uy = (rx2-rx1)/rlen, (ry2-ry1)/rlen
            # Build spans: each raw segment contributes one [t_min, t_max] span
            # (projecting both endpoints onto the reference direction).
            spans = []
            for x1, y1, x2, y2, _ in sub:
                t1 = x1*ux + y1*uy
                t2 = x2*ux + y2*uy
                lo, hi = (t1, t2) if t1 <= t2 else (t2, t1)
                # keep track of which actual point is at each extreme
                if t1 <= t2:
                    spans.append((lo, hi, x1, y1, x2, y2))
                else:
                    spans.append((lo, hi, x2, y2, x1, y1))
            spans.sort()
            # Merge overlapping / close spans
            cur_lo, cur_hi, cx1, cy1, cx2, cy2 = spans[0]
            for lo, hi, sx1, sy1, sx2, sy2 in spans[1:]:
                if lo - cur_hi <= gap_tol_px:
                    # extend current span
                    if hi > cur_hi:
                        cur_hi = hi
                        cx2, cy2 = sx2, sy2
                else:
                    length = float(np.hypot(cx2-cx1, cy2-cy1))
                    if length >= min_length:
                        results.append({"x1":int(cx1),"y1":int(cy1),"x2":int(cx2),"y2":int(cy2),"length":round(length,1)})
                    cur_lo, cur_hi, cx1, cy1, cx2, cy2 = lo, hi, sx1, sy1, sx2, sy2
            length = float(np.hypot(cx2-cx1, cy2-cy1))
            if length >= min_length:
                results.append({"x1":int(cx1),"y1":int(cy1),"x2":int(cx2),"y2":int(cy2),"length":round(length,1)})

    return results


def preprocessed_view(frame: np.ndarray) -> bytes:
    """
    Return the CLAHE+bilateral preprocessed grayscale image as JPEG bytes.
    Useful for diagnosing why detection succeeds or fails on a given frame.
    """
    gray = _preprocess(frame)
    ok, buf = cv2.imencode(".jpg", gray, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        raise RuntimeError("Failed to encode preprocessed image")
    return buf.tobytes()
