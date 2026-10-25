// Immutable, compact snapshots of two runs from one input/settings payload.
// Comparison grids are display-resolution data, not additional measurements.
export function comparisonSnapshot(r) {
  const keys=['analysis_method','grid_rows','grid_cols','surface_width','surface_height',
    'image_width','image_height','form_model','subtracted_terms','wavelength_nm',
    'execution_engine','warnings','pv_nm','rms_nm','n_valid_pixels','mask_grid','display_height_grid_nm',
    'hybrid_diagnostics'];
  const s=Object.fromEntries(keys.map(k=>[k,r[k]]));
  s.display_height_grid_nm=r.display_height_grid_nm || r.height_grid;
  return structuredClone(s);
}
export function hybridFallbackNotice(diagnostics) {
  if (diagnostics?.local_pixels !== 0) return '';
  return 'Hybrid used the Current estimate everywhere: no local fits passed all acceptance checks. These identical maps do not independently confirm the heights.';
}
export function makeMethodComparison(current, hybrid) {
  for (const key of ['grid_rows','grid_cols','surface_width','surface_height','image_width','image_height','form_model','wavelength_nm','reference_image_b64']) {
    if (current[key]!==hybrid[key]) throw new Error('Comparison requires the same image alignment, resolution and form removal.');
  }
  if (JSON.stringify(current.subtracted_terms)!==JSON.stringify(hybrid.subtracted_terms) || current.execution_engine!==hybrid.execution_engine) throw new Error('Comparison requires identical settings and execution engine.');
  if (current.analysis_method!=='current' || hybrid.analysis_method!=='hybrid') throw new Error('Comparison needs both analysis methods.');
  return {version:1,created_at:new Date().toISOString(),current:comparisonSnapshot(current),hybrid:comparisonSnapshot(hybrid)};
}
// Pivoted 3x3 solve; coordinates normalized to avoid image-size conditioning.
function solvePlane(matrix, vector) {
  const a=matrix.map((row,i)=>[...row,vector[i]]);
  for(let j=0;j<3;j++) {
    let p=j;for(let k=j+1;k<3;k++)if(Math.abs(a[k][j])>Math.abs(a[p][j]))p=k;
    if(Math.abs(a[p][j])<1e-10)return null;
    [a[j],a[p]]=[a[p],a[j]];
    const divisor=a[j][j];for(let k=j;k<4;k++)a[j][k]/=divisor;
    for(let i=0;i<3;i++)if(i!==j){const factor=a[i][j];for(let k=j;k<4;k++)a[i][k]-=factor*a[j][k];}
  }
  return a.map(row=>row[3]);
}
export function compareMethodGrids(pair, align=true) {
  const {current:a,hybrid:b}=pair || {};
  if(!a || !b || a.grid_rows!==b.grid_rows || a.grid_cols!==b.grid_cols)throw new Error('Comparison grids do not align.');
  const rows=a.grid_rows,cols=a.grid_cols,n=rows*cols;
  if(!Number.isInteger(n)||n<1||n>256*256||[a.mask_grid,b.mask_grid,a.display_height_grid_nm,b.display_height_grid_nm].some(v=>v?.length!==n))throw new Error('Invalid comparison grid.');
  const coverage=new Uint8Array(n),difference=new Float64Array(n).fill(NaN);
  const current=new Float64Array(n).fill(NaN),hybrid=new Float64Array(n).fill(NaN);
  const matrix=Array.from({length:3},()=>[0,0,0]),vector=[0,0,0];
  let shared=0,added=0,removed=0;
  for(let i=0;i<n;i++){
    const av=a.mask_grid[i]&&Number.isFinite(a.display_height_grid_nm[i]);
    const bv=b.mask_grid[i]&&Number.isFinite(b.display_height_grid_nm[i]);
    coverage[i]=(av?1:0)+(bv?2:0);
    if(av)current[i]=a.display_height_grid_nm[i];
    if(bv)hybrid[i]=b.display_height_grid_nm[i];
    if(coverage[i]===2)added++;
    if(coverage[i]===1)removed++;
    if(coverage[i]!==3)continue;
    shared++;
    const delta=hybrid[i]-current[i],v=[1,(i%cols+.5)/cols-.5,(Math.floor(i/cols)+.5)/rows-.5];
    for(let j=0;j<3;j++){vector[j]+=v[j]*delta;for(let k=0;k<3;k++)matrix[j][k]+=v[j]*v[k];}
  }
  const plane=align&&shared>=3?solvePlane(matrix,vector):null;
  let sum=0,max=0,surfaceLimit=0,deltaLimit=0;
  for(let i=0;i<n;i++){
    if(plane&&Number.isFinite(hybrid[i]))hybrid[i]-=plane[0]+plane[1]*((i%cols+.5)/cols-.5)+plane[2]*((Math.floor(i/cols)+.5)/rows-.5);
    if(Number.isFinite(current[i]))surfaceLimit=Math.max(surfaceLimit,Math.abs(current[i]));
    if(Number.isFinite(hybrid[i]))surfaceLimit=Math.max(surfaceLimit,Math.abs(hybrid[i]));
    if(coverage[i]!==3)continue;
    const d=hybrid[i]-current[i];difference[i]=d;sum+=d*d;max=Math.max(max,Math.abs(d));deltaLimit=Math.max(deltaLimit,Math.abs(d));
  }
  return {rows,cols,coverage,current,hybrid,difference,shared,added,removed,plane,
    rms:shared?Math.sqrt(sum/shared):null,max:shared?max:null,surfaceLimit:Math.max(.01,surfaceLimit),deltaLimit:Math.max(.01,deltaLimit)};
}
export function comparisonCsv(grid) {
  const lines=['column,row,coverage,current_nm,hybrid_nm,hybrid_minus_current_nm'];
  const names=['neither','current only','hybrid only','both'];
  const val=v=>Number.isFinite(v)?v.toFixed(4):'';
  for(let i=0;i<grid.coverage.length;i++)if(grid.coverage[i])lines.push([i%grid.cols,Math.floor(i/grid.cols),names[grid.coverage[i]],val(grid.current[i]),val(grid.hybrid[i]),val(grid.difference[i])].join(','));
  return lines.join('\n');
}
