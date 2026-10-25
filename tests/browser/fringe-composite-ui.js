// Isolated test origin only: loads a synthetic image into the real setup flow.
import {newProject} from './tab-manager.js';
import {fr} from './fringe.js';
import {getActiveCalibration,saveCalibration} from './fringe-calibration.js';
import {analyzeFromFile} from './fringe-panel.js';
const button=document.createElement('button');button.textContent='Load composite UI fixture';
button.style.cssText='position:fixed;bottom:8px;left:8px;z-index:10000';document.body.appendChild(button);
button.onclick=async()=>{
  button.disabled=true;
  try{
    await newProject('fringe',{name:'Composite quality validation'});
    const [fixture]=await(await fetch('fringe-validation-fixtures.json')).json();
    saveCalibration({...getActiveCalibration(),wavelength_nm:fixture.body.wavelength_nm});
    fr.analysisEngine='browser';fr.analysisMethod='composite';
    const bytes=Uint8Array.from(atob(fixture.body.image_b64),c=>c.charCodeAt(0));
    await analyzeFromFile(new File([bytes],'synthetic-composite-rim.png',{type:'image/png'}));
  }finally{button.disabled=false;}
};

// A repeatable UI-only registration fixture. Numerical engine parity is tested
// separately; these deliberately masked copies exercise complementary coverage.
import {rememberBrowserResult} from './fringe-compute.js';
import {openComposite} from './fringe-composite-view.js';
import {restoreFringeResult} from './fringe-results.js';
const pairButton=document.createElement('button');pairButton.textContent='Load registered-pair UI fixture';
pairButton.style.cssText='position:fixed;bottom:8px;left:215px;z-index:10000';document.body.appendChild(pairButton);
pairButton.onclick=async()=>{
  await newProject('fringe',{name:'Registered pair validation'});
  const [fixture]=await(await fetch('fringe-validation-fixtures.json')).json();
  const captures=[structuredClone(fixture.expected),structuredClone(fixture.expected)];
  captures.forEach((r,k)=>{
    r.id='registered-ui-'+k;r.execution_engine='browser';r.captured_at=`Synthetic capture ${k+1}`;
    r.reference_marks=[{label:'A',x:.3,y:.3},{label:'B',x:.7,y:.3},{label:'C',x:.5,y:.7}];
    const c=r.composite;
    c.quality_grid.forEach((q,i)=>{const x=i%c.grid_cols/c.grid_cols;if((k===0&&x>.65)||(k===1&&x<.35)){c.quality_grid[i]=0;c.source_grid[i]=0;}});
    // Recompute the fixture summaries after its deliberate support removal.
    c.summaries=[1,2,3].map(cutoff=>{const values=c.height_grid_nm.filter((_,i)=>c.quality_grid[i]>0&&c.quality_grid[i]<=cutoff&&!c.conflict_grid[i]);const mean=values.reduce((a,v)=>a+v,0)/values.length;return {cutoff,pixels:values.length,coverage_pct:100*values.length/c.aperture_grid.filter(Boolean).length,pv_nm:Math.max(...values)-Math.min(...values),rms_nm:Math.sqrt(values.reduce((a,v)=>a+(v-mean)**2,0)/values.length)};});
    rememberBrowserResult(r);
  });
  fr.lastResult=captures[0];fr.analysisEngine='browser';fr.analysisMethod='composite';restoreFringeResult(fr.lastResult);openComposite();
};

const photographicButton=document.createElement('button');photographicButton.textContent='Load photographic recovery UI fixture';
photographicButton.style.cssText='position:fixed;bottom:8px;left:470px;z-index:10000';document.body.appendChild(photographicButton);
photographicButton.onclick=async()=>{
  await newProject('fringe',{name:'Photographic recovery validation'});
  const fixture=(await(await fetch('fringe-validation-fixtures.json')).json()).find(f=>f.name==='composite-photographic-recovery');
  if(!fixture)throw new Error('Missing photographic recovery fixture');
  fr.lastResult=structuredClone(fixture.expected);fr.analysisEngine='browser';fr.analysisMethod='composite';
  restoreFringeResult(fr.lastResult);openComposite();
};
