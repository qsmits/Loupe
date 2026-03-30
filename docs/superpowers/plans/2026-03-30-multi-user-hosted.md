# Multi-User Hosted Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow multiple users to use the app simultaneously on a shared hosted server (no-camera mode) without interfering with each other, by isolating the frame store per session.

**Architecture:** Replace the single `FrameStore` with a `SessionFrameStore` keyed by UUID session IDs. Frontend generates a session ID per tab and sends it via `X-Session-ID` header on every API call. Config becomes read-only in hosted mode (403 on writes). No login, no server-side file storage.

**Tech Stack:** Python (FastAPI, threading), vanilla JS ES modules

**Spec:** `docs/superpowers/specs/2026-03-30-multi-user-hosted-design.md`

---

## File Map

### New files
| File | Purpose |
|------|---------|
| `backend/session_store.py` | `SessionFrameStore` class — per-session frame storage with TTL |
| `frontend/api.js` | `apiFetch()` wrapper — adds `X-Session-ID` header to all requests |
| `tests/test_session_store.py` | Unit tests for SessionFrameStore |

### Files to modify
| File | Changes |
|------|---------|
| `backend/main.py` | Use `SessionFrameStore` when `HOSTED=1`, add `get_session_id` dependency |
| `backend/api.py` | Config POST endpoints return 403 in hosted mode |
| `backend/api_camera.py` | Pass session_id to frame_store calls; add `DELETE /session`; upload size limit |
| `backend/api_detection.py` | Pass session_id to frame_store calls |
| `backend/api_inspection.py` | Pass session_id to frame_store calls |
| `backend/config.py` | Add `"hosted"` to `_DEFAULTS` |
| `frontend/main.js` | Import apiFetch, replace fetch calls, handle 403, session cleanup on beforeunload |
| `frontend/detect.js` | Replace fetch with apiFetch |
| `frontend/dxf.js` | Replace fetch with apiFetch |
| `frontend/sidebar.js` | Replace fetch with apiFetch, handle 403 on config saves |
| `frontend/session.js` | Replace fetch with apiFetch |
| `frontend/tools.js` | Replace fetch with apiFetch |
| `frontend/events-mouse.js` | Replace fetch with apiFetch |
| `frontend/events-inspection.js` | Replace fetch with apiFetch |

---

### Task 1: SessionFrameStore with tests

**Files:**
- Create: `backend/session_store.py`
- Create: `tests/test_session_store.py`

- [ ] **Step 1: Write tests**

