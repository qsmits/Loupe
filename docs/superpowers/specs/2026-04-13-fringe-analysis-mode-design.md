# Fringe Analysis Mode — Design Spec

## Goal

Add a Fringe Analysis mode to Loupe for quantitative surface flatness measurement using monochromatic interferograms. Primary use case: inspecting lapped parts with an optical flat. Secondary: inspecting optical flats themselves.

## Context

The user has sodium lamps and 8–10 optical flats up to 200mm. The workflow is: place an optical flat on a lapped part, illuminate with monochromatic light, observe interference fringes through the camera. Straight fringes = flat; curved fringes = surface error. Currently this is done by eye. This mode quantifies it.

DFTFringe is the reference application, but we're focused on flats/lapped parts (not lenses or telescope mirrors). No PSF/MTF needed.

## Architecture

Follows the deflectometry mode pattern exactly:

- **`frontend/fringe.js`** — workspace DOM builder, lazy init via `initFringe()`, MutationObserver lifecycle
- **`backend/api_fringe.py`** — `make_fringe_router(camera)` factory, included in main router
- **`backend/vision/fringe.py`** — pure functions: DFT phase extraction, unwrapping, Zernike fitting, surface map rendering, focus quality metric
- **`tests/test_fringe.py`** — unit tests for the vision module

**Key difference from deflectometry:** No multi-frame session. Each analysis is self-contained — one image in, results out. The backend is stateless per request (no accumulated captures). The Zernike coefficients are cached client-side so toggling subtraction checkboxes can recompute locally without a round-trip for the surface map re-render (or a lightweight re-render endpoint).

## Capture

Three ways to get an image:

1. **Freeze & Analyze** — freezes the live camera feed, sends the frame to the backend for DFT phase extraction. Single button, single action.
2. **Drag & drop** — accepts image files (PNG, JPEG) dropped onto the preview area. Same analysis pipeline.
3. **Re-analyze** — after adjusting mask threshold or Zernike subtraction, recompute without recapturing.

No multi-step workflow. No external devices (no iPad, no piezo). The simplest mode.

## Analysis Pipeline

Backend, single POST request (`/fringe/analyze`):

1. Convert to grayscale if needed
2. Compute modulation map from local contrast → auto-mask (reject pixels below threshold)
3. 2D FFT of the masked interferogram
4. Isolate the +1 order carrier frequency sideband (strongest off-center peak)
5. Shift sideband to origin, inverse FFT → complex analytic signal
6. Extract wrapped phase: `atan2(Im, Re)`
7. Spatial phase unwrapping (quality-guided, same algorithm as deflectometry)
8. Fit Zernike polynomials (36 terms, Noll ordering) over the masked aperture
9. Subtract selected terms (tilt X/Y always on by default)
10. Convert phase to physical height: `height = phase × λ / (4π)` — reflection doubles the optical path, so each fringe = λ/2 of surface height
11. Compute PV (peak-to-valley) and RMS of the residual surface
12. Render false-color surface map as PNG
13. Return: surface map image, all 36 Zernike coefficients (in waves and nm), PV, RMS, modulation stats, focus quality score

**Re-analysis endpoint** (`/fringe/reanalyze`): accepts the cached Zernike coefficients + which terms to subtract + wavelength. Returns new surface map, PV, RMS without redoing the FFT. This makes checkbox toggling fast.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Wavelength | Sodium (589 nm) | Dropdown of presets with source name: Sodium (589 nm), HeNe (632.8 nm), Green LED (532 nm), Custom. Custom shows a numeric input. |
| Mask threshold | 0.15 | Slider (0–1). Reject pixels with modulation below this fraction of the maximum. Auto-handles holes, irregular shapes, ring-shaped parts. |

## Zernike Subtraction Panel

Left column, below settings. Checkboxes for term groups:

