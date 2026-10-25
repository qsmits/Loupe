// Lateral dimensions are calibrated on this result's aligned image, independently
// of the illumination wavelength (which sets vertical height). No global reuse.
import { fr, $ } from './fringe.js';

// ColorBrewer RdBu reversed, also used by the backend's matplotlib renderer.
export const SURFACE_COLORS = [[5,48,97],[33,102,172],[67,147,195],[146,197,222],
  [209,229,240],[247,247,247],[253,219,199],[244,165,130],[214,96,77],[178,24,43],[103,0,31]];
export function surfaceColor(value, limit) {
  const t = Math.max(0, Math.min(10, (value / limit + 1) * 5));
  const i = Math.min(9, Math.floor(t)), fraction = t - i;
  return SURFACE_COLORS[i].map((v,c) => Math.round(v + fraction * (SURFACE_COLORS[i+1][c] - v)));
}
export function surfaceOverlayPixels(result) {
  const heights = result.display_height_grid_nm || result.height_grid;
  const count = result.grid_rows * result.grid_cols, limit = Number(result.surface_color_limit_nm);
  if (!(limit > 0) || !Number.isFinite(limit) || heights?.length !== count || result.mask_grid?.length !== count) return null;
  const pixels = new Uint8ClampedArray(count * 4);
  for (let i=0;i<count;i++) {
    if (!result.mask_grid[i] || !Number.isFinite(heights[i])) continue;
    pixels.set([...surfaceColor(heights[i], limit), 255], i*4);
  }
  return pixels;
}
function validPoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x>=0 && p.x<=1 && p.y>=0 && p.y<=1;
}
export function imageDistancePixels(result, a, b) {
  const w=Number(result?.surface_width), h=Number(result?.surface_height);
  if (!(w>0 && h>0) || !Number.isFinite(w+h) || !validPoint(a) || !validPoint(b)) return null;
  return Math.hypot((a.x-b.x)*w, (a.y-b.y)*h);
}
export function makeImageCalibration(result, a, b, lengthMm) {
  const pixels=imageDistancePixels(result,a,b), mm=Number(lengthMm);
  if (!(pixels>=2) || !(mm>0) || !Number.isFinite(mm)) return null;
  return {mm_per_analysis_pixel:mm/pixels, surface_width:result.surface_width,
    surface_height:result.surface_height, points:[{...a},{...b}], length_mm:mm,
    recorded_at:new Date().toISOString()};
}
export function imageDistanceMm(result, a, b) {
  const cal=result?.lateral_calibration, pixels=imageDistancePixels(result,a,b);
  if (pixels===null || !cal || !(cal.mm_per_analysis_pixel>0) || !Number.isFinite(cal.mm_per_analysis_pixel)
      || cal.surface_width!==result.surface_width || cal.surface_height!==result.surface_height) return null;
  return pixels*cal.mm_per_analysis_pixel;
}
function lengthLabel(value) { return value===null ? 'Set image scale first' : `${Number(value.toPrecision(5))} mm`; }

export function distanceSvg(points, width, height, label='') {
  if (!points.length) return '';
  const [a,b]=points.map(p=>({x:p.x*width,y:p.y*height}));
  let svg=points.map(p=>`<circle cx="${p.x*width}" cy="${p.y*height}" r="5" fill="none" stroke="#ffe15a" stroke-width="2"/>`).join('');
  if (b) svg+=`<path d="M${a.x},${a.y} L${b.x},${b.y}" fill="none" stroke="#ffe15a" stroke-width="2"/>
    <text x="${(a.x+b.x)/2}" y="${Math.max(16,(a.y+b.y)/2-10)}" text-anchor="middle" fill="#ffe15a" stroke="#111" stroke-width="3" paint-order="stroke" font-size="13">${label}</text>`;
  return svg;
}
export function handleDistanceClick(coords) {
  const points=fr.measurePoints;
  if (points.length>=2) points.length=0;
  points.push({x:coords.nx,y:coords.ny});
  drawDistance();
}
export function drawDistance() {
  const svg=$('fringe-measure-svg'), img=$('fringe-surface-img'), points=fr.measurePoints;
  if (!svg || !img || fr.measureMode!=='distance') return;
  const label=points.length===2 ? lengthLabel(imageDistanceMm(fr.lastResult,...points)) : points.length ? 'Click the second point' : 'Click the first point';
  $('fringe-measure-readout').textContent=label;
  svg.setAttribute('viewBox',`0 0 ${img.clientWidth} ${img.clientHeight}`);
  svg.innerHTML=distanceSvg(points,img.clientWidth,img.clientHeight,points.length===2?label:'');
}

