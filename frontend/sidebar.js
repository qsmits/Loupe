import { state, DETECTION_TYPES } from './state.js';
import { redraw, showStatus, getStatus, measurementLabel, listEl, cameraInfoEl } from './render.js';

// ── Sidebar rendering ──────────────────────────────────────────────────────────
export function renderSidebar() {
  listEl.innerHTML = "";
  let i = 0;
  state.annotations.forEach(ann => {
    if (ann.type === "edges-overlay" || ann.type === "preprocessed-overlay") return;
    if (ann.type === "dxf-overlay") return;  // DXF overlay is drawn on canvas, not in sidebar
    // Origin annotation: rendered without a measurement number
    if (ann.type === "origin") {
      const row = document.createElement("div");
      row.className = "measurement-item" + (state.selected.has(ann.id) ? " selected" : "");
      row.innerHTML = `
        <span class="measurement-number">⊙</span>
        <span class="measurement-name" style="flex:1;font-size:12px;color:var(--muted)">Origin</span>
        <button class="del-btn" data-id="${ann.id}">✕</button>`;
      row.addEventListener("click", e => {
        if (e.target.classList.contains("del-btn")) return;
        state.selected = new Set([ann.id]);
        state._flashExpiry = Date.now() + 400;
        renderSidebar();
        redraw();
      });
      listEl.appendChild(row);
      return; // skip i++
    }
    const number = String.fromCodePoint(9312 + i);
    i++;
    const row = document.createElement("div");
    row.className = "measurement-item" + (state.selected.has(ann.id) ? " selected" : "");
    row.dataset.id = ann.id;
    row.innerHTML = `
      <span class="measurement-number">${number}</span>
      <input class="measurement-name" type="text" placeholder="Label…">
      <span class="measurement-value">${measurementLabel(ann)}</span>
      <button class="del-btn" data-id="${ann.id}">✕</button>`;
    row.querySelector(".measurement-name").value = ann.name;
    row.querySelector(".measurement-name").addEventListener("input", e => {
      ann.name = e.target.value;
    });
    row.querySelector(".measurement-name").addEventListener("click", e => {
      e.stopPropagation();
    });
    row.addEventListener("click", () => {
      const wasSelected = state.selected.has(ann.id);
      state.selected = new Set([ann.id]);
      state._flashExpiry = Date.now() + 400;
      renderSidebar();
      redraw();
      if (wasSelected) {
        const label = measurementLabel(ann);
        if (!label) return; // origin or unknown — nothing to copy
        const text = ann.name ? `${ann.name}: ${label}` : label;
        navigator.clipboard.writeText(text).then(() => {
          // Flash the newly re-rendered row
          const flashRow = listEl.querySelector(`.measurement-item[data-id="${ann.id}"]`);
          if (flashRow) {
            flashRow.classList.add("copied");
            setTimeout(() => flashRow.classList.remove("copied"), 600);
          }
        }).catch(() => { /* clipboard unavailable — silent no-op */ });
      }
    });
    listEl.appendChild(row);
  });

  // Show selection count in status bar when multiple selected
  if (state.selected.size > 1) {
    const detCount = [...state.selected].filter(id => {
      const a = state.annotations.find(x => x.id === id);
      return a && DETECTION_TYPES.has(a.type);
    }).length;
    const measCount = state.selected.size - detCount;
    let msg = `${state.selected.size} selected`;
    if (detCount > 0 && measCount > 0) {
      msg = `${detCount} detection${detCount > 1 ? "s" : ""}, ${measCount} measurement${measCount > 1 ? "s" : ""} selected`;
    } else if (detCount > 0) {
      msg = `${detCount} detection${detCount > 1 ? "s" : ""} selected`;
    } else if (measCount > 0) {
      msg = `${measCount} measurement${measCount > 1 ? "s" : ""} selected`;
    }
    showStatus(msg);
  }
}

