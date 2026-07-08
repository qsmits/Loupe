// project-io.js — .loupe export/import, plain-image and v3-session import,
// legacy localStorage-autosave migration, global .loupe drag-in.
//
// .loupe = single JSON file (project metadata + workspace v4 + image as a
// data URL). Cross-user/machine sharing is EXPLICIT-ONLY via these files —
// the server never stores projects.

import { getProject } from './projects-db.js';
import {
  parseLoupe, buildLoupeObject, dataUrlToBlob, blobToDataUrl, migrateV3ToV4,
} from './project-format.js';
import { adoptProject } from './tab-manager.js';
import { showNotice, showToast } from './shell.js';

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function importError(message) {
  await showNotice({
    title: "Import failed",
    message,
    buttons: [{ id: "ok", label: "OK", primary: true }],
  });
}

// ── Export ───────────────────────────────────────────────────────────────────
export async function exportProjectAsLoupe(id) {
  let proj = null;
  try { proj = await getProject(id); } catch { /* fall through */ }
  if (!proj) { showToast("Project not found"); return; }
  const imageDataUrl = proj.image ? await blobToDataUrl(proj.image) : null;
  const obj = buildLoupeObject(proj, proj.workspace, imageDataUrl);
  const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
  const safeName = proj.name.replace(/[^\w\- ]+/g, "_").trim() || "project";
  downloadBlob(blob, `${safeName}.loupe`);
  showToast(`Exported "${proj.name}" as .loupe`);
}

// ── Import ───────────────────────────────────────────────────────────────────
function imageDims(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve({ w: im.naturalWidth, h: im.naturalHeight }); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image could not be decoded")); };
    im.src = url;
  });
}

async function importImageAsProject(file) {
  let dims;
  try { dims = await imageDims(file); }
  catch (e) { await importError(`"${file.name}": ${e.message}`); return; }
  const now = new Date().toISOString();
  await adoptProject({
    id: crypto.randomUUID(),
    type: "microscopy",
    name: file.name.replace(/\.[^.]+$/, "") || "Imported image",
    createdAt: now, updatedAt: now,
    thumbnail: null,
    image: file,
    imageMeta: { w: dims.w, h: dims.h, source: "file", filename: file.name },
    workspace: null,
  });
}

async function importLoupeText(text, filename) {
  let parsed;
  try { parsed = parseLoupe(text); }
  catch (e) { await importError(`"${filename}": ${e.message}`); return; }
  let image = null;
  let imageMeta = parsed.imageMeta ?? null;
  if (parsed.imageDataUrl) {
    try { image = dataUrlToBlob(parsed.imageDataUrl); }
    catch (e) { await importError(`"${filename}": embedded image is corrupt (${e.message})`); return; }
    if (!imageMeta) {
      try { const d = await imageDims(image); imageMeta = { ...d, source: "file" }; }
      catch { image = null; }
    }
  }
  const now = new Date().toISOString();
  await adoptProject({
    id: parsed.project.id ?? crypto.randomUUID(),
    type: parsed.project.type,
    name: parsed.project.name,
    createdAt: parsed.project.createdAt,
    updatedAt: now,
    thumbnail: null,
    image,
    imageMeta,
    workspace: parsed.workspace,
  });
}

async function importSessionJson(data, filename) {
  let workspace;
  try { workspace = migrateV3ToV4(data); }
  catch (e) { await importError(`"${filename}": ${e.message}`); return; }
  const now = new Date().toISOString();
  await adoptProject({
    id: crypto.randomUUID(),
    type: "microscopy",
    name: filename.replace(/\.[^.]+$/, "") || "Imported session",
    createdAt: now, updatedAt: now,
    thumbnail: null,
    image: null,                      // v3 sessions never include the image
    imageMeta: null,
    workspace,
  });
  showToast("Session imported — v3 sessions do not include the image");
}

/** Route one dropped/browsed file to the right importer. */
export async function importFile(file) {
  if (file.type.startsWith("image/")) return importImageAsProject(file);
  let text;
  try { text = await file.text(); }
  catch { await importError(`"${file.name}" could not be read`); return; }
  if (file.name.toLowerCase().endsWith(".loupe")) return importLoupeText(text, file.name);
  let data;
  try { data = JSON.parse(text); }
  catch { await importError(`"${file.name}" is not valid JSON, a .loupe file, or an image`); return; }
  if (data?.format === "loupe-project") return importLoupeText(text, file.name);
  if (Array.isArray(data?.annotations)) return importSessionJson(data, file.name);
  await importError(
    `"${file.name}" is JSON but neither a .loupe project nor a session file ` +
    `(expected "format": "loupe-project" or an "annotations" array)`);
}

// ── Legacy autosave migration (spec: offered as a converted project) ─────────
const LEGACY_AUTOSAVE_KEY = "microscope-autosave";

export async function offerAutosaveMigration() {
  const raw = localStorage.getItem(LEGACY_AUTOSAVE_KEY);
  if (!raw) return;
  let workspace = null;
  try { workspace = migrateV3ToV4(JSON.parse(raw)); }
  catch { localStorage.removeItem(LEGACY_AUTOSAVE_KEY); return; }
  const choice = await showNotice({
    title: "Previous session found",
    message: "An auto-saved session from the previous app version exists.\n" +
      "Convert it into a project? (v3 auto-saves never stored the image — " +
      "annotations and calibration only.)",
    buttons: [
      { id: "discard", label: "Discard" },
      { id: "convert", label: "Convert to project", primary: true },
    ],
  });
  if (choice === "convert") {
    const now = new Date().toISOString();
    const ok = await adoptProject({
      id: crypto.randomUUID(), type: "microscopy", name: "Recovered session",
      createdAt: now, updatedAt: now,
      thumbnail: null, image: null, imageMeta: null, workspace,
    });
    // adoptProject already toasted the failure; keep the only copy of the
    // legacy session around so the user can retry instead of losing it.
    if (!ok) return;
  }
  localStorage.removeItem(LEGACY_AUTOSAVE_KEY);
}

// ── Wiring ───────────────────────────────────────────────────────────────────
export function initProjectIo() {
  document.addEventListener("export-project", e => exportProjectAsLoupe(e.detail.id));
  document.addEventListener("import-files", e => {
    (async () => { for (const f of e.detail.files) await importFile(f); })();
  });

  // Global .loupe drag-in: capture phase so it wins over the viewer/fringe
  // image-drop handlers, which keep their behavior for every other file.
  document.addEventListener("dragover", e => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  }, true);
  document.addEventListener("drop", e => {
    const f = e.dataTransfer?.files?.[0];
    if (f && f.name.toLowerCase().endsWith(".loupe")) {
      e.preventDefault();
      e.stopPropagation();
      importFile(f);
    }
  }, true);

  // Home-screen import zone: visual feedback + drop of any supported type.
  // (Delegated to the persistent container div, which survives re-renders.)
  const zone = () => document.getElementById("home-import-zone");
  const home = document.getElementById("home-screen");
  if (home) {
    home.addEventListener("dragover", e => {
      e.preventDefault();
      zone()?.classList.add("drag-active");
    });
    home.addEventListener("dragleave", e => {
      if (!home.contains(e.relatedTarget)) zone()?.classList.remove("drag-active");
    });
    home.addEventListener("drop", e => {
      e.preventDefault();
      zone()?.classList.remove("drag-active");
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) {
        document.dispatchEvent(new CustomEvent("import-files", { detail: { files } }));
      }
    });
  }
}
