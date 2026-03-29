/**
 * Tests for frontend/viewport.js transform functions.
 *
 * These tests verify the critical invariants that prevent annotation
 * coordinate shifts during freeze/unfreeze and zoom changes:
 *
 * 1. Round-trip: screenToImage(imageToScreen(pt)) === pt at any zoom/pan
 * 2. fitToWindow keeps the full image visible in the canvas
 * 3. Coordinates are consistent across freeze/unfreeze cycles
 * 4. Camera resolution >> display size works correctly
 *
 * Run with: node --test tests/frontend/test_viewport.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  imageToScreenPure, screenToImagePure,
  viewport, setImageSize, fitToWindow,
  imageToScreen, screenToImage,
  zoomOneToOne, clampPan,
} from '../../frontend/viewport.js';

// ── Pure function tests (no module state) ────────────────────────────────────

describe('imageToScreenPure', () => {
  it('identity at zoom=1, pan=0,0', () => {
    const vp = { zoom: 1, panX: 0, panY: 0 };
    const r = imageToScreenPure(50, 50, vp);
    assert.deepStrictEqual(r, { x: 50, y: 50 });
  });

  it('zoom only (zoom=2, pan=0): (50,50) -> (100,100)', () => {
    const vp = { zoom: 2, panX: 0, panY: 0 };
    const r = imageToScreenPure(50, 50, vp);
    assert.deepStrictEqual(r, { x: 100, y: 100 });
  });

  it('pan only (zoom=1, pan=10,20): (50,50) -> (40,30)', () => {
    const vp = { zoom: 1, panX: 10, panY: 20 };
    const r = imageToScreenPure(50, 50, vp);
    assert.deepStrictEqual(r, { x: 40, y: 30 });
  });

  it('zoom + pan combined', () => {
    const vp = { zoom: 3, panX: 10, panY: 20 };
    // (50-10)*3 = 120, (50-20)*3 = 90
    const r = imageToScreenPure(50, 50, vp);
    assert.deepStrictEqual(r, { x: 120, y: 90 });
  });

  it('fractional zoom (zoom=0.5)', () => {
    const vp = { zoom: 0.5, panX: 0, panY: 0 };
    const r = imageToScreenPure(100, 200, vp);
    assert.deepStrictEqual(r, { x: 50, y: 100 });
  });
});

describe('screenToImagePure', () => {
  it('identity at zoom=1, pan=0,0', () => {
    const vp = { zoom: 1, panX: 0, panY: 0 };
    const r = screenToImagePure(50, 50, vp);
    assert.deepStrictEqual(r, { x: 50, y: 50 });
  });

  it('round-trip with non-trivial zoom/pan', () => {
    const vp = { zoom: 2.5, panX: 17, panY: -33 };
    const orig = { x: 123.456, y: 789.012 };
    const screen = imageToScreenPure(orig.x, orig.y, vp);
    const back = screenToImagePure(screen.x, screen.y, vp);
    assert.ok(Math.abs(back.x - orig.x) < 1e-10, `x: expected ${orig.x}, got ${back.x}`);
    assert.ok(Math.abs(back.y - orig.y) < 1e-10, `y: expected ${orig.y}, got ${back.y}`);
  });
});

// ── Round-trip invariant ─────────────────────────────────────────────────────

describe('round-trip invariant', () => {
  const testCases = [
    { zoom: 1, panX: 0, panY: 0, label: 'identity' },
    { zoom: 0.3, panX: 0, panY: 0, label: 'fit-to-window zoom' },
    { zoom: 5, panX: 100, panY: 200, label: 'zoomed in with pan' },
    { zoom: 0.1, panX: -50, panY: -50, label: 'extreme zoom out' },
    { zoom: 10, panX: 500, panY: 500, label: 'max zoom with large pan' },
  ];

  for (const vp of testCases) {
    it(`image→screen→image at ${vp.label}`, () => {
      const pts = [
        { x: 0, y: 0 }, { x: 1000, y: 0 },
        { x: 0, y: 750 }, { x: 1000, y: 750 },
        { x: 500, y: 375 },
      ];
      for (const pt of pts) {
        const screen = imageToScreenPure(pt.x, pt.y, vp);
        const back = screenToImagePure(screen.x, screen.y, vp);
        assert.ok(Math.abs(back.x - pt.x) < 1e-9, `x mismatch at (${pt.x},${pt.y}): ${back.x}`);
        assert.ok(Math.abs(back.y - pt.y) < 1e-9, `y mismatch at (${pt.x},${pt.y}): ${back.y}`);
      }
    });
  }
});

// ── fitToWindow tests ────────────────────────────────────────────────────────

describe('fitToWindow', () => {
  // Helper: reset viewport module state
  function resetViewport(imgW, imgH) {
    setImageSize(imgW, imgH);
    viewport.zoom = 1;
    viewport.panX = 0;
    viewport.panY = 0;
  }

  it('sets zoom < 1 when image is larger than display', () => {
    resetViewport(2592, 1944);
    fitToWindow(800, 600);
    assert.ok(viewport.zoom < 1, `zoom should be < 1, got ${viewport.zoom}`);
    assert.equal(viewport.panX, 0);
    assert.equal(viewport.panY, 0);
  });

  it('all four image corners map to within canvas bounds', () => {
    resetViewport(2592, 1944);
    fitToWindow(800, 600);
    const corners = [
      { x: 0, y: 0 },
      { x: 2592, y: 0 },
      { x: 0, y: 1944 },
      { x: 2592, y: 1944 },
    ];
    for (const c of corners) {
      const s = imageToScreen(c.x, c.y);
      assert.ok(s.x >= -1 && s.x <= 801, `corner (${c.x},${c.y}) x=${s.x} outside canvas`);
      assert.ok(s.y >= -1 && s.y <= 601, `corner (${c.x},${c.y}) y=${s.y} outside canvas`);
    }
  });

  it('uses the tighter axis (landscape image in landscape display)', () => {
    resetViewport(2000, 1000);  // 2:1 aspect
    fitToWindow(800, 600);      // display is 4:3
    // Width-limited: zoom = 800/2000 = 0.4
    assert.ok(Math.abs(viewport.zoom - 0.4) < 1e-10);
  });

  it('uses the tighter axis (portrait image in landscape display)', () => {
    resetViewport(1000, 2000);  // 1:2 aspect
    fitToWindow(800, 600);      // display is 4:3
    // Height-limited: zoom = 600/2000 = 0.3
    assert.ok(Math.abs(viewport.zoom - 0.3) < 1e-10);
  });

  it('no-op when imageWidth is 0', () => {
    resetViewport(0, 0);
    viewport.zoom = 1;
    fitToWindow(800, 600);
    assert.equal(viewport.zoom, 1, 'zoom should not change when imageWidth=0');
  });
});

// ── Coordinate stability across freeze/unfreeze ──────────────────────────────

describe('coordinate stability (freeze/unfreeze simulation)', () => {
  it('annotation at image center maps to same screen position after fitToWindow', () => {
    // Simulate: camera info sets imageWidth, fitToWindow runs
    setImageSize(2592, 1944);
    fitToWindow(800, 600);
    const zoom1 = viewport.zoom;

    // User places annotation at image center
    const annotationPt = { x: 1296, y: 972 };
    const screenPos1 = imageToScreen(annotationPt.x, annotationPt.y);

    // Simulate freeze: setImageSize called again with same dimensions
    setImageSize(2592, 1944);
    // fitToWindow called again (as in our fix)
    fitToWindow(800, 600);

    const screenPos2 = imageToScreen(annotationPt.x, annotationPt.y);
    assert.ok(Math.abs(screenPos1.x - screenPos2.x) < 1e-9, `x shifted: ${screenPos1.x} → ${screenPos2.x}`);
    assert.ok(Math.abs(screenPos1.y - screenPos2.y) < 1e-9, `y shifted: ${screenPos1.y} → ${screenPos2.y}`);
    assert.equal(viewport.zoom, zoom1, 'zoom should not change');
  });

  it('annotation stays stable when imageWidth is set twice with same value', () => {
    setImageSize(2592, 1944);
    fitToWindow(800, 600);

    const pts = [
      { x: 0, y: 0 }, { x: 2592, y: 1944 }, { x: 500, y: 300 },
    ];
    const before = pts.map(p => imageToScreen(p.x, p.y));

    // Second setImageSize with same value (simulating doFreeze)
    setImageSize(2592, 1944);
    fitToWindow(800, 600);

    const after = pts.map(p => imageToScreen(p.x, p.y));
    for (let i = 0; i < pts.length; i++) {
      assert.ok(Math.abs(before[i].x - after[i].x) < 1e-9, `pt ${i} x shifted`);
      assert.ok(Math.abs(before[i].y - after[i].y) < 1e-9, `pt ${i} y shifted`);
    }
  });

  it('mouse click maps to correct image coordinate at fit-to-window zoom', () => {
    setImageSize(2592, 1944);
    fitToWindow(800, 600);
    // zoom = min(800/2592, 600/1944) = min(0.3086, 0.3086) ≈ 0.3086

    // User clicks at screen center (400, 300)
    const imgPt = screenToImage(400, 300);

    // That image point should render back at screen (400, 300)
    const screenBack = imageToScreen(imgPt.x, imgPt.y);
    assert.ok(Math.abs(screenBack.x - 400) < 1e-9, `x: expected 400, got ${screenBack.x}`);
    assert.ok(Math.abs(screenBack.y - 300) < 1e-9, `y: expected 300, got ${screenBack.y}`);

    // And the image coordinate should be at the center of the camera frame
    assert.ok(Math.abs(imgPt.x - 1296) < 1, `image x: expected ~1296, got ${imgPt.x}`);
    assert.ok(Math.abs(imgPt.y - 972) < 1, `image y: expected ~972, got ${imgPt.y}`);
  });
});

// ── zoomOneToOne ─────────────────────────────────────────────────────────────

describe('zoomOneToOne', () => {
  it('sets zoom to 1.0 and centers the view', () => {
    setImageSize(2592, 1944);
    zoomOneToOne(800, 600);
    assert.equal(viewport.zoom, 1.0);
    // Pan should center: (2592-800)/2 = 896, (1944-600)/2 = 672
    assert.ok(Math.abs(viewport.panX - 896) < 1e-9);
    assert.ok(Math.abs(viewport.panY - 672) < 1e-9);
  });

  it('image center maps to screen center at 1:1', () => {
    setImageSize(2592, 1944);
    zoomOneToOne(800, 600);
    const center = imageToScreen(1296, 972);
    assert.ok(Math.abs(center.x - 400) < 1e-9);
    assert.ok(Math.abs(center.y - 300) < 1e-9);
  });
});

// ── clampPan ─────────────────────────────────────────────────────────────────

describe('clampPan', () => {
  it('does not change pan when image fits in canvas', () => {
    setImageSize(2592, 1944);
    fitToWindow(800, 600);
    const origPanX = viewport.panX;
    const origPanY = viewport.panY;
    clampPan(800, 600);
    assert.equal(viewport.panX, origPanX);
    assert.equal(viewport.panY, origPanY);
  });

  it('clamps extreme pan values', () => {
    setImageSize(2592, 1944);
    viewport.zoom = 2;
    viewport.panX = 9999;
    viewport.panY = 9999;
    clampPan(800, 600);
    assert.ok(viewport.panX < 2592, `panX should be clamped, got ${viewport.panX}`);
    assert.ok(viewport.panY < 1944, `panY should be clamped, got ${viewport.panY}`);
  });
});
