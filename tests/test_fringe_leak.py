"""Fringe-pitch striping from the demodulation low-pass leak.

After single-sideband filtering and demodulation, what is left of the
illumination background sits at exactly -fc and the phone-gamma/JPEG second
harmonic at +fc. The demodulation Gaussian's gain there is ~0.28, so both leak
into the baseband and beat with the surface term: a phase ripple at the fringe
pitch whose amplitude scales with background/fringe amplitude, i.e. it grows
as the fringe contrast falls. These tests pin its removal on a scaled-down
copy of the phone capture that exposed it (8% contrast, 18 deg carrier).
"""
import math

import cv2
import numpy as np
import pytest

from backend.vision.fringe import analyze_interferogram

# Half-size copy of the 2048x1536 scene the leak was diagnosed on: carrier
# 63.15 px -> 31.6 px, aperture radius 500 -> 250 px, background structure
# scaled by the same factor.
_H, _W = 768, 1024
_P = 31.575
_ANG = 18.1
_R = 250
_WL = 589.0


def _scene(contrast=0.08, *, surface_nm=None, gamma=0.45, jpeg=90,
           noise=1.5, seed=1):
    """A flat (or ``surface_nm``-figured) optical flat on a lit, structured
    background: illumination ramp, an off-centre bright lobe and a weak
    periodic shading, then display gamma, sensor noise and JPEG."""
    yy, xx = np.mgrid[0:_H, 0:_W].astype(np.float64)
    cy, cx = _H / 2, _W / 2
    disk = np.hypot(yy - cy, xx - cx) <= _R
    ang = math.radians(_ANG)
    ph = 2 * math.pi / _P * ((xx - cx) * math.cos(ang) + (yy - cy) * math.sin(ang))
    if surface_nm is not None:
        ph = ph + surface_nm * (4 * math.pi / _WL)
    rng = np.random.default_rng(seed)
    bg = np.full((_H, _W), 120.0)
    bg *= 1 + 0.25 * (xx - cx) / _W + 0.15 * (yy - cy) / _H
    bg *= 1 + 0.35 * np.exp(-((xx - (cx + 90)) ** 2 + (yy - (cy - 130)) ** 2)
                            / (2 * 70.0 ** 2))
    bg *= 1 + 0.08 * np.cos(2 * math.pi * (xx - cx) / 105 + 0.4)
    img = bg * (1 + contrast * np.cos(ph))
    img[~disk] = 40.0 + 10 * rng.random(int((~disk).sum()))
    img = 255 * (img / 255) ** gamma
    img = np.clip(img + rng.normal(0, noise, img.shape), 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, jpeg])
    assert ok
    return cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)


def _grids(r):
    gh, gw = r["grid_rows"], r["grid_cols"]
    disp = np.array(r["display_height_grid_nm"]).reshape(gh, gw)
    mask = np.array(r["mask_grid"], bool).reshape(gh, gw)
    return disp, mask


