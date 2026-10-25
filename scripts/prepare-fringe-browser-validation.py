"""Generate native-oracle fixtures and a browser harness in an isolated frontend.

Usage: MPLCONFIGDIR=/tmp/loupe-mpl .venv/bin/python scripts/prepare-fringe-browser-validation.py /tmp/loupe-browser-review/frontend
Add --hybrid to include small-aperture and 1024-pixel experimental fits.
Serve that checkout with HOSTED=1 and open /fringe-validation.html.
"""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import base64
import json
import shutil
import cv2
import numpy as np
from backend.browser.fringe import execute

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
y, x = np.mgrid[:176, :224]
height = (32*np.exp(-((x-58)**2+(y-52)**2)/(2*13**2))
          -24*np.exp(-((x-157)**2+(y-111)**2)/(2*17**2))
          +16*np.exp(-((x-120)**2+(y-53)**2)/(2*10**2)))
image = np.rint(125+90*np.cos(2*np.pi*(14*x/224+8*y/176)+4*np.pi*height/632.8+.37)).astype('uint8')
radius = np.hypot(x-112,y-88)
rim = -40*np.clip((radius-45)/25,0,1)**2
edge_image = np.rint(np.where(radius<=70,125+80*np.cos(2*np.pi*(15.3*x/224+6.7*y/176)+4*np.pi*rim/632.8+.93),15)).astype('uint8')
coarse_edge_image = np.rint(np.where(radius<=70,125+80*np.cos(2*np.pi*(4.9*x/224+3.4*y/176)+4*np.pi*rim/632.8+.93),15)).astype('uint8')
fixtures = []
yb, xb = np.mgrid[:960, :1200]
big = np.rint(125+90*np.cos(2*np.pi*(9*xb/1200+18*yb/960)+.6*((xb/1200-.5)**2+(yb/960-.5)**2))).astype('uint8')
for name, img, extra in [
    ('asymmetric-zernike', image, {}),
    ('mirror-x-plane', np.fliplr(image), {'form_model':'plane'}),
    ('resized-1024', big, {'form_model':'plane'}),
    *([('hybrid-edge', edge_image, {'form_model':'plane','analysis_method':'hybrid'}),
       ('hybrid-resized-1024', big, {'form_model':'plane','analysis_method':'hybrid'})]
      if '--hybrid' in sys.argv else []),
    ('directional-edge-outline', edge_image, {'form_model':'plane','mask_polygons':[
        {'include':True,'vertices':[[0,0],[1,0],[1,1],[0,1]]}]}),
    ('directional-edge-fft-support', coarse_edge_image, {'form_model':'plane'}),
    ('offcentre-mask-lens', image, {'lens_k1':.08, 'mask_polygons':[
        {'include':True,'vertices':[[.15,.12],[.94,.12],[.94,.92],[.15,.92]]},
        {'include':False,'vertices':[[.44,.4],[.56,.4],[.56,.55],[.44,.55]]}]}),
]:
    body = {'wavelength_nm':632.8, 'form_model':'zernike',
            'image_b64':base64.b64encode(cv2.imencode('.png',img)[1]).decode(), **extra}
    result = execute('analyze', body)
    rerun = dict(coefficients=result['coefficients'], raw_height_grid_nm=result['raw_height_grid_nm'],
        raw_wavelength_nm=result['raw_wavelength_nm'], raw_grid_rows=result['grid_rows'], raw_grid_cols=result['grid_cols'],
        mask=result['mask_grid'], surface_height=result['surface_height'], surface_width=result['surface_width'],
        wavelength_nm=632.8, subtract_terms=[1,2,3,4], form_model='zernike')
    fixtures.append(dict(name=name, body=body, expected=result, reanalyze=dict(body=rerun, expected=execute('reanalyze',rerun))))
    print(name, result['pv_nm'], flush=True)
source = fixtures[0]['expected']
other = {**source, 'id':'second-synthetic-capture'}
for name, operation, body in [
    ('average', 'average', {'results':[source,other], 'source_polarities':[1,1]}),
    ('subtract', 'subtract', {'measurement':source, 'reference':other, 'register':False, 'reference_polarity':1}),
]:
    fixtures.append(dict(name=name, operation=operation, body=body, expected=execute(operation,body)))
(out/'fringe-validation-fixtures.json').write_text(json.dumps(fixtures))
for p in (Path(__file__).resolve().parents[1]/'tests/browser').glob('fringe-validation.*'):
    shutil.copy2(p,out/p.name)
# Optional UI harness: the same browser-generated result in the real workspace.
# Use an isolated origin; this creates synthetic test projects in local storage.
ui_source=Path(__file__).resolve().parents[1]/'tests/browser/fringe-spatial-ui.js'
shutil.copy2(ui_source,out/ui_source.name)
if (out/'index.html').exists():
    page=(out/'index.html').read_text().replace('</body>',
        '<script type="module" src="fringe-spatial-ui.js"></script></body>')
    (out/'fringe-spatial.html').write_text(page)
# Paired-analysis workflow: use the real settings dialog and compare checkbox.
pair_source=Path(__file__).resolve().parents[1]/'tests/browser/fringe-comparison-ui.js'
shutil.copy2(pair_source,out/pair_source.name)
if (out/'index.html').exists():
    (out/'fringe-comparison.html').write_text((out/'index.html').read_text().replace('</body>',
        '<script type="module" src="fringe-comparison-ui.js"></script></body>'))
