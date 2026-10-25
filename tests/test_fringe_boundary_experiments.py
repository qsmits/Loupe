"""Analytic checks for directional guards and physical-outline/signal separation."""
import runpy
from pathlib import Path
import cv2
import numpy as np
import pytest
from backend.vision import fringe as f

BENCHMARK = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/validate-fringe-boundaries.py'))


def test_directional_guard_rotates_with_carrier_and_keeps_holes_unsupported():
    mask = np.ones((151, 151), bool)
    mask[75, 75] = False
    a = f._elliptical_boundary_kernel(27.5, 15, 0)
    b = f._elliptical_boundary_kernel(27.5, 15, np.pi/2)
    np.testing.assert_array_equal(a, b.T)
    supported = f._supported_interior(mask, a)
    # Along the carrier normal the guard reaches farther than along fringes.
    assert not supported[75, 100] and supported[100, 75]
    assert not supported[:, :27].any() and not supported[:15].any()
    turned = f._supported_interior(mask.T, b)
    np.testing.assert_array_equal(supported, turned.T)


def test_large_directional_guard_matches_direct_morphology():
    mask = np.ones((211, 229), np.uint8)
    mask[70:82, 90:104] = 0
    mask[:20, :40] = 0
    mask[170:, 180:] = 0
    # Exercise the FFT implementation with curved/oblique support and holes.
    for angle in (0.17, 0.83):
        kernel = f._elliptical_boundary_kernel(52, 29, angle)
        expected = cv2.erode(mask, kernel, borderType=cv2.BORDER_CONSTANT, borderValue=0)
        np.testing.assert_array_equal(f._supported_interior(mask, kernel), expected.astype(bool))


def test_drawn_outline_does_not_override_missing_fringe_signal():
    case = next(c for c in BENCHMARK['fixtures']() if c['name']=='oversized-weak-all')
    selected = case['selected'].copy()
    modulation = f.compute_fringe_modulation(case['image'])
    result = f.create_fringe_mask(case['image'], modulation, physical_aperture=selected, rim_px=0)
    assert np.all(~result | selected)
    assert np.count_nonzero(selected & ~result) > 500
    np.testing.assert_array_equal(selected, case['selected'])
    assert not f.create_fringe_mask(np.full((96,96),100.),np.zeros((96,96)),
                                    physical_aperture=np.ones((96,96),bool),rim_px=0).any()


@pytest.mark.parametrize('name', ['flat-10.7', 'flat-17.4', 'noisy-hole-flat',
                                  'oversized-weak-all', 'precise-flat'])
def test_more_aperture_without_material_error_increase(name):
    old,new = BENCHMARK['compare'](('legacy','bounded'),[name])
    assert new['coverage_pct'] > old['coverage_pct'] + 2
    assert new['outside_physical_pixels']==0
    # Numerical acceptance envelope, not a real-instrument accuracy claim.
    # Tight additive tolerances avoid unstable ratios close to zero error.
    assert new['rms_error_nm'] <= old['rms_error_nm'] + .01
    assert new['max_error_nm'] <= old['max_error_nm'] + .05
    assert new['common_rms_error_nm'] <= old['rms_error_nm'] + .01


def test_broad_edge_rolloff_is_retained_without_inventing_a_flat_surface():
    old,new = BENCHMARK['compare'](('legacy','bounded'),['broad-roll-17.4'])
    assert new['coverage_pct'] > old['coverage_pct'] + 4
    assert new['truth_pv_nm'] > old['truth_pv_nm'] + 1
    assert new['max_error_nm'] < old['max_error_nm']
    assert abs(new['recovered_pv_nm']-new['truth_pv_nm']) < 1


def test_weak_rim_stays_excluded_even_when_outline_includes_it():
    old,new = BENCHMARK['compare'](('legacy','bounded'),['precise-weak-rim'])
    assert new['coverage_pct'] < old['coverage_pct']
    assert new['max_error_nm'] <= old['max_error_nm']
    assert new['outside_physical_pixels']==0


def test_full_frame_retains_established_guard_and_height():
    old,new = BENCHMARK['compare'](('legacy','bounded'),['noisy-frame-flat'])
    for key in ('coverage_pct','rms_error_nm','max_error_nm','recovered_pv_nm'):
        assert new[key] == old[key]
