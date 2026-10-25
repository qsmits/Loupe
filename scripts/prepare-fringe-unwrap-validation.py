"""Prepare a browser regression that exercises 32-bit NumPy index boundaries.

Run with an output frontend directory; serve it with the normal local development
app (HOSTED unset), then open /fringe-unwrap-validation.html. The separate test
worker downloads the same pinned Pyodide runtime as the production worker.
"""
from pathlib import Path
import json
import runpy
import shutil
import sys

root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root))
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
shutil.copytree(root/'frontend',out,dirs_exist_ok=True)
for name in ['fringe-unwrap-validation.py','fringe-unwrap-validation.js','fringe-unwrap-worker.js']:
    shutil.copy2(root/'tests/browser'/name,out/name)
page=(root/'tests/browser/fringe-validation.html').read_text().replace(
    'fringe-validation.js','fringe-unwrap-validation.js').replace(
    'Loupe browser-engine validation','Loupe browser index regression').replace(
    '<button id="cancel">Cancel</button>','')
(out/'fringe-unwrap-validation.html').write_text(page)
probe=runpy.run_path(str(root/'tests/browser/fringe-unwrap-validation.py'))
expected=probe['run']()
(out/'fringe-unwrap-native.json').write_text(json.dumps(expected,indent=2)+'\n')
print(json.dumps(expected,indent=2))
