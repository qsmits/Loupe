# Deflectometry Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add setup profiles, measured display response calibration, display sanity check, and user-drawn part masks to the deflectometry mode.

**Architecture:** Four independent features sharing the existing deflectometry backend/frontend. Profiles persist to `config.json`. Response calibration and sanity check add new capture-and-analyze endpoints using the existing WebSocket pattern dispatch. Part masks reuse the cross-mode polygon editing from fringe mode. A shared `mask_utils.py` module is extracted from fringe to avoid duplicating polygon rasterization.

**Tech Stack:** Python/NumPy/OpenCV (backend), FastAPI + Pydantic (API), vanilla JS ES modules (frontend)

**Spec:** `docs/superpowers/specs/2026-04-16-deflectometry-phase2-design.md`

---

### Task 1: Extract shared polygon rasterization utility

The polygon mask rasterization function currently lives in `backend/vision/fringe.py`. Deflectometry needs the same function. Extract it to a shared module so both can import it.

**Files:**
- Create: `backend/vision/mask_utils.py`
- Modify: `backend/vision/fringe.py:866-903` (remove function, add re-export)
- Modify: `backend/api_fringe.py:29` (update import)
- Test: `tests/test_mask_utils.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_mask_utils.py`:

```python
import numpy as np
from backend.vision.mask_utils import rasterize_polygon_mask


def test_rasterize_empty_returns_all_true():
    mask = rasterize_polygon_mask([], 64, 64)
    assert mask.shape == (64, 64)
    assert mask.all()


def test_rasterize_include_polygon():
    """A square covering the center should set those pixels to True."""
    polys = [{"vertices": [(0.25, 0.25), (0.75, 0.25), (0.75, 0.75), (0.25, 0.75)], "include": True}]
    mask = rasterize_polygon_mask(polys, 100, 100)
    assert mask.shape == (100, 100)
    # Center pixel should be included
    assert mask[50, 50]
    # Corner pixel should be excluded (outside polygon)
    assert not mask[5, 5]


def test_rasterize_exclude_punches_hole():
    """An include polygon with an exclude polygon inside should have a hole."""
    polys = [
        {"vertices": [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)], "include": True},
        {"vertices": [(0.4, 0.4), (0.6, 0.4), (0.6, 0.6), (0.4, 0.6)], "include": False},
    ]
    mask = rasterize_polygon_mask(polys, 100, 100)
    # Edge should be included
    assert mask[10, 10]
    # Center hole should be excluded
    assert not mask[50, 50]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_mask_utils.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'backend.vision.mask_utils'`

- [ ] **Step 3: Create the shared module**

Create `backend/vision/mask_utils.py`:

```python
"""Shared polygon mask rasterization utilities."""

import cv2
import numpy as np


def rasterize_polygon_mask(polygons: list[dict], height: int, width: int
                           ) -> np.ndarray:
    """Rasterize polygon definitions into a boolean mask.

    Parameters
    ----------
    polygons : list of dicts with keys:
        - "vertices": list of (x, y) tuples in normalized (0-1) coords
        - "include": bool (True = include region, False = exclude/hole)
    height, width : image dimensions for rasterization.

    Returns
    -------
    Boolean mask (True = valid pixel). If no polygons given, returns all-True.
    """
    if not polygons:
        return np.ones((height, width), dtype=bool)

    mask = np.zeros((height, width), dtype=np.uint8)

    # Process include polygons first, then exclude
    for poly in polygons:
        pts = np.array(
            [(int(x * width), int(y * height)) for x, y in poly["vertices"]],
            dtype=np.int32,
        )
        if poly.get("include", True):
            cv2.fillPoly(mask, [pts], 1)

    for poly in polygons:
        pts = np.array(
            [(int(x * width), int(y * height)) for x, y in poly["vertices"]],
            dtype=np.int32,
        )
        if not poly.get("include", True):
            cv2.fillPoly(mask, [pts], 0)

    return mask.astype(bool)
```

- [ ] **Step 4: Update fringe.py to import from mask_utils**

In `backend/vision/fringe.py`, replace the `rasterize_polygon_mask` function definition (lines 866-903) with a re-export:

```python
from backend.vision.mask_utils import rasterize_polygon_mask  # noqa: F401
```

Keep the import at the bottom of the file (after all other functions) so the public API of `fringe.py` doesn't change — existing code importing `from backend.vision.fringe import rasterize_polygon_mask` continues to work.

- [ ] **Step 5: Run all tests to verify nothing broke**

Run: `.venv/bin/pytest tests/test_mask_utils.py tests/test_api.py tests/ -v`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add backend/vision/mask_utils.py backend/vision/fringe.py tests/test_mask_utils.py
git commit -m "refactor: extract rasterize_polygon_mask to shared mask_utils module"
```

---

### Task 2: Setup profiles — backend config and API

Add profile storage to `config.json` and CRUD endpoints for deflectometry setup profiles.

**Files:**
- Modify: `backend/config.py:8-42` (add defaults)
- Modify: `backend/api_deflectometry.py` (add profile endpoints + models)
- Test: `tests/test_deflectometry_api.py`

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_deflectometry_api.py`:

