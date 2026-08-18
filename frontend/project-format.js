// project-format.js — pure codecs for project persistence.
//
// Three shapes:
//  * in-memory tab record   (workspace.js — live refs, undo stacks)
//  * workspace v4           (JSON-safe; stored in the IDB project record and
//                            in .loupe files; v3 session fields + viewport +
//                            tool + frozen + imageSize + tolerances +
//                            showDeviations + lensK1 + lensK1Space)
//  * .loupe file            (single JSON: project metadata + workspace v4 +
//                            image as data URL)
//
// Node-importable: no DOM access outside function bodies that are
// browser-only by contract (blobToDataUrl).

import { OVERLAY_TYPES } from './state.js';
import { freshWorkspaceRecord } from './workspace.js';

export const WORKSPACE_VERSION = 4;
export const PROJECT_TYPES = ["microscopy", "deflectometry", "fringe"];
export const LOUPE_FORMAT = "loupe-project";
export const LOUPE_VERSION = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validate and sanitize calibration object.
 *  Returns the calibration if valid, or null if missing/invalid.
 *  An invalid calibration (non-numeric/non-positive pixelsPerMm, bad displayUnit)
 *  becomes null (uncalibrated) rather than being trusted — consistent with
 *  how migrateV3ToV4 and session.js validate. */
export function sanitizeCalibration(cal) {
  if (cal == null) return null;
  if (typeof cal !== "object") return null;
  if (typeof cal.pixelsPerMm !== "number" || !isFinite(cal.pixelsPerMm)
      || cal.pixelsPerMm <= 0) {
    return null;
  }
  if (cal.displayUnit !== "mm" && cal.displayUnit !== "µm") {
    return null;
  }
  return cal;
}

/** In-memory tab record → JSON-safe v4 workspace (deep copy).
 *  Keeps detections + dxf-overlay (plain JSON, unlike v3's TRANSIENT filter);
 *  strips only OVERLAY_TYPES (live HTMLImageElement payloads). */
export function buildWorkspaceV4(record) {
  const s = record.state;
  return {
    version: WORKSPACE_VERSION,
    savedAt: new Date().toISOString(),
    tool: s.tool,
    frozen: s.frozen,
    viewport: record.viewport ? { ...record.viewport } : null,
    imageSize: record.imageWidth > 0
      ? { w: record.imageWidth, h: record.imageHeight } : null,
    nextId: s.nextId,
    nextConstraintId: s.nextConstraintId,
    calibration: s.calibration ? { ...s.calibration } : null,
    origin: s.origin ? { ...s.origin } : null,
    tolerances: { ...s.tolerances },
    showDeviations: !!s.showDeviations,
    lensK1: s.lensK1 ?? 0,
    // The coefficient space lensK1 is actually in — must travel with it or
    // a deferred (still pixel_v0) value silently reverts to the
    // diag_normalized_v1 default on the next load and gets mistagged.
    lensK1Space: s.lensK1Space ?? "diag_normalized_v1",
    featureTolerances: { ...s.featureTolerances },
    featureModes: { ...s.featureModes },
    featureNames: { ...s.featureNames },
    measurementGroups: { ...s.measurementGroups },
    dxfFilename: s.dxfFilename ?? null,
    inspectionResults: JSON.parse(JSON.stringify(s.inspectionResults ?? [])),
    inspectionFrame: s.inspectionFrame ?? null,
    constraints: (s.constraints ?? []).map(c =>
      ({ ...c, contactPoint: c.contactPoint ? { ...c.contactPoint } : null })),
    annotations: (s.annotations ?? [])
      .filter(a => !OVERLAY_TYPES.has(a.type))
      .map(a => JSON.parse(JSON.stringify(a))),
  };
}

/** v4 workspace → fresh in-memory tab record (empty undo/redo stacks; the
 *  image Blob/element is attached separately by tab-manager). */
