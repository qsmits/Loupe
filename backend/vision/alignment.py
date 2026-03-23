# backend/vision/alignment.py
import math
import numpy as np


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