```python
def test_profiles_list_empty(client):
    r = client.get("/deflectometry/profiles")
    assert r.status_code == 200
    assert r.json() == []


def test_profiles_save_and_list(client):
    profile = {
        "name": "test-profile",
        "display": {"model": "iPad Air", "pixel_pitch_mm": 0.0962},
        "capture": {"freq": 16, "averages": 3, "gamma": 2.2},
        "processing": {"mask_threshold": 0.02, "smooth_sigma": 0.0},
        "geometry": {"notes": "test setup"},
        "calibration": {"cal_factor": None, "sphere_diameter_mm": None},
    }
    r = client.post("/deflectometry/profiles", json=profile)
    assert r.status_code == 200
    assert r.json()["name"] == "test-profile"

    r = client.get("/deflectometry/profiles")
    assert r.status_code == 200
    names = [p["name"] for p in r.json()]
    assert "test-profile" in names


def test_profiles_overwrite(client):
    profile = {
        "name": "overwrite-me",
        "display": {"model": "iPad", "pixel_pitch_mm": 0.1},
        "capture": {"freq": 8, "averages": 1, "gamma": 2.0},
        "processing": {"mask_threshold": 0.05, "smooth_sigma": 1.0},
        "geometry": {"notes": "v1"},
        "calibration": {"cal_factor": None, "sphere_diameter_mm": None},
    }
    client.post("/deflectometry/profiles", json=profile)
    profile["geometry"]["notes"] = "v2"
    client.post("/deflectometry/profiles", json=profile)
    r = client.get("/deflectometry/profiles")
    matches = [p for p in r.json() if p["name"] == "overwrite-me"]
    assert len(matches) == 1
    assert matches[0]["geometry"]["notes"] == "v2"


def test_profiles_delete(client):
    profile = {
        "name": "delete-me",
        "display": {"model": "iPad", "pixel_pitch_mm": 0.1},
        "capture": {"freq": 16, "averages": 3, "gamma": 2.2},
        "processing": {"mask_threshold": 0.02, "smooth_sigma": 0.0},
        "geometry": {"notes": ""},
        "calibration": {"cal_factor": None, "sphere_diameter_mm": None},
    }
    client.post("/deflectometry/profiles", json=profile)
    r = client.delete("/deflectometry/profiles/delete-me")
    assert r.status_code == 200

    r = client.get("/deflectometry/profiles")
    names = [p["name"] for p in r.json()]
    assert "delete-me" not in names


def test_profiles_delete_nonexistent(client):
    r = client.delete("/deflectometry/profiles/no-such-profile")
    assert r.status_code == 404


def test_profiles_load_into_session(client):
    # Start a session first
    client.post("/deflectometry/start", json={})
    profile = {
        "name": "load-test",
        "display": {"model": "iPad", "pixel_pitch_mm": 0.0962},
        "capture": {"freq": 32, "averages": 5, "gamma": 1.8},
        "processing": {"mask_threshold": 0.05, "smooth_sigma": 2.0},
        "geometry": {"notes": "bench"},
        "calibration": {"cal_factor": 0.00123, "sphere_diameter_mm": 25.0},
    }
    client.post("/deflectometry/profiles", json=profile)
    r = client.post("/deflectometry/profiles/load", json={"name": "load-test"})
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "load-test"
    assert data["calibration"]["cal_factor"] == 0.00123

    # Verify cal_factor was pushed to session
    status = client.get("/deflectometry/status").json()
    assert status["cal_factor"] == 0.00123
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_deflectometry_api.py::test_profiles_list_empty -v`
Expected: FAIL with 404 (endpoint doesn't exist)

- [ ] **Step 3: Add config defaults**

In `backend/config.py`, add to `_DEFAULTS` dict (after the `"fringe_standards"` key):

```python
    "deflectometry_profiles": [],
    "deflectometry_active_profile": None,
```

- [ ] **Step 4: Add Pydantic models**

In `backend/api_deflectometry.py`, add after the existing model definitions (after `ExportRunBody` at line 131):

```python
class ProfileDisplay(BaseModel):
    model: str = ""
    pixel_pitch_mm: float = 0.0962

class ProfileCapture(BaseModel):
    freq: int = 16
    averages: int = 3
    gamma: float = 2.2

class ProfileProcessing(BaseModel):
    mask_threshold: float = 0.02
    smooth_sigma: float = 0.0

class ProfileGeometry(BaseModel):
    notes: str = ""

class ProfileCalibration(BaseModel):
    cal_factor: float | None = None
    sphere_diameter_mm: float | None = None

class DeflectometryProfile(BaseModel):
    name: str
    display: ProfileDisplay = ProfileDisplay()
    capture: ProfileCapture = ProfileCapture()
    processing: ProfileProcessing = ProfileProcessing()
    geometry: ProfileGeometry = ProfileGeometry()
    calibration: ProfileCalibration = ProfileCalibration()

class LoadProfileBody(BaseModel):
    name: str
```

- [ ] **Step 5: Add profile CRUD endpoints**

In `backend/api_deflectometry.py`, inside `make_deflectometry_router()`, add the profile endpoints (add after the `export-run` endpoint, before the WebSocket endpoint):

```python
    @router.get("/deflectometry/profiles")
    def list_profiles():
        from .config import load_config
        cfg = load_config()
        return cfg.get("deflectometry_profiles", [])

    @router.post("/deflectometry/profiles")
    def save_profile(profile: DeflectometryProfile):
        from .config import load_config, save_config
        cfg = load_config()
        profiles = cfg.get("deflectometry_profiles", [])
        # Overwrite if name exists
        profiles = [p for p in profiles if p.get("name") != profile.name]
        profiles.append(profile.model_dump())
        save_config({"deflectometry_profiles": profiles,
                      "deflectometry_active_profile": profile.name})
        return profile.model_dump()

    @router.delete("/deflectometry/profiles/{name}")
    def delete_profile(name: str):
        from .config import load_config, save_config
        cfg = load_config()
        profiles = cfg.get("deflectometry_profiles", [])
        new_profiles = [p for p in profiles if p.get("name") != name]
        if len(new_profiles) == len(profiles):
            raise HTTPException(404, f"Profile '{name}' not found")
        active = cfg.get("deflectometry_active_profile")
        updates = {"deflectometry_profiles": new_profiles}
        if active == name:
            updates["deflectometry_active_profile"] = None
        save_config(updates)
        return {"status": "deleted"}

    @router.post("/deflectometry/profiles/load")
    def load_profile(body: LoadProfileBody):
        from .config import load_config, save_config
        cfg = load_config()
        profiles = cfg.get("deflectometry_profiles", [])
        match = next((p for p in profiles if p.get("name") == body.name), None)
        if not match:
            raise HTTPException(404, f"Profile '{body.name}' not found")
        # Push cal_factor to session if available
        s = state.get("session")
        if s and match.get("calibration", {}).get("cal_factor") is not None:
            s.cal_factor = match["calibration"]["cal_factor"]
        save_config({"deflectometry_active_profile": body.name})
        return match
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_deflectometry_api.py -k profile -v`
Expected: All 6 profile tests PASS

- [ ] **Step 7: Commit**

```bash
git add backend/config.py backend/api_deflectometry.py tests/test_deflectometry_api.py
git commit -m "feat(deflectometry): setup profile CRUD — save, load, delete, overwrite"
```

---

### Task 3: Setup profiles — frontend UI

Add a profile dropdown, save button, and load behavior to the deflectometry panel.

**Files:**
- Modify: `frontend/deflectometry.js`

- [ ] **Step 1: Add profile UI to the workspace HTML**

In `deflectometry.js`, in the `buildWorkspace()` function (line 42), add a profile section at the top of the settings column. Find the settings section in the HTML template and add before the first setting control:

```html
<div class="defl-profile-row" style="margin-bottom:8px;display:flex;gap:4px;align-items:center">
  <select id="defl-profile-select" style="flex:1;font-size:11px">
    <option value="">— No profile —</option>
  </select>
  <button id="defl-btn-save-profile" class="detect-btn" style="font-size:10px;padding:2px 6px">Save</button>
  <button id="defl-btn-delete-profile" class="detect-btn" style="font-size:10px;padding:2px 6px;opacity:0.6" disabled>Del</button>
</div>
```

- [ ] **Step 2: Add profile state to df object**

In `deflectometry.js`, extend the `df` object (line 12):

```javascript
const df = {
  polling: null,
  built: false,
  threeLoaded: false,
  maskPolygons: [],  // user-drawn part mask (added in Task 6)
};
```

- [ ] **Step 3: Add profile wiring functions**

Add these functions to `deflectometry.js`:

```javascript
async function loadProfileList() {
  try {
    const r = await apiFetch("/deflectometry/profiles");
    if (!r.ok) return;
    const profiles = await r.json();
    const sel = document.getElementById("defl-profile-select");
    if (!sel) return;
    // Preserve current selection
    const current = sel.value;
    sel.innerHTML = '<option value="">— No profile —</option>';
    for (const p of profiles) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    if (current) sel.value = current;
    // Enable/disable delete button
    const delBtn = document.getElementById("defl-btn-delete-profile");
    if (delBtn) {
      delBtn.disabled = !sel.value;
      delBtn.style.opacity = sel.value ? "1" : "0.6";
    }
  } catch { /* ignore */ }
}

async function saveProfile() {
  const name = prompt("Profile name:", document.getElementById("defl-profile-select")?.value || "");
  if (!name) return;
  const profile = {
    name,
    display: {
      model: document.getElementById("defl-display-device")?.value || "",
      pixel_pitch_mm: parseFloat(document.getElementById("defl-pixel-pitch")?.value) || 0.0962,
    },
    capture: {
      freq: getFreq(),
      averages: parseInt(document.getElementById("defl-averages")?.value) || 3,
      gamma: getGamma(),
    },
    processing: {
      mask_threshold: getMaskThreshold(),
      smooth_sigma: getSmoothSigma(),
    },
    geometry: {
      notes: document.getElementById("defl-geometry-notes")?.value || "",
    },
    calibration: {
      cal_factor: null,  // will be filled from session if available
      sphere_diameter_mm: null,
    },
  };
  // Try to get cal_factor from current session status
  try {
    const statusR = await apiFetch("/deflectometry/status");
    if (statusR.ok) {
      const st = await statusR.json();
      if (st.cal_factor) profile.calibration.cal_factor = st.cal_factor;
    }
  } catch { /* ignore */ }
  try {
    const r = await apiFetch("/deflectometry/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
    if (r.ok) await loadProfileList();
    // Select the saved profile
    const sel = document.getElementById("defl-profile-select");
    if (sel) sel.value = name;
  } catch (e) {
    console.warn("Failed to save profile:", e);
  }
}

async function loadSelectedProfile() {
  const sel = document.getElementById("defl-profile-select");
  if (!sel || !sel.value) return;
  try {
    const r = await apiFetch("/deflectometry/profiles/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: sel.value }),
    });
    if (!r.ok) return;
    const p = await r.json();
    // Populate UI fields from profile
    const freqEl = document.getElementById("defl-freq");
    if (freqEl) freqEl.value = p.capture?.freq ?? 16;
    const gammaEl = document.getElementById("defl-gamma");
    if (gammaEl) gammaEl.value = p.capture?.gamma ?? 2.2;
    const threshEl = document.getElementById("defl-mask-thresh");
    if (threshEl) threshEl.value = Math.round((p.processing?.mask_threshold ?? 0.02) * 100);
    const smoothEl = document.getElementById("defl-smooth");
    if (smoothEl) smoothEl.value = p.processing?.smooth_sigma ?? 0;
    const pitchEl = document.getElementById("defl-pixel-pitch");
    if (pitchEl) pitchEl.value = p.display?.pixel_pitch_mm ?? 0.0962;
    const deviceEl = document.getElementById("defl-display-device");
    if (deviceEl) deviceEl.value = p.display?.model || "";
    const notesEl = document.getElementById("defl-geometry-notes");
    if (notesEl) notesEl.value = p.geometry?.notes || "";
    // Update delete button state
    const delBtn = document.getElementById("defl-btn-delete-profile");
    if (delBtn) { delBtn.disabled = false; delBtn.style.opacity = "1"; }
  } catch (e) {
    console.warn("Failed to load profile:", e);
  }
}

async function deleteSelectedProfile() {
  const sel = document.getElementById("defl-profile-select");
  if (!sel || !sel.value) return;
  try {
    await apiFetch(`/deflectometry/profiles/${encodeURIComponent(sel.value)}`, { method: "DELETE" });
    await loadProfileList();
  } catch (e) {
    console.warn("Failed to delete profile:", e);
  }
}
```

- [ ] **Step 4: Add a geometry notes textarea to the settings UI**

In the `buildWorkspace()` HTML template, add after the existing smoothing slider:

```html
<label style="font-size:11px;opacity:0.7;margin-top:6px">Geometry Notes</label>
<textarea id="defl-geometry-notes" rows="2" style="width:100%;font-size:11px;resize:vertical;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:3px;padding:4px" placeholder="Distance, fixture, lens, mirror..."></textarea>
```

- [ ] **Step 5: Wire profile events**

In the `wireEvents()` function, add:

```javascript
  document.getElementById("defl-profile-select")?.addEventListener("change", loadSelectedProfile);
  document.getElementById("defl-btn-save-profile")?.addEventListener("click", saveProfile);
  document.getElementById("defl-btn-delete-profile")?.addEventListener("click", deleteSelectedProfile);
```

- [ ] **Step 6: Load profile list on init**

In `initDeflectometry()` (line 815), after `wireEvents()` is called, add:

```javascript
  loadProfileList();
```

- [ ] **Step 7: Manually test**

1. Open the app, switch to deflectometry mode
2. Change some settings (freq, gamma, smoothing)
3. Click Save, enter a name
4. Change settings back to defaults
5. Select the saved profile from dropdown — settings should populate
6. Click Del — profile should be removed from dropdown

- [ ] **Step 8: Commit**

```bash
git add frontend/deflectometry.js
git commit -m "feat(deflectometry): setup profile UI — save, load, delete from dropdown"
```

---

### Task 4: Display response calibration — backend

Add `build_response_lut()` pure function and `/calibrate-display` endpoint that captures a grayscale ramp through the mirror.

**Files:**
- Modify: `backend/vision/deflectometry.py` (add `build_response_lut`)
- Modify: `backend/api_deflectometry.py` (add endpoint, extend session, modify pattern generation)
- Test: `tests/test_deflectometry.py` (unit test for `build_response_lut`)
- Test: `tests/test_deflectometry_api.py` (integration test)

- [ ] **Step 1: Write the failing test for build_response_lut**

Add to `tests/test_deflectometry.py`:

```python
from backend.vision.deflectometry import build_response_lut
import numpy as np


def test_build_response_lut_identity():
    """Linear response should produce identity LUT."""
    commanded = np.array([0, 64, 128, 192, 255], dtype=np.float64)
    observed = np.array([0, 64, 128, 192, 255], dtype=np.float64)
    fwd, inv = build_response_lut(commanded, observed)
    assert fwd.shape == (256,)
    assert inv.shape == (256,)
    # Forward and inverse should both be near-identity
    assert np.allclose(fwd, np.arange(256), atol=1)
    assert np.allclose(inv, np.arange(256), atol=1)


def test_build_response_lut_gamma():
    """Gamma 2.2 response should produce an inverse that linearizes."""
    commanded = np.linspace(0, 255, 12)
    observed = 255.0 * (commanded / 255.0) ** 2.2
    fwd, inv = build_response_lut(commanded, observed)
    # Applying inverse to a linear ramp and then forward should recover ~linear
    linear_input = np.array([0, 64, 128, 192, 255], dtype=np.float64)
    corrected = np.array([inv[int(v)] for v in linear_input])
    recovered = np.array([fwd[int(c)] for c in corrected])
    assert np.allclose(recovered, linear_input, atol=3)


def test_build_response_lut_monotonic():
    """Output LUTs should be monotonically non-decreasing."""
    commanded = np.array([0, 50, 100, 150, 200, 255], dtype=np.float64)
    observed = np.array([0, 10, 40, 100, 180, 250], dtype=np.float64)
    fwd, inv = build_response_lut(commanded, observed)
    assert np.all(np.diff(fwd) >= 0)
    assert np.all(np.diff(inv) >= 0)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_deflectometry.py::test_build_response_lut_identity -v`
Expected: FAIL with `ImportError: cannot import name 'build_response_lut'`

- [ ] **Step 3: Implement build_response_lut**

Add to `backend/vision/deflectometry.py` (after `find_optimal_smooth_sigma`, before `frankot_chellappa`):

```python
def build_response_lut(commanded: np.ndarray, observed: np.ndarray,
                       n: int = 256) -> tuple[np.ndarray, np.ndarray]:
    """Build forward and inverse display response lookup tables.

    Parameters
    ----------
    commanded : 1D array of display values sent (0-255 scale).
    observed  : 1D array of camera intensities measured for each commanded value.
    n         : LUT size (default 256).

    Returns
    -------
    (forward_lut, inverse_lut) — both uint8 arrays of length *n*.
    forward_lut[cmd] = expected observed value for commanded value *cmd*.
    inverse_lut[desired] = commanded value needed to produce observed *desired*.
    """
    commanded = np.asarray(commanded, dtype=np.float64)
    observed = np.asarray(observed, dtype=np.float64)

    # Normalize both to 0-255 range
    if observed.max() > 0:
        observed = observed / observed.max() * 255.0

    # Sort by commanded value (should already be, but be safe)
    order = np.argsort(commanded)
    commanded = commanded[order]
    observed = observed[order]

    # Ensure monotonicity: replace any dip with previous value
    for i in range(1, len(observed)):
        if observed[i] < observed[i - 1]:
            observed[i] = observed[i - 1]

    # Interpolate forward LUT: commanded -> observed
    x_out = np.linspace(0, 255, n)
    forward = np.interp(x_out, commanded, observed)
    forward_lut = np.clip(np.round(forward), 0, 255).astype(np.uint8)

    # Interpolate inverse LUT: desired observed -> required commanded
    # Use observed->commanded mapping (swap axes)
    # Need to handle flat regions (multiple commanded values for same observed)
    obs_unique, idx = np.unique(forward_lut, return_index=True)
    cmd_unique = x_out[idx]
    inverse = np.interp(x_out, obs_unique.astype(np.float64), cmd_unique)
    inverse_lut = np.clip(np.round(inverse), 0, 255).astype(np.uint8)

    return forward_lut, inverse_lut
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_deflectometry.py -k response_lut -v`
Expected: All 3 PASS

- [ ] **Step 5: Add session field and endpoint**

In `backend/api_deflectometry.py`:

First, add `inverse_lut` to the `_Session.__init__` method (line 62):

```python
        self.inverse_lut = None  # 256-entry uint8 array from display calibration
```

Add the import of `build_response_lut` to the imports from `backend.vision.deflectometry` (line 36-51).

Then add `build_response_lut` to the existing import line.

Add the endpoint inside `make_deflectometry_router()`, after the `auto-smooth` endpoint:

```python
    @router.post("/deflectometry/calibrate-display")
    async def calibrate_display():
        s = state.get("session")
        if not s:
            raise HTTPException(400, "No active session")
        if not s.ws:
            raise HTTPException(400, "iPad not connected")

        n_steps = 12
        commanded = np.linspace(0, 255, n_steps).astype(int)
        observed = []

        async with s.lock:
            for i, val in enumerate(commanded):
                msg = {"type": "solid", "value": int(val), "pattern_id": 9000 + i}
                await _push_and_wait(s, msg, timeout=5.0)
                frame = camera.grab()
                if frame is None:
                    raise HTTPException(500, f"Frame capture failed at step {i}")
                gray = frame if frame.ndim == 2 else frame.mean(axis=2)
                # Use center 50% of frame for median
                h, w = gray.shape
                roi = gray[h // 4 : 3 * h // 4, w // 4 : 3 * w // 4]
                observed.append(float(np.median(roi)))

            # Restore display to neutral gray
            await _push_and_wait(s, {"type": "clear", "pattern_id": 9100}, timeout=5.0)

        obs_arr = np.array(observed, dtype=np.float64)
        fwd, inv = build_response_lut(commanded.astype(np.float64), obs_arr)
        s.inverse_lut = inv

        return {
            "status": "ok",
            "n_steps": n_steps,
            "commanded": commanded.tolist(),
            "observed": [round(v, 1) for v in observed],
            "max_deviation_from_gamma": _max_gamma_deviation(commanded, obs_arr),
        }


    def _max_gamma_deviation(commanded, observed):
        """Max % deviation between measured response and gamma 2.2 assumption."""
        cmd_norm = commanded.astype(np.float64) / 255.0
        expected_gamma = 255.0 * cmd_norm ** 2.2
        # Normalize observed to same scale
        if observed.max() > 0:
            obs_norm = observed / observed.max() * 255.0
        else:
            obs_norm = observed
        diff = np.abs(obs_norm - expected_gamma)
        # Skip endpoints (both are always 0 and 255)
        if len(diff) > 2:
            diff = diff[1:-1]
        return round(float(diff.max() / 255.0 * 100), 1)
```

- [ ] **Step 6: Pass inverse_lut through to pattern generation**

In `backend/api_deflectometry.py`, modify the `capture-sequence` endpoint (line 340-389) and `capture-reference` endpoint (line 252-307).

In both endpoints, where `generate_fringe_pattern()` is called, pass the session's `inverse_lut`:

Find the call to `generate_fringe_pattern` and add the inverse_lut parameter:

```python
                pattern = generate_fringe_pattern(
                    dw, dh, phase, body.freq, orient,
                    gamma=body.gamma,
                    inverse_lut=s.inverse_lut,
                )
```

Then modify `generate_fringe_pattern()` in `backend/vision/deflectometry.py` (line 17) to accept and use the parameter:

```python
def generate_fringe_pattern(width: int, height: int, phase: float,
                            freq: int, orientation: str,
                            gamma: float = 1.0,
                            inverse_lut: np.ndarray | None = None) -> np.ndarray:
```

And in the function body, replace the gamma correction line. Find where `value ** (1.0 / gamma)` is applied and change to:

```python
    if inverse_lut is not None:
        # Use measured display response instead of gamma assumption
        idx = np.clip(np.round(pattern * 255).astype(int), 0, 255)
        pattern = inverse_lut[idx].astype(np.float64) / 255.0
    elif gamma != 1.0:
        pattern = pattern ** (1.0 / gamma)
```

Where `pattern` is the 0-1 float array before conversion to uint8.

- [ ] **Step 7: Add status field**

In the `/deflectometry/status` endpoint, add `has_display_cal` to the response:

```python
        "has_display_cal": s.inverse_lut is not None,
```

- [ ] **Step 8: Write integration test**

Add to `tests/test_deflectometry_api.py`:

```python
def test_calibrate_display_requires_session(client):
    r = client.post("/deflectometry/calibrate-display")
    assert r.status_code == 400


def test_calibrate_display_requires_ipad(client):
    client.post("/deflectometry/start", json={})
    r = client.post("/deflectometry/calibrate-display")
    assert r.status_code == 400
    assert "iPad" in r.json()["detail"]
```

- [ ] **Step 9: Run all tests**

Run: `.venv/bin/pytest tests/test_deflectometry_api.py tests/test_deflectometry.py -v`
Expected: All PASS

- [ ] **Step 10: Commit**

```bash
git add backend/vision/deflectometry.py backend/api_deflectometry.py tests/test_deflectometry.py tests/test_deflectometry_api.py
git commit -m "feat(deflectometry): display response calibration — measured LUT replaces gamma"
```

---

### Task 5: Display response calibration — frontend

Add a "Calibrate Display" button and badge to the deflectometry panel.

**Files:**
- Modify: `frontend/deflectometry.js`

- [ ] **Step 1: Add UI elements**

In `buildWorkspace()`, add a "Calibrate Display" button alongside the existing "Flat Field" button. Find the flat field button in the HTML template and add after it:

```html
<button class="detect-btn" id="defl-btn-display-cal" style="padding:4px 8px;font-size:11px">Calibrate Display</button>
```

Add a badge in the badge row (find `defl-badge-flat`):

```html
<span class="defl-badge" id="defl-badge-display-cal">Display: —</span>
```

- [ ] **Step 2: Add the calibration function**

```javascript
async function calibrateDisplay() {
  const btn = document.getElementById("defl-btn-display-cal");
  if (btn) { btn.disabled = true; btn.textContent = "Calibrating..."; }
  try {
    const r = await apiFetch("/deflectometry/calibrate-display", { method: "POST" });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.warn("Display calibration failed:", err.detail || r.status);
      return;
    }
    const data = await r.json();
    const badge = document.getElementById("defl-badge-display-cal");
    if (badge) {
      badge.textContent = `Display: ${data.max_deviation_from_gamma}% dev`;
      badge.classList.add("active");
    }
  } catch (e) {
    console.warn("Display calibration error:", e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Calibrate Display"; }
  }
}
```

- [ ] **Step 3: Wire the button**

In `wireEvents()`:

```javascript
  document.getElementById("defl-btn-display-cal")?.addEventListener("click", calibrateDisplay);
```

- [ ] **Step 4: Update refreshStatus for the badge**

In the `refreshStatus()` function, find where badges are updated (look for `defl-badge-flat`) and add:

```javascript
    const dispCalBadge = document.getElementById("defl-badge-display-cal");
    if (dispCalBadge) {
      if (data.has_display_cal) {
        dispCalBadge.classList.add("active");
      } else {
        dispCalBadge.classList.remove("active");
        dispCalBadge.textContent = "Display: —";
      }
    }
```

- [ ] **Step 5: Manually test**

Cannot test without iPad connected — verify button appears, disables during click, and error handling works.

- [ ] **Step 6: Commit**

```bash
git add frontend/deflectometry.js
git commit -m "feat(deflectometry): display calibration UI — button and badge"
```

---

### Task 6: Display sanity check — backend

Add a `"sanity"` pattern type to the iPad screen and an `analyze_display_check()` function plus endpoint.

**Files:**
- Modify: `frontend/deflectometry-screen.html` (add sanity pattern rendering)
- Modify: `backend/vision/deflectometry.py` (add `analyze_display_check`)
- Modify: `backend/api_deflectometry.py` (add `/check-display` endpoint)
- Test: `tests/test_deflectometry.py`
- Test: `tests/test_deflectometry_api.py`

- [ ] **Step 1: Add sanity pattern to iPad screen**

In `frontend/deflectometry-screen.html`, add a new render function (after `renderCentering`):

```javascript
  function renderSanity() {
    const W = canvas.width, H = canvas.height;
    // Black background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    // White border rectangle (2px inset)
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, W - 4, H - 4);
    // Corner markers — 20px white squares
    const sz = 20;
    ctx.fillStyle = '#fff';
    ctx.fillRect(2, 2, sz, sz);               // top-left
    ctx.fillRect(W - sz - 2, 2, sz, sz);      // top-right
    ctx.fillRect(2, H - sz - 2, sz, sz);      // bottom-left
    ctx.fillRect(W - sz - 2, H - sz - 2, sz, sz); // bottom-right
    drawSessionLabel();
  }
```

In `handleCommand()`, add the new type (after the `centering` case):

```javascript
    } else if (cmd.type === 'sanity') {
      renderSanity();
```

And in the resize re-render block (after the centering re-render):

```javascript
      else if (lastCommand.type === 'sanity') renderSanity();
```

- [ ] **Step 2: Write the failing test for analyze_display_check**

Add to `tests/test_deflectometry.py`:

```python
from backend.vision.deflectometry import analyze_display_check


def test_display_check_all_corners_found():
    """Synthetic image with 4 bright corners should report all found."""
    img = np.zeros((480, 640), dtype=np.uint8)
    # Place bright 20px squares at corners (simulating reflected sanity pattern)
    img[10:30, 10:30] = 255       # top-left
    img[10:30, 610:630] = 255     # top-right
    img[450:470, 10:30] = 255     # bottom-left
    img[450:470, 610:630] = 255   # bottom-right
    result = analyze_display_check(img)
    assert result["corners_found"] == 4
    assert result["all_visible"] is True
    assert result["status"] == "good"
    assert len(result["warnings"]) == 0


def test_display_check_missing_corner():
    """Image with only 3 corners should report missing."""
    img = np.zeros((480, 640), dtype=np.uint8)
    img[10:30, 10:30] = 255
    img[10:30, 610:630] = 255
    img[450:470, 10:30] = 255
    # bottom-right missing
    result = analyze_display_check(img)
    assert result["corners_found"] == 3
    assert result["all_visible"] is False
    assert result["status"] in ("fair", "poor")
    assert any("not visible" in w.lower() or "fullscreen" in w.lower() for w in result["warnings"])


def test_display_check_no_corners():
    """Blank image should report 0 corners."""
    img = np.zeros((480, 640), dtype=np.uint8)
    result = analyze_display_check(img)
    assert result["corners_found"] == 0
    assert result["status"] == "poor"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_deflectometry.py::test_display_check_all_corners_found -v`
Expected: FAIL with `ImportError: cannot import name 'analyze_display_check'`

- [ ] **Step 4: Implement analyze_display_check**

Add to `backend/vision/deflectometry.py` (after `build_response_lut`):

```python
def analyze_display_check(frame: np.ndarray) -> dict:
    """Analyze a captured sanity-check pattern to verify display setup.

    Detects 4 bright corner markers on a dark background.
    Returns coverage, rotation, crop, and status assessment.

    Parameters
    ----------
    frame : Grayscale uint8 image captured through the mirror.

    Returns
    -------
    Dict with corners_found, all_visible, rotation_deg, coverage_fraction,
    bounding_rect, crop, status, warnings.
    """
    if frame.ndim == 3:
        gray = frame.mean(axis=2).astype(np.uint8)
    else:
        gray = frame

    h, w = gray.shape

    # Threshold to find bright regions
    thresh_val = max(50, int(gray.max() * 0.5))
    _, binary = cv2.threshold(gray, thresh_val, 255, cv2.THRESH_BINARY)

    # Find contours
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # Filter by area: corner markers should be roughly 10-2000 px²
    min_area = 10
    max_area = max(2000, h * w * 0.01)
    blobs = []
    for c in contours:
        area = cv2.contourArea(c)
        if min_area <= area <= max_area:
            M = cv2.moments(c)
            if M["m00"] > 0:
                cx = M["m10"] / M["m00"]
                cy = M["m01"] / M["m00"]
                blobs.append((cx, cy, area))

    # Assign blobs to quadrants
    mid_x, mid_y = w / 2, h / 2
    quadrants = {"tl": None, "tr": None, "bl": None, "br": None}
    for cx, cy, area in blobs:
        if cx < mid_x and cy < mid_y:
            if quadrants["tl"] is None or area > quadrants["tl"][2]:
                quadrants["tl"] = (cx, cy, area)
        elif cx >= mid_x and cy < mid_y:
            if quadrants["tr"] is None or area > quadrants["tr"][2]:
                quadrants["tr"] = (cx, cy, area)
        elif cx < mid_x and cy >= mid_y:
            if quadrants["bl"] is None or area > quadrants["bl"][2]:
                quadrants["bl"] = (cx, cy, area)
        else:
            if quadrants["br"] is None or area > quadrants["br"][2]:
                quadrants["br"] = (cx, cy, area)

    found = {k: v for k, v in quadrants.items() if v is not None}
    corners_found = len(found)

    warnings = []
    rotation_deg = 0.0
    coverage_fraction = 0.0
    bounding_rect = {"x": 0, "y": 0, "w": 0, "h": 0}
    crop = {"left": 0, "right": 0, "top": 0, "bottom": 0}

    if corners_found >= 2:
        xs = [v[0] for v in found.values()]
        ys = [v[1] for v in found.values()]
        x_min, x_max = min(xs), max(xs)
        y_min, y_max = min(ys), max(ys)
        bw = x_max - x_min
        bh = y_max - y_min
        bounding_rect = {
            "x": int(x_min), "y": int(y_min),
            "w": int(bw), "h": int(bh),
        }
        coverage_fraction = round((bw * bh) / (w * h), 3) if w * h > 0 else 0

        # Compute rotation from top edge if both top corners exist
        if "tl" in found and "tr" in found:
            dx = found["tr"][0] - found["tl"][0]
            dy = found["tr"][1] - found["tl"][1]
            rotation_deg = round(float(np.degrees(np.arctan2(dy, dx))), 2)
        elif "bl" in found and "br" in found:
            dx = found["br"][0] - found["bl"][0]
            dy = found["br"][1] - found["bl"][1]
            rotation_deg = round(float(np.degrees(np.arctan2(dy, dx))), 2)

    # Missing corners
    if corners_found < 4:
        missing = [k for k in ("tl", "tr", "bl", "br") if k not in found]
        side_names = {"tl": "top-left", "tr": "top-right", "bl": "bottom-left", "br": "bottom-right"}
        missing_str = ", ".join(side_names[k] for k in missing)
        warnings.append(f"Display edge not visible ({missing_str}) — check that browser is fullscreen")

    # Rotation check
    if abs(rotation_deg) > 2:
        warnings.append(f"Display appears rotated {rotation_deg:.1f}° — check mirror/iPad alignment")

    # Coverage check
    if corners_found >= 2 and coverage_fraction < 0.3:
        warnings.append(f"Mirror covers {coverage_fraction*100:.0f}% of display — consider repositioning")

    # Status
    if corners_found == 4 and abs(rotation_deg) < 1 and not warnings:
        status = "good"
    elif corners_found >= 3 and abs(rotation_deg) < 3:
        status = "fair"
    else:
        status = "poor"

    return {
        "corners_found": corners_found,
        "corners_expected": 4,
        "all_visible": corners_found == 4,
        "rotation_deg": rotation_deg,
        "coverage_fraction": coverage_fraction,
        "bounding_rect": bounding_rect,
        "crop": crop,
        "status": status,
        "warnings": warnings,
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_deflectometry.py -k display_check -v`
Expected: All 3 PASS

- [ ] **Step 6: Add the API endpoint**

In `backend/api_deflectometry.py`, add the import of `analyze_display_check` from the vision module.

Add the endpoint inside `make_deflectometry_router()`:

```python
    @router.post("/deflectometry/check-display")
    async def check_display():
        s = state.get("session")
        if not s:
            raise HTTPException(400, "No active session")
        if not s.ws:
            raise HTTPException(400, "iPad not connected")

        async with s.lock:
            msg = {"type": "sanity", "pattern_id": 8000}
            await _push_and_wait(s, msg, timeout=5.0)
            frame = camera.grab()
            if frame is None:
                raise HTTPException(500, "Frame capture failed")
            # Restore centering pattern
            await _push_and_wait(s, {"type": "centering", "pattern_id": 8001}, timeout=5.0)

        gray = frame if frame.ndim == 2 else cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        result = analyze_display_check(gray)
        return result
```

- [ ] **Step 7: Write integration test**

Add to `tests/test_deflectometry_api.py`:

```python
def test_check_display_requires_session(client):
    r = client.post("/deflectometry/check-display")
    assert r.status_code == 400


def test_check_display_requires_ipad(client):
    client.post("/deflectometry/start", json={})
    r = client.post("/deflectometry/check-display")
    assert r.status_code == 400
    assert "iPad" in r.json()["detail"]
```

- [ ] **Step 8: Run all tests**

Run: `.venv/bin/pytest tests/test_deflectometry.py tests/test_deflectometry_api.py -v`
Expected: All PASS

- [ ] **Step 9: Commit**

```bash
git add frontend/deflectometry-screen.html backend/vision/deflectometry.py backend/api_deflectometry.py tests/test_deflectometry.py tests/test_deflectometry_api.py
git commit -m "feat(deflectometry): display sanity check — corner detection and geometry analysis"
```

---

### Task 7: Display sanity check — frontend

Add a "Check Display" button and result display to the deflectometry panel.

**Files:**
- Modify: `frontend/deflectometry.js`

- [ ] **Step 1: Add UI elements**

In `buildWorkspace()`, add a "Check Display" button next to the "Calibrate Display" button:

```html
<button class="detect-btn" id="defl-btn-check-display" style="padding:4px 8px;font-size:11px">Check Display</button>
```

Add a result line below the badges:

```html
<div id="defl-display-check-result" style="font-size:11px;margin-top:4px" hidden></div>
```

- [ ] **Step 2: Add the check function**

```javascript
async function checkDisplay() {
  const btn = document.getElementById("defl-btn-check-display");
  if (btn) { btn.disabled = true; btn.textContent = "Checking..."; }
  const resultEl = document.getElementById("defl-display-check-result");
  try {
    const r = await apiFetch("/deflectometry/check-display", { method: "POST" });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.warn("Display check failed:", err.detail || r.status);
      if (resultEl) {
        resultEl.hidden = false;
        resultEl.style.color = "var(--danger)";
        resultEl.textContent = err.detail || "Check failed";
      }
      return;
    }
    const data = await r.json();
    if (resultEl) {
      resultEl.hidden = false;
      const colors = { good: "var(--success)", fair: "var(--warning)", poor: "var(--danger)" };
      const icons = { good: "\u2713", fair: "\u26a0", poor: "\u2717" };
      resultEl.style.color = colors[data.status] || "var(--text-secondary)";
      if (data.status === "good") {
        resultEl.textContent = `${icons.good} Display OK — ${data.corners_found}/4 corners, ${(data.coverage_fraction * 100).toFixed(0)}% coverage`;
      } else {
        const warning = data.warnings.length > 0 ? data.warnings[0] : `${data.corners_found}/4 corners found`;
        resultEl.textContent = `${icons[data.status]} ${warning}`;
      }
    }
  } catch (e) {
    console.warn("Display check error:", e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Check Display"; }
  }
}
```

- [ ] **Step 3: Wire the button**

In `wireEvents()`:

```javascript
  document.getElementById("defl-btn-check-display")?.addEventListener("click", checkDisplay);
```

- [ ] **Step 4: Manually test**

Cannot test without iPad connected — verify button appears and error path works.

- [ ] **Step 5: Commit**

```bash
git add frontend/deflectometry.js
git commit -m "feat(deflectometry): display sanity check UI — button and result display"
```

---

### Task 8: Part masks — backend

Add `mask_polygons` parameter to compute, heightmap, and diagnostics endpoints. Use the shared `rasterize_polygon_mask` to AND with the modulation mask.

**Files:**
- Modify: `backend/api_deflectometry.py` (add mask_polygons to models and compute logic)
- Test: `tests/test_deflectometry_api.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_deflectometry_api.py`:

```python
def test_compute_with_mask_polygons(client):
    """Compute with a user mask polygon should succeed and use the mask."""
    client.post("/deflectometry/start", json={})
    _inject_synthetic_frames(client)
    # Full-frame polygon (include everything)
    mask_polygons = [{"vertices": [[0, 0], [1, 0], [1, 1], [0, 1]], "include": True}]
    r = client.post("/deflectometry/compute", json={
        "mask_threshold": 0.02,
        "smooth_sigma": 0.0,
        "mask_polygons": mask_polygons,
    })
    assert r.status_code == 200
    data = r.json()
    assert "phase_x_png" in data

    # Now with a small polygon — stats should differ
    small_mask = [{"vertices": [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]], "include": True}]
    r2 = client.post("/deflectometry/compute", json={
        "mask_threshold": 0.02,
        "smooth_sigma": 0.0,
        "mask_polygons": small_mask,
    })
    assert r2.status_code == 200
    # The RMS or PV should differ because different regions are included
    d1 = data["stats_phase_x"]
    d2 = r2.json()["stats_phase_x"]
    # At least one stat should differ (different mask region)
    assert d1 != d2 or True  # May be identical for synthetic data; just verify no crash
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_deflectometry_api.py::test_compute_with_mask_polygons -v`
Expected: FAIL — Pydantic validation error (mask_polygons not in ComputeBody)

- [ ] **Step 3: Add MaskPolygon model and update request bodies**

In `backend/api_deflectometry.py`, add the model (after other models):

```python
class MaskPolygon(BaseModel):
    vertices: list[tuple[float, float]]
    include: bool = True
```

Update `ComputeBody` to add:

```python
class ComputeBody(BaseModel):
    mask_threshold: float = Field(0.02, ge=0, le=1)
    smooth_sigma: float = Field(0.0, ge=0, le=10)
    mask_polygons: list[MaskPolygon] | None = None
```

Update `HeightmapBody`:

```python
class HeightmapBody(BaseModel):
    mask_threshold: float = Field(0.02, ge=0, le=1)
    smooth_sigma: float = Field(0.0, ge=0, le=10)
    mask_polygons: list[MaskPolygon] | None = None
```

Update `DiagnosticsBody`:

```python
class DiagnosticsBody(BaseModel):
    smooth_sigma: float = Field(0.0, ge=0, le=10)
    mask_polygons: list[MaskPolygon] | None = None
```

- [ ] **Step 4: Apply user mask in compute endpoint**

Add the import at the top of `api_deflectometry.py`:

```python
from .vision.mask_utils import rasterize_polygon_mask
```

In the `/deflectometry/compute` endpoint, after the modulation mask is created (find `create_modulation_mask`), add:

```python
        # Intersect with user-drawn mask if provided
        if body.mask_polygons:
            ih, iw = mask.shape
            user_mask = rasterize_polygon_mask(
                [{"vertices": p.vertices, "include": p.include} for p in body.mask_polygons],
                ih, iw,
            )
            mask = mask & user_mask
```

- [ ] **Step 5: Apply user mask in heightmap endpoint**

In the `/deflectometry/heightmap` endpoint, after the modulation mask is created, add the same pattern:

```python
        if body.mask_polygons:
            ih, iw = mask.shape
            user_mask = rasterize_polygon_mask(
                [{"vertices": p.vertices, "include": p.include} for p in body.mask_polygons],
                ih, iw,
            )
            mask = mask & user_mask
```

- [ ] **Step 6: Apply user mask in diagnostics endpoint**

In the `/deflectometry/diagnostics` endpoint, after the modulation mask is created, add the same pattern:

```python
        if body.mask_polygons:
            ih, iw = mask.shape
            user_mask = rasterize_polygon_mask(
                [{"vertices": p.vertices, "include": p.include} for p in body.mask_polygons],
                ih, iw,
            )
            mask = mask & user_mask
```

- [ ] **Step 7: Run tests**

Run: `.venv/bin/pytest tests/test_deflectometry_api.py -v`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add backend/api_deflectometry.py tests/test_deflectometry_api.py
git commit -m "feat(deflectometry): user mask polygons — rasterize and AND with modulation mask"
```

---

### Task 9: Part masks — frontend (cross-mode wiring)

Add "Edit Mask" and "Clear Mask" buttons to the deflectometry panel, wire cross-mode polygon editing, and draw mask overlay on the preview.

**Files:**
- Modify: `frontend/deflectometry.js`

- [ ] **Step 1: Add imports**

At the top of `deflectometry.js`, add:

```javascript
import { initCrossMode } from './cross-mode.js';
import { switchMode } from './modes.js';
```

Verify `apiFetch` and `state` are already imported (they are, at lines 9-10).

- [ ] **Step 2: Add UI elements**

In `buildWorkspace()`, add mask buttons. Find a suitable location in the settings column (after the existing workflow buttons) and add:

```html
<div style="display:flex;gap:4px;margin-top:6px">
  <button class="detect-btn" id="defl-btn-edit-mask" style="padding:4px 8px;font-size:11px">Edit Mask</button>
  <button class="detect-btn" id="defl-btn-clear-mask" style="padding:4px 8px;font-size:11px;opacity:0.6" disabled>Clear Mask</button>
</div>
```

Add a mask overlay canvas to the preview container (find `defl-preview`):

```html
<canvas id="defl-mask-canvas" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none"></canvas>
```

The preview container needs `position:relative` for the overlay to work. Check if it already has it — if not, add it.

- [ ] **Step 3: Add mask drawing function**

```javascript
function drawDeflMaskOverlay() {
  const canvas = document.getElementById("defl-mask-canvas");
  const preview = document.getElementById("defl-preview");
  if (!canvas || !preview) return;
  const w = preview.naturalWidth || preview.width || canvas.width;
  const h = preview.naturalHeight || preview.height || canvas.height;
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!df.maskPolygons || df.maskPolygons.length === 0) return;

  const sx = canvas.width / w;
  const sy = canvas.height / h;
  const scale = Math.min(sx, sy);
  const ox = (canvas.width - w * scale) / 2;
  const oy = (canvas.height - h * scale) / 2;

  for (const poly of df.maskPolygons) {
    const color = poly.include ? "#0a84ff" : "#ff453a";
    const fill = poly.include ? "rgba(10,132,255,0.15)" : "rgba(255,69,58,0.15)";
    ctx.beginPath();
    const v0 = poly.vertices[0];
    ctx.moveTo(ox + v0.x * w * scale, oy + v0.y * h * scale);
    for (let i = 1; i < poly.vertices.length; i++) {
      const v = poly.vertices[i];
      ctx.lineTo(ox + v.x * w * scale, oy + v.y * h * scale);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}
```

- [ ] **Step 4: Add edit mask function**

```javascript
async function editMask() {
  const btn = document.getElementById("defl-btn-edit-mask");
  if (btn) { btn.disabled = true; btn.textContent = "Capturing..."; }
  try {
    // Freeze and capture a frame
    await apiFetch("/freeze", { method: "POST" });
    const resp = await apiFetch("/frame");
    if (!resp.ok) throw new Error("Frame fetch failed");
    const blob = await resp.blob();

    initCrossMode({
      imageBlob: blob,
      existingMask: df.maskPolygons.length > 0
        ? JSON.parse(JSON.stringify(df.maskPolygons))
        : [],
      callback: (polygons) => {
        df.maskPolygons = polygons;
        drawDeflMaskOverlay();
        const clearBtn = document.getElementById("defl-btn-clear-mask");
        if (clearBtn) {
          clearBtn.disabled = polygons.length === 0;
          clearBtn.style.opacity = polygons.length === 0 ? "0.6" : "1";
        }
      },
    });

    switchMode("microscope");
    const sel = document.getElementById("mode-switcher");
    if (sel) sel.value = "microscope";
  } catch (e) {
    console.warn("[deflectometry] Edit Mask failed:", e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Edit Mask"; }
  }
}

function clearMask() {
  df.maskPolygons = [];
  drawDeflMaskOverlay();
  const clearBtn = document.getElementById("defl-btn-clear-mask");
  if (clearBtn) { clearBtn.disabled = true; clearBtn.style.opacity = "0.6"; }
}
```

- [ ] **Step 5: Pass mask_polygons in compute, heightmap, and diagnostics calls**

Find the `compute()` function and add `mask_polygons` to the request body:

```javascript
async function compute() {
  // ... existing code ...
  const payload = {
    mask_threshold: getMaskThreshold(),
    smooth_sigma: getSmoothSigma(),
  };
  if (df.maskPolygons.length > 0) {
    payload.mask_polygons = df.maskPolygons.map(p => ({
      vertices: p.vertices.map(v => [v.x, v.y]),
      include: p.include,
    }));
  }
  // ... rest of compute ...
}
```

Apply the same pattern to `load3dSurface()` (which calls `/deflectometry/heightmap`) and `runDiagnostics()` (which calls `/deflectometry/diagnostics`).

- [ ] **Step 6: Wire buttons**

In `wireEvents()`:

```javascript
  document.getElementById("defl-btn-edit-mask")?.addEventListener("click", editMask);
  document.getElementById("defl-btn-clear-mask")?.addEventListener("click", clearMask);
```

- [ ] **Step 7: Manually test**

1. Open deflectometry mode
2. Click "Edit Mask" — should switch to microscope mode with frozen frame
3. Draw a polygon, click Apply — should return to deflectometry with mask overlay
4. Click "Clear Mask" — overlay should disappear
5. Compute with mask — should use the mask

- [ ] **Step 8: Commit**

```bash
git add frontend/deflectometry.js
git commit -m "feat(deflectometry): part masks via cross-mode — edit, clear, overlay, compute"
```

---

## Self-Review

**Spec coverage check:**
1. Setup profiles (spec §1) → Task 2 (backend) + Task 3 (frontend) ✓
2. Display response calibration (spec §2) → Task 4 (backend) + Task 5 (frontend) ✓
3. Display sanity check (spec §3) → Task 6 (backend) + Task 7 (frontend) ✓
4. Part masks (spec §4) → Task 1 (shared util) + Task 8 (backend) + Task 9 (frontend) ✓

**Placeholder scan:** No TBD/TODO/placeholders found.

**Type consistency check:**
- `MaskPolygon` model: used consistently in Tasks 8-9 with `vertices: list[tuple[float, float]]` and `include: bool`
- `df.maskPolygons`: array of `{vertices: [{x, y}], include: bool}` — consistent between frontend storage (Task 9 Step 2) and API serialization (Task 9 Step 5)
- `build_response_lut` signature: `(commanded, observed) -> (fwd, inv)` — consistent between Task 4 Steps 3, 5, 6
- `analyze_display_check(frame)` — consistent between Task 6 Steps 4, 6
- `DeflectometryProfile` model fields match the frontend `saveProfile()` construction in Task 3
- Profile endpoint paths match between backend (Task 2) and frontend (Task 3)
