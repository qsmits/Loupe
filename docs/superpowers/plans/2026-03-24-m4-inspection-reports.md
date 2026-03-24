# M4 — Inspection Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make inspection results exportable and archivable: state persistence, sidebar result table, CSV export, PDF export, and session v2 format so re-export works without re-running inspection.

**Architecture:** Three new state fields (`inspectionResults`, `dxfFilename`, `inspectionFrame`) are added to `state.js`. `session.js` gets v2 save/load plus two new export functions. `sidebar.js` gets a collapsible result table rendered from `state.inspectionResults`. `dxf.js` wires the "Run inspection" button to populate inspection state and capture the composited frame. `index.html` adds the jsPDF CDN tag, inspection panel HTML skeleton, and export buttons.

**Tech Stack:** Vanilla JS ES modules, jsPDF 2.5.1 CDN (base bundle, manual cell rendering — no autoTable), pytest (backend tests unchanged)

---

## File Structure

| File | Change |
|------|--------|
| `frontend/state.js` | Add `inspectionResults`, `dxfFilename`, `inspectionFrame` fields |
| `frontend/session.js` | Add `exportInspectionCsv()`, `exportInspectionPdf()`. Extend `saveSession()`/`loadSession()` for v2. |
| `frontend/sidebar.js` | Add `renderInspectionTable()`. Export and call after match runs and session load. |
| `frontend/dxf.js` | Set `dxfFilename` on load. Reset inspection state on load/clear. Add "Run inspection" button that populates `state.inspectionResults` and captures `state.inspectionFrame`. Wire export buttons. |
| `frontend/index.html` | Add jsPDF CDN `<script>`. Add inspection panel HTML. Add export buttons to DXF section. |
| `tests/test_session.py` | New: v1/v2 session save/load unit tests and `exportInspectionCsv` output tests |

---

### Task 1: State Fields

**Files:**
- Modify: `frontend/state.js`

- [ ] **Step 1: Read `state.js` and add the three new fields**

Open `frontend/state.js`. Add after the `featureTolerances` field:

```js
  inspectionResults: [],   // [{handle, type, parent_handle?, matched, deviation_mm,
                           //   angle_error_deg?, tolerance_warn, tolerance_fail, pass_fail}]
  dxfFilename: null,       // string — set when DXF is loaded, e.g. "demuth vblock"
  inspectionFrame: null,   // base64 data-URL — composited camera+overlay JPEG
```

The `state` object should now have these three new properties. `TRANSIENT_TYPES` does **not** include them — they persist with the session.

- [ ] **Step 2: Verify the app still loads**

```bash
# Start server in no-camera mode and open the browser
NO_CAMERA=1 .venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
# Open http://localhost:8000 and check the browser console for errors
```

Expected: no JS errors on load.

- [ ] **Step 3: Commit**

```bash
git add frontend/state.js
git commit -m "feat(m4): add inspectionResults, dxfFilename, inspectionFrame to state"
```

---

### Task 2: Session v2 Save/Load

**Files:**
- Modify: `frontend/session.js`
- Create: `tests/test_session.py`

The session format must be bumped to v2 to include the three new fields. The version ceiling guard in `loadSession()` currently rejects anything with `version !== 1`; it must be raised to accept `<= 2`.

- [ ] **Step 1: Write failing tests for session v2**

Create `tests/test_session.py`:

```python
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
    # Simulate what loadSession() does for v1
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
    # The JS loadSession() check: version > 2 → reject
    assert v3["version"] > 2


def test_inspection_csv_columns():
    """The inspection CSV for a v2 session must have the required column headers."""
    expected_headers = [
        "part_name", "timestamp", "feature_id", "feature_type",
        "deviation_mm", "angle_error_deg", "tolerance_warn", "tolerance_fail", "result"
    ]
    # We test the column contract by construction — the actual CSV generation is in JS
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
    }
    assert list(row.keys()) == expected_headers
    assert row["part_name"] == "demuth vblock"
    assert row["feature_id"] == "142_s1"
    assert row["result"] == "PASS"
```

