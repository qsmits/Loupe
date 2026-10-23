// Fringe calibration owns its image and samples; it never swaps microscopy state.
import { correctedRadialLength, fitRadialK1 } from './math.js';
import { bindImageDropTargets } from './image-drop.js';

export function fitLensSamples(samples, width, height) {
  if (samples.length < 3) return null;
  const k1 = fitRadialK1(samples, width, height);
  const spread = k => {
    const lengths = samples.map(s => correctedRadialLength(s, k, width, height));
    const mean = lengths.reduce((a,b) => a+b, 0)/lengths.length;
    return 100*Math.max(...lengths.map(v => Math.abs(v-mean)))/mean;
  };
  return {k1, before:spread(0), after:spread(k1)};
}

export function calibrationImagePoint(x, y, rect, width, height) {
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const point = {x:(x-rect.left)*width/rect.width, y:(y-rect.top)*height/rect.height};
  return point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height ? point : null;
}

let dialog, image, samples = [], pending = null, fit = null, generation = 0, options, loading = false;
const $ = id => dialog.querySelector(`#fringe-lens-${id}`);

function close() { dialog?.close(); }
function sizeImage() {
  if (!image) return;
  const area = $('viewport');
  const scale = Math.min((area.clientWidth-24)/image.naturalWidth, (area.clientHeight-24)/image.naturalHeight)
    * Number($('zoom').value);
  $('frame').style.width = `${Math.max(1,image.naturalWidth*scale)}px`;
  $('frame').style.height = `${Math.max(1,image.naturalHeight*scale)}px`;
}
function refresh() {
  const w = image?.naturalWidth || 1, h = image?.naturalHeight || 1;
  const svg = $('marks');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const radius = Math.max(w,h)/80;
  svg.innerHTML = samples.map((s,i) => `<g stroke="#ffe15a" fill="#ffe15a" stroke-width="${radius/3}" style="filter:drop-shadow(0 0 1px #111)">
    <line x1="${s.p1.x}" y1="${s.p1.y}" x2="${s.p2.x}" y2="${s.p2.y}"/>
    <circle cx="${s.p1.x}" cy="${s.p1.y}" r="${radius}" fill="none"/>
    <circle cx="${s.p2.x}" cy="${s.p2.y}" r="${radius}" fill="none"/>
    <text x="${s.p1.x+radius*2}" y="${s.p1.y-radius*2}" font-size="${radius*3}" stroke="#111" paint-order="stroke">${i+1}</text></g>`).join('')
    + (pending ? `<circle cx="${pending.x}" cy="${pending.y}" r="${radius}" fill="none" stroke="#ffe15a" stroke-width="${radius/3}"/>` : '');
  $('samples').replaceChildren();
  samples.forEach((s,i) => {
    const row = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = `${i+1}. ${Math.hypot(s.p2.x-s.p1.x,s.p2.y-s.p1.y).toFixed(2)} px`;
    const remove = document.createElement('button'); remove.type='button'; remove.textContent='Remove';
    remove.setAttribute('aria-label',`Remove measurement ${i+1}`);
    remove.onclick=()=>{samples.splice(i,1);pending=null;refresh();};
    row.append(text,remove); $('samples').append(row);
  });
  fit = null;
  try { if (image) fit=fitLensSamples(samples,w,h); }
  catch (error) { $('status').textContent=error.message; }
  $('stats').textContent=fit ? `Length spread: ±${fit.before.toFixed(2)}% before → ±${fit.after.toFixed(2)}% after. k₁ = ${fit.k1.toExponential(3)}.`
    : `${samples.length}/3 minimum measurements. Include the centre and edges.`;
  $('hint').textContent = !image ? 'Open or drop a calibration image to begin.'
    : pending ? 'Click the second endpoint. Undo cancels the first point.' : 'Click two endpoints of an equal-sized feature. Repeat at different distances from the image centre.';
  $('apply').disabled=loading || !fit || !!pending;
  $('undo').disabled=!pending && !samples.length;
  $('clear').disabled=!pending && !samples.length;
}
async function loadImage(file) {
  if (!file?.type.startsWith('image/')) { $('status').textContent='Choose an image file (for example PNG or JPEG).'; return; }
  const token=++generation; loading=true;
  $('status').textContent='Loading calibration image…'; $('apply').disabled=true;
  const url=URL.createObjectURL(file), candidate=new Image();
  try {
    await new Promise((resolve,reject)=>{candidate.onload=resolve;candidate.onerror=()=>reject(new Error('Could not decode this image. Try a PNG or JPEG.'));candidate.src=url;});
    if (token!==generation || !dialog.open || !options?.isCurrent()) return;
    $('image').src=url; await $('image').decode();
    if (token!==generation || !dialog.open || !options?.isCurrent()) return;
    image=candidate; samples=[]; pending=null;
    $('frame').hidden=false; $('empty').hidden=true;
    $('filename').textContent=file.name || 'Camera calibration image';
    $('zoom').value='1'; $('status').textContent='Image ready. Previous calibration measurements cleared.';
    sizeImage(); refresh();
  } catch (error) { if (token===generation && dialog.open) { $('status').textContent=error.message; refresh(); } }
  finally { URL.revokeObjectURL(url); if(token===generation){loading=false;if(dialog.open)refresh();} }
}
function build() {
  dialog=document.createElement('dialog'); dialog.id='fringe-lens-dialog'; dialog.className='fringe-lens-dialog';
  dialog.setAttribute('aria-labelledby','fringe-lens-title');
  dialog.innerHTML=`<header><h2 id="fringe-lens-title">Fringe lens calibration</h2><button id="fringe-lens-cancel" type="button">Cancel</button></header>
    <p>Use an uncorrected photo of a flat grid or repeated equal-sized features, taken with the same lens, zoom and framing as your interferograms. Keep the target parallel to the camera.</p>
    <div class="fringe-lens-tools"><button id="fringe-lens-open" type="button">Open calibration image…</button><button id="fringe-lens-camera" type="button">Capture camera</button>
      <input id="fringe-lens-file" type="file" accept="image/*" hidden>
      <label>Zoom <input id="fringe-lens-zoom" type="range" min="1" max="6" step="0.25" value="1"></label>
      <button id="fringe-lens-undo" type="button">Undo</button><button id="fringe-lens-clear" type="button">Clear measurements</button></div>
    <p id="fringe-lens-filename"></p><p id="fringe-lens-hint"></p>
    <div class="fringe-lens-body"><div id="fringe-lens-viewport"><p id="fringe-lens-empty">Drop a calibration image here, or use Open calibration image.</p>
      <div id="fringe-lens-frame" hidden><img id="fringe-lens-image" alt="Lens calibration target" draggable="false"><svg id="fringe-lens-marks" aria-hidden="true"></svg></div></div>
      <aside><h3>Measurements</h3><ol id="fringe-lens-samples"></ol><p id="fringe-lens-stats"></p><p>Measure the same physical length at 3–8 positions. A lower spread shows agreement between these samples, not independently verified accuracy.</p></aside></div>
    <p id="fringe-lens-status" role="status"></p><footer><span>The calibration image stays in this dialog. Apply updates the fringe lens setting; then analyze your interferogram again.</span><button id="fringe-lens-apply" type="button" disabled>Use calibration</button></footer>`;
  document.body.appendChild(dialog);
  $('open').onclick=()=>$('file').click();
  $('file').onchange=e=>{const file=e.target.files?.[0];e.target.value='';if(file)void loadImage(file);};
  $('cancel').onclick=close;
  // Keep shortcuts from editing the analysis underneath this modal.
  dialog.addEventListener('keydown',e=>e.stopPropagation());
  dialog.addEventListener('close',()=>{generation++;loading=false;image=null;samples=[];pending=null;fit=null;options=null;$('image').removeAttribute('src');});
  document.addEventListener('mode-switched',()=>{if(dialog.open)close();});
  $('zoom').oninput=sizeImage;
  new ResizeObserver(sizeImage).observe($('viewport'));
  $('undo').onclick=()=>{if(pending)pending=null;else samples.pop();refresh();};
  $('clear').onclick=()=>{samples=[];pending=null;refresh();};
  $('frame').onclick=e=>{
    if(!image || loading)return;
    const p=calibrationImagePoint(e.clientX,e.clientY,$('image').getBoundingClientRect(),image.naturalWidth,image.naturalHeight);
    if(!p)return;
    if(!pending)pending=p;
    else if(Math.hypot(p.x-pending.x,p.y-pending.y)>5){samples.push({p1:pending,p2:p});pending=null;}
    refresh();
  };
  $('apply').onclick=()=>{if(loading||!fit||pending||!options?.isCurrent())return;const callback=options.onConfirm,k1=fit.k1;close();callback(k1);};
  $('camera').onclick=async()=>{
    const current=options,token=++generation; loading=true;refresh(); $('camera').disabled=true;$('status').textContent='Capturing calibration image…';
    try {const file=await current.captureImage();if(token===generation&&dialog.open&&options===current)await loadImage(file);}
    catch(error){if(token===generation&&dialog.open)$('status').textContent=error.message;}
    finally{if(options===current){$('camera').disabled=false;if(token===generation){loading=false;refresh();}}}
  };
  bindImageDropTargets([dialog],file=>void loadImage(file),()=>{$('status').textContent='Choose an image file (for example PNG or JPEG).';});
}
export function openFringeLensCal({onConfirm,isCurrent=()=>true,captureImage=null}) {
  if(!dialog)build();
  options={onConfirm,isCurrent,captureImage};generation++;loading=false;image=null;samples=[];pending=null;
  $('frame').hidden=true;$('empty').hidden=false;$('filename').textContent='';$('status').textContent='';
  $('camera').hidden=!captureImage;$('camera').disabled=false;$('zoom').value='1';
  refresh();dialog.showModal();
}
