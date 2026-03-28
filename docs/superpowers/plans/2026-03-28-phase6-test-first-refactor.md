# Phase 6: Test-First Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the frontend safe to refactor by purifying key functions, adding tests, then splitting oversized files — each step independently shippable.

**Architecture:** Extract pure functions from global-state-coupled modules, test them with Node's built-in test runner, then mechanically split `main.js` (1714 LOC), `render.js` (1585 LOC), `tools.js` (821 LOC), and `api.py` (585 LOC) into focused modules. Tests act as the safety net for every split.

**Tech Stack:** Node 20 built-in test runner (`node:test`, `node:assert`), ES modules, FastAPI `include_router()`

**Spec:** `docs/superpowers/specs/2026-03-28-phase6-test-first-refactor-design.md`

---

## File Map

### New files to create
| File | Purpose |
|------|---------|
| `tests/frontend/test_math.js` | Tests for all `math.js` exports |
| `tests/frontend/test_viewport.js` | Tests for `imageToScreenPure`, `screenToImagePure` |
| `tests/frontend/test_measurement.js` | Tests for `measurementLabel` across all annotation types |
| `tests/frontend/test_csv.js` | Tests for `formatCsvValue` |
| `frontend/format.js` | Extracted: `measurementLabel`, `getLineEndpoints`, `lineAngleDeg` |
| `frontend/events-mouse.js` | Extracted from `main.js`: mouse handlers |
| `frontend/events-keyboard.js` | Extracted from `main.js`: keyboard shortcuts |
| `frontend/events-context-menu.js` | Extracted from `main.js`: context menu |
| `frontend/events-inspection.js` | Extracted from `main.js`: point-pick, label drag, tooltips |
| `frontend/events-dxf.js` | Extracted from `main.js`: DXF align, drag, entity selection |
| `frontend/render-annotations.js` | Extracted from `render.js`: draw functions for all measurement/detection types |
| `frontend/render-dxf.js` | Extracted from `render.js`: DXF overlay, guided results, deviations |
| `frontend/render-hud.js` | Extracted from `render.js`: minimap, grid, zoom badge, crosshair |
| `frontend/hit-test.js` | Extracted from `tools.js`: `hitTestAnnotation`, `hitTestDxfEntity` |
| `backend/api_camera.py` | Extracted from `api.py`: camera/stream/snapshot endpoints |
| `backend/api_detection.py` | Extracted from `api.py`: detection endpoints |
| `backend/api_inspection.py` | Extracted from `api.py`: inspection/alignment/DXF endpoints |

### Files to modify
| File | Changes |
|------|---------|
| `frontend/viewport.js` | Add `imageToScreenPure`, `screenToImagePure` exports; existing functions become wrappers |
| `frontend/render.js` | Remove `measurementLabel`, `getLineEndpoints`, `lineAngleDeg`; re-export from `format.js`. Later: extract draw functions into sub-modules |
| `frontend/session.js` | Change `formatCsvValue` signature to accept `calibration, imageWidth`; update `measurementLabel` import |
| `frontend/sidebar.js` | Update `measurementLabel` import; pass ctx at call sites |
| `frontend/main.js` | Extract event handlers into sub-modules; becomes thin init/wiring file |
| `frontend/tools.js` | Extract hit-test functions into `hit-test.js` |
| `backend/api.py` | Extract endpoint groups into sub-routers; becomes composition root |

---

### Task 1: Test infrastructure setup

**Files:**
- Create: `tests/frontend/test_math.js`

- [ ] **Step 1: Verify Node test runner works**

Create a minimal test file to confirm the runner:

```js
// tests/frontend/test_math.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('smoke test', () => {
  it('1 + 1 = 2', () => {
    assert.equal(1 + 1, 2);
  });
});
```

- [ ] **Step 2: Run it**

Run: `node --test tests/frontend/test_math.js`
Expected: PASS, 1 test

- [ ] **Step 3: Write math.js tests**

Replace the smoke test with real tests for all 6 exported functions:

