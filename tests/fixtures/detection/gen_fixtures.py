"""
Run once to regenerate fixture images.
Not a pytest test. Run: python tests/fixtures/detection/gen_fixtures.py
"""
import json, pathlib
import cv2, numpy as np

OUT = pathlib.Path(__file__).parent


def make_rect_edges():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.rectangle(frame, (200, 150), (440, 330), (255, 255, 255), 2)
    cv2.imwrite(str(OUT / "rect_edges.png"), frame)
    (OUT / "rect_edges.json").write_text(json.dumps({
        "edges": [[200,150,440,150],[440,150,440,330],[440,330,200,330],[200,330,200,150]],
        "arcs": [],
    }, indent=2))


def make_partial_arc():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.ellipse(frame, (320, 240), (100, 100), 0, 0, 90, (255, 255, 255), 2)
    cv2.imwrite(str(OUT / "partial_arc.png"), frame)
    (OUT / "partial_arc.json").write_text(json.dumps({
        "edges": [],
        "arcs": [{"cx": 320.0, "cy": 240.0, "r": 100.0, "start_deg": 0.0, "end_deg": 90.0}],
    }, indent=2))


def make_hough_fragments():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    for x1, y1, x2, y2 in [(80,240,200,240),(210,240,350,240),(360,240,560,240)]:
        cv2.line(frame, (x1,y1), (x2,y2), (255,255,255), 2)
    cv2.imwrite(str(OUT / "hough_fragments.png"), frame)
    (OUT / "hough_fragments.json").write_text(json.dumps({
        "edges": [[80, 240, 560, 240]],
        "arcs": [],
    }, indent=2))


if __name__ == "__main__":
    make_rect_edges(); make_partial_arc(); make_hough_fragments()
    print("Fixtures written to", OUT)
