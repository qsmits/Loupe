# UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dense toolbar and cluttered sidebar with a minimal top bar (dropdown menus), a floating tool strip, a slimmer sidebar, and a macOS-native dark visual style; add configurable app name and color theme.

**Architecture:** Backend gains a `/config/ui` endpoint exposing `app_name` and `theme` from `config.json`. The frontend is rebuilt with a `#top-bar` (title + three dropdown menus + utility buttons), a floating `#tool-strip` inside `#viewer`, and a sidebar with only three sections: Measurements, collapsible Camera, and a status bar with a persistent calibration button. CSS themes are named classes on `<html>` (e.g. `class="theme-macos-dark"`); `style.css` defines `.theme-macos-dark` with all custom properties. JS is updated in-place to wire the new elements while preserving all existing tool, annotation, and detection logic.

**Tech Stack:** Vanilla JS, HTML5, CSS custom properties. Python/FastAPI backend.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `backend/config.py` | Modify | Add `app_name` and `theme` defaults |
| `backend/api.py` | Modify | Add `GET /config/ui` and `POST /config/ui` |
| `tests/test_config_ui_api.py` | Create | Tests for `/config/ui` endpoints |
| `frontend/index.html` | Rewrite | New layout: top bar, dropdowns, floating strip, updated sidebar |
| `frontend/style.css` | Rewrite | macOS-dark theme system, all new component styles |
| `frontend/app.js` | Modify | Wire new UI; remove snapshot panel JS; update status-line ID references |

---

### Task 1: Backend — /config/ui endpoint

