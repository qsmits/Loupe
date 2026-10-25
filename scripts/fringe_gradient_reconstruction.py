"""Image-gradient reconstruction with hard measured anchors; NOT extra measurements.

Least-squares integration of wrapped local phase gradients, with a zero-gradient
regularizer. This is an independent prototype, not the FFT solver of Ghiglia &
Romero (1994). All new values must be identified as reconstructed/inferred.
"""
import numpy as np
from scipy.ndimage import label,distance_transform_edt
from scipy.sparse import coo_matrix,diags
from scipy.sparse.linalg import cg


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
