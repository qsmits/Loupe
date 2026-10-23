import {fr, $} from './fringe.js';

export function qualityDescription(data, trustedOnly = false) {
  const c = data?.coverage, f = data?.analysis_filter;
  const lines = [];
  if (c?.aperture_pixels > 0) {
    lines.push(`Measurement area: ${(100*c.measured_pixels/c.aperture_pixels).toFixed(1)}% of the detected fringe aperture; ${c.boundary_excluded_pixels.toLocaleString()} boundary pixels excluded.`);
    if (c.requested_pixels > 0) lines.push(`${(100*c.measured_pixels/c.requested_pixels).toFixed(1)}% of the drawn include/exclude area contributes to the full-aperture result.`);
  } else lines.push('Original aperture coverage is unavailable for this result.');
  if (trustedOnly) lines.push('Trusted-only is on: displayed statistics and measurements use the trusted subset of the measurement grid.');
  else lines.push('PV/RMS describe the measurement aperture, not the entire photographed part.');
  if (Number.isFinite(f?.sigma_across_px) && Number.isFinite(f?.sigma_along_px)) {
    lines.push(`Smoothing sigma: ${f.sigma_across_px.toFixed(1)} px across / ${f.sigma_along_px.toFixed(1)} px along fringes (analysis pixels). Small features can appear shallower; these widths are not a calibrated resolution limit.`);
    if (f.sigma_across_px <= 5.00001 || f.sigma_along_px <= 2.00001) lines.push('A minimum filter width is active: lowering the filter setting may not reveal more detail.');
  }
  return lines;
}

// The legend's colors distinguish accepted pixels from rejected boundaries;
// outside the aperture the original interferogram remains visible, dimmed.
export function coveragePixels(data, trustedOnly = false) {
  const n = data.grid_rows * data.grid_cols;
  if (!(n > 0) || data.mask_grid?.length !== n || data.diagnostic_mask_grid?.length !== n) return null;
  const pixels = new Uint8ClampedArray(n*4);
  for (let i=0;i<n;i++) {
    const measured=!!data.mask_grid[i], trusted=data.trusted_mask_grid?.length === n && !!data.trusted_mask_grid[i];
    const color = measured && (!trustedOnly || trusted) ? [45,212,191,100]
      : measured ? [157,110,229,175] : data.diagnostic_mask_grid[i] ? [245,158,11,190] : [0,0,0,160];
    pixels.set(color, i*4);
  }
  return pixels;
}

let generation = 0;
export function refreshQuality(data = fr.lastResult) {
  const panel = $('fringe-quality');
  if (panel) panel.hidden = !data;
  const summary=panel?.querySelector('summary');
  if (summary) summary.textContent=data?.coverage?.aperture_pixels > 0
    ? `Coverage & smoothing · ${(100*data.coverage.measured_pixels/data.coverage.aperture_pixels).toFixed(1)}% of fringe aperture retained`
    : 'Coverage & smoothing';
  const text = $('fringe-quality-text');
  if (text) text.textContent = data ? qualityDescription(data, fr.useTrustedOnly).join(' ') : '';
  const btn = $('fringe-coverage-button');
  const pixels = data ? coveragePixels(data, fr.useTrustedOnly) : null;
  if (btn) btn.disabled = !pixels || !data?.reference_image_b64;
  const token = ++generation;
  if (!pixels || !data?.reference_image_b64) return;
  const source = new Image();
  source.onload = () => {
    if (token !== generation || data !== fr.lastResult) return;
    const canvas = document.createElement('canvas');
    canvas.width = source.naturalWidth; canvas.height = source.naturalHeight;
    const ctx=canvas.getContext('2d'); ctx.drawImage(source,0,0);
    const overlay=document.createElement('canvas'); overlay.width=data.grid_cols; overlay.height=data.grid_rows;
    const oc=overlay.getContext('2d'); const image=oc.createImageData(data.grid_cols,data.grid_rows);
    image.data.set(pixels); oc.putImageData(image,0,0);
    ctx.imageSmoothingEnabled=false; ctx.drawImage(overlay,0,0,canvas.width,canvas.height);
    const img=$('fringe-surface-img');
    if (img) {
      img.dataset.coverageSrc=canvas.toDataURL('image/png');
      if (img.dataset.overlay === 'coverage') img.src=img.dataset.coverageSrc;
    }
  };
  source.src=`data:image/png;base64,${data.reference_image_b64}`;
}
