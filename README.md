# Loupe

Open-source optical inspection frontend for DIY and small-shop hardware. Browser-based (vanilla JS + FastAPI backend, no framework, no build step). Streams live video from industrial cameras, provides precision measurement tools, computer vision-based feature detection, DXF-guided part inspection, and multiple instrument modes for surface metrology.

## Instrument Modes

Modes replace each other — calibration units, tool availability, and workflows differ between them.

### Microscope (default)
Precision measurement and feature inspection using a video microscope or machine-vision camera. Covers all measurement tools, DXF-guided inspection, SPC, and surface metrology via Z-stack.

### Deflectometry
Specular surface measurement using an iPad as a phase-shifting display. 8-step phase shifting with gamma pre-correction, Gaussian smoothing, sphere calibration, Frankot-Chellappa height integration, inline 3D viewer, and a diagnostics tab. Requires a local camera/display setup and a controlled enclosure to suppress stray light. Deflectometry projects cannot be created, opened, or imported on the hosted instance.

### Fringe Analysis
Interferometric surface flatness measurement using an optical flat and monochromatic light. Single-image DFT phase extraction, 2D phase unwrapping, Zernike polynomial fitting (up to 66 terms, Noll indexing), PV/RMS/Strehl statistics, PSF and MTF computation, wavefront averaging, contour lines, 3D WebGL viewer, horizontal/vertical profiles, reference standards (ISO 3650, JIS B 7506, ASME B89.1.9, DIN 861), PDF and CSV export.

Drop an interferogram anywhere in the image/result view or camera preview to load it. The full view highlights during file drags; the smaller drop box remains available.

---

## Features

### Measurement (Microscope mode)
- **13 tools on a flat toolbar**: Select, Pan, Note, Distance, Angle, Circle, Best fit (circle/arc), Arc, Area, Shape, Spline, Flatness, Point — plus dedicated Calibrate/Origin buttons and a verb-first **Measure… palette** (`M`) that indexes every measuring task by what you're trying to measure, not which tool draws it
- **Measure panel**: guided procedure steps and a live fit diameter/RMS readout while a tool is armed; switches to a properties face when a measurement is selected, with a name field, nominal/upper/lower tolerance inputs, and a PASS/FAIL chip
- **Relation measurements** (via the palette): circle↔circle distance (between-centers, min-gap, max-span, with X/Y reference-axis patterns), point↔circle distance, perpendicular/parallel distance, slot width, line intersection — pick existing elements or inline-fit points on a bare edge; deleting a referenced element cascades to any dependent relation
- **Canvas comment annotations**: freeform text notes placed on the image
- Pixel ↔ mm calibration (two-point or circle-based), coordinate origin with rotation
- Calibration profiles with per-magnification settings, export/import
- Lens distortion correction, perspective (tilt) correction via 4-point homography
- Undo/redo for measurement edits; perspective correction has a separate undo that also restores the image and calibration
- Sub-pixel edge snapping to the nearest gradient ridge (parabola + Gaussian; browser and server methods); manually drawn segments also snap to nearby annotation and arc endpoints, and closing a loop this way offers a one-click "Create area"
- Numbered `[n]` canvas labels (name + deviation, pass/fail tint) that match the sidebar's numbering exactly

### Detection & Inspection
- **Auto-detection**: Contour-based circle/line detection and partial arc detection, with sub-pixel refinement enabled by default — adjustable Canny thresholds, smoothing, NMS, surface presets (Wire EDM / Lathe / 3D Print)
- **DXF-guided inspection**: Load a DXF drawing, auto-align to the part (edge-based template matching, no circles required), run corridor-based per-feature edge detection with geometric robust circle/arc fits and line inlier filtering; separated competing edges are flagged as ambiguous
- **Manual point-pick**: Click any DXF feature to measure it by placing points along the actual edge; compound features and connected standalone entities auto-assign points to the nearest sub-segment
- **GD&T**: True Position (TP = 2 × radial deviation), Punch/Die tolerance tagging with directional deviation coloring (green/amber/red)
- **Deviation reporting**: Grouped sidebar, hover tooltips with fit RMS and point counts, numbered cross-references to PDF. CSV and PDF export