let scaleDialog=null, scaleOwner=null, scalePoints=[], displayedResult=null;
function drawScale() {
  const img=$('fringe-scale-image'), svg=$('fringe-scale-svg');
  if (!img || !svg) return;
  svg.setAttribute('viewBox',`0 0 ${img.clientWidth || 1} ${img.clientHeight || 1}`);
  svg.innerHTML=distanceSvg(scalePoints,img.clientWidth,img.clientHeight);
  const cal=scalePoints.length===2 && makeImageCalibration(scaleOwner,...scalePoints,$('fringe-scale-mm').value);
  $('fringe-scale-save').disabled=!cal;
  $('fringe-scale-status').textContent=scalePoints.length<2 ? `Click ${scalePoints.length?'the second':'the first'} end of a known length on the photograph.`
    : cal ? `Selected span: ${imageDistancePixels(scaleOwner,...scalePoints).toFixed(1)} analysis pixels. Ready to save.`
      : 'Enter a positive length in mm; choose points at least 2 analysis pixels apart.';
}
function fitScaleImage() {
  const img=$('fringe-scale-image');
  if (!scaleDialog?.open || !img?.naturalWidth) return;
  img.style.width=`${Math.min(scaleDialog.clientWidth-40, window.innerHeight*.5*img.naturalWidth/img.naturalHeight)}px`;
  drawScale();
}
function openScale() {
  if (!fr.lastResult?.reference_image_b64) return;
  if (!scaleDialog) {
    scaleDialog=document.createElement('dialog');
    scaleDialog.id='fringe-scale-dialog';
    scaleDialog.className='fringe-scale-dialog';
    scaleDialog.setAttribute('aria-labelledby','fringe-scale-title');
    scaleDialog.innerHTML=`<h2 id="fringe-scale-title">Set image scale</h2>
      <p>Click the two ends of a known length on the interferogram, then enter its size. Use a length in the same plane as the part.</p>
      <div style="position:relative;width:fit-content;max-width:100%;margin:auto;cursor:crosshair">
        <img id="fringe-scale-image" alt="Interferogram for size calibration" draggable="false" style="display:block;width:600px;max-width:100%;height:auto"/>
        <svg id="fringe-scale-svg" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"></svg>
      </div>
      <p id="fringe-scale-status" role="status"></p>
      <label>Known length (mm) <input id="fringe-scale-mm" type="number" min="0" step="any" inputmode="decimal" style="width:110px"/></label>
      <p>This calibrates distances in this image only. It does not change height or flatness. Perspective can distort distances; use a straight-on photograph. A new analysis needs a new scale.</p>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button id="fringe-scale-clear" type="button">Clear scale</button><button id="fringe-scale-reset" type="button">Choose points again</button>
        <button id="fringe-scale-cancel" type="button">Cancel</button><button id="fringe-scale-save" type="button" disabled>Save scale</button>
      </div>`;
    document.body.appendChild(scaleDialog);
    $('fringe-scale-image').onload=fitScaleImage;
    $('fringe-scale-image').onclick=e=>{
      if (scaleOwner!==fr.lastResult) { scaleDialog.close(); return; }
      const rect=e.target.getBoundingClientRect();
      if (scalePoints.length===2) scalePoints=[];
      scalePoints.push({x:Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height))});
      drawScale();
    };
    $('fringe-scale-mm').oninput=drawScale;
    $('fringe-scale-reset').onclick=()=>{scalePoints=[];drawScale();};
    $('fringe-scale-cancel').onclick=()=>scaleDialog.close();
    $('fringe-scale-clear').onclick=()=>{
      if (scaleOwner===fr.lastResult) delete scaleOwner.lateral_calibration;
      scaleDialog.close(); refreshSpatial(); drawDistance();
    };
    $('fringe-scale-save').onclick=()=>{
      if (scaleOwner!==fr.lastResult || scalePoints.length!==2) return;
      const cal=makeImageCalibration(scaleOwner,...scalePoints,$('fringe-scale-mm').value);
      if (!cal) return;
      scaleOwner.lateral_calibration=cal; scaleDialog.close(); refreshSpatial(); drawDistance();
    };
    scaleDialog.addEventListener('close',()=>{scaleOwner=null;scalePoints=[];});
    new ResizeObserver(fitScaleImage).observe(scaleDialog);
  }
  scaleOwner=fr.lastResult;
  const savedPoints=scaleOwner.lateral_calibration?.points;
  scalePoints=Array.isArray(savedPoints) && savedPoints.length===2 && savedPoints.every(validPoint)
    ? savedPoints.map(p=>({...p})) : [];
  $('fringe-scale-mm').value=scaleOwner.lateral_calibration?.length_mm || '';
  $('fringe-scale-image').src='data:image/png;base64,'+scaleOwner.reference_image_b64;
  scaleDialog.showModal(); fitScaleImage();
}
export function refreshSpatial(result=fr.lastResult) {
  if (scaleDialog?.open && result!==scaleOwner) scaleDialog.close();
  if (displayedResult!==result) { fr.measurePoints=[]; displayedResult=result; }
  const img=$('fringe-surface-img'), canvas=$('fringe-photo-colors'), legend=$('fringe-surface-legend');
  if (!img || !canvas || !legend) return;
  const surface=(img.dataset.overlay || 'surface')==='surface';
  const limit=Number(result?.surface_color_limit_nm);
  const pixels=result && surfaceOverlayPixels(result);
  const canOverlay=!!(result?.reference_image_b64 && pixels);
  const check=$('fringe-photo-toggle');
  check.disabled=!canOverlay || !surface;
  if (!canOverlay) check.checked=false;
  const overlay=surface && canOverlay && check.checked;
  canvas.hidden=!overlay;
  $('fringe-photo-opacity').disabled=!overlay;
  $('fringe-image-scale').disabled=!result?.reference_image_b64;
  $('fringe-image-scale-status').textContent=imageDistanceMm(result,{x:0,y:0},{x:1,y:0})!==null
    ? 'Image scale set · distances in mm' : 'Image scale not set';
  if (surface && result?.surface_map) {
    const src='data:image/png;base64,'+(overlay?result.reference_image_b64:result.surface_map);
    if (img.getAttribute('src')!==src) img.src=src;
  }
  if (overlay) {
    canvas.width=result.grid_cols; canvas.height=result.grid_rows;
    canvas.getContext('2d').putImageData(new ImageData(pixels,result.grid_cols,result.grid_rows),0,0);
    canvas.style.opacity=Number($('fringe-photo-opacity').value)/100;
  }
  legend.hidden=!surface || !result;
  const known=Number.isFinite(limit) && limit>0;
  $('fringe-legend-low').textContent=known?`−${Number(limit.toPrecision(4))} nm`:'Negative';
  $('fringe-legend-high').textContent=known?`+${Number(limit.toPrecision(4))} nm`:'Positive';
  $('fringe-legend-caption').textContent=known?'Displayed deviation · physical direction: see surface-direction check':'Displayed deviation · analyze again for a numeric color scale';
}
export function wireSpatial() {
  $('fringe-image-scale')?.addEventListener('click',openScale);
  $('fringe-photo-toggle')?.addEventListener('change',()=>refreshSpatial());
  $('fringe-photo-opacity')?.addEventListener('input',()=>refreshSpatial());
  const image=$('fringe-surface-img');
  image?.addEventListener('load',drawDistance);
  if (image) new ResizeObserver(drawDistance).observe(image);
}
