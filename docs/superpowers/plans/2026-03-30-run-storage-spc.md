# Run Storage + Basic SPC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store inspection results across runs in SQLite, compute Cpk per feature, and display trend charts + capability summary so users can track process stability.

**Architecture:** New `backend/run_store.py` module with SQLite database (`data/runs.db`). New `backend/api_runs.py` router for CRUD + SPC endpoints. Frontend adds a "Save Run" button to the inspection panel and a new SPC dashboard panel in the sidebar with Canvas 2D trend charts. Disabled in hosted mode (no server-side file persistence).

**Tech Stack:** Python sqlite3 (standard library), `statistics` module for Cpk, vanilla JS Canvas 2D for charts

**Spec:** `docs/superpowers/specs/2026-03-30-run-storage-spc-design.md`

---

## File Map

### New files
| File | Purpose |
|------|---------|
| `backend/run_store.py` | RunStore class: SQLite CRUD, schema, Cpk calculation |
| `backend/api_runs.py` | REST endpoints for parts, runs, SPC stats |
| `tests/test_run_store.py` | Unit tests for RunStore |
| `frontend/spc.js` | SPC dashboard rendering: trend chart + Cpk summary (Canvas 2D) |

### Files to modify
| File | Changes |
|------|---------|
| `backend/main.py` | Create RunStore, pass to router, hosted mode guard |
| `backend/api.py` | Include runs router in `make_router()` |
| `frontend/index.html` | Add SPC panel in sidebar, Save Run button in inspection panel |
| `frontend/sidebar.js` | Wire Save Run button, render SPC panel |
| `frontend/main.js` | Wire SPC menu/panel toggle |
| `frontend/style.css` | SPC panel and chart styles |

---

### Task 1: RunStore module with SQLite + Cpk + tests

**Files:**
- Create: `backend/run_store.py`
- Create: `tests/test_run_store.py`

- [ ] **Step 1: Write tests**

