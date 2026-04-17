// fringe-geometry.js — Client-side aperture/geometry recipes for fringe mode.
//
// Recipes live in localStorage.  When a recipe is active, every
// /fringe/analyze* request sends it as `aperture_recipe` (for provenance)
// and as `mask_polygons` (for the actual mask used by the backend).
//
// Shape:
//   {
//     id: string,
//     name: string,
//     kind: "polygon" | "circle" | "ring",
//     created_at: string,            // ISO 8601
//     notes: string,
//
//     // For kind="polygon":
//     polygons?: [{ vertices: [[x, y], ...], include: boolean }, ...],
//
//     // For kind="circle":
//     circle?: { cx: number, cy: number, r: number },
//
//     // For kind="ring":
//     ring?: { cx: number, cy: number, r_inner: number, r_outer: number },
//
//     // Bookkeeping:
//     source_resolution?: { width: number, height: number },
//   }
//
// All coordinates stored in normalized [0, 1] image-space so recipes are
// portable across camera/image resolutions.  The wire format to the
// backend is also normalized — mask_utils.rasterize_polygon_mask already
// expects normalized vertices.
//
// Storage keys:
//   loupe.fringe.geometry_recipes        — JSON array of Recipe
//   loupe.fringe.activeGeometryRecipeId  — string (empty = no recipe / auto)

const STORAGE_RECIPES = 'loupe.fringe.geometry_recipes';
const STORAGE_ACTIVE_ID = 'loupe.fringe.activeGeometryRecipeId';

const KNOWN_KINDS = new Set(['polygon', 'circle', 'ring']);

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
  const raw = _safeGet(STORAGE_RECIPES);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (r) => r && typeof r === 'object'
          && typeof r.id === 'string' && r.id
          && typeof r.name === 'string'
          && KNOWN_KINDS.has(r.kind),
    );
  } catch (_) {
    return [];
  }
}

function _storeAll(list) {
  try {
    _safeSet(STORAGE_RECIPES, JSON.stringify(list));
  } catch (_) { /* already wrapped, ignore */ }
}

function _normalizePolygons(polygons) {
  if (!Array.isArray(polygons)) return [];
  const out = [];
  for (const p of polygons) {
    if (!p || !Array.isArray(p.vertices)) continue;
    const verts = [];
    for (const v of p.vertices) {
      // Accept both [x, y] and {x, y}.
      if (Array.isArray(v) && v.length >= 2
          && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))) {
        verts.push([Number(v[0]), Number(v[1])]);
      } else if (v && typeof v === 'object'
                 && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y))) {
        verts.push([Number(v.x), Number(v.y)]);
      }
    }
    if (verts.length >= 3) {
      out.push({ vertices: verts, include: p.include !== false });
    }
  }
  return out;
}

function _normalizeCircle(c) {
  if (!c || typeof c !== 'object') return null;
  const cx = Number(c.cx), cy = Number(c.cy), r = Number(c.r);
  if (![cx, cy, r].every(Number.isFinite) || r <= 0) return null;
  return { cx, cy, r };
}

function _normalizeRing(r) {
  if (!r || typeof r !== 'object') return null;
  const cx = Number(r.cx), cy = Number(r.cy);
  const ri = Number(r.r_inner), ro = Number(r.r_outer);
  if (![cx, cy, ri, ro].every(Number.isFinite)) return null;
  if (ri < 0 || ro <= 0 || ri >= ro) return null;
  return { cx, cy, r_inner: ri, r_outer: ro };
}

function _normalizeRecipe(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('recipe: not an object');
  const kind = raw.kind;
  if (!KNOWN_KINDS.has(kind)) throw new Error(`recipe: unknown kind "${kind}"`);

  const base = {
    id: (typeof raw.id === 'string' && raw.id) ? raw.id : _newId(),
    name: (typeof raw.name === 'string' && raw.name) ? raw.name : 'Untitled',
    kind,
    created_at: (typeof raw.created_at === 'string' && raw.created_at) ? raw.created_at : _nowIso(),
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };

  if (raw.source_resolution && typeof raw.source_resolution === 'object') {
    const w = Number(raw.source_resolution.width);
    const h = Number(raw.source_resolution.height);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      base.source_resolution = { width: w, height: h };
    }
  }

  if (kind === 'polygon') {
    const polys = _normalizePolygons(raw.polygons);
    if (polys.length === 0) throw new Error('recipe: polygon recipe needs at least one polygon');
    base.polygons = polys;
  } else if (kind === 'circle') {
    const c = _normalizeCircle(raw.circle);
    if (!c) throw new Error('recipe: circle recipe needs {cx, cy, r}');
    base.circle = c;
  } else if (kind === 'ring') {
    const r = _normalizeRing(raw.ring);
    if (!r) throw new Error('recipe: ring recipe needs {cx, cy, r_inner, r_outer} with r_inner < r_outer');
    base.ring = r;
  }

  return base;
}