### Annotation Management
- **Multi-select**: Shift+click, rectangle drag-select; bulk delete/elevate
- **Elevation**: Promote auto-detected features to editable measurements
- **Merge lines**: Combine multiple line segments into one measurement
- **Measurement grouping**: Named groups with uniform color, collapsible sidebar sections
- **Draggable labels**: Reposition any measurement or deviation label, with leader lines
- **Per-annotation visibility toggles**: Eye icon hides individual annotations without deleting them
- **Measurement templates**: Save/load inspection recipes as JSON (DXF entities, calibration, tolerances, detection settings)
- **Geometric constraints**: Select exactly two lines/circles/points and add a perpendicular, parallel, or angle constraint; a pure Gauss-Seidel solver resolves the geometry, with cascade-delete of constraints when a referenced annotation is removed
- **Digital reticle overlays**: Crosshair, grid, angle, radius, and thread-pitch reticles loaded over the live/frozen image, center-fixed and rotatable; custom reticles can be saved from existing annotations
- **Right-click context menu**: Elevate, delete, rename, merge, group, constrain, convert arc→circle, Punch/Die toggle, clear operations

### Surface Metrology (Z-Stack)
- Capture stack + compute all-in-focus composite + per-pixel height map
- ISO 4287 1D and ISO 25178 2D areal roughness parameters (Sa, Sq, Sp, Sv, Sz, Ssk, Sku)
- ISO 25178-606 surface texture parameters, ISO 25178-3 Gaussian S-filter / L-filter
- Spatial texture parameters: Sal, Str, Std
- 2D profile extraction along user-drawn lines with live roughness readout
- Bearing ratio (Abbott-Firestone curve), 2D PSD, plane / poly² detrend
- HDR bracketing + Laplacian pyramid fusion
- 3D textured heightmap viewer with confidence mask and Z calibration
- Quadrature noise-floor compensation

### Multi-Frame Reconstruction
- **Image stitching wizard**: manual tile capture with X/Y µm coordinate tracking, sub-pixel placement, anti-ghost blending
- **Super-resolution wizard**: multi-frame sub-pixel shift, pyramid reconstruction

### Fringe Analysis
- **Explicit setup**: drop or open an interferogram, or capture a camera frame, then review the image, wavelength, area, and analysis settings before clicking **Analyze image**.
- **Simple analysis regions**: fit circles through three edge points, or draw rectangles and ellipses, to include the surface and exclude holes, dust, glare, or background. Select regions to move, resize, change purpose, or delete them; edits support undo and keyboard nudging. Automatic area detection is the default; saved aperture recipes remain available.
- **Surface navigation**: cursor-anchored zoom and bounded panning keep the map in view; **Fit view** restores the complete centered image.
- **Reference marks**: label corresponding locations on the interferogram and surface map in a paired view, with dragging, linked zoom/scroll, deletion and undo. The source preview uses the exact analysis crop and lens correction. Marks remain on the main map and in the project's current result; they do not set contact, height zero or polarity.
- **Coverage and smoothing**: an aligned measurement-area overlay distinguishes included pixels, rejected boundaries and the trusted-only subset. Applied filter widths and aperture coverage explain which pixels contribute and why fine details may be attenuated.
- **Physical orientation records**: record a gap-opening direction, optional contact landmark and user-checked polarity with setup notes; these observations do not set height zero.
- **Fringe lens calibration**: open or drop a separate calibration target in a dedicated dialog, measure equal features across the image, inspect the fit, and apply a reusable lens correction without switching to microscopy.
- **Printable comparison**: PDF reports preserve image proportions and include both aligned images, reference labels, analysis details and physical-orientation records.
- **Bounded fitting allocations**: large Zernike fits use blockwise orthogonal reduction, retaining every measured pixel without allocating the full pixels-by-terms basis matrix.
- **Visible progress**: the analysis dialog shows server-reported stages, a progress bar, and a timestamped activity log. Errors stay visible for adjustment and retry.
- **Clear source and reset**: the sidebar identifies the current image and completion time. Loading another image clears the previous result. **Reset analysis** clears the current source, regions, results, and measurements while preserving analysis settings and session capture history.