```python
# tests/test_run_store.py
import os
import pytest
from backend.run_store import RunStore


@pytest.fixture
def store(tmp_path):
    db_path = str(tmp_path / "test_runs.db")
    return RunStore(db_path=db_path)


class TestRunStore:
    def test_create_part(self, store):
        pid = store.create_part("Bracket", dxf_filename="bracket.dxf")
        assert pid > 0
        # Creating same name returns same ID
        pid2 = store.create_part("Bracket")
        assert pid2 == pid

    def test_get_parts(self, store):
        store.create_part("Part A")
        store.create_part("Part B")
        parts = store.get_parts()
        assert len(parts) == 2
        assert parts[0]["name"] == "Part A"

    def test_save_run(self, store):
        pid = store.create_part("Bracket")
        results = [
            {"handle": "L1", "feature_type": "line", "deviation_mm": 0.012,
             "pass_fail": "pass", "tolerance_warn": 0.1, "tolerance_fail": 0.25},
            {"handle": "C1", "feature_type": "circle", "deviation_mm": 0.045,
             "tp_dev_mm": 0.090, "pass_fail": "pass",
             "tolerance_warn": 0.1, "tolerance_fail": 0.25},
        ]
        run_id = store.save_run(pid, results, operator="Alice")
        assert run_id > 0

    def test_get_runs(self, store):
        pid = store.create_part("Bracket")
        store.save_run(pid, [{"handle": "L1", "feature_type": "line",
                              "deviation_mm": 0.01, "pass_fail": "pass",
                              "tolerance_warn": 0.1, "tolerance_fail": 0.25}])
        store.save_run(pid, [{"handle": "L1", "feature_type": "line",
                              "deviation_mm": 0.02, "pass_fail": "pass",
                              "tolerance_warn": 0.1, "tolerance_fail": 0.25}])
        runs = store.get_runs(pid)
        assert len(runs) == 2
        assert runs[0]["run_number"] == 2  # newest first
        assert runs[1]["run_number"] == 1

    def test_get_run_results(self, store):
        pid = store.create_part("Bracket")
        rid = store.save_run(pid, [
            {"handle": "L1", "feature_type": "line", "deviation_mm": 0.012,
             "pass_fail": "pass", "tolerance_warn": 0.1, "tolerance_fail": 0.25},
        ])
        results = store.get_run_results(rid)
        assert len(results) == 1
        assert results[0]["handle"] == "L1"
        assert results[0]["deviation_mm"] == 0.012

    def test_delete_run(self, store):
        pid = store.create_part("Bracket")
        rid = store.save_run(pid, [{"handle": "L1", "feature_type": "line",
                                    "deviation_mm": 0.01, "pass_fail": "pass",
                                    "tolerance_warn": 0.1, "tolerance_fail": 0.25}])
        store.delete_run(rid)
        assert len(store.get_runs(pid)) == 0

    def test_get_feature_history(self, store):
        pid = store.create_part("Bracket")
        for val in [0.01, 0.02, 0.015, 0.025]:
            store.save_run(pid, [{"handle": "L1", "feature_type": "line",
                                  "deviation_mm": val, "pass_fail": "pass",
                                  "tolerance_warn": 0.1, "tolerance_fail": 0.25}])
        history = store.get_feature_history(pid, "L1")
        assert len(history) == 4
        # Oldest first for trend chart
        assert history[0]["deviation_mm"] == 0.01
        assert history[3]["deviation_mm"] == 0.025

    def test_compute_spc(self, store):
        pid = store.create_part("Bracket")
        for val in [0.01, 0.02, 0.015, 0.025, 0.012]:
            store.save_run(pid, [{"handle": "L1", "feature_type": "line",
                                  "deviation_mm": val, "pass_fail": "pass",
                                  "tolerance_warn": 0.1, "tolerance_fail": 0.25}])
        spc = store.compute_spc(pid, "L1")
        assert spc["count"] == 5
        assert 0.01 < spc["mean"] < 0.03
        assert spc["std"] > 0
        assert spc["cpk"] is not None
        assert spc["cpk"] > 0  # should be capable with this data

    def test_compute_spc_insufficient_data(self, store):
        pid = store.create_part("Bracket")
        store.save_run(pid, [{"handle": "L1", "feature_type": "line",
                              "deviation_mm": 0.01, "pass_fail": "pass",
                              "tolerance_warn": 0.1, "tolerance_fail": 0.25}])
        spc = store.compute_spc(pid, "L1")
        assert spc["cpk"] is None  # need >= 2 data points

    def test_run_auto_numbers(self, store):
        pid = store.create_part("Bracket")
        rid1 = store.save_run(pid, [])
        rid2 = store.save_run(pid, [])
        runs = store.get_runs(pid)
        assert runs[0]["run_number"] == 2
        assert runs[1]["run_number"] == 1

    def test_pagination(self, store):
        pid = store.create_part("Bracket")
        for i in range(10):
            store.save_run(pid, [])
        runs = store.get_runs(pid, limit=3, offset=0)
        assert len(runs) == 3
        runs2 = store.get_runs(pid, limit=3, offset=3)
        assert len(runs2) == 3
        assert runs[0]["run_number"] != runs2[0]["run_number"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_run_store.py -v`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `backend/run_store.py`**