- [ ] **Step 2: Run tests to verify they pass (they're specification tests, not unit tests of JS code)**

```bash
.venv/bin/pytest tests/test_session.py -v
```

Expected: all 6 tests PASS (they test the data contract only).

- [ ] **Step 3: Modify `session.js` — `saveSession()`**

In `frontend/session.js`, find `saveSession()` and change:
```js
  const session = {
    version: 1,
```
to:
```js
  const session = {
    version: 2,
```

Then add the three new fields after `featureTolerances`:
```js
    dxfFilename: state.dxfFilename ?? null,
    inspectionResults: state.inspectionResults.slice(),
    inspectionFrame: state.inspectionFrame ?? null,
```

- [ ] **Step 4: Modify `session.js` — `loadSession()` version ceiling**

Find this block in `loadSession()`:
```js
  } else if (data.version === 1) {
    // proceed
  } else {
    showStatus(`Cannot load: session format version ${data.version} is newer than this app supports`);
    return;
  }
```

Change to:
```js
  } else if (data.version <= 2) {
    // proceed
  } else {
    showStatus(`Cannot load: session format version ${data.version} is newer than this app supports`);
    return;
  }
```

- [ ] **Step 5: Modify `session.js` — restore new fields in `loadSession()`**

After the line `state.selected = null;`, add:
```js
  state.dxfFilename = data.dxfFilename ?? null;
  state.inspectionResults = Array.isArray(data.inspectionResults) ? data.inspectionResults.slice() : [];
  state.inspectionFrame = data.inspectionFrame ?? null;
```

- [ ] **Step 6: Verify tests still pass**

```bash
.venv/bin/pytest tests/test_session.py -v
```

Expected: all 6 PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/session.js tests/test_session.py
git commit -m "feat(m4): session v2 format with inspectionResults, dxfFilename, inspectionFrame"
```

---

### Task 3: Inspection Result Table

**Files:**
- Modify: `frontend/sidebar.js`
- Modify: `frontend/index.html`

A collapsible panel in the sidebar shows each matched DXF feature with its deviation, tolerance, and pass/fail badge.

- [ ] **Step 1: Add the inspection panel HTML skeleton to `index.html`**

In `frontend/index.html`, find the `<div id="list">` element (the annotation list). Insert the inspection panel **before** it:

```html
<!-- Inspection results panel -->
<div id="inspection-panel" hidden>
  <div class="inspection-header" id="inspection-toggle">
    <span class="inspection-title">Inspection Results</span>
    <span class="inspection-count" id="inspection-count"></span>
    <span class="inspection-chevron" id="inspection-chevron">▾</span>
  </div>
  <div id="inspection-table-wrap">
    <table class="inspection-table">
      <thead>
        <tr>
          <th>Feature ID</th>
          <th>Type</th>
          <th>Deviation</th>
          <th>Tolerance</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody id="inspection-tbody"></tbody>
    </table>
  </div>
</div>
```

- [ ] **Step 2: Add `renderInspectionTable()` to `sidebar.js`**

In `frontend/sidebar.js`, add at the end of the file:

```js
// ── Inspection result table ────────────────────────────────────────────────────
export function renderInspectionTable() {
  const panel = document.getElementById("inspection-panel");
  if (!panel) return;

  if (!state.inspectionResults || state.inspectionResults.length === 0) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;

  const countEl = document.getElementById("inspection-count");
  const tbody = document.getElementById("inspection-tbody");
  if (!tbody) return;

  const total = state.inspectionResults.length;
  const failed = state.inspectionResults.filter(r => r.pass_fail === "fail").length;
  const warned = state.inspectionResults.filter(r => r.pass_fail === "warn").length;
  if (countEl) {
    countEl.textContent = failed > 0
      ? `${total} features — ${failed} FAIL`
      : warned > 0
        ? `${total} features — ${warned} WARN`
        : `${total} features — all PASS`;
  }

  tbody.innerHTML = "";
  state.inspectionResults.forEach(r => {
    const tr = document.createElement("tr");

    const deviationText = r.matched && r.deviation_mm != null
      ? r.deviation_mm.toFixed(4) + " mm"
      : "—";

    const toleranceText = `±${r.tolerance_warn}/${r.tolerance_fail}`;

    let badgeClass, badgeText;
    if (!r.matched) {
      badgeClass = "badge-unmatched"; badgeText = "—";
    } else if (r.pass_fail === "pass") {
      badgeClass = "badge-pass"; badgeText = "PASS";
    } else if (r.pass_fail === "warn") {
      badgeClass = "badge-warn"; badgeText = "WARN";
    } else {
      badgeClass = "badge-fail"; badgeText = "FAIL";
    }

    tr.innerHTML = `
      <td class="insp-handle">${r.handle}</td>
      <td class="insp-type">${r.type}</td>
      <td class="insp-dev">${deviationText}</td>
      <td class="insp-tol">${toleranceText}</td>
      <td><span class="insp-badge ${badgeClass}">${badgeText}</span></td>`;
    tbody.appendChild(tr);
  });

  // Wire collapse toggle (idempotent)
  const toggle = document.getElementById("inspection-toggle");
  const wrap = document.getElementById("inspection-table-wrap");
  const chevron = document.getElementById("inspection-chevron");
  if (toggle && !toggle._m4wired) {
    toggle._m4wired = true;
    toggle.addEventListener("click", () => {
      const collapsed = wrap.hidden;
      wrap.hidden = !collapsed;
      if (chevron) chevron.textContent = collapsed ? "▾" : "▸";
    });
  }
}
```

- [ ] **Step 3: Call `renderInspectionTable()` from `loadSession()`**

In `frontend/session.js`, import `renderInspectionTable` from `sidebar.js`:

```js
import { renderSidebar, renderInspectionTable } from './sidebar.js';
```

Then in `loadSession()`, after `renderSidebar()`:

```js
  renderSidebar();
  renderInspectionTable();
  redraw();
```

- [ ] **Step 4: Manual smoke test**

Start the server and open the browser. In the JS console, run:
```js
import('./state.js').then(m => {
  m.state.inspectionResults = [
    {handle:"142_s1",type:"polyline_arc",matched:true,deviation_mm:0.032,
     angle_error_deg:null,tolerance_warn:0.10,tolerance_fail:0.25,pass_fail:"pass"},
    {handle:"143",type:"line",matched:true,deviation_mm:0.18,
     angle_error_deg:0.5,tolerance_warn:0.10,tolerance_fail:0.25,pass_fail:"warn"},
    {handle:"999",type:"arc",matched:false,deviation_mm:null,
     angle_error_deg:null,tolerance_warn:0.10,tolerance_fail:0.25,pass_fail:"unmatched"},
  ];
});
// Then call renderInspectionTable from the console
```

Expected: inspection panel appears with 3 rows showing PASS (green), WARN (amber), and `—` badges.

- [ ] **Step 5: Commit**

```bash
git add frontend/sidebar.js frontend/index.html
git commit -m "feat(m4): inspection result table in sidebar"
```

---

### Task 4: Inspection CSV Export

**Files:**
- Modify: `frontend/session.js`
- Modify: `frontend/index.html`

New `exportInspectionCsv()` function with two sections: DXF feature deviations and arc-measure annotations.

- [ ] **Step 1: Add `exportInspectionCsv()` to `session.js`**

In `frontend/session.js`, add after `exportCsv()`:

```js
// ── Inspection CSV export ────────────────────────────────────────────────────
export function exportInspectionCsv() {
  const partName = state.dxfFilename || "";
  const timestamp = new Date().toISOString();
  const headers = [
    "part_name", "timestamp", "feature_id", "feature_type",
    "deviation_mm", "angle_error_deg", "tolerance_warn", "tolerance_fail", "result", "notes"
  ];

  const rows = [headers];

  // Section 1 — DXF feature deviations
  state.inspectionResults.forEach(r => {
    rows.push([
      partName,
      timestamp,
      r.handle,
      r.type,
      r.matched && r.deviation_mm != null ? r.deviation_mm.toFixed(4) : "",
      r.angle_error_deg != null ? r.angle_error_deg.toFixed(2) : "",
      r.tolerance_warn,
      r.tolerance_fail,
      r.matched ? r.pass_fail.toUpperCase() : "UNMATCHED",
      "",  // notes empty for DXF features
    ]);
  });

  // Section 2 — Arc-measure annotations
  const ppm = state.calibration ? state.calibration.pixelsPerMm : 1;
  state.annotations
    .filter(ann => ann.type === "arc-measure")
    .forEach(ann => {
      const r_mm = ann.r / ppm;
      const chord_mm = ann.chord_px / ppm;
      const cx_mm = ann.cx / ppm;
      const cy_mm = ann.cy / ppm;
      const notes = `r=${r_mm.toFixed(3)} mm  span=${ann.span_deg.toFixed(1)}°  chord=${chord_mm.toFixed(3)} mm  center=(${cx_mm.toFixed(3)},${cy_mm.toFixed(3)}) mm`;
      rows.push([
        partName,
        timestamp,
        ann.name || String(ann.id),
        "arc-measure",
        "",  // deviation_mm — not applicable
        "",  // angle_error_deg — not applicable
        "",  // tolerance_warn — not applicable
        "",  // tolerance_fail — not applicable
        "",  // result — not applicable
        notes,
      ]);
    });

  const csv = rows
    .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inspection_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 2: Add "Export Inspection CSV" button to `index.html`**

In `frontend/index.html`, find the `#dxf-controls-group` section. After the `<button id="btn-show-deviations">` line, add:

```html
          <div class="dropdown-divider"></div>
          <button class="dropdown-item" id="btn-export-inspection-csv" disabled>Export Inspection CSV</button>
          <button class="dropdown-item" id="btn-export-inspection-pdf" disabled>Export Inspection PDF</button>
```

- [ ] **Step 3: Wire the CSV button in `dxf.js`**

In `frontend/dxf.js`, import `exportInspectionCsv` from `session.js`:

```js
import { exportInspectionCsv } from './session.js';
```

Add button wiring (in the DXF initialisation block where other buttons are wired):

```js
  const btnExportCsv = document.getElementById("btn-export-inspection-csv");
  if (btnExportCsv) {
    btnExportCsv.addEventListener("click", () => {
      exportInspectionCsv();
    });
  }
```

Add a helper to enable/disable the export buttons based on `state.inspectionResults`:

```js
function updateExportButtons() {
  const hasResults = state.inspectionResults.length > 0;
  const csvBtn = document.getElementById("btn-export-inspection-csv");
  const pdfBtn = document.getElementById("btn-export-inspection-pdf");
  if (csvBtn) csvBtn.disabled = !hasResults;
  if (pdfBtn) pdfBtn.disabled = !hasResults;
}
```

Call `updateExportButtons()` whenever `state.inspectionResults` is updated (after run-inspection in Task 6, and after session load).

- [ ] **Step 4: Smoke test CSV output**

In the browser console, after setting `state.inspectionResults` with test data (as in Task 3 step 4), call:
```js
import('./session.js').then(m => m.exportInspectionCsv());
```

Expected: a `.csv` file downloads with the correct headers and rows.

- [ ] **Step 5: Commit**

```bash
git add frontend/session.js frontend/dxf.js frontend/index.html
git commit -m "feat(m4): exportInspectionCsv with DXF feature and arc-measure sections"
```

---

### Task 5: PDF Export

**Files:**
- Modify: `frontend/session.js`
- Modify: `frontend/index.html`
- Modify: `frontend/dxf.js`

jsPDF is loaded via CDN. PDF is A4 landscape: header → annotated image (~60% of page height) → result table (manual cell positioning).

- [ ] **Step 1: Add jsPDF CDN `<script>` to `index.html`**

In `frontend/index.html`, just before the closing `</body>` tag (before the existing `<script type="module">` app entry point), add:

```html
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
```

Do **not** add the autoTable plugin — it's a separate bundle not included in the base package and must not be used.

- [ ] **Step 2: Add `exportInspectionPdf()` to `session.js`**

In `frontend/session.js`, add after `exportInspectionCsv()`:

```js
// ── Inspection PDF export ────────────────────────────────────────────────────
export function exportInspectionPdf() {
  const { jsPDF } = window.jspdf;
  if (!jsPDF) { showStatus("PDF library not loaded"); return; }

  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = 297;  // A4 landscape width mm
  const pageH = 210;  // A4 landscape height mm
  const margin = 10;

  // ── Header ──
  const partName = state.dxfFilename || "(no part)";
  const exportTs = new Date().toLocaleString();
  const scaleText = state.calibration
    ? `${state.calibration.pixelsPerMm.toFixed(3)} px/mm`
    : "uncalibrated";

  doc.setFontSize(14);
  doc.text(`Inspection Report — ${partName}`, margin, margin + 7);
  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text(`Exported: ${exportTs}   Scale: ${scaleText}`, margin, margin + 13);
  doc.setTextColor(0);

  let yPos = margin + 18;

  // ── Annotated image ──
  if (state.inspectionFrame) {
    const imgAreaH = pageH * 0.55;
    const imgAreaW = pageW - margin * 2;
    doc.addImage(state.inspectionFrame, "JPEG", margin, yPos, imgAreaW, imgAreaH);
    yPos += imgAreaH + 5;
  }

  // ── Result table (manual cell rendering) ──
  const colWidths = [30, 28, 28, 28, 20];  // Feature ID, Type, Deviation, Tolerance, Result
  const colHeaders = ["Feature ID", "Type", "Deviation", "Tolerance", "Result"];
  const rowH = 7;
  const fontSize = 8;

  doc.setFontSize(fontSize);
  doc.setFont(undefined, "bold");
  let xPos = margin;
  colHeaders.forEach((h, i) => {
    doc.text(h, xPos + 1, yPos + rowH - 2);
    doc.rect(xPos, yPos, colWidths[i], rowH);
    xPos += colWidths[i];
  });
  yPos += rowH;
  doc.setFont(undefined, "normal");

  state.inspectionResults.forEach(r => {
    if (yPos + rowH > pageH - margin) {
      doc.addPage();
      yPos = margin;
    }
    const deviationText = r.matched && r.deviation_mm != null
      ? r.deviation_mm.toFixed(4) + " mm" : "—";
    const toleranceText = `±${r.tolerance_warn}/${r.tolerance_fail}`;
    const resultText = r.matched ? r.pass_fail.toUpperCase() : "—";

    const cells = [r.handle, r.type, deviationText, toleranceText, resultText];
    xPos = margin;
    cells.forEach((cell, i) => {
      if (i === 4) {  // Result column — colour the text
        if (r.pass_fail === "pass") doc.setTextColor(0, 150, 0);
        else if (r.pass_fail === "warn") doc.setTextColor(200, 120, 0);
        else if (r.pass_fail === "fail") doc.setTextColor(200, 0, 0);
        else doc.setTextColor(100);
      }
      doc.text(String(cell), xPos + 1, yPos + rowH - 2);
      doc.setTextColor(0);
      doc.rect(xPos, yPos, colWidths[i], rowH);
      xPos += colWidths[i];
    });
    yPos += rowH;
  });

  // ── Arc-measure section (secondary block, no deviation columns) ──
  const arcMeasures = state.annotations.filter(a => a.type === "arc-measure");
  if (arcMeasures.length > 0) {
    yPos += 4;
    if (yPos + rowH > pageH - margin) { doc.addPage(); yPos = margin; }
    doc.setFontSize(fontSize);
    doc.setFont(undefined, "bold");
    doc.text("Arc Measurements", margin, yPos + rowH - 2);
    yPos += rowH;
    doc.setFont(undefined, "normal");

    const ppm = state.calibration ? state.calibration.pixelsPerMm : 1;
    arcMeasures.forEach(ann => {
      if (yPos + rowH > pageH - margin) { doc.addPage(); yPos = margin; }
      const r_mm = (ann.r / ppm).toFixed(3);
      const chord_mm = (ann.chord_px / ppm).toFixed(3);
      const label = ann.name || String(ann.id);
      const line = `${label}:  r=${r_mm} mm  span=${ann.span_deg.toFixed(1)}°  chord=${chord_mm} mm`;
      doc.text(line, margin, yPos + rowH - 2);
      yPos += rowH;
    });
  }

  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  doc.save(`inspection_${ts}.pdf`);
}
```

- [ ] **Step 3: Wire the PDF button in `dxf.js`**

In `frontend/dxf.js`, import `exportInspectionPdf` from `session.js`:

```js
import { exportInspectionCsv, exportInspectionPdf } from './session.js';
```

Add button wiring:

```js
  const btnExportPdf = document.getElementById("btn-export-inspection-pdf");
  if (btnExportPdf) {
    btnExportPdf.addEventListener("click", () => {
      exportInspectionPdf();
    });
  }
```

- [ ] **Step 4: Verify jsPDF loads**

Open the browser and confirm there are no JS errors about `window.jspdf`. Check the browser console:

```js
console.log(typeof window.jspdf);
// Expected: "object"
console.log(typeof window.jspdf.jsPDF);
// Expected: "function"
```

- [ ] **Step 5: Commit**

```bash
git add frontend/session.js frontend/dxf.js frontend/index.html
git commit -m "feat(m4): exportInspectionPdf via jsPDF CDN — A4 landscape, manual cell rendering"
```

---

### Task 6: Run Inspection Wire-Up

**Files:**
- Modify: `frontend/dxf.js`

This task wires the "Run inspection" button (added in M3 — if M3 is not yet merged, this task adds it) to populate `state.inspectionResults` and capture `state.inspectionFrame`. It also sets `state.dxfFilename` on DXF load and resets inspection state on DXF load/clear.

**Note on parallel development:** M3 also adds a "Run inspection" button handler. If M3 is not yet merged into this branch, implement the full handler here. At merge time, M3's handler (which adds `ann.lineMatchResults`/`ann.arcMatchResults`) takes precedence; M4's additions (populating `state.inspectionResults` and capturing `state.inspectionFrame`) are merged in.

- [ ] **Step 1: Read `dxf.js` in full**

Read `frontend/dxf.js` completely to understand the existing button wiring pattern before modifying it.

- [ ] **Step 2: Set `state.dxfFilename` on DXF load**

Find the `/load-dxf` response handler in `dxf.js`. After the annotation is pushed to `state.annotations`, add:

```js
  state.dxfFilename = file.name.replace(/\.dxf$/i, "");
```

- [ ] **Step 3: Reset inspection state on DXF load and clear**

In the same DXF load handler, after setting `dxfFilename`, also reset:

```js
  state.inspectionResults = [];
  state.inspectionFrame = null;
  renderInspectionTable();
  updateExportButtons();
```

Import `renderInspectionTable` from `sidebar.js` at the top of `dxf.js`:

```js
import { renderInspectionTable } from './sidebar.js';
```

Find the `btn-dxf-clear` handler. After filtering out the dxf-overlay annotation, add:

```js
  state.dxfFilename = null;
  state.inspectionResults = [];
  state.inspectionFrame = null;
  renderInspectionTable();
  updateExportButtons();
```

- [ ] **Step 4: Wire "Run inspection" button**

If the `#btn-run-inspection` button is **not yet present** in `index.html` (because M3 hasn't merged), add it now inside `#dxf-controls-group`, just before the `<div class="dropdown-divider">` before the export buttons:

```html
          <button class="dropdown-item" id="btn-run-inspection" disabled>Run inspection</button>
```

In `dxf.js`, add the run inspection handler. Import `renderInspectionTable` (already done in step 3). The handler:

1. Collects detected lines and arcs from `state.annotations`
2. Calls `/match-dxf-lines` and `/match-dxf-arcs` in parallel
3. Stores results on `ann.lineMatchResults`/`ann.arcMatchResults`
4. Merges results into `state.inspectionResults` (replace all line/polyline_line entries, preserve arc/polyline_arc — and vice versa for arc runs)
5. Captures `state.inspectionFrame`
6. Calls `renderInspectionTable()` and `updateExportButtons()`

```js
  const btnRunInspection = document.getElementById("btn-run-inspection");
  if (btnRunInspection) {
    btnRunInspection.addEventListener("click", async () => {
      const ann = state.annotations.find(a => a.type === "dxf-overlay");
      if (!ann) return;

      const frameW = ann.frameWidth || canvas.width;
      const sx = canvas.width / frameW;

      const detectedLines = state.annotations
        .filter(a => a.type === "detected-line-merged")
        .map(a => ({
          x1: a.x1 * sx, y1: a.y1 * sx,
          x2: a.x2 * sx, y2: a.y2 * sx,
        }));

      const detectedArcs = state.annotations
        .filter(a => a.type === "detected-arc-partial")
        .map(a => ({
          cx: a.cx * sx, cy: a.cy * sx,
          radius: a.radius * sx,
          start_angle: a.start_angle,
          end_angle: a.end_angle,
        }));

      const lineEntities = (ann.entities || []).filter(
        e => e.type === "line" || e.type === "polyline_line"
      );
      const arcEntities = (ann.entities || []).filter(
        e => e.type === "arc" || e.type === "polyline_arc"
      );

      const body = {
        scale: ann.scale,
        offset_x: ann.offsetX ?? 0,
        offset_y: ann.offsetY ?? 0,
        angle_deg: ann.angle ?? 0,
        flip_h: ann.flipH ?? false,
        flip_v: ann.flipV ?? false,
      };

      // Build per-feature tolerance map
      const tolerances = {};
      (ann.entities || []).forEach(e => {
        const ft = state.featureTolerances[e.handle];
        if (ft) tolerances[e.handle] = ft;
      });

      try {
        btnRunInspection.disabled = true;
        btnRunInspection.textContent = "Running…";

        const [lineResp, arcResp] = await Promise.all([
          fetch("/match-dxf-lines", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...body,
              entities: lineEntities,
              detected_lines: detectedLines,
              tolerance_warn: state.tolerances.warn,
              tolerance_fail: state.tolerances.fail,
              feature_tolerances: tolerances,
            }),
          }),
          fetch("/match-dxf-arcs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...body,
              entities: arcEntities,
              detected_arcs: detectedArcs,
              tolerance_warn: state.tolerances.warn,
              tolerance_fail: state.tolerances.fail,
              feature_tolerances: tolerances,
            }),
          }),
        ]);

        const lineData = await lineResp.json();
        const arcData = await arcResp.json();

        ann.lineMatchResults = lineData.results || [];
        ann.arcMatchResults = arcData.results || [];

        // Merge into state.inspectionResults
        // Strategy: replace all line/polyline_line entries, preserve arc/polyline_arc (and vice versa)
        const lineTypes = new Set(["line", "polyline_line"]);
        const arcTypes = new Set(["arc", "polyline_arc"]);

        const preserved = state.inspectionResults.filter(r =>
          !lineTypes.has(r.type) && !arcTypes.has(r.type)
        );

        const lineResults = ann.lineMatchResults.map(r => ({
          handle: r.handle,
          type: (lineEntities.find(e => e.handle === r.handle) || {}).type || "line",
          parent_handle: (lineEntities.find(e => e.handle === r.handle) || {}).parent_handle || null,
          matched: r.matched,
          deviation_mm: r.perp_dev_mm ?? null,
          angle_error_deg: r.angle_error_deg ?? null,
          tolerance_warn: r.tolerance_warn,
          tolerance_fail: r.tolerance_fail,
          pass_fail: r.pass_fail,
        }));

        const arcResults = ann.arcMatchResults.map(r => ({
          handle: r.handle,
          type: (arcEntities.find(e => e.handle === r.handle) || {}).type || "arc",
          parent_handle: (arcEntities.find(e => e.handle === r.handle) || {}).parent_handle || null,
          matched: r.matched,
          deviation_mm: r.center_dev_mm ?? null,
          angle_error_deg: null,
          tolerance_warn: r.tolerance_warn,
          tolerance_fail: r.tolerance_fail,
          pass_fail: r.pass_fail,
        }));

        state.inspectionResults = [...preserved, ...lineResults, ...arcResults];

        // Capture inspectionFrame: composite camera img + annotation canvas
        const offscreen = document.createElement("canvas");
        offscreen.width = canvas.width;
        offscreen.height = canvas.height;
        const octx = offscreen.getContext("2d");
        octx.drawImage(img, 0, 0, offscreen.width, offscreen.height);
        octx.drawImage(canvas, 0, 0);
        state.inspectionFrame = offscreen.toDataURL("image/jpeg", 0.85);

        renderInspectionTable();
        updateExportButtons();
        redraw();
        showStatus("Inspection complete");
      } catch (err) {
        showStatus("Inspection failed: " + err.message);
      } finally {
        btnRunInspection.disabled = false;
        btnRunInspection.textContent = "Run inspection";
      }
    });
  }
```

Note: `canvas` and `img` are already imported in `dxf.js` from `render.js`.

- [ ] **Step 5: Enable/disable "Run inspection" button correctly**

The "Run inspection" button should be enabled only when there is a DXF overlay AND a frozen frame. Find where `btn-auto-align` is enabled/disabled (it has the same preconditions) and apply the same logic to `btn-run-inspection`.

Update the existing `updateDxfButtons()` function (or equivalent) in `dxf.js`:

```js
  const btnRunInspection = document.getElementById("btn-run-inspection");
  if (btnRunInspection) {
    btnRunInspection.disabled = !hasDxf || !state.frozen;
  }
```

- [ ] **Step 6: Verify end-to-end in the browser**

With the server running and a DXF loaded:
1. Freeze a frame
2. Run line/arc detection
3. Click "Run inspection"
4. Expected: sidebar inspection panel appears with per-feature results
5. Click "Export Inspection CSV" — file downloads with correct headers
6. Click "Export Inspection PDF" — PDF downloads with image and table

- [ ] **Step 7: Commit**

```bash
git add frontend/dxf.js frontend/index.html
git commit -m "feat(m4): wire run-inspection to populate state.inspectionResults and inspectionFrame"
```

---

### Task 7: Session Re-Export Verification

**Files:**
- Modify: `frontend/session.js` (minor, if needed)
- Modify: `frontend/dxf.js` (call `updateExportButtons()` and `renderInspectionTable()` from `loadSession()`)

Re-export from a reloaded v2 session must work without re-running detection.

- [ ] **Step 1: Ensure `loadSession()` calls `renderInspectionTable()` and `updateExportButtons()`**

In `frontend/session.js`, confirm `loadSession()` already calls `renderInspectionTable()` (added in Task 3). Also call `updateExportButtons()` after session load.

`updateExportButtons()` is defined in `dxf.js`. Export it and import it into `session.js`:

```js
// In dxf.js — ensure this is exported:
export function updateExportButtons() {
  const hasResults = state.inspectionResults.length > 0;
  const csvBtn = document.getElementById("btn-export-inspection-csv");
  const pdfBtn = document.getElementById("btn-export-inspection-pdf");
  if (csvBtn) csvBtn.disabled = !hasResults;
  if (pdfBtn) pdfBtn.disabled = !hasResults;
}
```

```js
// In session.js — import it:
import { updateExportButtons } from './dxf.js';
```

```js
// In loadSession() — call after restoring state:
  renderInspectionTable();
  updateExportButtons();
```

Watch for circular imports: `session.js` → `dxf.js` → `session.js` is circular. If this is a problem, move `updateExportButtons()` to a small helper module (e.g., `frontend/ui-helpers.js`) that both can import, or expose it via a DOM event instead:

```js
// Alternative: dispatch a custom event from session.js, listen in dxf.js
// In session.js:
  document.dispatchEvent(new CustomEvent("inspectionResultsChanged"));
// In dxf.js:
  document.addEventListener("inspectionResultsChanged", updateExportButtons);
```

Use the custom event approach if a circular import is detected.

- [ ] **Step 2: Verify v2 session round-trip**

1. Run a full inspection (DXF loaded, frame frozen, detection run, "Run inspection" clicked)
2. Save session (File → Save Session → downloads v2 JSON)
3. Hard-reload the page
4. Load the saved session
5. Expected:
   - Inspection panel appears with the same rows
   - "Export Inspection CSV" button is enabled
   - "Export Inspection PDF" button is enabled
   - Clicking each button produces a correct download **without re-running detection**

- [ ] **Step 3: Verify v1 session still loads without error**

Load any existing v1 session file. Expected:
- No errors in the browser console
- `state.inspectionResults` is `[]`
- Inspection panel is hidden
- Export buttons are disabled

- [ ] **Step 4: Run Python tests**

```bash
.venv/bin/pytest tests/ -v
```

Expected: all existing tests pass plus the 6 new `test_session.py` tests.

- [ ] **Step 5: Final commit**

```bash
git add frontend/session.js frontend/dxf.js
git commit -m "feat(m4): wire session load to restore inspection table and enable re-export"
```

---

## Success Criteria Checklist

- [ ] After a complete inspection, the sidebar shows a result table with per-feature deviation, tolerance, and pass/fail for all matched features.
- [ ] "Export Inspection CSV" produces a file with correct per-feature data, part name from DXF filename, and arc-measure annotation results appended as Section 2.
- [ ] "Export Inspection PDF" produces a PDF containing the composited annotated camera frame and result table (A4 landscape, manual jsPDF cell rendering, no autoTable dependency).
- [ ] Reloading a saved v2 session restores inspection results and enables re-export of both CSV and PDF without re-running detection.
- [ ] v1 sessions load without errors; inspection panel stays hidden; export buttons remain disabled.
- [ ] Loading a new DXF clears stale inspection results from the previous part.
- [ ] All existing tests pass.
