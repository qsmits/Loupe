import cv2
import numpy as np


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


def detect_circles(
    frame: np.ndarray,
    dp: float,
    min_dist: int,
    param1: int,
    param2: int,
    min_radius: int,
    max_radius: int,
) -> list[dict]:
    """
    Run Hough circle detection on frame.
    Returns list of {"x": int, "y": int, "radius": int}.
    """
    gray = _preprocess(frame)
    gray = cv2.GaussianBlur(gray, (5, 5), 1)
    result = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=dp,
        minDist=min_dist,
        param1=param1,
        param2=param2,
        minRadius=min_radius,
        maxRadius=max_radius,
    )
    if result is None:
        return []
    return [
        {"x": int(x), "y": int(y), "radius": int(r)}
        for x, y, r in np.round(result[0]).astype(int)
    ]


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
