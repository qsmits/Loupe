"""Prepare opt-in reconstruction parity and UI fixtures on an isolated origin."""
from pathlib import Path
import sys, shutil, base64, json
import numpy as np
import cv2
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from backend.browser.fringe import execute

out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
shutil.copytree(ROOT/'frontend',out,dirs_exist_ok=True)
y,x=np.mgrid[:112,:144];radius=np.hypot(x-72,y-56)
truth=-40*np.clip((radius-30)/19,0,1)**2
image=np.rint(np.where((radius<49)&(radius>9),125+40*np.cos(2*np.pi*(11.3*x/144+4.7*y/112)+4*np.pi*truth/632.8),15)).astype('uint8')
polygons=[dict(include=include,vertices=[[float((72+r*np.cos(t))/144),float((56+r*np.sin(t))/112)]
    for t in np.linspace(0,2*np.pi,128,endpoint=False)]) for r,include in [(49,True),(9,False)]]
body=dict(image_b64=base64.b64encode(cv2.imencode('.png',image)[1]).decode(),
    analysis_method='composite',form_model='plane',reconstructed_preview=True,
    wavelength_nm=632.8,n_zernike=15,mask_polygons=polygons)
result=execute('analyze',body)
assert result['composite']['reconstruction']['reconstructed_pixels']>0
(out/'fringe-validation-fixtures.json').write_text(json.dumps([dict(name='reconstructed-rolled-rim-hole',body=body,expected=result)]))
for name in ['fringe-validation.js','fringe-validation.html','fringe-reconstruction-ui.js']:
    shutil.copy2(ROOT/'tests/browser'/name,out/name)
(out/'fringe-reconstruction-ui.html').write_text((out/'index.html').read_text().replace('</body>',
    '<script type="module" src="fringe-reconstruction-ui.js"></script></body>'))
print(result['composite']['reconstruction']['diagnostics'],flush=True)
