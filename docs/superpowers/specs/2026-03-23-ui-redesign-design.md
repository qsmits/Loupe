# UI Redesign Design

## Goal

Replace the dense single-row toolbar and cluttered sidebar with a cleaner layout: a minimal top menu bar with dropdown menus, a floating tool strip over the viewer, a tidier right sidebar, and a macOS-native dark visual style. Add a persistent calibration status button and a configurable app name and color theme.

**Tech Stack:** Vanilla JS, HTML5, CSS custom properties. Python/FastAPI backend (minor config additions only).

---

## Layout & Structure

### Top Bar

Replaces the current toolbar entirely.

**Left side:**
- App title (configurable, default `"Microscope"`) — plain text, not a button
- Vertical divider
- `Measure ▾` menu button
- `Detect ▾` menu button
- `Overlay ▾` menu button

**Right side:**
- `❄ Live` / `❄ Frozen` toggle button (blue when live, muted when frozen)
- `📁` Load image button
- `💾` Save session button
- `⚙` Settings button

No other buttons in the top bar. The snapshot button (`📷`) is removed from the top bar; raw snapshot is accessible via a keyboard shortcut or omitted (it is already hidden in no-camera mode).

### Dropdown Menus

All three menus open on click, close on click-outside or Escape.

**`Measure ▾`** — vertical list of tool items (clicking selects the tool and closes the menu):
- Distance, Angle, Circle, Fit Arc, Center Dist, Para, Perp, Area, Pt-Circle, Intersect, Slot

Calibrate is **not** in this menu (see Calibration Button below).

**`Detect ▾`** — inline panel (not a simple list). Contains all detection controls previously in the sidebar:
- Edge Detection: Low / High Canny sliders + "Run edge detect" + "Show preprocessed" buttons
- Circle Detection: Sensitivity / Min r / Max r sliders + "Run circle detect" button
- Line Detection: Sensitivity / Min length sliders + "Run line detect" button

The panel is wider than a standard menu (~280px) to fit the slider controls. Clicking a run button fires detection and closes the panel. Adjusting a slider does **not** close the panel.

**`Overlay ▾`** — vertical list of actions:
- Load DXF
- Export annotated image
- Export CSV
- Toggle crosshair (with current state indicated)
- Set origin (activates origin placement mode)

### Floating Tool Strip

Horizontally centered, pinned to the bottom of the `#viewer` area. Always visible (not hidden when frozen).

**Always-visible tools:** Select | Distance | Angle | Circle | Fit Arc | `···`

The active tool is highlighted with the blue accent. All keyboard shortcuts (V, D, A, O, F, etc.) continue to work unchanged.

**`···` overflow popup:** Opens a small panel above the strip listing the 7 less-frequently-used tools in a 2-row grid: Cdist, Para, Perp, Area, PtCirc, Isect, Slot. Clicking a tool selects it and closes the popup. The popup closes on click-outside or Escape.

### Right Sidebar

Three sections from top to bottom:

1. **Measurements** (always open, fills available space, scrollable)
   - Each row: editable name on the left, measurement value in blue on the right
   - Delete button appears on hover
   - No change to underlying data model

2. **Camera** (collapsible, expanded by default; hidden in no-camera mode via `body.no-camera`)
   - Exposure slider + Gain slider, same as current

3. **Bottom status bar** — single row pinned to the bottom of the sidebar:
   - Left: `● Live` / `● Frozen` status text
   - Right: **Calibration button** (see below)

### Calibration Button

Persistent pill button in the sidebar status bar.

- **Uncalibrated state:** orange background, text `NOT CALIBRATED`. Clicking activates the Calibrate tool immediately (same as pressing C).
- **Calibrated state:** green background, shows the scale e.g. `0.42 µm/px`. Clicking re-activates the Calibrate tool to redo calibration.
- Updates whenever calibration state changes (on calibration commit or on clear-all).

### Settings Dialog

