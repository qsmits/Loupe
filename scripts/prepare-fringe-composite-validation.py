"""Prepare native/browser parity and real UI fixtures in an isolated frontend."""
from pathlib import Path
import sys
import shutil
import json
import base64
import numpy as np
import cv2
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.browser.fringe import execute

out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
root=Path(__file__).resolve().parents[1]
shutil.copytree(root/'frontend',out,dirs_exist_ok=True)
y,x=np.mgrid[:176,:224];r=np.hypot(x-112,y-88)
truth=-40*np.clip((r-45)/25,0,1)**2
image=np.rint(np.where(r<=70,125+80*np.cos(2*np.pi*(15.3*x/224+6.7*y/176)+4*np.pi*truth/632.8+.93),15)).astype('uint8')
vertices=[[float((112+70*np.cos(t))/224),float((88+70*np.sin(t))/176)] for t in np.linspace(0,2*np.pi,128,endpoint=False)]
fixtures=[]
for name,mask in [('composite-auto',None),('composite-drawn',[dict(include=True,vertices=vertices)])]:
    body=dict(image_b64=base64.b64encode(cv2.imencode('.png',image)[1]).decode(),
              analysis_method='composite',wavelength_nm=632.8,form_model='plane',mask_polygons=mask)
    result=execute('analyze',body)
    fixtures.append(dict(name=name,body=body,expected=result))
    print(name,result['composite']['summaries'],flush=True)
# A flat annulus exercises checked continuation, not just the local-fit bank.
flat=np.rint(np.where((r<=70)&(r>18),125+80*np.cos(2*np.pi*(15.3*x/224+6.7*y/176)+.93),15)).astype('uint8')
hole=[[float((112+18*np.cos(t))/224),float((88+18*np.sin(t))/176)] for t in np.linspace(0,2*np.pi,64,endpoint=False)]
body=dict(image_b64=base64.b64encode(cv2.imencode('.png',flat)[1]).decode(),analysis_method='composite',
          wavelength_nm=632.8,form_model='plane',mask_polygons=[dict(include=True,vertices=vertices),dict(include=False,vertices=hole)])
result=execute('analyze',body)
fixtures.append(dict(name='composite-checked-continuation',body=body,expected=result))
print('composite-checked-continuation',result['composite']['diagnostics'],flush=True)
# Low contrast and image texture force the new limited layer to do real work.
rng=np.random.default_rng(42)
textured=np.rint(np.clip(np.where((r<=70)&(r>18),125+20*np.cos(2*np.pi*(15.3*x/224+6.7*y/176)+.93)+rng.normal(0,2.5,r.shape),15),0,255)).astype('uint8')
body={**body,'image_b64':base64.b64encode(cv2.imencode('.png',textured)[1]).decode()}
result=execute('analyze',body)
assert result['composite']['photographic_pixels']>0, 'Fixture must exercise photographic additions'
fixtures.append(dict(name='composite-photographic-recovery',body=body,expected=result))
print('composite-photographic-recovery',result['composite']['diagnostics']['photographic'],flush=True)
(out/'fringe-validation-fixtures.json').write_text(json.dumps(fixtures))
for name in ['fringe-validation.js','fringe-validation.html','fringe-composite-ui.js']:
    shutil.copy2(root/'tests/browser'/name,out/name)
(out/'fringe-composite-ui.html').write_text((out/'index.html').read_text().replace('</body>',
    '<script type="module" src="fringe-composite-ui.js"></script></body>'))
