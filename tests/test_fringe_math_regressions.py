"""Independent reproductions from the optical-flat physics review."""
import base64

import cv2
import numpy as np
import pytest

from backend.vision import fringe as f
from tests.fringe_step_helper import frontend_step


@pytest.fixture(autouse=True)
def no_plots(monkeypatch):
    # Exercise all numerical stages; plotting cannot affect these assertions.
    for name in ("render_surface_map", "render_profile", "render_fft_image",
                 "render_modulation_map", "render_confidence_maps", "render_zernike_chart"):
        monkeypatch.setattr(f, name, lambda *args, **kwargs: "")


def test_full_frame_boundary_is_not_quantitative():
    n = 256
    yy, xx = np.mgrid[:n, :n]
    img = np.clip(127 + 80*np.cos(2*np.pi*8.5*(xx+yy)/np.sqrt(2)/n+.4), 0, 255).astype(np.uint8)
    r = f.analyze_interferogram(img)
    mask = np.array(r["mask_grid"]).reshape(n,n)
    assert not mask[0].any() and not mask[-1].any()
    assert not mask[:,0].any() and not mask[:,-1].any()
    assert r["unwrap_stats"]["n_edge_risk"] > 0
    assert r["pv_nm"] < 4.0  # previously 18.71 nm on a perfectly flat specimen
    assert any("remaining measurement aperture" in w for w in r["warnings"])


@pytest.mark.parametrize("terms,axis", [([1,2],"y"), ([1,3],"x"), ([2],"y")])
@pytest.mark.parametrize("raw", [False,True])
def test_selective_form_removal_preserves_unselected_tilt(terms, axis, raw):
    yy,xx=np.mgrid[:64,:64]
    z = 100*(yy if axis=="y" else xx)/63
    coeffs,_,_=f.fit_zernike(f.height_to_phase(z,589.3),n_terms=6)
    kwargs = dict(raw_height_grid_nm=z.ravel().tolist(),raw_grid_rows=64,raw_grid_cols=64) if raw else {}
    r=f.reanalyze(coeffs.tolist(),terms,589.3,(64,64),n_zernike=6,**kwargs)
    assert r["pv_nm"] == pytest.approx(100,abs=1e-6)
    if terms==[2]:
        assert np.mean(r["height_grid"]) == pytest.approx(50,abs=.01)


def test_opposite_wedges_require_polarity_and_do_not_cancel():
    yy,xx=np.mgrid[:256,:256]
    z=80*(((xx-127.5)/127.5)**2+((yy-127.5)/127.5)**2)
    results=[]
    for direction in (1,-1):
        im=127+90*np.cos(direction*2*np.pi*12*xx/256+4*np.pi*z/589.3+.25)
        r=f.analyze_interferogram(im)
        f.wrap_wavefront_result(r)
        results.append(r)
    original = list(results[1]["raw_height_grid_nm"])
    with pytest.raises(ValueError,match="polarity"):
        f.average_wavefronts(results)
    with pytest.raises(ValueError,match="polarity"):
        f.subtract_wavefronts(*results,register=False)
    avg=f.average_wavefronts(results,source_polarities=[1,-1])
    diff=f.subtract_wavefronts(*results,reference_polarity=-1,register=False)
    assert avg["pv_nm"] == pytest.approx(results[0]["pv_nm"],rel=.04)
    assert diff["rms_nm"] < 2
    assert avg["source_polarities"] == [1,-1]
    assert results[1]["raw_height_grid_nm"] == original


@pytest.mark.parametrize("angle,count", [(0,30),(45,20)])
def test_frontend_step_fit_on_real_pipeline(angle,count):
    yy,xx=np.mgrid[:256,:256]
    a=np.deg2rad(angle)
    z=np.where(xx>=128,100.,0.)
    im=(127.5+127.5*np.cos(2*np.pi*count*(xx*np.cos(a)+yy*np.sin(a))/256+4*np.pi*z/632.8)).astype(np.uint8)
    # Defaults include form removal: the step estimator must use RAW data.
    r=f.analyze_interferogram(im,wavelength_nm=632.8,form_model="poly3")
    fit=frontend_step(r)
    assert abs(fit["step"]) == pytest.approx(100,abs=1)


@pytest.mark.parametrize("route", ["/fringe/analyze","/fringe/analyze-stream"])
def test_roi_lens_order_and_cached_carrier_reanalysis(client,monkeypatch,route):
    import backend.api_fringe as api
    yy,xx=np.mgrid[:96,:128]
    im=(127+80*np.cos(2*np.pi*12*xx/128)).astype(np.uint8)
    _,buf=cv2.imencode('.png',im)
    b64=base64.b64encode(buf).decode()
    seen=[]
    actual=api.analyze_interferogram
    def inspect(image,**kw):
        seen.append((image.copy(),dict(kw)))
        return actual(image,**kw)
    monkeypatch.setattr(api,"analyze_interferogram",inspect)
    roi=dict(x=.25,y=.125,w=.625,h=.75)
    resp=client.post(route,json=dict(image_b64=b64,lens_k1=.2,roi=roi,n_zernike=6))
    assert resp.status_code==200,resp.text
    assert '"stage": "error"' not in resp.text
    expected=f.undistort_frame(im.astype(float),.2)[12:84,32:112]
    np.testing.assert_array_equal(seen[0][0],expected)
    assert seen[0][1]["image_is_undistorted"] is True
    resp=client.post('/fringe/reanalyze-carrier',json=dict(lens_k1=.2,carrier_y=36,carrier_x=47.5,n_zernike=6))
    assert resp.status_code==200,resp.text
    np.testing.assert_array_equal(seen[-1][0],expected)
    assert resp.json()["lens_k1"]==.2


def test_api_requires_explicit_polarity(client):
    yy,xx=np.mgrid[:96,:96]
    im=(127+80*np.cos(2*np.pi*8*xx/96)).astype(np.uint8)
    _,buf=cv2.imencode('.png',im)
    r=client.post('/fringe/analyze',json=dict(image_b64=base64.b64encode(buf).decode())).json()
    ident=r['id']
    for route,body,key,value in [
        ('average',dict(source_ids=[ident,ident]),'source_polarities',[1,1]),
        ('subtract',dict(measurement_id=ident,reference_id=ident),'reference_polarity',1),
    ]:
        denied=client.post('/fringe/'+route,json=body)
        assert denied.status_code==400
        assert 'polarity' in denied.json()['detail']
        allowed=client.post('/fringe/'+route,json={**body,key:value})
        assert allowed.status_code==200,allowed.text
