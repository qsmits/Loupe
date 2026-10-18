import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { imageDimensions, planUpload, bytesToBase64, mimeFromBase64 } from '../../frontend/fringe-upload.js';

function png(w, h) {
  const u = new Uint8Array(33);
  u.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(u.buffer);
  dv.setUint32(16, w); dv.setUint32(20, h);
  return u;
}
function jpeg(w, h, sof = 0xc0) {
  const app1 = [0xff, 0xe1, 0x00, 0x08, 1, 2, 3, 4, 5, 6];
  const dqt = [0xff, 0xdb, 0x00, 0x04, 0, 0];
  const s = [0xff, sof, 0x00, 0x11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app1, ...dqt, ...s]);
}

describe('imageDimensions', () => {
  it('reads PNG', () => assert.deepEqual(imageDimensions(png(8064, 6048)), { width: 8064, height: 6048 }));
  it('reads JPEG SOF0 after APP1', () => assert.deepEqual(imageDimensions(jpeg(8064, 6048)), { width: 8064, height: 6048 }));
  it('reads progressive SOF2', () => assert.deepEqual(imageDimensions(jpeg(3000, 2000, 0xc2)), { width: 3000, height: 2000 }));
  it('null for garbage and truncated', () => {
    assert.equal(imageDimensions(new Uint8Array([1, 2, 3, 4, 5, 6])), null);
    assert.equal(imageDimensions(new Uint8Array(0)), null);
    assert.equal(imageDimensions(png(10, 10).subarray(0, 20)), null);
    assert.equal(imageDimensions(jpeg(10, 10).subarray(0, 25)), null);
    assert.equal(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2])), null);
  });
});

describe('planUpload', () => {
  it('null when small', () => assert.equal(planUpload({ width: 2048, height: 1536, type: 'image/png', size: 1000 }), null));
  it('scales landscape', () => {
    const p = planUpload({ width: 8064, height: 6048, type: 'image/jpeg', size: 20e6 });
    assert.equal(p.width, 2048); assert.equal(p.height, 1536);
    assert.equal(p.mime, 'image/jpeg'); assert.equal(p.quality, 0.95);
  });
  it('scales portrait', () => {
    const p = planUpload({ width: 3000, height: 6000, type: 'image/png', size: 1000 });
    assert.equal(p.width, 1024); assert.equal(p.height, 2048);
  });
  it('png for png/tiff', () => {
    for (const type of ['image/png', 'image/tiff']) {
      const p = planUpload({ width: 4000, height: 3000, type, size: 1 });
      assert.equal(p.mime, 'image/png'); assert.equal(p.quality, undefined);
    }
  });
  it('re-encodes at scale 1 when too many bytes', () => {
    const p = planUpload({ width: 2000, height: 1000, type: 'image/jpeg', size: 30 * 1024 * 1024 });
    assert.equal(p.width, 2000); assert.equal(p.height, 1000);
  });
});

describe('base64 helpers', () => {
  it('bytesToBase64 matches Buffer', () => {
    const u = new Uint8Array(20000);
    for (let i = 0; i < u.length; i++) u[i] = Math.floor(Math.random() * 256);
    assert.equal(bytesToBase64(u), Buffer.from(u).toString('base64'));
    assert.equal(bytesToBase64(new Uint8Array(0)), '');
  });
  it('mimeFromBase64', () => {
    assert.equal(mimeFromBase64(bytesToBase64(png(1, 1))), 'image/png');
    assert.equal(mimeFromBase64(bytesToBase64(jpeg(1, 1))), 'image/jpeg');
    assert.equal(mimeFromBase64('AAAA'), 'application/octet-stream');
  });
});