| Checkbox | Terms | Default | Notes |
|----------|-------|---------|-------|
| Tilt X/Y | Z1, Z2 | Always on | Wedge angle between flat and part, not a surface error. Cannot be unchecked. |
| Power | Z4 | Off | Overall convexity/concavity. Critical metric for flats — report but don't subtract by default. |
| Astigmatism | Z5, Z6 | Off | Saddle-shaped error, common in lapped flats. |
| Coma | Z7, Z8 | Off | Asymmetric error, less common in flats. |
| Spherical | Z9 | Off | Rotationally symmetric hill/valley. |

Toggling a checkbox recomputes the surface map, PV, and RMS via the lightweight re-analyze endpoint. The Zernike bar chart dims/stripes subtracted terms.

## Workspace Layout

Two-column layout matching deflectometry:

### Left Column

1. **Camera preview** — live feed with simulated fringe overlay while live
   - Scroll-to-zoom inside the preview (viewport controls)
   - Click to pop up full-size temporary overlay (Escape/click to dismiss)
   - Focus quality indicator below preview (gradient-based sharpness score, 0–100 bar)
2. **Capture section** — "Freeze & Analyze" button + drag-and-drop hint text
3. **Settings** — wavelength preset dropdown, mask threshold slider
4. **Subtract Terms** — Zernike checkboxes as described above

### Right Column

1. **Summary bar** — always visible at top:
   - PV in λ and nm (e.g., "PV 0.37λ (218 nm)")
   - RMS in λ and nm
   - Current wavelength and which terms are subtracted
2. **Tab bar** with four tabs:
   - **Surface Map** — false-color height map, fits available space (no forced scrolling), zoom/pan (scroll + drag), color bar with nm scale
   - **3D View** — Three.js viewer (reuse deflectometry pattern), Z exaggeration slider
   - **Zernike** — horizontal bar chart of all 36 coefficients, labeled with term names, values in λ and nm, subtracted terms shown dimmed/striped
   - **Profiles** — horizontal and vertical cross-section through the center of the surface map, plotted as height (nm) vs position (px or mm if calibrated)

### Empty state

Before any capture: "Freeze a frame or drop an interferogram image to analyze."

## Help Documentation

Fringe mode help pages follow the same tabbed structure as microscope and deflectometry. Pages should assume the user knows what an optical flat is but has never done computational fringe analysis. Each page explains both the software and the physics:

1. **How It Works** — what fringes are (λ/2 air gap per fringe), how DFT extraction works conceptually (not math-heavy), what the output means
2. **Setup** — how to get a good interferogram: clean surfaces, monochromatic light, camera focus, vibration isolation, recommended lighting angle
3. **Zernike Terms** — what each term looks like (described or with small diagrams), what physical surface errors cause them, why tilt is always subtracted, when to subtract power vs report it
4. **Capture & Analyze** — the three capture methods, what the focus quality indicator means, re-analysis workflow
5. **Results** — how to read the surface map, what PV and RMS mean practically ("your surface deviates by at most X nm"), interpreting the Zernike bar chart, using profiles
6. **Specifications** — how to relate results to optical flat grades (λ/4, λ/10, λ/20), what "waves" means, typical values for different surface qualities

## Testing

Unit tests in `tests/test_fringe.py`:

- **Phase extraction:** generate a synthetic interferogram with known carrier frequency and phase, verify extracted phase matches within tolerance
- **Zernike fitting:** generate a surface with known Zernike coefficients, fit, verify recovery
- **Zernike subtraction:** verify that subtracting tilt from a tilted+curved surface leaves only the curve
- **Height conversion:** verify λ/2 per fringe at known wavelengths
- **Auto-mask:** verify that a ring-shaped fringe pattern correctly masks the center hole
- **PV/RMS:** verify against manually computed values on a known surface
- **Focus quality:** verify sharp image scores higher than blurred version

## Not in v1 (parked ideas)

- Cross-mode calibration sharing (microscope px/mm → fringe mode physical dimensions)
- Cross-mode annotation overlay (microscope annotations visible in fringe mode)
- Custom profile lines (click to place arbitrary cross-sections on surface map)
- Phase-shifting capture (piezo-based multi-frame, requires hardware)
- Lens distortion correction from microscope lens cal
- Part centering pattern on display
