"""Experimental single-capture composite and categorical evidence, not uncertainty.

Every extension fits recorded pixels and anchors to the original Hybrid result.
No newly recovered pixels seed another fit. Thresholds are dimensionless phase /
intensity checks from the coverage study, not nanometer accuracy guarantees.
"""
import numpy as np
import cv2
from scipy.ndimage import label, distance_transform_edt, binary_propagation, gaussian_filter
from .fringe_hybrid import local_phase
from . import fringe as f

def fit_window(image, mask, metadata, across_fraction, along_fraction, degree=2):
    period=metadata['fringe_period_px'];theta=metadata['carrier_angle_rad']
    fx=metadata['refined_fx_cpp'];fy=metadata['refined_fy_cpp']
    diagnostics={}
    phase,condition,amplitude=local_phase(image,mask,fx,fy,max(3.,period*across_fraction),
        max(2.,period*along_fraction),degree,diagnostics)
    y,x=np.indices(image.shape)
    phase=np.angle(np.exp(1j*(phase+2*np.pi*((fx-np.cos(theta)/period)*x+(fy-np.sin(theta)/period)*y))))
    return dict(phase=phase,condition=condition,amplitude=amplitude,residual=diagnostics['residual'])


def stable_fit(a,b,mask,phase_limit=.025,condition_limit=1000,residual_floor=0.):
    condition=(a['condition']<condition_limit)&(b['condition']<condition_limit)
    amplitude=(a['amplitude']>15)&(b['amplitude']>15)
    residual=(a['residual']<np.maximum(a['amplitude']*.04,residual_floor))&(b['residual']<np.maximum(b['amplitude']*.04,residual_floor))
    agreement=np.abs(np.angle(np.exp(1j*(a['phase']-b['phase']))))<phase_limit
    valid=mask & condition & amplitude & residual & agreement
    # Report exclusive first-failing causes, not overlapping counts.
    reasons={};remaining=mask.copy()
    for name,gate in [('conditioning',condition),('contrast',amplitude),('image_residual',residual),('window_disagreement',agreement)]:
        reasons[name]=int((remaining&~gate).sum());remaining&=gate
    reasons['fit_passed']=int(valid.sum())
    return valid,reasons


def anchored_candidate(base_phase,base_valid,wrapped,reliable,mask,modulation,period,
                       reach=1.,agreement=.05,erode=True):
    """Unwrap real local fits and attach to ORIGINAL anchors, never filled values.

    No synthetic pixels enter the image regression. Every candidate component
    needs at least 25 anchor pixels and a consistent integer fringe order. Failed
    bridges are disconnected before growth; distance is measured from original
    observations even when all connected candidates are requested (reach=None).
    """
    local,_,_=f.unwrap_phase_2d(wrapped,mask,quality=modulation,
        fringe_period_px=period,edge_kernel=np.ones((1,1),np.uint8),correct_2pi_jumps=False)
    valid=reliable & mask & np.isfinite(local)
    if erode:valid=f._supported_interior(valid,np.ones((3,3),np.uint8))
    groups,count=label(valid)
    accepted=np.zeros_like(valid);aligned=local.copy()
    for j in range(1,count+1):
        region=groups==j;anchor=region & base_valid
        if anchor.sum()<25:continue
        turns=np.round(np.median((base_phase[anchor]-local[anchor])/(2*np.pi)))
        candidate=local+turns*2*np.pi
        error=np.abs(candidate[anchor]-base_phase[anchor])
        if np.percentile(error,90)>agreement:continue
        # Never use a disagreeing anchor as a bridge into a new area.
        eligible=region & (~base_valid | (np.abs(candidate-base_phase)<agreement))
        connected=binary_propagation(anchor & eligible,mask=eligible)
        if reach is not None:connected &= distance_transform_edt(~base_valid)<=period*reach
        accepted |= connected
        aligned[connected]=candidate[connected]
    return aligned,accepted


def extend_from_candidates(base_phase,base_valid,candidates,consensus=False,tolerance=.025):
    """Keep existing measurements exactly; fill only independently anchored fits."""
    out=base_phase.copy();valid=base_valid.copy();support=np.zeros_like(out,dtype=np.uint8)
    if not candidates:return out,valid,support
    phases=np.stack([p for p,m in candidates]);masks=np.stack([m for p,m in candidates])
    for j in range(len(candidates)):
        agreeing=masks & (np.abs(phases-phases[j])<tolerance)
        count=agreeing.sum(axis=0)
        permitted=masks[j] & ~base_valid & (count>=(2 if consensus else 1)) & (count>support)
        out[permitted]=np.sum(np.where(agreeing,phases,0),axis=0)[permitted]/count[permitted]
        valid[permitted]=True;support[permitted]=count[permitted]
    return out,valid,support