export function applyWorkspaceV4(v4) {
  if (!v4 || typeof v4 !== "object") throw new Error("Missing workspace");
  if (v4.version !== WORKSPACE_VERSION) {
    throw new Error(`Unsupported workspace version: ${v4.version}`);
  }
  if (!Array.isArray(v4.annotations)) {
    throw new Error("Invalid workspace: no annotations array");
  }
  const record = freshWorkspaceRecord();
  const s = record.state;
  s.tool = typeof v4.tool === "string" ? v4.tool : "select";
  s.frozen = !!v4.frozen;
  s.nextId = v4.nextId
    ?? (v4.annotations.reduce((m, a) => Math.max(m, a.id ?? 0), 0) + 1);
  s.nextConstraintId = v4.nextConstraintId ?? 1;
  s.calibration = sanitizeCalibration(v4.calibration);
  s.origin = v4.origin ?? null;
  if (v4.tolerances && typeof v4.tolerances === "object") {
    s.tolerances = { ...v4.tolerances };
  }
  s.showDeviations = !!v4.showDeviations;
  s.lensK1 = v4.lensK1 ?? 0;
  // Missing lensK1Space means a workspace saved before this field existed —
  // every such record's lensK1 is guaranteed already-converted (the old
  // defer bug stored 0, never a raw magnitude), so diag_normalized_v1 is the
  // correct, safe default here, not a guess.
  s.lensK1Space = v4.lensK1Space ?? "diag_normalized_v1";
  s.featureTolerances = { ...(v4.featureTolerances ?? {}) };
  s.featureModes = { ...(v4.featureModes ?? {}) };
  s.featureNames = { ...(v4.featureNames ?? {}) };
  s.measurementGroups = { ...(v4.measurementGroups ?? {}) };
  s.dxfFilename = v4.dxfFilename ?? null;
  s.inspectionResults = Array.isArray(v4.inspectionResults)
    ? v4.inspectionResults.slice() : [];
  s.inspectionFrame = v4.inspectionFrame ?? null;
  s.constraints = Array.isArray(v4.constraints)
    ? v4.constraints.map(c => ({ ...c })) : [];
  s.annotations = v4.annotations.map(a =>
    a.purpose ? { ...a } : { ...a, purpose: "measurement" });
  // state.origin is authoritative for the origin annotation's angle
  // (mirrors session.js loadSession).
  if (s.origin) {
    const originAnn = s.annotations.find(a => a.type === "origin");
    if (originAnn) originAnn.angle = s.origin.angle ?? 0;
  }
  record.viewport = v4.viewport
    ? { zoom: v4.viewport.zoom, panX: v4.viewport.panX, panY: v4.viewport.panY }
    : null;
  if (v4.imageSize && v4.imageSize.w > 0) {
    record.imageWidth = v4.imageSize.w;
    record.imageHeight = v4.imageSize.h;
  }
  return record;
}

/** v3 session JSON (the current save/autosave format) → v4 workspace.
 *  Validation mirrors session.js loadSession(). */
