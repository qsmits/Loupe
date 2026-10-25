import {fringeFetch} from './fringe-compute.js';
import {fr} from './fringe.js';
import {state} from './state.js';
import {referenceMarks} from './fringe-reference.js';
import {combineCaptures} from './fringe-multicapture.js';

export async function openCaptureCombine(owner,onCombined){
  const epoch=state._epoch;
  const dialog=document.createElement('dialog');dialog.className='fringe-method-comparison fringe-combine-dialog';
  dialog.setAttribute('aria-label','Combine two interferograms');
  dialog.innerHTML=`<header><h2>Combine two captures · experimental</h2><button data-close>Cancel</button></header>
    <p>Use two Composite quality analyses of the same side of the same part, both with Plane removal. Match three widely spaced physical landmarks (not fringe peaks). Only rotation, scale and translation are allowed; changing camera perspective may prevent alignment.</p>
    <label>Second capture <select data-capture><option value="">Loading session captures…</option></select></label>
    <div class="fringe-comparison-panes"><section><h3>Reference · current result</h3><canvas data-first tabindex="0" aria-label="Reference landmarks"></canvas><button data-undo-first>Undo reference point</button></section>
      <section><h3>Second capture</h3><canvas data-second tabindex="0" aria-label="Second capture landmarks"></canvas><button data-undo-second>Undo second point</button></section></div>
    <p>Click A, B, C in each image. Drag a mark to adjust; scroll to zoom, drag empty space to pan after placing three marks. Press 0 to fit.</p>
    <div class="fringe-comparison-controls"><label>Analysis-time gap direction <select data-sign><option value="">Choose…</option><option value="1">Same height direction</option><option value="-1">Opposite height direction</option></select></label>
      <label>Overlap disagreement limit <input data-limit type="number" min="0.01" max="1000" value="20" step="1"> nm</label><button data-combine disabled>Check and combine</button></div>
    <p>This compares the original analysis-time gap maps, before later inversion or contact confirmation. Confirm their relative height direction from your physical setup. The limit rejects inconsistent overlap; it is not a measurement uncertainty or accuracy guarantee. Offset and tilt are aligned; curvature is preserved. Single-capture regions remain less corroborated.</p>
    <p data-status role="status">Loading…</p>`;
  document.body.appendChild(dialog);dialog.showModal();
  const el=s=>dialog.querySelector(s),status=el('[data-status]');
  let incoming=null,generation=0,points=[[],[]],images=[null,null],zooms=[1,1],pans=[[0,0],[0,0]];
  const live=()=>dialog.open&&state._epoch===epoch&&fr.lastResult===owner;
  const canvases=[el('[data-first]'),el('[data-second]')];
  function geom(k){const canvas=canvases[k],w=canvas.clientWidth,h=canvas.clientHeight,img=images[k],ratio=img?.naturalWidth/img?.naturalHeight||1;
    const bw=Math.min(w,h*ratio),bh=bw/ratio;return {w,h,bw,bh,dw:bw*zooms[k],dh:bh*zooms[k],x:(w-bw*zooms[k])/2+pans[k][0]*bw,y:(h-bh*zooms[k])/2+pans[k][1]*bh};}
  function draw(k){const canvas=canvases[k],g=geom(k),dpr=window.devicePixelRatio||1;
    canvas.width=Math.max(1,Math.round(g.w*dpr));canvas.height=Math.max(1,Math.round(g.h*dpr));const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.fillStyle='#191b20';ctx.fillRect(0,0,g.w,g.h);
    if(images[k]?.naturalWidth)ctx.drawImage(images[k],g.x,g.y,g.dw,g.dh);
    points[k].forEach((p,j)=>{const x=g.x+p.x*g.dw,y=g.y+p.y*g.dh;ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,8,0,2*Math.PI);ctx.stroke();ctx.fillStyle='#000';ctx.fillRect(x+8,y-21,18,18);ctx.fillStyle='#fff';ctx.font='bold 14px sans-serif';ctx.fillText('ABC'[j],x+12,y-7);});
    el('[data-combine]').disabled=!incoming||points.some(p=>p.length!==3)||!el('[data-sign]').value;
  }
  function loadImage(k,result){const image=new Image();images[k]=image;zooms[k]=1;pans[k]=[0,0];image.onload=()=>{if(live()&&images[k]===image)draw(k);};image.src='data:image/png;base64,'+result.reference_image_b64;draw(k);}
  canvases.forEach((canvas,k)=>{
    let drag;
    const pos=e=>{const rect=canvas.getBoundingClientRect(),g=geom(k);return {g,x:e.clientX-rect.left,y:e.clientY-rect.top};};
    canvas.onpointerdown=e=>{if(e.button!==0||!images[k]?.naturalWidth)return;const {g,x,y}=pos(e);const hit=points[k].findIndex(p=>Math.hypot(g.x+p.x*g.dw-x,g.y+p.y*g.dh-y)<14);
      if(hit>=0)drag={point:hit};else if(points[k].length<3){const nx=(x-g.x)/g.dw,ny=(y-g.y)/g.dh;if(nx<0||nx>1||ny<0||ny>1)return;points[k].push({x:nx,y:ny});drag={point:points[k].length-1};draw(k);}
      else drag={x:e.clientX,y:e.clientY,pan:[...pans[k]]};canvas.setPointerCapture(e.pointerId);};
    canvas.onpointermove=e=>{if(!drag)return;const {g,x,y}=pos(e);if(drag.point!=null)points[k][drag.point]={x:Math.max(0,Math.min(1,(x-g.x)/g.dw)),y:Math.max(0,Math.min(1,(y-g.y)/g.dh))};else pans[k]=[drag.pan[0]+(e.clientX-drag.x)/g.bw,drag.pan[1]+(e.clientY-drag.y)/g.bh];draw(k);};
    canvas.onpointerup=canvas.onpointercancel=()=>drag=null;
    canvas.onwheel=e=>{e.preventDefault();const {g,x,y}=pos(e),nx=(x-g.x)/g.dw,ny=(y-g.y)/g.dh,next=Math.max(1,Math.min(16,zooms[k]*Math.exp(-e.deltaY*.002)));pans[k][0]+=(nx-.5)*(zooms[k]-next);pans[k][1]+=(ny-.5)*(zooms[k]-next);zooms[k]=next;draw(k);};
    canvas.onkeydown=e=>{if(e.key==='0'){zooms[k]=1;pans[k]=[0,0];draw(k);}};
    el(k?'[data-undo-second]':'[data-undo-first]').onclick=()=>{points[k].pop();draw(k);};
  });
  const resize=new ResizeObserver(()=>{draw(0);draw(1);});canvases.forEach(c=>resize.observe(c));
  const stale=()=>{if(!live())dialog.close();};window.addEventListener('workspace-changed',stale);
  dialog.addEventListener('close',()=>{generation++;resize.disconnect();window.removeEventListener('workspace-changed',stale);dialog.remove();},{once:true});
  el('[data-close]').onclick=()=>dialog.close();
  el('[data-sign]').onchange=()=>draw(0);
  el('[data-combine]').onclick=()=>{if(!live()){dialog.close();return;}try{
    const combined=combineCaptures(owner,incoming,{referencePoints:points[0],incomingPoints:points[1],sign:Number(el('[data-sign]').value),thresholdNm:Number(el('[data-limit]').value)});
    onCombined(combined);dialog.close();
  }catch(error){status.textContent=error.message;}};
  const refMarks=referenceMarks(owner);points[0]=refMarks.slice(0,3).map(({x,y})=>({x,y}));loadImage(0,owner);
  el('[data-capture]').onchange=async()=>{
    const token=++generation,id=el('[data-capture]').value;incoming=null;points[1]=[];images[1]=null;draw(1);el('[data-sign]').value='';
    if(!id){status.textContent='Choose another capture.';return;}
    status.textContent='Loading capture…';
    try{const response=await fringeFetch('/fringe/session/capture/'+encodeURIComponent(id));const result=await response.json();
      if(!live()||token!==generation)return;if(!response.ok)throw new Error(result.detail||'Cannot load capture.');
      if(!result.composite||!result.reference_image_b64)throw new Error('This capture has no composite map or reference image.');
      incoming=result;const marks=referenceMarks(result);const matched=refMarks.slice(0,3).map(p=>marks.find(q=>q.label===p.label));
      if(matched.length===3&&matched.every(Boolean))points[1]=matched.map(({x,y})=>({x,y}));
      loadImage(1,result);status.textContent='Place or check matching A, B, C marks, then confirm the relative height direction.';
    }catch(error){if(live()&&token===generation)status.textContent=error.message;}
  };
  try{const response=await fringeFetch('/fringe/session/captures');const data=await response.json();if(!live())return;
    if(!response.ok)throw new Error(data.detail||'Cannot load captures.');
    const select=el('[data-capture]');select.replaceChildren(new Option('Choose a capture…',''));
    for(const capture of data.captures||[])if(capture.id!==owner.id&&capture.analysis_method==='composite')select.appendChild(new Option(`${capture.captured_at||'Capture'} · ${capture.id.slice(0,8)}`,capture.id));
    status.textContent=select.options.length>1?'Choose a second capture from this session.':'No other Composite quality captures in this session. Close this dialog, analyze another interferogram with Composite quality and Plane, then reopen Combine captures. Session captures are temporary.';
  }catch(error){if(live())status.textContent=error.message;}
}
