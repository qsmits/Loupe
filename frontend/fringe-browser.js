// One isolated worker. Termination really cancels native/Wasm computation;
// there is deliberately no fallback that uploads an image to the server.
let worker = null;
let pending = null;
let sequence = 0;
let idleTimer = null;
export function cancelBrowserAnalysis(onlyActive=false) {
  if (onlyActive && !pending) return;
  clearTimeout(idleTimer);
  worker?.terminate(); worker=null;
  const job=pending; pending=null;
  job?.finish(new DOMException('Analysis cancelled', 'AbortError'));
}
export function runBrowserAnalysis(operation, body, {signal, onProgress=()=>{}}={}) {
  if (signal?.aborted) return Promise.reject(new DOMException('Analysis cancelled', 'AbortError'));
  if (pending) return Promise.reject(new Error('Browser analysis is already running. Cancel it before starting another.'));
  clearTimeout(idleTimer);
  return new Promise((resolve,reject) => {
    const id=++sequence;
    const abort=()=>cancelBrowserAnalysis();
    const timeout=setTimeout(()=>{
      const active=worker; worker=null;
      active?.terminate();
      finish(new Error('Browser analysis exceeded 10 minutes. Try a smaller image.'));
    }, 600_000);
    function finish(error, result) {
      clearTimeout(timeout); signal?.removeEventListener('abort',abort);
      if (pending?.id === id) pending=null;
      if (error) reject(error); else resolve(result);
      // Keep libraries warm for immediate form changes, then release Wasm memory.
      if (worker && !pending) idleTimer=setTimeout(cancelBrowserAnalysis,120_000);
    }
    pending={id,finish};
    try {
      worker ??= new Worker(new URL('./fringe-browser-worker.js',import.meta.url),{type:'module'});
      worker.onmessage=({data})=>{
        if (data.id!==id || pending?.id!==id) return;
        if (data.event) onProgress(data.event);
        else if (data.error) finish(new Error(data.error));
        else finish(null,data.result);
      };
      worker.onerror=()=>{
        if (pending?.id !== id) return;
        worker?.terminate(); worker=null;
        finish(new Error('Browser analysis could not start. Check runtime downloads and WebAssembly support; the image was not uploaded.'));
      };
      signal?.addEventListener('abort',abort,{once:true});
      worker.postMessage({id,operation,body});
    } catch(error) { worker?.terminate(); worker=null; finish(error); }
  });
}
