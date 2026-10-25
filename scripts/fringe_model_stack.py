"""Research-only, independently anchored model extensions; earlier layers win."""
import numpy as np
from scipy.ndimage import binary_dilation, binary_propagation
from backend.vision import fringe_composite as c


def prepare_candidate(base, anchors, current, fields, wrapped, gate, mask, period):
    accepted = (fields['source'] > 0) & ~fields['conflict']
    phase, supported = c.anchored_candidate(
        base, anchors, wrapped, gate & ~fields['conflict'], mask,
        mask.astype(float), period, reach=1., erode=True)
    eligible = supported & ~fields['conflict'] & mask & np.isfinite(phase)
    eligible &= ~accepted | (np.abs(phase-current) < .05)
    connected = binary_propagation(eligible & anchors, mask=eligible)
    added = connected & ~accepted
    trial = current.copy(); trial[added] = phase[added]
    bad, _ = c.order_check(trial, accepted | added)
    # Remove failed components from support as well as the additions. They
    # cannot later become bridges in a different stack order.
    connected &= ~bad
    return phase, connected, dict(supported_pixels=int(supported.sum()),
        independent_added_pixels=int((connected & ~accepted).sum()),
        independent_order_rejected_pixels=int((added & bad).sum()))


def stack_models(current, fields, anchors, mask, candidates, order, tolerance=.05):
    """Keep old phases, require overlap agreement, then check the joint unwrap.

    candidates maps names to (unwrapped phase, independently anchored support).
    Overlap checks use absolute unwrapped differences, not modulo a fringe.
    A rejected overlap gets a one-pixel moat. Each candidate must still connect
    to ORIGINAL anchors after exclusion: candidates never seed each other.
    tolerance=None is a diagnostic union, not an agreement-checked result.
    """
    accepted = (fields['source'] > 0) & ~fields['conflict']
    blocked = fields['conflict'] | ~mask
    disagreement = np.zeros(mask.shape, bool)
    overlap = np.zeros(mask.shape, bool)
    max_difference = 0.
    for i, name in enumerate(order):
        p, pm = candidates[name]
        for other in order[i+1:]:
            q, qm = candidates[other]
            both = pm & qm & ~accepted & ~blocked
            overlap |= both
            if both.any(): max_difference = max(max_difference, float(np.abs(p[both]-q[both]).max()))
            if tolerance is not None: disagreement |= both & (np.abs(p-q) >= tolerance)
    moat = binary_dilation(disagreement, structure=np.ones((3,3), bool)) & ~accepted
    blocked = blocked | moat
    phase = current.copy(); source = fields['source'].copy()
    added = np.zeros(mask.shape, bool)
    disconnected = 0
    ids = {name: 6+i for i, name in enumerate(candidates)}
    for name in order:
        p, pm = candidates[name]
        eligible = pm & ~blocked & np.isfinite(p)
        reachable = binary_propagation(eligible & anchors, mask=eligible)
        disconnected += int((eligible & ~reachable & ~accepted).sum())
        take = reachable & ~accepted & ~added
        phase[take] = p[take]; source[take] = ids[name]; added |= take
    before_order = int(added.sum()); passes = 0
    while True:
        bad, _ = c.order_check(phase, accepted | added); passes += 1
        rejected = added & bad
        if not rejected.any(): break
        added[rejected] = False; source[rejected] = fields['source'][rejected]
        phase[rejected] = current[rejected]
    assert np.array_equal(phase[accepted], current[accepted])
    assert np.array_equal(source[accepted], fields['source'][accepted])
    assert not (added & (~mask | fields['conflict'])).any()
    return phase, added, source, dict(
        overlap_pixels=int(overlap.sum()), overlap_max_difference_rad=max_difference,
        disagreement_pixels=int(disagreement.sum()), disagreement_moat_pixels=int(moat.sum()),
        disconnected_candidate_pixels=disconnected, joint_order_passes=passes,
        joint_order_rejected_pixels=before_order-int(added.sum()),
        remaining_old_order_conflict_pixels=int((bad & accepted).sum()),
        source_counts={name:int((added & (source == ids[name])).sum()) for name in order})


def stack_tiers(current, fields, anchors, mask, candidates, tiers, tolerance=.05):
    """Freeze each completed tier before letting lower-priority models fill gaps."""
    phase=current.copy(); source=fields['source'].copy(); added=np.zeros(mask.shape,bool)
    diagnostics=[]
    for order in tiers:
        frozen=(source>0)&~fields['conflict']
        # A disagreeing lower-priority fit cannot erase or bridge through an
        # earlier measurement. It still needs its own original-anchor path.
        pool={name:(p,pm & (~frozen | (np.abs(p-phase)<tolerance)))
              for name,(p,pm) in candidates.items()}
        previous_phase=phase; previous_source=source
        phase,new,source,diag=stack_models(phase,{**fields,'source':source},anchors,
            mask,pool,order,tolerance)
        assert np.array_equal(phase[frozen],previous_phase[frozen])
        assert np.array_equal(source[frozen],previous_source[frozen])
        added |= new; diagnostics.append(dict(models=order,added_pixels=int(new.sum()),**diag))
    ids={name:6+i for i,name in enumerate(candidates)}
    return phase,added,source,dict(tiers=diagnostics,
        joint_order_rejected_pixels=sum(d['joint_order_rejected_pixels'] for d in diagnostics),
        remaining_old_order_conflict_pixels=diagnostics[-1]['remaining_old_order_conflict_pixels'],
        source_counts={name:int((added&(source==idx)).sum()) for name,idx in ids.items()},
        earlier_tiers_preserved=True)
