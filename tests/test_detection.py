import cv2
import numpy as np
import pytest
from backend.vision.detection import detect_edges, detect_circles, detect_lines


def white_circle_frame():
    """640×480 black frame with a white circle — easy for Hough to find."""
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.circle(frame, (320, 240), 80, (255, 255, 255), 3)
    return frame


def white_line_frame():
    """640×480 black frame with a clear white horizontal line."""
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.line(frame, (100, 240), (540, 240), (255, 255, 255), 3)
    return frame


def test_detect_edges_returns_png_bytes():
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    result = detect_edges(frame, threshold1=50, threshold2=150)
    assert isinstance(result, bytes)
    assert result[:4] == b"\x89PNG"  # PNG magic bytes


def test_detect_circles_finds_circle():
    frame = white_circle_frame()
    circles = detect_circles(
        frame, dp=1.2, min_dist=50, param1=100, param2=30,
        min_radius=60, max_radius=100
    )
    assert len(circles) >= 1
    c = circles[0]
    assert abs(c["x"] - 320) < 15
    assert abs(c["y"] - 240) < 15
    assert abs(c["radius"] - 80) < 15


def test_detect_circles_empty_frame():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    circles = detect_circles(
        frame, dp=1.2, min_dist=50, param1=100, param2=30,
        min_radius=10, max_radius=200
    )
    assert circles == []


def test_detect_lines_finds_line():
    frame = white_line_frame()
    lines = detect_lines(
        frame, threshold1=30, threshold2=90,
        hough_threshold=20, min_length=50, max_gap=10
    )
    assert len(lines) >= 1
    seg = lines[0]
    assert {"x1", "y1", "x2", "y2", "length"} <= seg.keys()
    assert seg["length"] > 50


def test_detect_lines_empty_frame():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    lines = detect_lines(
        frame, threshold1=50, threshold2=130,
        hough_threshold=30, min_length=20, max_gap=8
    )
    assert lines == []


def test_preprocessed_view_returns_jpeg_bytes():
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    from backend.vision.detection import preprocessed_view
    result = preprocessed_view(frame)
    assert isinstance(result, bytes)
    assert result[:2] == b"\xff\xd8"  # JPEG magic bytes
