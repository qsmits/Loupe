// tab-manager.js — typed project tabs over the singleton engine.
//
// A tab = { id, type, name, record|null }. `id` is the project UUID (also
// the X-Session-ID for transient server frames). Microscopy tabs own an
// in-memory workspace record (workspace.js); their record is loaded lazily
// from IndexedDB on first activation. Deflectometry/fringe tabs wrap
// today's singleton mode containers (Task "Singleton tabs") — their module
// code is untouched; visibility toggling drives their own MutationObservers.
//
// PERSISTENCE: IndexedDB only (projects-db.js). Tab close never deletes a
// project. Autosave: 2 s dirty-poll + flush on tab switch + beforeunload.
//
// CROSS-MODE: fringe/deflectometry mask editing borrows the microscope
// container *below* the tab layer (cross-mode.js stashes/restores its own
// state and calls switchMode directly). All tab operations refuse while
// isCrossModeActive().

import { state } from './state.js';
import { imageWidth, imageHeight } from './viewport.js';
import {
  serializeWorkspace, restoreWorkspace, freshWorkspaceRecord,
} from './workspace.js';
import { buildWorkspaceV4, applyWorkspaceV4 } from './project-format.js';
import { putProject, getProject, listProjectSummaries, deleteProjectRecord } from './projects-db.js';
import { setSessionIdProvider } from './api.js';
import { switchMode } from './modes.js';
import { isCrossModeActive } from './cross-mode.js';
import { isBrowserCameraActive, stopBrowserCamera } from './browser-camera.js';
import { showNotice, showToast } from './shell.js';

const OPEN_TABS_KEY = "loupe-open-tabs";
const MODE_FOR_TYPE = { microscopy: "microscope", deflectometry: "deflectometry", fringe: "fringe" };
const TYPE_LABEL = { microscopy: "Microscopy", deflectometry: "Deflectometry", fringe: "Fringe" };

const tabs = [];              // [{ id, type, name, record|null }]
let activeTabId = null;
let homeVisible = false;
const modeHooks = {};         // { [type]: { serialize?, restore? } }

// ── Store views (shell renders from these) ──────────────────────────────────
export function getTabs() {
  return tabs.map(t => ({
    id: t.id, type: t.type, name: t.name,
    dirty: t.id === activeTabId
      ? state._dirty
      : (t.record?.state?._dirty ?? false),
  }));
}
export function getActiveTabId() { return activeTabId; }
export function getActiveTab() { return tabs.find(t => t.id === activeTabId) ?? null; }
export function isHomeVisible() { return homeVisible; }

/** Optional per-type persistence seam (spec: deflectometry/fringe may
 *  persist little in v1 — today they persist nothing, no regression). */
export function registerModeHooks(type, hooks) { modeHooks[type] = hooks; }

function emitChanged() {
  document.dispatchEvent(new CustomEvent("workspace-changed"));
}

function persistOpenSet() {
  try {
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify({
      open: tabs.map(t => t.id),
      active: activeTabId,
    }));
  } catch { /* private mode — tabs just won't restore */ }
}

// ── Camera stream handoff ────────────────────────────────────────────────────
function streamImgEl() { return document.getElementById("stream-img"); }

function stopStreamForDeactivate() {
  const img = streamImgEl();
  if (img) { img.src = ""; img.style.opacity = "0"; }
  // v1 simplification: the browser camera stops on tab switch and does not
  // auto-resume (like a mode switch today). The MJPEG camera resumes.
  if (isBrowserCameraActive()) {
    try { stopBrowserCamera(); } catch { /* device already gone */ }
  }
}

function startStreamIfLive() {
  const img = streamImgEl();
  if (!img) return;
  if (!state.frozen && !state._hosted) {
    img.src = "/stream?" + Date.now();
    img.style.opacity = "1";
  } else {
    img.src = "";                 // frozen tab: no stream, canvas draws the frame
    img.style.opacity = "0";
  }
}

// ── Autosave (spec: ~2 s after dirty, flush on switch + beforeunload) ───────
let _saveWarned = false;
let _saving = false;

