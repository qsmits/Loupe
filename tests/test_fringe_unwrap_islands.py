"""2π island merge post-pass for the quality-guided unwrap.

On marginal captures the flood can enter a region through a pair of phase
residues and unwrap that whole region one fringe order off: a closed island
whose boundary is a long branch cut and whose entry is the short gap between
the two residues. The 9x9 median snap cannot see islands larger than its
window. ``_merge_unwrap_islands`` re-orders them by voting across the long
boundary, while leaving genuine smooth features (continuous wrapped phase)
alone.
"""
import math

import numpy as np
import pytest

import backend.vision.fringe as fr
from backend.vision.fringe import _merge_unwrap_islands, unwrap_phase_2d

_TWO_PI = 2 * math.pi
_WL = 589.0
_H, _W = 320, 420


def _wrap(a):
    return (a + np.pi) % _TWO_PI - np.pi


def _surface_phase(bump_nm=0.0):
    """Curved surface (power + astigmatism, ~400 nm) plus an optional genuine
    smooth Gaussian bump, as unwrapped phase (rad, reflection: 4π/λ)."""
    yy, xx = np.mgrid[0:_H, 0:_W].astype(np.float64)
    cy, cx = _H / 2, _W / 2
    R = 150.0
    u = (xx - cx) / R
    v = (yy - cy) / R
    r2 = u * u + v * v
    surf = 400.0 * (0.6 * r2 + 0.4 * (u * u - v * v))
    if bump_nm:
        surf = surf + bump_nm * np.exp(-((xx - 300) ** 2 + (yy - 110) ** 2)
                                       / (2 * 18.0 ** 2))
    mask = r2 <= 1.0
    return surf * 4 * math.pi / _WL, mask


# Residue dipole on row Y0 between columns X1 and X2. The standard atan2
# branches put the 2π cut of the vortex pair exactly on that short segment,
# which is the correct (shortest) branch cut.
_Y0, _X1, _X2 = 150, 190, 212
# Island region below the dipole: a disk whose chord at Y0 spans X1..X2.
_RHO = 50.0
_DISK_C = (_Y0 + math.sqrt(_RHO ** 2 - ((_X2 - _X1) / 2) ** 2), (_X1 + _X2) / 2)


def _dipole_scene(bump_nm=0.0):
    """Return (wrapped, good_unwrapped, mask, island_region, bump_region)."""
    base, mask = _surface_phase(bump_nm)
    yy, xx = np.mgrid[0:_H, 0:_W].astype(np.float64)
    vort = (np.arctan2(yy - _Y0 - 0.5, xx - _X1 - 0.5)
            - np.arctan2(yy - _Y0 - 0.5, xx - _X2 - 0.5))
    good = base + vort
    wrapped = _wrap(good)
    island = (np.hypot(yy - _DISK_C[0], xx - _DISK_C[1]) <= _RHO) & (yy > _Y0)
    bump = np.hypot(xx - 300, yy - 110) <= 36
    return wrapped, good, mask, island, bump


def _orders(u, ref, mask):
    """Integer fringe-order error of ``u`` against ``ref`` (piston removed)."""
    k = np.rint((u - ref) / _TWO_PI)
    k -= np.median(k[mask])
    return np.where(mask, k, 0)


class TestMergeDirect:
    def test_plain_disk_island_is_reordered_and_bump_kept(self):
        """A region of the unwrapped map 2π off (closed inconsistent
        boundary) is shifted back; a genuine 120 nm bump (> λ/8 phase-wise,
        continuous wrapped phase) is untouched bit-for-bit."""
        good, mask = _surface_phase(bump_nm=120.0)
        wrapped = _wrap(good)
        yy, xx = np.mgrid[0:_H, 0:_W]
        island = np.hypot(yy - 200, xx - 130) <= 35
        bad = good + _TWO_PI * island
        bump = np.hypot(xx - 300, yy - 110) <= 36
        out, shifted = _merge_unwrap_islands(bad, wrapped, mask)
        k_before = _orders(bad, good, mask)
        k_after = _orders(out, good, mask)
        assert int((k_before != 0).sum()) == int(island.sum())
        # Only the 1 px wall ring may remain for the median snap.
        assert int((k_after != 0).sum()) <= 0.08 * island.sum()
        assert shifted[island].mean() > 0.9
        assert not shifted[~island].any()
        np.testing.assert_array_equal(out[bump & mask], good[bump & mask])

    def test_clean_map_is_untouched(self):
        good, mask = _surface_phase(bump_nm=120.0)
        out, shifted = _merge_unwrap_islands(good.copy(), _wrap(good), mask)
        assert not shifted.any()
        np.testing.assert_array_equal(out, good)

    def test_residue_entry_island_is_reordered(self):
        """Island entered through a residue dipole: its boundary is the long
        cut (the arc), the short cut (between the residues) was crossed. The
        residue cut must close that gap so the island separates and the
        majority of its boundary votes it back."""
        wrapped, good, mask, island, bump = _dipole_scene(bump_nm=120.0)
        # Flood-style wrong solution: the island region carries the short
        # cut's 2π across the chord, so its edges along the arc disagree.
        k_chord = np.rint((good[_Y0 + 1, _X1 + 5:_X2 - 5]
                           - good[_Y0, _X1 + 5:_X2 - 5]) / _TWO_PI)
        assert np.all(k_chord == k_chord[0]) and k_chord[0] != 0
        bad = good - _TWO_PI * k_chord[0] * island
        before = _orders(bad, good, mask)
        out, _ = _merge_unwrap_islands(bad, wrapped, mask, max_cut_px=30.0)
        after = _orders(out, good, mask)
        assert int((before != 0).sum()) > 0.9 * island.sum()
        assert int((after != 0).sum()) <= 0.08 * island.sum()
        np.testing.assert_array_equal(out[bump & mask], good[bump & mask])


