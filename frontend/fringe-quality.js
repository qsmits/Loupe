import {fr, $} from './fringe.js';
import {hybridFallbackNotice} from './fringe-method-comparison.js';

export function boundaryDescription(filter) {
  if (filter?.boundary_rule === 'composite-adaptive') return 'Composite coverage follows local-fit evidence, not a fixed boundary inset.';
  if (Number.isFinite(filter?.boundary_across_px) && Number.isFinite(filter?.boundary_along_px)) {
    return `Directional boundary guard: ${filter.boundary_across_px.toFixed(1)} analysis pixels across / ${filter.boundary_along_px.toFixed(1)} along fringes, following the detected fringe direction.`;
  }
  return Number.isFinite(filter?.boundary_band_px)
    ? `Boundary exclusion: about ${filter.boundary_band_px.toFixed(1)} analysis pixels inward from each aperture or hole edge (conservative square support; diagonal edges can lose more).`
    : '';
}

export function qualityDescription(data, trustedOnly = false) {
  const c = data?.coverage, f = data?.analysis_filter;
  const lines = [];
  if (c?.aperture_pixels > 0) {
    lines.push(`Measurement area: ${(100*c.measured_pixels/c.aperture_pixels).toFixed(1)}% of the detected fringe aperture; ${c.boundary_excluded_pixels.toLocaleString()} boundary pixels excluded.`);
    if (c.requested_pixels > 0) lines.push(`${(100*c.measured_pixels/c.requested_pixels).toFixed(1)}% of the drawn include/exclude area contributes to the full-aperture result.`);
    if (c.outline_source === 'drawn') lines.push('The drawn outline defines the part area; illumination, contrast and continuity checks determine where fringes can be measured. Drawing an area does not make every pixel valid.');
  } else lines.push('Original aperture coverage is unavailable for this result.');
  if (data?.analysis_method === 'composite') {
    lines.push('Experimental composite: layered real-image fits with per-pixel source and qualitative evidence. Open Composite quality for cutoff-dependent coverage and statistics. Quality is not calibrated uncertainty; conflicts are excluded, and shared fringe-order errors can survive.');
  } else if (data?.analysis_method === 'hybrid') {
    const h=data.hybrid_diagnostics;
    lines.push('Experimental hybrid: local quadratic fits where image-based checks pass; current-method fallback elsewhere. The accepted area has an adaptive boundary, not one fixed inset. Fit checks are not calibrated uncertainty bounds.');
    if (h) lines.push(`${h.local_pixels.toLocaleString()} pixels use local fits (including blended transitions); ${h.added_pixels.toLocaleString()} added beyond the baseline; ${h.fallback_pixels.toLocaleString()} retain the baseline estimate. Local-fit sigma: ${h.sigma_across_px.toFixed(1)} px across / ${h.sigma_along_px.toFixed(1)} px along fringes. The smoothing values below describe the fallback estimator.`);
    const fallback=hybridFallbackNotice(h);
    if (fallback) lines.push(fallback);
    if (h?.fit_checks) {
      const checks=h.fit_checks, names={conditioning:'unstable fit',contrast:'low contrast',image_residual:'image does not fit the fringe model',window_disagreement:'fit windows disagree'};
      lines.push(`Local-fit screening: ${checks.passed_pixels.toLocaleString()} of ${checks.aperture_pixels.toLocaleString()} pixels passed (before fringe-continuity filtering). First failed check: ${Object.entries(checks.first_rejection).map(([key,n])=>`${names[key] || key}: ${n.toLocaleString()}`).join('; ')}.`);
    }
    if (h?.merge_checks) {
      const c=h.merge_checks;
      lines.push(`After unwrap/boundary and transition checks: ${c.transition_supported.toLocaleString()} candidates; ${c.insufficient_anchor_pixels.toLocaleString()} lacked enough Current anchors; ${c.anchor_disagreement_pixels.toLocaleString()} disagreed with Current on their anchor region.`);
    }
  } else if (Number.isFinite(f?.boundary_band_px)) {
    lines.push(`${boundaryDescription(f)} ${f.preliminary_rim_px === 0 ? 'No additional fixed-width rim trim is applied.' : 'Earlier aperture trimming is additional.'} This is a precaution, not proof that every excluded pixel is invalid. Real edge roll-off may be excluded from PV/RMS.`);
  }
  if (c?.selected_rejected_pixels > 0) lines.push(`${c.selected_rejected_pixels.toLocaleString()} selected pixels were rejected before boundary trimming by aperture/contrast/continuity checks.`);
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
  refreshEdgeInspection(data);
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


// This separate dialog uses the full analysis frame, not the cropped surface
// coordinates. It has no height cursor or measurement tools.
export function edgeInspectionPixels(info) {
  const rows=info?.grid_rows, cols=info?.grid_cols, n=rows*cols;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows<1 || cols<1 || rows>256 || cols>256 || info.regions?.length!==n) return null;
  const pixels=new Uint8ClampedArray(n*4);
  for (let i=0;i<n;i++) {
    const region=info.regions[i], x=i%cols, y=Math.floor(i/cols);
    const neighbors=[];
    if(x>0)neighbors.push(info.regions[i-1]);
    if(x<cols-1)neighbors.push(info.regions[i+1]);
    if(y>0)neighbors.push(info.regions[i-cols]);
    if(y<rows-1)neighbors.push(info.regions[i+cols]);
    const border=(x===0 || y===0 || x===cols-1 || y===rows-1 ||
      neighbors.some(r=>r!==region));
    // Draw each shared boundary once: teal takes precedence at the
    // measured edge, amber at the boundary/rejected-selection edge.
    const outline=border && !neighbors.some(r=>r>0 && r<region);
    // Interior remains unpainted, so the fringe bending itself is readable.
    const color=region===1 ? [45,212,191,border?230:0]
      : region===2 ? [245,158,11,outline?220:35]
      : region===3 ? [96,165,250,outline?220:35] : [0,0,0,100];
    pixels.set(color,i*4);
  }
  return pixels;
}

