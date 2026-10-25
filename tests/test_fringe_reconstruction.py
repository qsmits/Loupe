"""Reconstruction remains a separate display payload across the full pipeline."""
import importlib.util
from pathlib import Path
import json
import numpy as np
import pytest
from backend.vision import fringe as f, fringe_reconstruction as r
from backend.api_fringe import AnalyzeBody, ReanalyzeCarrierBody


def test_production_solver_matches_research_and_keeps_holes_and_anchors():
    spec=importlib.util.spec_from_file_location('research',Path(__file__).parents[1]/'scripts/fringe_gradient_reconstruction.py')
    research=importlib.util.module_from_spec(spec);spec.loader.exec_module(research)
    y,x=np.mgrid[:32,:48];mask=np.ones(x.shape,bool);mask[10:15,20:25]=False
    anchors=mask&(x<8);truth=.2*x+.04*y+.001*x*x
    current=np.where(anchors,truth,0);wrapped=np.angle(np.exp(1j*truth));evidence=np.ones(x.shape)*.6
    expected,em,ed=research.reconstruct(current,anchors,mask,wrapped,evidence,.01)
    actual,am,ad=r.reconstruct(current,anchors,mask,wrapped,evidence,.01)
    np.testing.assert_array_equal(actual,expected);np.testing.assert_array_equal(am,em)
    np.testing.assert_array_equal(actual[anchors],current[anchors]);assert not (am&~mask).any()
    assert ad==ed
    failed,added,diagnostics=r.reconstruct(current,anchors,mask,wrapped,evidence,maxiter=1)
    assert not diagnostics['converged'] and not added.any()
    np.testing.assert_array_equal(failed,current)


def test_preview_never_changes_measurements_masks_or_summary_statistics(monkeypatch):
    for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
        monkeypatch.setattr(f,name,lambda *a,**kw:'')
    monkeypatch.setattr(f,'_edge_inspection',lambda *a,**kw:{})
    y,x=np.mgrid[:112,:144];radius=np.hypot(x-72,y-56)
    mask=(radius<49)&(radius>9)
    truth=-40*np.clip((radius-30)/19,0,1)**2
    image=np.rint(np.where(mask,125+40*np.cos(2*np.pi*(11.3*x/144+4.7*y/112)+4*np.pi*truth/632.8),15)).astype('uint8')
    options=dict(custom_mask=mask,form_model='plane',analysis_method='composite',wavelength_nm=632.8,n_zernike=15)
    before=f.analyze_interferogram(image,**options)
    after=f.analyze_interferogram(image,**options,reconstructed_preview=True)
    for key in ('pv_nm','rms_nm','n_valid_pixels','mask_grid','height_grid','raw_height_grid_nm','coefficients'):
        assert before[key]==after[key],key
    comp=after['composite'];preview=comp.pop('reconstruction')
    assert comp==before['composite']
    assert preview['diagnostics']['converged'] and preview['reconstructed_pixels']>0
    for i,added in enumerate(preview['reconstructed_grid']):
        if added:
            assert comp['aperture_grid'][i] and not comp['quality_grid'][i] and not comp['conflict_grid'][i]
    json.dumps(preview,allow_nan=False)


@pytest.mark.parametrize('method,form',[('current','plane'),('hybrid','plane'),('composite','zernike'),('composite','poly2')])
def test_preview_requires_supported_reference(method,form):
    with pytest.raises(ValueError,match='Composite quality and Plane'):
        f.analyze_interferogram(np.zeros((32,32)),analysis_method=method,form_model=form,reconstructed_preview=True)


def test_both_api_request_types_accept_opt_in_only():
    assert not AnalyzeBody().reconstructed_preview
    assert AnalyzeBody(reconstructed_preview=True).reconstructed_preview
    assert ReanalyzeCarrierBody(carrier_x=10,carrier_y=20,reconstructed_preview=True).reconstructed_preview
