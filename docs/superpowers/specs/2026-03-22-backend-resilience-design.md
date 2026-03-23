# Backend Resilience Design

**Date:** 2026-03-22

## Goal

Make the backend survive mismatches between saved configuration and the current hardware environment — specifically a saved camera ID that is no longer available at startup.

## Problem

`config.json` persists the last-used `camera_id`. On startup, `create_app` passes that ID directly to `AravisCamera`, which calls `Aravis.Camera.new(device_id)`. If that device is absent, Aravis raises an exception that propagates through the lifespan context manager and crashes the server.

## Design

### 1. Camera startup with graceful fallback

**Where:** `backend/main.py` `create_app`

Decision tree (executed before opening any camera):

```
if not ARAVIS_AVAILABLE:
    camera = OpenCVCamera(index=1)   # unchanged from today; no warning
elif camera_id is None:              # first run / no saved preference
    camera = AravisCamera(None)      # opens first available; no warning
else:
    try:
        available = list_aravis_cameras()   # may raise; caught below
    except Exception:
        available = []
    ids = [c["id"] for c in available]
    if camera_id in ids:
        camera = AravisCamera(camera_id)    # normal path; no warning
    elif available:
        fallback_id = available[0]["id"]
        startup_warning = f"Camera '{camera_id}' not found. Using '{fallback_id}'."
        camera = AravisCamera(fallback_id)
    else:
        startup_warning = f"Camera '{camera_id}' not found and no cameras available. Using OpenCV fallback."
        camera = OpenCVCamera(index=1)
```

`startup_warning` is a module-level string (or `None`) set during `create_app` and passed as a parameter into `make_router`. This avoids `app.state` and keeps the wiring explicit.

### 2. Startup-warning API endpoint

**Where:** `backend/api.py` `make_router`

```
GET /camera/startup-warning
→ { "warning": "..." }   # HTTP 200 always
→ { "warning": null }    # if no warning
```

`make_router` receives `startup_warning: str | None = None` as a new parameter. The endpoint reads from that closed-over value. **Pop semantics:** after the first successful read the value is cleared to `None` (via a mutable container, e.g. `_warning = [startup_warning]` and `_warning[0] = None` after return). This prevents the warning from reappearing on page refresh.

### 3. Frontend display

**Where:** `frontend/app.js`

On page load (after the initial `/camera/info` fetch succeeds), call `GET /camera/startup-warning`. If `warning` is non-null, display it in the `#status-line` element for 8 seconds then revert to the normal "Live" / "Frozen" status. No persistent UI change.

### 4. `config.json` versioning

**Where:** `backend/config.py`

Add `"version": 1` to `_DEFAULTS`. `save_config` already merges `_DEFAULTS` with the current file content, so every write will include `"version": 1` from this point on. **v0 files (no version field) are silently upgraded on first write** — no explicit migration step is needed.

`load_config` version handling:
- No version field → v0; load with defaults for missing keys (current behaviour, safe).
- `version == 1` → load normally.
- `version > 1` → log a warning; **pass through unknown keys** (keep the data, do not strip). This is the less-breaking choice: the app may not use the new fields but it will not destroy them on next save.

### 5. Camera ID stored by device ID string

Already the case — `camera_id` is the Aravis device ID string (e.g. `"Baumer-12345"`), not a numeric index. No change needed.

## Files Changed

| File | Change |
|------|--------|
| `backend/config.py` | Add `"version": 1` to `_DEFAULTS`; add version check/log in `load_config` |
| `backend/main.py` | Startup fallback decision tree; pass `startup_warning` into `make_router` |
| `backend/api.py` | `make_router` accepts `startup_warning` param; add `GET /camera/startup-warning` |
| `backend/cameras/aravis.py` | No code change; `list_aravis_cameras()` used as-is |
| `frontend/app.js` | After page-load `/camera/info` fetch: call `/camera/startup-warning`, display in `#status-line` for 8 s if non-null |

## Error Handling

- `list_aravis_cameras()` raising → `available = []` → fall through to OpenCV with warning.
- If fallback `AravisCamera(fallback_id)` also fails to open → the existing exception propagates as before (crash on lifespan). This is intentional: if even the fallback fails, something is fundamentally wrong.
- Fallback camera ID is **not** saved to config — user must explicitly select a camera to persist the choice.

## Out of Scope

- Hot-plug camera reconnection during runtime.
- Multiple simultaneous cameras.
