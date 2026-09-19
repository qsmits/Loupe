"""Exercise the actual browser step estimator from synthetic-image tests."""
import json
from pathlib import Path
import shutil
import subprocess

import pytest


def frontend_step(result, rect_a=None, rect_b=None):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node required to exercise the frontend step estimator")
    payload = {k: result[k] for k in (
        "raw_height_grid_nm", "mask_grid", "grid_rows", "grid_cols")}
    payload["a"] = rect_a or dict(x0=.125, x1=.37, y0=.2, y1=.8)
    payload["b"] = rect_b or dict(x0=.625, x1=.87, y0=.2, y1=.8)
    code = """
import fs from 'node:fs';
import {fitParallelStep} from './frontend/fringe-math.js';
const r=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(fitParallelStep(r.raw_height_grid_nm,r.mask_grid,
  r.grid_rows,r.grid_cols,r.a,r.b)));
"""
    run = subprocess.run([node, "--input-type=module", "-e", code],
                         input=json.dumps(payload), text=True, capture_output=True,
                         check=True, cwd=Path(__file__).resolve().parents[1])
    fit = json.loads(run.stdout)
    assert "error" not in fit, fit
    return fit
