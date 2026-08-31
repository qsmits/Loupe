// tests/frontend/test_keyboard_modal.js — the document-level keydown handler
// (events-keyboard.js) exercised through a real dispatched "keydown" event
// (dom-stub's document.dispatchEvent just calls every registered listener
// for the event's type — see dom-stub.js), not a hand-simulated copy of its
// logic. Covers:
//   - Finding I6(b): once the Measure… palette is open, it must own all
//     keyboard input except Escape — a Delete/letter keydown whose focus
//     has slipped off the palette's search input must not reach the tool
//     shortcuts/mutating actions behind the overlay. Escape must still
//     close the palette, and 'm' must still open it when the palette is NOT
//     open (regression guard for the reordering the fix required).
//   - Finding I8: Ctrl-Z popping the last accumulated relation-fit point
//     must also drop pendingRelationFit back to pick mode, so the next
//     click on an existing circle/line PICKS instead of silently
//     accumulating as another fit point.
//
// document.activeElement is undefined in dom-stub.js (a faithful DOM isn't
// the goal there) but the handler's very first non-"?" branch dereferences
// it (`document.activeElement.closest(...)`) unconditionally — patched once
// here, module-scope, before initKeyboard() ever runs.
import './dom-stub.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

document.activeElement = { closest: () => null };

import { state } from '../../frontend/state.js';
import { setTool, handleToolClick } from '../../frontend/tools.js';
import { addAnnotation } from '../../frontend/annotations.js';
import { initKeyboard } from '../../frontend/events-keyboard.js';
import { openPalette, closePalette } from '../../frontend/palette.js';

// Registered exactly once for the whole file — initKeyboard() itself has no
// teardown, and calling it again per-test would stack duplicate listeners
// that each fire on every dispatched keydown.
initKeyboard(() => {});

function keydown(props) {
  document.dispatchEvent({ type: 'keydown', key: '', ctrlKey: false, metaKey: false,
                           shiftKey: false, altKey: false, preventDefault() {}, ...props });
}

beforeEach(() => {
  state.annotations = [];
  state.selected = new Set();
  state.nextId = 1;
  state.frozen = false;
  state.calibration = null;
  state.pendingPoints = []; state.pendingRefLine = null;
  state.pendingCenterCircle = null; state.pendingCircleRef = null;
  state.pendingRelationFit = null;
  state.paletteOpen = false;
  state.paletteQuery = '';
});

describe('palette modality (Finding I6b)', () => {
  it('a Delete keydown while the palette is open does not delete the selection', () => {
    const ann = addAnnotation({ type: 'distance', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
    state.selected = new Set([ann.id]);
    openPalette();
    keydown({ key: 'Delete' });
    assert.ok(state.annotations.some(a => a.id === ann.id), 'annotation must survive — Delete must not leak behind the palette overlay');
    closePalette();
  });

  it('Escape still closes the palette even with the modality bail in place', () => {
    openPalette();
    assert.equal(state.paletteOpen, true);
    keydown({ key: 'Escape' });
    assert.equal(state.paletteOpen, false, 'Escape must close the palette');
  });

  it('"m" still opens the palette when it is NOT already open (no regression from the reorder)', () => {
    assert.equal(state.paletteOpen, false);
    keydown({ key: 'm' });
    assert.equal(state.paletteOpen, true, '"m" must still arm the palette when closed');
    closePalette();
  });

  it('a tool-switch letter while the palette is open does not change state.tool', () => {
    setTool('select');
    openPalette();
    keydown({ key: 'o' }); // circle tool shortcut
    assert.equal(state.tool, 'select', 'tool shortcuts must not leak behind the palette overlay');
    closePalette();
  });
});

describe('Ctrl-Z to zero fit points (Finding I8)', () => {
  it('accumulate 1 point, Ctrl-Z, then click an existing circle → it PICKS (does not accumulate)', async () => {
    const c1 = addAnnotation({ type: 'circle', cx: 100, cy: 100, r: 30 });
    setTool('center-dist');
    await handleToolClick({ x: 500, y: 500 });   // miss — arms pendingRelationFit, 1 point
    assert.equal(state.pendingRelationFit?.kind, 'circle');
    assert.equal(state.pendingPoints.length, 1);

    keydown({ key: 'z', ctrlKey: true });        // real Ctrl-Z through the document handler

    assert.equal(state.pendingPoints.length, 0, 'the only accumulated point was popped');
    assert.equal(state.pendingRelationFit, null, 'pendingRelationFit dropped back to pick mode');

    await handleToolClick({ x: 130, y: 100 });   // click c1's edge
    assert.equal(state.pendingCenterCircle?.id, c1.id, 'the click PICKED c1 instead of accumulating a fit point');
    assert.equal(state.annotations.filter(a => a.type === 'center-dist').length, 0);
  });
});
