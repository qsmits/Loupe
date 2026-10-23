"""Run the shared fringe engine in Pyodide, with JSON-only request boundaries.

This module intentionally does not import FastAPI, session storage or cameras.
It is also executable under native Python for cross-runtime parity tests.
"""
import base64
import gc
import io
import json
import math

import cv2
import numpy as np
from PIL import Image
from backend.vision.fringe import (
    analyze_interferogram, reanalyze, undistort_frame, rasterize_polygon_mask,
    wrap_wavefront_result, average_wavefronts, subtract_wavefronts,
)

MAX_DIM = 1024  # Conservative first browser release; explicitly reported.


def _number(body, key, default, low, high):
    value = float(body.get(key, default))
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"Invalid {key}")
    return value


def _prepare(body):
    encoded = body.get("image_b64")
    if not isinstance(encoded, str) or len(encoded) > 28 * 1024 * 1024:
        raise ValueError("Choose an image before starting browser analysis (maximum 20 MiB).")
    raw = base64.b64decode(encoded, validate=True)
    # Check dimensions before allocating a decoded image, including project imports.
    with Image.open(io.BytesIO(raw)) as header:
        if header.width * header.height > 32_000_000:
            raise ValueError("Image is too large. Resize it before browser analysis.")
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Could not decode image")
    image = image[:, :, int(np.argmax([image[:, :, c].std() for c in range(3)]))]
    original = list(image.shape)
    h, w = image.shape
    if max(h, w) > MAX_DIM:
        scale = MAX_DIM / max(h, w)
        image = cv2.resize(image, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    analyzed = list(image.shape)
    k1 = _number(body, "lens_k1", 0, -2, 2)
    if k1:
        image = undistort_frame(image.astype(np.float64), k1)
    polygons = body.get("mask_polygons")
    mask = rasterize_polygon_mask(polygons, *image.shape) if polygons else None
    return image, mask, original, analyzed


def execute(operation, body, progress=lambda *args: None):
    """Return the same result schema as the server without storing any images."""
    try:
        if operation == "analyze":
            progress("decode", 0, "Preparing image in this browser…")
            image, mask, original, analyzed = _prepare(body)
            wavelength = _number(body, "wavelength_nm", 589.3, .01, 2000)
            calibration = body.get("calibration")
            if calibration and calibration.get("wavelength_nm") is not None and abs(float(calibration["wavelength_nm"]) - wavelength) > 1e-9:
                raise ValueError("Calibration and analysis wavelengths disagree")
            model = body.get("form_model", "plane")
            if model not in ("zernike", "plane", "poly2", "poly3"):
                raise ValueError("Invalid form model")
            override = None
            if "carrier_y" in body:
                # UI carrier coordinates refer to the already capped analysis image.
                override = (float(body["carrier_y"]), float(body["carrier_x"]))
            result = analyze_interferogram(image,
                wavelength_nm=wavelength,
                mask_threshold=_number(body, "mask_threshold", .30, 0, 1),
                subtract_terms=body.get("subtract_terms", [1, 2, 3]),
                n_zernike=int(_number(body, "n_zernike", 36, 1, 66)),
                custom_mask=mask, form_model=model,
                lens_k1=float(body.get("lens_k1", 0)), image_is_undistorted=True,
                correct_2pi_jumps=body.get("correct_2pi_jumps", True),
                lpf_sigma_frac=body.get("lpf_sigma_frac"),
                dc_margin_override=body.get("dc_margin_override"),
                dc_cutoff_cycles=body.get("dc_cutoff_cycles", 1.5),
                carrier_override=override, on_progress=progress)
            result.pop("_mask_full", None)
            if calibration:
                calibration = {**calibration, "wavelength_nm": wavelength, "lens_k1": float(body.get("lens_k1", 0))}
                if original != analyzed and calibration.get("mm_per_pixel"):
                    calibration["input_mm_per_pixel"] = calibration["mm_per_pixel"]
                    calibration["mm_per_pixel"] *= max(original) / max(analyzed)
            wrap_wavefront_result(result, calibration=calibration, aperture_recipe=body.get("aperture_recipe"))
            result["tuning"] = {key: body.get(key, default) for key, default in
                (("mask_threshold", .30), ("lpf_sigma_frac", None), ("dc_margin_override", None), ("dc_cutoff_cycles", 1.5))}
            result["browser_resolution"] = {"original": original, "analyzed": analyzed, "max_dimension": MAX_DIM}
            if original != analyzed:
                result["warnings"].append(f"Browser analysis resized {original[1]}×{original[0]} to {analyzed[1]}×{analyzed[0]} pixels (1024-pixel limit).")
        elif operation == "reanalyze":
            rows, cols = body.get("raw_grid_rows"), body.get("raw_grid_cols")
            values = body.get("raw_height_grid_nm")
            # Browser results always have this grid; reject unbounded legacy reconstructions.
            if not rows or not cols or rows > 256 or cols > 256 or not isinstance(values, list) or len(values) != rows * cols:
                raise ValueError("A valid saved raw grid is required for browser recomputation. Analyze the image again.")
            if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values):
                raise ValueError("Raw grid must contain finite heights")
            for key in ("surface_height", "surface_width"):
                _number(body, key, 0, 1, MAX_DIM)
            if len(body["coefficients"]) > 66:
                raise ValueError("Too many Zernike coefficients")
            result = reanalyze(coefficients=body["coefficients"],
                subtract_terms=body.get("subtract_terms", [1, 2, 3]),
                wavelength_nm=_number(body, "wavelength_nm", 589.3, .01, 2000),
                surface_shape=(body["surface_height"], body["surface_width"]),
                mask_serialized=body.get("mask"), n_zernike=body.get("n_zernike", 36),
                form_model=body.get("form_model", "zernike"), raw_height_grid_nm=values,
                raw_wavelength_nm=body.get("raw_wavelength_nm"), raw_grid_rows=rows, raw_grid_cols=cols)
        elif operation == "average":
            result = average_wavefronts(body["results"], wavelength_nm=body.get("wavelength_nm"),
                rejection=body.get("rejection", "none"), rejection_threshold=body.get("rejection_threshold", 3),
                source_polarities=body.get("source_polarities"))
        elif operation == "subtract":
            result = subtract_wavefronts(body["measurement"], body["reference"],
                wavelength_nm=body.get("wavelength_nm"), register=body.get("register", True),
                hosted=True, reference_polarity=body.get("reference_polarity"))
        else:
            raise ValueError("Unsupported browser operation")
        result["execution_engine"] = "browser"
        return result
    finally:
        gc.collect()


def execute_json(operation, body_json, progress=lambda *args: None):
    return json.dumps(execute(operation, json.loads(body_json), progress), allow_nan=False)
