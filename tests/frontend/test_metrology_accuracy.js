import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cacheImageData, clearImageCache, refinePointJS, serverSubpixelMethod } from '../../frontend/subpixel-js.js';
import { fitCircleRobust, calibrationPixelsPerMm } from '../../frontend/math.js';

// Exercise the same image-cache entry point as the browser, with a minimal
// canvas adapter supplying analytically rendered pixels.
globalThis.OffscreenCanvas = class {
  getContext() {
    let image;
    return { drawImage(img) { image = img; }, getImageData() { return image; } };
  }
};
afterEach(clearImageCache);

function erf(x) {
  const sign = Math.sign(x), t = 1 / (1 + 0.3275911 * Math.abs(x));
  return sign * (1 - (((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x));
}

function cacheSynthetic(width, height, value) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
    const i = (y*width+x)*4, v = Math.round(value(x,y));
    data[i]=data[i+1]=data[i+2]=v; data[i+3]=255;
  }
  cacheImageData({data},width,height);
}

test('browser snap localizes ridges across phase, blur, angle, and cursor offset', () => {
  for (const sigma of [0.8,1.5,2.5]) for (const phase of [0.13,0.37,0.81]) for (const angle of [0,15,45]) {
    const nx=Math.cos(angle*Math.PI/180), ny=Math.sin(angle*Math.PI/180), cx=64+phase, cy=48;
    cacheSynthetic(128,96,(x,y) => 127.5*(1+erf(((x-cx)*nx+(y-cy)*ny)/(Math.SQRT2*sigma))));
    for (let offset=-6; offset<=6; offset+=0.5) {
      const result = refinePointJS(cx+offset*nx,cy+offset*ny,10,'parabola-js');
      assert.ok(result);
      const error=Math.abs((result.x-cx)*nx+(result.y-cy)*ny);
      assert.ok(error < (angle === 0 ? 0.05 : 0.15), `sigma=${sigma}, angle=${angle}, error=${error}`);
    }
  }
});

test('browser snap selects a nearby weaker edge and supports Gaussian peaks', () => {
  cacheSynthetic(128,96,x => 60*(1+erf((x-50.37)/Math.SQRT2))/2+180*(1+erf((x-58.81)/Math.SQRT2))/2);
  for (const method of ['parabola-js','gaussian-js']) {
    const point=refinePointJS(49,48,12,method);
    assert.ok(point && Math.abs(point.x-50.37)<0.05);
  }
});

test('browser snap declines blank images, absent caches, and outside searches', () => {
  assert.equal(refinePointJS(10,10,10,'parabola-js'),null);
  cacheSynthetic(64,64,() => 128);
  for (const xy of [[32,32],[-100,-100],[1,1],[NaN,32]]) {
    assert.equal(refinePointJS(...xy,10,'parabola-js'),null);
  }
});

test('calibration uses the snapped two-edge distance', () => {
  cacheSynthetic(200,96,x => 127.5*(erf((x-40.37)/(Math.SQRT2*2.5))-erf((x-140.81)/(Math.SQRT2*2.5))));
  for (const offset of [-6,0,6]) {
    const a=refinePointJS(40.37+offset,48,10,'parabola-js');
    const b=refinePointJS(140.81-offset,48,10,'parabola-js');
    assert.ok(a && b);
    const ppm=calibrationPixelsPerMm({x1:a.x,y1:a.y,x2:b.x,y2:b.y,knownValue:1,unit:'mm'});
    assert.ok(Math.abs(ppm-100.44)<0.1, `calibration=${ppm}`);
  }
});

test('browser-only method settings retain refinement for server geometry', () => {
  assert.equal(serverSubpixelMethod('parabola-js'),'parabola');
  assert.equal(serverSubpixelMethod('gaussian-js'),'gaussian');
  assert.equal(serverSubpixelMethod('none'),'none');
});

function random(seed) {
  return () => { seed=(Math.imul(seed,1664525)+1013904223)>>>0; return (seed+0.5)/4294967296; };
}
function normal(rng) { return Math.sqrt(-2*Math.log(rng()))*Math.cos(2*Math.PI*rng()); }

