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


def test_edge_inspection_preserves_full_selection_without_admitting_edge_heights(monkeypatch):
    for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
        monkeypatch.setattr(f,name,lambda *a,**kw: '')
    y,x=np.mgrid[:192,:192]
    disk=(x-96)**2+(y-96)**2<=65**2
    image=np.where(disk,125+80*np.cos(2*np.pi*(14*x+5*y)/192),15.)
    result=f.analyze_interferogram(image,custom_mask=np.ones_like(disk),n_zernike=15,form_model='plane')
    inspection=result['edge_inspection']
    regions=np.array(inspection['regions']).reshape(192,192)
    assert inspection['source_height']==inspection['source_width']==192
    assert inspection['has_user_selection']
    assert (regions==3).any()  # Selected background remains visible, beyond the numerical crop.
    assert (regions==2).any()  # Uncertain boundary is distinct from measured interior.
    assert np.count_nonzero(regions==1)==result['n_valid_pixels']
    assert np.count_nonzero(regions==2)==result['coverage']['boundary_excluded_pixels']
    assert np.count_nonzero(regions==3)==result['coverage']['selected_rejected_pixels']
    assert np.count_nonzero(result['mask_grid'])==result['n_valid_pixels']
    assert all(h==0 for h,m in zip(result['height_grid'],result['mask_grid']) if not m)
    assert result['surface_width']<inspection['source_width']


def test_edge_preview_is_bounded_and_does_not_modify_input():
    import base64,cv2
    image=np.full((600,1200),127.,np.float64)
    aperture=np.ones(image.shape,bool); risk=np.zeros(image.shape,np.uint8);risk[:20]=2
    result=f._edge_inspection(image,aperture,risk,None)
    preview=cv2.imdecode(np.frombuffer(base64.b64decode(result['image_b64']),np.uint8),0)
    assert preview.shape==(512,1024)
    assert (result['grid_rows'],result['grid_cols'])==(128,256)
    assert len(result['regions'])<=256*256
    assert not result['has_user_selection']
    assert set(result['regions'])=={1,2}
    assert np.all(image==127.) and aperture.all()
