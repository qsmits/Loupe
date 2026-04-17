// fringe-calibration.js — Client-side calibration records for fringe mode.
//
// Calibrations live in localStorage (this is a stateless app with no server
// persistence). Every /fringe/analyze* request should send the active
// calibration via `calibrationPayload(getActiveCalibration())`.
//
// Shape:
//   {
//     id: string,            // uuid-ish
//     name: string,          // user-facing label
//     wavelength_nm: number, // nominal light source wavelength
//     mm_per_pixel: number,  // 0 means uncalibrated
//     lens_k1: number,       // radial distortion coefficient
//     uncertainty_nm: number,// informational
//     method: string,        // "manual" | "stage-micrometer" | "imported" | "default"
//     captured_at: string,   // ISO 8601
//     notes: string,
//   }
//
// Storage keys:
//   loupe.fringe.calibrations      — JSON array of Calibration
//   loupe.fringe.activeCalibrationId — string

const STORAGE_CALIBRATIONS = 'loupe.fringe.calibrations';
const STORAGE_ACTIVE_ID = 'loupe.fringe.activeCalibrationId';

// ── In-memory shim when localStorage throws (private mode, quota, etc.) ─
const _memoryShim = { map: new Map() };
let _storageBroken = false;

function _safeGet(key) {
  if (_storageBroken) return _memoryShim.map.get(key) ?? null;
  try {
    return window.localStorage.getItem(key);
  } catch (_) {
    _storageBroken = true;
    return _memoryShim.map.get(key) ?? null;
  }
}

