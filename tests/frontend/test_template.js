/**
 * Tests for frontend/template.js using Node's built-in test runner.
 * Run with: node --test tests/frontend/test_template.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assembleTemplate, validateTemplate } from '../../frontend/template.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function validConfig() {
  return {
    name: 'Test Template',
    description: 'A test template',
    dxfFilename: 'part.dxf',
    entities: [{ type: 'LINE', start: [0, 0], end: [10, 0] }],
    calibration: { pixelsPerMm: 42.5, displayUnit: 'mm' },
    tolerances: { warn: 0.05, fail: 0.1 },
    featureTolerances: {},
    featureModes: {},
    featureNames: {},
    detection: { cannyLow: 50, cannyHigh: 150, smoothing: 1, subpixel: true },
    alignment: { method: 'edge', smoothing: 1 },
  };
}

// ── assembleTemplate ──────────────────────────────────────────────────────────

test('assembleTemplate: creates valid structure with version 1', () => {
  const tmpl = assembleTemplate(validConfig());
  assert.equal(tmpl.version, 1);
});

test('assembleTemplate: preserves name', () => {
  const tmpl = assembleTemplate(validConfig());
  assert.equal(tmpl.name, 'Test Template');
});

test('assembleTemplate: sets createdAt as ISO string', () => {
  const before = Date.now();
  const tmpl = assembleTemplate(validConfig());
  const after = Date.now();
  const ts = new Date(tmpl.createdAt).getTime();
  assert.ok(ts >= before && ts <= after, 'createdAt should be a recent timestamp');
});

test('assembleTemplate: sets updatedAt equal to createdAt on creation', () => {
  const tmpl = assembleTemplate(validConfig());
  assert.equal(tmpl.createdAt, tmpl.updatedAt);
});

test('assembleTemplate: nests entities under dxf.entities', () => {
  const cfg = validConfig();
  const tmpl = assembleTemplate(cfg);
  assert.deepEqual(tmpl.dxf.entities, cfg.entities);
});

test('assembleTemplate: nests dxfFilename under dxf.filename', () => {
  const tmpl = assembleTemplate(validConfig());
  assert.equal(tmpl.dxf.filename, 'part.dxf');
});

test('assembleTemplate: calibration fields are present', () => {
  const tmpl = assembleTemplate(validConfig());
  assert.equal(tmpl.calibration.pixelsPerMm, 42.5);
  assert.equal(tmpl.calibration.displayUnit, 'mm');
});

test('assembleTemplate: detection fields are present', () => {
  const tmpl = assembleTemplate(validConfig());
  assert.equal(tmpl.detection.cannyLow, 50);
  assert.equal(tmpl.detection.cannyHigh, 150);
  assert.equal(tmpl.detection.smoothing, 1);
  assert.equal(tmpl.detection.subpixel, true);
});

test('assembleTemplate: default description is empty string when omitted', () => {
  const cfg = validConfig();
  delete cfg.description;
  const tmpl = assembleTemplate(cfg);
  assert.equal(tmpl.description, '');
});

// ── validateTemplate ──────────────────────────────────────────────────────────

test('validateTemplate: accepts a valid template', () => {
  const tmpl = assembleTemplate(validConfig());
  const result = validateTemplate(tmpl);
  assert.equal(result.valid, true);
});

test('validateTemplate: rejects missing version', () => {
  const tmpl = assembleTemplate(validConfig());
  delete tmpl.version;
  const result = validateTemplate(tmpl);
  assert.equal(result.valid, false);
  assert.ok(result.error.toLowerCase().includes('version'));
});

test('validateTemplate: rejects future version (99)', () => {
  const tmpl = assembleTemplate(validConfig());
  tmpl.version = 99;
  const result = validateTemplate(tmpl);
  assert.equal(result.valid, false);
  assert.ok(result.error.toLowerCase().includes('version'));
});

test('validateTemplate: rejects missing dxf.entities', () => {
  const tmpl = assembleTemplate(validConfig());
  delete tmpl.dxf.entities;
  const result = validateTemplate(tmpl);
  assert.equal(result.valid, false);
  assert.ok(result.error.toLowerCase().includes('entities'));
});

test('validateTemplate: rejects empty dxf.entities array', () => {
  const tmpl = assembleTemplate(validConfig());
  tmpl.dxf.entities = [];
  const result = validateTemplate(tmpl);
  assert.equal(result.valid, false);
  assert.ok(result.error.toLowerCase().includes('entities'));
});

test('validateTemplate: rejects zero pixelsPerMm', () => {
  const tmpl = assembleTemplate(validConfig());
  tmpl.calibration.pixelsPerMm = 0;
  const result = validateTemplate(tmpl);
  assert.equal(result.valid, false);
  assert.ok(result.error.toLowerCase().includes('pixelspermm'));
});

test('validateTemplate: rejects negative pixelsPerMm', () => {
  const tmpl = assembleTemplate(validConfig());
  tmpl.calibration.pixelsPerMm = -5;
  const result = validateTemplate(tmpl);
  assert.equal(result.valid, false);
});

test('validateTemplate: rejects warn >= fail (equal)', () => {
  const tmpl = assembleTemplate(validConfig());
  tmpl.tolerances.warn = 0.1;
  tmpl.tolerances.fail = 0.1;
  const result = validateTemplate(tmpl);
  assert.equal(result.valid, false);
  assert.ok(result.error.toLowerCase().includes('warn'));
});

test('validateTemplate: rejects warn > fail', () => {
  const tmpl = assembleTemplate(validConfig());
  tmpl.tolerances.warn = 0.2;
  tmpl.tolerances.fail = 0.1;
  const result = validateTemplate(tmpl);
  assert.equal(result.valid, false);
});

test('validateTemplate: rejects missing detection settings', () => {
  const tmpl = assembleTemplate(validConfig());
  delete tmpl.detection;
  const result = validateTemplate(tmpl);
  assert.equal(result.valid, false);
  assert.ok(result.error.toLowerCase().includes('detection'));
});

test('validateTemplate: rejects non-number cannyLow', () => {
  const tmpl = assembleTemplate(validConfig());
  tmpl.detection.cannyLow = 'fifty';
  const result = validateTemplate(tmpl);
  assert.equal(result.valid, false);
});

test('validateTemplate: rejects non-object input (null)', () => {
  const result = validateTemplate(null);
  assert.equal(result.valid, false);
});

test('validateTemplate: rejects non-object input (array)', () => {
  const result = validateTemplate([]);
  assert.equal(result.valid, false);
});

test('validateTemplate: rejects invalid displayUnit', () => {
  const tmpl = assembleTemplate(validConfig());
  tmpl.calibration.displayUnit = 'inches';
  const result = validateTemplate(tmpl);
  assert.equal(result.valid, false);
  assert.ok(result.error.toLowerCase().includes('displayunit'));
});

// ── Round-trip ────────────────────────────────────────────────────────────────

test('round-trip: assembleTemplate output passes validateTemplate', () => {
  const tmpl = assembleTemplate(validConfig());
  const result = validateTemplate(tmpl);
  assert.equal(result.valid, true, `Expected valid but got: ${result.error}`);
});
