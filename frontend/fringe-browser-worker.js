// The numerical code is identical to the server's. Only its runtime changes.
// Keep this version pinned: package upgrades require parity validation.
const INDEX = 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/';
let runtime;
let busy = false;
async function initialize(progress) {
  const { loadPyodide } = await import(INDEX + 'pyodide.mjs');
  progress({stage:'runtime', progress:0, message:'Loading browser analysis runtime (first use downloads scientific libraries)…'});
  const py = await loadPyodide({ indexURL:INDEX, stdout:()=>{}, stderr:console.warn });
  await py.loadPackage(['opencv-python', 'scipy', 'scikit-image', 'matplotlib'], {
    messageCallback: message => progress({stage:'runtime', progress:0, message}),
  });
  const response = await fetch('/fringe-runtime/source.zip', {cache:'no-cache'});
  if (!response.ok) throw new Error('Could not load the browser analysis source');
  py.unpackArchive(await response.arrayBuffer(), 'zip', {extractDir:'/home/pyodide'});
  await py.runPythonAsync('from backend.browser.fringe import execute_json');
  return py;
}
self.onmessage = async ({data:{id, operation, body}}) => {
  if (busy) { self.postMessage({id, error:'Browser analysis is already running'}); return; }
  busy = true;
  const progress = event => self.postMessage({id, event});
  try {
    runtime ??= initialize(progress).catch(error => {runtime=null; throw error;});
    const py = await runtime;
    py.globals.set('job_operation', operation);
    py.globals.set('job_body', JSON.stringify(body));
    py.globals.set('job_progress', (stage, progressValue, message) => progress({stage,progress:progressValue,message}));
    const result = await py.runPythonAsync('execute_json(job_operation, job_body, job_progress)');
    const parsed=JSON.parse(result);
    parsed.browser_runtime={name:'Pyodide',version:py.version};
    self.postMessage({id, result:parsed});
  } catch(error) {
    self.postMessage({id, error:String(error.message || error)});
  } finally {
    if (runtime) {
      const py = await runtime;
      for (const key of ['job_operation','job_body','job_progress']) py.globals.delete(key);
    }
    busy = false;
  }
};
