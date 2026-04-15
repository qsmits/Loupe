# Fringe Lens Distortion Correction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply Brown-Conrady k1 lens distortion correction to the fringe analysis pipeline, with per-setup profile management and cross-mode calibration.

**Spec:** `docs/superpowers/specs/2026-04-15-fringe-lens-correction-design.md`

**Key invariant:** The frontend stores k1 in normalized form. Denormalization: `k1_raw = k1_norm / ((w^2 + h^2) / 4)`. The backend must apply this same conversion. The existing `lens-cal.js` golden-section search operates in this normalized space (range [-0.8, 0.8]).

---

### Task 1: Backend undistort function + unit tests

**Files:**
- Edit: `backend/vision/fringe.py`
- Edit: `tests/test_fringe.py`

Pure computation, no API or frontend changes. Add a helper function and wire it into `analyze_interferogram()`.

- [ ] **Step 1: Add `undistort_frame()` helper to `backend/vision/fringe.py`**

  Add near the top of the file (after imports), before the pipeline functions:

  ```python
  def undistort_frame(img: np.ndarray, lens_k1: float) -> np.ndarray:
      """Apply Brown-Conrady k1 radial undistortion.

      Parameters
      ----------
      img : 2D grayscale image (float64 or uint8).
      lens_k1 : normalized k1 coefficient. Denormalized via
          k1_raw = lens_k1 / ((w^2 + h^2) / 4).
          Range typically [-0.8, 0.8] in normalized units.

      Returns
      -------
      Undistorted image, same shape and dtype as input.
      """
      if lens_k1 == 0.0:
          return img
      h, w = img.shape[:2]
      cx, cy = w / 2, h / 2
      diag_sq = (w * w + h * h) / 4
      k1_raw = lens_k1 / diag_sq
      f = max(w, h)
      K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], dtype=np.float64)
      dist = np.array([k1_raw, 0, 0, 0, 0], dtype=np.float64)
      map1, map2 = cv2.initUndistortRectifyMap(K, dist, None, K, (w, h), cv2.CV_32FC1)
      return cv2.remap(img, map1, map2, cv2.INTER_LINEAR)
  ```

- [ ] **Step 2: Add `lens_k1` parameter to `analyze_interferogram()`**

  Add `lens_k1: float = 0.0` to the function signature (after `form_model`). Call `undistort_frame()` as the very first pipeline step, before modulation computation:

  ```python
  # At the start of analyze_interferogram, after converting to float64 and grayscale:
  if lens_k1:
      img = undistort_frame(img, lens_k1)
  ```

  Location: after `img = img.mean(axis=-1)` (line ~1480), before `_progress("carrier", ...)` (line ~1482).

- [ ] **Step 3: Add unit tests in `tests/test_fringe.py`**

  Add a new test class `TestUndistortFrame`:

  1. `test_zero_k1_returns_same` — verify `undistort_frame(img, 0.0)` returns the input unchanged (identity check with `np.array_equal`).
  2. `test_positive_k1_pincushion` — apply positive k1 to an image with a known bright dot near the edge; verify it moves inward (toward center).
  3. `test_negative_k1_barrel` — apply negative k1; verify edge dot moves outward.
  4. `test_roundtrip_shape` — verify output shape matches input shape for various image sizes.
  5. `test_analyze_interferogram_accepts_lens_k1` — call `analyze_interferogram()` on a synthetic fringe image with `lens_k1=0.1`; verify it returns a result dict without error (smoke test).

  Use small synthetic images (128x128 or 64x64) for speed.

**Verify:** `.venv/bin/pytest tests/test_fringe.py -v -k "undistort or lens_k1"` — all new tests pass. Then run full suite: `.venv/bin/pytest tests/test_fringe.py -v` — no regressions.

---

### Task 2: API parameter additions

**Files:**
- Edit: `backend/api_fringe.py`
- Edit: `backend/api_camera.py`

Wire `lens_k1` through the API layer to the pipeline.