async function makeThumbnail(imgEl) {
  if (!imgEl || !imgEl.naturalWidth) return null;
  const MAX = 160;
  const scale = Math.min(MAX / imgEl.naturalWidth, MAX / imgEl.naturalHeight, 1);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(imgEl.naturalWidth * scale));
  c.height = Math.max(1, Math.round(imgEl.naturalHeight * scale));
  c.getContext("2d").drawImage(imgEl, 0, 0, c.width, c.height);
  return await new Promise(res => c.toBlob(res, "image/jpeg", 0.6));
}

/** Persist the ACTIVE microscopy tab to IndexedDB if dirty. Never throws. */
export async function flushAutosave() {
  const tab = getActiveTab();
  if (!tab || tab.type !== "microscopy") return;
  if (!state._dirty || _saving) return;
  if (isCrossModeActive()) return;
  _saving = true;
  try {
    const record = serializeWorkspace();
    tab.record = record;
    const existing = await getProject(tab.id);
    const proj = existing ?? {
      id: tab.id, type: tab.type, name: tab.name,
      createdAt: new Date().toISOString(), updatedAt: null,
      thumbnail: null, image: null, imageMeta: null, workspace: null,
    };
    proj.name = tab.name;
    proj.updatedAt = new Date().toISOString();
    proj.workspace = buildWorkspaceV4(record);
    proj.image = record.state.frozenBlob ?? null;
    proj.imageMeta = (proj.image && record.imageWidth > 0)
      ? {
          w: record.imageWidth, h: record.imageHeight,
          source: record.state.frozenSource ?? "camera",
          ...(record.state.frozenFilename ? { filename: record.state.frozenFilename } : {}),
        }
      : null;
    proj.thumbnail = await makeThumbnail(record.state.frozenBackground) ?? proj.thumbnail;
    await putProject(proj);
    state._dirty = false;
    _saveWarned = false;
    emitChanged();                       // clears the dirty dot
  } catch (e) {
    console.warn("[autosave] failed:", e);
    if (!_saveWarned) {
      _saveWarned = true;
      showToast("Couldn't save project — storage may be full", {
        actionLabel: "Manage projects",
        onAction: () => showHomeScreen(),
      });
    }
  } finally {
    _saving = false;
  }
}