```python
# tests/test_session_store.py
import numpy as np
import pytest
import time


class TestSessionFrameStore:
    def test_store_and_get_returns_copy(self):
        from backend.session_store import SessionFrameStore
        store = SessionFrameStore()
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        frame[0, 0] = [1, 2, 3]
        store.store("s1", frame)
        got = store.get("s1")
        assert got is not None
        assert got[0, 0, 0] == 1
        # Verify it's a copy (mutating returned frame doesn't affect stored)
        got[0, 0] = [99, 99, 99]
        got2 = store.get("s1")
        assert got2[0, 0, 0] == 1  # still original

    def test_store_copies_input(self):
        from backend.session_store import SessionFrameStore
        store = SessionFrameStore()
        frame = np.zeros((10, 10, 3), dtype=np.uint8)
        store.store("s1", frame)
        frame[0, 0] = [42, 42, 42]  # mutate original
        got = store.get("s1")
        assert got[0, 0, 0] == 0  # store has the copy, not the mutated original

    def test_sessions_are_isolated(self):
        from backend.session_store import SessionFrameStore
        store = SessionFrameStore()
        f1 = np.full((10, 10, 3), 1, dtype=np.uint8)
        f2 = np.full((10, 10, 3), 2, dtype=np.uint8)
        store.store("s1", f1)
        store.store("s2", f2)
        assert store.get("s1")[0, 0, 0] == 1
        assert store.get("s2")[0, 0, 0] == 2

    def test_get_nonexistent_returns_none(self):
        from backend.session_store import SessionFrameStore
        store = SessionFrameStore()
        assert store.get("nonexistent") is None

    def test_clear_removes_session(self):
        from backend.session_store import SessionFrameStore
        store = SessionFrameStore()
        store.store("s1", np.zeros((10, 10, 3), dtype=np.uint8))
        assert store.has_frame("s1")
        store.clear("s1")
        assert not store.has_frame("s1")
        assert store.get("s1") is None

    def test_max_sessions_enforced(self):
        from backend.session_store import SessionFrameStore
        store = SessionFrameStore(max_sessions=3)
        for i in range(3):
            store.store(f"s{i}", np.zeros((10, 10, 3), dtype=np.uint8))
        with pytest.raises(RuntimeError, match="Too many"):
            store.store("s_extra", np.zeros((10, 10, 3), dtype=np.uint8))

    def test_max_sessions_allows_update_existing(self):
        from backend.session_store import SessionFrameStore
        store = SessionFrameStore(max_sessions=2)
        store.store("s1", np.zeros((10, 10, 3), dtype=np.uint8))
        store.store("s2", np.zeros((10, 10, 3), dtype=np.uint8))
        # Updating existing session should NOT raise
        store.store("s1", np.ones((10, 10, 3), dtype=np.uint8))
        assert store.get("s1")[0, 0, 0] == 1

    def test_expiration(self):
        from backend.session_store import SessionFrameStore
        store = SessionFrameStore(ttl_seconds=0.1)
        store.store("s1", np.zeros((10, 10, 3), dtype=np.uint8))
        assert store.has_frame("s1")
        time.sleep(0.15)
        assert store.get("s1") is None  # expired

    def test_touch_on_get_resets_ttl(self):
        from backend.session_store import SessionFrameStore
        store = SessionFrameStore(ttl_seconds=0.2)
        store.store("s1", np.zeros((10, 10, 3), dtype=np.uint8))
        time.sleep(0.1)
        store.get("s1")  # touch — resets TTL
        time.sleep(0.1)
        # 0.2s since store, but only 0.1s since last get — should still exist
        assert store.get("s1") is not None

    def test_has_frame(self):
        from backend.session_store import SessionFrameStore
        store = SessionFrameStore()
        assert not store.has_frame("s1")
        store.store("s1", np.zeros((10, 10, 3), dtype=np.uint8))
        assert store.has_frame("s1")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_session_store.py -v`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `backend/session_store.py`**

```python
"""Per-session frame storage for multi-user hosted mode."""
import re
import threading
import time

import numpy as np

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DEFAULT_SESSION_ID = "_default"


def validate_session_id(session_id: str) -> bool:
    return session_id == DEFAULT_SESSION_ID or bool(_UUID_RE.match(session_id))


class SessionFrameStore:
    """Thread-safe per-session frame storage with auto-expiration."""

    def __init__(self, max_sessions: int = 50, ttl_seconds: float = 1800):
        self._frames: dict[str, tuple[np.ndarray, float]] = {}
        self._lock = threading.Lock()
        self._max_sessions = max_sessions
        self._ttl = ttl_seconds

    def store(self, session_id: str, frame: np.ndarray) -> None:
        with self._lock:
            self._evict_expired()
            if len(self._frames) >= self._max_sessions and session_id not in self._frames:
                raise RuntimeError("Too many active sessions")
            self._frames[session_id] = (frame.copy(), time.monotonic())

    def get(self, session_id: str) -> np.ndarray | None:
        with self._lock:
            self._evict_expired()
            entry = self._frames.get(session_id)
            if entry is None:
                return None
            frame, _ = entry
            self._frames[session_id] = (frame, time.monotonic())
            return frame.copy()

    def clear(self, session_id: str) -> None:
        with self._lock:
            self._frames.pop(session_id, None)

    def has_frame(self, session_id: str) -> bool:
        with self._lock:
            return session_id in self._frames

    def _evict_expired(self) -> None:
        now = time.monotonic()
        expired = [k for k, (_, ts) in self._frames.items() if now - ts > self._ttl]
        for k in expired:
            del self._frames[k]
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest tests/test_session_store.py -v`
Expected: All 10 pass