Scientific background and references: [DFTFringe](https://github.com/githubdoe/DFTFringe) was the main recorded application/source-code reference; [Noll (1976)](https://doi.org/10.1364/JOSA.66.000207) supplies the Zernike convention named in the implementation. The subsequent scientific audit and validation draw on [Takeda, Ina & Kobayashi (1982)](https://doi.org/10.1364/JOSA.72.000156) for Fourier fringe analysis, [Herráez et al. (2002)](https://doi.org/10.1364/AO.41.007437) and the [scikit-image documentation](https://scikit-image.org/docs/stable/api/skimage.restoration.html#skimage.restoration.unwrap_phase) for the independent reliability-sorted unwrapper, [Zhao et al. (2011)](https://doi.org/10.1364/AO.50.006214) for quality-guided unwrapping and its limits, [Goldstein, Zebker & Werner (1988)](https://doi.org/10.1029/RS023i004p00713) to distinguish branch-cut methods from Loupe's custom heap flood, and [Doiron & Beers' NIST Gage Block Handbook, chapter 6](https://www.nist.gov/sites/default/files/documents/calibrations/mono180.pdf) for interferometric length measurement and fringe-order ambiguity. [Reeve's NBS/NIST optical-flat calibration procedure](https://www.nist.gov/system/files/documents/calibrations/75-975.pdf) and [Edmund Optics' optical-flat guide](https://www.edmundoptics.com/knowledge-center/application-notes/optics/optical-flats/) inform the contact/wedge and height-sign interpretation. [SciPy's Jacobi polynomial evaluator](https://docs.scipy.org/doc/scipy/reference/generated/scipy.special.eval_jacobi.html) provides an independent numerical check of the Zernike basis. These references and synthetic tests do not establish instrument accuracy; the [scientific-basis and validation record](docs/fringe-scientific-basis.md) documents provenance, measured software behavior, and remaining physical validation.

### SPC & Analytics
- SQLite run storage (parts → runs → results)
- Cpk with feature-type-aware one-sided/two-sided calculation and capability rating; zero observed variation is reported as unavailable, not as a numeric capability score
- Canvas 2D trend charts with tolerance bands
- SPC CSV export (all SPC features are disabled in hosted mode)

### Camera & Session
- Live MJPEG stream from industrial cameras (Baumer/Aravis, OpenCV, browser MediaDevices API)
- Camera controls: log-scale exposure and gain sliders, companion exact-value inputs, pixel format, ROI set-from-view/reset, auto white balance, RGB white balance
- Live 32-bin luma histogram with clip warnings; client-side auto-exposure loop
- 4-quadrant image comparison (Keyence-style: 4 live views, independent settings)
- Freeze frame for measurement; auto-freeze on detection
- **Projects**: typed project tabs (microscopy is multi-tab; deflectometry/fringe are singleton, one tab of each) with a home screen and recents grid; browser-local IndexedDB autosave roughly every 2 seconds after changes and on project tab switch/close
- **Portable projects**: `.loupe` export/import preserves the microscopy image, measurements, calibration, and viewport, or the latest instrument result and its saved settings, masks, and measurements. Imported fringe images and retained original lens images are included when available. Server capture history, running averages, and live hardware jobs are temporary; export captures/runs separately. Legacy v3 session JSON still imports but contains no image
- Snapshot capture and drag-and-drop image load
- Export: annotated PNG, measurement CSV, inspection CSV, inspection PDF (jsPDF, bundled locally), DXF (reverse engineering — measurements → DXF in mm)

### Zoom & Pan
- Scroll-wheel zoom centered on cursor (frozen mode, up to 10x)
- Pan tool (`H` key) and middle-mouse-button pan
- Zoom presets: `0` = fit to window, `1` = 1:1 pixel mapping
- Zoom indicator badge with clickable preset dropdown (Fit, 50%–800%)
- Minimap overview when zoomed in; measurement grid overlay

### Hosted Mode
- Image processing with isolated browser/project sessions: a signed HttpOnly, SameSite=Strict owner cookie scopes each public project UUID to its browser. Sharing a `.loupe` file does not share access to the original browser's live server data
- Projects stay in browser-local IndexedDB; processing uploads images and analysis data to temporary server memory. A notice appears before the first upload. Expiry or a server restart clears transient frames/results
- CSP headers, rate limiting, input validation, error scrubbing
- Image upload limits: 20 MiB encoded, 16,777,216 decoded pixels, and 8192 pixels per side; fringe analysis downsamples to a maximum dimension of 2048 pixels
- Three concurrent fringe compute jobs, with slots retained until computation finishes even if the client disconnects. Excess work returns HTTP 503 for retry; retained frame and fringe caches have memory budgets
- Stitch, super-resolution, Z-stack, SPC, and hardware-only deflectometry are unavailable
- jsPDF bundled locally (no third-party CDN)
- Deployment helpers for Ubuntu/Apache: `deploy.sh` updates the existing systemd installation; `deploy/install.sh` and `deploy/update.sh` use supervisord

When hosting behind a TLS reverse proxy, forward the original HTTPS scheme (Apache: `RequestHeader set X-Forwarded-Proto "https"` in the TLS virtual host) and configure Uvicorn to trust only the proxy. Bind the backend to loopback when the proxy is on the same host. Verify that the session cookie includes `Secure`, `HttpOnly`, and `SameSite=Strict` on the public HTTPS endpoint. Browser session isolation does not provide user accounts or access control for the public app.

### Image corrections and measurement validity

Apply **lens correction first, then perspective correction**, before making measurements. Lens corrections always resample the retained original image; applying the same coefficient again leaves it unchanged. Loading a zero-coefficient lens profile restores the original pixels. Changing or resetting the correction clears old measurements, DXF geometry, inspection results, and ordinary undo/redo history because their pixel coordinates no longer match the image.

Perspective correction sets the pixel-to-mm scale from the known rectangle dimensions and clears the old geometry. Its dedicated undo restores the preceding image, calibration, geometry, and undo history within that open project; it does not survive a reload or `.loupe` export/import. Undo perspective correction before changing the lens correction, or reload the original image. Older corrected projects without a retained original can keep their current lens correction but require the original image to change or reset it.

### Help System
- Two-panel layout (nav tree + content page), 20+ pages covering every tool, algorithm, workflow, and export format

---

## Requirements

- Python 3.11+ (3.13 recommended)
- For GigE/USB3 Vision cameras (Baumer, etc.): [Aravis](https://github.com/AravisProject/aravis) via Homebrew

## Installation

```bash
# Install Python (macOS)
brew install python@3.13

# For industrial cameras (optional)
brew install aravis

# Clone and set up
git clone <repo-url>
cd microscope
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Running

### With a camera

```bash
./server.sh start
```

Open [http://localhost:8000](http://localhost:8000). Logs in `.server.log`.

```bash
./server.sh stop      # stop the server
./server.sh restart   # restart
./server.sh status    # check if running
```

### Without a camera

```bash
NO_CAMERA=1 .venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Load images via drag-and-drop or the File menu for image measurement and analysis. Live capture and hardware workflows require the corresponding camera/display setup.

### Camera priority

1. `NullCamera` — if `NO_CAMERA=1` or `config.json` `no_camera: true`
2. `AravisCamera` — GigE/USB3 Vision (Baumer, etc.)
3. `OpenCVCamera` — fallback (camera index 1)
4. `NullCamera` — final fallback with warning

Browser cameras (MediaDevices API) are selectable from the camera dropdown after granting permission.

## Flatness and form removal

New analyses default to **Flatness · Plane (tilt only)** in both execution modes.
This subtracts height offset and a least-squares plane while retaining curvature,
bow, saddle shape and local errors. PV/RMS describe departure from that plane;
they are not minimum-zone flatness (the least separation of enclosing parallel
planes). Reference-flat error remains included. Existing saved analyses retain
their original model. Zernike remains an advanced diagnostic and selective
removal option: fitting its coefficients does not itself remove surface errors.
Subtracting terms above Z3, or using quadratic/cubic polynomial removal, reports
**Residual after form removal**, with Residual PV/RMS and no flatness-limit
comparison. CSV/PDF exports record the evaluation and removed form.

## Experimental browser fringe analysis

In the fringe setup dialog, choose **Analyze using → This browser (experimental)**.
The existing Python analysis engine runs in a dedicated Web Worker through
[Pyodide](https://pyodide.org/en/stable/usage/webworker.html), with WebAssembly
builds of NumPy, SciPy, OpenCV, scikit-image and Matplotlib. This is browser
execution of the shared implementation, not a second JavaScript reconstruction
algorithm. Images and computed grids are not uploaded by this path. The app
still downloads assets, configuration and the numerical runtime; it is not an
offline standalone application.

Server analysis remains the default. Browser images are explicitly capped at
1024 pixels on the longest side; results and exports record the execution
engine and any resizing. The first run downloads sizeable scientific libraries
from the pinned Pyodide 0.29.3 distribution on jsDelivr. Workers keep libraries
warm for immediate recomputations and release them after two idle minutes.
Cancel/reset/project switching terminates active computation. There is no
automatic fallback to uploading if browser execution fails.

Analysis, masks, lens correction, diagnostics, form removal, inversion, carrier
selection, 3D inspection, reports, session averaging and subtraction use the
local result. Browser session history retains at most eight captures / 48 MiB
across open projects and disappears on page reload; the current result and input
remain in the normal saved project. Browser mode does not yet support capture
JSON import or the live-camera running-average button. Camera acquisition and
the lens-calibration workflow still use their existing connections.

For numerical parity validation, copy the checkout to an isolated directory,
then generate the synthetic reference results and test page into its frontend:

```bash
MPLCONFIGDIR=/tmp/loupe-mpl .venv/bin/python scripts/prepare-fringe-browser-validation.py /tmp/loupe-browser-review/frontend
HOSTED=1 NO_CAMERA=1 .venv/bin/python -m uvicorn backend.main:app --app-dir /tmp/loupe-browser-review --port 8004
```

Open `http://localhost:8004/fringe-validation.html` and run validation. The harness
compares raw execution across runtimes for asymmetric and mirrored inputs,
off-centre masks with lens correction, a resized 1024-pixel image, form changes,
averages and subtraction. Its 0.011 nm grid tolerance allows one 0.01 nm
serialization rounding step; it is a software parity limit, not an optical
accuracy claim. On the development Mac (2026-10-24), all six cases passed:
mask grids matched exactly, maximum serialized-height difference was 0.01 nm,
and maximum PV difference was 0.000085 nm. The 1024-pixel case took 18.7 seconds;
small warm analyses took about one second. These timings are illustrative and
will vary by browser and hardware. Use the hosted security policy during testing: WebAssembly and
the pinned download origin are permitted only on the dedicated worker response;
the main page retains its existing script policy. `/fringe-runtime/source.zip`
contains only three explicitly allowlisted, public scientific source files.

## Configuration

Runtime settings in `config.json`:

| Key | Description |
|-----|-------------|
| `camera_id` | Aravis device ID, or `null` for first found |
| `no_camera` | `true` to always start without a camera |
| `app_name` | Title in top bar and browser tab |
| `theme` | UI theme (`macos-dark`) |
| `tolerance_warn` | Global warning tolerance in mm (default 0.10) |
| `tolerance_fail` | Global failure tolerance in mm (default 0.25) |
| `fringe_wavelengths` | Named wavelength presets for fringe analysis (nm) |
| `fringe_standards` | Reference standard tolerance tables for fringe analysis |

## Tests

```bash
.venv/bin/pytest tests/                 # backend tests
node --test tests/frontend/test_*.js    # frontend tests (Node.js required)
```

The fringe scientific checks compare independently generated phases and images,
scikit-image unwrapping, and Jacobi-reference Zernike modes. To include their
numerical error and amplitude-transfer measurements in a machine-readable report:

```bash
.venv/bin/pytest -q tests/test_fringe_scientific_validation.py \
  --junitxml=/tmp/loupe-fringe-validation.xml -o junit_family=legacy
```

`tests/test_metrology_accuracy.py` and `tests/frontend/test_metrology_accuracy.js`
exercise fractional analytic edges across blur, noise, phase and orientation,
including calibration snapping, production detection/inspection, short arcs,
outliers, and ambiguous edges. These establish software regression limits;
optical accuracy still needs validation against independently measured references.
`tests/test_caliper_and_pose_accuracy.py` also checks raw-profile inspection and
fractional rigid alignment, including competing edges, transformed arc sectors,
clipped profiles, fixed rotation, and explicit alignment datums.
Circle fit standard errors describe independent point noise conditional on the fit,
excluding scale, lens, alignment, and neighboring-pixel correlation.

In the DXF menu, **Edge sampling** selects raw calipers (the default for new
setups) or the Canny contour path. Calipers average raw intensities across a
width, filter the normal profile, localize fractional derivative peaks, and
weight geometric fits by edge contrast. Search width, caliper width, sigma,
brightness polarity and edge choice are saved with the overlay and templates.
Polarity means brightness change going outward: away from a circle's centre,
away from a closed outline's interior, or away from the drawing centre for a
standalone line. "Outward" is decided in image coordinates after the overlay
transform, so the direction a CAD line was drawn, a closed polyline's vertex
order, and overlay flips do not change it; a line through the drawing centre
falls back to a fixed orientation (reported as `normal_rule: "canonical"` in the
sampling diagnostics). Punch/Die tags alone cannot determine brightness. The
default requires a unique edge; explicit first (the first edge met going
outward from the inner end of the search range), strongest or closest choices
should reflect the intended boundary. Fit and
sampling diagnostics appear in inspection tooltips. Existing templates and
API requests without an edge method retain the contour path and its
measurements; where a contour corridor holds separated competing edges, the
result stays matched with the same measurement and verdict but carries
`ambiguous: true` and a `reason` (gear tooth segments are never flagged).
Ambiguous results remain amber in the canvas, group badges, and PDF report;
the inspection summary counts ambiguous and unmatched features explicitly.
Saved SPC runs retain these flags and their reasons (existing databases migrate
automatically). Ambiguous or unmatched results require review and are excluded
from capability statistics, with the excluded count shown in the SPC panel.

Edge alignment interpolates correlation peaks then refines translation and
rotation against raw caliper edges at a fixed calibrated scale. Poorly
constrained poses retain the coarse match and include a reason in the response.
It uses a global drawing fit unless entities explicitly carry
`alignment_datum: true`; marked entities then define both coarse and refined
alignment, so other features cannot absorb defects into the pose. Per-entity
`edge_polarity` and `edge_selection` can override guided caliper recipe choices.

No camera hardware required.

## Project Structure

```
backend/
  cameras/              BaseCamera + AravisCamera, OpenCVCamera, NullCamera
  vision/
    detection.py               Edge/circle/line/arc detection with preprocessing
    guided_inspection.py       DXF-guided corridor inspection + manual fitting
    line_arc_matching.py       DXF↔detected feature matching, shared transforms
    dxf_parser.py              DXF → JSON (LINE, CIRCLE, ARC, LWPOLYLINE with bulge)
    dxf_export.py              Measurements → DXF (reverse engineering export)
    alignment.py               Circle-based and edge-based DXF auto-alignment
    calibration.py             Pixel↔mm math
    subpixel.py                Gradient-ridge snapping and sub-pixel refinement
    geometry.py                Robust geometric circle/arc fit and diagnostics
    focus_stack.py             Depth-from-focus stack computation, HDR fusion
    heightmap_analysis.py      ISO 25178 areal roughness, spatial texture, PSD
    stitch.py                  Image stitching with sub-pixel placement
    superres.py                Super-resolution pyramid reconstruction
    mask_utils.py              Shared polygon mask rasterization (fringe + deflectometry)
    deflectometry.py           Phase-shifting deflectometry processing pipeline
    deflectometry_geometry.py  Deflectometry geometry kernel (camera/screen pose, slope→height)
    deflectometry_compute.py   Slope solver + paraboloid fit + uncertainty propagation
    screen_shape.py            iPad display-surface geometric model
    screen_shape_solver.py     Ball-calibration back-end (screen pose + panel bow)
    ball_detection.py          G20 ball detection for deflectometry calibration
    fringe.py                  DFT interferometric analysis, Zernike fitting, PSF/MTF
    gear_analysis.py           Gear tooth detection and spacing analysis
    gear_geometry.py           Involute/cycloidal gear geometry generation
    gear_phase.py              Gear phase estimation
    settings_proposer.py       Detection preset proposer
  api.py                 Core REST endpoints (stream, freeze, snapshot, DXF, calibration)
  api_camera.py          Camera controls and enumeration endpoints
  api_detection.py       Detection and sub-pixel snap endpoints
  api_inspection.py      Guided inspection and feature fitting endpoints
  api_deflectometry.py   Deflectometry HTTP API
  api_fringe.py          Fringe analysis HTTP API
  api_zstack.py          Z-stack depth-from-focus HTTP API
  api_stitch.py          Image stitching HTTP API
  api_superres.py        Super-resolution HTTP API
  api_compare.py         4-quadrant comparison HTTP API
  api_runs.py            SPC run storage endpoints
  api_reticles.py        Reticle preset listing/serving endpoints
  main.py                App factory, camera selection, router registration
  stream.py              Background-thread camera reader
  session_store.py       Per-session frame isolation (SessionFrameStore) for hosted mode
  compute_pool.py        Bounded fringe computation, including disconnected clients
  image_upload.py        Hosted upload size/dimension checks before image decoding
  calibration_store.py   Persistent deflectometry CalibrationSession JSON store
  screen_shape_store.py  Persistent ScreenShape (iPad panel geometry) JSON store
  run_store.py           SQLite SPC run storage
  rate_limit.py          Request rate limiting middleware
  config.py              Atomic JSON config load/save
frontend/
  main.js                    Entry point, event wiring, undo/redo, context menu, point-pick
  state.js                   Global state, undo stack, type classifications
  workspace.js               Swap-on-activate workspace state for project tabs (STATE_FIELDS, _epoch)
  instrument-workspace.js    Instrument settings/result persistence helpers
  image-geometry.js          Geometry snapshots and invalidation after image corrections
  perspective-math.js        Perspective destination geometry and metric scale
  modes.js                   Mode switcher (Microscope / Deflectometry / Fringe)
  shell.js                   Preact app bar (tab strip), modal dialogs and toasts
  toolbar.js                 Flat row-2 toolbar: every tool as icon+text, sub-mode segment
  palette.js                 Measure… verb-first task palette (relation measurements live here)
  measure-panel.js           Guided procedure steps + live fit readout, and the tolerance/PASS-FAIL properties face
  procedures.js              Per-tool guided-procedure step text (shared by status bar + Measure panel)
  spec.js                    Tolerance spec evaluation (nominal/upper/lower → pass/fail)
  numbering.js               Single numbering authority for sidebar rows and canvas [n] labels
  render.js                  Canvas rendering, viewport transform, draw dispatch
  render-annotations.js      Per-type annotation draw functions
  render-dxf.js              DXF overlay rendering, dxfToCanvas coordinate transform
  dxf-transform.js           Pure DXF→canvas transform math (unit-tested independently)
  render-hud.js              HUD rendering (crosshair, zoom badge, minimap)
  render-reticle.js          Digital reticle overlay renderer (screen-space HUD layer)
  label-clamp.js             Pure geometry for keeping annotation labels on screen
  viewport.js                Zoom/pan state, imageToScreen/screenToImage transforms
  tools.js                   Tool logic, hit-testing, snap, drag, DXF entity selection
  hit-test.js                Hit-testing helpers
  constraints.js             Geometric constraint CRUD (perpendicular/parallel/angle), cascade delete
  constraint-solver.js       Pure Gauss-Seidel constraint solver (10 projection functions)
  events-mouse.js            Mouse event handlers
  events-keyboard.js         Keyboard shortcut handlers
  events-inspection.js       Guided inspection event handlers
  events-context-menu.js     Right-click context menu
  dxf.js                     DXF overlay, alignment, guided inspection handler
  detect.js                  Detection button handlers with busy indicators
  annotations.js             Add/delete/elevate/merge/clear annotations
  session.js                 Legacy v3 JSON session export/import, CSV/PDF/DXF export
  project-format.js          Pure codecs: tab record ↔ workspace v4 JSON ↔ .loupe file
  projects-db.js             The only persistence layer: browser-local IndexedDB, in-memory fallback
  tab-manager.js             Typed project tabs: open/activate/close, swap-on-activate, autosave
  project-io.js              .loupe export/import, legacy session/autosave migration, drag-in
  home-screen.js             Preact home screen: new-project cards, IndexedDB recents grid
  upload-notice.js           One-time hosted-mode "image is sent to the server" notice
  sidebar.js                 Sidebar, inspection table, camera controls
  spc.js                     SPC trend charts, Cpk display
  template.js                Measurement template save/load
  cal-profiles.js            Calibration profile management
  lens-cal.js                Lens distortion calibration
  tilt-cal.js                Perspective (tilt) calibration
  subpixel-js.js             Client-side sub-pixel snapping (parabola + Gaussian)
  stitch.js                  Image stitching wizard UI
  superres.js                Super-resolution wizard UI
  zstack.js                  Z-stack workflow UI
  zstack-3d.js               3D textured heightmap viewer (WebGL)
  deflectometry.js           Deflectometry workspace UI
  cross-mode.js              Shared cross-mode editing infrastructure
  fringe.js                  Fringe analysis workspace coordinator: shared state, init lifecycle
  fringe-panel.js            Fringe left panel: capture workflow, mask drawing, averaging
  fringe-setup.js            Analysis setup dialog, region editor, progress workflow
  fringe-region.js           Three-point circle fitting and editable mask geometry
  fringe-viewport.js         Cursor-anchored surface zoom and pan limits
  fringe-measure.js          Fringe surface-map measurement tools
  fringe-results.js          Fringe results column, Zernike pills, 3D view, CSV/PDF export
  fringe-progress.js         SSE streaming client + progress bar for fringe analysis
  fringe-trend.js            In-session PV/RMS trend chart (inline SVG)
  fringe-calibration.js      Client-side fringe calibration record CRUD
  fringe-geometry.js         Client-side fringe aperture/geometry recipe CRUD
  fringe-lens-profiles.js    Fringe lens distortion profile CRUD
  compare.js                 4-quadrant image comparison UI
  browser-camera.js          MediaDevices browser camera integration
  comment-editor.js          Canvas comment annotation editor
  reticle.js                 Reticle CRUD: load list, load/unload, save custom from annotations
  math.js                    fitCircle, fitLine, fitCircleRobust, geometry helpers
  format.js                  Number formatting utilities
  api.js                     apiFetch wrapper (session token, hosted-mode handling)
  gear.js                    Gear analysis UI (parked)
  index.html                 App shell
  deflectometry-screen.html  Deflectometry display page (served to iPad)
  style.css                  macOS-dark theme
  vendor/                    Vendored preact.mjs + htm.mjs (plain ES module imports, no bundler)
tests/                  pytest suite (no camera required)
docs/                   Local working notes, design specs, plans, roadmap — gitignored, not part of the repo
snapshots/              Saved test images
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `M` | Open the Measure… palette (verb-first task index) |
| `V` | Select tool |
| `H` | Pan |
| `T` | Note (comment annotation) |
| `D` | Distance |
| `A` | Angle |
| `O` | Circle |
| `R` | Area |
| `L` | Flatness (fit-line) |
| `P` | Point |
| `C` | Calibrate |
| `U` | Elevate selected detections |
| `S` | Export the current session as JSON |
| `?` | Open the Help/Documentation dialog |
| `` ` `` | Toggle measurement grid |
| `0` | Fit zoom to window (frozen image only) |
| `1` | 1:1 pixel zoom (frozen image only) |
| `Escape` | Cancel the current pick / close the palette / exit mode / deselect |
| `Delete` / `Backspace` | Delete selected |
| `Ctrl+Z` | Undo (or remove the last placed point mid-measurement) |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| Arrow keys | Nudge the selected annotation, or pan when frozen (hold Shift for a larger step) |
| `Shift+P` | Export the raw frozen frame as PNG (no overlays) |
| Space (hold) | Temporary pan, Figma/CAD-style |

## License

Copyright 2026 Quintin Smits.

Loupe is licensed under the [Apache License, Version 2.0](LICENSE).
You may use, modify, and redistribute it, including commercially, subject to
the license terms. See [NOTICE](NOTICE) for attribution and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled library licenses.
Third-party components remain under their respective licenses.