```js
// tests/frontend/test_math.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDistanceInput, fitCircle, fitCircleAlgebraic,
  polygonArea, distPointToSegment, fitLine
} from '../../frontend/math.js';

// ── parseDistanceInput ──
describe('parseDistanceInput', () => {
  it('parses mm value', () => {
    const r = parseDistanceInput('1.5 mm');
    assert.deepStrictEqual(r, { value: 1.5, unit: 'mm', mm: 1.5 });
  });
  it('parses µm value', () => {
    const r = parseDistanceInput('500 µm');
    assert.equal(r.unit, 'µm');
    assert.equal(r.mm, 0.5);
  });
  it('defaults to mm when no unit', () => {
    const r = parseDistanceInput('2.0');
    assert.equal(r.unit, 'mm');
    assert.equal(r.mm, 2.0);
  });
  it('returns null for invalid input', () => {
    // parseDistanceInput calls alert() which is undefined in Node —
    // we need to stub it
    globalThis.alert = () => {};
    const r = parseDistanceInput('abc');
    assert.equal(r, null);
    delete globalThis.alert;
  });
});

// ── fitCircle ──
describe('fitCircle', () => {
  it('fits a unit circle from 3 points', () => {
    const c = fitCircle({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 });
    assert.ok(Math.abs(c.cx) < 1e-9);
    assert.ok(Math.abs(c.cy) < 1e-9);
    assert.ok(Math.abs(c.r - 1) < 1e-9);
  });
  it('fits an offset circle', () => {
    const cx = 10, cy = 20, r = 5;
    const c = fitCircle(
      { x: cx + r, y: cy },
      { x: cx, y: cy + r },
      { x: cx - r, y: cy }
    );
    assert.ok(Math.abs(c.cx - cx) < 1e-6);
    assert.ok(Math.abs(c.cy - cy) < 1e-6);
    assert.ok(Math.abs(c.r - r) < 1e-6);
  });
  it('throws for collinear points', () => {
    assert.throws(() => fitCircle({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }));
  });
});

// ── fitCircleAlgebraic ──
describe('fitCircleAlgebraic', () => {
  it('fits circle from many points', () => {
    const cx = 5, cy = 5, r = 10;
    const pts = [];
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * 2 * Math.PI;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    const c = fitCircleAlgebraic(pts);
    assert.ok(c !== null);
    assert.ok(Math.abs(c.cx - cx) < 0.01);
    assert.ok(Math.abs(c.cy - cy) < 0.01);
    assert.ok(Math.abs(c.r - r) < 0.01);
  });
  it('returns null for fewer than 3 points', () => {
    assert.equal(fitCircleAlgebraic([{ x: 0, y: 0 }]), null);
  });
  it('returns null for collinear points', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
    assert.equal(fitCircleAlgebraic(pts), null);
  });
});

// ── polygonArea ──
describe('polygonArea', () => {
  it('computes area of unit square', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    assert.ok(Math.abs(polygonArea(pts) - 1.0) < 1e-10);
  });
  it('computes area of right triangle', () => {
    const pts = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }];
    assert.ok(Math.abs(polygonArea(pts) - 6.0) < 1e-10);
  });
  it('returns 0 for degenerate polygon', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    assert.equal(polygonArea(pts), 0);
  });
});

// ── distPointToSegment ──
describe('distPointToSegment', () => {
  it('point on segment returns 0', () => {
    assert.ok(distPointToSegment({ x: 0.5, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }) < 1e-10);
  });
  it('perpendicular distance to horizontal segment', () => {
    const d = distPointToSegment({ x: 0.5, y: 3 }, { x: 0, y: 0 }, { x: 1, y: 0 });
    assert.ok(Math.abs(d - 3) < 1e-10);
  });
  it('distance to nearest endpoint when beyond segment', () => {
    const d = distPointToSegment({ x: 2, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 });
    assert.ok(Math.abs(d - 1) < 1e-10);
  });
  it('zero-length segment returns point distance', () => {
    const d = distPointToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 });
    assert.ok(Math.abs(d - 5) < 1e-10);
  });
});

// ── fitLine ──
describe('fitLine', () => {
  it('fits horizontal points', () => {
    const pts = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }];
    const l = fitLine(pts);
    assert.ok(l !== null);
    assert.ok(Math.abs(l.cy) < 1e-10, 'centroid y should be 0');
    assert.ok(Math.abs(l.y1) < 1e-10);
    assert.ok(Math.abs(l.y2) < 1e-10);
    assert.ok(Math.abs(l.x1 - 0) < 1e-6);
    assert.ok(Math.abs(l.x2 - 10) < 1e-6);
  });
  it('fits vertical points', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 10 }];
    const l = fitLine(pts);
    assert.ok(l !== null);
    assert.ok(Math.abs(l.cx) < 1e-10);
  });
  it('returns null for fewer than 2 points', () => {
    assert.equal(fitLine([{ x: 0, y: 0 }]), null);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/frontend/test_math.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add tests/frontend/test_math.js
git commit -m "test: add frontend math.js tests (Node built-in runner)"
```

---

### Task 2: Extract `format.js` from `render.js`

**Files:**
- Create: `frontend/format.js`
- Modify: `frontend/render.js:63-269` (remove `measurementLabel`), `frontend/render.js:1364-1386` (remove `getLineEndpoints`, `lineAngleDeg`)
- Modify: `frontend/session.js:2` (update import)
- Modify: `frontend/sidebar.js:2` (update import)

- [ ] **Step 1: Create `format.js` with extracted functions**

Extract `measurementLabel` (lines 63-269 of `render.js`), `getLineEndpoints` (lines 1364-1379), and `lineAngleDeg` (lines 1383-1386).

Key changes during extraction:
- `measurementLabel(ann)` → `measurementLabel(ann, ctx)` where `ctx = { calibration, annotations, origin, imageWidth, imageHeight, canvasWidth, canvasHeight }`
- Replace all `state.calibration` reads with `ctx.calibration`
- Replace all `state.annotations.find(...)` with `ctx.annotations.find(...)`
- Replace all `state.origin` reads with `ctx.origin`
- Replace `imageWidth` with `ctx.imageWidth`
- Replace `canvas.width`/`canvas.height` with `ctx.canvasWidth`/`ctx.canvasHeight`
- `getLineEndpoints(ann)` also reads `canvas.width` and `imageHeight` for `detected-line` type — add optional second param: `getLineEndpoints(ann, ctx)` and fall back for backward compat
- Import `polygonArea` from `./math.js` (currently imported by render.js)

