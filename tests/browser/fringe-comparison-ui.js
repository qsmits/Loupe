// Copy beside index.html in an isolated preview; append after main.js.
// Supplies a synthetic image only. Test the real settings/paired-run controls.
import {newProject} from './tab-manager.js';
import {fr} from './fringe.js';
import {getActiveCalibration,saveCalibration} from './fringe-calibration.js';
import {analyzeFromFile} from './fringe-panel.js';
const button=document.createElement('button');
button.textContent='Load paired-analysis UI fixture';
button.style.cssText='position:fixed;bottom:8px;left:8px;z-index:10000';
document.body.appendChild(button);
button.onclick=async()=>{
  button.disabled=true;
  try {
    await newProject('fringe',{name:'Synthetic paired-analysis validation'});
    const fixtures=await(await fetch('fringe-validation-fixtures.json')).json();
    const fixture=fixtures.find(f=>f.name==='directional-edge-outline');
    saveCalibration({...getActiveCalibration(),wavelength_nm:fixture.body.wavelength_nm});
    fr.analysisEngine='browser';
    const bytes=Uint8Array.from(atob(fixture.body.image_b64),c=>c.charCodeAt(0));
    await analyzeFromFile(new File([bytes],'synthetic-rim.png',{type:'image/png'}));
  } finally {button.disabled=false;}
};