- [ ] **Step 5: Commit**

```bash
git add backend/session_store.py tests/test_session_store.py
git commit -m "feat: add SessionFrameStore for multi-user per-session frame isolation"
```

---

### Task 2: Backend hosted mode — session ID middleware + config

**Files:**
- Modify: `backend/config.py`
- Modify: `backend/main.py`
- Modify: `backend/api.py`

- [ ] **Step 1: Add `hosted` to config defaults**

In `backend/config.py`, add to `_DEFAULTS`:
```python
"hosted": False,
```

- [ ] **Step 2: Create session ID dependency and use SessionFrameStore in main.py**

In `backend/main.py`:

Add imports:
```python
from .session_store import SessionFrameStore, DEFAULT_SESSION_ID, validate_session_id
import os
```

In `create_app()`, after loading config, check hosted mode:
```python
hosted = os.environ.get("HOSTED", "").lower() in ("1", "true") or cfg.get("hosted", False)
```

Replace `FrameStore()` with `SessionFrameStore()` when hosted:
```python
if hosted:
    frame_store = SessionFrameStore(
        max_sessions=int(os.environ.get("MAX_SESSIONS", "50")),
        ttl_seconds=int(os.environ.get("SESSION_TTL", "1800")),
    )
else:
    frame_store = FrameStore()
```

Store `hosted` flag on the app for use by endpoints:
```python
app.state.hosted = hosted
```

- [ ] **Step 3: Add `get_session_id_dep` to `backend/session_store.py`**

Place the dependency in `session_store.py` (not `main.py`) to avoid circular imports — all router modules can import from `session_store` safely.

Add to `backend/session_store.py`:

```python
from fastapi import Request, HTTPException

def get_session_id_dep(request: Request) -> str:
    """Extract and validate session ID from X-Session-ID header."""
    session_id = request.headers.get("X-Session-ID")
    if not session_id:
        if getattr(request.app.state, "hosted", False):
            raise HTTPException(400, detail="Missing X-Session-ID header")
        return DEFAULT_SESSION_ID
    if not validate_session_id(session_id):
        raise HTTPException(400, detail="Invalid session ID format")
    return session_id
```

All router modules import: `from ..session_store import get_session_id_dep`

- [ ] **Step 4: Make config endpoints return 403 in hosted mode**

In `backend/api.py`, update the POST handlers:

```python
@router.post("/config/ui")
def post_ui_config(body: UiConfig, request: Request):
    if getattr(request.app.state, "hosted", False):
        raise HTTPException(403, detail="Read-only in hosted mode")
    save_config({"app_name": body.app_name, "theme": body.theme, "subpixel_method": body.subpixel_method})
    return {"app_name": body.app_name, "theme": body.theme, "subpixel_method": body.subpixel_method}

@router.post("/config/tolerances")
def post_tolerances(body: TolerancesConfig, request: Request):
    if getattr(request.app.state, "hosted", False):
        raise HTTPException(403, detail="Read-only in hosted mode")
    save_config({"tolerance_warn": body.tolerance_warn, "tolerance_fail": body.tolerance_fail})
    return {"tolerance_warn": body.tolerance_warn, "tolerance_fail": body.tolerance_fail}
```

- [ ] **Step 5: Run tests**

Run: `python3 -m pytest tests/ -q`
Expected: No new failures

- [ ] **Step 6: Commit**

```bash
git add backend/config.py backend/main.py backend/api.py
git commit -m "feat: hosted mode with session ID dependency and read-only config"
```

---

### Task 3: Update all endpoints to use session ID

**Files:**
- Modify: `backend/api_camera.py`
- Modify: `backend/api_detection.py`
- Modify: `backend/api_inspection.py`

