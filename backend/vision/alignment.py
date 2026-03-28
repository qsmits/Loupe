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
    for i, (dx, dy, dr) in enumerate(dxf_px):
        mx = dx * cos_a - dy * sin_a + tx
        my = -(dx * sin_a + dy * cos_a) + ty  # Y-flip: DXF Y-up → canvas Y-down
        for j, (ex, ey, er) in enumerate(detected_px):
            if abs(dr - er) / (max(dr, er) + 1e-6) > 0.3:
                continue
            threshold = max(10.0, 0.15 * dr)
            if math.hypot(mx - ex, my - ey) < threshold:
                inliers.append((i, j))
                break
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
    h, w = frame.shape[:2]
    scale = pixels_per_mm

    gray = preprocess(frame, smoothing=smoothing)
    edges = cv2.Canny(gray, canny_low, canny_high)
    kernel = np.ones((3, 3), np.uint8)
    edges_thick = cv2.dilate(edges, kernel, iterations=1)

    # Pad the edge image so template matching works even when the part
    # fills the entire frame (template must be smaller than search image)
    pad_x = int(w * 0.3)
    pad_y = int(h * 0.3)
    edges_thick = cv2.copyMakeBorder(edges_thick, pad_y, pad_y, pad_x, pad_x,
                                      cv2.BORDER_CONSTANT, value=0)
    h_padded, w_padded = edges_thick.shape

    # DXF coordinate bounds
    xs, ys = [], []
    for e in entities:
        if "x1" in e:
            xs.extend([e["x1"], e["x2"]])
            ys.extend([e["y1"], e["y2"]])
        elif "cx" in e:
            xs.append(e["cx"])
            ys.append(e["cy"])
    if not xs:
        return {"success": False, "reason": "No geometry in DXF"}

    best_score = -1
    best_angle = 0.0
    best_loc = (0, 0)
    best_r_min_x = 0
    best_r_min_y = 0
    best_tmpl_shape = (0, 0)

    padding = 5  # small padding to maximize template fit in image
    angles = np.arange(-angle_range, angle_range + angle_step * 0.5, angle_step)

    for angle_deg in angles:
        render_result = _render_dxf_template(
            entities, scale, angle_deg, padding
        )
        if render_result is None or render_result[0] is None:
            continue
        tmpl, r_min_x, r_min_y = render_result
        th, tw = tmpl.shape
        if tw >= w_padded or th >= h_padded:
            continue

        result = cv2.matchTemplate(edges_thick, tmpl, cv2.TM_CCORR_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(result)

        if max_val > best_score:
            best_score = max_val
            best_angle = angle_deg
            best_loc = max_loc
            best_r_min_x = r_min_x
            best_r_min_y = r_min_y
            best_tmpl_shape = (th, tw)

    if best_score < 0:
        return {"success": False, "reason": "DXF template too large for image at this scale. Try lower calibration or smaller DXF."}
    if best_score < 0.01:
        return {"success": False, "reason": "No good match found"}

    # Convert template position to DXF overlay transform (offsetX, offsetY)
    # DXF (0,0) in the rotated template is at pixel:
    cos_a = math.cos(math.radians(best_angle))
    sin_a = math.sin(math.radians(best_angle))
    th, tw = best_tmpl_shape
    origin_tmpl_x = (0 - best_r_min_x) * scale + padding
    origin_tmpl_y = th - ((0 - best_r_min_y) * scale + padding)

    # Subtract the edge image padding to get coordinates in original image space
    tx = best_loc[0] + origin_tmpl_x - pad_x
    ty = best_loc[1] + origin_tmpl_y - pad_y

    return {
        "success": True,
        "tx": float(tx),
        "ty": float(ty),
        "angle_deg": float(best_angle),
        "scale": float(scale),
        "score": float(best_score),
    }


def _render_dxf_template(entities, scale, angle_deg=0, padding=15):
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
            coords = [(e["cx"] - r, e["cy"] - r), (e["cx"] + r, e["cy"] + r)]
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
