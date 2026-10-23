"""Read-only, allowlisted source bundle for the browser's WebAssembly worker."""
import io
from pathlib import Path
import zipfile
from fastapi import APIRouter
from fastapi.responses import Response

router = APIRouter()
SOURCES = ('vision/fringe.py', 'vision/mask_utils.py', 'browser/fringe.py')


@router.get('/fringe-runtime/source.zip')
def browser_source():
    output = io.BytesIO()
    root = Path(__file__).parent
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for name in ('backend/__init__.py', 'backend/vision/__init__.py', 'backend/browser/__init__.py'):
            bundle.writestr(name, '')
        for name in SOURCES:
            bundle.writestr('backend/' + name, (root / name).read_bytes())
    return Response(output.getvalue(), media_type='application/zip', headers={'Cache-Control': 'no-cache'})
