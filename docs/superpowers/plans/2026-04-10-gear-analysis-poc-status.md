# Gear Analysis PoC — Build Status (2026-04-10)

PoC built end-to-end while you were at dinner. Ready for you to test.
Server has been restarted, so you will need to re-freeze the gear frame
and re-fit the tip/root circles in the browser.

## Commits

1. `b756284` feat: gear tooth width analysis via PCD sampling
2. `e0b8f99` feat: /analyze-gear endpoint wired to gear_analysis module
3. `48babf7` feat: gear analysis click flow, overlay + sidebar results

## How to run the smoke test

1. **Freeze a frame** of the gear under the scope (❄ button, top right).
2. **Fit the tip circle** (Circle tool → click 3 points around the tooth tips, or use your existing flow).
3. **Fit the root circle** (same tool, 3 points around the root fillets).
4. **Click the new "Gear" button** in the top-bar (next to the `Surface` button).
5. Status bar reads *"Click the TIP (outer) circle annotation"*. Click the tip circle you just fitted.
6. Status bar reads *"Now click the ROOT (inner) circle annotation"*. Click the root circle.
7. A `prompt()` dialog asks *"How many teeth on this gear?"*. Default is 17. Press OK.
8. Watch the overlay appear: dashed cyan PCD + solid yellow L→R arc on each tooth + T1..T17 labels.
9. The sidebar panel **"Gear Analysis"** shows the per-tooth table.

## What to check

Compare the auto-measured widths for your clean reference teeth against
the manual values from earlier today. Tooth numbering is different —
the PoC numbers from whichever tooth is closest to angle 0° (image +x
axis), while you numbered them visually. Match by position, not index.

Manual reference:
| Manual # | Manual ° |
|----------|----------|
| T3       | 9.93     |
| T5       | 9.38     |
| T11      | 9.07     |
| T13      | 9.37     |

**Pass criteria:** those four auto-widths within ±0.1° of the manual
values.

**Soft pass:** consistent offset across all four (likely the
(tip+root)/2 PCD approximation biasing slightly off the module-derived
PCD). Record the offset and we can add a manual PCD override in V2.

**Fail:** ordering disagrees with the manual run on any clean tooth.
Do NOT hack the algorithm. The point of the PoC was to learn where it
breaks. Report what you saw and we iterate on the spec.

## What's in / out

In: the one-button workflow described above, the canvas overlay, the
sidebar table, and signed µm deviation at the PCD using your active
calibration.

Out (as scoped): auto-detecting which circle is tip/root, Pt-Circle
tip-bend check, CSV/PDF export, tolerance colouring, manual PCD
override, wizard-style modal, module-derived PCD.

## Test coverage

- `tests/test_gear_analysis.py` — 4 tests, all passing:
  - Synthetic 17-tooth gear tooth widths within 0.1°
  - Synthetic 17-tooth centers uniformly spaced within 0.1°
  - n_teeth out-of-range raises
  - tip_r ≤ root_r raises
- `tests/test_api.py` — 3 new endpoint tests, all passing:
  - Requires /freeze first (400)
  - Returns expected JSON shape on a frozen frame
  - Rejects tip_r ≤ root_r via pydantic (422)
- Full suite: 317 passed, 1 skipped. No regressions.

## Notes the PoC exposed

- **Pixel quantization matters.** The initial synthetic gear used a
  cv2.ellipse rasterizer whose antialiased edges pushed the Otsu
  crossings outward by ~0.8°. Swapped to an exact numpy polar
  rasterizer and widths landed within 0.1°.
- **Size of the test gear matters.** At 400×400 the synthetic flank
  crossing had ~0.2° of quantization noise per flank. Scaled to
  1200×1200 it's well below 0.1°. Your real gear fills the frame
  so it has even more pixels-per-degree — should be fine.
- **Automatic polarity selection** (material-dark vs material-light)
  works by picking the polarity whose top-N longest runs are most
  uniformly spaced around the PCD. Robust on the synthetic test;
  worth eyeballing on the real gear.
