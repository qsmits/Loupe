# Run Storage + Basic SPC

## Goal

Store inspection results across multiple runs so users can track trends,
compute process capability (Cpk), and generate statistical reports. This
crosses Loupe into ISO 9001 quality-system territory.

## Context

Currently every inspection session is standalone — results are viewed once,
exported as CSV/PDF, and the data is gone when the page reloads. There's no
memory between sessions. An operator inspecting 50 parts of the same type
gets 50 independent results with no way to see trends or compute statistics.

Run storage adds persistence: "Part XYZ, inspected 50 times, here are all
deviations for each feature across all runs." SPC (Statistical Process
Control) adds math on top: Cpk, control charts, histograms.

### What users need this for

- **ISO 9001 shops**: Must demonstrate process capability. Cpk > 1.33 is the
  standard threshold. Without run storage, they export CSVs and compute Cpk
  in Excel manually.
- **Process tuning**: "My EDM wire is drifting — the slot width has increased
  0.002mm per part over the last 20 runs." Trend charts show this at a glance.
- **First-article inspection**: "Here are the measurements from the first 5
  parts. All features are within tolerance with Cpk > 1.67." This is the
  report the customer needs before accepting production parts.

## Design

### 1. Database: SQLite

SQLite (Python standard library, no extra dependencies). Single file at
`data/runs.db` (created on first use). In hosted mode, this is server-side
state — each hosted instance has its own database.

**Tables:**

```sql
CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version VALUES (1);

CREATE TABLE parts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    dxf_filename TEXT,
    template_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    part_id INTEGER NOT NULL REFERENCES parts(id),
    run_number INTEGER NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    operator TEXT DEFAULT '',
    overall_status TEXT CHECK(overall_status IN ('pass', 'warn', 'fail')),
    notes TEXT DEFAULT '',
    UNIQUE(part_id, run_number)
);

CREATE TABLE results (
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
    tolerance_warn REAL,
    tolerance_fail REAL,
    pass_fail TEXT CHECK(pass_fail IN ('pass', 'warn', 'fail')),
    source TEXT DEFAULT 'auto'
);

CREATE INDEX idx_results_run ON results(run_id);
CREATE INDEX idx_results_handle ON results(handle);
CREATE INDEX idx_runs_part ON runs(part_id);
```

**Why not a separate per-session DB:** One shared database per server instance
is simpler. In hosted mode with multiple users, all users' runs are in the
same DB. Isolation comes from the part name — each user works on different
parts. If isolation is needed later, add a `session_id` column.

### 2. Backend module: `backend/run_store.py`

A thin layer over SQLite with these operations:

```python
class RunStore:
    def __init__(self, db_path: str = "data/runs.db"):
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")  # concurrent reads
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._lock = threading.Lock()  # serialize writes only
        self._create_tables()
        self._check_schema_version()

    def create_part(self, name, dxf_filename=None) -> int:
        """Create a part (or return existing ID if name exists)."""

    def save_run(self, part_id, results, operator="", notes="") -> int:
        """Save an inspection run with all feature results. Returns run_id.
        Auto-increments run_number per part."""

    def get_runs(self, part_id, limit=100) -> list[dict]:
        """Get recent runs for a part, newest first."""

    def get_run_results(self, run_id) -> list[dict]:
        """Get all feature results for a specific run."""

    def get_feature_history(self, part_id, handle, limit=50) -> list[dict]:
        """Get deviation history for one feature across runs (for trend chart)."""

    def get_parts(self) -> list[dict]:
        """List all parts."""

    def delete_run(self, run_id) -> None:
        """Delete a run and its results."""

    def compute_spc(self, part_id, handle) -> dict:
        """Compute SPC statistics for one feature:
        mean, std, min, max, Cpk, Ppk, count."""
```

Thread-safe via `threading.Lock` (same pattern as `SessionFrameStore`).

### 3. API endpoints

New router: `backend/api_runs.py`

```
GET  /parts                          → list all parts
POST /parts                          → create part { name, dxf_filename, template_name }
GET  /parts/{id}/runs?offset=0&limit=50 → list runs (paginated)
POST /parts/{id}/runs                → save a new run { results, operator, notes }
GET  /runs/{id}                      → get run details + results
DELETE /runs/{id}                    → delete a run (with confirmation on frontend)
GET  /parts/{id}/spc/{handle}       → get SPC stats for one feature
GET  /parts/{id}/history/{handle}   → get deviation history for trend chart
GET  /parts/{id}/spc-export         → CSV export of all SPC data for a part
```

### 4. Cpk calculation