// ── Tolerances config ──────────────────────────────────────────────────────────
export async function loadTolerances() {
  try {
    const r = await fetch("/config/tolerances");
    if (!r.ok) return;
    const cfg = await r.json();
    state.tolerances.warn = cfg.tolerance_warn;
    state.tolerances.fail = cfg.tolerance_fail;
    const warnInput = document.getElementById("tol-warn-input");
    const failInput = document.getElementById("tol-fail-input");
    if (warnInput) warnInput.value = cfg.tolerance_warn;
    if (failInput) failInput.value = cfg.tolerance_fail;
  } catch (_) {}
}

// ── UI config & calibration button ─────────────────────────────────────────────
export async function loadUiConfig() {
  try {
    const data = await fetch("/config/ui").then(r => r.json());
    document.getElementById("app-title").textContent = data.app_name || "Microscope";
    document.title = data.app_name || "Microscope";
    document.documentElement.className = `theme-${data.theme || "macos-dark"}`;
    const nameInput = document.getElementById("app-name-input");
    if (nameInput) nameInput.value = data.app_name || "Microscope";
    const themeSelect = document.getElementById("theme-select");
    if (themeSelect) themeSelect.value = data.theme || "macos-dark";
  } catch (_) {
    // non-fatal: default theme class is already on <html>
  }
}

export function updateCalibrationButton() {
  const btn = document.getElementById("btn-calibration");
  if (!btn) return;
  if (state.calibration) {
    const scale = (1000 / state.calibration.pixelsPerMm).toFixed(3);
    btn.textContent = `${scale} µm/px`;
    btn.classList.remove("uncalibrated");
    btn.classList.add("calibrated");
  } else {
    btn.textContent = "NOT CALIBRATED";
    btn.classList.remove("calibrated");
    btn.classList.add("uncalibrated");
  }
}

// ── Camera info ────────────────────────────────────────────────────────────────
export async function loadCameraInfo() {
  try {
    const r = await fetch("/camera/info");
    const d = await r.json();
    cameraInfoEl.innerHTML =
      `<div>${d.model}</div>` +
      `<div style="color:var(--muted)">${d.width}×${d.height}</div>` +
      `<div id="scale-display">${state.calibration ? scaleText() : "Uncalibrated"}</div>`;
    document.getElementById("exp-slider").value = d.exposure;
    document.getElementById("exp-value").textContent = `${d.exposure} µs`;
    document.getElementById("gain-slider").value = d.gain;
    document.getElementById("gain-value").textContent = `${d.gain} dB`;
    // Populate settings dialog camera info
    const modelEl = document.getElementById("settings-model");
    const serialEl = document.getElementById("settings-serial");
    if (modelEl) modelEl.textContent = d.model;
    if (serialEl) serialEl.textContent = d.serial;

    // Pixel format: initialise dropdown and state
    const fmtSelect = document.getElementById("pixel-format-select");
    if (fmtSelect) {
      const fmt = d.pixel_format && d.pixel_format !== "n/a" ? d.pixel_format : null;
      if (fmt) {
        fmtSelect.value = fmt;
        state.settings.pixelFormat = fmt;
      } else {
        fmtSelect.disabled = true;  // OpenCV fallback — format not configurable
      }
    }

    // White balance — initialise sliders and enable/disable based on availability
    const wbAvailable = d.pixel_format && d.pixel_format !== "n/a";
    const wbManual = wbAvailable && (d.wb_manual_supported ?? true);
    ["red", "green", "blue"].forEach(ch => {
      const slider = document.getElementById(`wb-${ch}-slider`);
      const display = document.getElementById(`wb-${ch}-value`);
      if (slider) {
        slider.value = d[`wb_${ch}`] ?? 1.0;
        if (display) display.textContent = parseFloat(slider.value).toFixed(2);
        slider.disabled = !wbManual;
      }
    });
    const wbAutoBtn = document.getElementById("btn-wb-auto");
    if (wbAutoBtn) wbAutoBtn.disabled = !wbAvailable;

    if (d.no_camera === true && !state._noCamera) {
      state._noCamera = true;
      document.body.classList.add("no-camera");
      showStatus("No camera — image only");
      updateDropOverlay();
    }
  } catch { cameraInfoEl.textContent = "Camera unavailable"; }
}

