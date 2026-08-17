/**
 * E2E regressions for the 2026-08-17 user bug batch.
 *
 * Requires:
 *   - HOSTED=1 NO_CAMERA=1 server on 127.0.0.1:8123 (HOSTED makes /camera/info
 *     report the 640x480 NullCamera stub, which is what caused the corruption)
 *   - a 1400x900 fixture PNG at SAMPLE_PNG (default /tmp/loupe-e2e/sample.png;
 *     the exact command to generate it is printed if it is missing)
 *   - playwright-core installed OUTSIDE the repo (never vendored here, never
 *     in a package.json). It is resolved from the CWD, not from this file's
 *     directory — a static `import 'playwright-core'` could not be, because
 *     ESM bare-specifier resolution walks up from the importing file.
 *
 * Setup + run:
 *   mkdir -p /tmp/loupe-e2e && cd /tmp/loupe-e2e && npm init -y && npm i playwright-core
 *   .venv/bin/python -c "
 *   import numpy as np, cv2
 *   img = np.full((900,1400,3), 235, np.uint8)
 *   cv2.rectangle(img,(300,200),(1100,700),(60,60,60),3)
 *   cv2.circle(img,(700,450),180,(90,90,90),3)
 *   cv2.imwrite('/tmp/loupe-e2e/sample.png', img)"
 *   cd /tmp/loupe-e2e && node /abs/path/to/repo/tests/e2e/bug-batch-2026-08-17.mjs
 *
 * Exits non-zero if any check fails.
 *
 * Also covers calibration (Tasks 6-7): calibrating from a distance
 * measurement, calibrating from an area measurement (pinning the
 * sqrt(px-area / mm-area) relation so a missing/extra square root regresses
 * loudly), and context-menu gating of "Use as calibration…" (absent for
 * dimensionless measurements like angle, absent when 2+ annotations are
 * selected).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const EXEC = process.env.CHROMIUM_PATH ||
  '/Users/qsmits/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/' +
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const APP = 'http://127.0.0.1:8123/';
const SAMPLE = process.env.SAMPLE_PNG || '/tmp/loupe-e2e/sample.png';

function die(msg) { console.error(msg); process.exit(1); }

// Resolve playwright-core from the CWD (see the header): the repo has no
// node_modules and must not grow one.
let chromium;
try {
  chromium = createRequire(pathToFileURL(process.cwd() + '/').href)('playwright-core').chromium;
} catch {
  die(`playwright-core is not installed in ${process.cwd()} — install it outside the repo and run from there:\n` +
      `  mkdir -p /tmp/loupe-e2e && cd /tmp/loupe-e2e && npm init -y && npm i playwright-core\n` +
      `  cd /tmp/loupe-e2e && node ${process.argv[1]}`);
}

let SAMPLE_BASE64;
try {
  SAMPLE_BASE64 = readFileSync(SAMPLE).toString('base64');
} catch {
  die(`fixture not found at ${SAMPLE} — generate it first (or point SAMPLE_PNG elsewhere):\n` +
      `  .venv/bin/python -c "\n` +
      `import numpy as np, cv2\n` +
      `img = np.full((900,1400,3), 235, np.uint8)\n` +
      `cv2.rectangle(img,(300,200),(1100,700),(60,60,60),3)\n` +
      `cv2.circle(img,(700,450),180,(90,90,90),3)\n` +
      `cv2.imwrite('${SAMPLE}', img)"`);
}

const browser = await chromium.launch({ executablePath: EXEC, headless: true });
const failures = [];

/** Fresh browser context with a microscopy project and the fixture loaded. */
async function session() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForSelector('.home-type-card');
  await page.locator('.home-type-card').first().click();
  await page.waitForTimeout(400);
  await page.setInputFiles('#file-input', SAMPLE);
  await page.waitForTimeout(1200);
  // CSP blocks addScriptTag with inline content; dynamic import is allowed.
  await page.evaluate(async () => {
    const s = await import('/state.js');
    const v = await import('/viewport.js');
    window.__state = s.state;
    window.__vp = v.viewport;
    window.__iw = () => v.imageWidth;
    window.__ih = () => v.imageHeight;
  });
  return { ctx, page, errors };
}

const readGeom = (page) => page.evaluate(() => ({
  iw: window.__iw(), ih: window.__ih(), zoom: window.__vp.zoom,
}));

async function check(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL  ${name}\n      ${e.message}`); }
}

// ── Task 1: the Camera menu must not touch image geometry ───────────────────
await check('camera menu leaves image geometry untouched', async () => {
  const { ctx, page } = await session();
  const before = await readGeom(page);
  assert.equal(before.iw, 1400, 'fixture loaded at its own size');
  await page.locator('#btn-menu-camera').click({ force: true });
  await page.waitForTimeout(1500);
  await page.locator('#btn-menu-camera').click({ force: true });
  await page.waitForTimeout(500);
  const after = await readGeom(page);
  assert.deepStrictEqual(after, before,
    `geometry changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  await ctx.close();
});