```python
"""Run storage for inspection history and SPC computation."""
import os
import sqlite3
import statistics
import threading
import time


class RunStore:
    """Thread-safe SQLite storage for inspection runs and SPC data."""

    SCHEMA_VERSION = 1

    def __init__(self, db_path: str = "data/runs.db"):
        os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._lock = threading.Lock()
        self._create_tables()

    def _create_tables(self):
        with self._lock:
            c = self._conn
            c.execute("""CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER NOT NULL)""")
            row = c.execute("SELECT version FROM schema_version").fetchone()
            if row is None:
                c.execute("INSERT INTO schema_version VALUES (?)", (self.SCHEMA_VERSION,))

            c.execute("""CREATE TABLE IF NOT EXISTS parts (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                dxf_filename TEXT,
                template_name TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )""")

            c.execute("""CREATE TABLE IF NOT EXISTS runs (
                id INTEGER PRIMARY KEY,
                part_id INTEGER NOT NULL REFERENCES parts(id),
                run_number INTEGER NOT NULL,
                timestamp TEXT NOT NULL DEFAULT (datetime('now')),
                operator TEXT DEFAULT '',
                overall_status TEXT CHECK(overall_status IN ('pass', 'warn', 'fail')),
                notes TEXT DEFAULT '',
                UNIQUE(part_id, run_number)
            )""")

            c.execute("""CREATE TABLE IF NOT EXISTS results (
                id INTEGER PRIMARY KEY,
                run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                handle TEXT NOT NULL,
                feature_type TEXT NOT NULL,
                parent_handle TEXT,
                feature_name TEXT DEFAULT '',
                perp_dev_mm REAL,
                center_dev_mm REAL,
                tp_dev_mm REAL,
                radius_dev_mm REAL,
                angle_error_deg REAL,
                deviation_mm REAL,
                tolerance_warn REAL,
                tolerance_fail REAL,
                pass_fail TEXT CHECK(pass_fail IN ('pass', 'warn', 'fail')),
                source TEXT DEFAULT 'auto'
            )""")

            c.execute("CREATE INDEX IF NOT EXISTS idx_results_run ON results(run_id)")
            c.execute("CREATE INDEX IF NOT EXISTS idx_results_handle ON results(handle)")
            c.execute("CREATE INDEX IF NOT EXISTS idx_runs_part ON runs(part_id)")
            c.commit()

    def create_part(self, name, dxf_filename=None, template_name=None):
        with self._lock:
            row = self._conn.execute(
                "SELECT id FROM parts WHERE name = ?", (name,)
            ).fetchone()
            if row:
                return row[0]
            cur = self._conn.execute(
                "INSERT INTO parts (name, dxf_filename, template_name) VALUES (?, ?, ?)",
                (name, dxf_filename, template_name),
            )
            self._conn.commit()
            return cur.lastrowid

    def save_run(self, part_id, results, operator="", notes=""):
        with self._lock:
            # Auto-increment run_number per part
            row = self._conn.execute(
                "SELECT COALESCE(MAX(run_number), 0) FROM runs WHERE part_id = ?",
                (part_id,),
            ).fetchone()
            run_number = row[0] + 1

            # Determine overall status
            statuses = [r.get("pass_fail") for r in results if r.get("pass_fail")]
            if "fail" in statuses:
                overall = "fail"
            elif "warn" in statuses:
                overall = "warn"
            elif statuses:
                overall = "pass"
            else:
                overall = None

            cur = self._conn.execute(
                "INSERT INTO runs (part_id, run_number, operator, overall_status, notes) "
                "VALUES (?, ?, ?, ?, ?)",
                (part_id, run_number, operator, overall, notes),
            )
            run_id = cur.lastrowid

            for r in results:
                self._conn.execute(
                    """INSERT INTO results
                    (run_id, handle, feature_type, parent_handle, feature_name,
                     perp_dev_mm, center_dev_mm, tp_dev_mm, radius_dev_mm,
                     angle_error_deg, deviation_mm, tolerance_warn, tolerance_fail,
                     pass_fail, source)
                    VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?)""",
                    (run_id, r.get("handle", ""), r.get("feature_type", r.get("type", "")),
                     r.get("parent_handle"), r.get("feature_name", ""),
                     r.get("perp_dev_mm"), r.get("center_dev_mm"), r.get("tp_dev_mm"),
                     r.get("radius_dev_mm"), r.get("angle_error_deg"),
                     r.get("deviation_mm"), r.get("tolerance_warn"), r.get("tolerance_fail"),
                     r.get("pass_fail"), r.get("source", "auto")),
                )
            self._conn.commit()
            return run_id

    def get_parts(self):
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, name, dxf_filename, template_name, created_at FROM parts ORDER BY name"
            ).fetchall()
            return [dict(r) for r in rows]

    def get_runs(self, part_id, limit=50, offset=0):
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, run_number, timestamp, operator, overall_status, notes "
                "FROM runs WHERE part_id = ? ORDER BY run_number DESC LIMIT ? OFFSET ?",
                (part_id, limit, offset),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_run_results(self, run_id):
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM results WHERE run_id = ? ORDER BY id", (run_id,)
            ).fetchall()
            return [dict(r) for r in rows]

    def delete_run(self, run_id):
        with self._lock:
            self._conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
            self._conn.commit()

    def get_feature_history(self, part_id, handle, limit=100):
        with self._lock:
            rows = self._conn.execute(
                """SELECT r.deviation_mm, r.tp_dev_mm, r.feature_type,
                          r.perp_dev_mm, r.center_dev_mm,
                          r.pass_fail, r.tolerance_warn, r.tolerance_fail,
                          run.run_number, run.timestamp
                   FROM results r
                   JOIN runs run ON r.run_id = run.id
                   WHERE run.part_id = ? AND r.handle = ?
                   ORDER BY run.run_number ASC LIMIT ?""",
                (part_id, handle, limit),
            ).fetchall()
            return [dict(r) for r in rows]

    def compute_spc(self, part_id, handle):
        history = self.get_feature_history(part_id, handle)
        if not history:
            return {"count": 0, "mean": None, "std": None,
                    "min": None, "max": None, "cpk": None, "feature_type": None}

        feature_type = history[0].get("feature_type", "line")
        is_circle = feature_type in ("circle", "arc", "polyline_arc")

        # For lines: use deviation_mm (= perp_dev_mm, signed, two-sided Cpk)
        # For circles: use deviation_mm (= center_dev_mm, unsigned, one-sided Cpk)
        values = [h["deviation_mm"] for h in history if h["deviation_mm"] is not None]
        if len(values) < 2:
            return {"count": len(values), "mean": None, "std": None,
                    "min": None, "max": None, "cpk": None, "feature_type": feature_type}

        mean = statistics.mean(values)
        std = statistics.stdev(values)
        tol_fail = history[0]["tolerance_fail"] if history else 0.25

        if std < 1e-10:
            cpk = 999.0
        elif is_circle:
            # One-sided Cpk: center_dev_mm is always >= 0, so only upper limit
            cpk = round((tol_fail - mean) / (3 * std), 2)
        else:
            # Two-sided Cpk: perp_dev_mm is signed
            usl = tol_fail
            lsl = -tol_fail
            cpu = (usl - mean) / (3 * std)
            cpl = (mean - lsl) / (3 * std)
            cpk = round(min(cpu, cpl), 2)

        return {
            "count": len(values),
            "mean": round(mean, 6),
            "std": round(std, 6),
            "min": round(min(values), 6),
            "max": round(max(values), 6),
            "cpk": cpk,
            "feature_type": feature_type,
        }
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest tests/test_run_store.py -v`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add backend/run_store.py tests/test_run_store.py
git commit -m "feat: add RunStore with SQLite storage, Cpk computation, and tests"
```

---

### Task 2: API endpoints for runs and SPC

**Files:**
- Create: `backend/api_runs.py`
- Modify: `backend/main.py`
- Modify: `backend/api.py`

- [ ] **Step 1: Create `backend/api_runs.py`**

```python
"""REST endpoints for run storage and SPC."""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .run_store import RunStore


class CreatePartBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    dxf_filename: str = ""
    template_name: str = ""


class SaveRunBody(BaseModel):
    results: list[dict] = Field(max_length=500)
    operator: str = Field(default="", max_length=100)
    notes: str = Field(default="", max_length=1000)


def make_runs_router(run_store: RunStore) -> APIRouter:
    router = APIRouter()

    def _check_hosted(request: Request):
        if getattr(request.app.state, "hosted", False):
            raise HTTPException(403, detail="Run storage disabled in hosted mode")

    @router.get("/parts")
    async def list_parts(request: Request):
        _check_hosted(request)
        return run_store.get_parts()

    @router.post("/parts")
    async def create_part(body: CreatePartBody, request: Request):
        _check_hosted(request)
        pid = run_store.create_part(body.name, body.dxf_filename, body.template_name)
        return {"id": pid, "name": body.name}

    @router.get("/parts/{part_id}/runs")
    async def list_runs(part_id: int, request: Request,
                        limit: int = 50, offset: int = 0):
        _check_hosted(request)
        return run_store.get_runs(part_id, limit=min(limit, 200), offset=max(offset, 0))

    @router.post("/parts/{part_id}/runs")
    async def save_run(part_id: int, body: SaveRunBody, request: Request):
        _check_hosted(request)
        run_id = run_store.save_run(part_id, body.results, body.operator, body.notes)
        return {"run_id": run_id}

    @router.get("/runs/{run_id}")
    async def get_run(run_id: int, request: Request):
        _check_hosted(request)
        results = run_store.get_run_results(run_id)
        return {"run_id": run_id, "results": results}

    @router.delete("/runs/{run_id}")
    async def delete_run(run_id: int, request: Request):
        _check_hosted(request)
        run_store.delete_run(run_id)
        return {"ok": True}

    @router.get("/parts/{part_id}/spc/{handle}")
    async def get_spc(part_id: int, handle: str, request: Request):
        _check_hosted(request)
        return run_store.compute_spc(part_id, handle)

    @router.get("/parts/{part_id}/history/{handle}")
    async def get_history(part_id: int, handle: str, request: Request,
                          limit: int = 100):
        _check_hosted(request)
        return run_store.get_feature_history(part_id, handle, limit=min(limit, 500))

    @router.get("/parts/{part_id}/spc-export")
    async def spc_export(part_id: int, request: Request):
        """CSV export of SPC data for a part."""
        _check_hosted(request)
        from fastapi.responses import Response
        parts = run_store.get_parts()
        part = next((p for p in parts if p["id"] == part_id), None)
        if not part:
            raise HTTPException(404, detail="Part not found")

        import csv, io
        runs = run_store.get_runs(part_id, limit=10000)
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["run_number", "timestamp", "operator", "handle", "feature_type",
                         "deviation_mm", "tp_dev_mm", "tolerance_warn", "tolerance_fail", "pass_fail"])
        for run in reversed(runs):  # oldest first
            results = run_store.get_run_results(run["id"])
            for r in results:
                writer.writerow([
                    run["run_number"], run["timestamp"], run.get("operator", ""),
                    r.get("handle", ""), r.get("feature_type", ""),
                    r.get("deviation_mm", ""), r.get("tp_dev_mm", ""),
                    r.get("tolerance_warn", ""), r.get("tolerance_fail", ""),
                    r.get("pass_fail", ""),
                ])
        csv_content = buf.getvalue()
        return Response(content=csv_content, media_type="text/csv",
                       headers={"Content-Disposition": f"attachment; filename=spc_{part['name']}.csv"})

    return router
