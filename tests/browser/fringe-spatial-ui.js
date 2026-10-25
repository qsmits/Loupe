// Copy beside index.html in an isolated preview; append this module after main.js.
// Exercises the actual browser worker and actual workspace, using synthetic data.
import {newProject} from './tab-manager.js';
import {fr} from './fringe.js';
import {getActiveCalibration,saveCalibration} from './fringe-calibration.js';
import {runBrowserAnalysis} from './fringe-browser.js';
import {restoreFringeResult} from './fringe-results.js';
import {flushAutosave} from './tab-manager.js';
const tools=document.createElement('div');
tools.style.cssText='position:fixed;bottom:8px;left:8px;z-index:10000;background:#222;padding:8px;color:white;font:12px sans-serif';
tools.innerHTML='<button id="spatial-fixture">Analyze UI fixture in browser</button> <button id="spatial-save">Save test project</button> <span id="spatial-status">Ready</span>';
document.body.appendChild(tools);
const status=document.querySelector('#spatial-status');
document.querySelector('#spatial-save').onclick=async()=>{await flushAutosave();status.textContent='Test project saved';};
document.querySelector('#spatial-fixture').onclick=async()=>{
  const button=document.querySelector('#spatial-fixture');button.disabled=true;
  try {
    await newProject('fringe',{name:'Synthetic overlay & distance validation'});
    const fixtures=await(await fetch('fringe-validation-fixtures.json')).json();
    const fixture=fixtures.find(f=>f.name==='mirror-x-plane');
    saveCalibration({...getActiveCalibration(),wavelength_nm:fixture.body.wavelength_nm});
    const result=await runBrowserAnalysis('analyze',fixture.body,{onProgress:e=>{status.textContent=e.message;}});
    if (!(result.surface_color_limit_nm>0) || Math.abs(result.surface_color_limit_nm-fixture.expected.surface_color_limit_nm)>.005) throw new Error('Browser/native legend scale differs');
    fr.analysisEngine='browser'; fr.analysisMethod='current';
    fr.lastResult=result; fr.sourceName='Synthetic asymmetric surface';
    fr.droppedImageB64=fixture.body.image_b64;
    restoreFringeResult(result,{formModel:'plane'});
    status.textContent='PASS: browser/native color scale · ready for UI checks';
  } catch(e) {status.textContent='FAIL: '+e.message;}
  finally {button.disabled=false;}
};