function updateDropOverlay() {
  const overlay = document.getElementById("drop-overlay");
  if (!overlay) return;
  overlay.classList.toggle("visible", state._noCamera && !state.frozen);
}

export function updateFreezeUI() {
  const btn = document.getElementById("btn-freeze");
  if (state.frozen) {
    btn.textContent = "❄ Frozen";
    btn.classList.replace("freeze-live", "freeze-frozen");
    showStatus("● Frozen");
  } else {
    btn.textContent = "❄ Live";
    btn.classList.replace("freeze-frozen", "freeze-live");
    showStatus("● Live");
  }
  updateDropOverlay();
}

// ── Startup warning ────────────────────────────────────────────────────────────
export async function checkStartupWarning() {
  try {
    const r = await fetch("/camera/startup-warning");
    const d = await r.json();
    if (d.warning) {
      const prev = { text: getStatus() };
      showStatus(d.warning);
      setTimeout(() => {
        showStatus(prev.text);
      }, 8000);
    }
  } catch (_) {
    // Non-fatal: silently ignore network or parse errors
  }
}

export async function loadCameraList() {
  const sel = document.getElementById("camera-select");
  try {
    const [camerasResp, infoResp] = await Promise.all([
      fetch("/cameras"),
      fetch("/camera/info"),
    ]);
    const cameras = await camerasResp.json();
    const info = await infoResp.json();
    const currentId = info.device_id ?? "";
    sel.innerHTML = cameras.map(c =>
      `<option value="${c.id}"${c.id === currentId ? " selected" : ""}>${c.label}</option>`
    ).join("");
    sel.disabled = cameras.length <= 1 && cameras[0]?.id === "opencv-0";
  } catch {
    sel.innerHTML = "<option>Unavailable</option>";
    sel.disabled = true;
  }
}

function scaleText() {
  const cal = state.calibration;
  if (!cal) return "Uncalibrated";
  const pxPerUnit = cal.displayUnit === "µm"
    ? cal.pixelsPerMm / 1000
    : cal.pixelsPerMm;
  return `1 px = ${(1/pxPerUnit).toFixed(3)} ${cal.displayUnit}`;
}

export function updateCameraInfo() {
  const el = document.getElementById("scale-display");
  if (el) el.textContent = scaleText();
}

