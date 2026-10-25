// Evidence categories are not calibrated confidence or uncertainty intervals.
export const QUALITY_LABELS = ['Unmeasured', 'Stronger agreement', 'Expanded coverage', 'Limited corroboration'];
export const QUALITY_COLORS = [null, [56,189,248], [245,158,11], [192,132,252]];
export const SOURCE_LABELS={hybrid:'Original Hybrid',strict_local_consensus:'Strict local consensus',coverage_local_consensus:'Coverage local consensus',checked_continuation:'Checked continuation',photographic_recovery:'Photographic recovery (limited)',registered_capture:'Registered capture'};
export function conflictReason(bits){return [[1,'local phase disagreement'],[2,'ambiguous fringe order'],[4,'capture overlap disagreement']].filter(([bit])=>bits&bit).map(([,label])=>label).join('; ');}
export function compositeView(result, cutoff=2, includePhotographic=true) {
  const c=result?.composite, rows=c?.grid_rows,cols=c?.grid_cols,n=rows*cols;
  if(!c||c.version!==1||!Number.isInteger(rows)||!Number.isInteger(cols)||rows<1||cols<1||rows>256||cols>256||
    ['height_grid_nm','quality_grid','source_grid','conflict_grid','aperture_grid'].some(k=>c[k]?.length!==n))throw new Error('Invalid composite grid. Analyze the image again.');
  if(![1,2,3].includes(cutoff))throw new Error('Invalid quality cutoff');
  if(['reason_grid','support_grid','spread_grid_nm'].some(k=>c[k]!=null&&c[k].length!==n))throw new Error('Invalid composite diagnostics');
  const included=new Uint8Array(n);let limit=.01;
  for(let i=0;i<n;i++){
    const q=c.quality_grid[i],v=c.height_grid_nm[i];
    if(!Number.isInteger(q)||q<0||q>3||!Number.isInteger(c.source_grid[i])||c.source_grid[i]<0||c.source_grid[i]>5||
       (c.source_grid[i]&&!c.sources?.some(s=>s.id===c.source_grid[i])))throw new Error('Invalid composite provenance');
    if(q&&Number.isFinite(v)&&!c.conflict_grid[i])limit=Math.max(limit,Math.abs(v));
    const photographic=c.sources?.find(s=>s.id===c.source_grid[i])?.method==='photographic_recovery';
    included[i]=q>0&&q<=cutoff&&!c.conflict_grid[i]&&Number.isFinite(v)&&(includePhotographic||!photographic)?1:0;
  }
  const summaries=!includePhotographic&&c.sources?.some(s=>s.method==='photographic_recovery')
    ? c.without_photographic_summaries : c.summaries;
  const stats=summaries?.find(s=>s.cutoff===cutoff);
  if(!stats)throw new Error('Composite statistics are missing. Analyze again.');
  return {c,rows,cols,included,limit,stats,cutoff,includePhotographic};
}
export function compositeCsv(view) {
  const {c,rows,cols,included,cutoff,includePhotographic}=view;
  const lines=[`# Experimental composite; quality is categorical, not uncertainty in nm`,
    `# Cutoff ${cutoff}: ${QUALITY_LABELS[cutoff]}; fixed analysis-time ${c.form_model} removal; wavelength ${c.wavelength_nm} nm`,
    '# Heights are air-gap departures, physical direction unverified; display-resolution samples',
    '# Reconstructed preview values are excluded from this measurement export and all flatness statistics',
    `# Photographic recovery: ${includePhotographic?'included when allowed by cutoff':'hidden'}; fixed form and color scale`,
    `# Statistics resolution: ${c.statistics_resolution==='display_grid'?'display grid':'full analysis'}; ${c.kind==='multi'?'registered pair, single-support cells are not cross-checked':'single capture'}`,
    ...(c.kind==='multi'?[`# Capture sources: ${JSON.stringify(c.sources)}`,`# Registration and overlap checks: ${JSON.stringify(c.registration)}`]:[]),
    'column,row,included,height_nm,quality,conflict,source_method,capture_index,reason,capture_support,overlap_difference_nm'];
  for(let i=0;i<rows*cols;i++)if(c.aperture_grid[i]||c.quality_grid[i]){
    const source=c.sources?.find(s=>s.id===c.source_grid[i]);
    // Source names come from a fixed schema, never user strings in CSV cells.
    const methods={1:'hybrid',2:'strict_local_consensus',3:'coverage_local_consensus',4:'checked_continuation',5:'photographic_recovery'};
    const method=SOURCE_LABELS[source?.method]?source.method:methods[source?.id]||'';
    lines.push([i%cols,Math.floor(i/cols),included[i],included[i]?c.height_grid_nm[i].toFixed(4):'',
      QUALITY_LABELS[c.quality_grid[i]],c.conflict_grid[i]?1:0,method,source?(source.capture_index||0):'',
      conflictReason(c.reason_grid?.[i]||0),c.support_grid?.[i]??(c.quality_grid[i]?1:0),c.spread_grid_nm?.[i]??''].join(','));
  }
  return lines.join('\n');
}

// Display-only extension: never changes included, stats, measurement heights or CSV.
export function reconstructionView(view, enabled=false) {
  const {c,rows,cols}=view, n=rows*cols, r=c.reconstruction;
  const reconstructed=new Uint8Array(n);
  let limit=view.limit;
  if(!r || c.kind==='multi')return {available:false,reconstructed,limit,pixels:0};
  if(r.version!==1 || r.kind!=='inferred_not_measured' ||
     r.height_grid_nm?.length!==n || r.reconstructed_grid?.length!==n ||
     !Number.isInteger(r.reconstructed_pixels) || r.reconstructed_pixels<0 || r.reconstructed_pixels>c.aperture_pixels)
    throw new Error('Invalid reconstructed preview. Analyze again.');
  for(let i=0;i<n;i++)if(r.reconstructed_grid[i]){
    if(!Number.isFinite(r.height_grid_nm[i]) || !c.aperture_grid[i] || c.conflict_grid[i] || c.quality_grid[i])
      throw new Error('Reconstructed preview overlaps measurements or excluded pixels. Analyze again.');
    // Keep the same color scale when toggling the preview, so measured colors stay fixed.
    limit=Math.max(limit,Math.abs(r.height_grid_nm[i]));
    if(enabled)reconstructed[i]=1;
  }
  return {available:true,reconstructed,limit,pixels:enabled?r.reconstructed_pixels:0,
    heights:r.height_grid_nm,converged:r.diagnostics?.converged===true};
}