This is mechanical: every endpoint that calls `frame_store.store()` or `frame_store.get()` needs the session ID parameter.

- [ ] **Step 1: Update `make_camera_router` signature and endpoints**

The router factory receives `frame_store` which is now a `SessionFrameStore` (or `FrameStore` in single-user mode). Since both have `.store(session_id, frame)` / `.get(session_id)` signatures in hosted mode but the old `FrameStore` uses `.store(frame)` / `.get()`, we need to handle both.

**Approach**: Make `SessionFrameStore` the universal implementation. In single-user mode, the `get_session_id` dependency returns `DEFAULT_SESSION_ID`. So all endpoints always pass a session ID — it's just always the same one in single-user mode.

**BUT** — this changes the `FrameStore` interface. The cleanest approach: **replace `FrameStore` entirely with `SessionFrameStore` in all cases.** Single-user mode just uses `DEFAULT_SESSION_ID`. Delete `backend/frame_store.py`.

Update `make_camera_router`:
```python
def make_camera_router(camera, frame_store, startup_warning=None):
    router = APIRouter()
    # ... existing code ...

    @router.post("/load-image")
    async def load_image(file: UploadFile = File(...), session_id: str = Depends(get_session_id_dep)):
        data = await file.read(20 * 1024 * 1024 + 1)  # 20MB + 1 byte
        if len(data) > 20 * 1024 * 1024:
            raise HTTPException(413, detail="Image too large (max 20MB)")
        arr = np.frombuffer(data, np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            raise HTTPException(400, detail="Cannot decode image")
        frame_store.store(session_id, frame)
        h, w = frame.shape[:2]
        return {"width": w, "height": h}

    @router.post("/freeze")
    async def freeze(session_id: str = Depends(get_session_id_dep)):
        frame = camera.get_frame()
        frame_store.store(session_id, frame)
        h, w = frame.shape[:2]
        return {"width": w, "height": h}

    @router.get("/frame")
    async def get_frame(session_id: str = Depends(get_session_id_dep)):
        frame = frame_store.get(session_id)
        if frame is None:
            raise HTTPException(404, detail="No frame stored")
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
        if not ok:
            raise HTTPException(500, detail="Failed to encode frame")
        return Response(content=buf.tobytes(), media_type="image/jpeg")

    @router.delete("/session")
    async def delete_session(session_id: str = Depends(get_session_id_dep)):
        frame_store.clear(session_id)
        return {"ok": True}
```

Apply the same pattern to `/load-snapshot`. All other camera endpoints (exposure, gain, gamma, etc.) don't use frame_store — no change needed.

- [ ] **Step 2: Update `make_detection_router` endpoints**

All detection endpoints follow the same pattern:
```python
async def detect_X(params, session_id: str = Depends(get_session_id_dep)):
    frame = frame_store.get(session_id)
    if frame is None:
        raise HTTPException(400, detail="No frame stored. Load an image first.")
    ...
```

Update all 6 detection endpoints + `/preprocessed-view`.

- [ ] **Step 3: Update `make_inspection_router` endpoints**

Update `/inspect-guided`, `/align-dxf-edges`, `/refine-point`, `/gradient-overlay`:
```python
async def inspect_guided_route(body, session_id: str = Depends(get_session_id_dep)):
    frame = frame_store.get(session_id)
    ...
```

- [ ] **Step 4: Import get_session_id_dep in all router modules**

Each router module needs:
```python
from fastapi import Depends
# get_session_id_dep needs to be importable — either from main.py or a deps.py module
```

Best to put `get_session_id_dep` in a new `backend/deps.py` or in `session_store.py` to avoid circular imports.

- [ ] **Step 5: Add hosted-mode guards to `/snapshot` and `/load-snapshot`**

In `api_camera.py`, add 403 checks at the top of `/snapshot` and `/load-snapshot`:
```python
if getattr(request.app.state, "hosted", False):
    raise HTTPException(403, detail="Disabled in hosted mode")
```

