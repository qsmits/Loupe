# backend/vision/alignment.py
import math
import cv2
import numpy as np
from .detection import preprocess


def extract_dxf_circles(entities):
    """Return list of (cx_mm, cy_mm, r_mm) from DXF entities (circles only)."""
    return [
        (float(e["cx"]), float(e["cy"]), float(e["radius"]))
        for e in entities
        if e.get("type") == "circle"
    ]


def _compute_transform(p1, p2, q1, q2):
    """Compute (tx, ty, angle_rad) mapping p1->q1, p2->q2.
    p1, p2: DXF pixel coordinates (Y-up, after flipping)
    q1, q2: canvas pixel coordinates (Y-down)
    The transform applies as: mx = dx*cos - dy*sin + tx,  my = -(dx*sin + dy*cos) + ty

    Derivation: treating dp = (dpx, dpy) and dq = (dqx, dqy),
    the transform gives dqx = dpx*cos - dpy*sin, dqy = -(dpx*sin + dpy*cos).
    Using complex arithmetic: e^{ia} = (dqx - i*dqy) / (dpx + i*dpy)
    So: angle = atan2(-dqy, dqx) - atan2(dpy, dpx)
              = atan2(-dq[1], dq[0]) - atan2(dp[1], dp[0])
    """
    dp = p2 - p1
    dq = q2 - q1
    angle = math.atan2(-float(dq[1]), float(dq[0])) - math.atan2(float(dp[1]), float(dp[0]))
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    # Rotate p1 in DXF Y-up space
    rp1_x = float(p1[0]) * cos_a - float(p1[1]) * sin_a
    rp1_y = float(p1[0]) * sin_a + float(p1[1]) * cos_a
    # Canvas position of p1: (rp1_x + tx, -rp1_y + ty) = q1
    tx = float(q1[0]) - rp1_x
    ty = float(q1[1]) + rp1_y  # ty = q1[1] + rp1_y because canvas_y = -rp1_y + ty
    return tx, ty, angle


def _score_transform(dxf_px, detected_px, tx, ty, angle):
    """Score a (tx, ty, angle) transform against detected circles.
    dxf_px: DXF pixel coords (Y-up, after flipping)
    detected_px: canvas pixel coords (Y-down)
    Transform: mx = dx*cos - dy*sin + tx,  my = -(dx*sin + dy*cos) + ty
    """
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    inliers = []
    used: set[int] = set()  # detected circles already claimed — enforce one-to-one
    for i, (dx, dy, dr) in enumerate(dxf_px):
        mx = dx * cos_a - dy * sin_a + tx
        my = -(dx * sin_a + dy * cos_a) + ty  # Y-flip: DXF Y-up → canvas Y-down
        threshold = max(10.0, 0.15 * dr)
        best_j, best_d = -1, threshold
        for j, (ex, ey, er) in enumerate(detected_px):
            if j in used:
                continue
            if abs(dr - er) / (max(dr, er) + 1e-6) > 0.3:
                continue
            d = math.hypot(mx - ex, my - ey)
            if d < best_d:  # nearest unused detection within threshold
                best_d, best_j = d, j
        if best_j >= 0:
            inliers.append((i, best_j))
            used.add(best_j)
    return inliers


def _refine_transform(dxf_px, detected_px, inliers):
    """Closed-form least-squares (Procrustes) over inlier pairs.
    Maps DXF Y-up pixel positions → canvas Y-down pixel positions.
    Negates src Y to match canvas Y-down convention before SVD.
    """
    if len(inliers) < 2:
        return None
    # Negate DXF Y to convert to canvas Y-down before Procrustes
    src = np.array([[dxf_px[i][0], -dxf_px[i][1]] for i, _ in inliers], dtype=float)
    dst = np.array([[detected_px[j][0], detected_px[j][1]] for _, j in inliers], dtype=float)
    src_c = src.mean(axis=0)
    dst_c = dst.mean(axis=0)
    src_n = src - src_c
    dst_n = dst - dst_c
    H = src_n.T @ dst_n
    U, _, Vt = np.linalg.svd(H)
    R = Vt.T @ U.T
    # Ensure proper rotation (det=1)
    if np.linalg.det(R) < 0:
        Vt[-1, :] *= -1
        R = Vt.T @ U.T
    # R maps Y-flipped DXF → canvas Y-down. The Procrustes angle is in Y-down space.
    # _score_transform uses DXF Y-up angle, which is the negation.
    angle = -math.atan2(float(R[1, 0]), float(R[0, 0]))
    t = dst_c - R @ src_c
    return float(t[0]), float(t[1]), angle