```

- [ ] **Step 2: Wire into `main.py`**

In `backend/main.py`:
- Import: `from .run_store import RunStore`
- Create RunStore in `create_app()` (after config load, before lifespan):
  ```python
  run_store = RunStore(db_path=os.path.join(os.path.dirname(__file__), "..", "data", "runs.db"))
  ```
- Pass to `make_router()`: add `run_store` parameter

- [ ] **Step 3: Update `api.py` to include runs router**

In `backend/api.py`, update `make_router()`:
```python
from .api_runs import make_runs_router

def make_router(camera, frame_store, startup_warning=None, run_store=None):
    composed = APIRouter()
    composed.include_router(make_camera_router(camera, frame_store, startup_warning))
    composed.include_router(make_detection_router(frame_store))
    composed.include_router(make_inspection_router(frame_store))
    if run_store:
        composed.include_router(make_runs_router(run_store))
    return composed
```

Update the `make_router()` call in `main.py` to pass `run_store=run_store`.

- [ ] **Step 4: Run tests**

```bash
python3 -m pytest tests/test_run_store.py tests/ -q
```

- [ ] **Step 5: Commit**

```bash
git add backend/api_runs.py backend/main.py backend/api.py
git commit -m "feat: add runs API endpoints with hosted mode guard + wire into app"
```

---

### Task 3: Frontend — Save Run button + flow

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/sidebar.js`
- Modify: `frontend/main.js`

- [ ] **Step 1: Add "Save Run" button to inspection panel in HTML**

In `frontend/index.html`, find the inspection panel header area. Add a Save
Run button next to the existing inspection controls:

```html
<button class="detect-btn" id="btn-save-run" hidden title="Save this inspection run for SPC tracking">Save Run</button>
```

Place it after the inspection count display or in the inspection panel footer.

- [ ] **Step 2: Wire Save Run in `sidebar.js`**

In `renderInspectionTable()`, after the table is built, show the Save Run
button when inspection results exist:

```js
const saveRunBtn = document.getElementById("btn-save-run");
if (saveRunBtn) {
  saveRunBtn.hidden = state.inspectionResults.length === 0;
}
```

