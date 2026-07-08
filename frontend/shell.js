// shell.js — Preact/htm UI shell: app bar (row 1), dialogs, toasts.
// Everything below the bars stays vanilla. The shell talks to the engine
// ONLY via document-level CustomEvents (see the event contract in the
// Track B plan) and re-renders on "workspace-changed" / "tool-changed".
// NO preact hooks (bare "preact" import can't resolve without an import
// map) — transient UI state lives in module variables + full re-render.

import { h, render } from './vendor/preact.mjs';
import htm from './vendor/htm.mjs';
import { getTabs, getActiveTabId } from './tab-manager.js';
import { Toolbar } from './toolbar.js';
import { HomeScreen, refreshHomeData } from './home-screen.js';

export const html = htm.bind(h);

function dispatch(name, detail = {}) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

const TYPE_BADGE = { microscopy: "M", deflectometry: "D", fringe: "F" };

function Tab({ tab, active }) {
  return html`
    <div class="shell-tab ${active ? "active" : ""}"
         title=${tab.name}
         onClick=${() => dispatch("activate-tab", { id: tab.id })}
         onAuxClick=${e => { if (e.button === 1) { e.preventDefault(); dispatch("close-tab", { id: tab.id }); } }}
         onDblClick=${() => {
           const name = prompt("Rename project", tab.name);
           if (name && name.trim()) dispatch("rename-project", { id: tab.id, name: name.trim() });
         }}>
      <span class="shell-tab-type shell-type-${tab.type}">${TYPE_BADGE[tab.type] ?? "?"}</span>
      <span class="shell-tab-name">${tab.name}</span>
      ${tab.dirty ? html`<span class="shell-tab-dirty" title="Unsaved changes">●</span>` : null}
      <button class="shell-tab-close" title="Close tab"
        onClick=${e => { e.stopPropagation(); dispatch("close-tab", { id: tab.id }); }}>×</button>
    </div>`;
}

function AppBar() {
  const tabs = getTabs();
  const activeId = getActiveTabId();
  return html`
    <div class="shell-mark" title="Home" onClick=${() => dispatch("new-project", {})}>⌕ Loupe</div>
    <div class="shell-tabstrip">
      ${tabs.map(t => html`<${Tab} key=${t.id} tab=${t} active=${t.id === activeId} />`)}
      <button class="shell-tab-add" title="New project / home"
        onClick=${() => dispatch("new-project", {})}>+</button>
    </div>`;
}

// ── Dialogs & toasts ─────────────────────────────────────────────────────────
let _dialog = null;   // { title, message, buttons, resolve }
let _toast = null;    // { message, actionLabel, onAction }
let _toastTimer = 0;
let _noticeStub = null;   // test seam, see _setNoticeHandler
let _toastStub = null;    // test seam, see _setToastHandler

/** Test seam: stub showNotice() so it resolves synchronously with whatever
 *  button id `stub({ title, message, buttons })` returns, bypassing the
 *  Preact overlay render — in a headless test DOM there's no button to
 *  click, so the real promise would never resolve. Pass null to restore
 *  the real modal. */
export function _setNoticeHandler(stub) { _noticeStub = stub; }

/** Test seam: stub showToast() so `stub(message, opts)` is called instead
 *  of scheduling the real overlay + auto-dismiss timer (which would leave
 *  a dangling timeout in a headless test run). Pass null to restore the
 *  real toast. */
export function _setToastHandler(stub) { _toastStub = stub; }

/** Modal notice. Resolves with the clicked button's id. */
export function showNotice({ title, message, buttons }) {
  if (_noticeStub) return Promise.resolve(_noticeStub({ title, message, buttons }));
  return new Promise(resolve => {
    _dialog = { title, message, buttons, resolve };
    renderOverlays();
  });
}

export function showToast(message, opts = {}) {
  if (_toastStub) { _toastStub(message, opts); return; }
  const { actionLabel, onAction, timeoutMs = 6000 } = opts;
  _toast = { message, actionLabel, onAction };
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { _toast = null; renderOverlays(); }, timeoutMs);
  renderOverlays();
}

function NoticeDialog() {
  if (!_dialog) return null;
  const d = _dialog;
  const pick = id => { _dialog = null; renderOverlays(); d.resolve(id); };
  return html`
    <div class="shell-dialog-backdrop">
      <div class="shell-dialog" role="dialog" aria-modal="true">
        <div class="shell-dialog-title">${d.title}</div>
        <div class="shell-dialog-message">${d.message}</div>
        <div class="shell-dialog-buttons">
          ${d.buttons.map(b => html`
            <button key=${b.id} class="shell-dialog-btn ${b.primary ? "primary" : ""}"
              onClick=${() => pick(b.id)}>${b.label}</button>`)}
        </div>
      </div>
    </div>`;
}

function Toast() {
  if (!_toast) return null;
  const t = _toast;
  return html`
    <div class="shell-toast">
      <span>${t.message}</span>
      ${t.actionLabel ? html`
        <button class="shell-toast-action"
          onClick=${() => { _toast = null; renderOverlays(); t.onAction?.(); }}>
          ${t.actionLabel}</button>` : null}
      <button class="shell-toast-close"
        onClick=${() => { _toast = null; renderOverlays(); }}>×</button>
    </div>`;
}

// ── Mount / render ───────────────────────────────────────────────────────────
let _appBarMount = null;
let _overlayMount = null;
let _toolbarMount = null;
let _homeMount = null;

export function renderShell() {
  if (_appBarMount) render(html`<${AppBar} />`, _appBarMount);
  if (_toolbarMount) render(html`<${Toolbar} />`, _toolbarMount);
  if (_homeMount) render(html`<${HomeScreen} />`, _homeMount);
}

function renderOverlays() {
  if (_overlayMount) render(html`<div><${NoticeDialog} /><${Toast} /></div>`, _overlayMount);
}

export function initShell() {
  _appBarMount = document.getElementById("app-bar-mount");
  _overlayMount = document.getElementById("shell-overlays");
  _toolbarMount = document.getElementById("toolbar-root");
  _homeMount = document.getElementById("home-screen-mount");
  document.addEventListener("workspace-changed", renderShell);
  document.addEventListener("tool-changed", renderShell);
  document.addEventListener("home-shown", refreshHomeData);
  renderShell();
}