export function updateDxfControlsVisibility() {
  const ann = state.annotations.find(a => a.type === "dxf-overlay");
  const group = document.getElementById("dxf-controls-group");
  if (group) group.hidden = !ann;
  if (ann) {
    const display = document.getElementById("dxf-angle-display");
    if (display) display.textContent = `${(ann.angle ?? 0).toFixed(1)}°`;
    const scaleInput = document.getElementById("dxf-scale");
    if (scaleInput) scaleInput.value = (ann.scale ?? 1).toFixed(3);
    const fH = document.getElementById("btn-dxf-flip-h");
    if (fH) fH.classList.toggle("active", ann.flipH ?? false);
    const fV = document.getElementById("btn-dxf-flip-v");
    if (fV) fV.classList.toggle("active", ann.flipV ?? false);
  }
  const dxfCircleCount = ann?.entities?.filter(e => e.type === "circle").length ?? 0;
  const autoAlignBtn = document.getElementById("btn-auto-align");
  if (autoAlignBtn) {
    autoAlignBtn.disabled = dxfCircleCount < 2;
    autoAlignBtn.title = dxfCircleCount < 2 ? "At least 2 DXF circles required" : "";
  }
  const inspBtn = document.getElementById("btn-run-inspection");
  if (inspBtn) {
    inspBtn.disabled = !ann;
    inspBtn.title = !ann ? "Load a DXF and detect features first" : "Run DXF inspection";
  }
  const moveBtn = document.getElementById("btn-dxf-move");
  if (moveBtn) {
    moveBtn.disabled = !ann;
    moveBtn.title = !ann ? "Load a DXF first" : "Drag to reposition DXF overlay";
  }
}

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

  // Group results
  const groups = new Map();  // groupKey → []
  for (const r of state.inspectionResults) {
    const key = r.parent_handle || r.handle;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  // Summary
  const total = state.inspectionResults.length;
  const failed = state.inspectionResults.filter(r => r.pass_fail === "fail").length;
  const warned = state.inspectionResults.filter(r => r.pass_fail === "warn").length;
  const matched = state.inspectionResults.filter(r => r.matched).length;
  if (countEl) {
    countEl.textContent = failed > 0
      ? `${matched}/${total} matched — ${failed} FAIL`
      : warned > 0
        ? `${matched}/${total} matched — ${warned} WARN`
        : `${matched}/${total} matched — all PASS`;
  }

  tbody.innerHTML = "";

  for (const [groupKey, results] of groups) {
    // Determine group name
    const dxfAnn = state.annotations.find(a => a.type === "dxf-overlay");
    const entity = dxfAnn?.entities?.find(e => e.handle === groupKey || e.parent_handle === groupKey);
    const layer = entity?.layer;
    const defaultName = (layer && layer !== "0") ? layer : groupKey;
    const groupName = state.featureNames[groupKey] || defaultName;

    // Worst-case result
    const worstResult = results.some(r => r.pass_fail === "fail") ? "fail"
      : results.some(r => r.pass_fail === "warn") ? "warn"
      : results.some(r => r.matched) ? "pass" : "unmatched";

    const segCount = results.length;

    // Group header row
    const headerTr = document.createElement("tr");
    headerTr.className = "insp-group-header";
    const badgeClass = worstResult === "fail" ? "badge-fail"
      : worstResult === "warn" ? "badge-warn"
      : worstResult === "pass" ? "badge-pass" : "badge-unmatched";

    const mode = state.featureModes[groupKey] || "die";
    const modeLabel = mode === "punch" ? "P" : "D";
    const modeClass = mode === "punch" ? "mode-punch" : "mode-die";

    headerTr.innerHTML = `
      <td colspan="4" class="insp-group-name">
        <span class="insp-chevron">▾</span>
        <span class="insp-mode ${modeClass}" title="${mode === 'punch' ? 'Punch (outer)' : 'Die (cavity)'}">${modeLabel}</span>
        <span class="insp-group-label">${groupName}</span>
        <span class="insp-group-count">(${segCount})</span>
      </td>
      <td><span class="insp-badge ${badgeClass}">${worstResult === "unmatched" ? "—" : worstResult.toUpperCase()}</span></td>`;

    // Hover: highlight all handles in group
    headerTr.addEventListener("mouseenter", () => {
      state.inspectionHoverHandle = groupKey;
      redraw();
    });
    headerTr.addEventListener("mouseleave", () => {
      state.inspectionHoverHandle = null;
      redraw();
    });

    // Click to collapse/expand
    let collapsed = false;
    headerTr.style.cursor = "pointer";
    headerTr.addEventListener("click", () => {
      collapsed = !collapsed;
      headerTr.querySelector(".insp-chevron").textContent = collapsed ? "▸" : "▾";
      // Toggle visibility of detail rows
      let sibling = headerTr.nextElementSibling;
      while (sibling && !sibling.classList.contains("insp-group-header")) {
        sibling.hidden = collapsed;
        sibling = sibling.nextElementSibling;
      }
    });

    // Double-click to rename
    headerTr.addEventListener("dblclick", e => {
      e.stopPropagation();
      const labelSpan = headerTr.querySelector(".insp-group-label");
      const input = document.createElement("input");
      input.type = "text";
      input.value = state.featureNames[groupKey] || defaultName;
      input.style.cssText = "width:80px; font-size:10px; padding:0 2px; background:var(--surface-3); color:var(--text); border:1px solid var(--border);";
      input.addEventListener("blur", () => {
        const val = input.value.trim();
        if (val && val !== defaultName) state.featureNames[groupKey] = val;
        else delete state.featureNames[groupKey];
        renderInspectionTable();
      });
      input.addEventListener("keydown", ev => {
        if (ev.key === "Enter") input.blur();
        if (ev.key === "Escape") { delete state.featureNames[groupKey]; renderInspectionTable(); }
      });
      labelSpan.replaceWith(input);
      input.focus();
      input.select();
    });

    tbody.appendChild(headerTr);

    // Detail rows for each result in group
    for (const r of results) {
      const tr = document.createElement("tr");
      tr.className = "insp-detail-row";

      const deviationText = r.matched && r.deviation_mm != null
        ? r.deviation_mm.toFixed(4) + " mm"
        : "—";

      let badgeClass2, badgeText;
      if (!r.matched) {
        badgeClass2 = "badge-unmatched"; badgeText = "—";
      } else if (r.pass_fail === "pass") {
        badgeClass2 = "badge-pass"; badgeText = "PASS";
      } else if (r.pass_fail === "warn") {
        badgeClass2 = "badge-warn"; badgeText = "WARN";
      } else {
        badgeClass2 = "badge-fail"; badgeText = "FAIL";
      }

      const sourceText = r.source === "manual" ? "M" : "";

      tr.innerHTML = `
        <td class="insp-handle">${r.handle}</td>
        <td class="insp-type">${r.type.replace("polyline_", "p_")}</td>
        <td class="insp-dev">${deviationText}</td>
        <td class="insp-tol">±${r.tolerance_warn}/${r.tolerance_fail}</td>
        <td><span class="insp-badge ${badgeClass2}">${badgeText}</span>${sourceText ? `<span class="insp-source">${sourceText}</span>` : ""}</td>`;

      // Hover: highlight just this handle
      tr.addEventListener("mouseenter", () => {
        state.inspectionHoverHandle = r.handle;
        redraw();
      });
      tr.addEventListener("mouseleave", () => {
        state.inspectionHoverHandle = null;
        redraw();
      });

      // Click unmatched to enter point-pick
      if (!r.matched) {
        tr.style.cursor = "pointer";
        tr.title = "Click to measure manually";
        tr.addEventListener("click", () => {
          const ann = state.annotations.find(a => a.type === "dxf-overlay");
          if (!ann) return;
          const entity = ann.entities.find(e => e.handle === r.handle);
          if (!entity) return;
          const ph = entity.parent_handle;
          if (ph) {
            state.inspectionPickTarget = ann.entities.filter(e => e.parent_handle === ph);
          } else {
            state.inspectionPickTarget = [entity];
          }
          state.inspectionPickPoints = [];
          state.inspectionPickFit = null;
          const n = state.inspectionPickTarget.length;
          showStatus(n > 1
            ? `${n} segments. Click points along edge. Double-click or Enter to finish.`
            : "Click points along edge. Double-click or Enter to finish.");
          redraw();
        });
      }

      tbody.appendChild(tr);
    }
  }

  // Wire collapse toggle (idempotent)
  const toggle = document.getElementById("inspection-toggle");
  const wrap = document.getElementById("inspection-table-wrap");
  const chevron = document.getElementById("inspection-chevron");
  if (toggle && !toggle._m4wired) {
    toggle._m4wired = true;
    toggle.addEventListener("click", () => {
      const c = wrap.hidden;
      wrap.hidden = !c;
      if (chevron) chevron.textContent = c ? "▾" : "▸";
    });
  }

  // Show selection count in status bar
  if (state.selected.size > 1) {
    const detCount = [...state.selected].filter(id => {
      const a = state.annotations.find(x => x.id === id);
      return a && DETECTION_TYPES.has(a.type);
    }).length;
    const measCount = state.selected.size - detCount;
    let msg = `${state.selected.size} selected`;
    if (detCount > 0 && measCount > 0) {
      msg = `${detCount} detection${detCount > 1 ? "s" : ""}, ${measCount} measurement${measCount > 1 ? "s" : ""} selected`;
    } else if (detCount > 0) {
      msg = `${detCount} detection${detCount > 1 ? "s" : ""} selected`;
    } else if (measCount > 0) {
      msg = `${measCount} measurement${measCount > 1 ? "s" : ""} selected`;
    }
    showStatus(msg);
  }
}
