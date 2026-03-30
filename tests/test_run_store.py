"""Tests for backend.run_store.RunStore."""

import os
import statistics

import pytest

from backend.run_store import RunStore


@pytest.fixture
def store(tmp_path):
    db_path = str(tmp_path / "test_runs.db")
    return RunStore(db_path=db_path)


def _make_result(handle="H1", feature_type="LINE", deviation_mm=0.01, **kwargs):
    base = {
        "handle": handle,
        "feature_type": feature_type,
        "parent_handle": None,
        "feature_name": f"Feature {handle}",
        "perp_dev_mm": deviation_mm,
        "center_dev_mm": None,
        "tp_dev_mm": None,
        "radius_dev_mm": None,
        "angle_error_deg": None,
        "deviation_mm": deviation_mm,
        "tolerance_warn": 0.05,
        "tolerance_fail": 0.10,
        "pass_fail": "PASS",
        "source": "guided",
    }
    base.update(kwargs)
    return base


class TestRunStore:
    def test_create_part(self, store):
        pid = store.create_part("Widget A", dxf_filename="widget.dxf")
        assert isinstance(pid, int)
        # Same name returns same ID
        pid2 = store.create_part("Widget A")
        assert pid2 == pid

    def test_get_parts(self, store):
        store.create_part("Alpha")
        store.create_part("Beta")
        parts = store.get_parts()
        names = [p["name"] for p in parts]
        assert "Alpha" in names
        assert "Beta" in names
        assert len(parts) == 2

    def test_save_run(self, store):
        pid = store.create_part("Part1")
        results = [_make_result("H1"), _make_result("H2", deviation_mm=0.02)]
        run_id = store.save_run(pid, results, operator="Alice", notes="first run")
        assert isinstance(run_id, int)
        runs = store.get_runs(pid)
        assert len(runs) == 1
        assert runs[0]["operator"] == "Alice"
        assert runs[0]["overall_status"] == "PASS"

    def test_get_runs(self, store):
        pid = store.create_part("Part1")
        store.save_run(pid, [_make_result()])
        store.save_run(pid, [_make_result()])
        store.save_run(pid, [_make_result()])
        runs = store.get_runs(pid)
        # Newest first
        assert runs[0]["run_number"] > runs[-1]["run_number"]
        assert runs[0]["run_number"] == 3

    def test_get_run_results(self, store):
        pid = store.create_part("Part1")
        results = [_make_result("H1", deviation_mm=0.03), _make_result("H2", deviation_mm=0.04)]
        run_id = store.save_run(pid, results)
        fetched = store.get_run_results(run_id)
        assert len(fetched) == 2
        handles = {r["handle"] for r in fetched}
        assert handles == {"H1", "H2"}

    def test_delete_run(self, store):
        pid = store.create_part("Part1")
        run_id = store.save_run(pid, [_make_result()])
        store.delete_run(run_id)
        assert len(store.get_runs(pid)) == 0
        # CASCADE: results should be gone too
        assert len(store.get_run_results(run_id)) == 0

    def test_get_feature_history(self, store):
        pid = store.create_part("Part1")
        for dev in [0.01, 0.02, 0.03]:
            store.save_run(pid, [_make_result("H1", deviation_mm=dev)])
        history = store.get_feature_history(pid, "H1")
        assert len(history) == 3
        # Oldest first
        assert history[0]["run_number"] < history[-1]["run_number"]
        assert history[0]["deviation_mm"] == pytest.approx(0.01)
        assert history[2]["deviation_mm"] == pytest.approx(0.03)
        # Check all expected fields present
        for key in ("deviation_mm", "tp_dev_mm", "feature_type", "perp_dev_mm",
                     "center_dev_mm", "pass_fail", "tolerance_warn", "tolerance_fail",
                     "run_number", "timestamp"):
            assert key in history[0], f"Missing key: {key}"

    def test_compute_spc(self, store):
        pid = store.create_part("Part1")
        deviations = [0.01, 0.02, 0.03, 0.04, 0.05]
        for dev in deviations:
            store.save_run(pid, [_make_result("H1", deviation_mm=dev)])

        spc = store.compute_spc(pid, "H1")
        assert spc["count"] == 5
        assert spc["mean"] == pytest.approx(statistics.mean(deviations))
        assert spc["std"] == pytest.approx(statistics.stdev(deviations))
        assert spc["min"] == pytest.approx(0.01)
        assert spc["max"] == pytest.approx(0.05)
        assert spc["cpk"] is not None
        assert spc["feature_type"] == "LINE"

        # Two-sided Cpk for LINE: min((USL-mean)/(3s), (mean-LSL)/(3s))
        m = statistics.mean(deviations)
        s = statistics.stdev(deviations)
        expected_cpk = min((0.10 - m) / (3 * s), (m - (-0.10)) / (3 * s))
        assert spc["cpk"] == pytest.approx(expected_cpk)

    def test_compute_spc_insufficient_data(self, store):
        pid = store.create_part("Part1")
        store.save_run(pid, [_make_result("H1", deviation_mm=0.01)])
        spc = store.compute_spc(pid, "H1")
        assert spc["count"] == 1
        assert spc["cpk"] is None

    def test_run_auto_numbers(self, store):
        pid1 = store.create_part("Part1")
        pid2 = store.create_part("Part2")
        store.save_run(pid1, [_make_result()])
        store.save_run(pid1, [_make_result()])
        store.save_run(pid2, [_make_result()])

        runs1 = store.get_runs(pid1)
        runs2 = store.get_runs(pid2)
        # Part1 should have run_numbers 1 and 2
        assert {r["run_number"] for r in runs1} == {1, 2}
        # Part2 should have run_number 1 (independent)
        assert runs2[0]["run_number"] == 1

    def test_pagination(self, store):
        pid = store.create_part("Part1")
        for _ in range(5):
            store.save_run(pid, [_make_result()])

        page1 = store.get_runs(pid, limit=2, offset=0)
        page2 = store.get_runs(pid, limit=2, offset=2)
        page3 = store.get_runs(pid, limit=2, offset=4)

        assert len(page1) == 2
        assert len(page2) == 2
        assert len(page3) == 1
        # No overlap
        ids1 = {r["id"] for r in page1}
        ids2 = {r["id"] for r in page2}
        assert ids1.isdisjoint(ids2)
