"""ScreenShape: geometric representation of the iPad display surface.

A ScreenShape maps normalized screen coordinates (u, v) in [0, 1] × [0, 1]
to 3D physical points on the iPad's emission surface, in the *screen frame*.

The screen frame (see ``backend.vision.deflectometry_geometry`` for the full
coordinate doc): x right, y down (matches iPad pixel coords), z out of screen
toward operator. Origin at the top-left corner of the iPad's active area.

Two concrete subclasses:

- :class:`Rectangular2DShape`: assumes iPad is perfectly flat. 3D point is
  simply ``(u * width_mm, v * height_mm, 0)``. No calibration data needed.

- :class:`Distorted2DShape`: backed by a sparse set of calibrated
  ``(u, v, x_mm, y_mm, z_mm)`` control points, interpolated via scipy
  :class:`LinearNDInterpolator`. Captures panel bow, lateral distortion, or
  whatever the calibration revealed. Falls back to the nearest-neighbor
  control point outside the convex hull.

Both are serializable to/from JSON for persistence under ``data/``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.interpolate import LinearNDInterpolator, NearestNDInterpolator


SCREEN_SHAPE_SCHEMA_VERSION = 1


@dataclass
class ScreenShape:
    """Abstract base. Do not instantiate directly; use a subclass.

    Attributes
    ----------
    width_mm : physical width of the active display area (mm).
    height_mm : physical height of the active display area (mm).
    kind : short tag identifying the concrete subclass. Subclasses set this
        via a default so they can still be instantiated as
        ``Rectangular2DShape(width_mm=..., height_mm=...)``.
    """

    width_mm: float
    height_mm: float
    kind: str = "abstract"

    def point_at(self, uv: np.ndarray) -> np.ndarray:
        """Map normalized screen coords to 3D screen-frame points (mm).

        Parameters
        ----------
        uv : array-like, shape (..., 2). Values in [0, 1] × [0, 1].

        Returns
        -------
        (..., 3) array of screen-frame mm coordinates.
        """
        raise NotImplementedError

    def as_dict(self) -> dict:
        raise NotImplementedError

    @staticmethod
    def from_dict(d: dict) -> "ScreenShape":
        """Parse a serialized ScreenShape dict. Dispatches on ``d['kind']``."""
        kind = d.get("kind")
        if kind == "rectangular_2d":
            return Rectangular2DShape.from_dict(d)
        if kind == "distorted_2d":
            return Distorted2DShape.from_dict(d)
        raise ValueError(f"unknown screen shape kind: {kind!r}")


@dataclass
class Rectangular2DShape(ScreenShape):
    """Perfectly-flat iPad assumption. No calibration data needed."""

    kind: str = "rectangular_2d"

    def point_at(self, uv: np.ndarray) -> np.ndarray:
        uv = np.asarray(uv, dtype=np.float64)
        single = uv.ndim == 1
        if single:
            uv = uv[np.newaxis, :]
        out = np.zeros((uv.shape[0], 3), dtype=np.float64)
        out[:, 0] = uv[:, 0] * self.width_mm
        out[:, 1] = uv[:, 1] * self.height_mm
        # z = 0 (flat panel)
        return out[0] if single else out

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "schema_version": SCREEN_SHAPE_SCHEMA_VERSION,
            "width_mm": float(self.width_mm),
            "height_mm": float(self.height_mm),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Rectangular2DShape":
        return cls(
            width_mm=float(d["width_mm"]),
            height_mm=float(d["height_mm"]),
        )


@dataclass
class Distorted2DShape(ScreenShape):
    """Calibrated screen shape from sparse ``(u, v, x_mm, y_mm, z_mm)`` points.

    Fit via scipy :class:`LinearNDInterpolator` over the Delaunay triangulation
    of the ``(u, v)`` control points. Evaluates each of ``x_mm``, ``y_mm``,
    ``z_mm`` independently.

    Outside the convex hull of the control points, falls back to
    nearest-neighbor via a second :class:`NearestNDInterpolator` — so the
    shape is defined across the full ``[0, 1] × [0, 1]`` screen even if
    calibration only covered a portion. A confidence signal (1 = inside
    convex hull, 0 = extrapolating via nearest) is exposed so callers that
    care can down-weight extrapolated regions.

    Minimum 4 control points are required for a valid 2D Delaunay
    triangulation. With fewer, the shape silently falls back to the
    :class:`Rectangular2DShape` math — callers needing strictness should
    check ``len(shape.control_uv) >= 4`` themselves.
    """

    kind: str = "distorted_2d"
    control_uv: np.ndarray = field(
        default_factory=lambda: np.zeros((0, 2), dtype=np.float64)
    )
    control_xyz_mm: np.ndarray = field(
        default_factory=lambda: np.zeros((0, 3), dtype=np.float64)
    )
    residual_rms_mm: float | None = None
    calibrated_at: str | None = None
    # Cached interpolators — not serialized, not compared, not repr'd.
    _interp_xyz: object = field(default=None, repr=False, compare=False)
    _interp_nearest_xyz: object = field(default=None, repr=False, compare=False)

    def __post_init__(self) -> None:
        # Normalize incoming arrays: callers may pass lists from JSON.
        self.control_uv = np.asarray(self.control_uv, dtype=np.float64).reshape(-1, 2)
        self.control_xyz_mm = np.asarray(
            self.control_xyz_mm, dtype=np.float64
        ).reshape(-1, 3)
        if self.control_uv.shape[0] != self.control_xyz_mm.shape[0]:
            raise ValueError(
                f"control_uv and control_xyz_mm row counts disagree: "
                f"{self.control_uv.shape[0]} vs {self.control_xyz_mm.shape[0]}"
            )
        self._rebuild_interpolators()

    def _rebuild_interpolators(self) -> None:
        # LinearNDInterpolator needs ≥4 points for a non-degenerate 2D
        # triangulation; any fewer and we silently fall back to the flat
        # Rectangular2D math in ``point_at``. (Docstring documents this.)
        if len(self.control_uv) < 4:
            self._interp_xyz = None
            self._interp_nearest_xyz = None
            return
        try:
            self._interp_xyz = LinearNDInterpolator(
                self.control_uv, self.control_xyz_mm
            )
            self._interp_nearest_xyz = NearestNDInterpolator(
                self.control_uv, self.control_xyz_mm
            )
        except Exception:
            # Degenerate (all points collinear, etc.) — fall back to flat.
            self._interp_xyz = None
            self._interp_nearest_xyz = None

    def point_at(
        self, uv: np.ndarray, return_confidence: bool = False
    ) -> np.ndarray | tuple[np.ndarray, np.ndarray]:
        """Map normalized screen coords to 3D mm points via interpolation.

        Parameters
        ----------
        uv : array-like, shape (..., 2).
        return_confidence : if True, also return an array of confidences in
            {0.0, 1.0}. 1.0 = inside the convex hull of control points
            (linear interpolation); 0.0 = extrapolation via nearest neighbor.

        Returns
        -------
        (..., 3) array, optionally paired with a (...,) confidence array.
        """
        uv = np.asarray(uv, dtype=np.float64)
        single = uv.ndim == 1
        if single:
            uv = uv[np.newaxis, :]

        if self._interp_xyz is None:
            # Insufficient or degenerate control points — behave like flat.
            flat = Rectangular2DShape(
                width_mm=self.width_mm, height_mm=self.height_mm
            )
            out = flat.point_at(uv)
            # All "confidence" is 0: these points were not inside any hull.
            conf = np.zeros(uv.shape[0], dtype=np.float64)
        else:
            out = self._interp_xyz(uv)
            # LinearNDInterpolator returns NaN outside the convex hull.
            nan_rows = np.any(np.isnan(out), axis=1)
            if nan_rows.any():
                out[nan_rows] = self._interp_nearest_xyz(uv[nan_rows])
            conf = (~nan_rows).astype(np.float64)

        if return_confidence:
            if single:
                return out[0], float(conf[0])
            return out, conf
        return out[0] if single else out

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "schema_version": SCREEN_SHAPE_SCHEMA_VERSION,
            "width_mm": float(self.width_mm),
            "height_mm": float(self.height_mm),
            "control_uv": self.control_uv.tolist(),
            "control_xyz_mm": self.control_xyz_mm.tolist(),
            "residual_rms_mm": (
                None if self.residual_rms_mm is None
                else float(self.residual_rms_mm)
            ),
            "calibrated_at": self.calibrated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Distorted2DShape":
        return cls(
            width_mm=float(d["width_mm"]),
            height_mm=float(d["height_mm"]),
            control_uv=np.asarray(d.get("control_uv", []), dtype=np.float64),
            control_xyz_mm=np.asarray(d.get("control_xyz_mm", []), dtype=np.float64),
            residual_rms_mm=d.get("residual_rms_mm"),
            calibrated_at=d.get("calibrated_at"),
        )