```js
// frontend/format.js
import { polygonArea } from './math.js';

/**
 * Pure formatting context — callers assemble from their state/DOM refs.
 * canvasWidth/canvasHeight = canvas.width/canvas.height (backing store pixels, not CSS pixels).
 * imageWidth/imageHeight = source image resolution (from viewport.js).
 * @typedef {{ calibration: object|null, annotations: Array, origin: object|null,
 *             imageWidth: number, imageHeight: number,
 *             canvasWidth: number, canvasHeight: number }} MeasurementCtx
 */

export function getLineEndpoints(ann, ctx = {}) {
  if (ann.type === "distance" || ann.type === "perp-dist" ||
      ann.type === "para-dist" || ann.type === "parallelism") {
    return { a: ann.a, b: ann.b };
  }
  if (ann.type === "calibration" && ann.x1 !== undefined) {
    return { a: { x: ann.x1, y: ann.y1 }, b: { x: ann.x2, y: ann.y2 } };
  }
  if (ann.type === "detected-line") {
    // NOTE: existing render.js uses canvas.width for sx and imageHeight for sy.
    // This is inconsistent with measurementLabel which uses imageWidth for detected types.
    // We preserve the existing behavior here to avoid regressions.
    const sx = (ctx.canvasWidth || 1)  / ann.frameWidth;
    const sy = (ctx.imageHeight || 1) / ann.frameHeight;
    return { a: { x: ann.x1 * sx, y: ann.y1 * sy },
             b: { x: ann.x2 * sx, y: ann.y2 * sy } };
  }
  return null;
}

export function lineAngleDeg(ann, ctx = {}) {
  const ep = getLineEndpoints(ann, ctx);
  if (!ep) return 0;  // defensive: unsupported annotation type
  return Math.atan2(ep.b.y - ep.a.y, ep.b.x - ep.a.x) * 180 / Math.PI;
}

export function measurementLabel(ann, ctx) {
  const cal = ctx.calibration && ctx.calibration.pixelsPerMm > 0 ? ctx.calibration : null;

  // ... (full body from render.js lines 65-268, with all state.* / canvas.* / imageWidth
  //      replaced by ctx.calibration / ctx.canvasWidth / ctx.canvasHeight / ctx.imageWidth
  //      / ctx.imageHeight / ctx.annotations / ctx.origin — see render.js:63-269 for the complete logic)
  //
  // Key replacements inside the function body:
  //   state.calibration     → ctx.calibration  (already done via `cal` above)
  //   state.annotations     → ctx.annotations
  //   state.origin          → ctx.origin
  //   imageWidth            → ctx.imageWidth
  //   canvas.width          → ctx.canvasWidth
  //   canvas.height         → ctx.canvasHeight
  //   getLineEndpoints(ann) → getLineEndpoints(ann, ctx)
  //   lineAngleDeg(ann)     → lineAngleDeg(ann, ctx)
  //
  // The complete function body is a 1:1 copy of render.js:63-269 with these substitutions.
  // No logic changes.
}

// Also extract formatCsvValue here (from session.js:9-83) with purified signature.
// This avoids a Task 4 → Task 5 flip-flop where we'd modify it in session.js then move it.
export function formatCsvValue(ann, calibration, imgWidth) {
  const cal = calibration;
  // ... (full body from session.js:12-83, with imageWidth replaced by imgWidth)
  // The complete function body is a 1:1 copy with this one substitution.
}
```

- [ ] **Step 2: Update `render.js` — remove extracted functions, add re-exports**

In `render.js`:
- Remove `measurementLabel` function (lines 63-269)
- Remove `getLineEndpoints` function (lines 1364-1379)
- Remove `lineAngleDeg` function (lines 1383-1386)
- Add import and re-exports at top:

```js
import { measurementLabel as _measurementLabel, getLineEndpoints, lineAngleDeg } from './format.js';
export { getLineEndpoints, lineAngleDeg } from './format.js';

// Convenience wrapper — assembles ctx from module-level globals
export function measurementLabel(ann) {
  return _measurementLabel(ann, {
    calibration: state.calibration,
    annotations: state.annotations,
    origin: state.origin,
    imageWidth,
    imageHeight,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  });
}
```

Internal callers in render.js (lines 553, 575, 655, 920, 928, 942, 1069, 1084, 1100, 1109, 1157, 1192, 1229, 1256, 1271) continue calling `measurementLabel(ann)` — the wrapper handles it.

Internal callers of `getLineEndpoints` and `lineAngleDeg` (in `drawSlotDist`, `drawIntersect`, `matchDxfToDetected`) need to pass ctx. Update these call sites to pass `{ canvasWidth: canvas.width, canvasHeight: canvas.height }`.

- [ ] **Step 3: Update `session.js` import**

Change line 2:
```js
// Before:
import { redraw, canvas, img, showStatus, measurementLabel } from './render.js';
// After:
import { redraw, canvas, img, showStatus } from './render.js';
import { measurementLabel } from './format.js';
```

