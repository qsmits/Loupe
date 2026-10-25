"""Run in native Python and the production Pyodide version; no user images."""
import hashlib
import json
import numpy as np
from backend.vision import fringe as f


def run():
    y, x = np.mgrid[:160, :208].astype(float)
    mask = ((x-104)/93)**2 + ((y-80)/72)**2 < 1
    base = .0003*(x-104)**2+.004*y
    phase = base + np.arctan2(y-65.5, x-87.5)-np.arctan2(y-65.5, x-101.5)
    wrapped = np.angle(np.exp(1j*phase))
    island = (np.hypot(x-94, y-94) < 30) & (y>65) & mask
    bad = phase+2*np.pi*island
    cuts = f._residue_cuts(wrapped, mask, max_cut_px=30.)
    assert cuts.any(), 'Fixture must exercise repeat, not the no-residue fast path'
    repaired, shifted = f._merge_unwrap_islands(bad, wrapped, mask, max_cut_px=30.)
    assert shifted.any(), 'Fixture must exercise bincount voting'
    result = dict(index_bits=np.dtype(np.intp).itemsize*8, cuts=int(cuts.sum()),
                  shifted=int(shifted.sum()),
                  cut_hash=hashlib.sha256(cuts.tobytes()).hexdigest(),
                  shifted_hash=hashlib.sha256(shifted.tobytes()).hexdigest(),
                  remaining_order_errors=int((np.abs(repaired[mask]-phase[mask])>np.pi).sum()))
    # Also run both production analysis methods in sequence on a real synthetic
    # interferogram. The direct fixture above forces the rare repair branch;
    # these analyses also check integration and numerical parity.
    image=np.rint(np.where(mask,125+80*np.cos(2*np.pi*(.085*x+.035*y)+phase),15)).astype('uint8')
    original=f._residue_cuts
    calls=[]
    def checked(*args,**kwargs):
        cut=original(*args,**kwargs)
        calls.append(int(cut.sum()))
        return cut
    f._residue_cuts=checked
    try:
        for method in ['current','hybrid']:
            calls.clear()
            r=f.analyze_interferogram(image,custom_mask=mask,form_model='plane',analysis_method=method)
            result[method]=dict(pv_nm=r['pv_nm'],rms_nm=r['rms_nm'],valid=r['n_valid_pixels'],nonempty_cut_calls=sum(v>0 for v in calls))
    finally:
        f._residue_cuts=original
    return result
