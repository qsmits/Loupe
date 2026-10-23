import './dom-stub.js';
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {fitReportImage, createFringeReport} from '../../frontend/fringe-report.js';

it('fits wide, tall and square maps without stretching', () => {
  for (const [w,h] of [[224,176],[80,300],[300,80],[200,200]]) {
    const r=fitReportImage(w,h,{x:10,y:58,w:134,h:112});
    assert.ok(Math.abs(r.w/r.h-w/h)<1e-12);
    assert.ok(r.x>=9.99999 && r.y>=57.99999 && r.x+r.w<=144.00001 && r.y+r.h<=170.00001);
  }
});

it('exports both images, aligned labels and all coefficients across pages', () => {
  class Pdf {
    constructor(){this.pages=1;this.images=[];this.circles=[];this.texts=[];}
    setFontSize(){} setTextColor(){} setDrawColor(){} setFillColor(){} setLineWidth(){} setFont(){} rect(){}
    text(t){this.texts.push(t);} splitTextToSize(s){return [s];}
    getImageProperties(){return {width:224,height:176};}
    addImage(...args){this.images.push(args);}
    circle(...args){this.circles.push(args);}
    addPage(){this.pages++;} getNumberOfPages(){return this.pages;} setPage(){}
  }
  const doc=createFringeReport({reference_image_b64:'source',surface_map:'map',zernike_chart:'chart',
    reference_marks:[{label:'A',x:.2,y:.7}], coefficients:new Array(80).fill(0),wavelength_nm:632.8}, {jsPDF:Pdf});
  assert.equal(doc.images.length,3);
  const a=doc.images[0], b=doc.images[1];
  assert.equal(a[4],b[4]); assert.equal(a[5],b[5]);
  assert.equal(doc.circles.length,4);
  assert.ok(Math.abs((doc.circles[2][0]-b[2])/b[4]-.2)<1e-12);
  assert.ok(doc.texts.includes('80'));
  assert.ok(doc.pages>=3);
});