Update both `measurementLabel` call sites in session.js. There are two: line 115 (in `exportCsv`) and line ~444 (in `exportInspectionPdf` measurements section, added recently). Add a helper at the top of the relevant scope:
```js
const _mctx = () => ({
  calibration: state.calibration,
  annotations: state.annotations,
  origin: state.origin,
  imageWidth, imageHeight,
  canvasWidth: canvas.width,
  canvasHeight: canvas.height,
});
// Then at each call site: measurementLabel(ann, _mctx())
```

- [ ] **Step 4: Update `sidebar.js` import**

Change line 2 and add viewport import:
```js
// Before:
import { redraw, showStatus, getStatus, measurementLabel, listEl, cameraInfoEl } from './render.js';
// After:
import { redraw, showStatus, getStatus, listEl, cameraInfoEl, canvas } from './render.js';
import { measurementLabel } from './format.js';
import { imageWidth, imageHeight } from './viewport.js';
```

Update call sites at lines 12, 24, 170 to pass ctx:
```js
const _mctx = () => ({
  calibration: state.calibration,
  annotations: state.annotations,
  origin: state.origin,
  imageWidth, imageHeight,
  canvasWidth: canvas.width,
  canvasHeight: canvas.height,
});
// Then: measurementLabel(ann, _mctx())
```

- [ ] **Step 5: Manual smoke test**

Open the app in a browser (`http://localhost:8000` or load an image in no-camera mode). Verify:
- Measurement labels display correctly (distance, circle, arc, angle)
- Sidebar shows labels
- PDF export works

- [ ] **Step 6: Commit**

```bash
git add frontend/format.js frontend/render.js frontend/session.js frontend/sidebar.js
git commit -m "refactor: extract measurementLabel into format.js (pure function)"
```

---

### Task 3: Purify viewport transforms

**Files:**
- Modify: `frontend/viewport.js:21-34`

- [ ] **Step 1: Add pure exports to `viewport.js`**

Add `imageToScreenPure` and `screenToImagePure` after the existing functions. Rewrite existing functions as wrappers:

```js
/** Pure version — takes viewport as parameter (for testing) */
export function imageToScreenPure(x, y, vp) {
  return {
    x: (x - vp.panX) * vp.zoom,
    y: (y - vp.panY) * vp.zoom,
  };
}

/** Pure version — takes viewport as parameter (for testing) */
export function screenToImagePure(x, y, vp) {
  return {
    x: x / vp.zoom + vp.panX,
    y: y / vp.zoom + vp.panY,
  };
}

/** Image-space → screen-space (convenience wrapper using module viewport) */
export function imageToScreen(x, y) {
  return imageToScreenPure(x, y, viewport);
}

/** Screen-space → image-space (convenience wrapper using module viewport) */
export function screenToImage(x, y) {
  return screenToImagePure(x, y, viewport);
}
```

- [ ] **Step 2: Run math tests to confirm nothing broke**

