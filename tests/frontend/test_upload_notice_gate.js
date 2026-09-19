import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerElement } from './dom-stub.js';
import { state } from '../../frontend/state.js';
import { apiFetch } from '../../frontend/api.js';

test('image bytes wait for disclosure acknowledgment before fetch', async () => {
  let acknowledge;
  const dialog = {hidden:true};
  registerElement('upload-notice-dialog', dialog);
  registerElement('btn-upload-notice-ok', {addEventListener: (name,fn) => {acknowledge=fn;}});
  state._hosted=true;
  const calls=[];
  globalThis.fetch=async (...args)=>{calls.push(args); return new Response('{}');};
  const pending=apiFetch('/load-image',{method:'POST',body:'image bytes'});
  await Promise.resolve();
  assert.equal(dialog.hidden,false);
  assert.equal(calls.length,0);
  acknowledge();
  await pending;
  assert.equal(calls.length,1);
  assert.equal(dialog.hidden,true);
  state._hosted=false;
});
