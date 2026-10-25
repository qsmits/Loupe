import numpy as np
from backend.vision.fringe import surface_color_limit


def test_map_legend_range_uses_only_valid_finite_full_resolution_pixels():
    surface=np.array([[-2.,4.,999.],[0.,np.nan,1.]])
    mask=np.array([[True,True,False],[True,True,True]])
    assert surface_color_limit(surface,mask)==4
    assert surface_color_limit(-surface,mask)==4
    assert surface_color_limit(np.ones((2,2)))==1
    assert surface_color_limit(surface,np.zeros_like(mask))==1
