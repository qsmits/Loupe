/**
 * Static import-wiring guard for frontend/dxf.js.
 * Run with: node --test tests/frontend/test_dxf_imports.js
 *
 * dxf.js is DOM-coupled (imports canvas/img from render.js) so it can't be
 * imported under Node. These tests read it as source and assert that any
 * cross-module helper it *calls* is also *imported* — catching the class of
 * bug where `ensureFrozen()` was called on the auto-align path but never
 * imported, throwing a ReferenceError swallowed as a generic "Network error".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dxfSrc = readFileSync(join(here, '../../frontend/dxf.js'), 'utf8');

function importsName(src, name) {
  // Match `name` inside any `import { ... } from '...'` block.
  const importBlocks = src.match(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]/g) || [];
  const word = new RegExp(`\\b${name}\\b`);
  return importBlocks.some((block) => word.test(block));
}

test('dxf.js imports ensureFrozen because it calls it', () => {
  const callsIt = /\bensureFrozen\s*\(/.test(dxfSrc);
  assert.ok(callsIt, 'precondition: dxf.js is expected to call ensureFrozen()');
  assert.ok(
    importsName(dxfSrc, 'ensureFrozen'),
    'dxf.js calls ensureFrozen() but never imports it (ReferenceError at runtime)'
  );
});
