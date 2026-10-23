// Describe the calculation actually stored with a result, including legacy captures.
export function describeFormRemoval(data = {}) {
  const model = data.form_model || 'zernike';
  const terms = (data.subtracted_terms || [1, 2, 3]).map(Number);
  const residual = model === 'poly2' || model === 'poly3' ||
    (model === 'zernike' && terms.some(term => term > 3));
  const tiltOnly = model === 'plane' ||
    (model === 'zernike' && [1, 2, 3].every(term => terms.includes(term)) && !residual);
  let removal;
  if (model === 'plane') removal = 'Height offset and tilt removed; curvature retained.';
  else if (model === 'poly2' || model === 'poly3') removal = `Polynomial order ${model.slice(-1)} removed, including curvature.`;
  else {
    const names = {1:'height offset', 2:'tilt X', 3:'tilt Y', 4:'curvature', 5:'saddle', 6:'saddle', 7:'coma', 8:'coma', 11:'spherical'};
    removal = `Zernike terms removed: ${terms.map(term => `Z${term}${names[term] ? ` (${names[term]})` : ''}`).join(', ') || 'none'}.`;
  }
  return {
    residual, tiltOnly,
    metric: residual ? 'Residual' : 'Gap',
    label: residual ? 'Residual after form removal' : tiltOnly ? 'Flatness — best-fit plane' : 'Gap departure — partial/no tilt removal',
    detail: `${removal} ${residual ? 'PV/RMS describe the remaining shape, not total flatness.' : tiltOnly ? 'PV/RMS are relative to a least-squares plane, not minimum-zone flatness.' : 'Remove height offset and both tilt axes for flatness evaluation.'} Reference-flat error remains included.`,
  };
}
