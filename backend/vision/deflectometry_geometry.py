"""Deflectometry geometry kernel — pure math, no I/O, no side effects.

This module is the shared geometric foundation for:
- Phase 3B: ball-based calibration (camera + screen pose recovery from spherical mirror).
- Phase 4: geometric slope solver that turns unwrapped phase → surface slopes → height.

Everything here is a pure function or a small dataclass. No FastAPI, no OpenCV,
no file I/O. All inputs and outputs are documented in a single explicit frame
per call — the caller is responsible for moving data between frames.

Coordinate frames
=================

Three native frames plus the image-pixel frame you already know about from
``CLAUDE.md``'s "Coordinate frames" section. All three native frames below are
right-handed; the screen-pixel frame is where Y flips.

1. Camera frame (``_cam``):
       x: right (matches image u)
       y: down  (matches image v)
       z: forward, into the scene
   Origin at the camera center (pinhole origin or telecentric entrance pupil).
   Image pixel (u, v) is mapped to a camera-frame ray by ``CameraModel``.

2. World / rig frame (``_world``):
       x: right
       y: back (away from the operator, along the optical bench)
       z: up
   Origin at the specimen fixture. In our benchtop deflectometry rig, the
   iPad hangs over the specimen and the camera sits roughly coaxial with the
   iPad center, pointing down at the specimen. Poses are expressed in this
   frame.

3. Screen / iPad frame (``_screen``):
       x: right
       y: down  (matches iPad pixel coords; this is the Y-flip boundary)
       z: out of the screen (toward the operator's face)
   Origin at top-left iPad pixel. This frame is right-handed if you interpret
   the three axes that way (x right, y down, z out makes a right-handed triad
   because right × down = out-of-page). It's consistent with how iPad renders
   pixels, which is what matters for the screen-shape callable.

All poses are SE(3) — a ``scipy.spatial.transform.Rotation`` plus a 3-vector
translation. A ``Pose`` ``T_ab`` represents the pose of frame B expressed in
frame A: ``x_a = T_ab.rotation.apply(x_b) + T_ab.translation``. The naming
``camera_pose_in_world`` means "pose of camera frame expressed in world frame",
i.e. applying it transforms camera-frame points to world-frame points.

Handedness warning / the Y-flip trap
====================================

The Y-flip bug documented in ``CLAUDE.md`` lives at the boundary between
DXF-math (y-up) and image/canvas (y-down). **This module introduces one new
Y-flip boundary**: the screen-pixel frame (y-down, matches iPad pixels) vs.
any physical mm quantities measured on the iPad surface.

Rules of thumb:
- If your screen-shape callable consumes screen pixel coords and produces
  world-frame mm, Y-flip happens inside that callable. ``slope_from_camera_pixel``
  does not Y-flip on its own — it passes screen coords through the callable
  as-is.
- If you rasterize a synthetic pattern into screen-pixel coords and
  photogrammetrically reason about it in world mm, you must Y-flip exactly
  once at the pixel↔mm boundary. Do it in the ``screen_shape_to_world``
  callable, not in the caller and not inside this module.
- Gears are mirror-symmetric and mask single-tooth Y-flip bugs
  (``CLAUDE.md``). Deflectometry slopes are NOT mirror-symmetric — a Y-flip
  bug manifests as slopes being sign-flipped in one axis, which is obvious
  if (and only if) you test with a known-asymmetric tilt. The test
  ``test_slope_from_camera_pixel_yflip_canary`` below is the forward-looking
  defense.

Reference: ``CLAUDE.md`` "Coordinate frames — read this before touching DXF,
overlays, or gear code" for the broader pattern.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np
from scipy.spatial.transform import Rotation


# ---------------------------------------------------------------------------
# CameraModel
# ---------------------------------------------------------------------------

_TELECENTRIC = "telecentric"
_PINHOLE = "pinhole"
_VALID_MODES = (_TELECENTRIC, _PINHOLE)


@dataclass
class CameraModel:
    """Maps camera pixels (u, v) to 3D rays in the camera frame.

    Two modes:
    - ``"telecentric"`` — all rays are parallel to +z. Pixel (u, v) becomes a
      ray with origin at ``(u * px_size_mm, v * px_size_mm, 0)`` and direction
      ``(0, 0, 1)``. Suitable for microscope optics with small FOV and a fixed
      working distance.
    - ``"pinhole"`` — rays emanate from the camera origin. Pixel (u, v) becomes
      ray origin ``(0, 0, 0)`` with direction proportional to
      ``(u - cx, v - cy, fx)``, then normalized.

    Distortion is NOT modeled. If step-block validation later shows systematic
    radial error, extend this with a Brown-Conrady k1/k2 stub.

    Image coordinate convention for (u, v): u right, v down, in pixels.
    The generated ray is in the camera frame (x right, y down, z forward).
    """

    mode: str
    px_size_mm: float | None = None
    fx: float | None = None
    fy: float | None = None
    cx: float | None = None
    cy: float | None = None
    image_width: int = 0
    image_height: int = 0

    def __post_init__(self) -> None:
        if self.mode not in _VALID_MODES:
            raise ValueError(
                f"CameraModel.mode must be one of {_VALID_MODES}, got {self.mode!r}"
            )
        if self.mode == _TELECENTRIC:
            if self.px_size_mm is None or self.px_size_mm <= 0:
                raise ValueError(
                    "telecentric mode requires positive px_size_mm"
                )
        elif self.mode == _PINHOLE:
            required = ("fx", "fy", "cx", "cy")
            missing = [name for name in required if getattr(self, name) is None]
            if missing:
                raise ValueError(
                    f"pinhole mode requires {required}, missing {missing}"
                )
            if self.fx <= 0 or self.fy <= 0:
                raise ValueError("pinhole mode requires positive fx, fy")
        if self.image_width < 0 or self.image_height < 0:
            raise ValueError("image_width and image_height must be non-negative")

    # -- factories ---------------------------------------------------------

    @classmethod
    def telecentric_from_pixels_per_mm(
        cls, pixels_per_mm: float, image_width: int, image_height: int
    ) -> "CameraModel":
        """Construct a telecentric model from the existing ``pixelsPerMm`` calibration."""
        if pixels_per_mm <= 0:
            raise ValueError("pixels_per_mm must be positive")
        return cls(
            mode=_TELECENTRIC,
            px_size_mm=1.0 / float(pixels_per_mm),
            image_width=int(image_width),
            image_height=int(image_height),
        )

    # -- conversions -------------------------------------------------------

    def ray_from_pixel(
        self, u: float | np.ndarray, v: float | np.ndarray
    ) -> tuple[np.ndarray, np.ndarray]:
        """Map pixel (u, v) to a ray (origin, direction) in the camera frame.

        Shapes:
        - scalar (u, v) → origin, direction of shape (3,)
        - array (u, v) of shape (...) → origin, direction of shape (..., 3)

        Direction is unit length.

        Out-of-bounds pixels are allowed (they still project to a well-defined
        ray). If ``image_width > 0`` and ``image_height > 0``, callers can
        validate bounds themselves. We do not raise or NaN here — the ray math
        is well-defined for any (u, v).
        """
        u_arr = np.asarray(u, dtype=np.float64)
        v_arr = np.asarray(v, dtype=np.float64)
        if u_arr.shape != v_arr.shape:
            raise ValueError(
                f"u and v must have matching shapes, got {u_arr.shape} and {v_arr.shape}"
            )

        if self.mode == _TELECENTRIC:
            origin = np.stack(
                [
                    u_arr * self.px_size_mm,
                    v_arr * self.px_size_mm,
                    np.zeros_like(u_arr),
                ],
                axis=-1,
            )
            direction = np.zeros_like(origin)
            direction[..., 2] = 1.0
            return origin, direction

        # pinhole
        x = (u_arr - self.cx)
        y = (v_arr - self.cy)
        # Ray direction proportional to (x/fx, y/fy, 1); normalize at end.
        dir_unnorm = np.stack(
            [x / self.fx, y / self.fy, np.ones_like(u_arr)], axis=-1
        )
        norm = np.linalg.norm(dir_unnorm, axis=-1, keepdims=True)
        direction = dir_unnorm / norm
        origin = np.zeros_like(direction)
        return origin, direction

    def pixel_from_ray(
        self, origin: np.ndarray, direction: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray]:
        """Inverse of ``ray_from_pixel`` (camera frame → pixel).

        Returns ``(u, v)`` arrays. Pixels that fall outside the image bounds
        (when ``image_width``/``image_height`` are nonzero) come back as NaN.
        A pinhole ray with non-positive z is behind the camera and returns NaN.

        For telecentric: pixel = origin.xy / px_size_mm (direction ignored).
        For pinhole: pixel = (fx * origin.x / origin.z + cx,
                              fy * origin.y / origin.z + cy).
        """
        origin = np.asarray(origin, dtype=np.float64)
        direction = np.asarray(direction, dtype=np.float64)
        if origin.shape[-1] != 3 or direction.shape[-1] != 3:
            raise ValueError("origin and direction must have last dim 3")

        if self.mode == _TELECENTRIC:
            u = origin[..., 0] / self.px_size_mm
            v = origin[..., 1] / self.px_size_mm
        else:
            # pinhole: project along the ray until z > 0. If origin.z > 0, use
            # the origin directly. If origin.z <= 0, walk along direction until
            # we hit z > 0.
            z_o = origin[..., 2]
            z_d = direction[..., 2]
            # If the origin is already in front of the camera, use it.
            # Otherwise project to z=1 along the ray (if direction has positive z).
            # Simplest convention: any point on the ray projects to the same
            # pixel when z > 0. So pick a point on the ray with z > 0; if no
            # such point exists, return NaN.
            pt = origin.copy()
            need_advance = z_o <= 0
            with np.errstate(divide="ignore", invalid="ignore"):
                t = np.where(z_d > 0, (1.0 - z_o) / z_d, np.nan)
            advance_ok = np.isfinite(t) & need_advance
            if advance_ok.any():
                pt = np.where(
                    advance_ok[..., None], origin + t[..., None] * direction, pt
                )
            z_pt = pt[..., 2]
            with np.errstate(divide="ignore", invalid="ignore"):
                u = np.where(
                    z_pt > 0, self.fx * pt[..., 0] / z_pt + self.cx, np.nan
                )
                v = np.where(
                    z_pt > 0, self.fy * pt[..., 1] / z_pt + self.cy, np.nan
                )

        if self.image_width > 0 and self.image_height > 0:
            out_of_bounds = (
                (u < 0) | (u > self.image_width - 1) |
                (v < 0) | (v > self.image_height - 1)
            )
            u = np.where(out_of_bounds, np.nan, u)
            v = np.where(out_of_bounds, np.nan, v)

        return u, v


# ---------------------------------------------------------------------------
# Pose (SE(3))
# ---------------------------------------------------------------------------


@dataclass
class Pose:
    """SE(3) rigid-body transform.

    A ``Pose`` represents the pose of frame B expressed in frame A:

        x_A = rotation.apply(x_B) + translation

    So ``pose.apply(x_B) → x_A``. Composition follows the same convention:
    if ``T_ab`` is the pose of B in A and ``T_bc`` is the pose of C in B,
    then ``T_ab.compose(T_bc)`` is the pose of C in A.
    """

    rotation: Rotation
    translation: np.ndarray = field(default_factory=lambda: np.zeros(3))

    def __post_init__(self) -> None:
        self.translation = np.asarray(self.translation, dtype=np.float64).reshape(3)

    # -- core --------------------------------------------------------------

    def apply(self, x_B: np.ndarray) -> np.ndarray:
        """Transform a point (or batch) from B to A: ``x_A = R x_B + t``."""
        x_B = np.asarray(x_B, dtype=np.float64)
        if x_B.shape[-1] != 3:
            raise ValueError(f"x must have last dim 3, got shape {x_B.shape}")
        rotated = self.rotation.apply(x_B.reshape(-1, 3)).reshape(x_B.shape)
        return rotated + self.translation

    def inverse(self) -> "Pose":
        """Pose of A in B (the inverse rigid transform)."""
        inv_rot = self.rotation.inv()
        inv_trans = -inv_rot.apply(self.translation)
        return Pose(rotation=inv_rot, translation=inv_trans)

    def compose(self, other: "Pose") -> "Pose":
        """Compose: ``self @ other``. If ``self`` is pose of B in A and ``other``
        is pose of C in B, the result is the pose of C in A.
        """
        new_rot = self.rotation * other.rotation
        new_trans = self.rotation.apply(other.translation) + self.translation
        return Pose(rotation=new_rot, translation=new_trans)

    # -- factories ---------------------------------------------------------

    @classmethod
    def identity(cls) -> "Pose":
        return cls(rotation=Rotation.identity(), translation=np.zeros(3))

    @classmethod
    def from_rotation_translation(
        cls, rotmat: np.ndarray, translation: np.ndarray
    ) -> "Pose":
        rotmat = np.asarray(rotmat, dtype=np.float64).reshape(3, 3)
        return cls(
            rotation=Rotation.from_matrix(rotmat),
            translation=np.asarray(translation, dtype=np.float64).reshape(3),
        )

    @classmethod
    def from_euler(
        cls, seq: str, angles_deg: list[float], translation: np.ndarray
    ) -> "Pose":
        """Convenience factory. Euler angles are always in DEGREES here."""
        return cls(
            rotation=Rotation.from_euler(seq, angles_deg, degrees=True),
            translation=np.asarray(translation, dtype=np.float64).reshape(3),
        )

    # -- serialization -----------------------------------------------------

    def as_dict(self) -> dict:
        return {
            "rotation_matrix": self.rotation.as_matrix().tolist(),
            "translation": self.translation.tolist(),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Pose":
        return cls.from_rotation_translation(
            np.asarray(d["rotation_matrix"], dtype=np.float64),
            np.asarray(d["translation"], dtype=np.float64),
        )

    # -- equality helper (for tests) --------------------------------------

    def approx_equal(self, other: "Pose", atol: float = 1e-9) -> bool:
        rot_diff = (self.rotation.inv() * other.rotation).magnitude()
        trans_diff = np.linalg.norm(self.translation - other.translation)
        return bool(rot_diff < atol and trans_diff < atol)


# ---------------------------------------------------------------------------
# Pure geometry kernels
# ---------------------------------------------------------------------------


def _as_array3(a: np.ndarray, name: str) -> np.ndarray:
    a = np.asarray(a, dtype=np.float64)
    if a.shape[-1] != 3:
        raise ValueError(f"{name} must have last dim 3, got shape {a.shape}")
    return a


def ray_sphere_intersection(
    ray_origin: np.ndarray,
    ray_direction: np.ndarray,
    sphere_center: np.ndarray,
    sphere_radius: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Nearest-positive-t intersection of rays with a sphere.

    Shapes:
    - ray_origin, ray_direction: ``(..., 3)``, broadcast-compatible
    - sphere_center: ``(3,)``
    - sphere_radius: scalar

    Convention: ``ray_direction`` should be unit length. If it isn't, the
    parameterization is still correct but the returned ``t`` won't be a
    distance — the hit points are returned in world coords so that doesn't
    matter downstream, but do normalize for cleanliness.

    Returns:
        hit_points: ``(..., 3)`` — nearest intersection (smallest positive t).
            NaN where ``valid_mask`` is False.
        valid_mask: ``(...,)`` bool — True where the ray hits with positive t.

    Branch choices:
    - Tangent rays (discriminant ≈ 0) return a single hit.
    - Rays originating inside the sphere return the positive-t exit point
      (the "ahead" hit) — not the behind-us entry point.
    - Rays pointing away from the sphere (no positive root) return valid=False.
    - Degenerate rays (zero-length direction) return valid=False.
    """
    ray_origin = _as_array3(ray_origin, "ray_origin")
    ray_direction = _as_array3(ray_direction, "ray_direction")
    sphere_center = _as_array3(sphere_center, "sphere_center").reshape(3)
    sphere_radius = float(sphere_radius)

    # Broadcast origin and direction to a common shape.
    ray_origin, ray_direction = np.broadcast_arrays(ray_origin, ray_direction)

    # Quadratic: (o + t d - c) · (o + t d - c) = r^2
    # => (d·d) t^2 + 2 (d · (o - c)) t + (o - c)·(o - c) - r^2 = 0
    oc = ray_origin - sphere_center
    a = np.einsum("...i,...i->...", ray_direction, ray_direction)
    b = 2.0 * np.einsum("...i,...i->...", ray_direction, oc)
    c = np.einsum("...i,...i->...", oc, oc) - sphere_radius * sphere_radius

    disc = b * b - 4.0 * a * c
    # Degenerate: a == 0 (zero-length direction) → invalid.
    nondegenerate = a > 1e-30
    hits = disc >= 0.0

    sqrt_disc = np.sqrt(np.where(hits, disc, 0.0))
    # Two roots
    with np.errstate(divide="ignore", invalid="ignore"):
        t1 = np.where(nondegenerate, (-b - sqrt_disc) / (2.0 * a), np.nan)
        t2 = np.where(nondegenerate, (-b + sqrt_disc) / (2.0 * a), np.nan)

    # Choose the smallest strictly-positive root. Small epsilon keeps us off
    # the surface we just left (important for reflected-ray chains).
    eps = 1e-9
    t1_ok = np.isfinite(t1) & (t1 > eps)
    t2_ok = np.isfinite(t2) & (t2 > eps)

    # Prefer t1 (nearer) when valid, else t2.
    t = np.where(t1_ok, t1, np.where(t2_ok, t2, np.nan))
    valid = (t1_ok | t2_ok) & nondegenerate & hits

    hit_points = ray_origin + t[..., None] * ray_direction
    hit_points = np.where(valid[..., None], hit_points, np.nan)

    return hit_points, valid