# Equivalent to the studied 5 nm admission score at 632.8 nm. Keep the
# IMAGE/PHASE gate fixed when wavelength changes; scale physical heights later.
COVERAGE_LIMIT = 5 * 4 * np.pi / 632.8
WINDOWS = ((.35, .175), (.5, .25), (.5, .5))


def order_check(phase, valid):
    """Compare a different unwrap path, allowing an arbitrary piston per island.

    A disagreement cannot identify which path is correct. Quarantine the whole
    connected island instead of blessing the majority order or repairing it.
    Agreement is only a check for detectable order mistakes, not true height.
    """
    from skimage.restoration import unwrap_phase
    conflict = np.zeros(valid.shape, bool)
    groups, count = label(valid)
    checked = 0
    for j in range(1, count+1):
        region = groups == j
        if region.sum() < 25:
            continue
        yy, xx = np.where(region)
        sl = np.s_[yy.min():yy.max()+1, xx.min():xx.max()+1]
        if min(region[sl].shape) < 2:
            continue
        wrapped = np.angle(np.exp(1j*phase[sl]))
        alternate = unwrap_phase(np.ma.array(wrapped, mask=~region[sl]), rng=0)
        turns = np.rint((phase[sl][region[sl]]-alternate.data[region[sl]])/(2*np.pi))
        checked += int(region.sum())
        if np.ptp(turns) > 0:
            conflict[region] = True
    return conflict, dict(checked_pixels=checked, conflicted_pixels=int(conflict.sum()))


def stack_layers(base_phase, base_valid, stable, expanded):
    """First accepted layer wins; provenance never implies calibrated quality."""
    phase = base_phase.copy(); valid = base_valid.copy()
    source = np.zeros(base_valid.shape, np.uint8)
    source[base_valid] = 1
    for source_id, candidate in ((2, stable), (3, expanded)):
        added = candidate[1] & ~valid & np.isfinite(candidate[0])
        phase[added] = candidate[0][added]; valid[added] = True
        source[added] = source_id
    return phase, valid, source


def photographic_fit_checks(image, mask, metadata, primary=None, lateral=None,
                            *, _filtered_residual_limit=.20):
    """Screen textured photographs without interpreting residual RMS as height error.

    A second window shape tests sensitivity to texture along the fringes. Mild
    filtering diagnoses residual structure only: returned heights always come
    from the original image fit. These correlated checks are NOT an uncertainty
    estimate, and all survivors still need original-anchor/order checks.
    """
    a,b = primary or (fit_window(image,mask,metadata,.5,.25),
                      fit_window(image,mask,metadata,.65,.325))
    def screen(a,b,residual_limit):
        gate = mask & (a['condition']<1000) & (b['condition']<1000)
        gate &= (a['amplitude']>15) & (b['amplitude']>15)
        gate &= (a['residual']<a['amplitude']*residual_limit) & (b['residual']<b['amplitude']*residual_limit)
        gate &= np.abs(np.angle(np.exp(1j*(a['phase']-b['phase']))))<.025
        return gate
    raw = screen(a,b,.20)
    sigma=max(.5,metadata['fringe_period_px']*.05)
    weight=mask.astype(float)
    # Constant padding and normalization include only observed aperture pixels.
    filtered=gaussian_filter(np.where(mask,image,0.),sigma,mode='constant')/np.maximum(
        gaussian_filter(weight,sigma,mode='constant'),1e-12)
    fa=fit_window(filtered,mask,metadata,.5,.25)
    fb=fit_window(filtered,mask,metadata,.65,.325)
    filtered_ok=screen(fa,fb,_filtered_residual_limit)
    for original,smoothed in ((a,fa),(b,fb)):
        filtered_ok &= np.abs(np.angle(np.exp(1j*(original['phase']-smoothed['phase']))))<.025
    la,lb = lateral or (fit_window(image,mask,metadata,.5,.5),
                       fit_window(image,mask,metadata,.65,.65))
    lateral_ok=screen(la,lb,.20)
    lateral_ok &= np.abs(np.angle(np.exp(1j*(a['phase']-la['phase']))))<.025
    permitted=raw & filtered_ok & lateral_ok
    diagnostics=dict(raw_passed_pixels=int(raw.sum()),
        filtered_passed_pixels=int((raw & filtered_ok).sum()),
        cross_window_passed_pixels=int(permitted.sum()), filter_sigma_px=float(sigma),
        raw_residual_limit=.20, filtered_residual_limit=_filtered_residual_limit, phase_agreement_limit_rad=.025)
    return a['phase'],permitted,diagnostics


