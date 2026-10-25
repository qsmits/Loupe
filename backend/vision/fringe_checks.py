"""Experimental continuation checks, using image-derived evidence only.

These gates are experimental hypotheses, not calibrated confidence bounds.
They only restrict additions; they never repair or replace original heights.
"""
import numpy as np
from scipy.ndimage import distance_transform_edt, gaussian_filter


def quadratic_basis(shape):
    y, x = np.indices(shape)
    u = x / max(1, shape[1] - 1) - .5
    v = y / max(1, shape[0] - 1) - .5
    return np.stack([np.ones_like(u), u, v, u*u, u*v, v*v], axis=-1)


def withheld_phase_check(phase, anchors, period, directional=False, limit=.01):
    """Fit interior phase without the held-out rim or outer directional strips.

    The held-out phase is itself an estimate, so this is a model adequacy check,
    not independent metrology. Too little training/test support fails closed.
    """
    basis = quadratic_basis(phase.shape)
    if directional:
        y, x = np.indices(phase.shape)
        tests = []
        if anchors.sum():
            for coordinate in (x, y):
                low, high = np.quantile(coordinate[anchors], [.2, .8])
                tests.extend([anchors & (coordinate <= low), anchors & (coordinate >= high)])
    else:
        # Padding makes image boundaries genuine boundaries for a full-frame mask.
        distance = distance_transform_edt(np.pad(anchors, 1))[1:-1, 1:-1]
        tests = [anchors & (distance <= period)]
    scores = []
    for held_out in tests:
        train = anchors & ~held_out
        if train.sum() < 100 or held_out.sum() < 25:
            return False, dict(complete=False, p95_rad=None, folds=len(scores))
        design = basis[train]
        coeff, _, rank, _ = np.linalg.lstsq(design, phase[train], rcond=None)
        if rank != 6:
            return False, dict(complete=False, p95_rad=None, folds=len(scores))
        error = np.abs(basis[held_out] @ coeff - phase[held_out])
        scores.append(float(np.percentile(error, 95)))
    if not scores:
        return False, dict(complete=False, p95_rad=None, folds=0)
    worst = max(scores)
    return worst <= limit, dict(complete=True, p95_rad=worst, folds=len(scores))


def structured_residual_check(image, mask, phase, anchors, metadata, limit=.01):
    """Measure local phase-like structure left in the continuation image residual.

    Regress the residual against offset, carrier amplitude, and phase derivative
    in a Gaussian window. Offset/amplitude are nuisance terms. A coherent phase
    discrepancy is rejected when it exceeds both .01 rad and three estimated
    noise standard errors. The latter is an iid-noise approximation only.
    """
    basis = quadratic_basis(image.shape)
    if anchors.sum() < 100:
        return np.zeros_like(mask), dict(complete=False), np.full(image.shape, np.nan)
    coeff = np.linalg.lstsq(basis[anchors], phase[anchors], rcond=None)[0]
    y, x = np.indices(image.shape)
    period = metadata['fringe_period_px']
    theta = metadata['carrier_angle_rad']
    arg = 2*np.pi*(np.cos(theta)*x + np.sin(theta)*y)/period + basis @ coeff
    design = np.concatenate([basis, np.cos(arg)[..., None], np.sin(arg)[..., None]], axis=-1)
    photo = np.linalg.lstsq(design[anchors], image[anchors], rcond=None)[0]
    predicted = design @ photo
    residual = np.where(mask, image - predicted, 0.)
    amplitude = np.hypot(photo[-2], photo[-1])
    if amplitude <= 15:
        return np.zeros_like(mask), dict(complete=False), np.full(image.shape, np.nan)
    wave = (photo[-2]*np.cos(arg) + photo[-1]*np.sin(arg))/amplitude
    derivative = (-photo[-2]*np.sin(arg) + photo[-1]*np.cos(arg))/amplitude
    regressors = np.stack([np.ones_like(wave), wave, derivative], axis=-1)
    sigma = max(2., period*.5)
    smooth = lambda a: gaussian_filter(a, sigma, mode='constant', truncate=3.)
    weight = mask.astype(float)
    gram = np.empty((*image.shape, 3, 3))
    rhs = np.empty((*image.shape, 3))
    for i in range(3):
        rhs[..., i] = smooth(residual*regressors[..., i])
        for j in range(3):
            gram[..., i, j] = smooth(weight*regressors[..., i]*regressors[..., j])
    eigenvalues = np.linalg.eigvalsh(gram)
    conditioned = (eigenvalues[..., 0] > .001) & (eigenvalues[..., -1] < 100*eigenvalues[..., 0])
    inverse = np.linalg.inv(gram + np.eye(3)*1e-12)
    beta = np.einsum('...ij,...j->...i', inverse, rhs)
    delta = beta[..., 2]/amplitude
    # Robust diagonal high-pass noise estimate: coefficients [1,-1,-1,1]
    # have norm 2. Require all four samples to be actual selected pixels.
    noise_mask = mask[:-1, :-1] & mask[1:, :-1] & mask[:-1, 1:] & mask[1:, 1:]
    differences = (residual[:-1, :-1]-residual[1:, :-1]
                   -residual[:-1, 1:]+residual[1:, 1:])[noise_mask]
    if differences.size < 100:
        return np.zeros_like(mask), dict(complete=False), delta
    noise = np.median(np.abs(differences-np.median(differences)))/(.67448975*2)
    # Exact squared discrete Gaussian weights, including aperture truncation,
    # give the iid covariance of the weighted least-squares estimate.
    radius = int(3*sigma + .5)
    axis = np.arange(-radius, radius+1)
    kernel = np.exp(-.5*(axis/sigma)**2)
    kernel /= kernel.sum()
    from scipy.ndimage import convolve1d
    square_smooth = lambda a: convolve1d(convolve1d(a, kernel**2, axis=0, mode='constant'), kernel**2, axis=1, mode='constant')
    square_gram = np.empty_like(gram)
    for i in range(3):
        for j in range(3):
            square_gram[..., i, j] = square_smooth(weight*regressors[..., i]*regressors[..., j])
    variance = noise**2*np.einsum('...i,...ij,...j->...', inverse[..., 2, :], square_gram, inverse[..., 2, :])/amplitude**2
    standard_error = np.sqrt(np.maximum(0, variance))
    valid = mask & conditioned & (np.abs(delta) <= np.maximum(limit, 3*standard_error))
    diagnostics = dict(complete=True, noise_sigma=float(noise),
                       rejected_pixels=int((mask & ~valid).sum()),
                       phase_bias_p95_rad=float(np.percentile(np.abs(delta[mask]), 95)))
    return valid, diagnostics, delta