(These write to the filesystem, which is forbidden in hosted mode.)

- [ ] **Step 6: Delete `backend/frame_store.py`**

Since `SessionFrameStore` replaces it entirely. Update all imports:
- `backend/main.py` — change import from `frame_store` to `session_store`
- `tests/conftest.py` — uses `FrameStore` in test fixtures
- `tests/test_main.py` (line ~24) — constructs `FrameStore` directly
- `tests/test_api_warning.py` (lines ~5, ~16) — imports and constructs `FrameStore`

- [ ] **Step 7: Update tests**

Replace all `FrameStore` usage in test files:
```python
# In conftest.py and test files, replace:
from backend.frame_store import FrameStore
frame_store = FrameStore()
frame_store.store(frame)
# With:
from backend.session_store import SessionFrameStore, DEFAULT_SESSION_ID
frame_store = SessionFrameStore()
frame_store.store(DEFAULT_SESSION_ID, frame)
```

Since `app.state.hosted = False` in test mode, the `get_session_id_dep` returns `DEFAULT_SESSION_ID` when no header is sent — existing API tests should continue working without adding headers.

**Note on interface change:** `has_frame` is now a method taking `session_id`, not a no-arg property. Grep for any usage and update accordingly. (Currently no endpoint code uses it.)

- [ ] **Step 7: Run tests**

Run: `python3 -m pytest tests/ -q`
Expected: All pass (same 4 pre-existing failures)

- [ ] **Step 8: Commit**

```bash
git add backend/ tests/
git commit -m "feat: all endpoints use session-scoped frame store"
```

---

### Task 4: Frontend `apiFetch` wrapper

**Files:**
- Create: `frontend/api.js`
- Modify: all 8 frontend files with `fetch()` calls

- [ ] **Step 1: Create `frontend/api.js`**

```js
// api.js — Session-aware fetch wrapper for multi-user hosted mode.
// All API calls go through apiFetch() which adds the X-Session-ID header.

if (!sessionStorage.getItem("sessionId")) {
  sessionStorage.setItem("sessionId", crypto.randomUUID());
}

const SESSION_ID = sessionStorage.getItem("sessionId");

/**
 * Wrapper around fetch() that adds X-Session-ID header.
 * Drop-in replacement — same signature as fetch().
 */
export function apiFetch(url, options = {}) {
  // Always create a new Headers to avoid mutating the caller's object
  const headers = new Headers(options.headers || {});
  headers.set("X-Session-ID", SESSION_ID);
  return fetch(url, { ...options, headers });
}

/** Get the current session ID (for sendBeacon fallback). */
export function getSessionId() {
  return SESSION_ID;
}
```

- [ ] **Step 2: Replace `fetch(` with `apiFetch(` across all frontend files**

For each file, add `import { apiFetch } from './api.js';` and replace all `fetch(` calls with `apiFetch(`.

Files and approximate call counts:
- `main.js` — ~22 calls
- `detect.js` — ~8 calls
- `dxf.js` — ~6 calls
- `sidebar.js` — ~4 calls
- `session.js` — ~1 call
- `tools.js` — ~1 call
- `events-mouse.js` — ~1 call
- `events-inspection.js` — ~1 call

**DO NOT replace** the `fetch()` call inside `apiFetch` itself.

For calls that use `FormData` (like `/load-dxf`, `/load-image`), `apiFetch` works fine — the `Headers` object merges with any existing headers. But make sure NOT to set `Content-Type` for FormData requests (the browser sets the multipart boundary automatically).

- [ ] **Step 3: Verify no bare `fetch(` calls remain**

Run: `grep -rn 'fetch(' frontend/*.js | grep -v apiFetch | grep -v 'api.js' | grep -v '// '`

Expected: only the `fetch()` call inside `apiFetch` itself and the `keepalive` fetch in the `beforeunload` handler (added in Task 5). Any other hits are missed replacements.

- [ ] **Step 4: Run frontend tests**

