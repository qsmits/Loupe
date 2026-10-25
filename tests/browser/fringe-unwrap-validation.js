// Serve with fringe-unwrap-validation.py and fringe-unwrap-native.json on an
// isolated frontend; uses the exact Pyodide version pinned by the app worker.
const run=document.querySelector('#run'),status=document.querySelector('#status'),output=document.querySelector('#results');
run.onclick=async()=>{
  run.disabled=true;status.textContent='Loading browser runtime…';output.textContent='';
  const worker=new Worker(new URL('./fringe-unwrap-worker.js',import.meta.url),{type:'module'});
  const stop=()=>{worker.terminate();run.disabled=false;};
  worker.onerror=e=>{status.textContent='FAIL: '+e.message;stop();};
  worker.onmessage=async({data})=>{
    if(data.status){status.textContent=data.status;return;}
    try{
      if(data.error)throw new Error(data.error);
      const expected=await(await fetch('fringe-unwrap-native.json')).json(),actual=data.result;
      if(actual.index_bits!==32)throw new Error('Expected a 32-bit browser runtime');
      for(const key of ['cuts','shifted','cut_hash','shifted_hash','remaining_order_errors'])if(actual[key]!==expected[key])throw new Error(key+' differs');
      for(const method of ['current','hybrid']){
        for(const key of ['valid','nonempty_cut_calls'])if(actual[method][key]!==expected[method][key])throw new Error(method+' '+key+' differs');
        for(const key of ['pv_nm','rms_nm'])if(Math.abs(actual[method][key]-expected[method][key])>.005)throw new Error(method+' '+key+' differs');
      }
      output.textContent=JSON.stringify(actual,null,2);status.textContent='PASS: 32-bit browser residue repair and Current / Hybrid match native Python.';
    }catch(error){status.textContent='FAIL: '+error.message;}finally{stop();}
  };
  worker.postMessage({});
};
