// compare.js — Keyence-style 4-up image settings comparison overlay.
//
// Calls POST /compare/propose, renders the four previews in a 2x2 grid,
// and on double-click calls POST /compare/apply to activate the chosen
// post-processing profile on the live MJPEG stream.

import { apiFetch } from './api.js';
import { showStatus } from './render.js';

let _currentVariants = null;  // list of variant dicts, index-aligned with cells
let _escHandler = null;

function $(id) { return document.getElementById(id); }

function overlayEl() { return $('compare-overlay'); }
function badgeEl() { return $('compare-active-badge'); }
function nameEl() { return $('compare-active-name'); }

function hideOverlay() {
  overlayEl().hidden = true;
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }
}

function showOverlay() {
  overlayEl().hidden = false;
  _escHandler = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); hideOverlay(); }
  };
  document.addEventListener('keydown', _escHandler);
}

async function openCompare() {
  const btn = $('btn-compare');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Proposing…';
  showStatus('Analysing frame…');
  try {
    const r = await apiFetch('/compare/propose', { method: 'POST' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${r.status}`);
    }
    const data = await r.json();
    const items = data.variants || [];
    _currentVariants = items.map((x) => x.variant);

    const cells = overlayEl().querySelectorAll('.compare-cell');
    items.forEach((item, i) => {
      const cell = cells[i];
      if (!cell) return;
      const imgEl = cell.querySelector('img');
      imgEl.src = `data:image/jpeg;base64,${item.preview_b64}`;
      const v = item.variant;
      const label = cell.querySelector('.compare-label');
      label.textContent = `${v.name} — ${v.description}`;
    });
    showOverlay();
    showStatus('Double-click a quadrant to apply, Esc to cancel');
  } catch (e) {
    showStatus(`Compare failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function applyVariant(variant) {
  try {
    const r = await apiFetch('/compare/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    setActiveBadge(variant);
    hideOverlay();
    showStatus(`Applied profile: ${variant.name}`);
  } catch (e) {
    showStatus(`Apply failed: ${e.message}`);
  }
}

async function clearProfile() {
  try {
    const r = await apiFetch('/compare/clear', { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    setActiveBadge(null);
    showStatus('Cleared image profile');
  } catch (e) {
    showStatus(`Clear failed: ${e.message}`);
  }
}

function setActiveBadge(variant) {
  const badge = badgeEl();
  if (!badge) return;
  if (variant) {
    nameEl().textContent = variant.name;
    badge.hidden = false;
  } else {
    nameEl().textContent = '—';
    badge.hidden = true;
  }
}

async function refreshActive() {
  try {
    const r = await apiFetch('/compare/active');
    if (!r.ok) return;
    const data = await r.json();
    setActiveBadge(data.active || null);
  } catch { /* ignore */ }
}

export function initCompareHandlers() {
  const btn = $('btn-compare');
  if (btn) btn.addEventListener('click', openCompare);

  const overlay = overlayEl();
  if (overlay) {
    overlay.querySelectorAll('.compare-cell').forEach((cell) => {
      cell.addEventListener('dblclick', () => {
        const idx = parseInt(cell.dataset.idx, 10);
        if (_currentVariants && _currentVariants[idx]) {
          applyVariant(_currentVariants[idx]);
        }
      });
    });
    // Click on backdrop (but not on a cell) cancels.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) hideOverlay();
    });
  }

  const clearBtn = $('btn-compare-clear');
  if (clearBtn) clearBtn.addEventListener('click', clearProfile);

  // Pick up any profile that was active from a previous session.
  refreshActive();
}