Run: `node --test tests/frontend/test_*.js`
Expected: All 81 pass (tests don't call fetch)

- [ ] **Step 5: Commit**

```bash
git add frontend/api.js frontend/main.js frontend/detect.js frontend/dxf.js frontend/sidebar.js frontend/session.js frontend/tools.js frontend/events-mouse.js frontend/events-inspection.js
git commit -m "feat: apiFetch wrapper adds session ID to all API calls"
```

---

### Task 5: Frontend 403 handling + session cleanup

**Files:**
- Modify: `frontend/main.js` — handle 403 on config saves, session cleanup on beforeunload
- Modify: `frontend/sidebar.js` — handle 403 on tolerance/config saves

- [ ] **Step 1: Handle 403 on config save endpoints**

In `main.js`, find the general settings save handler (the one that POSTs to `/config/ui`). Wrap the fetch response check:

```js
const resp = await apiFetch("/config/ui", { ... });
if (resp.status === 403) {
  // Hosted mode: settings are read-only on the server.
  // Just apply locally — they're already in state.settings.
  showStatus("Settings applied (local only)");
} else if (resp.ok) {
  showStatus("Settings saved");
} else {
  showStatus("Failed to save settings");
}
```

Same pattern for tolerance save in `sidebar.js` — if 403, show "Tolerances applied locally" and don't treat it as an error. The tolerances are already in `state.tolerances` on the client side.

- [ ] **Step 2: Session cleanup on tab close**

In `main.js`, update the existing `beforeunload` handler to also clean up the server-side session:

```js
import { getSessionId } from './api.js';

window.addEventListener("beforeunload", e => {
  // Best-effort session cleanup (may not complete)
  try {
    const body = JSON.stringify({});
    fetch("/session", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-Session-ID": getSessionId(),
      },
      keepalive: true,  // ensures request completes even during page unload
    });
  } catch { /* ignore */ }

  // Existing dirty-state warning
  if (!state._savedManually && state.annotations.some(a => !TRANSIENT_TYPES.has(a.type))) {
    e.preventDefault();
    e.returnValue = "";
  }
});
```

Note: uses raw `fetch` with `keepalive: true` (not `apiFetch`) because `keepalive` is critical for `beforeunload` and we want minimal overhead.

- [ ] **Step 3: Hide snapshot buttons in hosted mode**

The `/camera/info` response already includes `no_camera: true` for NullCamera. When in hosted mode, snapshot save/load buttons should be hidden. Check if this is already handled by the existing no-camera logic — if so, no change needed.

- [ ] **Step 4: Manual smoke test**

Test with `HOSTED=1 NO_CAMERA=1`:
```bash
HOSTED=1 NO_CAMERA=1 python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

- Open two browser tabs to the app
- Tab 1: load an image, place annotations, run detection
- Tab 2: load a DIFFERENT image, run detection
- Verify Tab 1's detections are still on Tab 1's image (not Tab 2's)
- Close Tab 2, verify Tab 1 still works
- Try saving settings — should show "applied locally" message

- [ ] **Step 5: Run all tests**

```bash
node --test tests/frontend/test_*.js
python3 -m pytest tests/ -q
```

- [ ] **Step 6: Commit**

```bash
git add frontend/main.js frontend/sidebar.js
git commit -m "feat: handle hosted mode 403s gracefully + session cleanup on tab close"
```

---

## Final Verification

```bash
# All tests
python3 -m pytest tests/ -q
node --test tests/frontend/test_*.js

# Multi-user smoke test
HOSTED=1 NO_CAMERA=1 python3 -m uvicorn backend.main:app --port 8000
# Open 2+ tabs, load different images, verify isolation
```

## Future optimization note

If memory becomes tight, the `SessionFrameStore` could store JPEG-compressed
bytes instead of decoded numpy arrays. This would cut memory ~10x (1.5MB per
session vs 15MB) at the cost of ~20ms decode latency per detection/inspection
call. This is a drop-in change to `store()`/`get()` with no API changes.