**Files:**
- Modify: `backend/config.py`
- Modify: `backend/api.py`
- Create: `tests/test_config_ui_api.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_config_ui_api.py
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app


@pytest.fixture
def client():
    app = create_app(no_camera=True)
    return TestClient(app)


def test_get_config_ui_returns_app_name_and_theme(client):
    resp = client.get("/config/ui")
    assert resp.status_code == 200
    data = resp.json()
    assert "app_name" in data
    assert "theme" in data


def test_get_config_ui_defaults(client):
    resp = client.get("/config/ui")
    data = resp.json()
    assert data["app_name"] == "Microscope"
    assert data["theme"] == "macos-dark"


def test_post_config_ui_accepts_valid_payload(client):
    resp = client.post("/config/ui", json={"app_name": "MyScope", "theme": "macos-dark"})
    assert resp.status_code == 200


def test_post_config_ui_rejects_unknown_keys(client):
    # Pydantic should reject payloads missing required fields
    resp = client.post("/config/ui", json={"evil": "payload"})
    assert resp.status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/qsmits/Projects/MainDynamics/microscope
python -m pytest tests/test_config_ui_api.py -v
```
Expected: 4 FAILED (endpoints don't exist yet)

- [ ] **Step 3: Add defaults to config.py**

In `backend/config.py`, add two keys to `_DEFAULTS`:

```python
_DEFAULTS = {
    "camera_id": None,
    "version": 1,
    "no_camera": False,
    "app_name": "Microscope",   # ← add
    "theme": "macos-dark",      # ← add
}
```

- [ ] **Step 4: Add /config/ui handlers to api.py**

In `backend/api.py`, add a Pydantic model and two route handlers. Place them near the other config-related routes. Check whether `load_config` and `save_config` are already imported; if not, add them.

```python
from pydantic import BaseModel

class UiConfig(BaseModel):
    app_name: str
    theme: str

@router.get("/config/ui")
def get_ui_config():
    cfg = load_config()
    return {
        "app_name": cfg.get("app_name", "Microscope"),
        "theme":    cfg.get("theme",    "macos-dark"),
    }

@router.post("/config/ui")
def post_ui_config(body: UiConfig):
    save_config({"app_name": body.app_name, "theme": body.theme})
    return {"app_name": body.app_name, "theme": body.theme}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
python -m pytest tests/test_config_ui_api.py -v
```
Expected: 4 PASSED

- [ ] **Step 6: Commit**

```bash
git add backend/config.py backend/api.py tests/test_config_ui_api.py
git commit -m "feat: add /config/ui endpoint for app_name and theme"
```

---

### Task 2: HTML — new layout structure

**Files:**
- Rewrite: `frontend/index.html`

This is a full structural rewrite of the 266-line file. The old `#toolbar` becomes `#top-bar`; detection controls move from the sidebar into the `Detect ▾` dropdown (same IDs preserved so existing JS handlers still bind); the snapshot panel is removed; a floating `#tool-strip` is added inside `#viewer`; the sidebar gains `#sidebar-status` with `#btn-calibration`; the Settings dialog gains a General tab.

**IDs preserved (existing JS depends on these):**
`#stream-img`, `#overlay-canvas`, `#viewer`, `#coord-display`, `#drop-overlay`,
`#measurement-list`, `#exp-slider`, `#exp-value`, `#gain-slider`, `#gain-value`, `#camera-info`,
`#btn-freeze`, `#btn-load`, `#btn-save-session`, `#btn-settings`,
`#btn-crosshair`, `#btn-set-origin`, `#btn-load-dxf`, `#btn-export`, `#btn-export-csv`,
`#canny-low`, `#canny-high`, `#hough-p2`, `#circle-min-r`, `#circle-max-r`,
`#line-sensitivity`, `#line-min-length`,
`#btn-run-edges`, `#btn-show-preprocessed`, `#btn-run-circles`, `#btn-run-lines`,
`#settings-dialog`, `#settings-camera-panel`, `#settings-display-panel`,
`#settings-model`, `#settings-serial`, `#camera-select`, `#pixel-format-select`,
`#btn-wb-auto`, `#wb-red-slider`, `#wb-green-slider`, `#wb-blue-slider`,
`#crosshair-opacity`, `#help-dialog`, `#settings-status`,
`#file-input`, `#dxf-input`, `#session-input`

**IDs removed:** `#toolbar`, `#snapshot-panel`, `#snapshot-list`, `#btn-refresh-snapshots`,
`#btn-snapshot`, `#btn-load-session`, `#btn-clear`, `#btn-help`, `#status-line`

**New IDs:** `#top-bar`, `#app-title`, `#btn-menu-measure`, `#dropdown-measure`,
`#btn-menu-detect`, `#dropdown-detect`, `#btn-menu-overlay`, `#dropdown-overlay`,
`#tool-strip`, `#btn-overflow`, `#overflow-popup`,
`#sidebar-status`, `#status-text`, `#btn-calibration`,
`#settings-general-panel`, `#app-name-input`, `#theme-select`, `#btn-save-general`,
`#camera-section-header`, `#camera-section-body`

- [ ] **Step 1: Read the current help dialog content**

Before rewriting, read `frontend/index.html` lines 224–262 and copy the help dialog `<table>` content — it will be pasted verbatim into the new file.

- [ ] **Step 2: Rewrite frontend/index.html**

```html
<!DOCTYPE html>
<html lang="en" class="theme-macos-dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Microscope</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>

  <!-- Top bar -->
  <div id="top-bar">
    <span id="app-title">Microscope</span>
    <div class="top-bar-divider"></div>

    <div class="menu-group">
      <button class="menu-btn" id="btn-menu-measure">Measure ▾</button>
      <div class="dropdown" id="dropdown-measure" hidden>
        <button class="dropdown-item" data-tool="distance">Distance</button>
        <button class="dropdown-item" data-tool="angle">Angle</button>
        <button class="dropdown-item" data-tool="circle">Circle</button>
        <button class="dropdown-item" data-tool="arc-fit">Fit Arc</button>
        <button class="dropdown-item" data-tool="center-dist">Center Dist</button>
        <button class="dropdown-item" data-tool="para-dist">Para</button>
        <button class="dropdown-item" data-tool="perp-dist">Perp</button>
        <button class="dropdown-item" data-tool="area">Area</button>
        <button class="dropdown-item" data-tool="pt-circle-dist">Pt-Circle</button>
        <button class="dropdown-item" data-tool="intersect">Intersect</button>
        <button class="dropdown-item" data-tool="slot-dist">Slot</button>
      </div>
    </div>

    <div class="menu-group">
      <button class="menu-btn" id="btn-menu-detect">Detect ▾</button>
      <div class="dropdown detect-panel" id="dropdown-detect" hidden>
        <div class="detect-section">
          <div class="detect-section-label">Edge Detection</div>
          <div class="detect-row">
            <label class="detect-label">Low</label>
            <input type="range" id="canny-low" min="0" max="255" value="50" />
            <span class="detect-val" id="canny-low-val">50</span>
          </div>
          <div class="detect-row">
            <label class="detect-label">High</label>
            <input type="range" id="canny-high" min="0" max="255" value="150" />
            <span class="detect-val" id="canny-high-val">150</span>
          </div>
          <div class="detect-actions">
            <button id="btn-run-edges" class="detect-btn">Run edge detect</button>
            <button id="btn-show-preprocessed" class="detect-btn">Show preprocessed</button>
          </div>
        </div>
        <div class="detect-section">
          <div class="detect-section-label">Circle Detection</div>
          <div class="detect-row">
            <label class="detect-label">Sensitivity</label>
            <input type="range" id="hough-p2" min="1" max="100" value="30" />
            <span class="detect-val" id="hough-p2-val">30</span>
          </div>
          <div class="detect-row">
            <label class="detect-label">Min r</label>
            <input type="range" id="circle-min-r" min="1" max="500" value="10" />
            <span class="detect-val" id="circle-min-r-val">10</span>
          </div>
          <div class="detect-row">
            <label class="detect-label">Max r</label>
            <input type="range" id="circle-max-r" min="1" max="500" value="200" />
            <span class="detect-val" id="circle-max-r-val">200</span>
          </div>
          <div class="detect-actions">
            <button id="btn-run-circles" class="detect-btn">Run circle detect</button>
          </div>
        </div>
        <div class="detect-section">
          <div class="detect-section-label">Line Detection</div>
          <div class="detect-row">
            <label class="detect-label">Sensitivity</label>
            <input type="range" id="line-sensitivity" min="1" max="200" value="50" />
            <span class="detect-val" id="line-sensitivity-val">50</span>
          </div>
          <div class="detect-row">
            <label class="detect-label">Min length</label>
            <input type="range" id="line-min-length" min="1" max="500" value="50" />
            <span class="detect-val" id="line-min-length-val">50</span>
          </div>
          <div class="detect-actions">
            <button id="btn-run-lines" class="detect-btn">Run line detect</button>
          </div>
        </div>
      </div>
    </div>

    <div class="menu-group">
      <button class="menu-btn" id="btn-menu-overlay">Overlay ▾</button>
      <div class="dropdown" id="dropdown-overlay" hidden>
        <button class="dropdown-item" id="btn-load-dxf">Load DXF</button>
        <button class="dropdown-item" id="btn-export">Export annotated image</button>
        <button class="dropdown-item" id="btn-export-csv">Export CSV</button>
        <button class="dropdown-item" id="btn-crosshair">Toggle crosshair</button>
        <button class="dropdown-item" id="btn-set-origin">Set origin</button>
      </div>
    </div>

    <div class="top-bar-right">
      <button id="btn-freeze" class="top-btn freeze-btn freeze-live">❄ Live</button>
      <button id="btn-load" class="top-btn icon-btn" title="Load image">📁</button>
      <button id="btn-save-session" class="top-btn icon-btn" title="Save session">💾</button>
      <button id="btn-settings" class="top-btn icon-btn" title="Settings">⚙</button>
    </div>
  </div>

  <!-- Main content area -->
  <div id="main">

    <!-- Viewer -->
    <div id="viewer">
      <img id="stream-img" src="/stream" alt="" />
      <canvas id="overlay-canvas"></canvas>
      <div id="coord-display"></div>
      <div id="drop-overlay">
        <div class="drop-message">Drop image here</div>
      </div>

      <!-- Floating tool strip -->
      <div id="tool-strip">
        <button class="strip-btn" data-tool="select">Select</button>
        <button class="strip-btn" data-tool="distance">Distance</button>
        <button class="strip-btn" data-tool="angle">Angle</button>
        <button class="strip-btn" data-tool="circle">Circle</button>
        <button class="strip-btn" data-tool="arc-fit">Fit Arc</button>
        <div class="strip-divider"></div>
        <button class="strip-btn overflow-btn" id="btn-overflow">···</button>
        <div id="overflow-popup" hidden>
          <button class="strip-btn" data-tool="center-dist">Cdist</button>
          <button class="strip-btn" data-tool="para-dist">Para</button>
          <button class="strip-btn" data-tool="perp-dist">Perp</button>
          <button class="strip-btn" data-tool="area">Area</button>
          <button class="strip-btn" data-tool="pt-circle-dist">PtCirc</button>
          <button class="strip-btn" data-tool="intersect">Isect</button>
          <button class="strip-btn" data-tool="slot-dist">Slot</button>
        </div>
      </div>
    </div>

    <!-- Right sidebar -->
    <div id="sidebar">

      <!-- Measurements (fills available space) -->
      <div class="sidebar-section measurements-section">
        <div class="section-label">Measurements</div>
        <div id="measurement-list"></div>
      </div>

      <!-- Camera (collapsible; hidden in no-camera mode via body.no-camera) -->
      <div class="sidebar-section camera-section">
        <div class="section-label section-toggle open" id="camera-section-header">
          Camera <span class="chevron">▾</span>
        </div>
        <div id="camera-section-body">
          <div class="camera-row">
            <span class="camera-label">Exp</span>
            <input type="range" id="exp-slider" min="100" max="100000" step="100" value="5000" />
            <span id="exp-value" class="camera-value">5000 µs</span>
          </div>
          <div class="camera-row">
            <span class="camera-label">Gain</span>
            <input type="range" id="gain-slider" min="0" max="24" step="0.1" value="0" />
            <span id="gain-value" class="camera-value">0 dB</span>
          </div>
          <div id="camera-info" class="camera-info"></div>
        </div>
      </div>

      <!-- Status bar -->
      <div id="sidebar-status">
        <span id="status-text">● Live</span>
        <button id="btn-calibration" class="cal-btn uncalibrated">NOT CALIBRATED</button>
      </div>

    </div>
  </div>

  <!-- Settings dialog -->
  <div id="settings-dialog" class="dialog-overlay" hidden>
    <div class="dialog-content">
      <div class="dialog-header">
        <span class="dialog-title">Settings</span>
        <button class="dialog-close" id="btn-settings-close">✕</button>
      </div>
      <div class="dialog-tabs">
        <button class="settings-tab active" data-tab="general">General</button>
        <button class="settings-tab" data-tab="camera">Camera</button>
        <button class="settings-tab" data-tab="display">Display</button>
      </div>

      <div class="settings-panel active" id="settings-general-panel">
        <div class="settings-row">
          <label class="settings-label" for="app-name-input">App name</label>
          <input type="text" id="app-name-input" class="settings-input" value="Microscope" />
        </div>
        <div class="settings-row">
          <label class="settings-label" for="theme-select">Theme</label>
          <select id="theme-select" class="settings-select">
            <option value="macos-dark">macOS Dark</option>
          </select>
        </div>
        <button class="settings-save-btn" id="btn-save-general">Save</button>
      </div>

      <div class="settings-panel" id="settings-camera-panel">
        <div class="settings-row">
          <label class="settings-label">Model</label>
          <span id="settings-model" class="settings-value">—</span>
        </div>
        <div class="settings-row">
          <label class="settings-label">Serial</label>
          <span id="settings-serial" class="settings-value">—</span>
        </div>
        <div class="settings-row">
          <label class="settings-label">Camera</label>
          <select id="camera-select" class="settings-select"></select>
        </div>
        <div class="settings-row">
          <label class="settings-label">Pixel format</label>
          <select id="pixel-format-select" class="settings-select">
            <option value="BayerRG8">BayerRG8</option>
            <option value="BayerRG12">BayerRG12</option>
            <option value="Mono8">Mono8</option>
          </select>
        </div>
        <div class="settings-row">
          <label class="settings-label">White balance</label>
          <button id="btn-wb-auto" class="settings-btn">Auto</button>
        </div>
        <div class="settings-row">
          <label class="settings-label">R</label>
          <input type="range" id="wb-red-slider" min="0.5" max="2.5" step="0.01" value="1.0" />
        </div>
        <div class="settings-row">
          <label class="settings-label">G</label>
          <input type="range" id="wb-green-slider" min="0.5" max="2.5" step="0.01" value="1.0" />
        </div>
        <div class="settings-row">
          <label class="settings-label">B</label>
          <input type="range" id="wb-blue-slider" min="0.5" max="2.5" step="0.01" value="1.0" />
        </div>
      </div>

      <div class="settings-panel" id="settings-display-panel">
        <div class="settings-row">
          <label class="settings-label">Crosshair color</label>
          <div class="swatch-row">
            <div class="swatch" data-color="#ffffff" style="background:#ffffff"></div>
            <div class="swatch" data-color="#ff0000" style="background:#ff0000"></div>
            <div class="swatch" data-color="#00ff00" style="background:#00ff00"></div>
            <div class="swatch" data-color="#0000ff" style="background:#0000ff"></div>
            <div class="swatch" data-color="#ffff00" style="background:#ffff00"></div>
            <div class="swatch" data-color="#00ffff" style="background:#00ffff"></div>
          </div>
        </div>
        <div class="settings-row">
          <label class="settings-label">Crosshair opacity</label>
          <input type="range" id="crosshair-opacity" min="0.1" max="1" step="0.05" value="0.4" />
        </div>
      </div>

      <div id="settings-status" class="settings-status"></div>
    </div>
  </div>

  <!-- Help dialog -->
  <div id="help-dialog" class="dialog-overlay" hidden>
    <div class="dialog-content dialog-content-wide">
      <div class="dialog-header">
        <span class="dialog-title">Keyboard shortcuts</span>
        <button class="dialog-close" id="btn-help-close">✕</button>
      </div>
      <div class="help-body">
        <!-- PASTE the full <table> from the current index.html help dialog here (lines ~224-262) -->
      </div>
    </div>
  </div>

  <!-- Hidden file inputs -->
  <input type="file" id="file-input" accept="image/*" hidden />
  <input type="file" id="dxf-input" accept=".dxf" hidden />
  <input type="file" id="session-input" accept=".json" hidden />

  <script src="app.js"></script>
</body>
</html>
```

**Important:** In step 1 you read the existing help table — paste it into `.help-body` to replace the comment placeholder.

- [ ] **Step 3: Open in browser (unstyled check)**

Start the server and open the app. The page will be partially unstyled (CSS not yet updated) but verify via DevTools:
- `#top-bar` is present (no `#toolbar`)
- `#tool-strip` is inside `#viewer`
- `#sidebar-status` is at the bottom of `#sidebar`
- `#settings-general-panel` exists in the settings dialog
- No `#snapshot-panel`, no `#toolbar` in the DOM

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html
git commit -m "feat: rewrite HTML layout — top bar, floating strip, updated sidebar"
```

---

### Task 3: CSS — macOS-dark theme system and all component styles

**Files:**
- Rewrite: `frontend/style.css`

Full replacement of the 477-line file. The old CSS variables (`--bg: #0f172a` etc.) are replaced by the macOS-dark palette inside a `.theme-macos-dark` class on `<html>`. All component styles are rewritten for the new layout.

- [ ] **Step 1: Rewrite frontend/style.css**

```css
/* ─── Theme definitions ─────────────────────────────────────── */
.theme-macos-dark {
  --bg:             #141414;
  --surface:        #1c1c1e;
  --surface-2:      #2c2c2e;
  --border:         #3a3a3c;
  --text:           #e8e8e8;
  --text-secondary: #ababab;
  --muted:          #636366;
  --accent:         #0a84ff;
  --accent-hover:   #0071e3;
  --warning:        #ff9f0a;
  --success:        #30d158;
  --danger:         #ff453a;
}

/* ─── Reset / base ──────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  height: 100%;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 11px;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}

body {
  display: flex;
  flex-direction: column;
}

button {
  font-family: inherit;
  cursor: pointer;
  border: none;
  background: none;
  color: inherit;
  transition: background 0.15s ease, color 0.15s ease;
}

input[type=range] { cursor: pointer; accent-color: var(--accent); }

/* ─── Top bar ───────────────────────────────────────────────── */
#top-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  position: relative;
  z-index: 100;
  flex-shrink: 0;
}

#app-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.02em;
  margin-right: 4px;
  white-space: nowrap;
  user-select: none;
}

.top-bar-divider {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 4px;
  flex-shrink: 0;
}

.top-bar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* ─── Top bar buttons ───────────────────────────────────────── */
.menu-btn {
  padding: 4px 10px;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 11px;
}
.menu-btn:hover { background: var(--surface-2); color: var(--text); }

.top-btn {
  padding: 5px 10px;
  border-radius: 7px;
  background: var(--surface-2);
  font-size: 11px;
  color: var(--text);
}
.top-btn:hover { background: var(--border); }

.freeze-btn { padding: 5px 12px; font-weight: 500; }
.freeze-live  { background: var(--accent) !important; color: #fff !important; }
.freeze-live:hover  { background: var(--accent-hover) !important; }
.freeze-frozen { background: var(--surface-2) !important; color: var(--text-secondary) !important; }
.freeze-frozen:hover { background: var(--border) !important; }

/* ─── Dropdown menus ────────────────────────────────────────── */
.menu-group { position: relative; }

.dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,.5);
  min-width: 160px;
  z-index: 200;
  padding: 4px;
}

.dropdown-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  border-radius: 5px;
  font-size: 11px;
  color: var(--text);
}
.dropdown-item:hover { background: var(--surface-2); }

/* ─── Detect panel (wider) ──────────────────────────────────── */
.detect-panel { min-width: 280px; padding: 8px; }

.detect-section { margin-bottom: 10px; }
.detect-section:last-child { margin-bottom: 0; }

.detect-section-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: .05em;
  margin-bottom: 6px;
}

.detect-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.detect-label {
  font-size: 10px;
  color: var(--text-secondary);
  width: 72px;
  flex-shrink: 0;
}

.detect-row input[type=range] { flex: 1; }

.detect-val {
  font-size: 10px;
  color: var(--text-secondary);
  width: 28px;
  text-align: right;
  flex-shrink: 0;
}

.detect-actions { display: flex; gap: 4px; margin-top: 6px; }

.detect-btn {
  flex: 1;
  padding: 5px 8px;
  background: var(--surface-2);
  border-radius: 6px;
  font-size: 10px;
  color: var(--text);
}
.detect-btn:hover { background: var(--border); }

/* ─── Main layout ───────────────────────────────────────────── */
#main {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* ─── Viewer ────────────────────────────────────────────────── */
#viewer {
  flex: 1;
  background: #0a0a0a;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

#stream-img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

body.no-camera #stream-img {
  width: 100%;
  height: 100%;
}

#overlay-canvas {
  position: absolute;
  top: 0; left: 0;
  pointer-events: none;
}

/* ─── Coordinate HUD ────────────────────────────────────────── */
#coord-display {
  position: absolute;
  bottom: 52px;
  left: 12px;
  font-family: ui-monospace, monospace;
  font-size: 9px;
  color: var(--muted);
  pointer-events: none;
}

/* ─── Drop overlay ──────────────────────────────────────────── */
#drop-overlay {
  display: none;
  position: absolute;
  inset: 0;
  align-items: center;
  justify-content: center;
  background: rgba(10,132,255,.08);
  border: 2px dashed var(--accent);
  border-radius: 4px;
  pointer-events: none;
}
#drop-overlay.visible  { display: flex; }
#drop-overlay.drag-active {
  background: rgba(10,132,255,.18);
  border-color: var(--accent-hover);
}
.drop-message {
  font-size: 14px;
  color: var(--accent);
  font-weight: 500;
}

/* ─── Floating tool strip ───────────────────────────────────── */
#tool-strip {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(28,28,30,.96);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 5px 8px;
  display: flex;
  align-items: center;
  gap: 3px;
  box-shadow: 0 4px 16px rgba(0,0,0,.6);
}

.strip-btn {
  padding: 5px 10px;
  border-radius: 8px;
  font-size: 10px;
  color: var(--text-secondary);
}
.strip-btn:hover { background: var(--surface-2); color: var(--text); }
.strip-btn.active { background: var(--accent); color: #fff; font-weight: 500; }
.strip-btn.active:hover { background: var(--accent-hover); }

.overflow-btn { color: var(--muted); padding: 5px 8px; }
.overflow-btn:hover { background: var(--surface-2); color: var(--text-secondary); }

.strip-divider {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 2px;
  flex-shrink: 0;
}

/* ─── Overflow popup ────────────────────────────────────────── */
#overflow-popup {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 4px 16px rgba(0,0,0,.6);
  padding: 6px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
  min-width: 140px;
}

/* ─── Sidebar ───────────────────────────────────────────────── */
#sidebar {
  width: 200px;
  background: var(--surface);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
}

.sidebar-section {
  border-bottom: 1px solid var(--border);
  padding: 10px 12px;
}

.measurements-section {
  flex: 1;
  overflow-y: auto;
}

.section-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: .05em;
  margin-bottom: 8px;
  user-select: none;
}

.section-toggle {
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0;
}
.section-toggle.open { margin-bottom: 8px; }

.chevron { color: var(--border); font-size: 9px; }

/* ─── Measurement list ──────────────────────────────────────── */
#measurement-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.measurement-item {
  background: var(--surface-2);
  border-radius: 7px;
  padding: 5px 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  position: relative;
}
.measurement-item:hover { background: var(--border); }
.measurement-item.selected { outline: 1px solid var(--accent); }

.measurement-name {
  font-size: 10px;
  color: var(--text);
  flex: 1;
  background: none;
  border: none;
  outline: none;
  font-family: inherit;
  min-width: 0;
}

.measurement-value {
  font-size: 10px;
  color: var(--accent);
  font-weight: 500;
  white-space: nowrap;
  margin-left: 4px;
}

.measurement-delete {
  display: none;
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--danger);
  font-size: 13px;
  padding: 0 3px;
  line-height: 1;
}
.measurement-item:hover .measurement-delete { display: block; }

@keyframes copied-flash {
  0%   { background: var(--accent); }
  100% { background: var(--surface-2); }
}
.measurement-item.copied { animation: copied-flash 0.4s ease; }

/* ─── Camera section ────────────────────────────────────────── */
.camera-section { padding: 8px 12px; }

.camera-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.camera-label {
  font-size: 9px;
  color: var(--muted);
  width: 24px;
  flex-shrink: 0;
}

.camera-value {
  font-size: 9px;
  color: var(--text-secondary);
  width: 54px;
  text-align: right;
  flex-shrink: 0;
}

.camera-row input[type=range] { flex: 1; }

.camera-info {
  margin-top: 4px;
  font-size: 9px;
  color: var(--muted);
  line-height: 1.5;
}

/* ─── Sidebar status bar ────────────────────────────────────── */
#sidebar-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  margin-top: auto;
}

#status-text {
  font-size: 10px;
  color: var(--muted);
}

/* ─── Calibration button ────────────────────────────────────── */
.cal-btn {
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 9px;
  font-weight: 600;
  white-space: nowrap;
  border: 1px solid transparent;
}

.cal-btn.uncalibrated {
  background: rgba(255,159,10,.15);
  border-color: rgba(255,159,10,.4);
  color: var(--warning);
}
.cal-btn.uncalibrated:hover { background: rgba(255,159,10,.25); }

.cal-btn.calibrated {
  background: rgba(48,209,88,.15);
  border-color: rgba(48,209,88,.4);
  color: var(--success);
}
.cal-btn.calibrated:hover { background: rgba(48,209,88,.25); }

/* ─── No-camera mode ────────────────────────────────────────── */
body.no-camera .camera-section { display: none; }

/* ─── Settings dialog ───────────────────────────────────────── */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 500;
}

.dialog-content {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  width: 360px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 40px rgba(0,0,0,.7);
  overflow: hidden;
}

.dialog-content-wide { width: 520px; }

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.dialog-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.dialog-close {
  font-size: 14px;
  color: var(--muted);
  padding: 2px 6px;
  border-radius: 4px;
}
.dialog-close:hover { background: var(--surface-2); color: var(--text); }

.dialog-tabs {
  display: flex;
  padding: 8px 12px 0;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.settings-tab {
  padding: 5px 12px;
  font-size: 11px;
  color: var(--text-secondary);
  border-radius: 6px 6px 0 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.settings-tab:hover { color: var(--text); }
.settings-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.settings-panel {
  display: none;
  padding: 14px 16px;
  overflow-y: auto;
}
.settings-panel.active { display: block; }

.settings-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.settings-label {
  font-size: 11px;
  color: var(--text-secondary);
  width: 90px;
  flex-shrink: 0;
}

.settings-value { font-size: 11px; color: var(--text); }

.settings-input {
  flex: 1;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 11px;
  color: var(--text);
  font-family: inherit;
  outline: none;
}
.settings-input:focus { border-color: var(--accent); }

.settings-select {
  flex: 1;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 11px;
  color: var(--text);
  font-family: inherit;
  outline: none;
}

.settings-btn {
  padding: 5px 12px;
  background: var(--surface-2);
  border-radius: 6px;
  font-size: 11px;
  color: var(--text);
}
.settings-btn:hover { background: var(--border); }

.settings-save-btn {
  padding: 6px 16px;
  background: var(--accent);
  border-radius: 7px;
  font-size: 11px;
  color: #fff;
  font-weight: 500;
  margin-top: 4px;
}
.settings-save-btn:hover { background: var(--accent-hover); }

.swatch-row { display: flex; gap: 5px; }
.swatch {
  width: 20px; height: 20px;
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid transparent;
}
.swatch:hover, .swatch.selected { border-color: var(--text); }

.settings-row input[type=range] { flex: 1; }

.settings-status {
  padding: 6px 16px 10px;
  font-size: 10px;
  color: var(--muted);
  flex-shrink: 0;
  min-height: 26px;
}

/* ─── Help dialog ───────────────────────────────────────────── */
.help-body {
  padding: 12px 16px;
  overflow-y: auto;
  flex: 1;
}

.help-body table { width: 100%; border-collapse: collapse; font-size: 11px; }
.help-body th {
  text-align: left;
  color: var(--muted);
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: .05em;
}
.help-body td { padding: 5px 8px; color: var(--text); }
.help-body tr:nth-child(even) td { background: var(--surface-2); }
.help-body kbd {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: ui-monospace, monospace;
  font-size: 10px;
}
```

- [ ] **Step 2: Verify in browser**

Open the app after this step. Verify:
- macOS dark palette: dark background (`#141414`), surface panels (`#1c1c1e`), blue accent (`#0a84ff`)
- Top bar: title, three menu buttons, right-side buttons render correctly
- Sidebar: Measurements section fills space, Camera section shows sliders, status bar shows orange "NOT CALIBRATED"
- Floating strip: visible at bottom of viewer, `Select` button highlighted blue

- [ ] **Step 3: Commit**

```bash
git add frontend/style.css
git commit -m "feat: macOS-dark theme system and full CSS overhaul"
```

---

### Task 4: JS — startup, theme/app name, calibration button, camera collapse, strip wiring

**Files:**
- Modify: `frontend/app.js`

**Context:** `app.js` is ~2,923 lines. This task adds a `loadUiConfig()` function, wires the calibration button, adds a camera section collapse toggle, and updates `setTool()` to highlight the floating strip. Search for referenced symbols before adding to avoid duplicates.

- [ ] **Step 1: Add `loadUiConfig()` — find `loadCameraInfo` and insert above it**

Search for `function loadCameraInfo` in `app.js`. Insert these two functions immediately before it:

```javascript
async function loadUiConfig() {
  try {
    const data = await fetch("/config/ui").then(r => r.json());
    document.getElementById("app-title").textContent = data.app_name || "Microscope";
    document.title = data.app_name || "Microscope";
    document.documentElement.className = `theme-${data.theme || "macos-dark"}`;
    const nameInput = document.getElementById("app-name-input");
    if (nameInput) nameInput.value = data.app_name || "Microscope";
    const themeSelect = document.getElementById("theme-select");
    if (themeSelect) themeSelect.value = data.theme || "macos-dark";
  } catch (_) {
    // non-fatal: default theme class is already on <html>
  }
}

function updateCalibrationButton() {
  const btn = document.getElementById("btn-calibration");
  if (!btn) return;
  if (state.calibration) {
    const scale = (1 / state.calibration.pixelsPerMm).toFixed(3);
    btn.textContent = `${scale} µm/px`;
    btn.classList.remove("uncalibrated");
    btn.classList.add("calibrated");
  } else {
    btn.textContent = "NOT CALIBRATED";
    btn.classList.remove("calibrated");
    btn.classList.add("uncalibrated");
  }
}
```

- [ ] **Step 2: Call both functions in the startup sequence**

Find the block where `loadCameraInfo()` is called in the startup/init sequence (near bottom of `app.js`). Add the two new calls alongside it:

```javascript
loadCameraInfo();
loadUiConfig();            // ← add
updateCalibrationButton(); // ← add (handles session-restored calibration)
```

- [ ] **Step 3: Call `updateCalibrationButton()` after calibration state changes**

Find `function applyCalibration` — add at the end of the function body:
```javascript
updateCalibrationButton();
```

Find `deleteAnnotation` — after the line `state.calibration = null` add:
```javascript
updateCalibrationButton();
```

- [ ] **Step 4: Wire calibration button click**

In the init sequence, after existing button bindings, add:

```javascript
document.getElementById("btn-calibration").addEventListener("click", () => setTool("calibrate"));
```

- [ ] **Step 5: Update `setTool()` to highlight the floating strip**

Find `function setTool(name)`. After the existing code that marks `.tool-btn` active, add:

```javascript
document.querySelectorAll("#tool-strip .strip-btn[data-tool]").forEach(btn => {
  btn.classList.toggle("active", btn.dataset.tool === name);
});
```

- [ ] **Step 6: Wire floating strip buttons**

In the init sequence:

```javascript
document.querySelectorAll("#tool-strip .strip-btn[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
});
// Trigger once to set initial active state
document.querySelectorAll("#tool-strip .strip-btn[data-tool]").forEach(btn => {
  btn.classList.toggle("active", btn.dataset.tool === state.tool);
});
```

- [ ] **Step 7: Wire camera section collapse toggle**

In the init sequence:

```javascript
const cameraSectionHeader = document.getElementById("camera-section-header");
const cameraSectionBody   = document.getElementById("camera-section-body");
if (cameraSectionHeader && cameraSectionBody) {
  cameraSectionHeader.addEventListener("click", () => {
    const isOpen = cameraSectionHeader.classList.toggle("open");
    cameraSectionBody.style.display = isOpen ? "" : "none";
  });
}
```

- [ ] **Step 8: Replace `#status-line` references with `#status-text`**

Search for `status-line` in `app.js` (there may be 1–3 occurrences where `textContent` is set). Replace each `getElementById("status-line")` with `getElementById("status-text")`. Do NOT change any other logic.

- [ ] **Step 9: Verify in browser**

- App title shows "Microscope", page title matches
- macOS dark palette active
- Clicking Distance in floating strip → tool activates, Distance button turns blue
- Keyboard shortcut D also activates Distance and strip updates
- Calibration button orange → run a calibration → button turns green with scale value → clear all → back to orange
- Camera section header click collapses/expands sliders
- Freeze → status text updates from "● Live" to "● Frozen"

- [ ] **Step 10: Commit**

```bash
git add frontend/app.js
git commit -m "feat: startup wiring — theme, calibration button, strip, camera collapse"
```

---

### Task 5: JS — dropdown menus, overflow popup, freeze UI, detect slider labels

**Files:**
- Modify: `frontend/app.js`

**Context:** Three menus open on click, close on click-outside/Escape. The Detect panel sliders show live value labels. The freeze button updates its own CSS class and `#status-text`. Note: existing handlers for `#btn-run-edges`, `#btn-load-dxf` etc. are already bound elsewhere in `app.js` — we only add close-on-action behaviour on top.

- [ ] **Step 1: Add dropdown helper functions**

Insert near the start of the init/binding section:

```javascript
// ─── Dropdown helpers ────────────────────────────────────────
function closeAllDropdowns() {
  ["dropdown-measure","dropdown-detect","dropdown-overlay"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  ["btn-menu-measure","btn-menu-detect","btn-menu-overlay"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove("open");
  });
  const popup = document.getElementById("overflow-popup");
  if (popup) popup.hidden = true;
}

function toggleDropdown(btnId, dropId) {
  const drop = document.getElementById(dropId);
  const wasOpen = !drop.hidden;
  closeAllDropdowns();
  if (!wasOpen) {
    drop.hidden = false;
    document.getElementById(btnId).classList.add("open");
  }
}
```

- [ ] **Step 2: Wire the three menu buttons**

```javascript
document.getElementById("btn-menu-measure").addEventListener("click", e => {
  e.stopPropagation();
  toggleDropdown("btn-menu-measure", "dropdown-measure");
});
document.getElementById("btn-menu-detect").addEventListener("click", e => {
  e.stopPropagation();
  toggleDropdown("btn-menu-detect", "dropdown-detect");
});
document.getElementById("btn-menu-overlay").addEventListener("click", e => {
  e.stopPropagation();
  toggleDropdown("btn-menu-overlay", "dropdown-overlay");
});
```

- [ ] **Step 3: Wire Measure dropdown — select tool and close**

```javascript
document.querySelectorAll("#dropdown-measure .dropdown-item[data-tool]").forEach(item => {
  item.addEventListener("click", () => {
    setTool(item.dataset.tool);
    closeAllDropdowns();
  });
});
```

- [ ] **Step 4: Wire Overlay dropdown — close after action (capture phase)**

The overlay action buttons (`#btn-load-dxf`, `#btn-export`, etc.) already have handlers elsewhere in `app.js`. Add a capture-phase listener that closes the dropdown before each fires:

```javascript
["btn-load-dxf","btn-export","btn-export-csv","btn-crosshair","btn-set-origin"]
  .forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", closeAllDropdowns, true);
  });
```

- [ ] **Step 5: Wire Detect run buttons — close panel after action (capture phase)**

```javascript
["btn-run-edges","btn-show-preprocessed","btn-run-circles","btn-run-lines"]
  .forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", closeAllDropdowns, true);
  });
```

- [ ] **Step 6: Wire detect slider live value labels**

Check first whether `app.js` already wires `input` events on `#canny-low` (search for `canny-low` in app.js). If it does, skip this step. If not, add:

```javascript
[
  ["canny-low",        "canny-low-val"],
  ["canny-high",       "canny-high-val"],
  ["hough-p2",         "hough-p2-val"],
  ["circle-min-r",     "circle-min-r-val"],
  ["circle-max-r",     "circle-max-r-val"],
  ["line-sensitivity", "line-sensitivity-val"],
  ["line-min-length",  "line-min-length-val"],
].forEach(([sliderId, valId]) => {
  const slider = document.getElementById(sliderId);
  const val    = document.getElementById(valId);
  if (slider && val) {
    val.textContent = slider.value;
    slider.addEventListener("input", () => { val.textContent = slider.value; });
  }
});
```

- [ ] **Step 7: Wire overflow popup (··· button)**

```javascript
const overflowBtn   = document.getElementById("btn-overflow");
const overflowPopup = document.getElementById("overflow-popup");

overflowBtn.addEventListener("click", e => {
  e.stopPropagation();
  closeAllDropdowns(); // close any open dropdown first
  overflowPopup.hidden = !overflowPopup.hidden;
});

document.querySelectorAll("#overflow-popup .strip-btn[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => {
    setTool(btn.dataset.tool);
    overflowPopup.hidden = true;
  });
});
```

- [ ] **Step 8: Close on click-outside and Escape**

There is already a global `keydown` handler in `app.js`. Find it and add Escape handling for dropdowns inside it (before the existing Escape logic, so the existing dialog-close still works):

```javascript
// Inside the existing keydown handler, at the top:
if (e.key === "Escape") {
  closeAllDropdowns(); // add this line
  // existing Escape handling continues below...
}
```

For click-outside, add a global click listener (verify there isn't one already):

```javascript
document.addEventListener("click", closeAllDropdowns);
```

- [ ] **Step 9: Add `updateFreezeUI()` helper and call it**

Search for where `state.frozen` is assigned in `app.js` (the `#btn-freeze` handler). Add this helper and call it there and in the startup sequence:

```javascript
function updateFreezeUI() {
  const btn        = document.getElementById("btn-freeze");
  const statusText = document.getElementById("status-text");
  if (state.frozen) {
    btn.textContent = "❄ Frozen";
    btn.classList.replace("freeze-live", "freeze-frozen");
    if (statusText) statusText.textContent = "● Frozen";
  } else {
    btn.textContent = "❄ Live";
    btn.classList.replace("freeze-frozen", "freeze-live");
    if (statusText) statusText.textContent = "● Live";
  }
  updateDropOverlay(); // keep drop overlay in sync
}
```

Replace the existing inline freeze-button text/style updates with a call to `updateFreezeUI()`. Also call it once during startup so the initial UI matches `state.frozen`.

- [ ] **Step 10: Verify in browser**

- Click "Measure ▾" → list opens; click Distance → tool activates, menu closes
- Click "Detect ▾" → wide panel opens; move slider → label updates in real time; click "Run edge detect" → detection fires, panel closes; sliders do NOT auto-close
- Click "Overlay ▾" → items visible; click "Toggle crosshair" → crosshair toggles, menu closes
- Click ··· → 2-column grid above strip; click Perp → tool selected, popup closes
- Click outside any open menu → all close
- Press Escape → all close
- Freeze → button text "❄ Frozen", muted style, status text "● Frozen"
- Unfreeze → button returns to blue "❄ Live"

- [ ] **Step 11: Commit**

```bash
git add frontend/app.js
git commit -m "feat: dropdown menus, overflow popup, freeze UI sync"
```

---

### Task 6: JS — Settings General tab and snapshot panel removal

**Files:**
- Modify: `frontend/app.js`

**Context:** Wire the new General tab's Save button. Remove all snapshot panel JS (`loadSnapshotList`, `#btn-refresh-snapshots` handler, `/load-snapshot` calls). Confirm settings tab-switching covers the new "general" tab.

- [ ] **Step 1: Verify settings tab-switching handles General tab**

Search for the settings tab-switching code in `app.js` (look for `settings-tab` or `data-tab`). If it derives the panel ID as `` `settings-${tab.dataset.tab}-panel` ``, it already works for "general" — confirm visually. If it hard-codes "camera" and "display", replace the whole binding with:

```javascript
document.querySelectorAll(".settings-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".settings-panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    const panel = document.getElementById(`settings-${tab.dataset.tab}-panel`);
    if (panel) panel.classList.add("active");
  });
});
```

- [ ] **Step 2: Wire General tab Save button**

```javascript
document.getElementById("btn-save-general").addEventListener("click", async () => {
  const appName = document.getElementById("app-name-input").value.trim() || "Microscope";
  const theme   = document.getElementById("theme-select").value;
  try {
    await fetch("/config/ui", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ app_name: appName, theme }),
    });
    document.getElementById("app-title").textContent = appName;
    document.title = appName;
    document.documentElement.className = `theme-${theme}`;
    document.getElementById("settings-status").textContent = "Saved.";
    setTimeout(() => { document.getElementById("settings-status").textContent = ""; }, 2000);
  } catch (_) {
    document.getElementById("settings-status").textContent = "Save failed.";
  }
});
```

- [ ] **Step 3: Remove snapshot panel JS**

Search `app.js` for `loadSnapshotList` and `snapshot`. Remove:
- The `loadSnapshotList()` function definition entirely
- All calls to `loadSnapshotList()` (startup and `#btn-refresh-snapshots` handler)
- The `#btn-refresh-snapshots` event listener binding
- Any click handler that calls `POST /load-snapshot` (usually on snapshot list items inside `loadSnapshotList`)

After removal, search `app.js` for `/snapshots` and `/load-snapshot` — there should be zero occurrences.

- [ ] **Step 4: Guard or remove bindings for deleted elements**

The following IDs exist in the old `app.js` but are absent from the new HTML: `#btn-clear`, `#btn-help`, `#btn-snapshot`, `#btn-load-session`. If any of these are bound without a null-check, the app will throw at startup.

For each ID, grep `app.js`:

```bash
grep -n "btn-clear\|btn-help\|btn-snapshot\|btn-load-session" frontend/app.js
```

For each match, apply whichever fix fits:

- **`#btn-clear`** — remove the entire event listener binding (clear-all is now accessible only via keyboard shortcut; verify `?` / Ctrl+Z / clear shortcut still works through the existing keydown handler).
- **`#btn-help`** — remove the button click binding (the help dialog is still opened via the `?` keyboard shortcut in the existing keydown handler; confirm that shortcut still works).
- **`#btn-snapshot`** — remove the binding entirely (snapshot-to-disk is removed from the new UI per spec).
- **`#btn-load-session`** — remove the binding (session loading is now triggered only via `#session-input` drop or the `📁` Load button flow; verify session restore still works).

If any binding already uses optional chaining (`document.getElementById("btn-clear")?.addEventListener(...)`) it is already safe — leave it as-is.

After edits, reload the app with the browser console open and confirm zero `TypeError: Cannot read properties of null` errors on startup.

- [ ] **Step 5: Run all tests**

```bash
python -m pytest tests/ -v
```
Expected: all tests pass

- [ ] **Step 6: Verify Settings General tab in browser**

- Open Settings → General tab is shown first (active)
- App name field shows current name
- Change name to "MyScope" → click Save → `#app-title` updates immediately, page title updates
- Reload page → name persists (fetched from `/config/ui` on startup)
- Verify Camera and Display tabs still work as before

- [ ] **Step 7: Commit**

```bash
git add frontend/app.js
git commit -m "feat: Settings General tab, remove snapshot panel JS, guard deleted-element bindings"
```