// ── Public API ─────────────────────────────────────────────────────────

export function listRecipes() {
  return _loadAll();
}

export function getRecipe(id) {
  if (!id) return null;
  return _loadAll().find((r) => r.id === id) ?? null;
}

/**
 * Save (create or update) a recipe. Returns the stored copy.
 * Throws Error on invalid input.
 */
export function saveRecipe(recipe) {
  const normalized = _normalizeRecipe(recipe);
  const list = _loadAll();
  const idx = list.findIndex((r) => r.id === normalized.id);
  if (idx >= 0) list[idx] = normalized;
  else list.push(normalized);
  _storeAll(list);
  return { ...normalized };
}

export function deleteRecipe(id) {
  if (!id) return false;
  const list = _loadAll();
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) return false;
  _storeAll(next);
  if (getActiveRecipeId() === id) {
    _safeSet(STORAGE_ACTIVE_ID, '');
  }
  return true;
}

export function getActiveRecipeId() {
  const id = _safeGet(STORAGE_ACTIVE_ID);
  return typeof id === 'string' ? id : '';
}

/**
 * Set the active recipe id. Pass null or "" to clear (no recipe = auto-mask).
 */
export function setActiveRecipeId(id) {
  if (id == null || id === '') {
    _safeSet(STORAGE_ACTIVE_ID, '');
    return;
  }
  if (typeof id !== 'string') return;
  const list = _loadAll();
  if (!list.find((r) => r.id === id)) return;
  _safeSet(STORAGE_ACTIVE_ID, id);
}

/**
 * May return null — "no recipe" is a valid state meaning "use auto-mask".
 */
export function getActiveRecipe() {
  const id = getActiveRecipeId();
  if (!id) return null;
  const found = _loadAll().find((r) => r.id === id);
  return found ? { ...found } : null;
}

/**
 * Convert a Recipe to the wire shape the backend accepts as
 * `aperture_recipe` (for provenance).  Strips nothing — the backend uses
 * extra='allow' on ApertureRecipe so any extras round-trip through
 * `result.aperture_recipe`.
 */
export function recipePayload(recipe) {
  if (!recipe) return null;
  const out = {
    id: recipe.id,
    kind: recipe.kind,
    name: recipe.name,
    created_at: recipe.created_at,
    notes: recipe.notes || '',
  };
  if (recipe.polygons) out.polygons = recipe.polygons;
  if (recipe.circle) out.circle = recipe.circle;
  if (recipe.ring) out.ring = recipe.ring;
  if (recipe.source_resolution) out.source_resolution = recipe.source_resolution;
  return out;
}

/**
 * Resolve a recipe to the `mask_polygons` payload the backend rasterizer
 * expects — a list of `{vertices: [[x, y], ...], include: bool}` where
 * coords are normalized [0, 1].
 *
 * Circle → 32-segment polygon approximation.
 * Ring   → outer circle (include) + inner circle (exclude) (donut).
 * Polygon → passed through.
 *
 * Returns [] for a null recipe (caller should then send `undefined`).
 */
export function recipeToMaskPolygons(recipe) {
  if (!recipe) return [];
  if (recipe.kind === 'polygon') {
    return (recipe.polygons || []).map((p) => ({
      vertices: p.vertices.map((v) => [v[0], v[1]]),
      include: p.include !== false,
    }));
  }
  if (recipe.kind === 'circle') {
    const c = recipe.circle;
    if (!c) return [];
    return [{ vertices: _circleVertices(c.cx, c.cy, c.r, 32), include: true }];
  }
  if (recipe.kind === 'ring') {
    const r = recipe.ring;
    if (!r) return [];
    return [
      { vertices: _circleVertices(r.cx, r.cy, r.r_outer, 32), include: true },
      { vertices: _circleVertices(r.cx, r.cy, r.r_inner, 32), include: false },
    ];
  }
  return [];
}

