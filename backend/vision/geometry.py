"""Geometric primitive fits shared by detection and inspection."""
from dataclasses import dataclass

import numpy as np
from scipy.optimize import least_squares


def fit_line_robust(points, weights=None):
    """Contrast-weighted orthogonal line fit with Huber reweighting."""
    points = np.asarray(points, dtype=float)
    if points.ndim != 2 or points.shape[1] != 2 or len(points) < 2 or not np.isfinite(points).all():
        raise ValueError("line fit needs at least 2 finite points")
    base = np.ones(len(points)) if weights is None else np.asarray(weights, dtype=float)
    if base.shape != (len(points),) or not np.isfinite(base).all() or np.any(base <= 0):
        raise ValueError("line weights must be finite and positive")
    base = np.clip(base / np.median(base), 0.2, 5)
    current = base.copy()
    for _ in range(20):
        centroid = np.average(points, axis=0, weights=current)
        centered = points - centroid
        values, vectors = np.linalg.eigh(centered.T @ (centered * current[:, None]))
        if values[-1] < 1e-12:
            raise ValueError("line points are coincident")
        normal, direction = vectors[:, 0], vectors[:, 1]
        residuals = centered @ normal
        sigma = max(0.02, 1.4826 * float(np.median(np.abs(residuals - np.median(residuals)))))
        next_weights = base * np.minimum(1, 2.5 * sigma / np.maximum(np.abs(residuals), 1e-12))
        if np.max(np.abs(next_weights - current)) < 1e-6:
            break
        current = next_weights
    inliers = np.abs(residuals) <= 3 * sigma
    if inliers.sum() < 2:
        raise ValueError("too few line inliers")
    return centroid, direction, normal, inliers


@dataclass
class CircleFit:
    cx: float
    cy: float
    r: float
    rms_px: float
    inlier_mask: np.ndarray
    coverage_deg: float
    condition: float
    covariance: np.ndarray | None

    @property
    def parameters(self):
        return self.cx, self.cy, self.r

    def diagnostics(self):
        # Conditional fit errors assume independent point noise. They exclude
        # optical/scale/pose errors and correlation between neighboring pixels.
        errors = None if self.covariance is None else np.sqrt(np.maximum(0, np.diag(self.covariance)))
        return {
            "rms_px": self.rms_px,
            "inlier_count": int(self.inlier_mask.sum()),
            "point_count": len(self.inlier_mask),
            "coverage_deg": self.coverage_deg,
            "condition": self.condition,
            "parameter_std_error_px": None if errors is None else errors.tolist(),
        }


def fit_circle_robust(points: np.ndarray, weights=None) -> CircleFit:
    """Huber geometric radial fit, with a centered/scaled algebraic seed.

    Raises ValueError for nonfinite, collinear, or poorly constrained data.
    The Jacobian condition gate also catches near-straight short arcs which
    can otherwise produce huge radii with deceptively small residuals.
    """
    points = np.asarray(points, dtype=np.float64)
    if points.ndim != 2 or points.shape[1] != 2 or len(points) < 3 or not np.isfinite(points).all():
        raise ValueError("circle fit needs at least 3 finite points")
    weights = np.ones(len(points)) if weights is None else np.asarray(weights, dtype=float)
    if weights.shape != (len(points),) or not np.isfinite(weights).all() or np.any(weights <= 0):
        raise ValueError("circle weights must be finite and positive")
    weights = np.clip(weights / np.median(weights), 0.2, 5)
    sqrt_weights = np.sqrt(weights)
    origin = points.mean(axis=0)
    scale = float(np.sqrt(np.mean(np.sum((points - origin) ** 2, axis=1))))
    if scale < 1e-9:
        raise ValueError("circle points are coincident")
    pts = (points - origin) / scale
    a = np.column_stack([2 * pts, np.ones(len(pts))])
    seed, _, rank, _ = np.linalg.lstsq(a, np.sum(pts ** 2, axis=1), rcond=None)
    radius_sq = seed[2] + np.sum(seed[:2] ** 2)
    if rank < 3 or radius_sq <= 0:
        raise ValueError("circle points are collinear")
    params = np.array([seed[0], seed[1], np.sqrt(radius_sq)])

    def residual(p):
        return np.hypot(pts[:, 0] - p[0], pts[:, 1] - p[1]) - p[2]

    def jacobian(p):
        delta = p[:2] - pts
        distances = np.maximum(np.linalg.norm(delta, axis=1), 1e-12)
        return np.column_stack([delta / distances[:, None], -np.ones(len(pts))])

    # Re-estimate noise after each solve; the seed's bias/outliers should not
    # set the final robust cutoff. The 0.02 px floor handles quantized images
    # and exact points without turning floating-point noise into outliers.
    for _ in range(3):
        res = residual(params)
        sigma = max(0.02 / scale, 1.4826 * float(np.median(np.abs(res - np.median(res)))))
        fit = least_squares(lambda p: residual(p) * sqrt_weights, params,
                            jac=lambda p: jacobian(p) * sqrt_weights[:, None], loss="huber", f_scale=2.5 * sigma,
                            bounds=([-np.inf, -np.inf, 1e-12], [np.inf, np.inf, np.inf]),
                            max_nfev=100, ftol=1e-10, xtol=1e-10, gtol=1e-10)
        if not fit.success or not np.isfinite(fit.x).all():
            raise ValueError("geometric circle fit did not converge")
        params = fit.x

    res = residual(params)
    sigma = max(0.02 / scale, 1.4826 * float(np.median(np.abs(res - np.median(res)))))
    inliers = np.abs(res) <= 3 * sigma
    if inliers.sum() < 3:
        raise ValueError("too few circle inliers")
    j = jacobian(params)[inliers] * sqrt_weights[inliers, None]
    condition = float(np.linalg.cond(j))
    if not np.isfinite(condition) or condition > 1e4:
        raise ValueError("circle fit is poorly constrained (insufficient arc coverage)")
    rms = float(np.sqrt(np.mean(res[inliers] ** 2)) * scale)
    covariance = None
    if inliers.sum() > 3:
        variance = float(np.sum(weights[inliers] * res[inliers] ** 2) * scale ** 2 / (inliers.sum() - 3))
        covariance = np.linalg.inv(j.T @ j) * variance
    angles = np.sort(np.degrees(np.arctan2(pts[inliers, 1] - params[1], pts[inliers, 0] - params[0])) % 360)
    gaps = np.diff(angles, append=angles[0] + 360)
    return CircleFit(float(origin[0] + scale * params[0]), float(origin[1] + scale * params[1]),
                     float(scale * params[2]), rms, inliers, 360 - float(gaps.max()), condition, covariance)