def align_circles(dxf_circles, detected_circles, pixels_per_mm):
    """
    Find the best-fit rigid transform mapping DXF circles onto detected circles.

    dxf_circles: list of (cx_mm, cy_mm, r_mm)
    detected_circles: list of (cx_px, cy_px, r_px) in canvas coordinates
      (Y-down, origin top-left)
    pixels_per_mm: calibration scale

    Returns dict with keys:
      tx, ty, angle_deg, scale, flip_h, flip_v,
      inlier_count, total_dxf_circles, confidence
    OR on error:
      error: str
    """
    if len(dxf_circles) < 2:
        return {"error": "insufficient_dxf_circles"}

    # Scale DXF to pixels (Y still pointing up — canvas Y-flip applied later)
    dxf_px = [(cx * pixels_per_mm, cy * pixels_per_mm, r * pixels_per_mm)
               for cx, cy, r in dxf_circles]
    det_px = list(detected_circles)

    best_score = (-1, math.pi + 1)  # (inlier_count, abs_angle) — maximize count, minimize angle
    best_result = None

    for flip_h in (False, True):
        for flip_v in (False, True):
            flipped = [
                ((-cx if flip_h else cx), (-cy if flip_v else cy), r)
                for cx, cy, r in dxf_px
            ]
            n = len(flipped)
            m = len(det_px)
            for i in range(n):
                for j in range(i + 1, n):
                    for a in range(m):
                        for b in range(m):
                            if a == b:
                                continue
                            # Check radius ratio compatibility
                            r_dxf = sorted([flipped[i][2], flipped[j][2]])
                            r_det = sorted([det_px[a][2], det_px[b][2]])
                            ratio_dxf = r_dxf[0] / (r_dxf[1] + 1e-6)
                            ratio_det = r_det[0] / (r_det[1] + 1e-6)
                            if abs(ratio_dxf - ratio_det) > 0.3:
                                continue
                            p1 = np.array([flipped[i][0], flipped[i][1]])
                            p2 = np.array([flipped[j][0], flipped[j][1]])
                            q1 = np.array([det_px[a][0], det_px[a][1]])
                            q2 = np.array([det_px[b][0], det_px[b][1]])
                            if np.linalg.norm(p2 - p1) < 1e-6 or np.linalg.norm(q2 - q1) < 1e-6:
                                continue
                            tx, ty, angle = _compute_transform(p1, p2, q1, q2)
                            inliers = _score_transform(
                                flipped, det_px, tx, ty, angle
                            )
                            # Prefer more inliers; break ties by smallest |angle|
                            candidate_score = (len(inliers), -abs(angle))
                            if candidate_score > best_score:
                                best_score = candidate_score
                                best_result = (tx, ty, angle, flip_h, flip_v, flipped, inliers)

    if best_result is None or best_score[0] < 2:
        confidence = "failed"
        tx, ty, angle_rad = 0.0, 0.0, 0.0
        flip_h = flip_v = False
        inlier_count = 0
    else:
        tx, ty, angle_rad, flip_h, flip_v, flipped, inliers = best_result
        refined = _refine_transform(flipped, det_px, inliers)
        if refined:
            tx, ty, angle_rad = refined
            inliers = _score_transform(flipped, det_px, tx, ty, angle_rad)
        inlier_count = len(inliers)
        total = len(dxf_circles)
        if inlier_count >= max(2, total * 0.5):
            confidence = "high"
        elif inlier_count >= 2:
            confidence = "low"
        else:
            confidence = "failed"
        # Note: _compute_transform already accounts for the DXF Y-up → canvas Y-down
        # coordinate change, so the angle is always in DXF Y-up convention regardless
        # of flip state. No sign correction needed here.

    return {
        "tx": tx,
        "ty": ty,
        "angle_deg": math.degrees(angle_rad),
        "scale": pixels_per_mm,
        "flip_h": flip_h,
        "flip_v": flip_v,
        "inlier_count": inlier_count,
        "total_dxf_circles": len(dxf_circles),
        "confidence": confidence,
    }


# ── Edge-based alignment (no circles required) ──────────────────────────────

