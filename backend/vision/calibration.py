import math


def distance_px(p1: tuple, p2: tuple) -> float:
    """Euclidean distance between two (x, y) points in pixels."""
    return math.sqrt((p2[0] - p1[0]) ** 2 + (p2[1] - p1[1]) ** 2)


def px_to_mm(pixels: float, pixels_per_mm: float) -> float:
    """Convert a pixel distance to mm."""
    if pixels_per_mm <= 0:
        raise ValueError("pixels_per_mm must be positive")
    return pixels / pixels_per_mm


def mm_to_px(mm: float, pixels_per_mm: float) -> float:
    """Convert a mm distance to pixels."""
    if pixels_per_mm <= 0:
        raise ValueError("pixels_per_mm must be positive")
    return mm * pixels_per_mm


def angle_degrees(p1: tuple, vertex: tuple, p3: tuple) -> float:
    """Angle in degrees at `vertex` formed by the line from p1→vertex and vertex→p3."""
    v1 = (p1[0] - vertex[0], p1[1] - vertex[1])
    v2 = (p3[0] - vertex[0], p3[1] - vertex[1])
    mag1 = math.sqrt(v1[0] ** 2 + v1[1] ** 2)
    mag2 = math.sqrt(v2[0] ** 2 + v2[1] ** 2)
    if mag1 < 1e-10 or mag2 < 1e-10:
        return 0.0
    dot = v1[0] * v2[0] + v1[1] * v2[1]
    cos_a = max(-1.0, min(1.0, dot / (mag1 * mag2)))
    return math.degrees(math.acos(cos_a))


def fit_circle_three_points(p1: tuple, p2: tuple, p3: tuple) -> tuple:
    """
    Fit a circle through three points on its circumference.
    Returns (cx, cy, radius).
    Raises ValueError if points are collinear.
    """
    ax, ay = p1
    bx, by = p2
    cx, cy = p3
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-10:
        raise ValueError("Points are collinear — cannot fit a circle")
    sq_a = ax ** 2 + ay ** 2
    sq_b = bx ** 2 + by ** 2
    sq_c = cx ** 2 + cy ** 2
    ux = (sq_a * (by - cy) + sq_b * (cy - ay) + sq_c * (ay - by)) / d
    uy = (sq_a * (cx - bx) + sq_b * (ax - cx) + sq_c * (bx - ax)) / d
    radius = math.sqrt((ax - ux) ** 2 + (ay - uy) ** 2)
    return ux, uy, radius
