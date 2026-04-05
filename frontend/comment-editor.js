// ── Comment annotation inline text editor ────────────────────────────────
// Creates a floating <textarea> over the canvas for placing or editing a
// comment annotation. Used by the Comment tool and by double-click on an
// existing comment.

import { state, pushUndo } from './state.js';
import { canvas, redraw } from './render.js';
import { renderSidebar } from './sidebar.js';
import { addAnnotation } from './annotations.js';
import { imageToScreen } from './viewport.js';
import { setTool } from './tools.js';

let _activeEditor = null;  // { el, commit, cancel }

/**
 * Open the inline comment editor.
 *  - If `existing` is null, commit creates a new annotation at `pt` (image coords).
 *  - If `existing` is a comment annotation, commit updates its text in place.
 * Pressing Escape cancels (no new annotation, no edit of existing).
 */
export function openCommentEditor(pt, existing) {
  // Close any already-open editor first (commits it).
  if (_activeEditor) _activeEditor.commit();

  const viewer = document.getElementById("viewer");
  if (!viewer) return;

  const ta = document.createElement("textarea");
  ta.className = "comment-editor";
  ta.rows = 3;
  ta.placeholder = "Note…";
  if (existing) ta.value = existing.text || "";

  // Position: convert image coords → canvas screen coords → viewer coords.
  _positionEditor(ta, pt.x, pt.y);

  viewer.appendChild(ta);

  let committed = false;
  let cancelled = false;

  const cleanup = () => {
    ta.removeEventListener("blur", onBlur);
    ta.removeEventListener("keydown", onKey);
    if (ta.parentNode) ta.parentNode.removeChild(ta);
    _activeEditor = null;
  };

  const commit = () => {
    if (committed || cancelled) return;
    committed = true;
    const text = ta.value.trim();
    if (existing) {
      if (text.length > 0 && text !== existing.text) {
        pushUndo();
        existing.text = text;
      }
      // Empty text on edit-commit → leave unchanged (delete via Delete key).
    } else {
      if (text.length > 0) {
        addAnnotation({
          type: "comment",
          x: pt.x,
          y: pt.y,
          text,
          labelOffset: { dx: 0, dy: 0 },
        });
      }
      // Return to select tool after placing.
      setTool("select");
    }
    cleanup();
    renderSidebar();
    redraw();
  };

  const cancel = () => {
    if (committed || cancelled) return;
    cancelled = true;
    cleanup();
    if (!existing) setTool("select");
    redraw();
  };

  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      commit();
    }
  };
  const onBlur = () => { commit(); };

  ta.addEventListener("keydown", onKey);
  // Defer focus + blur listener until after the current mousedown finishes,
  // otherwise the browser's default click handling immediately moves focus
  // away and the blur handler commits an empty note, removing the editor.
  requestAnimationFrame(() => {
    ta.focus();
    if (existing) ta.select();
    ta.addEventListener("blur", onBlur);
  });

  _activeEditor = { el: ta, commit, cancel };
}

/** Is an inline comment editor currently open? */
export function isCommentEditorOpen() { return _activeEditor !== null; }

/** Force-commit any open editor (e.g. on pan/zoom). */
export function commitCommentEditor() {
  if (_activeEditor) _activeEditor.commit();
}

function _positionEditor(ta, imgX, imgY) {
  // Convert image coords → canvas pixel coords → viewer-relative CSS coords.
  const screenPt = imageToScreen(imgX, imgY);  // canvas pixel space
  const canvasRect = canvas.getBoundingClientRect();
  const viewer = document.getElementById("viewer");
  const viewerRect = viewer.getBoundingClientRect();
  // Canvas pixel → CSS px on canvas
  const cssX = (screenPt.x / canvas.width) * canvasRect.width;
  const cssY = (screenPt.y / canvas.height) * canvasRect.height;
  // Canvas origin relative to viewer
  const left = (canvasRect.left - viewerRect.left) + cssX + 8;
  const top  = (canvasRect.top  - viewerRect.top)  + cssY - 8;
  ta.style.left = `${Math.round(left)}px`;
  ta.style.top  = `${Math.round(top)}px`;
}