Run: `node --test tests/frontend/test_math.js`
Expected: All PASS (viewport changes don't affect math tests, but confirms runner still works)

- [ ] **Step 3: Commit**

```bash
git add frontend/viewport.js
git commit -m "refactor: add pure imageToScreenPure/screenToImagePure exports"
```

---

### Task 4: Update `session.js` to use extracted `formatCsvValue`

`formatCsvValue` was already moved to `format.js` in Task 2. Now update session.js to import and call it.

**Files:**
- Modify: `frontend/session.js`

- [ ] **Step 1: Remove `formatCsvValue` from session.js**

Delete lines 9-83 (the `formatCsvValue` function body).

Add import:
```js
import { formatCsvValue } from './format.js';
```

- [ ] **Step 2: Update the call site**

Line 117 (after deletion, line number will shift) currently: `const { value, unit } = formatCsvValue(ann);`
Change to: `const { value, unit } = formatCsvValue(ann, state.calibration, imageWidth);`

Note: `arc-measure` type returns a raw string, not `{value, unit}`. The existing call site at line 117 is inside a type check that excludes arc-measure, so this is safe.

- [ ] **Step 3: Commit**

```bash
git add frontend/session.js
git commit -m "refactor: use extracted formatCsvValue from format.js"
```

---

### Task 5: Write tests for purified functions

**Files:**
- Create: `tests/frontend/test_viewport.js`
- Create: `tests/frontend/test_measurement.js`
- Create: `tests/frontend/test_csv.js`

- [ ] **Step 1: Write viewport transform tests**

```js
// tests/frontend/test_viewport.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { imageToScreenPure, screenToImagePure } from '../../frontend/viewport.js';

describe('imageToScreenPure', () => {
  it('identity at zoom=1 pan=0', () => {
    const vp = { zoom: 1, panX: 0, panY: 0 };
    const { x, y } = imageToScreenPure(100, 200, vp);
    assert.equal(x, 100);
    assert.equal(y, 200);
  });
  it('applies zoom', () => {
    const vp = { zoom: 2, panX: 0, panY: 0 };
    const { x, y } = imageToScreenPure(50, 50, vp);
    assert.equal(x, 100);
    assert.equal(y, 100);
  });
  it('applies pan', () => {
    const vp = { zoom: 1, panX: 10, panY: 20 };
    const { x, y } = imageToScreenPure(50, 50, vp);
    assert.equal(x, 40);
    assert.equal(y, 30);
  });
  it('applies zoom and pan together', () => {
    const vp = { zoom: 3, panX: 10, panY: 5 };
    const { x, y } = imageToScreenPure(20, 15, vp);
    assert.equal(x, (20 - 10) * 3);
    assert.equal(y, (15 - 5) * 3);
  });
});

describe('screenToImagePure', () => {
  it('identity at zoom=1 pan=0', () => {
    const vp = { zoom: 1, panX: 0, panY: 0 };
    const { x, y } = screenToImagePure(100, 200, vp);
    assert.equal(x, 100);
    assert.equal(y, 200);
  });
  it('inverse of imageToScreen', () => {
    const vp = { zoom: 2.5, panX: 30, panY: -10 };
    const screen = imageToScreenPure(100, 200, vp);
    const back = screenToImagePure(screen.x, screen.y, vp);
    assert.ok(Math.abs(back.x - 100) < 1e-10);
    assert.ok(Math.abs(back.y - 200) < 1e-10);
  });
});
```

- [ ] **Step 2: Run viewport tests**

Run: `node --test tests/frontend/test_viewport.js`
Expected: All PASS

- [ ] **Step 3: Write measurementLabel tests**

```js
// tests/frontend/test_measurement.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { measurementLabel } from '../../frontend/format.js';

// Default context — uncalibrated
const CTX = {
  calibration: null,
  annotations: [],
  origin: null,
  imageWidth: 640,
  imageHeight: 480,
  canvasWidth: 640,
  canvasHeight: 480,
};

// Calibrated context
const CAL_CTX = {
  ...CTX,
  calibration: { pixelsPerMm: 100, displayUnit: 'mm' },
};

const CAL_UM_CTX = {
  ...CTX,
  calibration: { pixelsPerMm: 100, displayUnit: 'µm' },
};

describe('measurementLabel', () => {
  describe('distance', () => {
    const ann = { type: 'distance', a: { x: 0, y: 0 }, b: { x: 300, y: 400 } };
    it('uncalibrated shows px', () => {
      assert.equal(measurementLabel(ann, CTX), '500.0 px');
    });
    it('calibrated mm', () => {
      assert.equal(measurementLabel(ann, CAL_CTX), '5.000 mm');
    });
    it('calibrated µm', () => {
      assert.equal(measurementLabel(ann, CAL_UM_CTX), '5000.00 µm');
    });
  });

  describe('angle', () => {
    it('90 degree angle', () => {
      const ann = {
        type: 'angle',
        vertex: { x: 0, y: 0 },
        p1: { x: 1, y: 0 },
        p3: { x: 0, y: 1 },
      };
      assert.equal(measurementLabel(ann, CTX), '90.00°');
    });
    it('0 degree angle', () => {
      const ann = {
        type: 'angle',
        vertex: { x: 0, y: 0 },
        p1: { x: 1, y: 0 },
        p3: { x: 2, y: 0 },
      };
      assert.equal(measurementLabel(ann, CTX), '0.00°');
    });
  });

  describe('circle', () => {
    const ann = { type: 'circle', cx: 100, cy: 100, r: 50 };
    it('uncalibrated shows diameter px', () => {
      assert.equal(measurementLabel(ann, CTX), '⌀ 100.0 px');
    });
    it('calibrated mm', () => {
      assert.equal(measurementLabel(ann, CAL_CTX), '⌀ 1.000 mm');
    });
  });

  describe('center-dist', () => {
    it('computes distance between two points', () => {
      const ann = { type: 'center-dist', a: { x: 0, y: 0 }, b: { x: 30, y: 40 } };
      assert.equal(measurementLabel(ann, CTX), '50.0 px');
    });
  });

  describe('arc-measure', () => {
    it('shows radius and span', () => {
      const ann = { type: 'arc-measure', r: 100, span_deg: 90 };
      assert.equal(measurementLabel(ann, CTX), 'r 100.0 px  90°');
    });
    it('calibrated mm', () => {
      const ann = { type: 'arc-measure', r: 100, span_deg: 45 };
      assert.equal(measurementLabel(ann, CAL_CTX), 'r 1.000 mm  45°');
    });
  });

  describe('perp-dist', () => {
    it('shows perp symbol', () => {
      const ann = { type: 'perp-dist', a: { x: 0, y: 0 }, b: { x: 0, y: 100 } };
      assert.equal(measurementLabel(ann, CTX), '⊥ 100.0 px');
    });
  });

  describe('para-dist', () => {
    it('shows parallel symbol', () => {
      const ann = { type: 'para-dist', a: { x: 0, y: 0 }, b: { x: 0, y: 50 } };
      assert.equal(measurementLabel(ann, CTX), '∥ 50.0 px');
    });
  });

  describe('area', () => {
    it('computes polygon area', () => {
      const ann = {
        type: 'area',
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      };
      assert.equal(measurementLabel(ann, CTX), '□ 100.0 px²');
    });
  });

  describe('calibration', () => {
    it('line calibration', () => {
      const ann = { type: 'calibration', x1: 0, y1: 0, x2: 100, y2: 0, knownValue: 1, unit: 'mm' };
      assert.equal(measurementLabel(ann, CTX), '⟷ 1 mm');
    });
    it('circle calibration', () => {
      const ann = { type: 'calibration', knownValue: 5, unit: 'mm' };
      assert.equal(measurementLabel(ann, CTX), '⌀ 5 mm');
    });
  });

  describe('origin', () => {
    it('returns empty string', () => {
      assert.equal(measurementLabel({ type: 'origin' }, CTX), '');
    });
  });

  describe('parallelism', () => {
    it('shows angle', () => {
      const ann = { type: 'parallelism', angleDeg: 1.5 };
      assert.equal(measurementLabel(ann, CTX), '∥ 1.50°');
    });
  });

  describe('detected-circle', () => {
    it('scales by frame ratio', () => {
      const ann = { type: 'detected-circle', x: 100, y: 100, radius: 25, frameWidth: 320, frameHeight: 240 };
      // imageWidth=640, frameWidth=320 → sx=2, scaled radius=50, diameter=100
      assert.equal(measurementLabel(ann, CTX), '⌀ 100.0 px');
    });
  });

  describe('detected-line', () => {
    it('scales length by frame ratio', () => {
      const ann = { type: 'detected-line', x1: 0, y1: 0, x2: 100, y2: 0, length: 100, frameWidth: 640, frameHeight: 480 };
      // imageWidth=640, frameWidth=640 → sx=1
      assert.equal(measurementLabel(ann, CTX), '100.0 px');
    });
  });

  describe('pt-circle-dist with referenced circle', () => {
    it('computes gap', () => {
      const circle = { id: 10, type: 'circle', cx: 0, cy: 0, r: 50 };
      const ann = { type: 'pt-circle-dist', px: 100, py: 0, circleId: 10 };
      const ctx = { ...CTX, annotations: [circle] };
      // dist = 100, gap = 100 - 50 = 50
      assert.equal(measurementLabel(ann, ctx), '⊙ 50.0 px');
    });
    it('returns ref deleted when circle missing', () => {
      const ann = { type: 'pt-circle-dist', px: 100, py: 0, circleId: 999 };
      assert.equal(measurementLabel(ann, CTX), '⊙ ref deleted');
    });
  });

  describe('slot-dist with referenced lines', () => {
    it('computes perpendicular gap', () => {
      const lineA = { id: 1, type: 'distance', a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
      const lineB = { id: 2, type: 'distance', a: { x: 0, y: 50 }, b: { x: 100, y: 50 } };
      const ann = { type: 'slot-dist', lineAId: 1, lineBId: 2 };
      const ctx = { ...CTX, annotations: [lineA, lineB] };
      assert.equal(measurementLabel(ann, ctx), '⟺ 50.0 px');
    });
  });

  describe('unknown type', () => {
    it('returns empty string', () => {
      assert.equal(measurementLabel({ type: 'nonexistent' }, CTX), '');
    });
  });
});
```

- [ ] **Step 4: Run measurement tests**

Run: `node --test tests/frontend/test_measurement.js`
Expected: All PASS

- [ ] **Step 5: Write CSV format tests**

`formatCsvValue` was already extracted to `format.js` in Task 2, so we can import directly:

```js
// tests/frontend/test_csv.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatCsvValue } from '../../frontend/format.js';

const CAL = { pixelsPerMm: 100, displayUnit: 'mm' };

describe('formatCsvValue', () => {
  it('distance calibrated', () => {
    const ann = { type: 'distance', a: { x: 0, y: 0 }, b: { x: 300, y: 400 } };
    const r = formatCsvValue(ann, CAL, 640);
    assert.equal(r.value, '5.000');
    assert.equal(r.unit, 'mm');
  });
  it('distance uncalibrated', () => {
    const ann = { type: 'distance', a: { x: 0, y: 0 }, b: { x: 300, y: 400 } };
    const r = formatCsvValue(ann, null, 640);
    assert.equal(r.value, '500.0');
    assert.equal(r.unit, 'px');
  });
  it('angle', () => {
    const ann = { type: 'angle', vertex: { x: 0, y: 0 }, p1: { x: 1, y: 0 }, p3: { x: 0, y: 1 } };
    const r = formatCsvValue(ann, null, 640);
    assert.equal(r.value, '90.00');
    assert.equal(r.unit, '°');
  });
  it('circle calibrated', () => {
    const ann = { type: 'circle', r: 50 };
    const r = formatCsvValue(ann, CAL, 640);
    assert.equal(r.value, '1.000');
    assert.equal(r.unit, 'mm');
  });
  it('detected-circle scales by imageWidth', () => {
    const ann = { type: 'detected-circle', radius: 25, frameWidth: 320 };
    const r = formatCsvValue(ann, CAL, 640);
    // sx = 640/320 = 2, scaled r = 50, diameter = 100, mm = 1.0
    assert.equal(r.value, '1.000');
  });
  it('arc-measure returns a string (not {value, unit})', () => {
    const ann = { type: 'arc-measure', r: 50, cx: 100, cy: 100, span_deg: 90, chord_px: 70.7 };
    const r = formatCsvValue(ann, { pixelsPerMm: 100, displayUnit: 'mm' }, 640);
    // NOTE: arc-measure is the one type that returns a raw string instead of {value, unit}
    assert.equal(typeof r, 'string');
    assert.ok(r.includes('r='));
    assert.ok(r.includes('span'));
  });
  it('unknown type returns empty', () => {
    const r = formatCsvValue({ type: 'nonexistent' }, null, 640);
    assert.equal(r.value, '');
  });
});
```

- [ ] **Step 6: Run all frontend tests**

Run: `node --test tests/frontend/`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add tests/frontend/test_viewport.js tests/frontend/test_measurement.js tests/frontend/test_csv.js frontend/format.js frontend/session.js
git commit -m "test: add viewport, measurementLabel, and CSV format tests"
```

**Note:** The spec lists `test_session_roundtrip.js` (serialize → deserialize → compare state). This is deferred because `session.js` imports from `render.js` which requires DOM globals (`document.getElementById`). A round-trip test would require either DOM stubs or extracting the serialization logic into a pure module. This can be added after the render.js split (Task 7), when session.js no longer transitively imports DOM globals.

---

### Task 6: Split `main.js` → event modules

**Files:**
- Create: `frontend/events-mouse.js`, `frontend/events-keyboard.js`, `frontend/events-context-menu.js`, `frontend/events-inspection.js`, `frontend/events-dxf.js`
- Modify: `frontend/main.js` (reduce to ~150 lines)

This is the largest split. The approach:

1. Identify section boundaries using the `// ──` markers in main.js
2. Move each section into its target file as an exported `init*()` function
3. `main.js` imports and calls each init function

- [ ] **Step 1: Create `events-context-menu.js`**

Move from `main.js`:
- Lines 18-45: `ctxMenu`, `showContextMenu`, `hideContextMenu`
- The context menu construction logic from `onMouseDown` (the right-click branch)
- Context menu item handlers

Export: `initContextMenu()` that wires up the DOM refs and returns `{ showContextMenu, hideContextMenu }`.

- [ ] **Step 2: Create `events-keyboard.js`**

Move from `main.js`:
- Lines 1055-1145: keyboard event handler (`document.addEventListener("keydown", ...)`)
- Lines 47-76: undo/redo functions

Export: `initKeyboard()` that registers the keydown listener.

- [ ] **Step 3: Create `events-inspection.js`**

Move from `main.js`:
- Lines 309-587: `_hitTestGuidedResult`, `_entityEndpoints`, `_findConnectedEntities`, `_annotationPrimaryPoint`, `_nearestSegmentDist`, `_updatePickFit`
- Point-pick click handling, label drag, tooltip show/hide logic

Export: `initInspection()` and individual helpers needed by mouse handlers.

- [ ] **Step 4: Create `events-mouse.js`**

Move from `main.js`:
- Lines 102-308: `onMouseDown` (except context menu branch)
- Lines 391-431: `onMouseUp`
- Lines 588-1017: `onMouseMove`
- Lines 1018-1053: scroll-wheel zoom

Export: `initMouseHandlers()` that registers canvas mousedown/mousemove/mouseup/wheel.

- [ ] **Step 5: Create `events-dxf.js`**

The DXF-specific event handling is interleaved with mouse events. Extract:
- DXF align mode click handling
- DXF drag-to-translate
- DXF entity right-click

Export helpers called by the mouse handler.

- [ ] **Step 6: Reduce `main.js` to init/wiring**

`main.js` becomes:
- Imports from all event modules
- Imports from existing modules (dxf, detect, session, sidebar, etc.)
- Lines 1147-1715: button wiring, dropdown setup, resize observer, init calls
- Calls `initMouseHandlers()`, `initKeyboard()`, `initContextMenu()`, etc.

- [ ] **Step 7: Run frontend tests**

Run: `node --test tests/frontend/`
Expected: All PASS (tests only cover pure functions, not DOM event handlers)

- [ ] **Step 8: Manual smoke test**

Open the app, verify:
- All mouse interactions work (click, drag, select, pan, zoom)
- Context menu works
- Keyboard shortcuts work
- Point-pick mode works
- DXF align mode works

- [ ] **Step 9: Commit**

```bash
git add frontend/events-*.js frontend/main.js
git commit -m "refactor: split main.js into focused event handler modules"
```

---

### Task 7: Split `render.js` → render modules + split `tools.js`

**Files:**
- Create: `frontend/render-annotations.js`, `frontend/render-dxf.js`, `frontend/render-hud.js`
- Create: `frontend/hit-test.js`
- Modify: `frontend/render.js` (reduce to ~150 lines)
- Modify: `frontend/tools.js` (reduce to ~400 lines)

- [ ] **Step 1: Create `render-annotations.js`**

Move all `draw*` functions for individual annotation types:
- `drawDistance`, `drawAngle`, `drawCircle`, `drawArcMeasure`
- `drawDetectedCircle`, `drawDetectedLine`, `drawCalibration`
- `drawPerpDist`, `drawParaDist`, `drawParallelism`
- `drawPtCircleDist`, `drawIntersect`, `drawSlotDist`
- `drawArea`, `drawAreaPreview`, `drawOrigin`
- `drawLine`, `drawHandle`, `drawLabel`, `drawMeasurementLabel`
- `_annColor`
- `drawAnnotations` (the dispatcher)

Export all draw functions + `drawAnnotations`.

- [ ] **Step 2: Create `render-dxf.js`**

Move:
- `drawDxfOverlay`, `dxfToCanvas`
- `drawGuidedResults`, `_deviationColor`, `_drawFeatureNumber`
- `drawDeviations`, `matchDxfToDetected`
- `drawEdgesOverlay`, `drawPreprocessedOverlay`
- `deviationColor`

Export all.

- [ ] **Step 3: Create `render-hud.js`**

Move:
- `drawMinimap` (lines 458-517)
- `drawGrid` (lines 271-325)
- `drawPendingPoints`, `drawCrosshair` (lines 1343-1362)

Export all.

- [ ] **Step 4: Reduce `render.js` to orchestrator**

`render.js` keeps:
- DOM refs (`canvas`, `ctx`, `img`, `statusEl`, etc.)
- `showStatus`, `getStatus`
- `resizeCanvas`
- `redraw()` — imports and calls sub-renderers
- `pw()` helper
- Re-exports for backward compatibility

- [ ] **Step 5: Create `hit-test.js` from `tools.js`**

Move from `tools.js`:
- `hitTestAnnotation` function and all its per-type proximity checks
- `hitTestDxfEntity` function

Export both. `tools.js` imports them.

- [ ] **Step 6: Run frontend tests**

Run: `node --test tests/frontend/`
Expected: All PASS

- [ ] **Step 7: Manual smoke test**

Open the app, verify:
- All annotation types render correctly
- DXF overlay renders
- Guided results render with correct coloring
- Minimap, grid, crosshair work
- Hit-testing works (click on annotations, DXF entities)

- [ ] **Step 8: Commit**

```bash
git add frontend/render.js frontend/render-annotations.js frontend/render-dxf.js frontend/render-hud.js frontend/hit-test.js frontend/tools.js
git commit -m "refactor: split render.js and tools.js into focused modules"
```

---

### Task 8: Split `api.py` → sub-routers

**Files:**
- Create: `backend/api_camera.py`, `backend/api_detection.py`, `backend/api_inspection.py`
- Modify: `backend/api.py`

- [ ] **Step 1: Create `backend/api_camera.py`**

Move from `make_router()` in `api.py`:
- `/stream`, `/freeze`, `/frame`, `/snapshot`, `/load-image`, `/snapshots`, `/load-snapshot`
- `/camera/startup-warning`, `/camera/info`, `/camera/exposure`, `/camera/gain`, `/camera/pixel-format`
- `/camera/white-balance/*`, `/cameras`, `/camera/select`

Create a `make_camera_router(camera, frame_store, startup_warning)` function that returns an `APIRouter`.

- [ ] **Step 2: Create `backend/api_detection.py`**

Move from `make_router()`:
- `/detect-edges`, `/detect-circles`, `/detect-lines`, `/detect-lines-merged`, `/detect-arcs-partial`
- `/preprocessed-view`
- `/match-dxf-lines`, `/match-dxf-arcs`

Create a `make_detection_router(frame_store)` function.

- [ ] **Step 3: Create `backend/api_inspection.py`**

Move from `make_router()`:
- `/align-dxf-edges`, `/inspect-guided`, `/fit-feature`, `/load-dxf`

Move from module-level `router`:
- `/align-dxf`, `/export-dxf`

Create a `make_inspection_router(frame_store)` function for frame-dependent routes, and a plain `inspection_router = APIRouter()` for the frame-independent ones.

- [ ] **Step 4: Reduce `api.py` to composition**

`api.py` keeps:
- Module-level `router` with `/config/ui` and `/config/tolerances`
- `make_router()` becomes:

```python
def make_router(camera, frame_store, startup_warning=None):
    router = APIRouter()
    router.include_router(make_camera_router(camera, frame_store, startup_warning))
    router.include_router(make_detection_router(frame_store))
    router.include_router(make_inspection_router(frame_store))
    return router
```

- Pydantic models stay in `api.py` (or extract to `api_models.py` if preferred)

- [ ] **Step 5: Run backend tests**

Run: `python3 -m pytest tests/ -v`
Expected: All existing tests PASS (endpoints unchanged, just moved between files)

- [ ] **Step 6: Commit**

```bash
git add backend/api.py backend/api_camera.py backend/api_detection.py backend/api_inspection.py
git commit -m "refactor: split api.py into camera, detection, and inspection sub-routers"
```

---

## Final Verification

After all 8 tasks:

```bash
node --test tests/frontend/    # all frontend tests pass
python3 -m pytest tests/ -v    # all backend tests pass
```

Open the app and verify full functionality: measurements, detection, DXF load/align/inspect, PDF export, session save/load.

### File size targets
| File | Before | After |
|------|--------|-------|
| `main.js` | 1714 | ~150 |
| `render.js` | 1585 | ~150 |
| `tools.js` | 821 | ~400 |
| `api.py` | 585 | ~100 |
| Largest new file | — | ~500 |
