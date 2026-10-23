import base64
import io
import zipfile
from pathlib import Path
import cv2
import numpy as np
import pytest
from backend.browser.fringe import _prepare, execute, MAX_DIM
from backend.browser_runtime import browser_source, SOURCES
from backend.api_fringe import AnalyzeBody, _best_gray, _prepare_fringe_image


def encode(image):
    return base64.b64encode(cv2.imencode('.png',image)[1]).decode()


@pytest.mark.parametrize('lens', [0, .12])
def test_browser_preparation_matches_server_geometry_and_channel_selection(lens):
    y,x=np.mgrid[:100,:140]
    gray=np.rint(125+90*np.cos(x*.7+y*.3)).astype('uint8')
    color=np.stack([gray//3, gray, gray//2],axis=-1)
    body={'image_b64':encode(color),'lens_k1':lens,'mask_polygons':[
        {'include':True,'vertices':[[.1,.1],[.9,.1],[.9,.8],[.1,.8]]},
        {'include':False,'vertices':[[.4,.4],[.6,.4],[.6,.6],[.4,.6]]}]}
    image,mask,original,analyzed=_prepare(body)
    expected,expected_mask,_=_prepare_fringe_image(_best_gray(color),AnalyzeBody(**body))
    np.testing.assert_array_equal(image,expected)
    np.testing.assert_array_equal(mask,expected_mask)
    assert original==analyzed==[100,140]


def test_browser_size_cap_is_explicit_and_aspect_preserving():
    image=np.zeros((800,1600),np.uint8)
    prepared,_,original,analyzed=_prepare({'image_b64':encode(image)})
    assert original==[800,1600]
    assert analyzed==[512,MAX_DIM]
    assert prepared.shape==(512,MAX_DIM)


def test_source_bundle_contains_only_current_allowlisted_scientific_code():
    response=browser_source()
    with zipfile.ZipFile(io.BytesIO(response.body)) as bundle:
        assert set(bundle.namelist())=={'backend/'+p for p in SOURCES}|{'backend/__init__.py','backend/vision/__init__.py','backend/browser/__init__.py'}
        for source in SOURCES:
            assert bundle.read('backend/'+source)==(Path('backend')/source).read_bytes()
    assert response.headers['cache-control']=='no-cache'


@pytest.mark.parametrize('body', [
    {}, {'raw_grid_rows':10000,'raw_grid_cols':10000,'raw_height_grid_nm':[1]},
    {'raw_grid_rows':1,'raw_grid_cols':1,'raw_height_grid_nm':[float('nan')]},
])
def test_browser_recompute_rejects_unbounded_or_invalid_grids(body):
    with pytest.raises(ValueError): execute('reanalyze',body)


def test_browser_rejects_calibration_disagreement_before_analysis():
    with pytest.raises(ValueError,match='wavelengths disagree'):
        execute('analyze',{'image_b64':encode(np.zeros((20,20),np.uint8)),
            'wavelength_nm':632.8,'calibration':{'wavelength_nm':589.3}})


def test_browser_records_resizing_and_adjusts_lateral_pixel_scale(monkeypatch):
    from backend.browser import fringe as browser
    monkeypatch.setattr(browser, 'analyze_interferogram', lambda *args, **kwargs: {'warnings':[]})
    body={'image_b64':encode(np.zeros((800,1600),np.uint8)), 'wavelength_nm':632.8,
          'calibration':{'wavelength_nm':632.8,'mm_per_pixel':.01}}
    result=browser.execute('analyze',body)
    assert result['calibration_snapshot']['mm_per_pixel']==pytest.approx(.01*1600/1024)
    assert body['calibration']['mm_per_pixel']==.01
    assert result['browser_resolution']['analyzed']==[512,1024]
    assert any('resized' in warning for warning in result['warnings'])


def test_hosted_wasm_permission_is_scoped_to_the_worker(monkeypatch,tmp_path):
    from backend import main
    from backend.run_store import RunStore
    from fastapi.testclient import TestClient
    monkeypatch.setenv('HOSTED','1')
    monkeypatch.setattr(main,'RunStore',lambda **kwargs: RunStore(db_path=str(tmp_path/'runs.db')))
    with TestClient(main.create_app(no_camera=True)) as client:
        page=client.get('/')
        worker=client.get('/fringe-browser-worker.js')
        assert page.status_code==worker.status_code==200
        assert 'wasm-unsafe-eval' not in page.headers['content-security-policy']
        assert "'unsafe-eval'" not in worker.headers['content-security-policy']
        assert 'wasm-unsafe-eval' in worker.headers['content-security-policy']
        assert 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/' in worker.headers['content-security-policy']
        assert client.get('/fringe-runtime/source.zip').status_code==200
        assert client.get('/fringe-runtime/config.json').status_code==404


def test_new_analysis_defaults_to_plane_in_both_runtimes(monkeypatch):
    from backend.browser import fringe as browser
    assert AnalyzeBody().form_model == 'plane'
    models = []
    def analyze(*args, **kwargs):
        models.append(kwargs['form_model'])
        return {'warnings': [], 'form_model': kwargs['form_model']}
    monkeypatch.setattr(browser, 'analyze_interferogram', analyze)
    body = {'image_b64': encode(np.zeros((20, 20), np.uint8))}
    assert browser.execute('analyze', body)['form_model'] == 'plane'
    assert browser.execute('analyze', {**body, 'form_model': 'zernike'})['form_model'] == 'zernike'
    assert models == ['plane', 'zernike']