- [ ] **Step 3: Wire Save Run handler in `main.js`**

```js
document.getElementById("btn-save-run")?.addEventListener("click", async () => {
  if (state.inspectionResults.length === 0) return;

  const partName = prompt("Part name:", state._templateName || state.dxfFilename || "");
  if (!partName) return;

  try {
    // Create or get part
    const partResp = await apiFetch("/parts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: partName,
        dxf_filename: state.dxfFilename || "",
        template_name: state._templateName || "",
      }),
    });
    if (partResp.status === 403) {
      showStatus("Run storage not available in hosted mode");
      return;
    }
    if (!partResp.ok) throw new Error(await partResp.text());
    const part = await partResp.json();

    // Save the run
    const runResp = await apiFetch(`/parts/${part.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        results: state.inspectionResults,
        operator: "",
      }),
    });
    if (!runResp.ok) throw new Error(await runResp.text());
    const run = await runResp.json();

    showStatus(`Run saved: ${partName} #${run.run_id}`);
  } catch (err) {
    showStatus("Failed to save run: " + err.message);
  }
});
```

- [ ] **Step 4: Run tests and commit**

```bash
node --test tests/frontend/test_*.js
git add frontend/index.html frontend/sidebar.js frontend/main.js
git commit -m "feat: Save Run button in inspection panel"
```

---

### Task 4: Frontend — SPC dashboard panel with trend chart

**Files:**
- Create: `frontend/spc.js`
- Modify: `frontend/index.html`
- Modify: `frontend/main.js`
- Modify: `frontend/style.css`

- [ ] **Step 1: Add SPC panel HTML to sidebar**

In `frontend/index.html`, add a collapsible SPC section in the sidebar
(after the inspection panel, before the measurement list):

```html
<div id="spc-panel" class="spc-panel" hidden>
  <div class="section-label section-toggle" id="spc-header">SPC Dashboard ▾</div>
  <div id="spc-body">
    <div class="spc-controls">
      <select id="spc-part-select" class="spc-select">
        <option value="">Select part...</option>
      </select>
      <select id="spc-feature-select" class="spc-select">
        <option value="">Select feature...</option>
      </select>
    </div>
    <canvas id="spc-chart" width="300" height="180"></canvas>
    <div id="spc-cpk-summary"></div>
  </div>
