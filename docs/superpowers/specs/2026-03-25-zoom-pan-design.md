# Phase 1.5 — Zoom & Pan Design Spec

## Problem

The camera captures more resolution than the canvas displays. Annotations in dense
areas are hard to distinguish. There's no way to zoom in for sub-pixel precision
placement or to verify detection results at full resolution.

## Solution

A viewport transform system with scroll-wheel zoom, a Pan tool for navigation,
and keyboard shortcuts for zoom presets. **Zoom/pan only works in frozen mode.**
In live mode, zoom controls are disabled (the MJPEG stream is an HTML `<img>`
element that can't be canvas-transformed).

---

## 1. Viewport Module

**New file: `frontend/viewport.js`**

Owns the zoom/pan state and provides coordinate transforms:

```js
export const viewport = {
  zoom: 1.0,    // scale factor (1.0 = fit-to-window)
  panX: 0,      // image-space X offset of the viewport's top-left corner
  panY: 0,      // image-space Y offset of the viewport's top-left corner
};
```

**Two transform functions:**

```js
// Image-space → screen-space (for rendering)
export function imageToScreen(x, y) {
  return {
    x: (x - viewport.panX) * viewport.zoom,
    y: (y - viewport.panY) * viewport.zoom,
  };
}

// Screen-space → image-space (for mouse events)
export function screenToImage(x, y) {
  return {
    x: x / viewport.zoom + viewport.panX,
    y: y / viewport.zoom + viewport.panY,
  };
}
```

**Image dimensions:** The viewport also tracks the image size (set on freeze or
image load) so zoom and pan can be clamped:

```js
export let imageWidth = 0;
export let imageHeight = 0;
export function setImageSize(w, h) { imageWidth = w; imageHeight = h; }
```

---

## 2. Zoom Interaction

**Scroll wheel** on the canvas zooms in/out:
- Each scroll tick multiplies (up) or divides (down) the zoom by a factor of 1.15
- Zoom is centered on the cursor position: the image point under the cursor stays
  under the cursor after zoom (adjust panX/panY to compensate)
- Zoom range: 0.5x (see more than fits) to 10x
- The zoom-to-cursor math:
  ```
  // pt = image-space point under cursor (before zoom)
  viewport.zoom *= factor;
  viewport.panX = pt.x - screenX / viewport.zoom;
  viewport.panY = pt.y - screenY / viewport.zoom;
  ```

**Keyboard shortcuts:**
- `0` — fit to window (reset zoom so entire image fills canvas, panX/panY = 0)
- `1` — 1:1 pixel mapping (zoom = imageWidth / canvasWidth, centered)

**No smooth/animated zoom** — keep it simple, instant response.

---

## 3. Pan Interaction

**Pan tool:** A new tool `"pan"` activated via the toolbar or keyboard shortcut `H`
(for "hand", matching Photoshop convention). When active:
- Cursor changes to `grab` (and `grabbing` while dragging)
- Left-click-drag pans the viewport: `panX -= dx / zoom`, `panY -= dy / zoom`
- No annotation interaction while Pan tool is active

**Middle-mouse drag** always pans regardless of active tool (standard convention).
Listen for `mousedown` with `e.button === 1`.

**Pan clamping:** Don't allow panning so far that the image is entirely off-screen.
Clamp panX to `[0, imageWidth - canvasWidth/zoom]` (and similar for Y), but allow
some overscroll margin (10% of canvas size) so the user doesn't feel stuck at edges.

---

## 4. Canvas Resolution Strategy

**The core insight:** For zoom to reveal actual detail (not just upscale blurry pixels),
the canvas internal resolution must increase with zoom.

**On `resizeCanvas`:** When zoom changes, update the canvas internal resolution:
```js
canvas.width  = Math.min(imageWidth, Math.round(r.width * viewport.zoom));
canvas.height = Math.min(imageHeight, Math.round(r.height * viewport.zoom));
```
CSS size stays the same (`r.width` x `r.height`). The `canvas.width / r.width` ratio
in `canvasPoint` now equals `viewport.zoom` (capped at image resolution), which is
exactly the DPI scaling factor needed.

**Cap at image resolution:** No point making the canvas larger than the source image.
At zoom levels where `r.width * zoom > imageWidth`, cap at `imageWidth`.

---

## 5. Rendering Changes

### 5.1 The viewport transform

In `redraw()`, wrap all drawing in the viewport transform:

```js
ctx.save();
ctx.scale(viewport.zoom, viewport.zoom);
ctx.translate(-viewport.panX, -viewport.panY);

// Draw frozen background at native image size
if (state.frozenBackground) {
  ctx.drawImage(state.frozenBackground, 0, 0, imageWidth, imageHeight);
}

// Draw all annotations (they store image-space coordinates)
drawAnnotations();
// Draw pending points, snap indicators, arc-fit preview, DXF alignment indicators
// (these all use image-space coordinates from canvasPoint)

ctx.restore();

// Draw HUD elements OUTSIDE the transform (screen-space):
drawCrosshair();  // full-canvas lines, must NOT be viewport-transformed
drawSelectionRect();  // convert coords via imageToScreen() before drawing
drawCoordReadout();
```

### 5.2 Frozen background

Currently drawn as `ctx.drawImage(bg, 0, 0, canvas.width, canvas.height)`.
Change to `ctx.drawImage(bg, 0, 0, imageWidth, imageHeight)` — the viewport
transform handles the scaling.

### 5.3 Frame-scaled annotations

Detected features use `frameWidth/frameHeight` to scale coordinates. Currently:
```js
const sx = canvas.width / ann.frameWidth;
```
Change **everywhere** to:
```js
const sx = imageWidth / ann.frameWidth;
```

This change is needed in **all** locations across the codebase:
- `frontend/render.js` — ~12 occurrences (rendering + measurement labels)
- `frontend/tools.js` — ~5 occurrences (hit-testing)
- `frontend/annotations.js` — ~1 occurrence (elevation)
- `frontend/main.js` — ~3 occurrences (`_annotationPrimaryPoint`)
- `frontend/session.js` — ~1 occurrence (export labels)

All must change to `imageWidth` / `imageHeight` to stay consistent. Since
everything (rendering, hit-testing, mouse events) now works in image-space,
frame-scaled annotations just need to map from frame-space to image-space.

### 5.4 HUD elements (drawn OUTSIDE viewport transform)

Elements that stay fixed on screen regardless of zoom. These are drawn after
`ctx.restore()`:
- **Crosshair** (`drawCrosshair`) — full-canvas lines, screen-space
- **Selection rectangle** — coordinates come from `canvasPoint` (image-space),
  so convert via `imageToScreen()` before drawing
- **Coordinate readout** — screen-fixed text
- **Flash halo** — convert annotation center via `imageToScreen()` before drawing

Alternatively, the selection rectangle and flash halo can be drawn INSIDE the
viewport transform (they use image-space coords). This is simpler — the visual
result is that they zoom/pan with the image, which is actually fine.

**Recommended approach:** Draw selection rect and flash halo inside the viewport
transform. Only crosshair and coord readout go outside.

### 5.5 Label and handle sizes

Labels (`drawLabel`) and handles (`drawHandle`) should stay the same screen size
regardless of zoom — a 5px handle dot should be 5 screen pixels, not 5 image pixels.
Since they're drawn inside the viewport transform, compensate:
```js
const r = 5 / viewport.zoom;  // handle radius in image-space
```
Same for label font size and annotation line widths.

### 5.6 DXF overlay line width

`drawDxfOverlay` compensates stroke width with `ctx.lineWidth = 1 / scale`. With
the viewport transform active, this should be `1 / (scale * viewport.zoom)` to keep
strokes at 1 screen pixel.

### 5.7 Live mode restriction

**Zoom/pan is disabled in live (unfrozen) mode.** The MJPEG stream is an HTML `<img>`
element rendered by the browser — it cannot be affected by canvas transforms. If the
user scrolls the wheel while live, show status: "Freeze frame to enable zoom".
Freeze first, then zoom works.

---

## 6. canvasPoint Change

**This is the keystone change.** Currently in `tools.js`:
```js
export function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
```

Change to:
```js
export function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  const screenX = (e.clientX - r.left) * (canvas.width / r.width);
  const screenY = (e.clientY - r.top) * (canvas.height / r.height);
  return screenToImage(screenX, screenY);
}
```

Note the `canvas.width / r.width` factor — this accounts for CSS scaling of the
canvas element (canvas internal resolution vs. displayed size).

After this change, every tool, hit-test, and snap automatically works in image-space
with no further modifications.

---

## 7. Hit-Test Adjustment

Hit-test thresholds (currently 8px) are in canvas-space. With zoom, an 8px threshold
at 4x zoom means 2 image pixels — too tight. Adjust thresholds by dividing by zoom:

```js
const threshold = 8 / viewport.zoom;
```

This makes clicking easier when zoomed out and more precise when zoomed in.

---

## 8. Pan Tool in Toolbar

Add a "Pan" button to the tool strip (the floating toolbar). Icon: a hand or
a four-directional arrow. Keyboard shortcut: `H`.

Add to `toolKeys` in main.js: `h: "pan"`.

In the mousedown handler, when `state.tool === "pan"`:
- Record start position
- On mousemove: update panX/panY
- On mouseup: clear drag state
- Cursor: `grab` / `grabbing`

---

## 9. Files Changed

| File | Changes |
|------|---------|
| `frontend/viewport.js` | **NEW** — viewport state, imageToScreen, screenToImage, setImageSize, zoom/pan helpers |
| `frontend/tools.js` | Update `canvasPoint` to use `screenToImage`. Change all `canvas.width / ann.frameWidth` to `imageWidth / ann.frameWidth`. Adjust hit-test thresholds by zoom. |
| `frontend/render.js` | Wrap drawing in viewport transform. Move `drawCrosshair` outside transform. Adjust label/handle sizes and DXF lineWidth by zoom. Change all `canvas.width / ann.frameWidth` to `imageWidth`. Update `resizeCanvas` for zoom-dependent resolution. |
| `frontend/main.js` | Add scroll-wheel zoom handler (disabled in live mode). Add middle-mouse pan handler. Add Pan tool mouse handlers. Add `H` to toolKeys. Add `0`/`1` zoom presets. Update `_annotationPrimaryPoint` frame scaling. |
| `frontend/detect.js` | Set `imageWidth/imageHeight` via `setImageSize` on freeze. |
| `frontend/annotations.js` | Change `canvas.width / ann.frameWidth` to `imageWidth / ann.frameWidth` in elevation. |
| `frontend/session.js` | Change `canvas.width / ann.frameWidth` to `imageWidth / ann.frameWidth` in export labels. |
| `frontend/state.js` | No changes — viewport state lives in viewport.js (not undo-able or session-saved). |
| `frontend/index.html` | Add Pan tool button to tool strip. |
| `frontend/style.css` | Cursor styles for pan tool (`cursor: grab` / `cursor: grabbing`). |

---

## 10. What's NOT in Scope

- Minimap (add later if zoom feels disorienting)
- Smooth/animated zoom transitions
- Pinch-to-zoom (touch events)
- Space+drag for pan (using Pan tool instead)
- Saving viewport state in sessions (zoom resets on load)
- Zoom indicator in the UI (can add later as a small "2.0x" badge)
