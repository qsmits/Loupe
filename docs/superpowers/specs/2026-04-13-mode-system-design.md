# Mode System & Deflectometry Workspace — Design Spec

## Goal

Replace the dialog-over-microscope approach with a mode-based UI where different instruments get their own full-window workspace. The microscope view is one mode; deflectometry is another; fringe analysis is a future third. A dropdown in the top bar switches between them.

## Mode System

### Mode Switcher

A `<select>` dropdown in the top-left of the top bar, positioned before the existing title/controls. Three entries:

- **Microscope** (default) — the current full UI, unchanged.
- **Deflectometry** — full-window deflectometry workspace.
- **Fringe Analysis** — placeholder with "Coming soon" message.

### Switching Behavior

Each mode has a root container element:

- `#mode-microscope` — wraps the existing `#viewer`, `#sidebar`, `#tool-strip`, and all current microscope UI. Internal structure is unchanged; the container div is just added around it.
- `#mode-deflectometry` — the new deflectometry workspace.
- `#mode-fringe` — placeholder.

Selecting a mode hides the current mode's container and shows the new one. CSS `display:none` / `display:flex`.

### Top Bar Behavior Per Mode

The top bar itself persists across all modes. Some items are shared, some are mode-specific:

**Always visible (all modes):**
- Mode switcher dropdown (top-left)
- Camera selector (includes exposure controls)
- Freeze button
- Settings (top-right, fixed position)
- Help (top-right, fixed position, next to Settings)

**Microscope-only (hidden in other modes):**
- Detect dropdown
- Overlay dropdown
- Clear dropdown
- Mode buttons (Stitch, SR, 3D, Gear, Surface, Deflect, 4-up)
- Tool strip (floating at bottom)
- Sidebar

Items are shown/hidden based on the active mode. The mode switcher dispatches a custom event or calls a function that each module can listen to for show/hide.

### State Isolation

Each mode manages its own state independently. Switching modes does not destroy state — a deflectometry session persists if you switch to microscope and back. No cross-mode state dependencies.

## Deflectometry Workspace

### Layout: Three Columns

The workspace fills the area below the top bar with a three-column flex layout:

```
┌──────────────────────────────────────────────────────────────┐
│ [Mode ▾]  [Camera ▾]  [Freeze]  [Settings]       top bar    │
├────────────┬──────────────┬──────────────────────────────────┤
│            │              │                                  │
│  Camera    │  Workflow    │  Results                         │
│  Preview   │  Steps       │  [Phase Maps] [3D] [Diagnostics]│
│            │              │                                  │
│  ───────   │  1. Connect  │  ┌─────────┐ ┌─────────┐        │
│  Status    │  2. Flat Fld │  │ Phase X │ │ Phase Y │        │
│  badges    │  3. Ref      │  │         │ │         │        │
│            │  4. Capture  │  ├─────────┤ ├─────────┤        │
│  ───────   │  5. Compute  │  │ Stats   │ │ Stats   │        │
│  Settings  │  6. Calibr.  │  └─────────┘ └─────────┘        │
│  (freq,    │              │                                  │
│   mask,    │  [Reset]     │                                  │
│   display) │              │                                  │
│            │              │                                  │
├────────────┴──────────────┴──────────────────────────────────┤
```

### Left Column: Camera Preview & Settings (~250px, fixed)

**Camera preview:**
- Live camera feed rendered at thumbnail size, maintaining aspect ratio.
- Same MJPEG stream as the microscope view, just displayed smaller.

**Status badges** (below preview):
- iPad: connected / disconnected
- Flat field: ✓ / —
- Reference: ✓ / —
- Calibration: ✓ / —

Stacked vertically, same visual style as the current status badges.

**Settings** (below badges):
- Display device dropdown (iPad Air 1, iPad Air 2, iPad Pro, Custom)
- Custom pixel pitch input (shown only when "Custom" selected)
- Fringe frequency input (cycles)
- Mask threshold slider (0–20%)

These settings persist across workflow resets and mode switches.

### Center Column: Workflow Steps (~280px, fixed)

Vertical checklist of steps, worked top to bottom. Each step is a row with:

