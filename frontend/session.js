import { state, TRANSIENT_TYPES } from './state.js';
import { redraw, canvas, img, showStatus, measurementLabel } from './render.js';
import { renderSidebar, renderInspectionTable } from './sidebar.js';
import { addAnnotation } from './annotations.js';
import { polygonArea } from './math.js';

// ── CSV value helper ────────────────────────────────────────────────────────
function formatCsvValue(ann) {
  const cal = state.calibration;

  function distResult(px) {
    if (!cal) return { value: px.toFixed(1), unit: "px" };
    const mm = px / cal.pixelsPerMm;
    if (cal.displayUnit === "µm") return { value: (mm * 1000).toFixed(1), unit: "µm" };
    return { value: mm.toFixed(3), unit: "mm" };
  }

  function areaResult(px2) {
    if (!cal) return { value: px2.toFixed(1), unit: "px²" };
    const mm2 = px2 / (cal.pixelsPerMm * cal.pixelsPerMm);
    if (cal.displayUnit === "µm") return { value: (mm2 * 1e6).toFixed(1), unit: "µm²" };
    return { value: mm2.toFixed(4), unit: "mm²" };
  }

  if (ann.type === "distance" || ann.type === "perp-dist" || ann.type === "para-dist") {
    return distResult(Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y));
  }
  if (ann.type === "center-dist") {
    return distResult(Math.hypot(ann.b.x - ann.a.x, ann.b.y - ann.a.y));
  }
  if (ann.type === "angle") {
    const v1 = { x: ann.p1.x - ann.vertex.x, y: ann.p1.y - ann.vertex.y };
    const v2 = { x: ann.p3.x - ann.vertex.x, y: ann.p3.y - ann.vertex.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
    const deg = mag < 1e-10 ? 0 : Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI;
    return { value: deg.toFixed(2), unit: "°" };
  }
  if (ann.type === "circle") {
    return distResult(ann.r * 2);
  }
  if (ann.type === "arc-fit") {
    return distResult(ann.r * 2);
  }
  if (ann.type === "arc-measure") {
    const ppm = cal ? cal.pixelsPerMm : 1;
    const r_mm = ann.r / ppm;
    const chord_mm = ann.chord_px / ppm;
    const cx_mm = ann.cx / ppm;
    const cy_mm = ann.cy / ppm;
    const rStr = cal
      ? (cal.displayUnit === "µm" ? `${(r_mm * 1000).toFixed(2)} µm` : `${r_mm.toFixed(3)} mm`)
      : `${ann.r.toFixed(1)} px`;
    const chordStr = cal
      ? (cal.displayUnit === "µm" ? `${(chord_mm * 1000).toFixed(2)} µm` : `${chord_mm.toFixed(3)} mm`)
      : `${ann.chord_px.toFixed(1)} px`;
    const centerStr = cal
      ? `(${cx_mm.toFixed(3)}, ${cy_mm.toFixed(3)}) mm`
      : `(${ann.cx.toFixed(1)}, ${ann.cy.toFixed(1)}) px`;
    return `center=${centerStr}  r=${rStr}  span ${ann.span_deg.toFixed(1)}°  chord=${chordStr}`;
  }
  if (ann.type === "detected-circle") {
    const sx = canvas.width / ann.frameWidth;
    return distResult((ann.radius * sx) * 2);
  }
  if (ann.type === "area") {
    return areaResult(polygonArea(ann.points));
  }
  if (ann.type === "parallelism") {
    return { value: ann.angleDeg.toFixed(2), unit: "°" };
  }
  if (ann.type === "calibration") {
    let px;
    if (ann.x1 !== undefined) {
      px = Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1);
    } else {
      px = ann.r * 2;
    }
    return distResult(px);
  }
  return { value: "", unit: "" };
}