// ── Task 5: paste into an occupied tab opens a new tab ──────────────────────
await check('paste into an occupied tab opens a new tab', async () => {
  const { ctx, page } = await session();
  await page.keyboard.press('d');
  await page.locator('#overlay-canvas').click({ position: { x: 300, y: 250 } });
  await page.locator('#overlay-canvas').click({ position: { x: 800, y: 550 } });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__state.annotations.length), 1,
    'measurement was placed');
  // Count tabs through the app's own API — DOM class names in the Preact tab
  // strip are an implementation detail and would make this test brittle.
  const countTabs = () => page.evaluate(async () =>
    (await import('/tab-manager.js')).getTabs().length);
  const tabsBefore = await countTabs();

  // Build the File in-page from raw base64 (no network fetch of a data: URL —
  // the app's CSP connect-src doesn't allow it, and the real paste handler
  // never fetches anyway: it reads clipboardData.items[].getAsFile() directly).
  await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'pasted.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, SAMPLE_BASE64);
  await page.waitForTimeout(2500);

  const tabsAfter = await countTabs();
  assert.ok(tabsAfter > tabsBefore, `expected a new tab (${tabsBefore} -> ${tabsAfter})`);
  assert.equal(await page.evaluate(() => window.__state.annotations.length), 0,
    'the new tab starts with no measurements from the old image');
  await ctx.close();
});

// ── Task 4: the loupe stays visible while dragging ──────────────────────────
await check('loupe stays visible while dragging a measurement', async () => {
  const { ctx, page } = await session();
  await page.keyboard.press('d');
  await page.locator('#overlay-canvas').click({ position: { x: 300, y: 250 } });
  await page.locator('#overlay-canvas').click({ position: { x: 700, y: 500 } });
  await page.keyboard.press('v');
  const box = await page.locator('#overlay-canvas').boundingBox();
  await page.mouse.move(box.x + 300, box.y + 250);
  await page.mouse.down();
  await page.mouse.move(box.x + 340, box.y + 290, { steps: 6 });
  const hidden = await page.locator('#loupe-canvas').getAttribute('hidden');
  await page.mouse.up();
  assert.equal(hidden, null, 'loupe was hidden mid-drag');
  await ctx.close();
});

// ── Tasks 6-7: calibrate from a distance measurement ─────────────────────────
await check('calibrate from a distance measurement', async () => {
  const { ctx, page } = await session();
  page.once('dialog', d => d.accept('2 mm'));
  await page.keyboard.press('d');
  await page.locator('#overlay-canvas').click({ position: { x: 300, y: 250 } });
  await page.locator('#overlay-canvas').click({ position: { x: 700, y: 500 } });
  await page.waitForTimeout(200);
  // addAnnotation auto-selects the new annotation — no extra click needed.
  const sel = await page.evaluate(() => [...window.__state.selected]);
  assert.equal(sel.length, 1, 'the new distance measurement is auto-selected');

  const calBefore = await page.evaluate(() => window.__state.calibration);
  assert.equal(calBefore, null, 'not calibrated yet');

  await page.locator('#overlay-canvas').click({ position: { x: 1000, y: 700 }, button: 'right' });
  await page.waitForTimeout(150);
  const useCal = page.locator('#context-menu .ctx-item', { hasText: 'Use as calibration' });
  assert.equal(await useCal.count(), 1, '"Use as calibration…" present for a single distance selection');
  await useCal.click();
  await page.waitForTimeout(200);

  const calAfter = await page.evaluate(() => window.__state.calibration);
  assert.notEqual(calAfter, null, 'state.calibration was set');
  assert.ok(calAfter.pixelsPerMm > 0, 'pixelsPerMm is a positive number');

  const badge = await page.evaluate(() => {
    const el = document.getElementById('cal-badge');
    return { calibrated: el.classList.contains('calibrated'), uncalibrated: el.classList.contains('uncalibrated'), text: el.textContent };
  });
  assert.equal(badge.calibrated, true, 'cal-badge carries the "calibrated" class');
  assert.equal(badge.uncalibrated, false, 'cal-badge no longer carries "uncalibrated"');
  assert.doesNotMatch(badge.text, /NOT CALIBRATED/, 'badge text no longer reads NOT CALIBRATED');
  await ctx.close();
});

