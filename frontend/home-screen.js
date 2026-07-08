// home-screen.js — Preact home screen: new-project type cards, recents grid
// from IndexedDB (NEVER the server — hosted multi-user instances must not
// leak projects between users), per-project context menu, import zone.
// Rendered by shell.js into #home-screen-mount; tab-manager toggles the
// #home-screen container's [hidden].

import { html } from './shell.js';
import { listProjectSummaries, isPersistent } from './projects-db.js';

function dispatch(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

const TYPE_CARDS = [
  { type: "microscopy",    title: "Microscopy",
    blurb: "Measure, calibrate and inspect against DXF" },
  { type: "deflectometry", title: "Deflectometry",
    blurb: "Specular surface slope measurement" },
  { type: "fringe",        title: "Fringe analysis",
    blurb: "Interferometric flatness from fringe images" },
];

let _summaries = [];
let _loaded = false;
let _menuFor = null;                    // project id with the ⋯ menu open
const _thumbUrls = new Map();           // id → object URL

export async function refreshHomeData() {
  try { _summaries = await listProjectSummaries(); }
  catch (e) { console.warn("[home] listing failed:", e); _summaries = []; }
  _loaded = true;
  for (const url of _thumbUrls.values()) URL.revokeObjectURL(url);
  _thumbUrls.clear();
  for (const s of _summaries) {
    if (s.thumbnail) _thumbUrls.set(s.id, URL.createObjectURL(s.thumbnail));
  }
  _menuFor = null;
  dispatch("workspace-changed", {});    // re-render the shell (and this screen)
}

function fmtBytes(n) {
  if (!n) return "—";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
function fmtWhen(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso ?? ""; }
}

function ProjectCard({ p }) {
  const thumb = _thumbUrls.get(p.id);
  return html`
    <div class="home-card" onClick=${() => dispatch("open-project", { id: p.id })}>
      <div class="home-card-thumb">
        ${thumb
          ? html`<img src=${thumb} alt="" />`
          : html`<div class="home-card-thumb-empty">${p.type === "microscopy" ? "no image" : p.type}</div>`}
      </div>
      <div class="home-card-body">
        <div class="home-card-name" title=${p.name}>${p.name}</div>
        <div class="home-card-meta">${fmtWhen(p.updatedAt)} · ${fmtBytes(p.imageBytes)}</div>
      </div>
      <button class="home-card-menu-btn" title="Project actions"
        onClick=${e => {
          e.stopPropagation();
          _menuFor = _menuFor === p.id ? null : p.id;
          dispatch("workspace-changed", {});
        }}>⋯</button>
      ${_menuFor === p.id ? html`
        <div class="home-card-menu" onClick=${e => e.stopPropagation()}>
          <button onClick=${() => {
            _menuFor = null;
            const name = prompt("Rename project", p.name);
            if (name && name.trim()) dispatch("rename-project", { id: p.id, name: name.trim() });
            else dispatch("workspace-changed", {});
          }}>Rename</button>
          <button onClick=${() => {
            _menuFor = null;
            dispatch("export-project", { id: p.id });
            dispatch("workspace-changed", {});
          }}>Export .loupe</button>
          <button class="danger" onClick=${() => {
            _menuFor = null;
            dispatch("delete-project", { id: p.id });
            dispatch("workspace-changed", {});   // close the menu now — the confirm dialog
                                                  // (tab-manager.js) resolves independently,
                                                  // on any outcome (cancel/confirm/failure)
          }}>Delete…</button>
        </div>` : null}
    </div>`;
}

export function HomeScreen() {
  return html`
    <div class="home-wrap" onClick=${() => {
      if (_menuFor) { _menuFor = null; dispatch("workspace-changed", {}); }
    }}>
      ${!isPersistent() ? html`
        <div class="home-warning">
          Private browsing / storage unavailable — projects will NOT survive
          closing this browser tab. Export anything you care about as .loupe.
        </div>` : null}
      <div class="home-section-label">New project</div>
      <div class="home-type-cards">
        ${TYPE_CARDS.map(c => html`
          <button key=${c.type} class="home-type-card"
            onClick=${() => dispatch("new-project", { type: c.type })}>
            <div class="home-type-title">${c.title}</div>
            <div class="home-type-blurb">${c.blurb}</div>
          </button>`)}
      </div>
      <div class="home-section-label">Recent projects</div>
      ${!_loaded ? html`<div class="home-empty">Loading…</div>`
        : _summaries.length === 0
          ? html`<div class="home-empty">No projects yet — create one above or drop a file below.</div>`
          : html`<div class="home-grid">
              ${_summaries.map(p => html`<${ProjectCard} key=${p.id} p=${p} />`)}
            </div>`}
      <div class="home-section-label">Import</div>
      <div id="home-import-zone" class="home-import-zone">
        Drop a <b>.loupe</b> project, a session JSON, or an image here — or
        <label class="home-import-browse">browse
          <input type="file" id="home-import-input" hidden
            accept=".loupe,.json,application/json,image/*"
            onChange=${e => {
              if (e.target.files?.length) {
                dispatch("import-files", { files: [...e.target.files] });
                e.target.value = "";
              }
            }} />
        </label>
      </div>
    </div>`;
}
