import './dom-stub.js';
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {runBrowserAnalysis,cancelBrowserAnalysis} from '../../frontend/fringe-browser.js';
import {fringeFetch,rememberBrowserResult} from '../../frontend/fringe-compute.js';
import {fr} from '../../frontend/fringe.js';
import {state} from '../../frontend/state.js';
import {setSessionIdProvider} from '../../frontend/api.js';

class FakeWorker {
  static all=[];
  constructor(url,options){this.url=url;this.options=options;FakeWorker.all.push(this);}
  postMessage(data){this.request=data;}
  terminate(){this.terminated=true;}
  reply(payload){this.onmessage({data:{id:this.request.id,...payload}});}
}
afterEach(()=>{cancelBrowserAnalysis();fr.lastResult=null;fr.analysisEngine='server';setSessionIdProvider(null);});
function setup(t){
 const previous=globalThis.Worker; globalThis.Worker=FakeWorker;
 t.after(()=>{ if (previous===undefined) delete globalThis.Worker; else globalThis.Worker=previous; });
 t.mock.method(globalThis,'fetch',()=>{throw new Error('Unexpected network request');});
 setSessionIdProvider(()=> 'browser-test');
 fr.analysisEngine='browser';fr.lastResult=null;
 return ()=>FakeWorker.all.at(-1);
}
test('runs locally, forwards progress, terminates on cancel, and ignores late results',async t=>{
 const worker=setup(t), progress=[];
 const signal=new AbortController();
 const promise=runBrowserAnalysis('analyze',{image_b64:'private'},{signal:signal.signal,onProgress:e=>progress.push(e)});
 worker().reply({event:{stage:'phase',progress:.25}});
 assert.equal(progress.length,1);
 assert.equal(worker().options.type,'module');
 signal.abort();
 await assert.rejects(promise,{name:'AbortError'});
 assert.equal(worker().terminated,true);
 worker().reply({result:{id:'late'}});
});
test('worker startup failure never falls back to server computation',async t=>{
 const worker=setup(t);
 const response=fringeFetch('/fringe/analyze',{body:JSON.stringify({image_b64:'private'})});
 worker().onerror();
 const result=await response;
 assert.equal(result.status,422);
 assert.match((await result.json()).detail,/not uploaded/);
});
test('browser results keep recomputation local even after the setting changes',async t=>{
 const worker=setup(t);fr.analysisEngine='server';fr.lastResult={id:'local',execution_engine:'browser'};
 const response=fringeFetch('/fringe/reanalyze',{body:JSON.stringify({coefficients:[1]})});
 assert.equal(worker().request.operation,'reanalyze');
 worker().reply({result:{execution_engine:'browser',pv_nm:3}});
 assert.equal((await (await response).json()).pv_nm,3);
});
test('browser history is isolated, capped, immutable, and can be cleared',async t=>{
 setup(t);
 const first={id:'history-0',execution_engine:'browser',pv_nm:1};
 rememberBrowserResult(first); first.pv_nm=9;
 assert.equal((await (await fringeFetch('/fringe/session/capture/history-0')).json()).pv_nm,1);
 for(let i=1;i<10;i++) rememberBrowserResult({id:'history-'+i,execution_engine:'browser'});
 let rows=(await (await fringeFetch('/fringe/session/captures')).json()).captures;
 assert.equal(rows.length,8);assert.equal(rows[0].id,'history-2');
 setSessionIdProvider(()=> 'other-project');
 assert.equal((await (await fringeFetch('/fringe/session/captures')).json()).captures.length,0);
 assert.equal((await fringeFetch('/fringe/session/capture/history-9')).status,422);
 setSessionIdProvider(()=> 'browser-test');fr.lastResult={id:'history-9',execution_engine:'browser'};
 await fringeFetch('/fringe/session/clear',{method:'POST'});
 assert.equal((await (await fringeFetch('/fringe/session/captures')).json()).captures.length,0);
});
test('project changes discard results instead of entering another project history',async t=>{
 const worker=setup(t);
 const response=fringeFetch('/fringe/analyze',{body:'{}'});
 state._epoch++;
 worker().reply({result:{id:'wrong-project',execution_engine:'browser'}});
 await assert.rejects(response,{name:'AbortError'});
});
test('average and subtraction resolve browser sources without a server request',async t=>{
 const worker=setup(t);
 rememberBrowserResult({id:'avg-a',execution_engine:'browser',raw_height_grid_nm:[1]});
 rememberBrowserResult({id:'avg-b',execution_engine:'browser',raw_height_grid_nm:[2]});
 const response=fringeFetch('/fringe/average',{body:JSON.stringify({source_ids:['avg-a','avg-b'],source_polarities:[1,1]})});
 assert.deepEqual(worker().request.body.results.map(r=>r.id),['avg-a','avg-b']);
 worker().reply({result:{id:'avg-c',execution_engine:'browser'}});
 assert.equal((await response).status,200);
 const subtraction=fringeFetch('/fringe/subtract',{body:JSON.stringify({measurement_id:'avg-a',reference_id:'avg-b',reference_polarity:1})});
 assert.equal(worker().request.body.reference.id,'avg-b');
 worker().reply({result:{id:'difference',execution_engine:'browser'}});
 assert.equal((await subtraction).status,200);
});

test('group pills update the authoritative subtraction terms without losing individual terms',async()=>{
 const {getSubtractTerms,setPillSubtracted}=await import('../../frontend/fringe-results.js');
 fr.lastResult={subtracted_terms:[1,2,3,17]};
 setPillSubtracted('power',true);
 assert.deepEqual(getSubtractTerms(),[1,2,3,4,17]);
 setPillSubtracted('tilt',false);
 assert.deepEqual(getSubtractTerms(),[1,4,17]);
 setPillSubtracted('power',false);
 assert.deepEqual(getSubtractTerms(),[1,17]);
});