Gains a **General** tab (first tab, shown by default):
- App name field (reads/writes `config.json` `"app_name"`)
- Theme selector (reads/writes `config.json` `"theme"`)

Existing Camera and Display tabs remain unchanged. The Detection panel is removed from the sidebar — its controls are now in `Detect ▾`. There is no existing Detection tab in Settings; none is added.

---

## Visual Design

### Color Palette — `macos-dark` theme

| Variable | Value | Usage |
|---|---|---|
| `--bg` | `#141414` | Page background |
| `--surface` | `#1c1c1e` | Top bar, sidebar, dialog backgrounds |
| `--surface-2` | `#2c2c2e` | Cards, control backgrounds, buttons |
| `--border` | `#3a3a3c` | Dividers, borders |
| `--text` | `#e8e8e8` | Primary text |
| `--text-secondary` | `#ababab` | Labels, secondary text |
| `--muted` | `#636366` | Section headers, status text |
| `--accent` | `#0a84ff` | Active tool, Live button, measurement values, slider fill |
| `--accent-hover` | `#0071e3` | Hover state for accent elements |
| `--warning` | `#ff9f0a` | NOT CALIBRATED button |
| `--success` | `#30d158` | Calibrated button |
| `--danger` | `#ff453a` | Delete actions |

### Typography

- **Body font:** `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
- **Exception:** coordinate HUD (`#coord-display`) keeps `ui-monospace, monospace` for the technical readout feel
- **Sizes:** 13px top bar title, 11px menu buttons and top bar actions, 10px sidebar labels and measurement rows, 9px slider labels and status text

### Shape & Depth

- **Border radius:** 6–8px on buttons and input controls; 10–12px on the floating strip pill
- **Floating strip shadow:** `0 4px 16px rgba(0,0,0,.6)` — lifts it above the image
- **Dropdown shadow:** `0 8px 24px rgba(0,0,0,.5)` with `border: 1px solid var(--border)`
- **Transitions:** 0.15s ease on hover/active

### Theme System

Themes are named sets of CSS custom properties. Each theme is defined as a CSS class on `<html>` (e.g. `class="theme-macos-dark"`). On startup, the frontend reads `config["theme"]` from the backend and applies the corresponding class.

`style.css` defines:
```css
.theme-macos-dark { --bg: #141414; --surface: #1c1c1e; … }
```

Adding a new theme in future requires only adding a new CSS block and a `<option>` in the Settings theme selector — no backend changes.

---

## Configuration (`config.json`)

Two new keys added to `_DEFAULTS` in `backend/config.py`:

```json
{
  "app_name": "Microscope",
  "theme": "macos-dark"
}
```

The backend exposes both via a new `GET /config/ui` endpoint returning `{ "app_name": "...", "theme": "..." }`. The frontend reads this at startup alongside `/camera/info`. Settings dialog writes changes back via `POST /config/ui` (same pattern as existing config writes).

---

## Files Changed

| File | Change |
|---|---|
| `backend/config.py` | Add `"app_name"` and `"theme"` to `_DEFAULTS` |
| `backend/api.py` | Add `GET /config/ui` and `POST /config/ui` handlers |
| `frontend/index.html` | Full rewrite of toolbar → top bar + dropdown markup; add floating strip; add calibration button to sidebar status bar; add General tab to Settings dialog; remove snapshot browser panel from sidebar |
| `frontend/style.css` | Full visual overhaul: CSS variables for `macos-dark` theme, new component styles, floating strip, dropdowns, calibration button |
| `frontend/app.js` | Wire up new menu buttons, dropdown open/close logic, floating strip + overflow popup, calibration button state, app name + theme loading from `/config/ui` |

---

## Out of Scope

- Multiple simultaneous themes (only one active at a time)
- Light theme (not designed; the architecture supports adding it later)
- Responsive/mobile layout
- Any backend measurement logic changes
- Snapshot browser panel is **removed** from the sidebar. Snapshots and other images are loaded via the `📁` Load image button in the top bar.
