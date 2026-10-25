self.onmessage=async()=>{try{
    const source=await(await fetch('fringe-browser-worker.js')).text();
    const index=source.match(/const INDEX = '([^']+)'/)[1];
    const {loadPyodide}=await import(index+'pyodide.mjs');
    const py=await loadPyodide({indexURL:index,stdout:()=>{},stderr:()=>{}});
    await py.loadPackage(['opencv-python','scipy','scikit-image','matplotlib']);
    const bundle=await fetch('/fringe-runtime/source.zip',{cache:'no-cache'});
    if(!bundle.ok)throw new Error('Source bundle unavailable');
    py.unpackArchive(await bundle.arrayBuffer(),'zip',{extractDir:'/home/pyodide'});
    self.postMessage({status:'Running residue repair, Current and Hybrid in the browser…'});
    await py.runPythonAsync(await(await fetch('fringe-unwrap-validation.py')).text());
    const result=JSON.parse(await py.runPythonAsync('json.dumps(run())'));
    self.postMessage({result});
  }catch(error){self.postMessage({error:String(error)});}};
