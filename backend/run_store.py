"""SQLite-based run storage for SPC (Statistical Process Control)."""

import os
import sqlite3
import statistics
import threading
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    dxf_filename TEXT,
    template_name TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id INTEGER NOT NULL REFERENCES parts(id),
    run_number INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    operator TEXT NOT NULL DEFAULT '',
    overall_status TEXT NOT NULL DEFAULT 'PASS',
    notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    handle TEXT,
    feature_type TEXT,
    parent_handle TEXT,
    feature_name TEXT,
    perp_dev_mm REAL,
    center_dev_mm REAL,
    tp_dev_mm REAL,
    radius_dev_mm REAL,
    angle_error_deg REAL,
    deviation_mm REAL,
    tolerance_warn REAL,
    tolerance_fail REAL,
    pass_fail TEXT,
    source TEXT
);

CREATE INDEX IF NOT EXISTS idx_results_run ON results(run_id);
CREATE INDEX IF NOT EXISTS idx_results_handle ON results(handle);
CREATE INDEX IF NOT EXISTS idx_runs_part ON runs(part_id);
"""


class RunStore:
    """Thread-safe SQLite storage for inspection runs and SPC data."""

    def __init__(self, db_path: str | None = None):
        if db_path is None:
            data_dir = Path(__file__).resolve().parent.parent / "data"
            data_dir.mkdir(parents=True, exist_ok=True)
            db_path = str(data_dir / "runs.db")
        else:
            os.makedirs(os.path.dirname(db_path) if os.path.dirname(db_path) else ".", exist_ok=True)

        self._db_path = db_path
        self._lock = threading.Lock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        with self._lock:
            conn = self._connect()
            try:
                conn.executescript(_SCHEMA_SQL)
                row = conn.execute("SELECT version FROM schema_version").fetchone()
                if row is None:
                    conn.execute("INSERT INTO schema_version (version) VALUES (?)", (SCHEMA_VERSION,))
                conn.commit()
            finally:
                conn.close()

    # ------------------------------------------------------------------
    # Parts
    # ------------------------------------------------------------------

    def create_part(self, name: str, dxf_filename: str | None = None, template_name: str | None = None) -> int:
        with self._lock:
            conn = self._connect()
            try:
                row = conn.execute("SELECT id FROM parts WHERE name = ?", (name,)).fetchone()
                if row:
                    return row["id"]
                now = datetime.now(timezone.utc).isoformat()
                cur = conn.execute(
                    "INSERT INTO parts (name, dxf_filename, template_name, created_at) VALUES (?, ?, ?, ?)",
                    (name, dxf_filename, template_name, now),
                )
                conn.commit()
                return cur.lastrowid
            finally:
                conn.close()

    def get_parts(self) -> list[dict]:
        conn = self._connect()
        try:
            rows = conn.execute("SELECT * FROM parts ORDER BY name").fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Runs
    # ------------------------------------------------------------------

    def save_run(self, part_id: int, results: list[dict], operator: str = "", notes: str = "") -> int:
        with self._lock:
            conn = self._connect()
            try:
                # Auto-increment run_number per part
                row = conn.execute(
                    "SELECT COALESCE(MAX(run_number), 0) AS mx FROM runs WHERE part_id = ?",
                    (part_id,),
                ).fetchone()
                run_number = row["mx"] + 1

                # Compute overall status
                overall_status = "PASS"
                for r in results:
                    pf = r.get("pass_fail", "PASS")
                    if pf == "FAIL":
                        overall_status = "FAIL"
                        break
                    elif pf == "WARN" and overall_status != "FAIL":
                        overall_status = "WARN"

                now = datetime.now(timezone.utc).isoformat()
                cur = conn.execute(
                    "INSERT INTO runs (part_id, run_number, timestamp, operator, overall_status, notes) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (part_id, run_number, now, operator, overall_status, notes),
                )
                run_id = cur.lastrowid

                for r in results:
                    conn.execute(
                        "INSERT INTO results "
                        "(run_id, handle, feature_type, parent_handle, feature_name, "
                        "perp_dev_mm, center_dev_mm, tp_dev_mm, radius_dev_mm, angle_error_deg, "
                        "deviation_mm, tolerance_warn, tolerance_fail, pass_fail, source) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            run_id,
                            r.get("handle"),
                            r.get("feature_type"),
                            r.get("parent_handle"),
                            r.get("feature_name"),
                            r.get("perp_dev_mm"),
                            r.get("center_dev_mm"),
                            r.get("tp_dev_mm"),
                            r.get("radius_dev_mm"),
                            r.get("angle_error_deg"),
                            r.get("deviation_mm"),
                            r.get("tolerance_warn"),
                            r.get("tolerance_fail"),
                            r.get("pass_fail"),
                            r.get("source"),
                        ),
                    )

                conn.commit()
                return run_id
            finally:
                conn.close()

    def get_runs(self, part_id: int, limit: int = 50, offset: int = 0) -> list[dict]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT * FROM runs WHERE part_id = ? ORDER BY run_number DESC LIMIT ? OFFSET ?",
                (part_id, limit, offset),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def get_run_results(self, run_id: int) -> list[dict]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT * FROM results WHERE run_id = ?", (run_id,)
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def delete_run(self, run_id: int):
        with self._lock:
            conn = self._connect()
            try:
                conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
                conn.commit()
            finally:
                conn.close()

    # ------------------------------------------------------------------
    # Feature history & SPC
    # ------------------------------------------------------------------

    def get_feature_history(self, part_id: int, handle: str, limit: int = 100) -> list[dict]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT res.deviation_mm, res.tp_dev_mm, res.feature_type, "
                "res.perp_dev_mm, res.center_dev_mm, res.pass_fail, "
                "res.tolerance_warn, res.tolerance_fail, "
                "r.run_number, r.timestamp "
                "FROM results res "
                "JOIN runs r ON res.run_id = r.id "
                "WHERE r.part_id = ? AND res.handle = ? "
                "ORDER BY r.run_number ASC "
                "LIMIT ?",
                (part_id, handle, limit),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def compute_spc(self, part_id: int, handle: str) -> dict:
        history = self.get_feature_history(part_id, handle, limit=100000)
        if not history:
            return {"count": 0, "mean": None, "std": None, "min": None, "max": None, "cpk": None, "feature_type": None}

        feature_type = history[0].get("feature_type")
        values = [h["deviation_mm"] for h in history if h["deviation_mm"] is not None]
        count = len(values)

        if count == 0:
            return {"count": 0, "mean": None, "std": None, "min": None, "max": None, "cpk": None, "feature_type": feature_type}

        m = statistics.mean(values)
        mn = min(values)
        mx = max(values)

        if count < 2:
            return {"count": count, "mean": m, "std": None, "min": mn, "max": mx, "cpk": None, "feature_type": feature_type}

        s = statistics.stdev(values)

        # Get tolerance_fail from the most recent result
        tol_fail = None
        for h in reversed(history):
            if h.get("tolerance_fail") is not None:
                tol_fail = h["tolerance_fail"]
                break

        cpk = None
        if tol_fail is not None:
            if s < 1e-12:
                cpk = 999.0
            else:
                is_circle_or_arc = feature_type in ("CIRCLE", "ARC", "circle", "arc")
                if is_circle_or_arc:
                    # One-sided: unsigned center_dev_mm
                    cpk = (tol_fail - m) / (3 * s)
                else:
                    # Two-sided: signed perp_dev_mm
                    usl = tol_fail
                    lsl = -tol_fail
                    cpk = min((usl - m) / (3 * s), (m - lsl) / (3 * s))

        return {
            "count": count,
            "mean": m,
            "std": s,
            "min": mn,
            "max": mx,
            "cpk": cpk,
            "feature_type": feature_type,
        }