from . import fringe as f

def fringe_continuation(image,mask,base_phase,base_valid,metadata,pad_frame=False):
    """Predict OUTSIDE the measured aperture only; never admit synthetic samples.

    A quadratic phase model plus quadratic illumination comes from the reliable
    interior. Image agreement is tested on actual in-aperture pixels before
    allowing the newly filtered phase to contribute. Model failure remains a
    diagnostic, never a reason to overwrite the original photograph.
    """
    from scipy.ndimage import uniform_filter
    y,x=np.indices(image.shape);u=x/max(1,image.shape[1]-1)-.5;v=y/max(1,image.shape[0]-1)-.5
    basis=np.stack([np.ones_like(u),u,v,u*u,u*v,v*v],axis=-1)
    coeff=np.linalg.lstsq(basis[base_valid],base_phase[base_valid],rcond=None)[0]
    residual_phase=basis@coeff
    theta=metadata['carrier_angle_rad'];period=metadata['fringe_period_px']
    fx,fy=np.cos(theta)/period,np.sin(theta)/period
    arg=2*np.pi*(fx*x+fy*y)+residual_phase
    design=np.concatenate([basis,np.cos(arg)[...,None],np.sin(arg)[...,None]],axis=-1)
    photo=np.linalg.lstsq(design[base_valid],image[base_valid],rcond=None)[0]
    predicted=design@photo
    # Keep EVERY real in-aperture pixel; only exterior/known exclusions filled.
    extended=np.where(mask,image,np.clip(predicted,0,255))
    if pad_frame:
        pad=int(np.ceil(2*period))
        py,px=np.mgrid[-pad:image.shape[0]+pad,-pad:image.shape[1]+pad]
        pu=px/max(1,image.shape[1]-1)-.5;pv=py/max(1,image.shape[0]-1)-.5
        pb=np.stack([np.ones_like(pu),pu,pv,pu*pu,pu*pv,pv*pv],axis=-1)
        pa=2*np.pi*(fx*px+fy*py)+pb@coeff
        pd=np.concatenate([pb,np.cos(pa)[...,None],np.sin(pa)[...,None]],axis=-1)
        extended=np.clip(pd@photo,0,255)
        extended[pad:-pad,pad:-pad]=np.where(mask,image,np.clip(predicted,0,255))
    wrapped=f.extract_phase_dft(extended,np.ones_like(extended,dtype=bool),
        carrier_override=(extended.shape[0]//2+fy*extended.shape[0],extended.shape[1]//2+fx*extended.shape[1]))
    if pad_frame:
        wrapped=np.angle(np.exp(1j*(wrapped[pad:-pad,pad:-pad]+2*np.pi*(fx+fy)*pad)))
    amplitude=float(np.hypot(photo[-2],photo[-1]))
    width=max(3,int(round(period)))
    weight=uniform_filter(mask.astype(float),size=width,mode='constant')
    mse=uniform_filter(np.where(mask,(image-predicted)**2,0),size=width,mode='constant')/np.maximum(weight,1e-12)
    reliable=mask & (np.sqrt(np.maximum(0,mse))<.04*amplitude) & (amplitude>15)
    return wrapped,reliable,dict(prediction_rms=float(np.sqrt(np.mean((image[mask]-predicted[mask])**2))),prediction_amplitude=amplitude,prediction_anchor_rms=float(np.sqrt(np.mean((image[base_valid]-predicted[base_valid])**2))))