// ── Record loading (lazy, on first activation) ──────────────────────────────
async function ensureRecordLoaded(tab) {
  if (tab.record) return;
  let proj = null;
  try { proj = await getProject(tab.id); } catch (e) { console.warn("[tabs] load failed:", e); }
  if (!proj) { tab.record = freshWorkspaceRecord(); return; }
  let record;
  try {
    record = proj.workspace ? applyWorkspaceV4(proj.workspace) : freshWorkspaceRecord();
  } catch (e) {
    console.warn("[tabs] corrupt workspace, opening empty:", e);
    showToast(`"${proj.name}": stored workspace could not be read (${e.message})`);
    record = freshWorkspaceRecord();
  }
  if (proj.image) {
    record.state.frozenBlob = proj.image;
    record.state.frozenSource = proj.imageMeta?.source ?? "file";
    record.state.frozenFilename = proj.imageMeta?.filename ?? null;
    record.state.frozen = true;
    const url = URL.createObjectURL(proj.image);
    const el = await new Promise(resolve => {
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      im.src = url;
    });
    if (el) {
      record.state.frozenBackground = el;
      record.imageWidth = proj.imageMeta?.w || el.naturalWidth;
      record.imageHeight = proj.imageMeta?.h || el.naturalHeight;
      record.state.frozenSize = { w: record.imageWidth, h: record.imageHeight };
    } else {
      showToast(`"${proj.name}": stored image could not be decoded`);
      record.state.frozen = false;
      record.state.frozenBlob = null;
    }
  }
  tab.record = record;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
async function deactivateCurrent() {
  const tab = getActiveTab();
  if (!tab) return;
  if (tab.type === "microscopy") {
    await flushAutosave();               // must run while the tab is still live
    tab.record = serializeWorkspace();
    stopStreamForDeactivate();
  } else {
    // Persist optional per-type state, then hide the container — the mode's
    // own MutationObserver on [hidden] stops polling/capture.
    const opaque = modeHooks[tab.type]?.serialize?.();
    if (opaque !== undefined) {
      getProject(tab.id).then(proj => {
        if (!proj) return;
        proj.workspace = { version: 4, opaque };
        proj.updatedAt = new Date().toISOString();
        return putProject(proj);
      }).catch(e => console.warn("[tabs] singleton persist failed:", e));
    }
    const el = document.getElementById("mode-" + MODE_FOR_TYPE[tab.type]);
    if (el) el.hidden = true;
  }
  activeTabId = null;
}

export async function activateTab(id) {
  if (isCrossModeActive()) {
    showToast("Finish the mask / calibration editing session first");
    return;
  }
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  if (id === activeTabId && !homeVisible) return;
  await deactivateCurrent();
  homeVisible = false;
  const home = document.getElementById("home-screen");
  if (home) home.hidden = true;
  if (tab.type === "microscopy") {
    await ensureRecordLoaded(tab);
    switchMode("microscope");            // containers + .microscope-only menus
    restoreWorkspace(tab.record);        // bumps epoch; DOM hook re-fits
    startStreamIfLive();
  } else {
    switchMode(MODE_FOR_TYPE[tab.type]); // un-hides the container → observer starts
    let proj = null;
    try { proj = await getProject(tab.id); } catch { /* metadata only */ }
    modeHooks[tab.type]?.restore?.(proj?.workspace?.opaque ?? null);
  }
  activeTabId = tab.id;
  persistOpenSet();
  document.title = `${tab.name} — Loupe`;
  emitChanged();
}

export async function newProject(type, { name } = {}) {
  if (!MODE_FOR_TYPE[type]) throw new Error("unknown project type: " + type);
  if (isCrossModeActive()) {
    showToast("Finish the mask / calibration editing session first");
    return null;
  }
  if (type !== "microscopy") {
    const existing = tabs.find(t => t.type === type);
    if (existing) {
      const choice = await showNotice({
        title: "One tab per instrument",
        message: `Only one ${TYPE_LABEL[type]} tab can be open at a time.\nClose "${existing.name}" and open a new one?`,
        buttons: [
          { id: "cancel", label: "Cancel" },
          { id: "swap", label: "Close & open", primary: true },
        ],
      });
      if (choice !== "swap") return null;
      await closeTab(existing.id);
    }
  }
  const now = new Date().toISOString();
  const project = {
    id: crypto.randomUUID(),
    type,
    name: name ?? `${TYPE_LABEL[type]} ${now.slice(0, 16).replace("T", " ")}`,
    createdAt: now, updatedAt: now,
    thumbnail: null, image: null, imageMeta: null, workspace: null,
  };
  try { await putProject(project); }
  catch (e) { console.warn("[projects] initial save failed:", e); }
  const record = freshWorkspaceRecord();
  record.imageWidth = imageWidth;        // seed current camera dims (global HW info)
  record.imageHeight = imageHeight;
  const tab = {
    id: project.id, type, name: project.name,
    record: type === "microscopy" ? record : null,
  };
  tabs.push(tab);
  await activateTab(tab.id);
  return tab;
}

export async function openProject(id) {
  if (tabs.some(t => t.id === id)) return activateTab(id);
  let proj = null;
  try { proj = await getProject(id); } catch { /* fall through */ }
  if (!proj) { showToast("Project not found"); return; }
  if (proj.type !== "microscopy") {
    const existing = tabs.find(t => t.type === proj.type);
    if (existing) {
      const choice = await showNotice({
        title: "One tab per instrument",
        message: `Only one ${TYPE_LABEL[proj.type]} tab can be open at a time.\nClose "${existing.name}" and open "${proj.name}"?`,
        buttons: [
          { id: "cancel", label: "Cancel" },
          { id: "swap", label: "Close & open", primary: true },
        ],
      });
      if (choice !== "swap") return;
      await closeTab(existing.id);
    }
  }
  tabs.push({ id: proj.id, type: proj.type, name: proj.name, record: null });
  await activateTab(proj.id);
}

/** Close a tab. NEVER destructive — autosave keeps the project current in
 *  IndexedDB; this only removes it from the open set. */
export async function closeTab(id) {
  if (isCrossModeActive()) {
    showToast("Finish the mask / calibration editing session first");
    return;
  }
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const wasActive = tabs[idx].id === activeTabId;
  if (wasActive) await deactivateCurrent();   // flush + stop stream / hide container
  tabs.splice(idx, 1);
  persistOpenSet();
  if (wasActive) {
    const next = tabs[idx] ?? tabs[idx - 1];
    if (next) await activateTab(next.id);
    else await showHomeScreen();
  }
  emitChanged();
}

export async function renameProject(id, name) {
  const tab = tabs.find(t => t.id === id);
  if (tab) tab.name = name;
  try {
    const proj = await getProject(id);
    if (proj) {
      proj.name = name;
      proj.updatedAt = new Date().toISOString();
      await putProject(proj);
    }
  } catch (e) { console.warn("[projects] rename failed:", e); }
  if (id === activeTabId) document.title = `${name} — Loupe`;
  emitChanged();
}

export async function deleteProjectEverywhere(id) {
  if (isCrossModeActive()) {
    // closeTab() no-ops under cross-mode; proceeding would delete the IDB
    // record while a tab stays open pointing at it. Unreachable via the
    // shipped UI today (home refuses to show under cross-mode) — defensive.
    showToast("Finish the mask / calibration editing session first");
    return;
  }
  let name = id;
  try { name = (await getProject(id))?.name ?? id; } catch { /* keep id */ }
  const choice = await showNotice({
    title: "Delete project?",
    message: `"${name}" will be permanently deleted from this browser.\nThis cannot be undone. (Export it as .loupe first if unsure.)`,
    buttons: [
      { id: "cancel", label: "Cancel", primary: true },
      { id: "delete", label: "Delete" },
    ],
  });
  if (choice !== "delete") return;
  const open = tabs.find(t => t.id === id);
  if (open) await closeTab(id);
  try { await deleteProjectRecord(id); }
  catch (e) { console.warn("[projects] delete failed:", e); showToast("Delete failed"); return; }
  document.dispatchEvent(new CustomEvent("home-shown"));   // refresh recents
}

export async function showHomeScreen() {
  if (isCrossModeActive()) return;
  await deactivateCurrent();
  for (const m of Object.values(MODE_FOR_TYPE)) {
    const el = document.getElementById("mode-" + m);
    if (el) el.hidden = true;
  }
  document.querySelectorAll(".microscope-only").forEach(el => { el.hidden = true; });
  document.querySelectorAll(".fringe-only").forEach(el => { el.hidden = true; });
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.hidden = true;
  homeVisible = true;
  const home = document.getElementById("home-screen");   // exists from Task "Home screen"
  if (home) home.hidden = false;
  persistOpenSet();
  document.title = "Loupe";
  emitChanged();
  document.dispatchEvent(new CustomEvent("home-shown"));
}

// ── Boot ─────────────────────────────────────────────────────────────────────
export async function initTabManager() {
  document.addEventListener("activate-tab", e => activateTab(e.detail.id));
  document.addEventListener("close-tab", e => closeTab(e.detail.id));
  document.addEventListener("open-project", e => openProject(e.detail.id));
  document.addEventListener("rename-project", e => renameProject(e.detail.id, e.detail.name));
  document.addEventListener("delete-project", e => deleteProjectEverywhere(e.detail.id));
  document.addEventListener("new-project", e => {
    if (e.detail?.type) newProject(e.detail.type);
    else showHomeScreen();
  });

  // Per-tab server sessions: X-Session-ID = active project UUID.
  setSessionIdProvider(() => getActiveTab()?.id ?? null);

  // Autosave: 2 s dirty-poll (writes at most every 2 s after a change —
  // simpler than event-driven debounce and equivalent in effect).
  setInterval(() => { flushAutosave(); }, 2000);
  window.addEventListener("beforeunload", () => { flushAutosave(); });

  // Restore the open-tab set from the previous browser session.
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) || "null"); } catch { /* ignore */ }
  if (saved?.open?.length) {
    let summaries = [];
    try { summaries = await listProjectSummaries(); } catch { /* memory mode */ }
    const byId = new Map(summaries.map(s => [s.id, s]));
    for (const id of saved.open) {
      const s = byId.get(id);
      if (s) tabs.push({ id: s.id, type: s.type, name: s.name, record: null });
    }
  }
  if (tabs.length > 0 && saved?.active && tabs.some(t => t.id === saved.active)) {
    await activateTab(saved.active);
  } else if (tabs.length > 0 && saved?.active == null) {
    await showHomeScreen();          // tabs stay open in the strip, home visible
  } else if (tabs.length > 0) {
    await activateTab(tabs[0].id);
  } else {
    await showHomeScreen();
  }
  emitChanged();
}
