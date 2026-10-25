import {fr,$} from './fringe.js';
import {compositeView,compositeCsv,reconstructionView,QUALITY_LABELS,QUALITY_COLORS,SOURCE_LABELS,conflictReason} from './fringe-composite.js';
import {openCaptureCombine} from './fringe-combine-view.js';
import {surfaceColor} from './fringe-spatial.js';
let dialog,owner,view,photo,raster,zoom=1,panX=0,panY=0,observer;
const fmt=v=>Number.isFinite(v)?`${v.toFixed(2)} nm`:'not measured';
function geometry(canvas){
  const w=canvas.clientWidth,h=canvas.clientHeight,ratio=view.c.surface_width/view.c.surface_height;
  const bw=Math.min(w,h*ratio),bh=bw/ratio;
  return {w,h,bw,bh,x:(w-bw*zoom)/2+panX*bw,y:(h-bh*zoom)/2+panY*bh,dw:bw*zoom,dh:bh*zoom};
}
function rebuild(){
  if(!owner)return;
  const combined=$('fringe-composite-dataset').value==='combined'&&owner.composite_combination;
  view=compositeView(combined?{composite:combined}:owner,Number($('fringe-composite-cutoff').value),
    !!combined || $('fringe-composite-photographic').checked);
  view.c.view_cutoff=view.cutoff;
  const multi=view.c.kind==='multi';
  view.preview=reconstructionView(view,$('fringe-composite-reconstructed').checked);
  $('fringe-composite-reconstructed').disabled=!view.preview.available;
  view.limit=view.preview.limit;
  const photographic=(!multi&&view.c.photographic_pixels)||0;
  $('fringe-composite-photographic').disabled=!photographic;
  const overlaySelect=$('fringe-composite-overlay');
  for(const option of overlaySelect.options)option.disabled=option.value==='recovery'?!photographic:['support','difference'].includes(option.value)&&!multi;
  if(overlaySelect.selectedOptions[0]?.disabled)overlaySelect.value='quality';
  overlaySelect.disabled=!multi&&!photographic;
  const overlay=overlaySelect.value;
  raster=document.createElement('canvas');raster.width=view.cols;raster.height=view.rows;
  const ctx=raster.getContext('2d'),pixels=ctx.createImageData(view.cols,view.rows),quality=$('fringe-composite-heatmap').checked;
  for(let i=0;i<view.included.length;i++){
    if(view.c.conflict_grid[i]){
      if(quality)pixels.data.set((i%view.cols+Math.floor(i/view.cols))%6<3?[255,90,120,235]:[35,35,40,180],i*4);
    }else if(view.preview.reconstructed[i]){
      const hatch=(i%view.cols+Math.floor(i/view.cols))%8<2;
      const color=hatch?[245,245,245]:surfaceColor(view.preview.heights[i],view.limit);
      pixels.data.set([...color,hatch?235:210],i*4);
    }else if(view.included[i]){
      let color=quality?QUALITY_COLORS[view.c.quality_grid[i]]:surfaceColor(view.c.height_grid_nm[i],view.limit);
      if(quality&&overlay==='support')color=view.c.support_grid[i]>1?[56,189,248]:[192,132,252];
      if(quality&&overlay==='recovery')color=view.c.source_grid[i]===5?[45,212,191]:[150,150,165];
      if(quality&&overlay==='difference'){
        const delta=view.c.spread_grid_nm[i];
        color=delta==null?[192,132,252]:[Math.round(245*Math.min(1,delta/view.c.registration.threshold_nm)),190,60];
      }
      pixels.data.set([...color,quality?175:230],i*4);
    }
  }
  ctx.putImageData(pixels,0,0);
  const s=view.stats;
  $('fringe-composite-stats').textContent=`Measured: ${s.coverage_pct.toFixed(1)}% of ${view.c.aperture_label} · ${s.pixels.toLocaleString()} ${multi?'display samples':'analysis pixels'} · Gap PV ${fmt(s.pv_nm)} · RMS ${fmt(s.rms_nm)} · ${view.c.conflict_pixels.toLocaleString()} conflicting ${multi?'samples':'pixels'} excluded`;
  const preview=view.preview, note=$('fringe-composite-reconstructed-note');
  note.hidden=!preview.available;
  note.textContent=preview.available ? (preview.converged
    ? `Reconstructed preview ${$('fringe-composite-reconstructed').checked?'shown':'hidden'} · ${preview.pixels.toLocaleString()} inferred pixels · ${Math.min(100,100*(s.pixels+preview.pixels)/view.c.aperture_pixels).toFixed(1)}% displayed coverage. White hatching = reconstructed, not measured. Excluded from PV/RMS and measurement CSV.`
    : 'Reconstruction did not converge; no inferred pixels shown. Measured result is unchanged.') : '';
  $('fringe-composite-key').textContent=quality?'Blue: stronger agreement · Amber: expanded coverage · Purple: limited corroboration · Stripes: disagreement (excluded). Qualitative evidence, not ±nm uncertainty.':'Air-gap departure: blue lower → red higher; physical direction unverified';
  if(quality&&overlay==='support')$('fringe-composite-key').textContent='Blue: two captures · Purple: one capture only · Stripes: conflict (excluded). Two captures can share errors.';
  if(quality&&overlay==='difference')$('fringe-composite-key').textContent=`Green → amber: 0 → ${view.c.registration.threshold_nm} nm overlap difference · Purple: only one capture, difference unknown · Stripes: conflict. Difference is not uncertainty.`;
  if(quality&&overlay==='recovery')$('fringe-composite-key').textContent='Teal: photographic recovery (limited evidence) · Gray: earlier layers · Stripes: conflict. Recovered pixels have no calibrated ±nm uncertainty.';
  $('fringe-composite-recovery-note').hidden=!photographic;
  $('fringe-composite-recovery-note').textContent=photographic?`${photographic.toLocaleString()} photographic recovery pixels ${view.cutoff<3?'available at + Limited corroboration':view.includePhotographic?'included':'hidden'}. Toggle Photographic recovery to compare with earlier layers; heights and form removal stay fixed.`:'';
  const diagnostics=view.c.diagnostics,registration=view.c.registration;
  $('fringe-composite-audit').textContent=multi?`Registration residual ${registration.rms_px.toFixed(2)} analysis pixels · Held-out overlap difference ${registration.heldout_p90_nm.toFixed(2)} nm (90th percentile) · ${registration.overlap_pixels} alignment samples. Single-support regions require + Expanded coverage. Combined statistics and CSV use the display grid; coverage is limited to the reference aperture.`:
    diagnostics?.order?`Alternate unwrap checked ${diagnostics.order.checked_pixels.toLocaleString()} pixels; ${diagnostics.order.conflicted_pixels.toLocaleString()} pixels in ambiguous islands excluded. Withheld edge prediction: ${diagnostics.withheld_rim.complete?`${diagnostics.withheld_rim.p95_rad.toFixed(4)} rad (95th percentile; admission limit 0.0100 rad)`:'insufficient support'}. Checked continuation added ${diagnostics.continuation.added_pixels.toLocaleString()} pixels, visible at + Limited corroboration.`:'This saved analysis predates the additional order and continuation checks. Analyze again to run them.';
  if(!multi&&diagnostics?.photographic){const p=diagnostics.photographic;$('fringe-composite-audit').textContent+=p.attempted?` Photographic recovery: ${p.raw_passed_pixels.toLocaleString()} passed raw screening, ${p.filtered_passed_pixels.toLocaleString()} survived filtered checks, ${p.cross_window_passed_pixels.toLocaleString()} agreed across window shapes; ${p.added_pixels.toLocaleString()} pixels added after anchoring and order checks.`:' Photographic recovery added no pixels; no eligible unmeasured area or anchors remained.';}
  $('fringe-composite-meta').textContent=`${view.c.wavelength_nm} nm wavelength · ${view.c.form_model} form removal · ${multi?'two registered captures':`one capture, ${view.c.sources.length} estimator layers`}. ${view.c.reference}`;
  if(preview.pixels) $('fringe-composite-key').textContent+=' White hatching: reconstructed air-gap departure, not measured.';
  $('fringe-composite-scale').hidden=quality&&!preview.pixels;
  $('fringe-composite-scale-label').textContent=`−${view.limit.toFixed(2)} nm                              +${view.limit.toFixed(2)} nm`;
  draw();
}
function draw(){
  if(!dialog?.open||!view||!raster)return;
  const canvas=$('fringe-composite-canvas'),g=geometry(canvas),dpr=window.devicePixelRatio||1;
  canvas.width=Math.max(1,Math.round(g.w*dpr));canvas.height=Math.max(1,Math.round(g.h*dpr));
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.fillStyle='#191b20';ctx.fillRect(0,0,g.w,g.h);
  if(photo?.complete&&photo.naturalWidth&&$('fringe-composite-photo').checked){ctx.globalAlpha=.65;ctx.drawImage(photo,g.x,g.y,g.dw,g.dh);ctx.globalAlpha=1;}
  ctx.imageSmoothingEnabled=false;ctx.drawImage(raster,g.x,g.y,g.dw,g.dh);
  $('fringe-composite-fit').textContent=`Fit · ${Math.round(zoom*100)}%`;
}
export function refreshComposite(result=fr.lastResult){
  const button=$('fringe-composite-open');if(button)button.hidden=!result?.composite;
  if(dialog?.open&&owner!==result)dialog.close();
}
export function openComposite(){
  if(!fr.lastResult?.composite)return;
  if(dialog?.open&&owner===fr.lastResult)return;
  if(dialog?.open)dialog.close();
  owner=fr.lastResult;
  if(!dialog){
    dialog=document.createElement('dialog');dialog.id='fringe-composite-dialog';dialog.className='fringe-method-comparison fringe-composite-dialog';
    dialog.setAttribute('aria-labelledby','fringe-composite-title');
    dialog.innerHTML=`<header><h2 id="fringe-composite-title">Composite quality · experimental</h2><button id="fringe-composite-close">Close</button></header>
      <div class="fringe-comparison-controls">
        <label>Result <select id="fringe-composite-dataset"><option value="single">Single capture</option><option value="combined">Combined pair</option></select></label>
        <button id="fringe-composite-combine">Combine captures…</button>
        <label>Include <select id="fringe-composite-cutoff"><option value="1">Stronger agreement only</option><option value="2">+ Expanded coverage</option><option value="3">+ Limited corroboration</option></select></label>
        <label><input id="fringe-composite-photographic" type="checkbox" checked> Photographic recovery</label>
        <label><input id="fringe-composite-reconstructed" type="checkbox"> Reconstructed preview</label>
        <label><input id="fringe-composite-heatmap" type="checkbox" checked> Quality overlay</label>
        <select id="fringe-composite-overlay" aria-label="Evidence overlay"><option value="quality">Fit evidence</option><option value="recovery">Photographic additions</option><option value="support">Capture support</option><option value="difference">Overlap difference</option></select>
        <label><input id="fringe-composite-photo" type="checkbox" checked> Interferogram</label>
        <button id="fringe-composite-fit">Fit</button><button id="fringe-composite-export">Export measured data CSV</button>
      </div>
      <p id="fringe-composite-stats" role="status"></p>
      <p id="fringe-composite-reconstructed-note" role="status" hidden></p>
      <p id="fringe-composite-recovery-note" role="status" hidden></p>
      <canvas id="fringe-composite-canvas" tabindex="0" aria-label="Composite surface and quality; scroll to zoom, drag to pan"></canvas>
      <p id="fringe-composite-key"></p>
      <div id="fringe-composite-scale"><div class="fringe-composite-gradient"></div><div id="fringe-composite-scale-label"></div></div>
      <p id="fringe-composite-readout" role="status">Hover to see height, quality and source. Scroll to zoom; drag to pan.</p>
      <details><summary>Checks and interpretation</summary><p id="fringe-composite-audit"></p><p>Quality describes agreement among fits, not calibrated uncertainty in nanometers. The methods share image errors; even blue regions can be wrong. A second unwrap path checks for inconsistent fringe orders. If paths disagree, the connected island is excluded because neither path is known to be right. Continuation must pass withheld-edge and image-residual checks. Photographic recovery is the final, limited-evidence layer: it allows more image texture only when raw and filtered fits, different window shapes, original anchors and fringe-order checks agree. Heights come from the raw image fit. Neither layer fills outside the aperture, and undetected errors can remain.</p><p>Reconstructed preview is optional and available with Composite quality and Plane removal. It integrates image-derived phase gradients with smoothness where evidence is weak. White hatching always marks inferred pixels; these never enter PV/RMS, measurement CSV, or capture combination. They may hide sharp roll or invent features. Exclude holes, glare and background in Analysis settings. Missing preview data requires another analysis with Prepare reconstructed surface preview enabled.</p><p>Cutoff and photographic recovery controls change this view and CSV. The main result keeps its original selection. Heights share the same analysis-time form removal at every cutoff; later inversion or contact confirmation does not alter this snapshot. Display and CSV are sampled at up to 256 × 256. Single-capture statistics use full analysis resolution; combined statistics use only the displayed samples. Combined captures remove relative offset and tilt, retain the better-supported value, and exclude overlap disagreements above your limit. Single-capture regions have no repeatability estimate. Coverage uses the reference drawn area or detected support, not a verified physical outline.</p><p id="fringe-composite-meta"></p></details>`;
    document.body.appendChild(dialog);
    $('fringe-composite-close').onclick=()=>dialog.close();
    $('fringe-composite-cutoff').onchange=$('fringe-composite-heatmap').onchange=rebuild;
    $('fringe-composite-photographic').onchange=rebuild;
    $('fringe-composite-reconstructed').onchange=rebuild;
    $('fringe-composite-overlay').onchange=$('fringe-composite-dataset').onchange=rebuild;
    $('fringe-composite-combine').onclick=()=>{
      const token=owner;
      openCaptureCombine(owner,combined=>{if(owner!==token||fr.lastResult!==token)return;owner.composite_combination=combined;$('fringe-composite-dataset').options[1].disabled=false;$('fringe-composite-dataset').value='combined';rebuild();});
    };
    $('fringe-composite-photo').onchange=draw;
    $('fringe-composite-fit').onclick=()=>{zoom=1;panX=panY=0;draw();};
    $('fringe-composite-export').onclick=()=>{
      const url=URL.createObjectURL(new Blob([compositeCsv(view)],{type:'text/csv'})),a=document.createElement('a');
      a.href=url;a.download=`fringe-composite-quality-${view.cutoff}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    const canvas=$('fringe-composite-canvas');let drag;
    const position=e=>{const r=canvas.getBoundingClientRect(),g=geometry(canvas);return {g,x:e.clientX-r.left,y:e.clientY-r.top};};
    canvas.onwheel=e=>{e.preventDefault();const {g,x,y}=position(e),nx=(x-g.x)/g.dw,ny=(y-g.y)/g.dh,next=Math.max(1,Math.min(16,zoom*Math.exp(-e.deltaY*.002)));panX+=(nx-.5)*(zoom-next);panY+=(ny-.5)*(zoom-next);zoom=next;draw();};
    canvas.onpointerdown=e=>{if(e.button!==0)return;canvas.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY,px:panX,py:panY};};
    canvas.onpointerup=canvas.onpointercancel=()=>{drag=null;};
    canvas.onpointermove=e=>{
      const {g,x,y}=position(e);if(drag){panX=drag.px+(e.clientX-drag.x)/g.bw;panY=drag.py+(e.clientY-drag.y)/g.bh;draw();return;}
      const nx=(x-g.x)/g.dw,ny=(y-g.y)/g.dh;if(nx<0||nx>=1||ny<0||ny>=1)return;
      const i=Math.floor(ny*view.rows)*view.cols+Math.floor(nx*view.cols),source=view.c.sources.find(s=>s.id===view.c.source_grid[i]);
      if(view.preview.reconstructed[i]){
        $('fringe-composite-readout').textContent=`Reconstructed estimate: ${fmt(view.preview.heights[i])} · NOT measured · excluded from flatness statistics and measurement CSV · uncertainty not calibrated`;
        return;
      }
      const reasons=conflictReason(view.c.reason_grid?.[i]||0),support=view.c.support_grid?.[i];
      $('fringe-composite-readout').textContent=`${view.included[i]?fmt(view.c.height_grid_nm[i]):'Excluded / unmeasured'} · ${QUALITY_LABELS[view.c.quality_grid[i]]}${reasons?' · '+reasons:view.c.conflict_grid[i]?' · Disagreement':''} · ${source?SOURCE_LABELS[source.method]||'Source unavailable':'No source'}${source&&view.c.kind==='multi'?' '+(source.capture_index+1):''} · ${support==null?'single capture':`${support} capture support · overlap difference ${view.c.spread_grid_nm[i]==null?'unknown':fmt(view.c.spread_grid_nm[i])}`}`;
    };
    canvas.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'].includes(e.key))return;e.preventDefault();if(e.key==='ArrowLeft')panX+=.1;if(e.key==='ArrowRight')panX-=.1;if(e.key==='ArrowUp')panY+=.1;if(e.key==='ArrowDown')panY-=.1;if(['+','='].includes(e.key))zoom=Math.min(16,zoom*1.5);if(e.key==='-')zoom=Math.max(1,zoom/1.5);if(e.key==='0'){zoom=1;panX=panY=0;}draw();};
    dialog.addEventListener('close',()=>{if(dialog.open)return;owner=null;view=null;photo=null;raster=null;drag=null;});
    observer=new ResizeObserver(draw);observer.observe(dialog);
  }
  zoom=1;panX=panY=0;
  $('fringe-composite-photographic').checked=true;
  $('fringe-composite-cutoff').value=[1,2,3].includes(owner.composite.view_cutoff)?owner.composite.view_cutoff:2;
  $('fringe-composite-dataset').options[1].disabled=!owner.composite_combination;
  $('fringe-composite-dataset').value=owner.composite_combination?'combined':'single';
  $('fringe-composite-reconstructed').checked=!!owner.composite.reconstruction;
  if(owner.composite.reconstruction&&!owner.composite_combination){
    $('fringe-composite-cutoff').value='3';
    $('fringe-composite-heatmap').checked=false;
  }
  dialog.showModal();rebuild();
  const token=owner;photo=new Image();photo.onload=()=>{if(owner===token)draw();};photo.src='data:image/png;base64,'+owner.reference_image_b64;
}