def build_composite(image, mask, phase, valid, metadata, progress=lambda *args: None,
                    *, _photographic=True):
    """Fit two evidence levels, then classify all pixels, including the base."""
    strict_candidates = []; broad_candidates = []
    strict_votes = np.zeros(mask.shape, np.uint8)
    broad_votes = np.zeros(mask.shape, np.uint8)
    disagreements = np.zeros(mask.shape, np.uint8)
    photographic_windows = {}
    for i, (across, along) in enumerate(WINDOWS):
        progress('composite-fit', .49 + .05*i, f'Composite: checking local window {i+1} of {len(WINDOWS)}…')
        a = fit_window(image, mask, metadata, across, along)
        b = fit_window(image, mask, metadata, 1.3*across, 1.3*along)
        if _photographic and i in (1,2): photographic_windows[i] = (a,b)
        difference = np.abs(np.angle(np.exp(1j*(a['phase']-b['phase']))))
        residual = np.maximum(a['residual']/np.maximum(a['amplitude'], 1e-12),
                              b['residual']/np.maximum(b['amplitude'], 1e-12))
        score = np.maximum(difference, residual)
        broad = (mask & (a['amplitude'] > 10) & (b['amplitude'] > 10)
                 & (a['condition'] < 10000) & (b['condition'] < 10000)
                 & np.isfinite(score) & (score <= COVERAGE_LIMIT))
        strict, _ = stable_fit(a, b, mask)
        # Independent anchoring for each gate: broad growth never validates strict growth.
        for reliable, candidates in ((strict, strict_candidates), (broad, broad_candidates)):
            candidates.append(anchored_candidate(phase, valid, a['phase'], reliable, mask,
                np.where(mask, np.maximum(a['amplitude'], 0), 0), metadata['fringe_period_px'],
                reach=None, erode=False))
        # Wrapped agreement alone hides integer-fringe disagreement. A baseline
        # pixel earns corroboration only from an accepted, unwrapped component
        # whose order has passed the original-anchor check.
        sp, sm = strict_candidates[-1]
        bp, bm = broad_candidates[-1]
        strict_votes += sm & valid & (np.abs(sp-phase) < .025)
        broad_votes += bm & valid & (np.abs(bp-phase) < .05)
        wrapped_delta = np.abs(np.angle(np.exp(1j*(a['phase']-phase))))
        disagreements += broad & valid & (wrapped_delta > COVERAGE_LIMIT)
    strict = extend_from_candidates(phase, valid, strict_candidates, consensus=True, tolerance=.025)
    broad = extend_from_candidates(phase, valid, broad_candidates, consensus=True, tolerance=COVERAGE_LIMIT)
    combined, accepted, source = stack_layers(phase, valid, strict, broad)
    # Categorical, correlated image evidence. Missing corroboration is explicit.
    quality = np.zeros(mask.shape, np.uint8)
    quality[accepted] = 3
    quality[(source == 2) | (valid & (strict_votes >= 2))] = 1
    quality[(source == 3) | (valid & (broad_votes >= 2) & (strict_votes < 2))] = 2
    conflict = valid & (disagreements >= 2)
    reasons = conflict.astype(np.uint8)  # bit 1: local phase disagreement
    progress('composite-check', .62, 'Composite: checking fringe order and withheld edge predictions…')
    order_conflict, order_diagnostics = order_check(combined, accepted)
    conflict |= order_conflict
    reasons[order_conflict] |= 2
    # Continuation never supplies a height without actual image evidence. Its
    # quadratic prediction must first survive withheld real anchors, then local
    # structured-residual and integer-order checks. It remains limited evidence.
    from .fringe_checks import withheld_phase_check, structured_residual_check, fringe_continuation
    anchors = valid & ~conflict
    rim_ok, rim_diagnostics = withheld_phase_check(phase, anchors, metadata['fringe_period_px'])
    continuation_diagnostics = dict(attempted=False, added_pixels=0)
    if rim_ok and (~accepted & mask).any():
        permitted, residual_diagnostics, _ = structured_residual_check(image, mask, phase, anchors, metadata)
        wrapped, reliable, _ = fringe_continuation(image, mask, phase, anchors, metadata, pad_frame=True)
        predicted, supported = anchored_candidate(phase, anchors, wrapped, reliable & permitted,
            mask, mask.astype(float), metadata['fringe_period_px'], reach=None, erode=False)
        # Failed areas cannot be bridges; existing conflicts remain excluded.
        eligible = supported & permitted & ~conflict
        connected = binary_propagation(eligible & anchors, mask=eligible)
        added = connected & ~accepted
        trial = combined.copy(); trial[added] = predicted[added]
        trial_conflict, _ = order_check(trial, accepted | added)
        # A new continuation bridge must not introduce order ambiguity. Reject
        # its additions; it cannot invalidate or overwrite the earlier layers.
        rejected = int((added & trial_conflict).sum())
        added &= ~trial_conflict
        combined[added] = predicted[added]
        accepted |= added; source[added] = 4; quality[added] = 3
        continuation_diagnostics = dict(attempted=True, added_pixels=int(added.sum()),
            order_rejected_pixels=rejected, residual=residual_diagnostics)
    photographic_diagnostics = dict(attempted=False, added_pixels=0)
    if _photographic and anchors.sum()>=25 and (mask & ~accepted & ~conflict).any():
        progress('composite-photographic', .64, 'Composite: checking photographic recovery against texture and window shape…')
        wrapped, reliable, photo_checks = photographic_fit_checks(image, mask, metadata,
            primary=photographic_windows[1], lateral=photographic_windows[2])
        predicted, supported = anchored_candidate(phase, anchors, wrapped,
            reliable & ~conflict, mask, mask.astype(float), metadata['fringe_period_px'])
        # Earlier layers are vetoes, never new anchors. A disagreeing seam or
        # conflicted pixel cannot become a bridge into a recovered region.
        eligible = supported & ~conflict & (~accepted | (np.abs(predicted-combined)<.05))
        connected = binary_propagation(eligible & anchors, mask=eligible)
        added = connected & ~accepted & mask
        trial = combined.copy(); trial[added] = predicted[added]
        trial_conflict, _ = order_check(trial, (accepted & ~conflict) | added)
        rejected = int((added & trial_conflict).sum())
        added &= ~trial_conflict
        combined[added] = predicted[added]
        accepted |= added; source[added] = 5; quality[added] = 3
        photographic_diagnostics = dict(attempted=True, **photo_checks,
            anchored_pixels=int(supported.sum()), added_pixels=int(added.sum()),
            order_rejected_pixels=rejected)
    quality[conflict] = 3
    return combined, accepted, dict(source=source, quality=quality, conflict=conflict, aperture=mask,
        reasons=reasons, diagnostics=dict(order=order_diagnostics, withheld_rim=rim_diagnostics,
                                         continuation=continuation_diagnostics,
                                         photographic=photographic_diagnostics))


