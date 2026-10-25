import {fr,$} from './fringe.js';
import {compareMethodGrids,comparisonCsv,hybridFallbackNotice} from './fringe-method-comparison.js';
import {surfaceColor} from './fringe-spatial.js';
let dialog,owner,grid,photo,rasters=[],zoom=1,panX=0,panY=0,hover=null;
const fmt=v=>Number.isFinite(v)?`${v.toFixed(2)} nm`:'not measured';
function buildRasters(){
  grid=compareMethodGrids(owner.method_comparison,$('fringe-compare-align').checked);
  rasters=['current','hybrid','difference'].map((key,index)=>{
    const canvas=document.createElement('canvas');canvas.width=grid.cols;canvas.height=grid.rows;
    const ctx=canvas.getContext('2d'),pixels=ctx.createImageData(grid.cols,grid.rows);
    for(let i=0;i<grid.coverage.length;i++){
      const v=grid[key][i];if(!Number.isFinite(v))continue;
      let color=surfaceColor(v,index===2?grid.deltaLimit:grid.surfaceLimit);
      if(index===1&&$('fringe-compare-extra').checked&&grid.coverage[i]===2)color=[45,212,191];
      if(index===0&&$('fringe-compare-extra').checked&&grid.coverage[i]===1)color=[232,121,249];
      pixels.data.set([...color,255],i*4);
    }
    ctx.putImageData(pixels,0,0);return canvas;
  });
  $('fringe-compare-stats').textContent=`Air-gap departure (direction unverified). Shared: ${grid.shared.toLocaleString()} · Extra hybrid: ${grid.added.toLocaleString()} · Current only: ${grid.removed.toLocaleString()} grid cells. Shared-area Δ RMS: ${fmt(grid.rms)} · max |Δ|: ${fmt(grid.max)}.`;
  const notice=hybridFallbackNotice(owner.method_comparison.hybrid.hybrid_diagnostics || owner.hybrid_diagnostics);
  $('fringe-compare-fallback').textContent=notice;
  $('fringe-compare-fallback').hidden=!notice;
  $('fringe-compare-alignment').textContent=grid.plane?'Hybrid height offset and tilt aligned to Current on the shared area; curvature is retained.':$('fringe-compare-align').checked?'Too little shared area to align: showing original heights.':'Original heights, including differences from fitting each method’s own measurement area.';
  $('fringe-compare-surface-scale').textContent=`Surface scale: blue −${grid.surfaceLimit.toFixed(2)} → red +${grid.surfaceLimit.toFixed(2)} nm (both methods)`;
  $('fringe-compare-delta-scale').textContent=`Difference scale: blue −${grid.deltaLimit.toFixed(2)} → red +${grid.deltaLimit.toFixed(2)} nm`;
  $('fringe-compare-coverage-key').hidden=!$('fringe-compare-extra').checked;
  draw();
}
function geometry(canvas){
  const w=canvas.clientWidth,h=canvas.clientHeight,ratio=owner.method_comparison.current.surface_width/owner.method_comparison.current.surface_height;
  const bw=Math.min(w,h*ratio),bh=bw/ratio;
  return {w,h,bw,bh,x:(w-bw*zoom)/2+panX*bw,y:(h-bh*zoom)/2+panY*bh,dw:bw*zoom,dh:bh*zoom};
}
function draw(){
  if(!dialog?.open||!grid)return;
  $('fringe-compare-fit').textContent=`Fit views · ${Math.round(zoom*100)}%`;
  dialog.querySelectorAll('canvas[data-view]').forEach((canvas,index)=>{
    const g=geometry(canvas),dpr=window.devicePixelRatio||1;
    canvas.width=Math.max(1,Math.round(g.w*dpr));canvas.height=Math.max(1,Math.round(g.h*dpr));
    const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.fillStyle='#191b20';ctx.fillRect(0,0,g.w,g.h);
    if(photo?.complete&&photo.naturalWidth&&$('fringe-compare-photo').checked){ctx.globalAlpha=.65;ctx.drawImage(photo,g.x,g.y,g.dw,g.dh);ctx.globalAlpha=1;}
    ctx.imageSmoothingEnabled=false;ctx.globalAlpha=$('fringe-compare-photo').checked ? .8 : 1;ctx.drawImage(rasters[index],g.x,g.y,g.dw,g.dh);ctx.globalAlpha=1;
    if(hover){const x=g.x+hover.x*g.dw,y=g.y+hover.y*g.dh;ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x-9,y);ctx.lineTo(x+9,y);ctx.moveTo(x,y-9);ctx.lineTo(x,y+9);ctx.stroke();}
  });
}
export function refreshMethodComparison(result=fr.lastResult){
  const button=$('fringe-method-compare-open');
  if(button){button.hidden=!result;button.disabled=!result?.method_comparison&&!fr.droppedImageB64;button.textContent=result?.method_comparison?'Compare Current / Hybrid…':'Compare methods…';}
  if(dialog?.open&&owner!==result)dialog.close();
}
export function openMethodComparison(){
  if(!fr.lastResult?.method_comparison){
    if(fr.droppedImageB64){
      // Remember the comparison choice when setup is reopened later as well.
      if(fr.analysisMethod==='composite')fr.analysisMethod='current';
      document.dispatchEvent(new CustomEvent('fringe:setup'));
      const method=$('fringe-analysis-method');
      if(method?.value==='composite'){method.value='current';method.onchange?.();}
      if($('fringe-compare-both'))$('fringe-compare-both').checked=true;
    }
    return;
  }
  owner=fr.lastResult;
  if(!dialog){
    dialog=document.createElement('dialog');dialog.id='fringe-method-comparison';dialog.className='fringe-method-comparison';
    dialog.setAttribute('aria-labelledby','fringe-compare-title');
    dialog.innerHTML=`<header><h2 id="fringe-compare-title">Current / Hybrid comparison</h2><button id="fringe-compare-close">Close</button></header>
      <div class="fringe-comparison-controls"><label><input id="fringe-compare-extra" type="checkbox" checked/> Highlight extra coverage</label><label><input id="fringe-compare-photo" type="checkbox" checked/> Interferogram backdrop</label><label><input id="fringe-compare-align" type="checkbox" checked/> Align offset and tilt</label><button id="fringe-compare-out" aria-label="Zoom all views out">−</button><button id="fringe-compare-in" aria-label="Zoom all views in">+</button><button id="fringe-compare-fit">Fit views</button><button id="fringe-compare-export">Export comparison CSV</button></div>
      <p id="fringe-compare-stats" role="status"></p>
      <p id="fringe-compare-fallback" role="status" hidden></p>
      <div class="fringe-comparison-panes">${['Current','Hybrid · experimental','Height difference · Hybrid − Current'].map((title,i)=>`<section><h3>${title}</h3><canvas tabindex="0" data-view="${i}" aria-label="${title}; linked pan and zoom"></canvas></section>`).join('')}</div>
      <div class="fringe-comparison-legends"><span id="fringe-compare-surface-scale"></span><span id="fringe-compare-coverage-key"><b style="color:#2dd4bf">Teal: extra hybrid</b> · <b style="color:#e879f9">Pink: current only</b></span><span id="fringe-compare-delta-scale"></span></div>
      <p id="fringe-compare-readout" role="status">Hover to compare the same location. Scroll to zoom; drag to pan all three views.</p>
      <details><summary id="fringe-compare-details-title">Comparison settings and interpretation</summary><p id="fringe-compare-meta"></p><p id="fringe-compare-alignment"></p><ul id="fringe-compare-warnings"></ul><p>Snapshots from the paired analysis, before any later inversion, surface-direction check or form changes. Heights are air-gap departures; the physical direction is unverified. Differences exist only where both methods measured. Teal coverage has no Current height to compare against. Counts and CSV use the display grid (up to 256 × 256), not full-resolution pixels. Extra coverage and agreement do not prove accuracy.</p></details>`;
    document.body.appendChild(dialog);
    $('fringe-compare-close').onclick=()=>dialog.close();
    for(const id of ['fringe-compare-extra','fringe-compare-align'])$(id).onchange=buildRasters;
    $('fringe-compare-photo').onchange=draw;
    $('fringe-compare-in').onclick=()=>{zoom=Math.min(16,zoom*1.5);draw();};
    $('fringe-compare-out').onclick=()=>{zoom=Math.max(1,zoom/1.5);draw();};
    $('fringe-compare-fit').onclick=()=>{zoom=1;panX=panY=0;draw();};
    $('fringe-compare-export').onclick=()=>{
      const blob=new Blob([`# ${$('fringe-compare-meta').textContent}\n# ${$('fringe-compare-alignment').textContent}\n`+comparisonCsv(grid)],{type:'text/csv'});
      const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='fringe-current-hybrid-comparison.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    dialog.querySelectorAll('canvas[data-view]').forEach(canvas=>{
      let drag=null;
      const position=e=>{const r=canvas.getBoundingClientRect(),g=geometry(canvas);return {g,x:e.clientX-r.left,y:e.clientY-r.top};};
      canvas.onkeydown=e=>{
        if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'].includes(e.key))e.preventDefault();
        if(e.key==='ArrowLeft')panX+=.1;if(e.key==='ArrowRight')panX-=.1;if(e.key==='ArrowUp')panY+=.1;if(e.key==='ArrowDown')panY-=.1;
        if(e.key==='+'||e.key==='=')zoom=Math.min(16,zoom*1.5);if(e.key==='-')zoom=Math.max(1,zoom/1.5);if(e.key==='0'){zoom=1;panX=panY=0;}draw();
      };
      canvas.onwheel=e=>{e.preventDefault();const {g,x,y}=position(e),nx=(x-g.x)/g.dw,ny=(y-g.y)/g.dh,next=Math.max(1,Math.min(16,zoom*Math.exp(-e.deltaY*.002)));panX+=(nx-.5)*(zoom-next);panY+=(ny-.5)*(zoom-next);zoom=next;draw();};
      canvas.onpointerdown=e=>{if(e.button!==0)return;canvas.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY,px:panX,py:panY};};
      canvas.onpointerup=canvas.onpointercancel=()=>{drag=null;};
      canvas.onpointermove=e=>{
        const {g,x,y}=position(e);
        if(drag){panX=drag.px+(e.clientX-drag.x)/g.bw;panY=drag.py+(e.clientY-drag.y)/g.bh;draw();return;}
        const nx=(x-g.x)/g.dw,ny=(y-g.y)/g.dh;
        hover=nx>=0&&nx<1&&ny>=0&&ny<1?{x:nx,y:ny}:null;
        if(hover){const i=Math.floor(ny*grid.rows)*grid.cols+Math.floor(nx*grid.cols);$('fringe-compare-readout').textContent=`Current: ${fmt(grid.current[i])} · Hybrid: ${fmt(grid.hybrid[i])} · Δ: ${fmt(grid.difference[i])}`;}
        draw();
      };
      canvas.onpointerleave=()=>{hover=null;draw();};
    });
    new ResizeObserver(draw).observe(dialog);
    dialog.addEventListener('close',()=>{photo=null;rasters=[];grid=null;owner=null;});
  }
  zoom=1;panX=panY=0;hover=null;
  const p=owner.method_comparison,c=p.current;
  $('fringe-compare-meta').textContent=`Paired run: ${p.created_at} · ${c.execution_engine||'server'} · ${c.image_width} × ${c.image_height} analysis image · ${c.wavelength_nm} nm wavelength · ${c.form_model} removal · Zernike terms ${(c.subtracted_terms||[]).join(', ')||'none'} · identical source, mask and settings.`;
  const warnings=$('fringe-compare-warnings');warnings.replaceChildren();
  for(const [name,r] of [['Current',p.current],['Hybrid',p.hybrid]])for(const warning of r.warnings||[]){const li=document.createElement('li');li.textContent=`${name}: ${warning}`;warnings.appendChild(li);}
  $('fringe-compare-details-title').textContent=`Comparison settings and interpretation${warnings.children.length?` · ⚠ ${warnings.children.length} warnings`:''}`;
  dialog.showModal();buildRasters();
  photo=new Image();photo.onload=draw;photo.src='data:image/png;base64,'+owner.reference_image_b64;
}
