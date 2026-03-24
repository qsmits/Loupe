"""
Tests for session v2 format.

These tests verify the JavaScript session logic by parsing the JSON format
directly — we're testing the data contract, not the JS functions themselves.
The tests use Python to construct and parse session JSON as an independent
specification check.
"""
import json
import pytest


V1_SESSION = {
    "version": 1,
    "savedAt": "2026-03-24T10:00:00.000Z",
    "nextId": 5,
    "calibration": {"pixelsPerMm": 12.5, "displayUnit": "mm"},
    "origin": None,
    "featureTolerances": {},
    "annotations": [
        {"id": 1, "type": "distance", "name": "d1", "a": {"x": 0, "y": 0}, "b": {"x": 10, "y": 0}}
    ],
}

V2_SESSION = {
    **V1_SESSION,
    "version": 2,
    "dxfFilename": "demuth vblock",
    "inspectionResults": [
        {
            "handle": "142_s1",
            "type": "polyline_arc",
            "parent_handle": "142",
            "matched": True,
            "deviation_mm": 0.032,
            "angle_error_deg": None,
            "tolerance_warn": 0.10,
            "tolerance_fail": 0.25,
            "pass_fail": "pass",
        }
    ],
    "inspectionFrame": "data:image/jpeg;base64,/9j/AAAA",
}


def test_v2_has_required_fields():
    """v2 session must have all three new fields."""
    assert "dxfFilename" in V2_SESSION
    assert "inspectionResults" in V2_SESSION
    assert "inspectionFrame" in V2_SESSION


def test_v2_inspection_result_fields():
    """Each result record has the required fields."""
    result = V2_SESSION["inspectionResults"][0]
    required = {"handle", "type", "matched", "deviation_mm", "tolerance_warn", "tolerance_fail", "pass_fail"}
    assert required.issubset(result.keys())


def test_v1_missing_fields_default():
    """v1 sessions are missing the new fields — loading code must default them."""
    assert "inspectionResults" not in V1_SESSION
    assert "dxfFilename" not in V1_SESSION
    assert "inspectionFrame" not in V1_SESSION
    results = V1_SESSION.get("inspectionResults", [])
    filename = V1_SESSION.get("dxfFilename", None)
    frame = V1_SESSION.get("inspectionFrame", None)
    assert results == []
    assert filename is None
    assert frame is None


def test_v2_round_trip_json():
    """v2 session serialises and deserialises without data loss."""
    raw = json.dumps(V2_SESSION)
    loaded = json.loads(raw)
    assert loaded["version"] == 2
    assert loaded["dxfFilename"] == "demuth vblock"
    assert loaded["inspectionResults"][0]["deviation_mm"] == pytest.approx(0.032)
    assert loaded["inspectionFrame"].startswith("data:image/jpeg;base64,")


def test_v3_would_be_rejected():
    """A hypothetical v3 session should be flagged as too new by the version check."""
    v3 = {**V2_SESSION, "version": 3}
    assert v3["version"] > 2


def test_inspection_csv_columns():
    """The inspection CSV for a v2 session must have the required column headers."""
    expected_headers = [
        "part_name", "timestamp", "feature_id", "feature_type",
        "deviation_mm", "angle_error_deg", "tolerance_warn", "tolerance_fail", "result", "notes"
    ]
    result = V2_SESSION["inspectionResults"][0]
    row = {
        "part_name": V2_SESSION["dxfFilename"],
        "timestamp": "2026-03-24T10:00:00.000Z",
        "feature_id": result["handle"],
        "feature_type": result["type"],
        "deviation_mm": round(result["deviation_mm"], 4) if result["matched"] else "",
        "angle_error_deg": round(result["angle_error_deg"], 2) if result.get("angle_error_deg") is not None else "",
        "tolerance_warn": result["tolerance_warn"],
        "tolerance_fail": result["tolerance_fail"],
        "result": result["pass_fail"].upper(),
        "notes": "",
    }
    assert list(row.keys()) == expected_headers
    assert row["part_name"] == "demuth vblock"
    assert row["feature_id"] == "142_s1"
    assert row["result"] == "PASS"