function _circleVertices(cx, cy, r, segments) {
  const verts = [];
  for (let i = 0; i < segments; i++) {
    const theta = (2 * Math.PI * i) / segments;
    const x = cx + r * Math.cos(theta);
    const y = cy + r * Math.sin(theta);
    verts.push([x, y]);
  }
  return verts;
}

// ── Export / Import ────────────────────────────────────────────────────

const EXPORT_VERSION = 1;

export function exportRecipesJson() {
  return JSON.stringify({
    version: EXPORT_VERSION,
    exported_at: _nowIso(),
    activeId: getActiveRecipeId(),
    recipes: _loadAll(),
  }, null, 2);
}

/**
 * Import recipes from a JSON string.  Duplicates (same id) overwrite.
 * Returns { added, errors }.  Malformed JSON → { added: 0, errors: ["invalid JSON"] }.
 */
export function importRecipesJson(str) {
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(str);
  } catch (_) {
    return { added: 0, errors: ['invalid JSON'] };
  }

  let incoming;
  let incomingActive = null;
  if (Array.isArray(parsed)) {
    incoming = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.recipes)) {
    incoming = parsed.recipes;
    if (typeof parsed.activeId === 'string') incomingActive = parsed.activeId;
  } else {
    return { added: 0, errors: ['expected array or {recipes: [...]}'] };
  }

  const list = _loadAll();
  const byId = new Map(list.map((r) => [r.id, r]));
  let added = 0;

  for (let i = 0; i < incoming.length; i++) {
    const raw = incoming[i];
    if (!raw || typeof raw !== 'object') {
      errors.push(`entry ${i}: not an object`);
      continue;
    }
    if (!raw.id || typeof raw.id !== 'string') {
      errors.push(`entry ${i}${raw.name ? ` (${raw.name})` : ''}: missing id`);
      continue;
    }
    if (!raw.name || typeof raw.name !== 'string') {
      errors.push(`entry ${i}: missing name`);
      continue;
    }
    if (!KNOWN_KINDS.has(raw.kind)) {
      errors.push(`entry ${i} (${raw.name}): unknown or missing kind`);
      continue;
    }
    try {
      const normalized = _normalizeRecipe(raw);
      byId.set(normalized.id, normalized);
      added += 1;
    } catch (e) {
      errors.push(`entry ${i} (${raw.name || '?'}): ${e.message || String(e)}`);
    }
  }

  const merged = Array.from(byId.values());
  _storeAll(merged);
  if (incomingActive && merged.find((r) => r.id === incomingActive)) {
    _safeSet(STORAGE_ACTIVE_ID, incomingActive);
  }
  return { added, errors };
}

// ── Smoke tests (not auto-run; useful from a console) ──────────────────

export function __smokeTests() {
  const results = [];
  const report = (name, ok, msg) => results.push({ name, ok, msg: msg || '' });

  // start from a clean slate (but don't destroy user's real data in prod)
  const saved = saveRecipe({
    kind: 'circle', name: 'Full aperture',
    circle: { cx: 0.5, cy: 0.5, r: 0.45 },
    source_resolution: { width: 1024, height: 1024 },
  });
  report('create-circle', !!saved.id && saved.kind === 'circle');

  const ring = saveRecipe({
    kind: 'ring', name: 'Annular',
    ring: { cx: 0.5, cy: 0.5, r_inner: 0.2, r_outer: 0.45 },
  });
  report('create-ring', !!ring.id);

  setActiveRecipeId(saved.id);
  report('active', getActiveRecipe().id === saved.id);

  const masks = recipeToMaskPolygons(getActiveRecipe());
  report('circle-to-polys', masks.length === 1 && masks[0].vertices.length === 32);

  const ringMasks = recipeToMaskPolygons(ring);
  report('ring-to-polys',
    ringMasks.length === 2
    && ringMasks[0].include === true
    && ringMasks[1].include === false);

  // export/import round-trip
  const json = exportRecipesJson();
  const imp = importRecipesJson(json);
  report('reimport', imp.errors.length === 0 && imp.added >= 1);

  // reject missing kind
  const bad = importRecipesJson(JSON.stringify([{ id: 'x', name: 'y' }]));
  report('reject-missing-kind', bad.added === 0 && bad.errors.length === 1);

  // bad JSON
  const badj = importRecipesJson('not json');
  report('bad-json', badj.added === 0 && badj.errors[0] === 'invalid JSON');

  // clear active
  setActiveRecipeId(null);
  report('clear-active', getActiveRecipe() === null);

  // cleanup
  deleteRecipe(saved.id);
  deleteRecipe(ring.id);

  return results;
}