- **Status indicator**: gray circle (not started) → green checkmark (done) → red indicator (error)
- **Step name**
- **Action button** (where applicable)
- **Brief status text** (e.g., "8 frames captured", "Factor: 0.0042 µm/rad")

Steps:

1. **Connect iPad** — no action button (auto-connect). Shows "connected" or "waiting…".
2. **Flat Field** — button: "Capture". Prerequisite: iPad connected.
3. **Capture Reference** — button: "Capture". Prerequisite: iPad connected. Optional (can be skipped).
4. **Capture Part** — button: "Capture". Prerequisite: iPad connected.
5. **Compute** — button: "Compute". Prerequisite: part captured (8 frames). Could auto-trigger after capture.
6. **Calibrate** — sphere diameter input + "Calibrate" button. Prerequisite: compute done + camera calibration (px/mm) set. Optional.

Steps that aren't ready are visually grayed out with disabled buttons. Steps that are done show a green checkmark.

**Reset button** at the bottom: clears capture data (frames + results). Preserves flat field, reference, and calibration — same behavior as current reset.

### Right Column: Results (flex: 1)

Three tabs across the top of this column:

**Phase Maps** (default tab):
- X and Y phase map images side by side.
- PV/RMS/Mean stats below each image.
- Stats display in rad by default, µm when calibrated.

**3D Surface**:
- Embedded Three.js viewer (replaces the current fullscreen modal).
- Z exaggeration slider.
- Fills the available space in the column.

**Diagnostics**:
- Frame stats table.
- Modulation maps (X/Y) with min/max/mean/median stats.
- Wrapped and unwrapped phase maps.

When no results are available: empty state with message "Complete the workflow to see results."

## iPad Centering Pattern

### What

When the deflectometry mode is active and the iPad is idle (connected but no capture in progress), the iPad displays concentric white circles on a black background. This provides a bullseye reflection visible in the camera preview for centering the part.

### Circle Design

- White circles on black background (high contrast for specular reflection).
- Rings evenly spaced based on screen pixel dimensions: spacing = `min(width, height) / 12`, giving roughly 5–6 visible rings.
- Small filled dot or crosshair at the center as the bullseye target.
- Rendered client-side on the iPad page using canvas arc calls.

### When Shown

- iPad connected + no capture in progress → centering circles.
- Capture sequence starts → backend takes over with fringe patterns.
- Capture sequence finishes → backend sends `centering` command, iPad returns to circles.

### Implementation

New command type `centering` added to the iPad WebSocket protocol. The backend sends it:
- Immediately after a WebSocket connection is established (auto-connect).
- After any capture sequence completes (capture-sequence, capture-reference, flat-field).

The iPad page handles `{type: "centering"}` by drawing the ring pattern. No parameters needed — the iPad uses its own screen dimensions.

## Fringe Analysis Placeholder

- Appears in the mode switcher dropdown as "Fringe Analysis".
- When selected, shows a centered message: "Fringe Analysis — coming soon" on a dark background.
- No layout skeleton, no shared abstraction. Build standalone when ready.

## Migration from Current Dialog

The existing `deflectometry.js` dialog (the `dialog-overlay` that pops up over the microscope view) is replaced by the new workspace. Specifically:

- The `#btn-deflectometry` button in the top bar is removed (it was in the microscope-mode button row).
- `deflectometry.js` is rewritten to build and manage the workspace layout instead of a dialog overlay.
- The `initDeflectometry()` function is still called from `main.js` but now it builds the workspace container inside `#mode-deflectometry` instead of appending a dialog to `document.body`.
- All backend API endpoints remain unchanged.
- The 3D surface modal CSS (`deflectometry-3d-*` styles) is replaced by inline-in-tab styling.

## What Does NOT Change

- Microscope mode internal structure — every existing feature, event handler, DOM element works as-is.
- Backend API — no endpoint changes.
- `deflectometry-screen.html` (iPad page) — extended with the `centering` command type, otherwise unchanged.
- Camera stream — the same MJPEG endpoint is used by both the microscope canvas and the deflectometry preview.
- Session state on the backend — the deflectometry router and session model are unchanged.