function _safeSet(key, value) {
  if (_storageBroken) {
    _memoryShim.map.set(key, value);
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch (_) {
    _storageBroken = true;
    _memoryShim.map.set(key, value);
  }
}

function _newId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (_) { /* fall through */ }
  // Fallback: RFC4122-ish v4 from Math.random
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i++) out += hex[(Math.random() * 16) | 0];
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-${hex[(Math.random() * 4) | 0 | 8]}${out.slice(17, 20)}-${out.slice(20, 32)}`;
}

function _nowIso() {
  return new Date().toISOString();
}

// ── Core load/save ─────────────────────────────────────────────────────

function _loadAll() {
  const raw = _safeGet(STORAGE_CALIBRATIONS);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(c => c && typeof c === 'object' && typeof c.id === 'string');
  } catch (_) {
    return [];
  }
}

function _storeAll(list) {
  try {
    _safeSet(STORAGE_CALIBRATIONS, JSON.stringify(list));
  } catch (_) { /* already wrapped, ignore */ }
}

function _defaultCalibration() {
  return {
    id: _newId(),
    name: 'Sodium D (default)',
    wavelength_nm: 589.3,
    mm_per_pixel: 0,
    lens_k1: 0,
    uncertainty_nm: 0.3,
    method: 'default',
    captured_at: _nowIso(),
    notes: '',
  };
}

function _ensureSeeded() {
  const list = _loadAll();
  if (list.length > 0) return list;
  const def = _defaultCalibration();
  _storeAll([def]);
  _safeSet(STORAGE_ACTIVE_ID, def.id);
  return [def];
}

// ── Public API ─────────────────────────────────────────────────────────

export function listCalibrations() {
  return _ensureSeeded().slice();
}

export function getCalibration(id) {
  if (!id) return null;
  const list = _ensureSeeded();
  return list.find(c => c.id === id) ?? null;
}

/**
 * Save (create or update) a calibration. Returns the stored copy.
 * If the input lacks an `id`, a new one is assigned.
 */
export function saveCalibration(cal) {
  if (!cal || typeof cal !== 'object') throw new Error('saveCalibration: invalid input');
  const list = _ensureSeeded();
  const now = _nowIso();
  const wavelength = Number(cal.wavelength_nm);
  if (!Number.isFinite(wavelength) || wavelength <= 0) {
    throw new Error('saveCalibration: wavelength_nm must be > 0');
  }
  const normalized = {
    id: typeof cal.id === 'string' && cal.id ? cal.id : _newId(),
    name: typeof cal.name === 'string' && cal.name ? cal.name : 'Untitled',
    wavelength_nm: wavelength,
    mm_per_pixel: Number.isFinite(Number(cal.mm_per_pixel)) ? Number(cal.mm_per_pixel) : 0,
    lens_k1: Number.isFinite(Number(cal.lens_k1)) ? Number(cal.lens_k1) : 0,
    uncertainty_nm: Number.isFinite(Number(cal.uncertainty_nm)) ? Number(cal.uncertainty_nm) : 0,
    method: typeof cal.method === 'string' && cal.method ? cal.method : 'manual',
    captured_at: typeof cal.captured_at === 'string' && cal.captured_at ? cal.captured_at : now,
    notes: typeof cal.notes === 'string' ? cal.notes : '',
  };
  const idx = list.findIndex(c => c.id === normalized.id);
  if (idx >= 0) list[idx] = normalized;
  else list.push(normalized);
  _storeAll(list);
  return { ...normalized };
}

export function deleteCalibration(id) {
  if (!id) return false;
  const list = _ensureSeeded();
  const next = list.filter(c => c.id !== id);
  if (next.length === list.length) return false;
  // Never end up with zero calibrations — re-seed default if necessary.
  if (next.length === 0) {
    const def = _defaultCalibration();
    _storeAll([def]);
    _safeSet(STORAGE_ACTIVE_ID, def.id);
    return true;
  }
  _storeAll(next);
  // If the active one was deleted, switch to the first remaining.
  if (getActiveCalibrationId() === id) {
    _safeSet(STORAGE_ACTIVE_ID, next[0].id);
  }
  return true;
}

export function getActiveCalibrationId() {
  _ensureSeeded();
  const id = _safeGet(STORAGE_ACTIVE_ID);
  return typeof id === 'string' ? id : '';
}

export function setActiveCalibrationId(id) {
  if (typeof id !== 'string' || !id) return;
  const list = _ensureSeeded();
  if (!list.find(c => c.id === id)) return;
  _safeSet(STORAGE_ACTIVE_ID, id);
}

/**
 * Always returns a calibration. Auto-seeds + picks the first entry if the
 * active id is missing or dangling.
 */
export function getActiveCalibration() {
  const list = _ensureSeeded();
  const id = getActiveCalibrationId();
  const found = list.find(c => c.id === id);
  if (found) return { ...found };
  // Repair: active id is dangling → fall back to first.
  _safeSet(STORAGE_ACTIVE_ID, list[0].id);
  return { ...list[0] };
}

/**
 * Convert a Calibration to the wire shape the backend accepts. Strips
 * id/name (those are client-only bookkeeping) but keeps everything else
 * so the backend's `extra='allow'` snapshot can carry it through.
 */
export function calibrationPayload(cal) {
  if (!cal) return null;
  return {
    name: cal.name,
    wavelength_nm: cal.wavelength_nm,
    mm_per_pixel: cal.mm_per_pixel,
    lens_k1: cal.lens_k1,
    uncertainty_nm: cal.uncertainty_nm,
    method: cal.method,
    captured_at: cal.captured_at,
    notes: cal.notes,
  };
}

// ── Export / Import ────────────────────────────────────────────────────

const EXPORT_VERSION = 1;

export function exportCalibrationsJson() {
  return JSON.stringify({
    version: EXPORT_VERSION,
    exported_at: _nowIso(),
    activeId: getActiveCalibrationId(),
    calibrations: _ensureSeeded(),
  }, null, 2);
}

/**
 * Import calibrations from a JSON string. Duplicates (same id) overwrite.
 * Returns { added, errors }. Malformed JSON → { added: 0, errors: ["invalid JSON"] }.
 * Entries missing/invalid `wavelength_nm` are rejected with an error message.
 */
export function importCalibrationsJson(str) {
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(str);
  } catch (_) {
    return { added: 0, errors: ['invalid JSON'] };
  }

  // Accept either the full envelope {calibrations: [...]} or a bare array.
  let incoming;
  let incomingActive = null;
  if (Array.isArray(parsed)) {
    incoming = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.calibrations)) {
    incoming = parsed.calibrations;
    if (typeof parsed.activeId === 'string') incomingActive = parsed.activeId;
  } else {
    return { added: 0, errors: ['expected array or {calibrations: [...]}'] };
  }

  const list = _ensureSeeded();
  const byId = new Map(list.map(c => [c.id, c]));
  let added = 0;

  for (let i = 0; i < incoming.length; i++) {
    const raw = incoming[i];
    if (!raw || typeof raw !== 'object') {
      errors.push(`entry ${i}: not an object`);
      continue;
    }
    const wl = Number(raw.wavelength_nm);
    if (!Number.isFinite(wl) || wl <= 0) {
      errors.push(`entry ${i}${raw.name ? ` (${raw.name})` : ''}: wavelength_nm missing or <= 0`);
      continue;
    }
    const id = (typeof raw.id === 'string' && raw.id) ? raw.id : _newId();
    const normalized = {
      id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : 'Imported',
      wavelength_nm: wl,
      mm_per_pixel: Number.isFinite(Number(raw.mm_per_pixel)) ? Number(raw.mm_per_pixel) : 0,
      lens_k1: Number.isFinite(Number(raw.lens_k1)) ? Number(raw.lens_k1) : 0,
      uncertainty_nm: Number.isFinite(Number(raw.uncertainty_nm)) ? Number(raw.uncertainty_nm) : 0,
      method: typeof raw.method === 'string' && raw.method ? raw.method : 'imported',
      captured_at: typeof raw.captured_at === 'string' && raw.captured_at ? raw.captured_at : _nowIso(),
      notes: typeof raw.notes === 'string' ? raw.notes : '',
    };
    byId.set(id, normalized);
    added += 1;
  }

  const merged = Array.from(byId.values());
  _storeAll(merged);
  if (incomingActive && merged.find(c => c.id === incomingActive)) {
    _safeSet(STORAGE_ACTIVE_ID, incomingActive);
  }
  return { added, errors };
}

// ── Smoke tests (not auto-run; useful from a console or future E2E) ────

export function __smokeTests() {
  const results = [];
  const report = (name, ok, msg) => results.push({ name, ok, msg: msg || '' });

  // list + seed
  const initial = listCalibrations();
  report('seeded-one', initial.length >= 1);

  // create
  const created = saveCalibration({ name: 'HeNe 632.8', wavelength_nm: 632.8 });
  report('create', !!created.id && created.name === 'HeNe 632.8');

  // update
  const updated = saveCalibration({ ...created, notes: 'updated' });
  report('update', updated.notes === 'updated');

  // active
  setActiveCalibrationId(created.id);
  report('active', getActiveCalibration().id === created.id);

  // payload
  const payload = calibrationPayload(getActiveCalibration());
  report('payload-strips-id', payload && !('id' in payload) && payload.wavelength_nm === 632.8);

  // export/import round-trip
  const json = exportCalibrationsJson();
  const imp = importCalibrationsJson(json);
  report('reimport', imp.errors.length === 0 && imp.added >= 1);

  // bad JSON
  const bad = importCalibrationsJson('not json');
  report('bad-json', bad.added === 0 && bad.errors[0] === 'invalid JSON');

  // reject missing wavelength
  const missing = importCalibrationsJson(JSON.stringify([{ name: 'bad' }]));
  report('reject-missing-wl', missing.added === 0 && missing.errors.length === 1);

  // delete
  const delOk = deleteCalibration(created.id);
  report('delete', delOk);

  return results;
}
