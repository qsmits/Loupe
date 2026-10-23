// Route fringe work explicitly. Browser failures never fall back to uploading.
import { apiFetch, getSessionId } from './api.js';
import { fr } from './fringe.js';
import { state } from './state.js';
import { runBrowserAnalysis } from './fringe-browser.js';

// Volatile, bounded history. The existing project store saves the current result.
// Store JSON to avoid mutable aliases and account for retained payload size.
const captures = new Map();
const clearedCurrent = new Map();
const MAX_BYTES = 48 * 1024 * 1024;
export function isBrowserResult(result=fr.lastResult) { return result?.execution_engine === 'browser'; }
export function browserSelected() { return fr.analysisEngine === 'browser'; }
export function rememberBrowserResult(result, session=getSessionId()) {
  const json=JSON.stringify(result), bytes=json.length*2;
  if (bytes>MAX_BYTES) return;
  captures.delete(result.id);
  captures.set(result.id,{session,json,bytes});
  let total=[...captures.values()].reduce((sum,v)=>sum+v.bytes,0);
  while (captures.size>8 || total>MAX_BYTES) {
    const first=captures.keys().next().value;
    total-=captures.get(first).bytes; captures.delete(first);
  }
}
function readCapture(id,session) {
  const capture=captures.get(id);
  if (capture?.session===session) return JSON.parse(capture.json);
  if (fr.lastResult?.id===id && isBrowserResult()) return structuredClone(fr.lastResult);
  throw new Error('This browser capture is no longer in memory. Reopen its saved project or analyze the image again.');
}
function summary(r) {
  const keys=['id','origin','source_ids','captured_at','pv_nm','rms_nm','pv_waves','rms_waves','pv_fringes',
    'source_polarities','rms_fringes','incidence_model','measurement_model','height_semantics','absolute_sign_known','specimen_surface_relative_sign',
    'reference_flat_error_included','wavelength_nm','n_valid_pixels','n_total_pixels','surface_height','surface_width','calibration_snapshot'];
  return {...Object.fromEntries(keys.map(k=>[k,r[k]])),thumbnail:r.surface_map,execution_engine:'browser'};
}
export async function fringeFetch(path, options={}, engine) {
  const local = engine === 'browser' || (engine == null && (fr.lastResult ? isBrowserResult() : browserSelected()));
  if (!local) return apiFetch(path,options);
  const session=getSessionId(), epoch=state._epoch, sourceResult=fr.lastResult;
  const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  try {
    const body=options.body ? JSON.parse(options.body) : {};
    if (path==='/fringe/session/captures') {
      const rows=[...captures.values()].filter(c=>c.session===session).map(c=>JSON.parse(c.json));
      if (isBrowserResult() && clearedCurrent.get(session)!==fr.lastResult.id && !rows.some(r=>r.id===fr.lastResult.id)) rows.push(fr.lastResult);
      return reply({captures:rows.map(summary)});
    }
    if (path==='/fringe/session/clear') {
      for (const [id,c] of captures) if (c.session===session) captures.delete(id);
      if (isBrowserResult()) clearedCurrent.set(session,fr.lastResult.id);
      return reply({ok:true});
    }
    if (path.startsWith('/fringe/session/capture/')) return reply(readCapture(decodeURIComponent(path.split('/').at(-1)),session));
    // Import validation belongs to the server's existing schema; until ported,
    // reject explicitly instead of secretly uploading browser results.
    if (path==='/fringe/session/import') throw new Error('Capture import is not yet supported in browser mode. Open a saved Loupe project instead.');
    let operation;
    if (path==='/fringe/analyze' || path==='/fringe/reanalyze-carrier') operation='analyze';
    else if (path==='/fringe/reanalyze') operation='reanalyze';
    else if (path==='/fringe/average') {
      operation='average'; body.results=body.source_ids.map(id=>readCapture(id,session));
    } else if (path==='/fringe/subtract') {
      operation='subtract'; body.measurement=readCapture(body.measurement_id,session); body.reference=readCapture(body.reference_id,session);
    } else throw new Error('This operation is not available in browser analysis mode.');
    const message=document.getElementById('fringe-result-operation');
    const controls=[...document.querySelectorAll('.fringe-pill, #fringe-form-model, #fringe-btn-invert, #fringe-zernike-table-container input')];
    const disabled=controls.map(el=>el.disabled);
    controls.forEach(el=>el.disabled=true);
    if (message) { message.hidden=false; message.textContent='Computing in this browser…'; }
    let result;
    try {
      result=await runBrowserAnalysis(operation,body,{signal:options.signal});
    } finally {
      if (state._epoch===epoch && fr.lastResult===sourceResult) {
        controls.forEach((el,i)=>el.disabled=disabled[i]);
        if (message) message.hidden=true;
      }
    }
    if (state._epoch!==epoch) throw new DOMException('Project changed','AbortError');
    if (operation!=='reanalyze' && body.record!==false) rememberBrowserResult(result,session);
    return reply(result);
  } catch(error) {
    if (error.name==='AbortError') throw error;
    return reply({detail:error.message},422);
  }
}