// ── Annotated export ───────────────────────────────────────────────────────
export function exportAnnotatedImage() {
  let sourceCanvas;
  if (state.frozen) {
    // canvas already has frozen background + annotations painted on it
    sourceCanvas = canvas;
  } else {
    // live mode: composite the stream img under the annotation overlay
    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = canvas.width;
    sourceCanvas.height = canvas.height;
    const sctx = sourceCanvas.getContext("2d");
    sctx.drawImage(img, 0, 0, sourceCanvas.width, sourceCanvas.height);
    sctx.drawImage(canvas, 0, 0);
  }
  sourceCanvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `microscope_${new Date().toISOString().replace(/[:.]/g,"-")}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

// ── CSV export ──────────────────────────────────────────────────────────────
export function exportCsv() {
  const rows = [["#", "Name", "Value", "Unit", "type", "label"]];
  let i = 1;
  state.annotations.forEach(ann => {
    const label = measurementLabel(ann);
    if (!label) return;  // skip origin / overlays
    const { value, unit } = formatCsvValue(ann);
    rows.push([i++, ann.name || "", value, unit, ann.type, label]);
  });
  const csv = rows
    .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `measurements_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

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
      "",
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
        "",
        "",
        "",
        "",
        "",
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

// ── Inspection PDF export ────────────────────────────────────────────────────
export function exportInspectionPdf() {
  const { jsPDF } = window.jspdf;
  if (!jsPDF) { showStatus("PDF library not loaded"); return; }

  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = 297;
  const pageH = 210;
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
  const colWidths = [30, 28, 28, 28, 20];
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
      if (i === 4) {
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

  // ── Arc-measure section ──
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

// ── Session save ────────────────────────────────────────────────────────────
export function saveSession() {
  const session = {
    version: 2,
    savedAt: new Date().toISOString(),
    nextId: state.nextId,
    calibration: state.calibration ? { ...state.calibration } : null,
    origin: state.origin ? { ...state.origin } : null,
    featureTolerances: { ...state.featureTolerances },
    dxfFilename: state.dxfFilename ?? null,
    inspectionResults: state.inspectionResults.slice(),
    inspectionFrame: state.inspectionFrame ?? null,
    annotations: state.annotations
      .filter(a => !TRANSIENT_TYPES.has(a.type))
      .map(a => ({ ...a })),
  };
  const json = JSON.stringify(session, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ts = new Date().toISOString().slice(0, 19).replace(/-/g, "").replace("T", "-").replace(/:/g, "");
  a.download = `microscope-session-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Session load ────────────────────────────────────────────────────────────
export function loadSession(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    showStatus("Cannot load: invalid file");
    return;
  }

  // Version check
  if (!data.version) {
    showStatus("Loaded legacy session (no version field)");
    // fall through and attempt to treat as v1
  } else if (data.version <= 2) {
    // proceed
  } else {
    showStatus(`Cannot load: session format version ${data.version} is newer than this app supports`);
    return;
  }

  // Format validation
  if (!Array.isArray(data.annotations)) {
    showStatus("Cannot load: invalid file");
    return;
  }
  if (data.calibration !== null && data.calibration !== undefined) {
    const cal = data.calibration;
    if (typeof cal.pixelsPerMm !== "number" || !isFinite(cal.pixelsPerMm) || cal.pixelsPerMm <= 0) {
      showStatus("Cannot load: invalid file");
      return;
    }
    if (cal.displayUnit !== "mm" && cal.displayUnit !== "µm") {
      showStatus("Cannot load: invalid file");
      return;
    }
  }

  // Confirm overwrite if non-transient annotations exist
  const hasExisting = state.annotations.some(a => !TRANSIENT_TYPES.has(a.type));
  if (hasExisting) {
    if (!confirm("Replace current session? This cannot be undone.")) return;
  }

  // Preserve existing DXF overlay (if any)
  const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");

  // Restore state
  state.annotations = data.annotations.slice();
  if (dxfAnn) state.annotations.push(dxfAnn);

  state.calibration = data.calibration ?? null;
  state.origin = data.origin ?? null;
  state.featureTolerances = (data.featureTolerances && typeof data.featureTolerances === "object")
    ? { ...data.featureTolerances }
    : {};

  // Sync origin annotation's angle from state.origin (state.origin is authoritative)
  if (state.origin) {
    const originAnn = state.annotations.find(a => a.type === "origin");
    if (originAnn) originAnn.angle = state.origin.angle ?? 0;
  }

  if (data.nextId !== undefined && data.nextId !== null) {
    state.nextId = data.nextId;
  } else {
    const maxId = data.annotations.reduce((m, a) => Math.max(m, a.id ?? 0), 0);
    state.nextId = maxId + 1;
  }

  state.selected = null;
  state.dxfFilename = data.dxfFilename ?? null;
  state.inspectionResults = Array.isArray(data.inspectionResults) ? data.inspectionResults.slice() : [];
  state.inspectionFrame = data.inspectionFrame ?? null;

  const coordEl = document.getElementById("coord-display");
  if (coordEl) coordEl.textContent = "";

  // Show status only when no legacy warning was already set
  if (data.version <= 2) showStatus("Session loaded");

  renderSidebar();
  renderInspectionTable();
  redraw();
}
