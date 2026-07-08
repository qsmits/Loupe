// tab-manager.js — project tab store. This file is the engine-side owner of
// the open-tab list. Task "TabManager core" adds the full lifecycle
// (open/activate/close/persist/autosave); this version only backs the shell
// rendering so the shell can land first.

export const tabs = [];          // internal: [{ id, type, name, record|null }]
let activeTabId = null;

export function getTabs() {
  return tabs.map(t => ({ id: t.id, type: t.type, name: t.name, dirty: false }));
}
export function getActiveTabId() { return activeTabId; }
export function getActiveTab() { return tabs.find(t => t.id === activeTabId) ?? null; }
export function _setActiveTabId(id) { activeTabId = id; }

export function emitChanged() {
  document.dispatchEvent(new CustomEvent("workspace-changed"));
}