export function migrateV3ToV4(data) {
  if (!data || typeof data !== "object") throw new Error("Not a session object");
  if (data.version != null && data.version > 3) {
    throw new Error(`Session version ${data.version} is newer than this app supports`);
  }
  if (!Array.isArray(data.annotations)) {
    throw new Error("Invalid session: no annotations array");
  }
  let calibration = null;
  if (data.calibration != null) {
    // Validate using shared helper; if it was non-null but failed validation, throw
    calibration = sanitizeCalibration(data.calibration);
    if (calibration === null) {
      throw new Error("Invalid session: bad calibration");
    }
  }
  return {
    version: WORKSPACE_VERSION,
    savedAt: data.savedAt ?? new Date().toISOString(),
    tool: "select",
    frozen: false,          // v3 sessions never include the image
    viewport: null,
    imageSize: null,
    nextId: data.nextId
      ?? (data.annotations.reduce((m, a) => Math.max(m, a.id ?? 0), 0) + 1),
    nextConstraintId: data.nextConstraintId ?? 1,
    calibration: calibration,
    origin: data.origin ?? null,
    tolerances: { warn: 0.10, fail: 0.25 },
    showDeviations: false,
    lensK1: 0,
    lensK1Space: "diag_normalized_v1", // v3 sessions never carried lens correction
    featureTolerances: { ...(data.featureTolerances ?? {}) },
    featureModes: { ...(data.featureModes ?? {}) },
    featureNames: { ...(data.featureNames ?? {}) },
    measurementGroups: { ...(data.measurementGroups ?? {}) },
    dxfFilename: data.dxfFilename ?? null,
    inspectionResults: Array.isArray(data.inspectionResults)
      ? data.inspectionResults.slice() : [],
    inspectionFrame: data.inspectionFrame ?? null,
    constraints: Array.isArray(data.constraints)
      ? data.constraints.map(c => ({ ...c })) : [],
    annotations: data.annotations.map(a =>
      a.purpose ? { ...a } : { ...a, purpose: "measurement" }),
  };
}

/** Assemble the single-JSON .loupe payload. */
export function buildLoupeObject(project, workspace, imageDataUrl) {
  return {
    format: LOUPE_FORMAT,
    loupeVersion: LOUPE_VERSION,
    project: {
      id: project.id,
      type: project.type,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    imageMeta: project.imageMeta ?? null,
    imageDataUrl: imageDataUrl ?? null,
    workspace: workspace ?? null,
  };
}

/** Parse + validate a .loupe file. Throws Errors that say what's wrong —
 *  the import UI shows err.message verbatim. */
export function parseLoupe(text) {
  let obj;
  try { obj = JSON.parse(text); }
  catch { throw new Error("Not a valid JSON file"); }
  if (obj?.format !== LOUPE_FORMAT) {
    throw new Error('Not a .loupe project file (missing "format": "loupe-project")');
  }
  if (typeof obj.loupeVersion !== "number" || obj.loupeVersion > LOUPE_VERSION) {
    throw new Error(
      `.loupe version ${obj.loupeVersion} is newer than this app supports (max ${LOUPE_VERSION})`);
  }
  const p = obj.project;
  if (!p || typeof p !== "object") {
    throw new Error("Invalid .loupe file: missing project metadata");
  }
  if (!PROJECT_TYPES.includes(p.type)) {
    throw new Error(
      `Unknown project type "${p.type}" (expected one of: ${PROJECT_TYPES.join(", ")})`);
  }
  if (typeof p.name !== "string" || !p.name) {
    throw new Error("Invalid .loupe file: missing project name");
  }
  if (obj.workspace != null && obj.workspace.version !== WORKSPACE_VERSION) {
    throw new Error(
      `Unsupported workspace version ${obj.workspace?.version} in .loupe file`);
  }
  if (obj.imageDataUrl != null && !/^data:image\//.test(obj.imageDataUrl)) {
    throw new Error("Invalid .loupe file: image is not an image data URL");
  }
  return {
    project: {
      id: typeof p.id === "string" && UUID_RE.test(p.id) ? p.id : null,
      type: p.type,
      name: p.name,
      createdAt: p.createdAt ?? new Date().toISOString(),
      updatedAt: p.updatedAt ?? new Date().toISOString(),
    },
    workspace: obj.workspace ?? null,
    imageDataUrl: obj.imageDataUrl ?? null,
    imageMeta: obj.imageMeta ?? null,
  };
}

/** data URL → Blob (node-safe: atob + Uint8Array). */
export function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) throw new Error("Invalid data URL");
  const mime = m[1] || "application/octet-stream";
  if (m[2]) {
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(m[3])], { type: mime });
}

/** Blob → data URL. Browser-only (FileReader). */
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("Blob read failed"));
    r.readAsDataURL(blob);
  });
}
