import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openFringeLensCal, fitLensSamples, calibrationImagePoint} from '../../frontend/fringe-lens-cal.js';

const nodes=new Map();
class Element extends EventTarget {
  constructor(tag='div'){super();this.tag=tag;this.style={};this.classList={add(){},remove(){}};this.children=[];this.value='1';this.clientWidth=824;this.clientHeight=624;this.hidden=false;}
  set innerHTML(value){this.html=value;for(const m of value.matchAll(/id="([^"]+)"/g))nodes.set(m[1],new Element());}
  querySelector(selector){return nodes.get(selector.slice(1));}
  setAttribute(){} removeAttribute(){} append(...nodes){this.children.push(...nodes);} appendChild(node){this.append(node);} replaceChildren(){this.children=[];}
  showModal(){this.open=true;} close(){this.open=false;this.dispatchEvent(new Event('close'));}
  getBoundingClientRect(){return {left:0,top:0,width:800,height:600};}
  async decode(){}
}
const root=new Element();let dialog;
globalThis.document={createElement:tag=>new Element(tag),body:{appendChild:el=>{dialog=el;}},addEventListener:(...args)=>root.addEventListener(...args)};
globalThis.ResizeObserver=class {observe(){}};
let holdImage=false, pendingImage;
globalThis.Image=class {naturalWidth=800;naturalHeight=600;set src(value){if(holdImage)pendingImage=this;else queueMicrotask(()=>this.onload());}};
const $=id=>nodes.get('fringe-lens-'+id);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function drop(file){const e=new Event('drop',{cancelable:true});e.dataTransfer={types:['Files'],files:[file]};dialog.dispatchEvent(e);return e;}
function measure(){for(const [x,y] of [[380,300],[420,300],[80,100],[120,100],[680,500],[720,500]])$('frame').onclick({clientX:x,clientY:y});}

test('maps zoomed image clicks into original image coordinates',()=>{
  assert.deepEqual(calibrationImagePoint(300,250,{left:100,top:100,width:400,height:300},800,600),{x:400,y:300});
  assert.equal(calibrationImagePoint(99,250,{left:100,top:100,width:400,height:300},800,600),null);
});
test('recovers known radial distortion from independent equal-length target samples',()=>{
  const width=800,height=600,k=.12,R=500;
  const distort=p=>{const dx=p.x-400,dy=p.y-300,f=1+k*(dx*dx+dy*dy)/(R*R);return {x:400+dx*f,y:300+dy*f};};
  const samples=[[380,300],[80,100],[680,500],[400,40]].map(([x,y])=>({p1:distort({x,y}),p2:distort({x:x+40,y})}));
  const result=fitLensSamples(samples,width,height);
  assert.ok(Math.abs(result.k1-k)<1e-8);assert.ok(result.after<1e-7);assert.ok(result.before>1);
  assert.equal(fitLensSamples(samples.slice(0,2),width,height),null);
});
test('dialog accepts drops, replaces samples, cancels cleanly, and applies only explicitly',async()=>{
  const applied=[];openFringeLensCal({onConfirm:k=>applied.push(k)});
  assert.equal($('apply').disabled,true);
  assert.equal(drop(new File(['pixels'],'grid.png',{type:'image/png'})).defaultPrevented,true);
  await settle();assert.equal($('filename').textContent,'grid.png');
  measure();assert.equal($('samples').children.length,3);assert.equal($('apply').disabled,false);
  drop(new File(['pixels'],'second.png',{type:'image/png'}));await settle();
  assert.equal($('samples').children.length,0);assert.equal($('apply').disabled,true);
  measure();$('cancel').onclick();assert.deepEqual(applied,[]);
  openFringeLensCal({onConfirm:k=>applied.push(k)});drop(new File(['pixels'],'grid.png',{type:'image/png'}));await settle();measure();
  $('apply').onclick();assert.equal(applied.length,1);assert.ok(Math.abs(applied[0])<1e-8);assert.equal(dialog.open,false);
});
test('in-flight image loading cannot apply old samples or reopen a cancelled session',async()=>{
  let calls=0;openFringeLensCal({onConfirm:()=>calls++});drop(new File(['pixels'],'first.png',{type:'image/png'}));await settle();measure();
  holdImage=true;drop(new File(['pixels'],'slow.png',{type:'image/png'}));
  assert.equal($('apply').disabled,true);$('apply').onclick();assert.equal(calls,0);
  $('cancel').onclick();holdImage=false;pendingImage.onload();await settle();assert.equal(dialog.open,false);assert.equal(calls,0);
});
test('a project change prevents applying calibration to another project',async()=>{
  let current=true,calls=0;openFringeLensCal({onConfirm:()=>calls++,isCurrent:()=>current});drop(new File(['pixels'],'grid.png',{type:'image/png'}));await settle();measure();
  current=false;$('apply').onclick();assert.equal(calls,0);root.dispatchEvent(new Event('mode-switched'));assert.equal(dialog.open,false);
});