- [ ] **Step 1: Add `lens_k1` to `AnalyzeBody` and `ReanalyzeCarrierBody`**

  In `backend/api_fringe.py`:

  ```python
  # In AnalyzeBody (after form_model field):
  lens_k1: float = Field(default=0.0)

  # In ReanalyzeCarrierBody (after mask_polygons field):
  lens_k1: float = Field(default=0.0)
  ```

  `ReanalyzeBody` does NOT get `lens_k1` — it works from coefficients, not raw image.

- [ ] **Step 2: Pass `lens_k1` to `analyze_interferogram()` in all call sites**

  Three call sites in `api_fringe.py`:

  1. `fringe_analyze` (line ~137): add `lens_k1=body.lens_k1` to the `analyze_interferogram()` call.
  2. `fringe_analyze_stream` (line ~214): add `lens_k1=body.lens_k1` to the `analyze_interferogram()` call inside the lambda.
  3. `fringe_reanalyze_carrier` (line ~291): add `lens_k1=body.lens_k1` to the `analyze_interferogram()` call.

- [ ] **Step 3: Add `lens_k1` query parameter to the frame endpoint for mask preview**

  The fringe "Edit Mask" flow needs an undistorted preview image. The current flow calls `apiFetch("/snapshot")` — but `/snapshot` (POST, in `api_camera.py`) saves a file and returns a filename, not an image blob.

  The actual image-returning endpoint is `GET /frame`. Add an optional `lens_k1` query parameter to the `/frame` endpoint in `api_camera.py`:

  ```python
  @router.get("/frame")
  async def get_frame(session_id: str = Depends(get_session_id_dep),
                      lens_k1: float = 0.0):
      frame = frame_store.get(session_id)
      if frame is None:
          raise HTTPException(status_code=404, detail="No frame stored")
      if lens_k1:
          from backend.vision.fringe import undistort_frame
          gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
          frame = undistort_frame(gray, lens_k1)
      ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
      ...
  ```

  Alternatively, add a dedicated `GET /frame-preview?lens_k1=...` to avoid complicating the existing `/frame` endpoint. Choose whichever is cleaner — the key requirement is that the mask edit flow can fetch an undistorted JPEG from the server.

  **Note:** The fringe panel's Edit Mask handler currently calls `apiFetch("/snapshot")` and does `.blob()`. Since `/snapshot` returns JSON, this may already be broken or working through a different code path. Investigate the actual flow and fix/adapt as needed. The most likely correct approach: the Edit Mask handler should call `/freeze` (POST, captures frame) then `/frame?lens_k1=...` (GET, returns JPEG blob).

