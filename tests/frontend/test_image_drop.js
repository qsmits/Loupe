import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindImageDropTargets } from '../../frontend/image-drop.js';

class Target extends EventTarget {
  classList = {
    values: new Set(),
    add(value) { this.values.add(value); },
    remove(value) { this.values.delete(value); },
    contains(value) { return this.values.has(value); },
  };
}
function fire(target, type, types = ['Files'], files = []) {
  const event = new Event(type, { cancelable: true });
  event.dataTransfer = { types, files };
  target.dispatchEvent(event);
  return event;
}
function setup() {
  const targets = [new Target(), new Target(), new Target()];
  const root = new Target();
  const images = [], invalid = [];
  bindImageDropTargets(targets, f => images.push(f), () => invalid.push(true), root);
  return { targets, root, images, invalid };
}
const active = target => target.classList.contains('fringe-drop-active');

test('each image view accepts an image once and advertises a copy operation', () => {
  const { targets, images } = setup();
  const image = { name: 'fringes.png', type: 'image/png' };
  for (const target of targets) {
    fire(target, 'dragenter');
    const over = fire(target, 'dragover');
    assert.equal(over.defaultPrevented, true);
    assert.equal(over.dataTransfer.dropEffect, 'copy');
    assert.equal(active(target), true);
    assert.equal(fire(target, 'drop', ['Files'], [image]).defaultPrevented, true);
    assert.equal(active(target), false);
  }
  assert.deepEqual(images, [image, image, image]);
});

test('crossing nested canvas/toolbar children keeps feedback until the view is left', () => {
  const { targets: [target] } = setup();
  fire(target, 'dragenter');
  fire(target, 'dragenter');
  fire(target, 'dragleave');
  assert.equal(active(target), true);
  fire(target, 'dragleave');
  assert.equal(active(target), false);
});

test('text and link drags leave normal gestures untouched', () => {
  const { targets: [target], images } = setup();
  for (const type of ['dragenter', 'dragover', 'drop']) {
    assert.equal(fire(target, type, ['text/uri-list']).defaultPrevented, false);
  }
  assert.equal(active(target), false);
  assert.deepEqual(images, []);
});

test('project files remain with project import; unsupported files give feedback', () => {
  const { targets: [target], images, invalid } = setup();
  assert.equal(fire(target, 'drop', ['Files'], [{ name: 'saved.LOUPE', type: '' }]).defaultPrevented, false);
  assert.equal(fire(target, 'drop', ['Files'], [{ name: 'notes.txt', type: 'text/plain' }]).defaultPrevented, true);
  assert.deepEqual(images, []);
  assert.equal(invalid.length, 1);
});

test('cancelled drags and drops consumed by project import clear all feedback', () => {
  const { targets, root } = setup();
  for (const end of ['dragend', 'drop']) {
    targets.forEach(t => fire(t, 'dragenter'));
    fire(root, end);
    assert.equal(targets.some(active), false);
  }
});