```python
def compute_cpk(values, usl, lsl):
    """
    Cpk = min((USL - mean) / (3σ), (mean - LSL) / (3σ))

    For symmetric tolerances (±tol):
      USL = +tolerance_fail
      LSL = -tolerance_fail
      mean = average deviation across runs
      σ = standard deviation of deviations
    """
    if len(values) < 2:
        return None
    mean = np.mean(values)
    std = np.std(values, ddof=1)  # sample std dev
    if std < 1e-10:
        return 999.0  # effectively infinite capability (no variation)
    cpu = (usl - mean) / (3 * std)
    cpl = (mean - lsl) / (3 * std)
    return round(min(cpu, cpl), 2)
```

**For our inspection data:**

For **line features** (signed `perp_dev_mm`):
- `values` = array of `perp_dev_mm` across runs (signed: +/- indicates which side)
- `USL` = +`tolerance_fail`, `LSL` = -`tolerance_fail` (symmetric)
- Standard two-sided Cpk

For **circle features** (`center_dev_mm` is unsigned, always ≥ 0):
- Use `tp_dev_mm` (also unsigned) with one-sided capability
- `Cpk = (USL - mean) / (3σ)` where `USL = tolerance_fail`, no LSL
- Or compute Cpk on `datum_dx_mm` and `datum_dy_mm` independently (both signed)
  for a more meaningful two-sided analysis. Deferred to follow-up.

**Tolerance is symmetric for both Punch and Die features.** The Punch/Die
mode affects interpretation (scrap vs rework) but not the tolerance zone
size. Both get the same `tolerance_warn` and `tolerance_fail` values.

Use Python's `statistics.mean` and `statistics.stdev` instead of numpy to
keep the storage module lightweight.

### 5. Frontend: "Save Run" flow

After inspection results are shown:
1. "Save Run" button appears in the inspection panel (next to Export CSV/PDF)
2. Prompts for part name (auto-filled from DXF filename) and optional operator name
3. POSTs to `/parts` (create-or-get) then `/parts/{id}/runs` (save results)
4. Status: "Run #7 saved for Slot Bracket"

### 6. Frontend: SPC dashboard

A new panel accessible from the sidebar or a top-bar menu item.

**Part selector:** Dropdown of all parts with saved runs.

**Run history table:** List of runs for the selected part, with timestamp,
operator, overall pass/fail, run number. Click a run to see its full results.

**Feature trend chart:** Select a feature from the part → show deviation vs.
run number. Horizontal lines at ±warn and ±fail tolerances. Color-coded points
(green/amber/red). This is the core SPC visualization.

**Cpk summary:** Per-feature Cpk values for the selected part. Color-coded:
- Green: Cpk ≥ 1.33 (capable)
- Amber: 1.0 ≤ Cpk < 1.33 (marginal)
- Red: Cpk < 1.0 (not capable)

Histograms are deferred to a follow-up (trend chart + Cpk table is sufficient
for initial release).

**Charting library:** Use Chart.js from CDN (`<script>` tag in index.html).
Lightweight (~60KB gzipped), no build step needed, good enough for line charts
and histograms. Alternative: draw directly on a `<canvas>` element using the
Canvas 2D API (no dependency, but more work).

My recommendation: **Canvas 2D API** — we already use canvas extensively, no
new dependency, full control over appearance, matches the app's aesthetic.
A trend chart is just: axes + horizontal tolerance lines + colored dots.
A histogram is rectangles. A Cpk gauge is an arc. All trivial with Canvas 2D.

### 7. In hosted mode

Run storage works in hosted mode but is shared across all users (one SQLite
database). This is acceptable for a demo/evaluation scenario. For production
hosted use with user isolation, add a `session_id` column to the `parts`
table later.

The database file is server-side state — it persists across server restarts
(unlike the in-memory frame stores). This is the one piece of server-side
persistence in hosted mode.

**Disk usage:** Each run is ~1-2KB (metadata + 20-50 feature results). 1000
runs ≈ 1-2MB. SQLite handles this easily.

## Known limitations

**DXF handle stability:** Feature history is keyed by DXF entity `handle`.
If the DXF is re-exported with different handles, the historical data for
those features becomes orphaned (still in the DB but not matched to new
features). This is acceptable — SPC data is tied to a specific part
definition, and re-exporting the DXF effectively creates a new part revision.

**Template linkage:** When a template is loaded (from Measurement Templates
spec), the "Save Run" prompt should default the part name to the template
name. The `parts.template_name` column stores this association so the SPC
dashboard can show which template a part was created from.

## What this does NOT include

- Ppk (equivalent to Cpk for our use case — no subgroup distinction)
- Histograms (deferred — trend chart + Cpk table is sufficient initially)
- X-bar/R control charts (advanced SPC — mean + range per subgroup)
- Subgroup analysis (grouping runs into statistical subgroups)
- Automated alerts (email/slack when Cpk drops below threshold)
- Run comparison (side-by-side two runs — useful but separate feature)
- Image storage per run (too much disk; save reference to session file instead)
- Export SPC data as QDAS/QIF format (revisit when an ISO shop asks)
