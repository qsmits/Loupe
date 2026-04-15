# Cross-Mode Mask Editing — Design Spec

## Goal

Replace the clunky inline polygon mask drawing in fringe mode with a cross-mode workflow: the user clicks "Edit Mask" in fringe mode, enters microscope mode with the camera preview loaded, draws mask regions using microscope's existing annotation tools (lines, splines, area), then applies them back to fringe mode as analysis apertures. The fringe camera stays live so the user can adjust the optical flat and re-analyze without redoing the mask.

## Current Problems

- Fringe mode's mask drawing is cumbersome: draw one polygon → exit → click "Add Hole" → draw another → exit. No persistent drawing mode.
- The drawing happens in an enlarged overlay with limited tools (just vertex-clicking).
- Microscope mode already has better geometry tools (lines that snap, splines, area, DXF import, right-click context menus, undo/redo) — but they're inaccessible from fringe mode.
- Building equivalent annotation tools in fringe mode would duplicate a large amount of code.

## Architecture

### Cross-Mode State

A shared object `window.crossMode` coordinates the handoff between modes:

```javascript
window.crossMode = {
  source: "fringe",           // which mode initiated the workflow
  imageBlob: Blob,            // captured camera preview frame (JPEG/PNG)
  existingMask: [...],        // current fr.maskPolygons (for round-trip editing)
  callback: (polygons) => {}, // called with extracted mask polygons on Apply
};
```

Set by fringe mode before switching. Cleared on Apply or Cancel.

### User Flow

1. User clicks **"Edit Mask"** in fringe left panel.
2. Fringe mode captures the current camera preview frame via `/freeze` or `/snapshot`.
3. Sets `window.crossMode` with the image, any existing mask polygons, and a callback.
4. Switches to microscope mode.
5. Microscope mode detects `crossMode`, enters mask-edit session:
   - Stashes current microscope state (frozen image, annotations, calibration, undo stack).
   - Loads the fringe preview image as a frozen frame (via the existing `/load-image` path).
   - Converts any `existingMask` polygons back to microscope annotations (so the user can edit previously drawn masks).
   - Shows a floating action bar at top-center of the canvas: label + "Apply Mask" + "Cancel".
   - Hides the mode switcher dropdown.
   - Disables session auto-save.
6. User draws regions using existing tools. Punch = include, Die = exclude.
7. A live mask preview overlay dims excluded areas as the user works.
8. User clicks **"Apply Mask"**:
   - Extracts all closed polygon annotations.
   - Converts pixel coordinates to normalized (0–1) relative to the image.
   - Maps Punch → `include: true`, Die → `include: false`.
   - Calls the `crossMode.callback` with the polygon array.
   - Clears `crossMode`.
   - Restores stashed microscope state.
   - Switches back to fringe mode.
9. Fringe mode receives polygons via callback:
   - Sets `fr.maskPolygons` to the received polygons.
   - Updates the mask overlay on the live camera preview.
   - Auto-triggers `analyzeFromCamera()`.
10. User clicks **"Cancel"**:
    - Discards all mask-edit annotations.
    - Clears `crossMode`.
    - Restores stashed microscope state.
    - Switches back to fringe mode. No mask change.

### Mask Preview Overlay

During the mask-edit session, an additional render pass shows the mask effect on the canvas:

- **No Punch, no Die regions drawn** → no overlay (clean image).
- **No Punch, some Die regions** → Die regions darkened with semi-transparent overlay. Rest stays clear. The whole image is implicitly the aperture; user is just cutting holes.
- **Some Punch regions exist** → everything outside Punch regions is darkened. Die regions within Punch are also darkened.

The overlay uses canvas compositing: fill entire canvas with dark overlay (`rgba(0,0,0,0.5)`), cut out Punch regions with `globalCompositeOperation: 'destination-out'`, then re-darken Die regions.

Updates live as annotations are drawn, toggled (Punch/Die via context menu), or deleted.

### Polygon Extraction

On "Apply Mask", scan microscope annotations for closed shapes:

- **Area annotations** — already closed polygons with vertices.
- **Closed line loops** — sequences of line annotations that form a closed polygon (endpoints snap together).
- **Spline regions** — spline annotations that define closed areas.
- **DXF-derived closed entities** — if the user loaded and aligned a DXF, closed polylines/circles become mask regions.