test('browser geometric fit removes short-arc mean bias', () => {
  for (const span of [30,60,90,360]) {
    const rng=random(19), errors=[];
    for (let trial=0; trial<24; trial++) {
      const points=Array.from({length:500},(_,i) => {
        const angle=i/499*span*Math.PI/180;
        return {x:320.37+100*Math.cos(angle)+0.2*normal(rng),y:240.81+100*Math.sin(angle)+0.2*normal(rng)};
      });
      const fit=fitCircleRobust(points);
      assert.ok(fit, `span=${span}`);
      errors.push(fit.r-100);
    }
    const bias=errors.reduce((sum,e) => sum+e,0)/errors.length;
    assert.ok(Math.abs(bias)<0.15, `span=${span}, bias=${bias}`);
  }
});

test('browser geometric fit resists sparse outliers and reports quality', () => {
  const rng=random(31);
  const points=Array.from({length:200},(_,i) => {
    const a=i/199*Math.PI/2, r=80+(i%20===0 ? 8 : 0.1*normal(rng));
    return {x:1e6+r*Math.cos(a),y:-1e6+r*Math.sin(a)};
  });
  const fit=fitCircleRobust(points);
  assert.ok(fit);
  assert.ok(Math.hypot(fit.cx-1e6,fit.cy+1e6)<0.3);
  assert.ok(Math.abs(fit.r-80)<0.3);
  assert.ok(fit.fit_quality.inlier_count<points.length);
  assert.ok(fit.fit_quality.rms_px<0.2);
  assert.ok(fit.fit_quality.parameter_std_error_px.every(Number.isFinite));
});

test('browser fit rejects nonfinite, coincident, and unconstrained points', () => {
  assert.equal(fitCircleRobust([{x:NaN,y:0},{x:1,y:0},{x:0,y:1}]),null);
  assert.equal(fitCircleRobust(Array(5).fill({x:3,y:4})),null);
  const short=Array.from({length:50},(_,i) => ({x:100*Math.cos(i/49*Math.PI/180),y:100*Math.sin(i/49*Math.PI/180)}));
  assert.equal(fitCircleRobust(short),null);
});

// ── S3: snap gate rescaled for the 5x5 Sobel ────────────────────────────────
import fs from 'node:fs';
import { SNAP_MIN_MAGNITUDE } from '../../frontend/subpixel-js.js';

function seededNormal(seed) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

test('snap gate constant is 240 (5 grey levels on the 5x5 Sobel)', () => {
  assert.equal(SNAP_MIN_MAGNITUDE, 240);
});

test('flat 128-grey patch with sigma=1 noise never snaps over a 140-click sweep', () => {
  const n = seededNormal(12345);
  let snaps = 0, clicks = 0;
  for (let patch = 0; patch < 14; patch++) {
    cacheSynthetic(64, 64, () => 128 + n());
    for (let k = 0; k < 10; k++, clicks++) {
      const x = 24 + (k * 7) % 17, y = 24 + (k * 5 + patch) % 17;
      for (const m of ['parabola-js', 'gaussian-js']) {
        const r = refinePointJS(x, y, 10, m);
        if (r && r.magnitude > SNAP_MIN_MAGNITUDE) snaps++;
      }
    }
  }
  assert.equal(clicks, 140);
  assert.equal(snaps, 0);
});

test('a 6-grey-level step still snaps; a 4-grey-level step does not', () => {
  const step = h => cacheSynthetic(64, 64, (x) => (x < 32 ? 100 : 100 + h));
  step(6);
  const hit = refinePointJS(30, 32, 10, 'parabola-js');
  assert.ok(hit && hit.magnitude > SNAP_MIN_MAGNITUDE, 'expected a snap');
  assert.ok(Math.abs(hit.x - 31.5) < 0.2, `x=${hit.x}`);
  step(4);
  const miss = refinePointJS(30, 32, 10, 'parabola-js');
  assert.ok(!miss || miss.magnitude <= SNAP_MIN_MAGNITUDE);
});

test('all three snap call sites use the shared constant, not a literal 20', () => {
  for (const f of ['subpixel-js.js', 'events-mouse.js', 'tools.js']) {
    const src = fs.readFileSync(new URL(`../../frontend/${f}`, import.meta.url), 'utf8');
    assert.match(src, /SNAP_MIN_MAGNITUDE/, f);
    assert.doesNotMatch(src, /(mag|magnitude)\s*[<>]=?\s*20\b/, f);
  }
});
