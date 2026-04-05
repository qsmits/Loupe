# 4-Quadrant Image Settings Comparison — Implementation Notes

Keyence VHX-900-inspired "4-up" image settings comparison. Click the **4-up**
button in the top bar, the backend analyses the current frame and proposes
four algorithmically chosen post-processing variants, and double-clicking a
quadrant applies that variant as the active profile on the MJPEG stream.

## Files touched

### New
- `backend/vision/settings_proposer.py` — `propose_four_variants()` + `apply_variant()`
- `backend/api_compare.py` — `/compare/propose`, `/compare/apply`, `/compare/clear`, `/compare/active`
- `tests/test_settings_proposer.py` — 8 tests (proposer shape, shadow lift, highlight compress, API round-trip)
- `frontend/compare.js` — overlay UI + apply/clear calls
- `COMPARE_NOTES.md` — this file

### Modified
- `backend/api.py` — wires `make_compare_router` into the composed router.
- `backend/stream.py` — `mjpeg_generator` now applies the active profile (if any) per frame before JPEG encoding.
- `frontend/index.html` — adds `#btn-compare`, `#compare-overlay` (2x2 grid), `#compare-active-badge` in sidebar.
- `frontend/main.js` — imports and calls `initCompareHandlers()`.
- `frontend/style.css` — overlay, grid, cell hover, label, and sidebar badge styles.

## Variant schema

```json
{
  "name": "Shadow detail",
  "description": "Lift shadows (γ=0.60)",
  "gain": 1.0,
  "exposure_scale": 1.15,
  "gamma": 0.60,
  "contrast": 1.0,
  "saturation": 1.05,
  "clahe": true,
  "unsharp": 0.2
}
```

Pipeline order inside `apply_variant`: gain × exposure → contrast (around mid-grey) → CLAHE (on L of LAB) → gamma LUT → HSV saturation → unsharp mask.

The 4 variants are:
1. **Balanced** — auto-levels to mean 128 / stddev 60.
2. **High contrast edges** — CLAHE + extra contrast + unsharp.
3. **Shadow detail** — gamma < 1, moderate CLAHE, slight exposure boost.
4. **Highlight detail** — gamma > 1, reduced exposure.

Parameters are derived from the input histogram (`mean`, `stddev`, percentiles) — not hard-coded constants. For a dark input, Shadow detail will pick a lower gamma and higher exposure than for a well-exposed input.

## Performance

Benchmarked `apply_variant` on a random 1080p BGR frame (20 runs, warm cache):

| Variant              | Time      |
|----------------------|-----------|
| Balanced             | ~1.8 ms  |
| High contrast edges  | ~16 ms   |
| Shadow detail        | ~15 ms   |
| Highlight detail     | ~5 ms    |

All under the 50 ms/frame budget; even the heaviest CLAHE+unsharp variants leave >15 ms headroom at 30 fps. Gamma LUTs are cached by rounded key.

## Manual test plan

1. `./server.sh restart`
2. Open http://localhost:8000 in a browser.
3. Click **4-up** in the top bar. The 2x2 overlay should appear with 4 labelled previews.
4. Hover a cell → cyan border highlights. Double-click the **Shadow detail** cell.
5. Overlay closes; the live stream should now look noticeably brighter / more lifted.
6. Sidebar shows a cyan "Profile: Shadow detail" badge with a **Reset** button.
7. Click **Reset** — badge disappears and the stream reverts to raw.
8. Open 4-up again, press **Esc** — overlay closes without applying anything.
9. Click outside the grid (on the dark backdrop) — also cancels.

Test in NO_CAMERA mode as well:
```bash
NO_CAMERA=1 .venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```
The NullCamera returns a blank frame, so the variants will look visually similar, but the flow (propose → apply → clear) still works.

## Active profile lifecycle

- Stored as a module-level dict in `backend/api_compare.py`, guarded by a `threading.Lock`.
- `backend/stream.py:mjpeg_generator` lazy-imports the getter and calls `apply_variant` per frame.
- Profile persists for the life of the server process. It is not written to disk, is shared across all sessions (intentionally global, as it maps to a single physical camera), and is cleared on server restart.

## Known limitations / TODOs

- **Shared across sessions.** In hosted mode the profile affects every connected client because the stream is shared. If Loupe later gains per-session streams, the profile should move into `SessionFrameStore`.
- **Not persisted.** Restarting the server resets to raw frames. A `save_config` call would fix this if desired.
- **Applied only to /stream.** `/frame` (frozen-snapshot fetch) and `/snapshot` still return raw camera frames. Revisit if users expect "what I see is what I save".
- **No undo.** Applying a new variant replaces the previous one; there is no stack. Could add if users ask.
- **Propose operates on the live camera frame, not the frozen one.** If the user froze first with a specific framing, the comparison will still run off the current camera read. This is intentional (goal is tuning the camera) but could be revisited.
- **No live preview of parameter edits.** The 4 variants are fixed candidates; there is no slider-based refinement. That would be a natural follow-up.