// ── Tasks 6-7: calibrate from an area measurement — pin the sqrt relation ───
await check('calibrate from an area measurement uses sqrt(px-area / mm-area)', async () => {
  const { ctx, page } = await session();
  page.once('dialog', d => d.accept('25 mm²'));
  await page.keyboard.press('r');
  const pts = [{ x: 300, y: 200 }, { x: 600, y: 200 }, { x: 600, y: 450 }, { x: 300, y: 450 }];
  for (const p of pts) {
    await page.locator('#overlay-canvas').click({ position: p });
  }
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);

  const areaAnn = await page.evaluate(() => {
    const a = window.__state.annotations.find(x => x.type === 'area');
    return a ? { points: a.points, selected: window.__state.selected.has(a.id) } : null;
  });
  assert.ok(areaAnn, 'an area annotation was created');
  assert.equal(areaAnn.points.length, 4, 'polygon has the 4 clicked vertices');
  assert.equal(areaAnn.selected, true, 'addAnnotation auto-selected the new area');

  // True pixel area of the polygon, computed independently in this script
  // (shoelace formula) from the raw points the app stored — NOT by calling
  // back into the app's own math helpers.
  const A = (() => {
    const p = areaAnn.points;
    let s = 0;
    for (let i = 0; i < p.length; i++) {
      const j = (i + 1) % p.length;
      s += p[i].x * p[j].y - p[j].x * p[i].y;
    }
    return Math.abs(s) / 2;
  })();
  assert.ok(A > 1000, `sanity: polygon area should be substantial, got ${A}`);

  await page.locator('#overlay-canvas').click({ position: { x: 1000, y: 700 }, button: 'right' });
  await page.waitForTimeout(150);
  const useCal = page.locator('#context-menu .ctx-item', { hasText: 'Use as calibration' });
  assert.equal(await useCal.count(), 1, '"Use as calibration…" present for a single area selection');
  await useCal.click();
  await page.waitForTimeout(200);

  const ppm = await page.evaluate(() => window.__state.calibration?.pixelsPerMm);
  assert.ok(Number.isFinite(ppm) && ppm > 0, `pixelsPerMm should be a positive finite number, got ${ppm}`);

  const knownMm2 = 25;
  assert.ok(Math.abs(ppm - Math.sqrt(A / knownMm2)) < 1e-6,
    `ppm should equal sqrt(A/knownMm2): ppm=${ppm} sqrt(A/25)=${Math.sqrt(A / knownMm2)}`);
  // This is what catches a missing/extra square root: the non-sqrt ratio
  // must be a clearly different number from ppm.
  assert.ok(Math.abs(ppm - A / knownMm2) > 1e-6,
    `ppm should NOT equal the un-rooted ratio A/knownMm2 (that would mean the sqrt is missing): ppm=${ppm} A/25=${A / knownMm2}`);
  await ctx.close();
});

// ── Tasks 6-7: "Use as calibration…" menu gating ─────────────────────────────
await check('menu gating: "Use as calibration…" absent for an angle measurement', async () => {
  const { ctx, page } = await session();
  await page.evaluate(() => { window.__state.angleMode = 'three-points'; });
  await page.keyboard.press('a');
  const p1 = { x: 300, y: 250 }, vertex = { x: 500, y: 250 }, p3 = { x: 500, y: 450 };
  for (const p of [p1, vertex, p3]) {
    await page.locator('#overlay-canvas').click({ position: p });
  }
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => {
    const a = window.__state.annotations.find(x => x.type === 'angle');
    return { found: !!a, selectedCount: window.__state.selected.size };
  });
  assert.equal(info.found, true, 'an angle annotation was created');
  assert.equal(info.selectedCount, 1, 'exactly one annotation (the angle) is selected');

  await page.locator('#overlay-canvas').click({ position: { x: 1000, y: 700 }, button: 'right' });
  await page.waitForTimeout(150);
  const items = await page.locator('#context-menu .ctx-item').count();
  assert.ok(items > 0, 'the context menu actually opened with some items');
  const useCal = await page.locator('#context-menu .ctx-item', { hasText: 'Use as calibration' }).count();
  assert.equal(useCal, 0, '"Use as calibration…" must not appear for a dimensionless angle measurement');
  await ctx.close();
});

await check('menu gating: "Use as calibration…" absent when two annotations are selected', async () => {
  const { ctx, page } = await session();
  await page.keyboard.press('d');
  const a1 = [{ x: 300, y: 250 }, { x: 500, y: 250 }];
  const a2 = [{ x: 300, y: 600 }, { x: 500, y: 600 }];
  for (const p of a1) await page.locator('#overlay-canvas').click({ position: p });
  for (const p of a2) await page.locator('#overlay-canvas').click({ position: p });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__state.annotations.filter(a => a.type === 'distance').length), 2,
    'two distance measurements were placed');

  await page.keyboard.press('v');
  const mid1 = { x: (a1[0].x + a1[1].x) / 2, y: (a1[0].y + a1[1].y) / 2 };
  await page.locator('#overlay-canvas').click({ position: mid1, modifiers: ['Shift'] });
  await page.waitForTimeout(100);
  const selCount = await page.evaluate(() => window.__state.selected.size);
  assert.equal(selCount, 2, 'both distance measurements are selected');

  await page.locator('#overlay-canvas').click({ position: { x: 1000, y: 700 }, button: 'right' });
  await page.waitForTimeout(150);
  const items = await page.locator('#context-menu .ctx-item').count();
  assert.ok(items > 0, 'the context menu actually opened with some items');
  const useCal = await page.locator('#context-menu .ctx-item', { hasText: 'Use as calibration' }).count();
  assert.equal(useCal, 0, '"Use as calibration…" must not appear when 2+ annotations are selected');
  await ctx.close();
});

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAll e2e checks passed.');