def _ripple(r):
    """Directional carrier-pitch ripple in the display grid.

    Peak |F| within +-0.35 fc of the carrier axis (or its perpendicular) in
    the 0.7-1.35 fc ring, against the median of the same ring. Returns
    ``(amplitude_nm, prominence)``.
    """
    disp, mask = _grids(r)
    gh, gw = disp.shape
    cell = r["surface_width"] / gw
    fc = cell / r["carrier"]["fringe_period_px"]
    th = math.radians(r["carrier"]["fringe_angle_deg"])
    z = np.where(mask, disp - disp[mask].mean(), 0.0)
    mag = np.abs(np.fft.fftshift(np.fft.fft2(z)))
    yy, xx = np.mgrid[0:gh, 0:gw]
    FY, FX = (yy - gh // 2) / gh, (xx - gw // 2) / gw
    rho = np.hypot(FY, FX)
    ring = (rho >= 0.7 * fc) & (rho <= 1.35 * fc)
    best = 0.0
    for a in (th, th + math.pi / 2):
        ux, uy = math.cos(a), math.sin(a)
        along = (FX * ux + FY * uy) / fc
        perp = np.abs(-FX * uy + FY * ux) / fc
        sel = ring & (np.abs(along) >= 0.7) & (perp <= 0.35)
        if sel.any():
            best = max(best, float(mag[sel].max()))
    return 2 * best / mask.sum(), best / float(np.median(mag[ring]))


@pytest.fixture(scope="module")
def flat_result():
    return analyze_interferogram(_scene(0.08), wavelength_nm=_WL)


class TestCarrierLeakStriping:
    def test_low_contrast_flat_reads_flat(self, flat_result):
        """A perfectly flat part at 8% fringe contrast on a structured,
        gamma-encoded background must not come back striped at the fringe
        pitch.

        Before the fix (HEAD, mask threshold 0.15) this measured PV 555.5 nm,
        RMS 58.8 nm, carrier-pitch ripple amplitude 17.7 nm (seeds 2/3: PV
        744/856 nm). With it: PV 47.3, RMS 6.0, ripple 7.45 nm (seeds 2/3:
        PV 47.9/45.7).
        The bounds leave ~20% headroom over the fixed result and sit an order
        of magnitude under the leaking one.

        Ripple *prominence* (peak over the ring median) is deliberately not
        asserted here: on a synthetic flat the ring median is the noise
        floor, which drops faster than the peak when the leak is removed, so
        prominence rises (27.9 -> 99.9) even as the ripple shrinks. It is a
        meaningful metric only on a real surface with its own broadband
        texture (IMG_3248: 12.6 -> 4.3).
        """
        r = flat_result
        assert abs(r["carrier"]["fringe_period_px"] - _P) < 0.5
        amp, prom = _ripple(r)
        detail = (r["pv_nm"], r["rms_nm"], amp, prom)
        assert r["pv_nm"] < 60.0, detail
        assert r["rms_nm"] < 8.0, detail
        assert amp < 9.0, detail

    def test_low_contrast_flat_raises_no_marginal_carrier_warning(self, flat_result):
        """The leak's ripple steepened the unwrapped phase enough that the
        wavefront-bandwidth check (99th-percentile |grad phi| / 2pi of the
        unwrapped phase against 0.8 x the carrier) fired on a flat part,
        producing a spurious 'Carrier is marginal' warning (present without
        leak subtraction). This is not the fold-over gate, which has its own
        warning."""
        warns = [str(m) for m in flat_result["warnings"]]
        assert not any(m.startswith("Carrier is marginal") for m in warns), warns


def _feature_truth(x, y):
    """30 nm, sigma = 30 px bump and a 20 nm, 75-px-period patch: the
    full-size scene's 60 px / 150 px features scaled by the same factor as
    the carrier, so they sit at the same fraction of fc (the patch at ~0.42 fc,
    inside the 0.3-0.7 fc band a too-narrow leak estimator would eat)."""
    bump = 30.0 * np.exp(-((x - 600) ** 2 + (y - 300) ** 2) / (2 * 30.0 ** 2))
    patch = (20.0 * np.sin(2 * math.pi * (x - 512) / 75.0)
             * np.exp(-((y - 450) ** 2) / (2 * 40.0 ** 2)))
    return bump + patch


class TestCarrierLeakPreservesFigure:
    def test_bump_and_sub_carrier_patch_survive(self):
        """Leak subtraction must not subtract genuine surface content near fc.

        Measured with leak subtraction (est_scale 2, 2 iterations): bump
        23.7/30 nm, patch rms 11.39 nm vs 12.92 nm truth (-12%). Fault-
        injected: a 1x estimator eats the patch (7.63 nm, -41%; bump 22.7),
        and no subtraction at all buries it in striping (26.78 nm, +107%),
        so the patch bound fails in both directions. The bump's ~21% loss
        is the demodulation low-pass's own roll-off (24.6 nm without leak
        subtraction), not this step."""
        yy, xx = np.mgrid[0:_H, 0:_W].astype(np.float64)
        r = analyze_interferogram(
            _scene(0.08, surface_nm=_feature_truth(xx, yy)), wavelength_nm=_WL)
        disp, m = _grids(r)
        gh, gw = disp.shape
        cell = r["surface_width"] / gw
        x0 = _W / 2 - r["surface_width"] / 2
        y0 = _H / 2 - r["surface_height"] / 2
        gy, gx = np.mgrid[0:gh, 0:gw]
        sx, sy = (gx + 0.5) * cell + x0, (gy + 0.5) * cell + y0
        truth = _feature_truth(sx, sy)
        bump = m & (np.hypot(sx - 600, sy - 300) < 12.5)
        patch = m & (np.abs(sy - 450) < 30) & (np.abs(sx - 512) < 150)
        bump_nm = disp[bump].mean() - disp[m & ~bump & ~patch].mean()
        patch_rms = disp[patch].std()
        truth_rms = truth[patch].std()
        detail = (bump_nm, patch_rms, truth_rms)
        assert bump.sum() > 20 and patch.sum() > 200, (bump.sum(), patch.sum())
        assert bump_nm >= 0.7 * 30.0, detail
        assert abs(patch_rms / truth_rms - 1.0) <= 0.25, detail


class TestModulationEnvelopeLeak:
    def test_long_period_modulation_map_has_no_fringe_pitch_stripes(self):
        """The modulation envelope's box filter (2P wide) has a null at fc and
        2fc, so neither the residual background (-fc after demodulation) nor
        the conjugate sideband (-2fc) reaches the envelope. A 61 px cap on
        that box -- "for efficiency", though ``uniform_filter`` is a running
        sum whose cost does not depend on its size -- broke the null for any
        period over ~30 px: at P = 80 the box gain at 2fc is ~0.21 and the
        envelope of a perfectly uniform fringe field striped at the fringe
        pitch by that fraction of its mean. Measured: 2fc component 0.168 on
        a 0.821 mean (20.5%) with the cap, 0.0061 on 0.983 (0.62%) without;
        the fc component is ~0.0003 either way (no background in this
        fixture).
        """
        from backend.vision.fringe import compute_fringe_modulation
        h, w, P = 600, 640, 80.0
        _yy, xx = np.mgrid[0:h, 0:w]
        img = 128.0 + 100.0 * np.cos(2 * np.pi * xx / P)
        mod = compute_fringe_modulation(img)
        # Interior, clear of the filter's frame-edge support, spanning an
        # integer number of periods so the projections below are exact.
        core = mod[100:h - 100, 80:80 + int(6 * P)]
        x = np.arange(core.shape[1])
        mean = float(core.mean())
        comps = {}
        for k in (1, 2):
            ph = np.exp(-2j * np.pi * k * x / P)
            comps[k] = 2.0 * abs(float(np.abs((core * ph[None, :]).mean())))
        detail = (mean, comps)
        assert comps[1] < 0.03 * mean, detail
        assert comps[2] < 0.03 * mean, detail


def _weak_disc_scene(h=420, w=520, P=24.0, ang_deg=20.0, disc_d=4.0,
                     weak=0.2, seed=3):
    """Full-frame, evenly lit fringes with a central disc of ``disc_d`` P
    diameter whose fringe contrast is ``weak`` x the rest."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    a = math.radians(ang_deg)
    ph = 2 * math.pi / P * (xx * math.cos(a) + yy * math.sin(a))
    r = np.hypot(yy - h / 2, xx - w / 2)
    amp = np.where(r < disc_d * P / 2, 60.0 * weak, 60.0)
    img = 128.0 + amp * np.cos(ph)
    img += np.random.RandomState(seed).randn(h, w) * 1.0
    return np.clip(img, 0, 255), r


class TestWeakFringeHole:
    def test_weak_fringe_disc_and_margin_leave_the_measured_aperture(self):
        """A region whose fringe contrast is 1/5 of the rest has no
        trustworthy phase; it must leave the measured aperture together with
        a margin, and nothing else may.

        The threshold alone does not get there: the modulation envelope is a
        2P box average, so its 0.30-of-median crossing sits ~0.75 P *inside*
        the weak disc, and its marginal pixels survive as a ragged fringe the
        seam closing then bridges. Mirroring ``_foldover_islands``, the
        rejected hole is dilated by P/2 before it is removed, and the
        boundary band (~0.76 P) takes it the rest of the way.

        Where the margin comes from (all distances from the disc centre; the
        disc edge is at 2 P). The threshold crossing of the 2P-box envelope
        is ragged: the outermost rejected pixel sits at 1.24 P (≈ 0.75 P
        inside the disc edge), the nearest side of the crossing at ≈ 1.1 P.
        The P/2 dilation carries the hole out to 1.6-1.75 P, so the remaining
        aperture's innermost edge is at ≈ 1.6 P, and the boundary band (≈ 0.76
        -0.78 P, measured from that edge) puts the innermost measured pixel at
        2.375 P: a margin of 0.375 P over the disc (summing from the
        *outermost* crossing would predict 0.5 P, which overstates it). The
        margin moves with the scene: 0.29 P at weak = 0.25, 0.36 P at P = 25,
        0.33-0.42 P for a 3-7 px disc shift, so 0.2 P is asserted. The real
        guard is PV < 6 nm: threshold 0.15 measures the disc outright
        (innermost pixel 0.00 P) and reads 12.9 nm; threshold 0.30 without
        the dilation still reaches 1.88 P, inside the disc, and reads
        10.7 nm; with the dilation it reads ≈ 2.8 nm. The rest of the field
        stays 100% in in every case.
        """
        P = 24.0
        img, r = _weak_disc_scene(P=P)
        h, w = img.shape
        res = analyze_interferogram(img, wavelength_nm=_WL)
        assert (res["surface_height"], res["surface_width"]) == (h, w)
        m = np.asarray(res["_mask_full"], bool).reshape(h, w)
        yy, xx = np.mgrid[0:h, 0:w]
        frame_dist = np.minimum.reduce([yy, xx, h - 1 - yy, w - 1 - xx])
        r_disc = 2.0 * P
        hole = r < r_disc + 0.2 * P
        rest = (r > r_disc + 2.5 * P) & (frame_dist > 2 * P)
        detail = (float(m[hole].mean()), float(r[m].min() / P),
                  float(m[rest].mean()), res["pv_nm"], res["warnings"])
        assert not m[hole].any(), detail
        assert m[rest].mean() >= 0.99, detail
        assert res["pv_nm"] < 6.0, detail