def align_dxf_edges(
    frame: np.ndarray,
    entities: list[dict],
    pixels_per_mm: float,
    angle_range: float = 5.0,
    angle_step: float = 0.5,
    smoothing: int = 2,
    canny_low: int = 60,
    canny_high: int = 150,
) -> dict:
    """
    Align a DXF to an image using edge template matching.
    Requires calibration (known px/mm) — searches position and rotation only.
    """
    if pixels_per_mm <= 0 or angle_range < 0 or angle_step <= 0:
        return {"success": False, "reason": "Invalid alignment scale or angle search"}
    h, w = frame.shape[:2]
    gray = preprocess(frame, smoothing=smoothing)
    raw_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, canny_low, canny_high) | cv2.Canny(raw_gray, canny_low, canny_high)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8))
    pad_x, pad_y = int(w * 0.3), int(h * 0.3)
    search = cv2.copyMakeBorder(edges, pad_y, pad_y, pad_x, pad_x, cv2.BORDER_CONSTANT, value=0)
    padding = 5
    best = None
    alignment_entities = [e for e in entities if e.get("alignment_datum")] or entities

    def evaluate(angle):
        rendered = _render_dxf_template(alignment_entities, pixels_per_mm, angle, padding)
        if rendered is None or rendered[0] is None or not np.any(rendered[0]):
            return None
        template, min_x, min_y = rendered
        th, tw = template.shape
        if th > search.shape[0] or tw > search.shape[1]:
            return None
        scores = cv2.matchTemplate(search, template, cv2.TM_CCORR_NORMED)
        # Allow partly clipped geometry, but require the template's center to
        # lie within the actual image. Padding must not be a winning location.
        x0, x1 = max(0, pad_x-tw//2), min(scores.shape[1], pad_x+w-tw//2)
        y0, y1 = max(0, pad_y-th//2), min(scores.shape[0], pad_y+h-th//2)
        if x0 >= x1 or y0 >= y1:
            return None
        _, score, _, loc = cv2.minMaxLoc(scores[y0:y1, x0:x1])
        x, y = loc[0]+x0, loc[1]+y0
        # Fractional translation from a valid concave correlation maximum.
        dx = _peak_offset(scores[y, x-1], scores[y, x], scores[y, x+1]) if x0 < x < x1-1 else 0
        dy = _peak_offset(scores[y-1, x], scores[y, x], scores[y+1, x]) if y0 < y < y1-1 else 0
        tx = x + dx - pad_x - min_x*pixels_per_mm + padding
        ty = y + dy - pad_y + th - padding + min_y*pixels_per_mm
        return {"score": float(score), "angle": float(angle), "tx": tx, "ty": ty}

    def consider(candidate):
        nonlocal best
        if candidate is not None and (best is None or candidate["score"] > best["score"]+1e-9 or
            (abs(candidate["score"]-best["score"]) <= 1e-9 and abs(candidate["angle"]) < abs(best["angle"]))):
            best = candidate

    for angle in np.arange(-angle_range, angle_range + angle_step/2, angle_step):
        consider(evaluate(float(np.clip(angle, -angle_range, angle_range))))
    if best is None:
        return {"success": False, "reason": "DXF template too large or empty at this scale"}
    if best["score"] < 0.01:
        return {"success": False, "reason": "No good match found"}
    fine_step = min(0.1, angle_step)
    coarse_angle = best["angle"]
    for angle in np.arange(max(-angle_range, coarse_angle-angle_step),
                           min(angle_range, coarse_angle+angle_step)+fine_step/2, fine_step):
        consider(evaluate(float(np.clip(angle, -angle_range, angle_range))))
    # Interpolate the angular score peak without applying a prior toward zero.
    if -angle_range+fine_step <= best["angle"] <= angle_range-fine_step:
        minus, plus = evaluate(best["angle"]-fine_step), evaluate(best["angle"]+fine_step)
        if minus is not None and plus is not None:
            shift = _peak_offset(minus["score"], best["score"], plus["score"])
            if shift:
                consider(evaluate(best["angle"] + shift*fine_step))

    tx, ty, angle, quality = _refine_edge_pose(raw_gray, entities, pixels_per_mm,
                                              best["tx"], best["ty"], best["angle"], angle_range)
    xs, ys = [], []
    for e in entities:
        if "x1" in e:
            xs.extend([e["x1"], e["x2"]]); ys.extend([e["y1"], e["y2"]])
        elif "cx" in e:
            xs.append(e["cx"]); ys.append(e["cy"])
    if not xs:
        return {"success": False, "reason": "No geometry in DXF"}
    dxf_cx, dxf_cy = (min(xs)+max(xs))/2, (min(ys)+max(ys))/2
    from .line_arc_matching import dxf_to_image_px
    img_cx, img_cy = dxf_to_image_px(dxf_cx, dxf_cy, pixels_per_mm, tx, ty, math.radians(angle))
    return {"success": True, "img_cx": img_cx, "img_cy": img_cy,
            "dxf_cx": dxf_cx, "dxf_cy": dxf_cy, "angle_deg": angle,
            "flip_h": False, "flip_v": False,
            "scale": float(pixels_per_mm), "score": best["score"], "refinement": quality}


def _peak_offset(minus, center, plus):
    curvature = minus + plus - 2*center
    if center < minus or center < plus or curvature >= -1e-12:
        return 0.0
    offset = (minus-plus)/(2*curvature)
    return float(offset) if abs(offset) <= 0.6 else 0.0


def _refine_edge_pose(gray, entities, ppm, tx, ty, angle_deg, angle_range):
    """Point-to-normal rigid registration against raw-image caliper edges.

    Explicit alignment_datum entities take precedence. Otherwise this is a
    global best fit of the drawing, as in the coarse matcher. A rank-deficient
    constraint system retains the coarse pose and explains why it cannot be
    refined; a single line or circle does not constrain all three pose axes.
    """
    from .caliper import float_frame, nominal_calipers, sample_caliper_edges
    gray = float_frame(gray)  # once, not once per iteration
    usable = [e for e in entities if e.get("type") in ("line", "polyline_line", "arc", "polyline_arc", "circle")]
    datums = [e for e in usable if e.get("alignment_datum")]
    if datums:
        usable = datums
    coarse = tx, ty, angle_deg
    quality = {"refined": False, "reason": "insufficient stable edge constraints", "datum_count": len(datums)}
    def fallback(reason="insufficient stable edge constraints"):
        return *coarse, {"refined": False, "reason": reason, "datum_count": len(datums)}
    for _ in range(8):
        centers, normals, widths = [], [], []
        for e in usable:
            try:
                c, n, width = nominal_calipers(e, ppm, tx, ty, math.radians(angle_deg), spacing=8)
            except (KeyError, ValueError):
                continue
            centers.extend(c); normals.extend(n); widths.append(width)
        if not centers:
            return fallback()
        centers, normals = np.array(centers), np.array(normals)
        # Bound sampling work on dense DXFs without favoring the first features.
        indices = np.linspace(0, len(centers)-1, min(1000, len(centers)), dtype=int)
        centers, normals = centers[indices], normals[indices]
        found = sample_caliper_edges(gray, centers, normals, corridor_px=4,
                                     width=min(5, min(widths)), sigma=1, min_contrast=20)
        if len(found.points) < max(12, 0.5*len(centers)):
            return fallback()
        c, n = centers[found.indices], found.normals
        base = np.clip(found.strengths**2 / np.median(found.strengths**2), 0.2, 5)
        # Solve about the weighted centroid of the calipers, not the DXF
        # origin (tx, ty): with the origin far from the part, a small
        # rotation about it is a large translation at the part, which both
        # couples the unknowns and trips the step gate below.
        pivot = np.average(c, axis=0, weights=base)
        local = c - pivot
        radius = max(1.0, float(np.sqrt(np.mean(np.sum(local**2, axis=1)))))
        # Small visual-CCW image rotation eps moves a point by eps*(ly, -lx);
        # this is +eps in the DXF angle (see dxf_to_image_px).
        matrix = np.column_stack([n, (n[:, 0]*local[:, 1]-n[:, 1]*local[:, 0])/radius])
        if angle_range == 0:
            matrix = matrix[:, :2]
        offsets = np.sum((found.points-c)*n, axis=1)
        weights = base.copy()
        for _ in range(4):
            weighted = matrix*np.sqrt(weights[:, None])
            condition = float(np.linalg.cond(weighted))
            if not np.isfinite(condition) or condition > 1e3:
                return fallback("pose is poorly constrained; use nonparallel datum edges")
            update, _, rank, _ = np.linalg.lstsq(weighted, offsets*np.sqrt(weights), rcond=None)
            if rank < matrix.shape[1]:
                return fallback("pose is poorly constrained; use nonparallel datum edges")
            residual = offsets-matrix@update
            sigma = max(0.02, 1.4826*float(np.median(np.abs(residual-np.median(residual)))))
            weights = base*np.minimum(1, 2.5*sigma/np.maximum(np.abs(residual), 1e-12))
        delta_angle = math.degrees(update[2]/radius) if angle_range else 0.0
        # The gate applies to the centroid-frame step.
        if np.linalg.norm(update[:2]) > 4 or abs(delta_angle) > 1:
            return fallback("local refinement exceeds the stable search range")
        new_angle = float(np.clip(angle_deg+delta_angle, -angle_range, angle_range))
        eps = math.radians(new_angle - angle_deg)
        # Back to the response's origin convention: the new image position
        # of the DXF origin is the old one rotated by eps about the pivot,
        # then shifted by the solved translation.
        vx, vy = tx - pivot[0], ty - pivot[1]
        tx = float(pivot[0] + update[0] + vx*math.cos(eps) + vy*math.sin(eps))
        ty = float(pivot[1] + update[1] - vx*math.sin(eps) + vy*math.cos(eps))
        angle_deg = new_angle
        quality = {"refined": True, "reason": None, "rms_px": float(np.sqrt(np.mean(residual**2))),
                   "point_count": len(found.points), "condition": condition, "datum_count": len(datums)}
        if np.linalg.norm(update) < 1e-4:
            break
    return tx, ty, angle_deg, quality


def _render_dxf_template(entities, scale, angle_deg=0, padding=5):
    """Render DXF entities to a binary template at the given scale and angle."""
    cos_a = math.cos(math.radians(angle_deg))
    sin_a = math.sin(math.radians(angle_deg))

    pts = []
    for e in entities:
        coords = []
        if "x1" in e:
            coords = [(e["x1"], e["y1"]), (e["x2"], e["y2"])]
        elif "cx" in e:
            r = e.get("radius", 0)
            # A circle's radius is unchanged by rotation. Rotating just two
            # opposite bounding-box corners can shrink one dimension and
            # clip the template's circle/arc at nonzero angles.
            cx = e["cx"] * cos_a - e["cy"] * sin_a
            cy = e["cx"] * sin_a + e["cy"] * cos_a
            pts.extend([(cx-r, cy-r), (cx+r, cy+r)])
        for px, py in coords:
            pts.append((px * cos_a - py * sin_a, px * sin_a + py * cos_a))

    if not pts:
        return None, 0, 0

    pxs = [p[0] for p in pts]
    pys = [p[1] for p in pts]
    r_min_x, r_min_y = min(pxs), min(pys)
    r_max_x, r_max_y = max(pxs), max(pys)

    tw = int((r_max_x - r_min_x) * scale) + 2 * padding
    th = int((r_max_y - r_min_y) * scale) + 2 * padding
    if tw < 10 or th < 10 or tw > 4000 or th > 4000:
        return None, 0, 0

    tmpl = np.zeros((th, tw), dtype=np.uint8)

    for e in entities:
        etype = e.get("type", "")
        if etype in ("line", "polyline_line"):
            x1r = e["x1"] * cos_a - e["y1"] * sin_a
            y1r = e["x1"] * sin_a + e["y1"] * cos_a
            x2r = e["x2"] * cos_a - e["y2"] * sin_a
            y2r = e["x2"] * sin_a + e["y2"] * cos_a
            px1 = int((x1r - r_min_x) * scale) + padding
            py1 = th - (int((y1r - r_min_y) * scale) + padding)
            px2 = int((x2r - r_min_x) * scale) + padding
            py2 = th - (int((y2r - r_min_y) * scale) + padding)
            cv2.line(tmpl, (px1, py1), (px2, py2), 255, 2)
        elif etype in ("arc", "polyline_arc"):
            cxr = e["cx"] * cos_a - e["cy"] * sin_a
            cyr = e["cx"] * sin_a + e["cy"] * cos_a
            pcx = int((cxr - r_min_x) * scale) + padding
            pcy = th - (int((cyr - r_min_y) * scale) + padding)
            r = int(e["radius"] * scale)
            if r < 1:
                continue
            s_deg = -(e.get("end_angle", 0) + angle_deg)
            e_deg = -(e.get("start_angle", 360) + angle_deg)
            cv2.ellipse(tmpl, (pcx, pcy), (r, r), 0, s_deg, e_deg, 255, 2)
        elif etype == "circle":
            cxr = e["cx"] * cos_a - e["cy"] * sin_a
            cyr = e["cx"] * sin_a + e["cy"] * cos_a
            pcx = int((cxr - r_min_x) * scale) + padding
            pcy = th - (int((cyr - r_min_y) * scale) + padding)
            r = int(e["radius"] * scale)
            if r < 1:
                continue
            cv2.circle(tmpl, (pcx, pcy), r, 255, 2)

    return tmpl, r_min_x, r_min_y
