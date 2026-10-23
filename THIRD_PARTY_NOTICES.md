# Third-party notices

Loupe's Apache-2.0 license does not replace the licenses of third-party
components. Preserve the notices below and the referenced license files when
redistributing those components.

## Preact 10.26.4

- Bundled file: `frontend/vendor/preact.mjs`
- Upstream: <https://github.com/preactjs/preact/tree/10.26.4>
- Copyright (c) 2015-present Jason Miller
- License: MIT; full text in [frontend/vendor/preact.LICENSE](frontend/vendor/preact.LICENSE).

## htm 3.1.1

- Bundled file: `frontend/vendor/htm.mjs`
- Upstream: <https://github.com/developit/htm/tree/3.1.1>
- Copyright 2018 Google Inc.
- License: Apache-2.0; upstream license and copyright notice in
  [frontend/vendor/htm.LICENSE](frontend/vendor/htm.LICENSE).

## jsPDF 2.5.1

- Bundled file: [frontend/lib/jspdf.umd.min.js](frontend/lib/jspdf.umd.min.js)
- Upstream: <https://github.com/parallax/jsPDF/tree/v2.5.1>
- License: MIT. The bundled file retains the full license, copyright notices,
  and additional notices for its embedded components.

## Installed dependencies

Python packages listed in `requirements.txt` and other separately installed
dependencies retain their own licenses and notices. Consult the license files
in the distributions you install or redistribute.

## Browser scientific runtime

Experimental browser analysis downloads Pyodide 0.29.3 and its scientific
packages from the version-pinned official Pyodide distribution on jsDelivr.
These runtime artifacts are not bundled into this repository. Pyodide and
NumPy, SciPy, OpenCV, scikit-image, Matplotlib, Pillow and their dependencies
retain the licenses and notices shipped in their distributions. Runtime
source and license information: <https://github.com/pyodide/pyodide/tree/0.29.3>.
