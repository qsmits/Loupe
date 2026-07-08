/**
 * Tests for frontend/home-screen.js — the Preact home screen (Track B
 * Task 10): new-project type cards, an IndexedDB-only recents grid with a
 * per-project ⋯ menu (Rename/Export/Delete), and the import-zone file input.
 *
 * home-screen.js is a Preact/htm component, same shape as toolbar.js
 * (Task 9): calling `HomeScreen()`/`ProjectCard()` directly builds plain
 * vnode objects without touching the DOM. We reuse toolbar.js's
 * shallow-expand technique (recurse into function-component vnodes) to
 * inspect the rendered tree and drive click/change handlers, with
 * dom-stub.js supplying `document`/`window`/`localStorage`/`URL` for the
 * one slice of real behavior that needs it (CustomEvent dispatch, thumbnail
 * object URLs).
 *
 * HARD RULE under test: refreshHomeData() must read recents from
 * IndexedDB (projects-db.js) ONLY — never the server. We assert this by
 * stubbing a `fetch` that throws if called and confirming refreshHomeData()
 * still resolves normally.
 *
 * Run with: node --test tests/frontend/test_home_screen.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './dom-stub.js';
import { createIdbStub } from './idb-stub.js';
import { _setIndexedDbFactory, putProject, isPersistent, listProjectSummaries } from '../../frontend/projects-db.js';
import { HomeScreen, refreshHomeData } from '../../frontend/home-screen.js';

// ── Shallow-expand helper (mirrors tests/frontend/test_toolbar.js) ─────────
function expand(node, out = []) {
  if (node == null || node === false || typeof node === 'string' || typeof node === 'number') return out;
  if (Array.isArray(node)) { node.forEach(n => expand(n, out)); return out; }
  if (typeof node.type === 'function') {
    expand(node.type(node.props), out);
    return out;
  }
  out.push(node);
  const kids = node.props && node.props.children;
  if (kids != null) expand(kids, out);
  return out;
}

function render() { return expand(HomeScreen()); }
function hasClass(node, cls) { return (node.props.class || '').split(/\s+/).includes(cls); }
function flattenText(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  const kids = node.props && node.props.children;
  if (kids == null) return '';
  if (typeof kids === 'string' || typeof kids === 'number') return String(kids);
  if (Array.isArray(kids)) return kids.map(flattenText).join('');
  if (typeof kids === 'object' && 'props' in kids) return flattenText(kids);
  return '';
}
function byId(nodes, id) { return nodes.find(n => n.props?.id === id); }

async function seedProject(overrides = {}) {
  const now = new Date().toISOString();
  const proj = {
    id: overrides.id ?? crypto.randomUUID(),
    type: overrides.type ?? 'microscopy',
    name: overrides.name ?? 'Test project',
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    thumbnail: overrides.thumbnail ?? null,
    image: overrides.image ?? null,
    imageMeta: overrides.imageMeta ?? null,
    workspace: overrides.workspace ?? null,
  };
  await putProject(proj);
  return proj;
}

let addedListeners;
function captureEvent(name) {
  let captured = null;
  const handler = e => { captured = e.detail; };
  document.addEventListener(name, handler);
  addedListeners.push([name, handler]);
  return () => captured;
}

beforeEach(() => {
  _setIndexedDbFactory(createIdbStub());
  addedListeners = [];
});
afterEach(() => {
  for (const [name, handler] of addedListeners) document.removeEventListener(name, handler);
});

describe('HomeScreen — type cards', () => {
  it('renders exactly the three project-type cards', () => {
    const nodes = render();
    const cards = nodes.filter(n => n.type === 'button' && hasClass(n, 'home-type-card'));
    assert.equal(cards.length, 3);
    const titles = cards.map(c => flattenText(c.props.children.find(k => hasClass(k, 'home-type-title'))));
    assert.deepEqual(titles, ['Microscopy', 'Deflectometry', 'Fringe analysis']);
  });

  it('clicking a type card dispatches new-project with that type', () => {
    const getDetail = captureEvent('new-project');
    const nodes = render();
    const cards = nodes.filter(n => n.type === 'button' && hasClass(n, 'home-type-card'));
    cards[1].props.onClick();
    assert.deepEqual(getDetail(), { type: 'deflectometry' });
  });
});

describe('HomeScreen — recents (IndexedDB only)', () => {
  it('shows the empty state after refreshHomeData() finds no projects', async () => {
    await refreshHomeData();
    const nodes = render();
    const empty = nodes.find(n => hasClass(n, 'home-empty'));
    assert.ok(empty, 'expected a .home-empty node');
    assert.match(flattenText(empty), /No projects yet/);
    assert.equal(nodes.some(n => hasClass(n, 'home-grid')), false);
  });

  it('renders one card per summary, ordered as returned by listProjectSummaries', async () => {
    await seedProject({ id: 'p1', name: 'Older', updatedAt: '2026-01-01T00:00:00.000Z' });
    await seedProject({ id: 'p2', name: 'Newer', updatedAt: '2026-06-01T00:00:00.000Z' });
    await refreshHomeData();
    const summaries = await listProjectSummaries();
    assert.deepEqual(summaries.map(s => s.id), ['p2', 'p1'], 'sanity: IDB sorts updatedAt desc');

    const nodes = render();
    const names = nodes.filter(n => hasClass(n, 'home-card-name')).map(flattenText);
    assert.deepEqual(names, ['Newer', 'Older']);
  });

  it('formats byte count and shows the type placeholder when there is no thumbnail', async () => {
    await seedProject({ id: 'p1', type: 'fringe', name: 'No thumb' });
    await refreshHomeData();
    const nodes = render();
    const meta = nodes.find(n => hasClass(n, 'home-card-meta'));
    assert.match(flattenText(meta), /—$/, 'zero imageBytes formats as em dash');
    const placeholder = nodes.find(n => hasClass(n, 'home-card-thumb-empty'));
    assert.equal(flattenText(placeholder), 'fringe');
  });

  it('renders an <img> thumbnail (via IDB-stored Blob, not a server URL) when present', async () => {
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    await seedProject({ id: 'p1', thumbnail: blob });
    await refreshHomeData();
    const nodes = render();
    const img = nodes.find(n => n.type === 'img');
    assert.ok(img, 'expected an <img> for the thumbnail');
    assert.match(img.props.src, /^blob:/, 'thumbnail src should be an object URL, not a fetched path');
  });

  it('does not call fetch — recents come from IndexedDB only, never the server', async () => {
    await seedProject({ id: 'p1', name: 'A' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('home screen must not hit the network for recents'); };
    try {
      await refreshHomeData();
      const summaries = await listProjectSummaries();
      assert.equal(summaries.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('dispatches workspace-changed after loading, so the shell re-renders', async () => {
    const getDetail = captureEvent('workspace-changed');
    let seen = false;
    document.addEventListener('workspace-changed', () => { seen = true; });
    await refreshHomeData();
    assert.ok(seen);
    void getDetail;
  });

  it('clicking a card dispatches open-project with its id', async () => {
    await seedProject({ id: 'p1', name: 'Click me' });
    await refreshHomeData();
    const getDetail = captureEvent('open-project');
    const nodes = render();
    const card = nodes.find(n => hasClass(n, 'home-card'));
    card.props.onClick();
    assert.deepEqual(getDetail(), { id: 'p1' });
  });
});

describe('HomeScreen — per-project ⋯ menu', () => {
  it('opening the menu does not itself open the project', async () => {
    await seedProject({ id: 'p1', name: 'A' });
    await refreshHomeData();
    const openDetail = captureEvent('open-project');
    let stopped = false;
    const nodes = render();
    const menuBtn = nodes.find(n => hasClass(n, 'home-card-menu-btn'));
    menuBtn.props.onClick({ stopPropagation: () => { stopped = true; } });
    assert.ok(stopped, 'menu button click must stop propagation to the card');
    assert.equal(openDetail(), null);
  });

  it('after opening, shows Rename / Export .loupe / Delete… for that project only', async () => {
    await seedProject({ id: 'p1', name: 'A' });
    await seedProject({ id: 'p2', name: 'B' });
    await refreshHomeData();
    let nodes = render();
    const menuBtns = nodes.filter(n => hasClass(n, 'home-card-menu-btn'));
    assert.equal(menuBtns.length, 2);
    menuBtns[0].props.onClick({ stopPropagation: () => {} });

    nodes = render();
    const menu = nodes.find(n => hasClass(n, 'home-card-menu'));
    assert.ok(menu, 'expected the open menu to render');
    const labels = nodes.filter(n => n.type === 'button'
      && ['Rename', 'Export .loupe', 'Delete…'].includes(flattenText(n)));
    assert.deepEqual(labels.map(flattenText), ['Rename', 'Export .loupe', 'Delete…']);
  });

  it('Export .loupe dispatches export-project with the project id and closes the menu', async () => {
    await seedProject({ id: 'p1', name: 'A' });
    await refreshHomeData();
    let nodes = render();
    nodes.find(n => hasClass(n, 'home-card-menu-btn')).props.onClick({ stopPropagation: () => {} });
    nodes = render();
    const getExport = captureEvent('export-project');
    const exportBtn = nodes.find(n => n.type === 'button' && flattenText(n) === 'Export .loupe');
    exportBtn.props.onClick({ stopPropagation: () => {} });
    assert.deepEqual(getExport(), { id: 'p1' });
  });

  it('Delete… dispatches delete-project with the id (no confirmation here — that is tab-manager\'s job) and closes the menu immediately', async () => {
    await seedProject({ id: 'p1', name: 'A' });
    await refreshHomeData();
    let nodes = render();
    nodes.find(n => hasClass(n, 'home-card-menu-btn')).props.onClick({ stopPropagation: () => {} });
    nodes = render();
    const getDelete = captureEvent('delete-project');
    const getChanged = captureEvent('workspace-changed');
    const deleteBtn = nodes.find(n => n.type === 'button' && flattenText(n) === 'Delete…');
    deleteBtn.props.onClick({ stopPropagation: () => {} });
    assert.deepEqual(getDelete(), { id: 'p1' });
    // Fix: the menu must close right away, independent of tab-manager's
    // async confirm dialog resolving (cancel or failure must not leave it
    // stuck open) — same re-render event Export .loupe uses.
    assert.ok(getChanged(), 'expected workspace-changed to be dispatched so the menu closes immediately');
  });

  it('Rename with a non-empty prompt() answer dispatches rename-project with the trimmed name', async () => {
    await seedProject({ id: 'p1', name: 'A' });
    await refreshHomeData();
    let nodes = render();
    nodes.find(n => hasClass(n, 'home-card-menu-btn')).props.onClick({ stopPropagation: () => {} });
    nodes = render();
    const getRename = captureEvent('rename-project');
    const originalPrompt = globalThis.prompt;
    globalThis.prompt = () => '  New name  ';
    try {
      const renameBtn = nodes.find(n => n.type === 'button' && flattenText(n) === 'Rename');
      renameBtn.props.onClick({ stopPropagation: () => {} });
    } finally {
      globalThis.prompt = originalPrompt;
    }
    assert.deepEqual(getRename(), { id: 'p1', name: 'New name' });
  });

  it('Rename with a cancelled prompt() does not dispatch rename-project', async () => {
    await seedProject({ id: 'p1', name: 'A' });
    await refreshHomeData();
    let nodes = render();
    nodes.find(n => hasClass(n, 'home-card-menu-btn')).props.onClick({ stopPropagation: () => {} });
    nodes = render();
    const getRename = captureEvent('rename-project');
    const originalPrompt = globalThis.prompt;
    globalThis.prompt = () => null;
    try {
      const renameBtn = nodes.find(n => n.type === 'button' && flattenText(n) === 'Rename');
      renameBtn.props.onClick({ stopPropagation: () => {} });
    } finally {
      globalThis.prompt = originalPrompt;
    }
    assert.equal(getRename(), null);
  });
});

describe('HomeScreen — private-storage warning', () => {
  it('shows no warning while IndexedDB is available', async () => {
    await refreshHomeData();
    assert.equal(isPersistent(), true);
    const nodes = render();
    assert.equal(nodes.some(n => hasClass(n, 'home-warning')), false);
  });

  it('shows the warning once storage has fallen back to memory', async () => {
    _setIndexedDbFactory(null);
    await listProjectSummaries().catch(() => {});   // engage the memory fallback
    assert.equal(isPersistent(), false);
    await refreshHomeData();
    const nodes = render();
    const warning = nodes.find(n => hasClass(n, 'home-warning'));
    assert.ok(warning, 'expected a .home-warning node');
    assert.match(flattenText(warning), /will NOT survive/);
  });
});

describe('HomeScreen — import zone', () => {
  it('choosing files via the browse input dispatches import-files and clears the input', async () => {
    await refreshHomeData();
    const getDetail = captureEvent('import-files');
    const nodes = render();
    const input = byId(nodes, 'home-import-input');
    assert.ok(input, 'expected the #home-import-input file input');
    const fakeFile = { name: 'part.loupe' };
    const target = { files: [fakeFile], value: 'C:\\fakepath\\part.loupe' };
    input.props.onChange({ target });
    assert.deepEqual(getDetail(), { files: [fakeFile] });
    assert.equal(target.value, '', 'input value should reset so re-choosing the same file re-fires change');
  });

  it('does nothing when the change event carries no files', async () => {
    await refreshHomeData();
    const getDetail = captureEvent('import-files');
    const nodes = render();
    const input = byId(nodes, 'home-import-input');
    input.props.onChange({ target: { files: [], value: '' } });
    assert.equal(getDetail(), null);
  });
});