</div>
```

- [ ] **Step 2: Add SPC styles**

In `frontend/style.css`:
```css
.spc-panel { border-bottom: 1px solid var(--border); }
.spc-controls { padding: 6px 10px; display: flex; gap: 6px; }
.spc-select { flex: 1; background: var(--surface-2); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 3px; font-size: 11px; }
#spc-chart { width: 100%; height: 180px; display: block; }
#spc-cpk-summary { padding: 6px 10px; font-size: 11px; }
.cpk-good { color: #32d74b; }
.cpk-marginal { color: #ff9f0a; }
.cpk-bad { color: #ff453a; }
```

- [ ] **Step 3: Create `frontend/spc.js` with trend chart rendering**

```js
// spc.js — SPC dashboard: trend chart + Cpk summary using Canvas 2D
import { apiFetch } from './api.js';

/**
 * Draw a trend chart on the given canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {Array} history — [{run_number, deviation_mm, tolerance_warn, tolerance_fail, pass_fail}]
 */
export function drawTrendChart(canvas, history) {
  if (!history || history.length === 0) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.clientWidth;
  const h = canvas.height = 180;

  ctx.clearRect(0, 0, w, h);

  const margin = { top: 15, right: 10, bottom: 25, left: 45 };
  const plotW = w - margin.left - margin.right;
  const plotH = h - margin.top - margin.bottom;

  const values = history.map(d => d.deviation_mm).filter(v => v != null);
  if (values.length === 0) return;

  const tolWarn = history[0].tolerance_warn || 0.1;
  const tolFail = history[0].tolerance_fail || 0.25;
  const yMax = Math.max(tolFail * 1.2, ...values.map(Math.abs)) * 1.1;
  const yMin = -yMax;

  const xScale = (i) => margin.left + (i / Math.max(1, history.length - 1)) * plotW;
  const yScale = (v) => margin.top + ((yMax - v) / (yMax - yMin)) * plotH;

  // Background
  ctx.fillStyle = "#1c1c1e";
  ctx.fillRect(margin.left, margin.top, plotW, plotH);

  // Tolerance bands
  ctx.fillStyle = "rgba(50, 215, 75, 0.08)";
  ctx.fillRect(margin.left, yScale(tolWarn), plotW, yScale(-tolWarn) - yScale(tolWarn));
  ctx.fillStyle = "rgba(255, 159, 10, 0.08)";
  ctx.fillRect(margin.left, yScale(tolFail), plotW, yScale(tolWarn) - yScale(tolFail));
  ctx.fillRect(margin.left, yScale(-tolWarn), plotW, yScale(-tolFail) - yScale(-tolWarn));

  // Tolerance lines
  for (const [val, color, dash] of [
    [tolWarn, "#ff9f0a", [4, 4]], [-tolWarn, "#ff9f0a", [4, 4]],
    [tolFail, "#ff453a", [2, 2]], [-tolFail, "#ff453a", [2, 2]],
    [0, "rgba(255,255,255,0.2)", []],
  ]) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(dash);
    ctx.moveTo(margin.left, yScale(val));
    ctx.lineTo(margin.left + plotW, yScale(val));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Data line
  ctx.beginPath();
  ctx.strokeStyle = "rgba(96, 165, 250, 0.6)";
  ctx.lineWidth = 1.5;
  history.forEach((d, i) => {
    if (d.deviation_mm == null) return;
    const x = xScale(i);
    const y = yScale(d.deviation_mm);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Data points
  history.forEach((d, i) => {
    if (d.deviation_mm == null) return;
    const x = xScale(i);
    const y = yScale(d.deviation_mm);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = d.pass_fail === "pass" ? "#32d74b"
                  : d.pass_fail === "warn" ? "#ff9f0a" : "#ff453a";
    ctx.fill();
  });

  // Y-axis labels
  ctx.fillStyle = "#888";
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "right";
  for (const v of [-tolFail, -tolWarn, 0, tolWarn, tolFail]) {
    ctx.fillText(v.toFixed(3), margin.left - 4, yScale(v) + 3);
  }

  // X-axis labels (run numbers)
  ctx.textAlign = "center";
  const step = Math.max(1, Math.floor(history.length / 8));
  history.forEach((d, i) => {
    if (i % step === 0 || i === history.length - 1) {
      ctx.fillText(`#${d.run_number}`, xScale(i), h - 5);
    }
  });
}

/**
 * Render Cpk summary HTML.
 */
export function renderCpkSummary(container, spc) {
  if (!spc || spc.count < 2) {
    container.innerHTML = '<span style="color:var(--muted)">Need 2+ runs for SPC</span>';
    return;
  }
  const cpkClass = spc.cpk >= 1.33 ? "cpk-good"
                 : spc.cpk >= 1.0 ? "cpk-marginal" : "cpk-bad";
  container.innerHTML = `
    <div><b>Cpk: <span class="${cpkClass}">${spc.cpk.toFixed(2)}</span></b>
    (${spc.cpk >= 1.33 ? "capable" : spc.cpk >= 1.0 ? "marginal" : "not capable"})</div>
    <div style="color:var(--muted);margin-top:2px">
      n=${spc.count}  mean=${spc.mean.toFixed(4)}  σ=${spc.std.toFixed(4)}
      range=[${spc.min.toFixed(4)}, ${spc.max.toFixed(4)}]
    </div>
  `;
}

/**
 * Load and display SPC data for a part + feature.
 */
export async function loadSpcData(partId, handle) {
  const chartCanvas = document.getElementById("spc-chart");
  const cpkContainer = document.getElementById("spc-cpk-summary");
  if (!chartCanvas || !cpkContainer) return;

  try {
    const [histResp, spcResp] = await Promise.all([
      apiFetch(`/parts/${partId}/history/${handle}`),
      apiFetch(`/parts/${partId}/spc/${handle}`),
    ]);
    if (!histResp.ok || !spcResp.ok) return;
    const history = await histResp.json();
    const spc = await spcResp.json();

    drawTrendChart(chartCanvas, history);
    renderCpkSummary(cpkContainer, spc);
  } catch { /* ignore */ }
}

/**
 * Populate the part and feature dropdowns.
 */
export async function loadSpcParts() {
  const partSelect = document.getElementById("spc-part-select");
  if (!partSelect) return;
  try {
    const resp = await apiFetch("/parts");
    if (resp.status === 403) return;  // hosted mode
    if (!resp.ok) return;
    const parts = await resp.json();
    if (parts.length === 0) return;

    // Show SPC panel
    const panel = document.getElementById("spc-panel");
    if (panel) panel.hidden = false;

    partSelect.innerHTML = '<option value="">Select part...</option>' +
      parts.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
  } catch { /* ignore */ }
}

export async function loadSpcFeatures(partId) {
  const featureSelect = document.getElementById("spc-feature-select");
  if (!featureSelect) return;
  try {
    const runs = await apiFetch(`/parts/${partId}/runs?limit=1`).then(r => r.json());
    if (!runs || runs.length === 0) return;
    const results = await apiFetch(`/runs/${runs[0].id}`).then(r => r.json());
    const features = results.results || [];
    const unique = [...new Map(features.map(f => [f.handle, f])).values()];
    featureSelect.innerHTML = '<option value="">Select feature...</option>' +
      unique.map(f => `<option value="${f.handle}">${f.feature_name || f.handle} (${f.feature_type})</option>`).join("");
  } catch { /* ignore */ }
}
```

- [ ] **Step 4: Wire SPC dashboard in `main.js`**

```js
import { loadSpcParts, loadSpcFeatures, loadSpcData } from './spc.js';

// Load SPC parts on startup (will show panel if parts exist)
loadSpcParts();

// Part selector change
document.getElementById("spc-part-select")?.addEventListener("change", async e => {
  const partId = e.target.value;
  if (!partId) return;
  await loadSpcFeatures(parseInt(partId));
});

// Feature selector change
document.getElementById("spc-feature-select")?.addEventListener("change", async e => {
  const handle = e.target.value;
  const partId = document.getElementById("spc-part-select")?.value;
  if (!handle || !partId) return;
  await loadSpcData(parseInt(partId), handle);
});

// Refresh SPC after saving a run
// (call loadSpcParts() after the save-run handler succeeds)
```

Update the Save Run handler to refresh SPC after saving:
```js
// After successful save:
showStatus(`Run saved: ${partName}`);
loadSpcParts();  // refresh SPC dashboard
```

- [ ] **Step 5: SPC header collapse toggle**

```js
document.getElementById("spc-header")?.addEventListener("click", () => {
  const body = document.getElementById("spc-body");
  const header = document.getElementById("spc-header");
  if (body && header) {
    const open = header.classList.toggle("open");
    body.style.display = open ? "" : "none";
  }
});
```

- [ ] **Step 6: Run all tests**

```bash
node --test tests/frontend/test_*.js
python3 -m pytest tests/ -q
```

- [ ] **Step 7: Manual smoke test**

1. Run inspection on a DXF part
2. Click "Save Run" → prompted for part name → saves
3. Run inspection 4 more times, save each
4. SPC panel appears in sidebar with part dropdown
5. Select the part → feature dropdown populates
6. Select a feature → trend chart shows deviation over 5 runs
7. Cpk summary shows below the chart
8. Export SPC as CSV

- [ ] **Step 8: Commit**

```bash
git add frontend/spc.js frontend/index.html frontend/main.js frontend/style.css
git commit -m "feat: SPC dashboard with trend chart, Cpk summary, and part/feature selectors"
```

---

## Final Verification

```bash
python3 -m pytest tests/ -q             # all backend tests
node --test tests/frontend/test_*.js    # all frontend tests
```

### Manual test checklist
- [ ] Save Run button appears after inspection
- [ ] Run saves with part name prompt
- [ ] SPC panel shows after first saved run
- [ ] Part dropdown lists saved parts
- [ ] Feature dropdown lists features from latest run
- [ ] Trend chart renders with tolerance bands + colored dots
- [ ] Cpk summary shows green/amber/red rating
- [ ] SPC CSV export downloads
- [ ] Hosted mode: Save Run returns 403, SPC panel hidden
- [ ] Delete run works (via API — no UI yet)
- [ ] 50+ runs don't slow down the dashboard
