/**
 * v4 workspace codec, v3→v4 migration, .loupe file codec.
 * Run with: node --test tests/frontend/test_project_format.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { freshWorkspaceRecord } from '../../frontend/workspace.js';
import {
  WORKSPACE_VERSION, PROJECT_TYPES,
  buildWorkspaceV4, applyWorkspaceV4, migrateV3ToV4,
  sanitizeCalibration,
  LOUPE_FORMAT, LOUPE_VERSION, buildLoupeObject, parseLoupe, dataUrlToBlob,
} from '../../frontend/project-format.js';

function sampleRecord() {
  const rec = freshWorkspaceRecord();
  rec.state.tool = 'circle';
  rec.state.frozen = true;
  rec.state.nextId = 7;
  rec.state.calibration = { pixelsPerMm: 42.5, displayUnit: 'mm' };
  rec.state.origin = { x: 10, y: 20, angle: 0 };
  rec.state.tolerances = { warn: 0.05, fail: 0.2 };
  rec.state.lensK1 = -0.02;
  rec.state.featureModes = { A1: 'punch' };
  rec.state.measurementGroups = { 3: 'Slot' };
  rec.state.annotations = [
    { type: 'distance', id: 3, a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, purpose: 'measurement' },
    { type: 'detected-circle', id: 4, x: 5, y: 5, radius: 2 },
    { type: 'dxf-overlay', id: 5, offsetX: 1, offsetY: 2, entities: [] },
    { type: 'edges-overlay', id: 6, image: { live: 'element' } },   // must be stripped
  ];
  rec.viewport = { zoom: 2, panX: 3, panY: 4 };
  rec.imageWidth = 1920;
  rec.imageHeight = 1080;
  rec.undoStack = ['{"annotations":[]}'];   // must NOT be persisted
  return rec;
}

describe('buildWorkspaceV4', () => {
  it('produces a version-4 object with viewport, tool and frozen', () => {
    const v4 = buildWorkspaceV4(sampleRecord());
    assert.equal(v4.version, WORKSPACE_VERSION);
    assert.equal(v4.tool, 'circle');
    assert.equal(v4.frozen, true);
    assert.deepEqual(v4.viewport, { zoom: 2, panX: 3, panY: 4 });
    assert.deepEqual(v4.imageSize, { w: 1920, h: 1080 });
    assert.deepEqual(v4.tolerances, { warn: 0.05, fail: 0.2 });
    assert.equal(v4.lensK1, -0.02);
  });

  it('strips live-image overlays but keeps detections and dxf-overlay', () => {
    const v4 = buildWorkspaceV4(sampleRecord());
    assert.deepEqual(v4.annotations.map(a => a.type),
      ['distance', 'detected-circle', 'dxf-overlay']);
  });

  it('never contains undo/redo stacks or live element refs', () => {
    const v4 = buildWorkspaceV4(sampleRecord());
    assert.ok(!('undoStack' in v4) && !('redoStack' in v4));
    assert.ok(!('frozenBackground' in v4) && !('frozenBlob' in v4));
    // must be JSON-safe end to end
    assert.equal(typeof JSON.stringify(v4), 'string');
  });

  it('is a deep copy — later state mutations do not leak in', () => {
    const rec = sampleRecord();
    const v4 = buildWorkspaceV4(rec);
    rec.state.annotations[0].b.x = 999;
    rec.state.featureModes.A1 = 'die';
    assert.equal(v4.annotations[0].b.x, 10);
    assert.equal(v4.featureModes.A1, 'punch');
  });
});

describe('sanitizeCalibration', () => {
  it('passes through a valid calibration unchanged', () => {
    const cal = { pixelsPerMm: 100, displayUnit: 'mm' };
    assert.deepEqual(sanitizeCalibration(cal), cal);
  });

  it('accepts µm displayUnit', () => {
    const cal = { pixelsPerMm: 42.5, displayUnit: 'µm' };
    assert.deepEqual(sanitizeCalibration(cal), cal);
  });

  it('returns null for missing/null calibration', () => {
    assert.equal(sanitizeCalibration(null), null);
    assert.equal(sanitizeCalibration(undefined), null);
  });

  it('returns null for non-object calibration', () => {
    assert.equal(sanitizeCalibration("not an object"), null);
    assert.equal(sanitizeCalibration(123), null);
  });

  it('returns null for negative pixelsPerMm', () => {
    const cal = { pixelsPerMm: -1, displayUnit: 'mm' };
    assert.equal(sanitizeCalibration(cal), null);
  });

  it('returns null for zero pixelsPerMm', () => {
    const cal = { pixelsPerMm: 0, displayUnit: 'mm' };
    assert.equal(sanitizeCalibration(cal), null);
  });

  it('returns null for non-numeric pixelsPerMm', () => {
    const cal = { pixelsPerMm: 'garbage', displayUnit: 'mm' };
    assert.equal(sanitizeCalibration(cal), null);
  });

  it('returns null for non-finite pixelsPerMm (NaN, Infinity)', () => {
    assert.equal(sanitizeCalibration({ pixelsPerMm: NaN, displayUnit: 'mm' }), null);
    assert.equal(sanitizeCalibration({ pixelsPerMm: Infinity, displayUnit: 'mm' }), null);
  });

  it('returns null for invalid displayUnit', () => {
    const cal = { pixelsPerMm: 42.5, displayUnit: 'px' };
    assert.equal(sanitizeCalibration(cal), null);
  });
});

describe('applyWorkspaceV4', () => {
  it('round-trips buildWorkspaceV4 output', () => {
    const v4 = buildWorkspaceV4(sampleRecord());
    const rec = applyWorkspaceV4(JSON.parse(JSON.stringify(v4)));
    assert.equal(rec.state.tool, 'circle');
    assert.equal(rec.state.frozen, true);
    assert.equal(rec.state.nextId, 7);
    assert.equal(rec.state.calibration.pixelsPerMm, 42.5);
    assert.deepEqual(rec.state.tolerances, { warn: 0.05, fail: 0.2 });
    assert.equal(rec.state.lensK1, -0.02);
    assert.deepEqual(rec.viewport, { zoom: 2, panX: 3, panY: 4 });
    assert.equal(rec.imageWidth, 1920);
    assert.equal(rec.imageHeight, 1080);
    assert.deepEqual(rec.undoStack, []);
    assert.deepEqual(rec.state.measurementGroups, { 3: 'Slot' });
  });

  it('rejects wrong versions with a clear message', () => {
    assert.throws(() => applyWorkspaceV4({ version: 5, annotations: [] }),
      /Unsupported workspace version/);
    assert.throws(() => applyWorkspaceV4(null), /Missing workspace/);
    assert.throws(() => applyWorkspaceV4({ version: 4 }), /annotations/);
  });

  it('backfills purpose on annotations (matches loadSession behavior)', () => {
    const rec = applyWorkspaceV4({
      version: 4, tool: 'select', frozen: false, viewport: null, imageSize: null,
      annotations: [{ type: 'distance', id: 1 }],
    });
    assert.equal(rec.state.annotations[0].purpose, 'measurement');
  });

  it('sanitizes bad calibration: negative pixelsPerMm becomes null', () => {
    const rec = applyWorkspaceV4({
      version: 4, tool: 'select', frozen: false, viewport: null, imageSize: null,
      annotations: [],
      calibration: { pixelsPerMm: -1, displayUnit: 'mm' },
    });
    assert.equal(rec.state.calibration, null);
  });

  it('sanitizes bad calibration: non-numeric pixelsPerMm becomes null', () => {
    const rec = applyWorkspaceV4({
      version: 4, tool: 'select', frozen: false, viewport: null, imageSize: null,
      annotations: [],
      calibration: { pixelsPerMm: 'garbage', displayUnit: 'mm' },
    });
    assert.equal(rec.state.calibration, null);
  });

  it('sanitizes bad calibration: invalid displayUnit becomes null', () => {
    const rec = applyWorkspaceV4({
      version: 4, tool: 'select', frozen: false, viewport: null, imageSize: null,
      annotations: [],
      calibration: { pixelsPerMm: 100, displayUnit: 'cm' },
    });
    assert.equal(rec.state.calibration, null);
  });

  it('sanitizes bad calibration: non-object calibration becomes null', () => {
    const rec = applyWorkspaceV4({
      version: 4, tool: 'select', frozen: false, viewport: null, imageSize: null,
      annotations: [],
      calibration: 'not an object',
    });
    assert.equal(rec.state.calibration, null);
  });

  it('preserves valid calibration unchanged', () => {
    const cal = { pixelsPerMm: 100, displayUnit: 'mm' };
    const rec = applyWorkspaceV4({
      version: 4, tool: 'select', frozen: false, viewport: null, imageSize: null,
      annotations: [],
      calibration: cal,
    });
    assert.deepEqual(rec.state.calibration, cal);
  });
});

describe('migrateV3ToV4', () => {
  const v3 = {
    version: 3, savedAt: '2026-07-01T10:00:00Z', nextId: 12, nextConstraintId: 2,
    calibration: { pixelsPerMm: 33.3, displayUnit: 'mm' },
    origin: { x: 1, y: 2, angle: 0 },
    featureTolerances: {}, featureModes: { H1: 'die' }, featureNames: {},
    measurementGroups: {}, dxfFilename: 'part.dxf',
    inspectionResults: [], inspectionFrame: null, constraints: [],
    annotations: [{ type: 'distance', id: 1, a: { x: 0, y: 0 }, b: { x: 3, y: 4 } }],
  };

  it('produces a valid v4 workspace that applyWorkspaceV4 accepts', () => {
    const v4 = migrateV3ToV4(v3);
    assert.equal(v4.version, 4);
    assert.equal(v4.tool, 'select');
    assert.equal(v4.frozen, false);
    assert.equal(v4.viewport, null);
    assert.equal(v4.imageSize, null);
    const rec = applyWorkspaceV4(v4);
    assert.equal(rec.state.nextId, 12);
    assert.equal(rec.state.dxfFilename, 'part.dxf');
    assert.equal(rec.state.calibration.pixelsPerMm, 33.3);
  });

  it('rejects sessions newer than v3 and invalid shapes', () => {
    assert.throws(() => migrateV3ToV4({ version: 4, annotations: [] }), /newer/);
    assert.throws(() => migrateV3ToV4({ version: 3 }), /annotations/);
    assert.throws(() => migrateV3ToV4({ version: 3, annotations: [],
      calibration: { pixelsPerMm: -1, displayUnit: 'mm' } }), /calibration/);
  });

  it('derives nextId from annotations when missing (legacy v1)', () => {
    const v4 = migrateV3ToV4({ annotations: [{ type: 'distance', id: 9 }] });
    assert.equal(v4.nextId, 10);
  });
});

describe('.loupe codec', () => {
  const project = {
    id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', type: 'microscopy', name: 'Bracket',
    createdAt: '2026-07-08T09:00:00Z', updatedAt: '2026-07-08T10:00:00Z',
    imageMeta: { w: 4, h: 4, source: 'file', filename: 'b.png' },
  };
  // 1×1 red PNG
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('build → parse round-trips project metadata, workspace and image', () => {
    const ws = buildWorkspaceV4(sampleRecord());
    const text = JSON.stringify(buildLoupeObject(project, ws, dataUrl));
    const parsed = parseLoupe(text);
    assert.equal(parsed.project.id, project.id);
    assert.equal(parsed.project.type, 'microscopy');
    assert.equal(parsed.project.name, 'Bracket');
    assert.equal(parsed.workspace.version, 4);
    assert.equal(parsed.imageDataUrl, dataUrl);
    assert.deepEqual(parsed.imageMeta, project.imageMeta);
  });

  it('reports WHAT is wrong on invalid input', () => {
    assert.throws(() => parseLoupe('not json'), /valid JSON/);
    assert.throws(() => parseLoupe('{"foo":1}'), /loupe-project/);
    assert.throws(() => parseLoupe(JSON.stringify(
      { format: LOUPE_FORMAT, loupeVersion: 99, project })), /newer/);
    assert.throws(() => parseLoupe(JSON.stringify(
      { format: LOUPE_FORMAT, loupeVersion: 1,
        project: { ...project, type: 'hologram' } })), /Unknown project type "hologram"/);
    assert.throws(() => parseLoupe(JSON.stringify(
      { format: LOUPE_FORMAT, loupeVersion: 1,
        project: { ...project }, workspace: { version: 9 } })), /workspace version/);
  });

  it('invalid project id is nulled (importer regenerates), not fatal', () => {
    const text = JSON.stringify(buildLoupeObject({ ...project, id: 'nope' }, null, null));
    assert.equal(parseLoupe(text).project.id, null);
  });

  it('dataUrlToBlob decodes base64 data URLs', () => {
    const blob = dataUrlToBlob(dataUrl);
    assert.ok(blob instanceof Blob);
    assert.equal(blob.type, 'image/png');
    assert.ok(blob.size > 20);
    assert.throws(() => dataUrlToBlob('http://not-a-data-url'), /data URL/);
  });

  it('PROJECT_TYPES matches the spec whitelist', () => {
    assert.deepEqual(PROJECT_TYPES, ['microscopy', 'deflectometry', 'fringe']);
    assert.equal(LOUPE_VERSION, 1);
  });
});
