"""Independent synthetic evidence against simply reducing the edge safety band."""
import runpy
from pathlib import Path
import pytest
from backend.vision import fringe as f


@pytest.fixture
def characterization(monkeypatch):
    for name in ('render_surface_map','render_profile','render_fft_image','render_modulation_map','render_confidence_maps','render_zernike_chart'):
        monkeypatch.setattr(f,name,lambda *a,**kw:'')
    return runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts/validate-fringe-edges.py'))['characterize']


def test_smaller_boundary_keeps_more_pixels_but_introduces_false_flat_disk_shape(characterization):
    normal,half=characterization(['flat-disk'],(1.,.5))
    assert half['retained_pct']>normal['retained_pct']+15
    assert normal['recovered_pv_nm']<1.5
    assert half['recovered_pv_nm']>3
    assert half['rms_error_nm']>2*normal['rms_error_nm']


def test_true_narrow_rolloff_can_be_completely_excluded(characterization):
    normal=characterization(['narrow-edge-roll-disk'],(1.,))[0]
    # Fixture has a 40 nm physical drop confined to its rim. The automatic
    # mask and safety band remove that entire region: a small PV cannot be
    # interpreted as whole-part flatness.
    assert normal['truth_pv_on_retained_nm']==0
    assert normal['recovered_pv_nm']<1.5
    assert normal['retained_pct']<60