def surface_normal_at_sphere_point(
    hit_points: np.ndarray, sphere_center: np.ndarray
) -> np.ndarray:
    """Outward-pointing unit normal at each sphere hit point.

    Shape: ``(..., 3)``. NaN inputs propagate to NaN outputs.
    """
    hit_points = _as_array3(hit_points, "hit_points")
    sphere_center = _as_array3(sphere_center, "sphere_center").reshape(3)
    diff = hit_points - sphere_center
    norm = np.linalg.norm(diff, axis=-1, keepdims=True)
    # Avoid division by zero at the center (shouldn't happen for real hits).
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.where(norm > 1e-30, diff / norm, np.nan)
    return out


def reflect(
    incident_direction: np.ndarray, surface_normal: np.ndarray
) -> np.ndarray:
    """Specular reflection.

    Both inputs must be unit vectors. Caller convention:
    - ``incident_direction`` points TOWARD the surface (into it).
    - ``surface_normal`` points OUT of the surface (away from it).

    The returned direction points AWAY from the surface and is unit length.

    Formula: ``r = d − 2 (d · n) n``.
    """
    incident_direction = _as_array3(incident_direction, "incident_direction")
    surface_normal = _as_array3(surface_normal, "surface_normal")
    incident_direction, surface_normal = np.broadcast_arrays(
        incident_direction, surface_normal
    )
    dot = np.einsum("...i,...i->...", incident_direction, surface_normal)
    reflected = incident_direction - 2.0 * dot[..., None] * surface_normal
    # Re-normalize to kill drift (inputs assumed unit; tiny noise otherwise).
    norm = np.linalg.norm(reflected, axis=-1, keepdims=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        reflected = np.where(norm > 1e-30, reflected / norm, np.nan)
    return reflected


def ray_plane_intersection(
    ray_origin: np.ndarray,
    ray_direction: np.ndarray,
    plane_point: np.ndarray,
    plane_normal: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Nearest-positive-t intersection of rays with a plane.

    Returns:
        hit_points: ``(..., 3)``. NaN where invalid.
        valid_mask: ``(...,)`` bool.

    A ray parallel to the plane (``|d · n| ≈ 0``) returns valid=False. A ray
    whose positive-t side doesn't reach the plane (e.g. pointing away) also
    returns valid=False.
    """
    ray_origin = _as_array3(ray_origin, "ray_origin")
    ray_direction = _as_array3(ray_direction, "ray_direction")
    plane_point = _as_array3(plane_point, "plane_point").reshape(3)
    plane_normal = _as_array3(plane_normal, "plane_normal").reshape(3)

    ray_origin, ray_direction = np.broadcast_arrays(ray_origin, ray_direction)

    denom = np.einsum("...i,i->...", ray_direction, plane_normal)
    num = np.einsum("i,i->", plane_normal, plane_point) - np.einsum(
        "...i,i->...", ray_origin, plane_normal
    )
    eps = 1e-12
    nondegenerate = np.abs(denom) > eps
    with np.errstate(divide="ignore", invalid="ignore"):
        t = np.where(nondegenerate, num / denom, np.nan)
    valid = nondegenerate & np.isfinite(t) & (t > 1e-9)
    hit_points = ray_origin + t[..., None] * ray_direction
    hit_points = np.where(valid[..., None], hit_points, np.nan)
    return hit_points, valid


def ray_paraboloid_intersection(
    ray_origin: np.ndarray,
    ray_direction: np.ndarray,
    paraboloid_coeffs: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Ray–conic intersection for a paraboloid of form
        z = F + D x + A x² + E y + C x y + B y²

    Coefficients are packed as ``[F, D, A, E, C, B]`` to match OpenCSP's
    ``Surface2DParabolic`` convention. If ``A == B == C == 0`` the surface is
    a plane and this function reduces to a plane intersection.

    Returns:
        hit_points: ``(..., 3)`` — nearest strictly-positive-t intersection.
            NaN where invalid.
        valid_mask: ``(...,)`` bool.

    Branch choices:
    - Nearest positive root is returned. For a concave cup (A, B > 0) and a
      ray coming from above, the nearest positive root is the front surface,
      which is what you want.
    - For degenerate rays (zero direction) returns valid=False.
    - For rays grazing the surface (discriminant < 0) returns valid=False.
    """
    ray_origin = _as_array3(ray_origin, "ray_origin")
    ray_direction = _as_array3(ray_direction, "ray_direction")
    paraboloid_coeffs = np.asarray(paraboloid_coeffs, dtype=np.float64).reshape(6)
    F, D, A, E, C, B = paraboloid_coeffs

    ray_origin, ray_direction = np.broadcast_arrays(ray_origin, ray_direction)
    ox, oy, oz = ray_origin[..., 0], ray_origin[..., 1], ray_origin[..., 2]
    dx, dy, dz = ray_direction[..., 0], ray_direction[..., 1], ray_direction[..., 2]

    # F(t) = (oz + t dz) − F − D(ox+t dx) − A(ox+t dx)² − E(oy+t dy)
    #        − C(ox+t dx)(oy+t dy) − B(oy+t dy)² = 0
    #
    # Expand:  a t² + b t + c = 0 with
    #  a = −(A dx² + B dy² + C dx dy)
    #  b = dz − D dx − E dy − 2 A ox dx − 2 B oy dy − C (ox dy + oy dx)
    #  c = oz − F − D ox − E oy − A ox² − B oy² − C ox oy
    a = -(A * dx * dx + B * dy * dy + C * dx * dy)
    b = (
        dz
        - D * dx - E * dy
        - 2.0 * A * ox * dx - 2.0 * B * oy * dy
        - C * (ox * dy + oy * dx)
    )
    c = (
        oz - F
        - D * ox - E * oy
        - A * ox * ox - B * oy * oy
        - C * ox * oy
    )

    eps = 1e-30
    dir_nonzero = (dx * dx + dy * dy + dz * dz) > eps

    # Linear case: a == 0 → b t + c = 0.
    linear = np.abs(a) < 1e-18
    with np.errstate(divide="ignore", invalid="ignore"):
        t_linear = np.where(np.abs(b) > 1e-18, -c / b, np.nan)

    # Quadratic case.
    disc = b * b - 4.0 * a * c
    disc_ok = disc >= 0.0
    sqrt_disc = np.sqrt(np.where(disc_ok, disc, 0.0))
    with np.errstate(divide="ignore", invalid="ignore"):
        t1 = np.where(~linear, (-b - sqrt_disc) / (2.0 * a), np.nan)
        t2 = np.where(~linear, (-b + sqrt_disc) / (2.0 * a), np.nan)

    pos_eps = 1e-9
    t1_ok = np.isfinite(t1) & (t1 > pos_eps) & disc_ok
    t2_ok = np.isfinite(t2) & (t2 > pos_eps) & disc_ok
    t_quad = np.where(t1_ok, t1, np.where(t2_ok, t2, np.nan))

    t_lin_ok = np.isfinite(t_linear) & (t_linear > pos_eps)
    t = np.where(linear, np.where(t_lin_ok, t_linear, np.nan), t_quad)
    valid = dir_nonzero & np.isfinite(t)

    hit_points = ray_origin + t[..., None] * ray_direction
    hit_points = np.where(valid[..., None], hit_points, np.nan)
    return hit_points, valid


# ---------------------------------------------------------------------------
# End-to-end helper: camera pixel → surface slope
# ---------------------------------------------------------------------------


def slope_from_camera_pixel(
    camera_pixel_uv: np.ndarray,
    camera_model: CameraModel,
    camera_pose_in_world: Pose,
    screen_coord_xy: np.ndarray,
    screen_shape_to_world: Callable[[np.ndarray], np.ndarray],
    surface_plane_point: np.ndarray,
    surface_plane_normal: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Compute surface slope per pixel via the reflection chain.

    This is the composition the Phase-4 geometric slope solver calls.

    Pipeline:
        1. camera_pixel → ray in camera frame
        2. transform ray into the world frame via ``camera_pose_in_world``
        3. intersect with the assumed specimen plane → world-frame hit point
        4. screen_coord → world 3D point via the caller-provided callable
           (this is where the screen-pixel ↔ world-mm Y-flip lives, if any)
        5. incident ray = from camera origin (world) to surface hit point,
           normalized; points INTO the surface
        6. reflected ray = from surface hit point to screen world point,
           normalized; points AWAY from the surface
        7. surface normal = bisector of (−incident) and reflected, normalized
           (law of reflection: n is the bisector of the two outgoing directions)
        8. slope = (−normal.x / normal.z, −normal.y / normal.z) in the
           world frame — these are dz/dx and dz/dy of the specimen surface
           at the hit point.

    All 3D math is done in the world frame after step 2.

    Arguments:
        camera_pixel_uv: ``(..., 2)`` pixel coords.
        camera_model: ``CameraModel`` for ray generation.
        camera_pose_in_world: pose of camera frame expressed in world frame.
        screen_coord_xy: ``(..., 2)`` — screen coord per pixel (from unwrapped
            phase). These are whatever your screen-shape callable expects;
            typically iPad pixel coords with y-down.
        screen_shape_to_world: callable taking ``(..., 2)`` screen coords and
            returning ``(..., 3)`` world-frame 3D points on the iPad surface.
            If your screen_coord_xy is in pixels (y-down) and your world is
            y-up on the iPad surface, the Y-flip lives INSIDE this callable.
        surface_plane_point: ``(3,)`` — any point on the assumed specimen plane,
            world frame.
        surface_plane_normal: ``(3,)`` unit — outward normal of the assumed
            specimen plane, world frame (points roughly at the camera).

    Returns:
        slope_xy: ``(..., 2)`` — (dz/dx, dz/dy) at each hit point, world frame.
            NaN where the chain failed.
        surface_hits: ``(..., 3)`` — world-frame hit point on the specimen.
        valid_mask: ``(...,)`` bool — True where every step succeeded.

    Notes on handedness (please actually read this):
    - Slope output is in the world frame (x right, y back, z up). If you want
      to display a slope map in image pixel coords, you'll want to resample
      the slope into pixel space — but the slope _values_ stay in world-frame
      mm/mm.
    - If ``screen_coord_xy`` is Y-flipped (swapped y for height − y), and
      ``screen_shape_to_world`` doesn't flip it back, the recovered dz/dy will
      be sign-inverted. That's the canary bug that breaks Phase 4 — the test
      ``test_slope_from_camera_pixel_yflip_canary`` is the defense.
    """
    # 1. camera ray in camera frame
    uv = np.asarray(camera_pixel_uv, dtype=np.float64)
    if uv.shape[-1] != 2:
        raise ValueError(f"camera_pixel_uv last dim must be 2, got {uv.shape}")
    u = uv[..., 0]
    v = uv[..., 1]
    ray_o_cam, ray_d_cam = camera_model.ray_from_pixel(u, v)

    # 2. transform into world frame
    ray_o_world = camera_pose_in_world.apply(ray_o_cam)
    # Directions transform by rotation only (no translation).
    ray_d_world = camera_pose_in_world.rotation.apply(
        ray_d_cam.reshape(-1, 3)
    ).reshape(ray_d_cam.shape)

    # Camera center (origin of camera frame) in world coords — needed as the
    # source of the "incident" ray regardless of the pixel's in-sensor offset.
    # For pinhole this matches ray_o_world. For telecentric each pixel has its
    # own origin on the entrance aperture, which IS the correct emitter point
    # for that pixel (the incident ray genuinely starts at that aperture
    # point and goes to the surface).
    camera_point_world = ray_o_world

    # 3. intersect with specimen plane
    surface_hits, plane_valid = ray_plane_intersection(
        ray_o_world,
        ray_d_world,
        np.asarray(surface_plane_point, dtype=np.float64).reshape(3),
        np.asarray(surface_plane_normal, dtype=np.float64).reshape(3),
    )

    # 4. screen coord → world point on screen (Y-flip lives here, if needed)
    screen_xy = np.asarray(screen_coord_xy, dtype=np.float64)
    if screen_xy.shape[-1] != 2:
        raise ValueError(f"screen_coord_xy last dim must be 2, got {screen_xy.shape}")
    screen_world = screen_shape_to_world(screen_xy)
    screen_world = np.asarray(screen_world, dtype=np.float64)
    if screen_world.shape[-1] != 3:
        raise ValueError(
            "screen_shape_to_world must return a (..., 3) world-frame point"
        )

    # 5. incident ray (camera → surface), normalized
    incident = surface_hits - camera_point_world
    inc_norm = np.linalg.norm(incident, axis=-1, keepdims=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        incident_dir = np.where(inc_norm > 1e-12, incident / inc_norm, np.nan)

    # 6. reflected ray (surface → screen), normalized
    reflected = screen_world - surface_hits
    ref_norm = np.linalg.norm(reflected, axis=-1, keepdims=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        reflected_dir = np.where(ref_norm > 1e-12, reflected / ref_norm, np.nan)

    # 7. surface normal = bisector of (−incident_dir) and reflected_dir.
    # The two "outgoing" rays from the surface are (a) back along the incident
    # toward the camera, and (b) along the reflected toward the screen. Their
    # normalized sum is the surface normal (law of reflection).
    bisector = (-incident_dir) + reflected_dir
    bis_norm = np.linalg.norm(bisector, axis=-1, keepdims=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        normal = np.where(bis_norm > 1e-12, bisector / bis_norm, np.nan)

    # 8. slope = (−nx / nz, −ny / nz). If nz < 0 (normal pointing into world),
    # the surface's "up" is inverted — flip. For our rig the plane normal
    # points up (+z), so we expect nz > 0 for well-behaved pixels; if not,
    # we still return the slope algebraically.
    nx = normal[..., 0]
    ny = normal[..., 1]
    nz = normal[..., 2]
    nz_ok = np.abs(nz) > 1e-12
    with np.errstate(divide="ignore", invalid="ignore"):
        slope_x = np.where(nz_ok, -nx / nz, np.nan)
        slope_y = np.where(nz_ok, -ny / nz, np.nan)
    slope_xy = np.stack([slope_x, slope_y], axis=-1)

    valid = (
        plane_valid
        & np.isfinite(incident_dir).all(axis=-1)
        & np.isfinite(reflected_dir).all(axis=-1)
        & np.isfinite(normal).all(axis=-1)
        & nz_ok
    )
    slope_xy = np.where(valid[..., None], slope_xy, np.nan)
    surface_hits = np.where(valid[..., None], surface_hits, np.nan)

    return slope_xy, surface_hits, valid
