import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fitParallelStep } from '../../frontend/fringe-math.js';
import { fitRadialK1, correctedRadialLength, undistortRadialPoint } from '../../frontend/math.js';

describe('radial calibration uses the remapper forward model', () => {
  for (const k of [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.4]) {
    it(`recovers k1=${k} and equal 60-pixel lengths`, () => {
      const distort = p => {
        const x = p.x-400, y = p.y-300, s = 1+k*(x*x+y*y)/250000;
        return { x: 400+x*s, y: 300+y*s };
      };
      const samples = [[350,300], [570,300], [580,480], [300,100], [180,430]]
        .map(([x,y]) => ({ p1: distort({x,y}), p2: distort({x:x+60,y}) }));
      const fitted = fitRadialK1(samples, 800, 600);
      assert.ok(Math.abs(fitted-k) < 1e-7, `fitted ${fitted}`);
      for (const s of samples) assert.ok(Math.abs(correctedRadialLength(s, fitted, 800, 600)-60) < 1e-5);
    });
  }
  it('rejects points beyond the monotonic inverse branch', () => {
    assert.equal(undistortRadialPoint({x:800,y:600}, -.3, 800, 600), null);
  });
});

describe('step measurement fits parallel planes rather than regional means', () => {
  const rows = 80, cols = 100, mask = Array(rows*cols).fill(1);
  const A = {x0:.1, x1:.39, y0:.2, y1:.8}, B = {x0:.6, x1:.89, y0:.2, y1:.8};
  const make = (a,b,sign=1) => Array.from({length:rows*cols}, (_,i) => {
    const x=(i%cols)/cols, y=Math.floor(i/cols)/rows;
    return sign*(a*x+b*y+45+(x>=.5 ? 100 : 0));
  });
  for (const [a,b] of [[0,0], [1000,-300], [-500,800]]) {
    it(`is invariant to carrier/wedge slope ${a},${b}`, () => {
      const r = fitParallelStep(make(a,b),mask,rows,cols,A,B,12);
      assert.ok(!r.error, r.error);
      assert.ok(Math.abs(r.step+100)<1e-8);
      assert.ok(r.sem<1e-8);
      assert.deepEqual(r.warnings, []);
    });
  }
  it('preserves the explicitly chosen sign', () => {
    assert.ok(Math.abs(fitParallelStep(make(300,200,-1),mask,rows,cols,A,B).step-100)<1e-8);
  });
  it('rejects overlapping regions and absent raw data', () => {
    assert.match(fitParallelStep(make(0,0),mask,rows,cols,A,A).error,/overlap/);
    assert.match(fitParallelStep(null,mask,rows,cols,A,B).error,/Raw height/);
  });
  it('rejects line-like regions and flags nonparallel plateaus', () => {
    assert.match(fitParallelStep(make(0,0),mask,rows,cols,{...A,y0:.5,y1:.5},B).error,/two-dimensional/);
    const grid=make(0,0).map((z,i)=>z+(i%cols>=50 ? 100*(i%cols)/cols : 0));
    assert.ok(fitParallelStep(grid,mask,rows,cols,A,B).warnings.length>0);
  });
  it('includes the uncertainty of extrapolating the shared slope', () => {
    let seed=9127;
    const uniform=()=>{ seed=(1664525*seed+1013904223)>>>0; return (seed+.5)/4294967296; };
    const normal=()=>Math.sqrt(-2*Math.log(uniform()))*Math.cos(2*Math.PI*uniform());
    const steps=[], errors=[];
    for (let i=0;i<100;i++) {
      const noisy=make(300,-200).map(z=>z+.5*normal());
      const r=fitParallelStep(noisy,mask,rows,cols,A,B);
      steps.push(r.step); errors.push(r.sem);
    }
    const mean=steps.reduce((a,b)=>a+b)/steps.length;
    const observed=Math.sqrt(steps.reduce((v,s)=>v+(s-mean)**2,0)/(steps.length-1));
    const predicted=errors.reduce((a,b)=>a+b)/errors.length;
    assert.ok(observed/predicted>.75 && observed/predicted<1.25, `${observed} vs ${predicted}`);
    // RMS/sqrt(N_A)+RMS/sqrt(N_B) alone would be about 0.018 nm here.
    assert.ok(predicted>.04);
  });
});