Each closed shape becomes a mask polygon entry:
- Punch (or untagged) → `{ vertices: [{x, y}, ...], include: true }`
- Die → `{ vertices: [{x, y}, ...], include: false }`

Vertex coordinates converted: `nx = px / imageWidth`, `ny = py / imageHeight`.

### Microscope State Stash/Restore

When entering mask-edit mode, stash:
- `state.frozen`, `state.frozenBackground`, `state.frozenSize`
- `state.annotations` (deep copy)
- `state.calibration`
- `state.undoStack`, `state.redoStack`

On exit (Apply or Cancel), restore all of the above. The mask-edit annotations are ephemeral.

### What's Disabled During Mask-Edit

- Mode switcher dropdown (hidden)
- Session save/load buttons
- Auto-save to localStorage

### What's Enabled During Mask-Edit

- All drawing tools (lines, splines, area, select, pan, etc.)
- Undo/redo (within the mask-edit session)
- Zoom/pan
- Right-click context menu (Punch/Die toggle, delete, group, etc.)
- DXF import and alignment

### Round-Trip Editing

When entering mask-edit mode with existing `fr.maskPolygons`:
- Each polygon is converted to a microscope Area annotation.
- `include: true` polygons are tagged as Punch.
- `include: false` polygons are tagged as Die.
- The user sees their previous mask and can modify it.

### Fringe Mode After Return

- Camera preview stays live (not frozen). User can adjust the optical flat.
- Mask polygons persist on `fr.maskPolygons` across re-analyses.
- The small mask overlay on the preview (`fringe-roi-canvas`) shows the current mask.
- "Freeze & Analyze" captures a fresh frame and applies the persisted mask.
- "Edit Mask" captures a fresh preview frame and re-enters the workflow.

## UI Changes

### Fringe Mode Left Panel

- **"Edit Mask"** button replaces "Draw Mask". Full width, standard `detect-btn` styling.
- **"Clear Mask"** button below it, disabled when no mask is set. Clears `fr.maskPolygons` and the overlay.
- "Add Hole" button removed (holes are drawn in microscope mode).
- Mask hint text removed.
- When a mask is active, show a small label like "Mask: 3 regions" below the button.

### Microscope Mode Action Bar

- Floating bar at top-center of canvas, above all content.
- Background: `var(--surface)` with border, subtle shadow, `border-radius: 8px`.
- Contents: "Defining fringe mask" label, primary "Apply Mask" button, subdued "Cancel" button.
- `z-index` above annotations and overlays but below modals.
- Appears only during mask-edit workflow.

## Files Changed

- `frontend/fringe-panel.js` — Replace mask drawing code with "Edit Mask" button + crossMode setup. Remove enterMaskDrawMode, exitMaskDrawMode, drawEnlargeMaskOverlay, _wireEnlargeContextMenu, _pointInPolygon, _showPolyContextMenu, _drawPolygonsOnCtx. Keep drawMaskOverlay (for the small preview overlay).
- `frontend/cross-mode.js` — New module: crossMode state management, stash/restore microscope state, action bar DOM, polygon extraction + coordinate conversion.
- `frontend/render.js` — Add mask preview overlay render pass (only active during mask-edit session).
- `frontend/modes.js` — Check for `crossMode` on mode switch, prevent mode switching when active.
- `frontend/main.js` — Detect `crossMode` after mode switch, enter mask-edit session, wire action bar buttons.
- `frontend/session.js` — Skip auto-save when `crossMode` is active.
- `frontend/style.css` — Styles for the action bar and mask preview overlay.

## What's NOT Changing

- Fringe analysis algorithm — unchanged.
- Fringe mask polygon format sent to backend — unchanged (`[{vertices, include}]`).
- Backend mask rasterization — unchanged.
- Microscope mode tools and annotations — unchanged (just used in a new context).
- Camera preview stream — stays live, not affected by mask editing.
- Surface map rendering — unchanged.

## What's NOT In Scope

- **Perspective/lens correction** — separate feature. When added later, it applies to the image before both mask editing and analysis, so mask coordinates stay consistent without changes to this workflow.
- **"Open Surface Map in Microscope"** — separate feature (one-way push from fringe results to microscope for measurement).
- **Fringe session save/load** — broader feature, not part of mask editing.
- **Camera calibration procedure** — separate feature for computing lens distortion coefficients.
