import {runBrowserAnalysis,cancelBrowserAnalysis} from './fringe-browser.js';
const status=document.querySelector('#status'), output=document.querySelector('#results');
let running=false;
document.querySelector('#cancel').onclick=()=>cancelBrowserAnalysis();
function compare(a,b) {
  if (a.analysis_method!==b.analysis_method) throw new Error('Analysis methods differ');
  if (b.hybrid_diagnostics && ['local_pixels','added_pixels','fallback_pixels','baseline_pixels'].some(k=>a.hybrid_diagnostics?.[k]!==b.hybrid_diagnostics[k])) throw new Error('Hybrid selection differs');
  if (!(a.surface_color_limit_nm>0) || Math.abs(a.surface_color_limit_nm-b.surface_color_limit_nm)>.005) throw new Error('Surface color ranges differ');
  if (b.analysis_filter?.boundary_rule && a.analysis_filter?.boundary_rule!==b.analysis_filter.boundary_rule) throw new Error('Boundary policies differ');
  if (b.coverage?.physical_pixels && a.coverage?.physical_pixels!==b.coverage.physical_pixels) throw new Error('Physical outline counts differ');
  if (a.grid_rows!==b.grid_rows || a.grid_cols!==b.grid_cols) throw new Error('Grid dimensions differ');
  const diff=a.display_height_grid_nm.flatMap((v,i)=>a.mask_grid[i]&&b.mask_grid[i]?[v-b.display_height_grid_nm[i]]:[]);
  const rms=Math.sqrt(diff.reduce((s,d)=>s+d*d,0)/diff.length), max=Math.max(...diff.map(Math.abs));
  const masks=a.mask_grid.filter((v,i)=>v!==b.mask_grid[i]).length;
  // Serialized height grids round to 0.01 nm. A value close to a rounding
  // boundary can differ by one unit even when float computations agree.
  if (!diff.length || max>.011 || masks || Math.abs(a.pv_nm-b.pv_nm)>.005) throw new Error(`Parity failure: max=${max}, masks=${masks}, PV=${a.pv_nm-b.pv_nm}`);
  return {rms_nm:rms,max_nm:max,maskDifferences:masks,pvDifference_nm:a.pv_nm-b.pv_nm};
}
document.querySelector('#run').onclick=async()=>{
 if(running)return;running=true;output.textContent='';
 const start=performance.now();
 const results=[];
 try {
   const fixtures=await (await fetch('fringe-validation-fixtures.json')).json();
   for(const fixture of fixtures){
     const began=performance.now();
     const result=await runBrowserAnalysis(fixture.operation || 'analyze',fixture.body,{onProgress:e=>status.textContent=fixture.name+': '+e.message});
     const row={name:fixture.name,seconds:(performance.now()-began)/1000,...compare(result,fixture.expected)};
     if (fixture.reanalyze) {
       const r=await runBrowserAnalysis('reanalyze',fixture.reanalyze.body);
       row.reanalyze=compare(r,fixture.reanalyze.expected);
     }
     results.push(row);output.textContent=JSON.stringify(results,null,2);
   }
   status.textContent=`PASS: ${results.length} fixtures (${((performance.now()-start)/1000).toFixed(1)} s)`;
 }catch(error){status.textContent='FAIL: '+error.message;}finally{running=false;}
};
