// Isolated test origin only; deliberately creates a synthetic local project.
import {newProject} from './tab-manager.js';
import {fr} from './fringe.js';
import {restoreFringeResult} from './fringe-results.js';
import {openComposite} from './fringe-composite-view.js';
import {analyzeFromFile} from './fringe-panel.js';
for(const setup of [false,true]){
  const button=document.createElement('button');
  button.textContent=setup?'Load reconstruction setup fixture':'Show reconstructed fixture';
  button.style.cssText=`position:fixed;bottom:8px;left:${setup?230:8}px;z-index:10000`;
  document.body.appendChild(button);
  button.onclick=async()=>{
    button.disabled=true;
    try{
      await newProject('fringe',{name:'Reconstructed preview validation'});
      const [fixture]=await(await fetch('fringe-validation-fixtures.json')).json();
      fr.analysisEngine='browser';fr.analysisMethod='composite';
      if(setup){
        const bytes=Uint8Array.from(atob(fixture.body.image_b64),c=>c.charCodeAt(0));
        await analyzeFromFile(new File([bytes],'synthetic-rolled-rim.png',{type:'image/png'}));
      }else{
        fr.lastResult=structuredClone(fixture.expected);restoreFringeResult(fr.lastResult);openComposite();
      }
    }finally{button.disabled=false;}
  };
}
