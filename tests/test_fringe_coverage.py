import numpy as np
from backend.vision import fringe as f


def test_coverage_counts_and_actual_filter_metadata(monkeypatch):
    for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
        monkeypatch.setattr(f,name,lambda *a,**kw: '')
    y,x=np.mgrid[:128,:160]
    image=128+80*np.cos(2*np.pi*(x/10+y/32)+.1*np.sin(x/20))
    result=f.analyze_interferogram(image,use_full_mask=True,n_zernike=15)
    c=result['coverage']; filt=result['analysis_filter']
    assert c['measured_pixels']==result['n_valid_pixels']
    assert c['aperture_pixels']==c['measured_pixels']+c['boundary_excluded_pixels']
    assert c['frame_pixels']==image.size
    assert c['requested_pixels'] is None
    diag=np.array(result['diagnostic_mask_grid'])
    measured=np.array(result['mask_grid'])
    assert len(diag)==result['grid_rows']*result['grid_cols']
    assert np.all(measured<=diag)
    assert filt['sigma_across_px']==5
    assert filt['sigma_along_px']==2
    assert filt['boundary_band_px']>=3*filt['sigma_across_px']