def payload(fields, heights, crop, grid_shape):
    """Full-resolution statistics; nearest-sampled grids retain pixel provenance.

    All cutoffs use the SAME already-removed form. No plane is refitted when
    changing cutoff, so the underlying surface and heights cannot shift.
    """
    r0, r1, c0, c1 = crop; h, w = grid_shape
    source = fields['source'][r0:r1, c0:c1]
    quality = fields['quality'][r0:r1, c0:c1]
    conflict = fields['conflict'][r0:r1, c0:c1]
    aperture = fields['aperture'][r0:r1, c0:c1]
    def summarize(photographic):
        summaries=[]
        for cutoff in (1, 2, 3):
            included = (quality > 0) & (quality <= cutoff) & ~conflict
            if not photographic: included &= source!=5
            values = heights[included]
            stats = f.surface_stats(heights, included) if values.size else None
            summaries.append(dict(cutoff=cutoff, pixels=int(included.sum()),
                coverage_pct=float(100*included.sum()/max(1, aperture.sum())),
                pv_nm=float(stats['pv']) if stats else None, rms_nm=float(stats['rms']) if stats else None))
        return summaries
    def grid(a):
        return cv2.resize(a, (w, h), interpolation=cv2.INTER_NEAREST).ravel().tolist()
    return dict(version=1, interpretation='qualitative_image_evidence_not_measurement_uncertainty',
        source_grid=grid(source), quality_grid=grid(quality), conflict_grid=grid(conflict.astype(np.uint8)),
        reason_grid=grid(fields.get('reasons', fields['conflict'].astype(np.uint8))[r0:r1,c0:c1]),
        diagnostics=fields.get('diagnostics', {}),
        height_grid_nm=grid(heights.astype(np.float32)), aperture_grid=grid(aperture.astype(np.uint8)),
        aperture_pixels=int(aperture.sum()), conflict_pixels=int(conflict.sum()), summaries=summarize(True),
        without_photographic_summaries=summarize(False),
        photographic_pixels=int(((source==5) & ~conflict).sum()),
        sources=[dict(id=1, capture_index=0, method='hybrid'),
                 dict(id=2, capture_index=0, method='strict_local_consensus'),
                 dict(id=3, capture_index=0, method='coverage_local_consensus'),
                 dict(id=4, capture_index=0, method='checked_continuation'),
                 dict(id=5, capture_index=0, method='photographic_recovery')],
        reference='Single shared form removal, fixed for all cutoffs; analysis-time air-gap departure. Physical direction unverified.')
