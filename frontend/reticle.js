/**
 * reticle.js — Reticle CRUD: load list, load/unload reticle, save custom, annotation conversion.
 */
import { apiFetch } from './api.js';
import { state } from './state.js';
import { redraw } from './render.js';
import { renderSidebar } from './sidebar.js';

/** Cached reticle category list (populated by loadReticleList). */
let _reticleCategories = null;

/**
 * Fetch the reticle category listing from the backend.
 * @returns {Promise<Object>} — { "thread-metric": [...], ... }
 */
export async function loadReticleList() {
  const resp = await apiFetch('/reticles');
  const data = await resp.json();
  _reticleCategories = data.categories || {};
  return _reticleCategories;
}

/** Return the cached category listing (call loadReticleList first). */
export function getReticleCategories() {
  return _reticleCategories;
}

/**
 * Load a specific reticle by category and file stem, and activate it.
 */
export async function loadReticle(category, file) {
  const resp = await apiFetch(`/reticles/${encodeURIComponent(category)}/${encodeURIComponent(file)}`);
  const data = await resp.json();
  state.activeReticle = data;
  state.reticleRotationDeg = 0;
  state.reticleColorOverride = null;
  state.reticleOpacityOverride = null;
  renderSidebar();
  redraw();
}

/**
 * Unload the active reticle.
 */
export function unloadReticle() {
  state.activeReticle = null;
  state.reticleRotationDeg = 0;
  state.reticleColorOverride = null;
  state.reticleOpacityOverride = null;
  renderSidebar();
  redraw();
}

/**
 * Convert current annotations to a reticle and save to server.
 * Requires calibration for px→mm conversion.
 * @param {string} name — user-provided reticle name
 */
export async function saveCustomReticle(name) {
  const cal = state.calibration;
  if (!cal || !cal.pixelsPerMm || cal.pixelsPerMm <= 0) {
    throw new Error('Calibration required to save a reticle');
  }
  const ppm = cal.pixelsPerMm;
  const anns = state.annotations.filter(a =>
    !a.type.startsWith('detected-') && a.type !== 'dxf-overlay' &&
    a.type !== 'edges-overlay' && a.type !== 'preprocessed-overlay' &&
    a.type !== 'origin' && a.type !== 'comment'
  );
  if (anns.length === 0) {
    throw new Error('No annotations to convert');
  }

  // Compute centroid in pixel space
  const points = [];
  for (const ann of anns) {
    if (ann.a) points.push(ann.a);
    if (ann.b) points.push(ann.b);
    if (ann.cx != null) points.push({ x: ann.cx, y: ann.cy });
    if (ann.type === 'point') points.push({ x: ann.x, y: ann.y });
  }
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;

  // Convert annotations to reticle elements (px→mm, centered)
  const elements = [];
  for (const ann of anns) {
    if (ann.a && ann.b) {
      elements.push({
        type: 'line',
        x1: (ann.a.x - cx) / ppm,
        y1: (ann.a.y - cy) / ppm,
        x2: (ann.b.x - cx) / ppm,
        y2: (ann.b.y - cy) / ppm,
      });
    } else if (ann.cx != null && ann.r != null) {
      if (ann.startAngle != null && ann.endAngle != null) {
        elements.push({
          type: 'arc',
          cx: (ann.cx - cx) / ppm,
          cy: (ann.cy - cy) / ppm,
          r: ann.r / ppm,
          startDeg: ann.startAngle * 180 / Math.PI,
          endDeg: ann.endAngle * 180 / Math.PI,
        });
      } else {
        elements.push({
          type: 'circle',
          cx: (ann.cx - cx) / ppm,
          cy: (ann.cy - cy) / ppm,
          r: ann.r / ppm,
        });
      }
    } else if (ann.type === 'point') {
      elements.push({
        type: 'circle',
        cx: (ann.x - cx) / ppm,
        cy: (ann.y - cy) / ppm,
        r: 0.05,
      });
    }
  }

  const reticle = {
    name,
    description: `Custom reticle created from ${anns.length} annotation(s)`,
    units: 'mm',
    elements,
    style: { color: '#00ff00', lineWidth: 1, opacity: 0.7 },
  };

  // Download as JSON file
  const blob = new Blob([JSON.stringify(reticle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Import a reticle from a local JSON file and activate it.
 * @param {File} file
 */
export async function importReticle(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (!Array.isArray(data.elements) || data.elements.length === 0) {
    throw new Error('Invalid reticle file — no elements found');
  }
  state.activeReticle = data;
  state.reticleRotationDeg = 0;
  state.reticleColorOverride = null;
  state.reticleOpacityOverride = null;
  redraw();
}

/**
 * Set rotation angle for the active reticle.
 */
export function setReticleRotation(deg) {
  state.reticleRotationDeg = ((deg % 360) + 360) % 360;
  renderSidebar();
  redraw();
}

/**
 * Nudge reticle rotation by delta degrees.
 */
export function nudgeReticleRotation(deltaDeg) {
  setReticleRotation((state.reticleRotationDeg || 0) + deltaDeg);
}
