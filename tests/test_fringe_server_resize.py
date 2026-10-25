"""Server preprocessing keeps local-fit sizes, geometry and calibration aligned."""
import base64
import json
from types import SimpleNamespace
import cv2
import numpy as np
import pytest
from backend import api_fringe as api
from backend.browser.fringe import _prepare


def request(hosted=False):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(hosted=hosted)))


def encoded(image):
    return base64.b64encode(cv2.imencode('.png',image)[1]).decode()


@pytest.mark.parametrize('method',['hybrid','composite'])
@pytest.mark.parametrize('uploaded,hosted',[(True,False),(True,True),(False,False),(False,True)])
def test_local_fit_resizes_uploads_and_camera_frames_once(method,uploaded,hosted):
    image=np.arange(777*1500,dtype=np.uint8).reshape(777,1500)
    body=api.AnalyzeBody(analysis_method=method)
    actual,res=api._resize_analysis_frame(image,body,request(hosted),uploaded=uploaded)
    assert actual.shape==(530,1024)
    np.testing.assert_array_equal(actual,cv2.resize(image,(1024,530),interpolation=cv2.INTER_AREA))
    assert res==dict(original=[777,1500],analyzed=[530,1024],max_dimension=1024)


def test_current_defaults_and_paired_resolution_are_distinct():
    image=np.zeros((900,2400),np.uint8)
    current=api.AnalyzeBody()
    assert api._resize_analysis_frame(image,current,request(),uploaded=False)[0] is image
    assert api._resize_analysis_frame(image,current,request(),uploaded=True)[0].shape==(768,2048)
    paired=api.AnalyzeBody(analysis_max_dimension=1024)
    assert api._resize_analysis_frame(image,paired,request(),uploaded=True)[0].shape==(384,1024)
    small=image[:30,:40]
    assert api._resize_analysis_frame(small,paired,request(),uploaded=True)[0] is small
    with pytest.raises(ValueError):api.AnalyzeBody(analysis_max_dimension=4096)


def test_resize_precedes_lens_and_polygon_rasterization_matching_browser():
    y,x=np.mgrid[:700,:1300];image=np.rint(125+80*np.cos(.1*x+.03*y)).astype('uint8')
    body=dict(image_b64=encoded(image),analysis_method='hybrid',lens_k1=.12,
        mask_polygons=[dict(include=True,vertices=[(.1,.1),(.9,.1),(.9,.9),(.1,.9)]),
                       dict(include=False,vertices=[(.4,.4),(.6,.4),(.6,.6),(.4,.6)])])
    model=api.AnalyzeBody(**body)
    resized,_=api._resize_analysis_frame(image,model,request(),uploaded=True)
    actual,mask,_=api._prepare_fringe_image(resized,model)
    expected,expected_mask,_,_=_prepare(body)
    np.testing.assert_array_equal(actual,expected)
    np.testing.assert_array_equal(mask,expected_mask)


@pytest.mark.parametrize('method',['hybrid','composite'])
def test_oversized_upload_runs_through_real_numerical_engine(client,method):
    y,x=np.mgrid[:160,:1280]
    image=np.rint(125+80*np.cos(2*np.pi*(.03*x+.035*y))).astype('uint8')
    response=client.post('/fringe/analyze',json=dict(image_b64=encoded(image),
        analysis_method=method,form_model='plane',n_zernike=6))
    assert response.status_code==200,response.text
    result=response.json()
    assert result['server_resolution']['analyzed']==[128,1024]
    assert result['n_valid_pixels']>100 and np.isfinite(result['pv_nm'])
    assert max(result['surface_width'],result['surface_height'])<=1024


@pytest.mark.parametrize('route',['/fringe/analyze','/fringe/analyze-stream','/fringe/reanalyze-carrier'])
@pytest.mark.parametrize('method',['hybrid','composite'])
def test_routes_record_resize_and_adjust_scale_without_changing_request(client,monkeypatch,route,method):
    seen=[]
    def analyze(image,**kwargs):
        seen.append((image.copy(),kwargs))
        return dict(warnings=[],analysis_method=kwargs['analysis_method'])
    monkeypatch.setattr(api,'analyze_interferogram',analyze)
    image=np.zeros((800,1600),np.uint8)
    body=dict(image_b64=encoded(image),analysis_method=method,form_model='plane',
        wavelength_nm=632.8,calibration=dict(mm_per_pixel=.01,wavelength_nm=632.8),
        roi=dict(x=.25,y=.25,w=.5,h=.5))
    if route.endswith('carrier'):body.update(carrier_y=256,carrier_x=525)
    response=client.post(route,json=body)
    assert response.status_code==200,response.text
    if route.endswith('stream'):
        events=[json.loads(line[5:]) for line in response.text.splitlines() if line.startswith('data:')]
        result=next(e['result'] for e in events if e['stage']=='done')
    else:result=response.json()
    assert result['server_resolution']==dict(original=[800,1600],analyzed=[512,1024],max_dimension=1024)
    assert any('1600×800 to 1024×512' in w for w in result['warnings'])
    assert result['calibration_snapshot']['mm_per_pixel']==pytest.approx(.015625)
    assert result['calibration_snapshot']['input_mm_per_pixel']==.01
    assert seen[-1][0].shape==((512,1024) if route.endswith('carrier') else (256,512))
    saved=client.get('/fringe/session/capture/'+result['id']).json()
    assert saved['server_resolution']==result['server_resolution']
    if not route.endswith('carrier'):
        # The cached image was already resized; neither image nor scale is resized twice.
        rerun=dict(analysis_method=method,carrier_y=128,carrier_x=266,calibration=body['calibration'],wavelength_nm=632.8)
        for _ in range(2):
            repeated=client.post('/fringe/reanalyze-carrier',json=rerun)
            assert repeated.status_code==200,repeated.text
            assert repeated.json()['server_resolution']==result['server_resolution']
            assert repeated.json()['calibration_snapshot']['mm_per_pixel']==pytest.approx(.015625)
            assert seen[-1][0].shape==(256,512)
            assert seen[-1][1]['carrier_override']==(128,266)