**Verify:** `.venv/bin/pytest tests/ -v` — no regressions. Manually test: start server with `NO_CAMERA=1`, verify `/fringe/analyze` accepts `lens_k1` in body (returns normally with the null camera's blank frame).

---

### Task 3: Frontend fringe lens profiles module

**Files:**
- Create: `frontend/fringe-lens-profiles.js`

New standalone module. No dependencies on other fringe modules except `fr` state object.

- [ ] **Step 1: Create `frontend/fringe-lens-profiles.js`**

  ```javascript
  // fringe-lens-profiles.js — Fringe lens distortion profile CRUD.
  //
  // Profiles stored in localStorage under "loupe_fringe_lens_profiles".
  // Each profile: { name: string, k1: number }
  // Separate from microscope cal profiles (cal-profiles.js).

  import { fr } from './fringe.js';

  const STORAGE_KEY = "loupe_fringe_lens_profiles";

  export function loadFringeLensProfiles() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  export function saveFringeLensProfile(name, k1) {
    const profiles = loadFringeLensProfiles();
    const existing = profiles.findIndex(p => p.name === name);
    if (existing >= 0) profiles[existing].k1 = k1;
    else profiles.push({ name, k1 });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  }

  export function deleteFringeLensProfile(name) {
    const profiles = loadFringeLensProfiles().filter(p => p.name !== name);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  }

  export function renderFringeLensDropdown() {
    const sel = document.getElementById("fringe-lens-profile");
    if (!sel) return;
    const profiles = loadFringeLensProfiles();
    const currentVal = sel.value;
    sel.innerHTML = "";

    // "None" option
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "None";
    sel.appendChild(none);

    for (const p of profiles) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = `${p.name} (k₁=${p.k1.toFixed(3)})`;
      opt.dataset.k1 = p.k1;
      sel.appendChild(opt);
    }

    // Restore selection if it still exists
    if (currentVal && profiles.some(p => p.name === currentVal)) {
      sel.value = currentVal;
    }
  }
  ```

  This module is purely data + DOM rendering. No side effects on import.

**Verify:** No runtime test needed yet — this is wired in Task 4.

---

### Task 4: Frontend fringe panel UI — lens dropdown + calibrate button

**Files:**
- Edit: `frontend/fringe-panel.js`
- Edit: `frontend/fringe.js` (add `lensK1` to `fr` state)
- Edit: `frontend/fringe-results.js` (pass `lens_k1` in reanalyze-carrier request)
- Edit: `frontend/style.css` (minor styling)

- [ ] **Step 1: Add `lensK1` to `fr` state object**

  In `frontend/fringe.js`, add to the `fr` object:

  ```javascript
  lensK1: 0,              // normalized k1 for fringe lens distortion correction
  ```

- [ ] **Step 2: Add lens dropdown HTML to fringe panel**

  In `frontend/fringe-panel.js`, in `buildPanelHtml()`, add after the mask controls section (after the `fringe-mask-status` div, before the drop zone):

  ```html
  <div style="display:flex;gap:4px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
    <label style="font-size:11px;opacity:0.7;white-space:nowrap">Lens:</label>
    <select id="fringe-lens-profile" style="flex:1;font-size:11px;padding:2px 4px"></select>
    <button class="detect-btn" id="fringe-btn-lens-cal" style="padding:4px 10px;font-size:11px">Calibrate</button>
  </div>
  <div id="fringe-lens-save-row" hidden style="display:flex;gap:4px;align-items:center;margin-top:4px">
    <input type="text" id="fringe-lens-save-name" placeholder="Profile name" style="flex:1;font-size:11px;padding:2px 4px" />
    <button class="detect-btn" id="fringe-btn-lens-save" style="padding:4px 8px;font-size:11px">Save</button>
  </div>
  ```

- [ ] **Step 3: Wire lens dropdown change handler in `wirePanelEvents()`**

  Add import of `loadFringeLensProfiles`, `renderFringeLensDropdown`, `saveFringeLensProfile` from `./fringe-lens-profiles.js`.

  In `wirePanelEvents()`:

  ```javascript
  // Initialize lens profile dropdown
  renderFringeLensDropdown();

  // Lens profile selection
  $("fringe-lens-profile")?.addEventListener("change", (e) => {
    const sel = e.target;
    if (!sel.value) {
      fr.lensK1 = 0;
    } else {
      const opt = sel.selectedOptions[0];
      fr.lensK1 = parseFloat(opt.dataset.k1) || 0;
    }
    // Re-analyze if results exist
    if (fr.lastResult) analyzeFromCamera();
  });
  ```

- [ ] **Step 4: Pass `lens_k1` in all analyze request payloads**

  In `fringe-panel.js`, update `analyzeFromCamera()` and `analyzeFromFile()` — add `lens_k1: fr.lensK1` to each payload object. Also update `addToAverage()` payload.

  In `fringe-results.js`, update the `reanalyze-carrier` request body (around line 591) — add `lens_k1: fr.lensK1`. Import `fr` from `./fringe.js` if not already imported.

  `doReanalyze()` does NOT need `lens_k1` — it calls `/fringe/reanalyze` which works from coefficients.

- [ ] **Step 5: Wire the "Save" button for lens profile save prompt**

  ```javascript
  $("fringe-btn-lens-save")?.addEventListener("click", () => {
    const nameInput = $("fringe-lens-save-name");
    const name = nameInput?.value.trim();
    if (!name || !fr.lensK1) return;
    saveFringeLensProfile(name, fr.lensK1);
    renderFringeLensDropdown();
    $("fringe-lens-profile").value = name;
    $("fringe-lens-save-row").hidden = true;
  });
  ```

  The save row is shown after calibration completes (Task 5 wires this).

**Verify:** Start server with `NO_CAMERA=1`, open fringe mode. Verify the Lens dropdown appears with "None" selected. Verify no JS console errors. The Calibrate button is wired in Task 5.

---

### Task 5: Cross-mode lens cal session

**Files:**
- Edit: `frontend/cross-mode.js`
- Edit: `frontend/fringe-panel.js` (Calibrate button handler)

This is the most complex task. It extends the cross-mode system to support a second source type.

- [ ] **Step 1: Add source-aware routing in `enterMaskEditSession()`**

  In `frontend/cross-mode.js`, modify `enterMaskEditSession()` to check `window.crossMode.source`:

  ```javascript
  export async function enterMaskEditSession() {
    if (!window.crossMode) return;
    const cm = window.crossMode;

    if (cm.source === 'fringe-lens-cal') {
      return enterLensCalSession();
    }

    // ... existing mask edit code unchanged ...
  }
  ```

- [ ] **Step 2: Add `enterLensCalSession()` function in `cross-mode.js`**

  New function that handles the fringe lens calibration cross-mode session:

  ```javascript
  import { openLensCalDialog, isLensCalMode } from './lens-cal.js';

  async function enterLensCalSession() {
    const cm = window.crossMode;

    // 1. Stash microscope state
    stashMicroscopeState();

    // 2. Hide mode switcher
    const switcher = document.getElementById('mode-switcher');
    if (switcher) switcher.hidden = true;

    // 3. Show action bar with lens cal label
    showActionBar(
      null,  // no Apply button — lens cal dialog has its own
      () => cancelLensCal(),
      { label: 'Calibrating fringe lens', hideApply: true }
    );

    // 4. Let user interact with live feed normally (no frozen image needed)
    // The user will freeze manually when graph paper is positioned

    // 5. Open the lens cal dialog
    // We need to intercept the dialog's Apply to capture k1 instead of
    // applying correction to the microscope frame.
    // Strategy: temporarily replace the confirm button handler.
    _setupLensCalIntercept(cm.callback);
  }
  ```

  **Important design decision:** The existing `lens-cal.js` `_confirmCal()` applies the correction to `state.frozenBackground` and uploads it. For the fringe lens cal flow, we need to intercept this. Two approaches:

  A. Add a callback/hook mechanism to `lens-cal.js` (cleaner but touches more code).
  B. Override the confirm button click handler from `cross-mode.js` (hacky but isolated).

  Recommended: **Option A** — add an optional `onConfirm` callback to `openLensCalDialog()`. When set, `_confirmCal()` calls the callback with the fitted k1 instead of applying the correction. This keeps the interception clean.

  Modify `lens-cal.js::openLensCalDialog()`:
  ```javascript
  export function openLensCalDialog(opts) {
    _externalCallback = opts?.onConfirm || null;
    _openDialog();
  }
  ```

  Modify `_confirmCal()`: if `_externalCallback` is set, call it with k1 and skip the frame correction + upload.

- [ ] **Step 3: Modify `showActionBar()` to support configurable label and optional Apply button**

  The current `showActionBar(onApply, onCancel)` hardcodes "Defining fringe mask" and "Apply Mask". Extend it:

  ```javascript
  function showActionBar(onApply, onCancel, opts = {}) {
    if (actionBar) actionBar.remove();
    actionBar = document.createElement('div');
    actionBar.id = 'cross-mode-action-bar';

    const label = document.createElement('span');
    label.className = 'cross-mode-label';
    label.textContent = opts.label || 'Defining fringe mask';

    if (!opts.hideApply && onApply) {
      const applyBtn = document.createElement('button');
      applyBtn.className = 'detect-btn cross-mode-apply';
      applyBtn.textContent = opts.applyLabel || 'Apply Mask';
      applyBtn.addEventListener('click', onApply);
      actionBar.appendChild(label);
      actionBar.appendChild(applyBtn);
    } else {
      actionBar.appendChild(label);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cross-mode-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', onCancel);
    actionBar.appendChild(cancelBtn);

    document.body.appendChild(actionBar);
  }
  ```

  Update the existing `enterMaskEditSession()` call to `showActionBar()` — no change needed since default opts match current behavior.

- [ ] **Step 4: Add `cancelLensCal()` exit function**

  ```javascript
  function cancelLensCal() {
    // Close lens cal dialog if open
    const dialog = document.getElementById('lens-cal-dialog');
    if (dialog) dialog.hidden = true;

    _exitMaskEditSession();  // reuse existing exit — restores state, switches back to fringe
    redraw();
  }
  ```

- [ ] **Step 5: Wire the Calibrate button in `fringe-panel.js`**

  In `wirePanelEvents()`:

  ```javascript
  $("fringe-btn-lens-cal")?.addEventListener("click", () => {
    // Set up cross-mode for lens calibration
    window.crossMode = {
      source: 'fringe-lens-cal',
      callback: (k1) => {
        fr.lensK1 = k1;

        // Show save prompt
        const saveRow = $("fringe-lens-save-row");
        if (saveRow) saveRow.hidden = false;

        // Update dropdown to show custom value
        const sel = $("fringe-lens-profile");
        if (sel) sel.value = "";  // no saved profile yet

        // Re-analyze if results exist
        if (fr.lastResult) analyzeFromCamera();
      },
    };

    // Switch to microscope mode
    switchMode("microscope");
    const sel = $("mode-switcher");
    if (sel) sel.value = "microscope";
  });
  ```

  Add import of `switchMode` from `./modes.js` if not already present.

- [ ] **Step 6: Add `onConfirm` callback support to `lens-cal.js`**

  In `frontend/lens-cal.js`:

  Add module-level variable:
  ```javascript
  let _externalCallback = null;
  ```

  Modify `openLensCalDialog()`:
  ```javascript
  export function openLensCalDialog(opts) {
    _externalCallback = opts?.onConfirm || null;
    _openDialog();
  }
  ```

  Modify `_confirmCal()` — add early return path when external callback is set:
  ```javascript
  async function _confirmCal() {
    if (_samples.length < 3) return;
    const k1 = _fitK1(_samples);

    if (_externalCallback) {
      // Cross-mode lens cal: return k1 to caller, don't apply to frame
      const cb = _externalCallback;
      _externalCallback = null;
      _active = false;
      _samples = [];
      _pendingP1 = null;
      document.getElementById("lens-cal-dialog").hidden = true;
      cb(k1);
      return;
    }

    // ... existing apply-to-frame logic unchanged ...
  }
  ```

  Also modify `_cancelDialog()` to clear `_externalCallback`:
  ```javascript
  function _cancelDialog() {
    _externalCallback = null;
    _active = false;
    // ... rest unchanged ...
  }
  ```

**Verify:** Start server with `NO_CAMERA=1`. Open fringe mode, click Calibrate. Verify:
1. Mode switches to microscope
2. Action bar shows "Calibrating fringe lens"
3. Lens cal dialog opens (will show "Freeze an image first" since no camera — that's fine for smoke test)
4. Cancel returns to fringe mode
5. No JS errors in console

Full flow test requires a real camera or loading an image.

---

### Task 6: Mask preview undistortion

**Files:**
- Edit: `frontend/fringe-panel.js` (Edit Mask handler)

- [ ] **Step 1: Pass `lens_k1` to the snapshot/frame fetch in Edit Mask handler**

  In `fringe-panel.js`, the Edit Mask click handler currently does:
  ```javascript
  const resp = await apiFetch("/snapshot");
  ```

  Update to pass `lens_k1` when active. The exact approach depends on what Task 2 decided for the image-fetching endpoint. If using `/frame`:

  ```javascript
  // First freeze the current frame
  await apiFetch("/freeze", { method: "POST" });
  // Then fetch the frame image (with optional undistortion)
  const url = fr.lensK1 ? `/frame?lens_k1=${fr.lensK1}` : "/frame";
  const resp = await apiFetch(url);
  ```

  This ensures the mask polygons the user draws align with the geometry the pipeline will analyze (since the pipeline also undistorts with the same k1).

**Verify:** With a lens profile active, click Edit Mask. Verify the preview image loads correctly. If k1 is non-zero, the preview should show the undistorted version of the frame.

---

### Task 7: Integration test

**Files:**
- Edit: `tests/test_fringe.py`

- [ ] **Step 1: Add API-level integration test for `lens_k1` passthrough**

  Add a test that calls `/fringe/analyze` with `lens_k1=0.3` on a synthetic fringe image and verifies the response contains valid results. Use the existing test app fixture pattern from `tests/test_fringe.py`.

  ```python
  class TestLensK1Integration:
      def test_analyze_with_lens_k1(self):
          """analyze_interferogram produces valid output with lens_k1."""
          # Create synthetic fringe pattern
          h, w = 128, 128
          y, x = np.mgrid[:h, :w]
          img = (128 + 100 * np.sin(2 * np.pi * x / 20)).astype(np.uint8)

          result = analyze_interferogram(img, lens_k1=0.3)
          assert "pv_nm" in result
          assert "rms_nm" in result
          assert result["pv_nm"] > 0

      def test_analyze_lens_k1_zero_matches_no_k1(self):
          """lens_k1=0.0 should produce identical results to omitting it."""
          h, w = 64, 64
          y, x = np.mgrid[:h, :w]
          img = (128 + 100 * np.sin(2 * np.pi * x / 16)).astype(np.uint8)

          r1 = analyze_interferogram(img, lens_k1=0.0)
          r2 = analyze_interferogram(img)
          assert r1["pv_nm"] == r2["pv_nm"]
          assert r1["rms_nm"] == r2["rms_nm"]
  ```

- [ ] **Step 2: Run full test suite**

  `.venv/bin/pytest tests/test_fringe.py -v` — all 80+ existing tests pass, plus the new ones.

**Verify:** Full green test suite, no regressions.

---

## Dependency graph

```
Task 1 (backend undistort)
  └─→ Task 2 (API params) ─→ Task 6 (mask preview undistortion)
                            └─→ Task 7 (integration test)
Task 3 (lens profiles module) ─→ Task 4 (panel UI)
                                    └─→ Task 5 (cross-mode lens cal)
```

Tasks 1 and 3 are independent and can run in parallel.
Tasks 4 and 2 are independent of each other (4 just needs 3; 2 just needs 1).
Task 5 depends on both 4 (for the UI) and the cross-mode routing.
Task 6 depends on 2 (API endpoint change) and 4 (fr.lensK1 being set).
Task 7 is the final verification.

## Files changed summary

| File | Action | Task |
|------|--------|------|
| `backend/vision/fringe.py` | Edit — add `undistort_frame()`, add `lens_k1` param to `analyze_interferogram()` | 1 |
| `tests/test_fringe.py` | Edit — add undistort + integration tests | 1, 7 |
| `backend/api_fringe.py` | Edit — add `lens_k1` to `AnalyzeBody`, `ReanalyzeCarrierBody`, pass through | 2 |
| `backend/api_camera.py` | Edit — add `lens_k1` query param to `/frame` endpoint | 2 |
| `frontend/fringe-lens-profiles.js` | Create — profile CRUD + dropdown rendering | 3 |
| `frontend/fringe.js` | Edit — add `lensK1` to `fr` state | 4 |
| `frontend/fringe-panel.js` | Edit — lens dropdown HTML, wire events, pass `lens_k1` in payloads, calibrate button, mask preview | 4, 5, 6 |
| `frontend/fringe-results.js` | Edit — pass `lens_k1` in reanalyze-carrier body | 4 |
| `frontend/cross-mode.js` | Edit — source-aware routing, `enterLensCalSession()`, configurable action bar | 5 |
| `frontend/lens-cal.js` | Edit — add `onConfirm` callback support to `openLensCalDialog()` and `_confirmCal()` | 5 |
| `frontend/style.css` | Edit — minor styling if needed for lens row | 4 |