export function edgeSelectionLegend(data) {
  if (data.edge_inspection?.regions?.includes(3)) {
    return '<strong style="color:#60a5fa">Blue: selected area rejected before boundary trimming</strong>.';
  }
  if (data.edge_inspection?.has_user_selection === false) {
    return 'Automatic area: no drawn selection, so there is no blue region.';
  }
  if (data.coverage?.selected_rejected_pixels > 0) {
    return 'Selected rejected areas are too small to show in blue at this preview resolution.';
  }
  return 'No selected rejected area to show in blue.';
}
let edgeDialog=null;
function refreshEdgeInspection(data) {
  edgeDialog?.close(); edgeDialog?.remove(); edgeDialog=null;
  const button=$('fringe-edge-inspection-button');
  if (!button) return;
  const info=data?.edge_inspection;
  button.disabled=!info?.image_b64 || !edgeInspectionPixels(info);
  button.title=button.disabled ? 'Analyze the original image again to inspect the full edge coverage.' : 'Compare original fringes with the selected area and measured interior; excluded pixels do not enter PV/RMS.';
  button.onclick=button.disabled ? null : ()=>openEdgeInspection(data);
}
function openEdgeInspection(data) {
  const info=data.edge_inspection, pixels=edgeInspectionPixels(info);
  if (!pixels) return;
  const dialog=document.createElement('dialog'); edgeDialog=dialog;
  dialog.setAttribute('aria-label','Inspect excluded edges');
  dialog.style.cssText='width:min(1050px,92vw);max-height:90vh;box-sizing:border-box;margin:auto;font-size:13px;line-height:1.45;overflow:auto;background:#202124;color:#eee;border:1px solid #555;border-radius:10px;padding:18px';
  dialog.innerHTML=`<h2 style="margin:0 0 10px;font-size:18px">Inspect excluded edges</h2>
    <p>Fringes before edge exclusion, after any analysis resizing/lens correction. This is an inspection image, not a height map. PV/RMS and measurements still use the accepted interior.</p>
    <p data-edge-note></p>
    <p><strong style="color:#2dd4bf">Teal outline: measured interior</strong> · <strong style="color:#f59e0b">Amber band: excluded edges, including around holes</strong>. ${edgeSelectionLegend(data)} Outside areas are dimmed.</p>
    <label><input type="checkbox" checked data-edge-overlay> Show coverage outlines</label>
    <button type="button" data-edge-close style="float:right;padding:4px 12px;border:1px solid #777;border-radius:4px">Close</button>
    <div style="position:relative;width:fit-content;max-width:100%;margin:12px auto">
      <img data-edge-image alt="Original interferogram with measurement and exclusion boundaries" style="display:block;max-width:100%;max-height:60vh;width:auto;height:auto" />
      <canvas data-edge-outlines aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;image-rendering:pixelated"></canvas>
    </div>`;
  dialog.querySelectorAll('p').forEach(p=>{p.style.margin='8px 0';});
  const coverage=data.coverage;
  dialog.querySelector('[data-edge-note]').textContent=[
    coverage?.aperture_pixels ? `${(100*coverage.measured_pixels/coverage.aperture_pixels).toFixed(1)}% of the detected fringe aperture is measured.` : '',
    boundaryDescription(data.analysis_filter),
    data.analysis_filter?.preliminary_rim_px === 0 ? 'No additional fixed-width rim trim.' : '',
    'Real edge roll-off may be excluded. Outlines are approximate at preview resolution.'
  ].filter(Boolean).join(' ');
  const view=dialog.querySelector('[data-edge-image]'), toggle=dialog.querySelector('[data-edge-overlay]');
  // Keep the photo in an <img>: the canvas-to-PNG composite showed a
  // blank photo on the first opening after analysis in Safari.
  // The photo sizes the wrapper; the transparent canvas follows exactly,
  // including non-square images and viewport resizing, without a load race.
  view.src=`data:image/png;base64,${info.image_b64}`;
  const overlay=dialog.querySelector('[data-edge-outlines]');
  overlay.width=info.grid_cols;overlay.height=info.grid_rows;
  const ctx=overlay.getContext('2d'), image=ctx.createImageData(info.grid_cols,info.grid_rows);
  image.data.set(pixels);ctx.putImageData(image,0,0);
  toggle.onchange=()=>{overlay.hidden=!toggle.checked;};
  dialog.querySelector('[data-edge-close]').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{if(edgeDialog===dialog)edgeDialog=null;dialog.remove();});
  document.body.appendChild(dialog);dialog.showModal();
}
