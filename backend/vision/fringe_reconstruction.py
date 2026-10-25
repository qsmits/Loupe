"""Optional image-gradient preview with hard anchors; NOT extra measurements.

Least-squares integration of wrapped local phase gradients, with a zero-gradient
regularizer. This is an independent prototype, not the FFT solver of Ghiglia &
Romero (1994). All new values must be identified as reconstructed/inferred.
"""
import numpy as np
from scipy.ndimage import label,distance_transform_edt
from scipy.sparse import coo_matrix,diags
from scipy.sparse.linalg import cg


def preview(image, mask, current, accepted, metadata, crop, grid_shape,
            plane, wavelength_nm, progress=lambda *args: None):
    """Separate display-only payload; never modifies phases, masks or statistics."""
    import cv2
    from .fringe_hybrid import local_phase
    period = metadata['fringe_period_px']
    fx, fy = metadata['refined_fx_cpp'], metadata['refined_fy_cpp']
    theta = metadata['carrier_angle_rad']
    yy, xx = np.indices(image.shape)
    carrier = 2*np.pi*((fx-np.cos(theta)/period)*xx+(fy-np.sin(theta)/period)*yy)
    fits = []
    for i, (across, along) in enumerate(((.35, .175), (.455, .2275))):
        progress('reconstruction-fit', .91 + .02*i,
                 f'Reconstructed preview: fitting fringe detail ({i+1}/2)…')
        diagnostics = {}
        phase, condition, amplitude = local_phase(image, mask, fx, fy,
            max(3., period*across), max(2., period*along), 1, diagnostics, harmonics=2)
        fits.append(dict(phase=np.angle(np.exp(1j*(phase+carrier))),
            condition=condition, amplitude=amplitude, residual=diagnostics['residual']))
    evidence = fit_evidence(*fits, mask)
    progress('reconstruction-solve', .95, 'Reconstructing preview; measured heights stay fixed…')
    phase, added, diagnostics = reconstruct(current, accepted, mask,
        fits[0]['phase'], evidence, regularization=.01)
    r0, r1, c0, c1 = crop
    added = added[r0:r1, c0:c1]
    y, x = np.indices(added.shape)
    heights = (phase[r0:r1, c0:c1] - (plane['a']*x+plane['b']*y+plane['c']))*wavelength_nm/(4*np.pi)
    heights = np.where(added, heights, 0.)
    h, w = grid_shape
    def grid(a):
        return cv2.resize(a, (w, h), interpolation=cv2.INTER_NEAREST).ravel().tolist()
    return dict(version=1, kind='inferred_not_measured', model='small_linear_second_harmonic',
        regularization=.01, diagnostics=diagnostics,
        reconstructed_pixels=int(added.sum()),
        height_grid_nm=grid(heights.astype(np.float32)),
        reconstructed_grid=grid(added.astype(np.uint8)))


def fit_evidence(a,b,mask):
    amp=np.minimum(a['amplitude'],b['amplitude'])
    residual=np.maximum(a['residual'],b['residual'])/np.maximum(amp,1e-12)
    agreement=np.abs(np.angle(np.exp(1j*(a['phase']-b['phase']))))
    condition=np.maximum(a['condition'],b['condition'])
    with np.errstate(invalid='ignore',over='ignore'):
        strength=(amp/(amp+5))**2/(1+(residual/.5)**2+(agreement/.15)**2+(condition/1e4)**2)
    return np.where(mask,np.nan_to_num(strength,nan=0.,posinf=0.,neginf=0.),0.)


def reconstruct(current,accepted,mask,wrapped,evidence,regularization=.1,maxiter=3000):
    """Minimize Σ w(Δphase−wrapped_gradient)² + λ(Δphase)².

    Only 4-connected aperture edges exist. Measured pixels are hard Dirichlet
    anchors; components with fewer than 25 anchors remain unfilled. The minimum
    λ>0 permits smooth inference where there is no usable image evidence.
    The reported image influence is a heuristic weight, not uncertainty.
    """
    if not regularization>0:raise ValueError('regularization must be positive')
    accepted=accepted&mask&np.isfinite(current)
    groups,n=label(mask);counts=np.bincount(groups[accepted].ravel(),minlength=n+1)
    usable=mask&(groups>0)&(counts[groups]>=25)
    unknown=usable&~accepted;out=current.copy();nunknown=int(unknown.sum())
    if not nunknown:return out,unknown,dict(converged=True,iterations=0,unanchored_pixels=int((mask&~accepted).sum()),linear_residual_relative=0.)
    index=np.full(mask.shape,-1,np.int32);index[unknown]=np.arange(nunknown)
    diag=np.zeros(nunknown);rhs=np.zeros(nunknown);rr=[];cc=[];vv=[]
    gradient=np.where(np.isfinite(wrapped),wrapped,0.)
    evidence=np.where(np.isfinite(wrapped),np.clip(np.nan_to_num(evidence),0,1),0.)
    for left,right in [(np.s_[:,:-1],np.s_[:,1:]),(np.s_[:-1,:],np.s_[1:,:])]:
        edge=usable[left]&usable[right]
        i=index[left][edge];j=index[right][edge]
        data_weight=np.minimum(evidence[left][edge],evidence[right][edge])
        weight=data_weight+regularization
        target=data_weight*np.angle(np.exp(1j*(gradient[right][edge]-gradient[left][edge])))
        ui=i>=0;uj=j>=0;both=ui&uj
        np.add.at(diag,i[ui],weight[ui]);np.add.at(diag,j[uj],weight[uj])
        np.add.at(rhs,i[ui],-target[ui]);np.add.at(rhs,j[uj],target[uj])
        fixedj=ui&~uj;fixedi=uj&~ui
        np.add.at(rhs,i[fixedj],weight[fixedj]*current[right][edge][fixedj])
        np.add.at(rhs,j[fixedi],weight[fixedi]*current[left][edge][fixedi])
        rr.extend([i[both],j[both]]);cc.extend([j[both],i[both]]);vv.extend([-weight[both],-weight[both]])
    rr.append(np.arange(nunknown));cc.append(np.arange(nunknown));vv.append(diag)
    matrix=coo_matrix((np.concatenate(vv),(np.concatenate(rr),np.concatenate(cc))),shape=(nunknown,nunknown)).tocsr()
    nearest=distance_transform_edt(~accepted,return_distances=False,return_indices=True)
    initial=current[tuple(nearest)][unknown]
    iterations=0
    def count(_):
        nonlocal iterations
        iterations+=1
    solved,info=cg(matrix,rhs,x0=initial,rtol=1e-8,atol=1e-10,maxiter=maxiter,M=diags(1/diag),callback=count)
    residual=float(np.linalg.norm(matrix@solved-rhs)/max(np.linalg.norm(rhs),1e-12))
    converged=info==0 and np.isfinite(solved).all()
    if converged:out[unknown]=solved
    else:unknown[:]=False
    assert np.array_equal(out[accepted],current[accepted])
    return out,unknown,dict(converged=bool(converged),iterations=iterations,
        solver_info=int(info),linear_residual_relative=residual,regularization=regularization,
        unanchored_pixels=int((mask&~usable&~accepted).sum()))
