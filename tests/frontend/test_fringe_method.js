import { resetElements } from './dom-stub.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { analysisMethodLabel } from '../../frontend/fringe-method.js';
import { fr } from '../../frontend/fringe.js';
import { mergeReanalyzeResult } from '../../frontend/fringe-results.js';
import { captureInstrument, restoreInstrument } from '../../frontend/instrument-workspace.js';
import { qualityDescription } from '../../frontend/fringe-quality.js';

it('defaults to current, persists an explicit choice, and preserves result provenance through inversion',()=>{
  resetElements();
  assert.equal(fr.analysisMethod,'current');
  fr.analysisMethod='hybrid';
  fr.lastResult={analysis_method:'hybrid',hybrid_diagnostics:{local_pixels:10}};
  const saved=captureInstrument(fr,{analysisMethod:'current',lastResult:null},null);
  restoreInstrument(fr,{analysisMethod:'current',lastResult:null},null,null);
  assert.equal(fr.analysisMethod,'current');
  restoreInstrument(fr,{analysisMethod:'current',lastResult:null},saved,null);
  assert.equal(fr.analysisMethod,'hybrid');
  mergeReanalyzeResult({pv_nm:4});
  assert.equal(fr.lastResult.analysis_method,'hybrid');
  assert.equal(fr.lastResult.hybrid_diagnostics.local_pixels,10);
});
it('labels methods and avoids calling unknown or derived results current',()=>{
  assert.equal(analysisMethodLabel({analysis_method:'current'}),'Current method');
  assert.match(analysisMethodLabel({analysis_method:'hybrid'}),/experimental/);
  assert.match(analysisMethodLabel({}),/not recorded/);
  assert.match(analysisMethodLabel({origin:'average'}),/Derived/);
});
it('describes adaptive hybrid coverage and the original estimator separately',()=>{
  const text=qualityDescription({analysis_method:'hybrid',hybrid_diagnostics:{local_pixels:100,added_pixels:20,fallback_pixels:40,sigma_across_px:5,sigma_along_px:2.5},analysis_filter:{boundary_band_px:25,sigma_across_px:5,sigma_along_px:2}}).join(' ');
  assert.match(text,/adaptive boundary/);
  assert.match(text,/20 added/);
  assert.match(text,/fallback estimator/);
  assert.doesNotMatch(text,/Boundary exclusion: about 25/);
});