class TestUnwrapPipeline:
    def _quality(self, island):
        """Seed inside the island, a low-quality ring along its arc, so the
        flood leaves the island through the residue gap (the chord)."""
        import cv2
        q = np.ones((_H, _W))
        q[island] = 1.2
        ring = (cv2.dilate(island.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & ~island
        yy = np.mgrid[0:_H, 0:_W][0]
        ring &= yy > _Y0 + 1
        q[ring] = 0.05
        return q

    def test_unwrap_phase_2d_removes_flood_island(self, monkeypatch):
        wrapped, good, mask, island, bump = _dipole_scene(bump_nm=120.0)
        q = self._quality(island)
        kw = dict(quality=q, fringe_period_px=30.0, edge_band_px=9.0)
        interior = mask & (unwrap_phase_2d(wrapped, mask, **kw)[1] != 2)

        with monkeypatch.context() as mp:
            mp.setattr(fr, "_merge_unwrap_islands",
                       lambda u, w, m, **k: (u, np.zeros(m.shape, bool)))
            u_off, _, _ = unwrap_phase_2d(wrapped, mask, **kw)
        u_on, risk_on, _ = unwrap_phase_2d(wrapped, mask, **kw)

        off = _orders(u_off, good, interior)
        on = _orders(u_on, good, interior)
        # Without the post-pass the island survives the 9x9 median snap.
        assert int((off != 0).sum()) > 0.8 * island.sum()
        # With it, the map equals the correct unwrap (up to piston) everywhere
        # in the quantitative interior.
        assert int((on != 0).sum()) == 0
        # Re-ordered pixels are reported as re-ordered (reliable), not as
        # median-snap corrected.
        assert (risk_on[island & interior] == fr._RISK_REORDERED).mean() > 0.9
        assert not np.any(risk_on[island & interior] == 1)
        np.testing.assert_allclose(u_on[bump & interior] - u_on[interior].mean(),
                                   good[bump & interior] - u_on[interior].mean()
                                   + (np.median(u_on[interior] - good[interior])),
                                   atol=1e-9)

    def test_step_path_never_calls_merge(self, monkeypatch):
        """correct_2pi_jumps=False (gage-block steps) must not run the
        post-pass at all."""
        wrapped, good, mask, island, _ = _dipole_scene()

        def boom(*a, **k):
            raise AssertionError("island merge ran with correct_2pi_jumps=False")

        monkeypatch.setattr(fr, "_merge_unwrap_islands", boom)
        unwrap_phase_2d(wrapped, mask, quality=np.ones((_H, _W)),
                        fringe_period_px=12.0, correct_2pi_jumps=False)


# ---------------------------------------------------------------------------
# Review fix-ups: risk code 3, band/wall fill, no-op cases.
# ---------------------------------------------------------------------------

def _no_merge(u, w, m, **k):
    return u, np.zeros(m.shape, bool)


def _forced_flood(monkeypatch, bad):
    """Make the quality-guided flood return ``bad`` (an island scene)."""
    monkeypatch.setattr(fr, "_quality_guided_unwrap", lambda w, q, m: bad.copy())


def _disk_scene(n=400, island_c=None, island_r=100.0):
    """Disk aperture (radius 0.475 n) with a smooth tilt + power surface and a
    disk island one fringe order off. Returns (good, bad, mask, island)."""
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    c = n / 2
    mask = np.hypot(yy - c, xx - c) <= 0.475 * n
    good = (0.01 * (xx - c)) ** 2 + 0.005 * yy
    icy, icx = island_c if island_c is not None else (c, c)
    island = mask & (np.hypot(yy - icy, xx - icx) <= island_r)
    return good, good + _TWO_PI * island, mask, island


class TestRiskCodes:
    def test_successful_merge_does_not_lower_confidence(self, monkeypatch):
        """Reviewer case: a fixed interior island must not cost unwrap
        confidence or trusted area (risk 3 counts as reliable)."""
        good, bad, mask, island = _disk_scene()
        kw = dict(quality=np.ones(mask.shape), fringe_period_px=30.0,
                  edge_band_px=22.0)
        carrier = {"fringe_period_px": 30.0, "peak_ratio": 10}
        _forced_flood(monkeypatch, bad)
        res = {}
        for on in (False, True):
            with monkeypatch.context() as mp:
                if not on:
                    mp.setattr(fr, "_merge_unwrap_islands", _no_merge)
                u, risk, _ = unwrap_phase_2d(_wrap(good), mask, **kw)
            conf = fr.compute_confidence(carrier, np.ones(mask.shape), risk, mask)
            interior = mask & (risk != 2)
            trusted = (risk[interior] == 0) | (risk[interior] == fr._RISK_REORDERED)
            res[on] = (conf["unwrap"], trusted.mean(), u, risk, interior)
        assert res[True][0] >= res[False][0]
        assert res[True][0] == 100.0
        assert res[True][1] >= res[False][1]
        # And the merge actually fixed the island.
        u, risk, interior = res[True][2], res[True][3], res[True][4]
        assert int((_orders(u, good, interior) != 0).sum()) == 0
        assert (risk[island & interior] == fr._RISK_REORDERED).mean() > 0.9

    def test_risk_precedence_snap_over_reordered(self, monkeypatch):
        """Risk = 3 where the merge shifted, 1 only where the 9x9 median snap
        then actually moves the pixel, 2 on the edge band (2 > 1 > 3 > 0)."""
        from scipy.ndimage import median_filter

        good, bad, mask, island = _disk_scene(n=200, island_r=40.0)
        # Single-pixel 2π spikes inside the island: re-ordered with it, then
        # snapped again by the median pass (3 -> 1).
        spikes = [(90, 95), (100, 110), (110, 92)]
        for y, x in spikes:
            bad[y, x] += _TWO_PI
        wrapped = _wrap(good)
        _forced_flood(monkeypatch, bad)
        u, risk, _ = unwrap_phase_2d(wrapped, mask, quality=np.ones(mask.shape),
                                     fringe_period_px=30.0, edge_band_px=22.0)
        band = risk == 2
        merged, shifted = _merge_unwrap_islands(bad, wrapped, mask & ~band,
                                                max_cut_px=30.0, fill_mask=mask)
        jump = np.abs(merged - median_filter(merged, size=9)) > np.pi
        expect = np.zeros(mask.shape, np.uint8)
        expect[shifted] = fr._RISK_REORDERED
        expect[jump] = 1
        expect[band] = 2
        np.testing.assert_array_equal(risk, expect)
        assert np.any(risk == fr._RISK_REORDERED)
        for y, x in spikes:
            assert shifted[y, x] and risk[y, x] == 1
        assert int((_orders(u, good, mask & ~band) != 0).sum()) == 0

    def test_risk_map_renders_reordered_colour(self):
        risk = np.zeros((32, 32), np.uint8)
        risk[8:16, 8:16] = fr._RISK_REORDERED
        out = fr.render_confidence_maps(np.ones((32, 32)), risk,
                                        np.ones((32, 32), bool))
        import base64
        import cv2
        img = cv2.imdecode(np.frombuffer(base64.b64decode(out["unwrap_risk"]),
                                         np.uint8), cv2.IMREAD_COLOR)
        assert tuple(img[10, 10]) == (255, 128, 0)
        assert tuple(img[0, 0]) == (0, 0, 0)


class TestBandFill:
    def test_island_crossing_edge_band_leaves_band_consistent(self, monkeypatch):
        """An island reaching into the edge band: after the merge the band
        pixels carry the interior's fringe order (no 2π step across the band
        boundary), both inside and outside the island."""
        n = 200
        yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
        mask = np.hypot(yy - 100, xx - 100) <= 90
        good = (0.02 * (xx - 100)) ** 2 * 0.5 + 0.01 * yy
        island = mask & (np.hypot(yy - 100, xx - 170) <= 45)
        _forced_flood(monkeypatch, good + _TWO_PI * island)
        u, risk, _ = unwrap_phase_2d(_wrap(good), mask, quality=np.ones((n, n)),
                                     fringe_period_px=30.0, edge_band_px=22.0)
        band = risk == 2
        interior = mask & ~band
        assert int((island & band).sum()) > 1000
        k = np.rint((u - good) / _TWO_PI)
        k0 = np.median(k[interior])
        assert int((interior & (k != k0)).sum()) == 0
        assert int((band & (k != k0)).sum()) == 0


class TestNoOp:
    @pytest.mark.parametrize("step_nm", [120.0, 250.0])
    def test_straight_step_identical_with_and_without_merge(self, monkeypatch,
                                                            step_nm):
        """A genuine straight step across the aperture (continuous or not in
        wrapped phase) produces no island: merge on == merge off."""
        n = 300
        yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
        mask = np.hypot(yy - 150, xx - 150) <= 140
        good = 0.05 * xx + 0.03 * yy + 4 * math.pi * step_nm / _WL * (xx > 150)
        kw = dict(quality=np.ones((n, n)), fringe_period_px=20.0,
                  edge_band_px=15.0)
        u_on, r_on, _ = unwrap_phase_2d(_wrap(good), mask, **kw)
        with monkeypatch.context() as mp:
            mp.setattr(fr, "_merge_unwrap_islands", _no_merge)
            u_off, r_off, _ = unwrap_phase_2d(_wrap(good), mask, **kw)
        np.testing.assert_array_equal(u_on, u_off)
        np.testing.assert_array_equal(r_on, r_off)

    def test_noisy_patch_with_residues_identical(self, monkeypatch):
        """Noise patch (σ ≈ 1.5 rad) with residues but no island: the merge
        must leave the result bit-identical."""
        import cv2

        n = 400
        yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
        mask = np.hypot(yy - 200, xx - 200) <= 190
        good = 4 * _TWO_PI * (((xx - 200) / 190) ** 2
                              + 0.6 * ((yy - 200) / 190) ** 2)
        patch = np.hypot(yy - 150, xx - 230) <= 60
        noise = np.random.default_rng(1).normal(0, 1, (n, n)) * patch
        noise = cv2.GaussianBlur(noise, (0, 0), 1.0)
        noise *= 1.5 / noise[patch].std()
        w = _wrap(good + noise)
        s = (_wrap(w[:-1, 1:] - w[:-1, :-1]) + _wrap(w[1:, 1:] - w[:-1, 1:])
             + _wrap(w[1:, :-1] - w[1:, 1:]) + _wrap(w[:-1, :-1] - w[1:, :-1]))
        assert int((np.rint(s / _TWO_PI) != 0)[mask[:-1, :-1]].sum()) > 10
        kw = dict(quality=np.exp(-np.abs(cv2.GaussianBlur(noise, (0, 0), 3))),
                  fringe_period_px=30.0, edge_band_px=22.0)
        u_on, r_on, _ = unwrap_phase_2d(w, mask, **kw)
        with monkeypatch.context() as mp:
            mp.setattr(fr, "_merge_unwrap_islands", _no_merge)
            u_off, r_off, _ = unwrap_phase_2d(w, mask, **kw)
        np.testing.assert_array_equal(u_on, u_off)
        np.testing.assert_array_equal(r_on, r_off)


def test_residue_repair_uses_platform_sized_numpy_indices(monkeypatch):
    """Exercise both APIs with wasm's 32-bit index rule on a 64-bit host."""
    wrapped, good, mask, island, _ = _dipole_scene(bump_nm=120.)
    bad = good + _TWO_PI * island
    expected, expected_shifted = _merge_unwrap_islands(bad, wrapped, mask, max_cut_px=30.)
    calls = dict(repeat=0, bincount=0)

    class WasmIndexNumpy:
        intp = np.int32

        def __getattr__(self, name):
            return getattr(np, name)

        def repeat(self, values, repeats, *args, **kwargs):
            assert np.asarray(repeats).dtype == np.dtype(np.int32)
            calls['repeat'] += 1
            return np.repeat(values, repeats, *args, **kwargs)

        def bincount(self, bins, *args, **kwargs):
            assert np.asarray(bins).dtype == np.dtype(np.int32)
            calls['bincount'] += 1
            return np.bincount(bins, *args, **kwargs)

    monkeypatch.setattr(fr, 'np', WasmIndexNumpy())
    actual, shifted = _merge_unwrap_islands(bad, wrapped, mask, max_cut_px=30.)
    assert calls['repeat'] >= 3 and calls['bincount'] > 0
    assert shifted.any()
    np.testing.assert_array_equal(actual, expected)
    np.testing.assert_array_equal(shifted, expected_shifted)
