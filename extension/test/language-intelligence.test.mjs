import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './helpers.mjs';
await load('language-intelligence.js');
const {describe,prioritize}=globalThis.PERSADO_INTELLIGENCE;
const field=(n,extra={})=>({field:'preview_text',text:'Saved preview',score:{kind:'score',variants:[{performance:n,...extra}]}});

test('score-only response remains neutral, with an action and no fabricated model reason or band',()=>{
 const r=describe(field(51));assert.equal(r.score,51);assert.equal(r.band,'');
 assert.equal(r.status,'Evaluated');assert.equal(r.explanationUnavailable,true);
 assert.equal(r.rationale,'');assert.match(r.recommendation,/optimized alternative/);
 assert.doesNotMatch(JSON.stringify(r),/poor|weak|ROI|confidence|lift|fair/);
});
test('band and brand rationale retain their API provenance, including linguistic tags',()=>{
 const r=describe(field(51,{performanceBand:'fair',brandRationale:'The wording is generic for this brand.',brandAlignment:3,emotions:['CURIOSITY'],descriptors:['BRAND_MENTION']}));
 assert.equal(r.bandLabel,'Fair');assert.equal(r.rationale,'The wording is generic for this brand.');
 assert.equal(r.brandFit,3);assert.deepEqual(r.emotions,['Curiosity']);assert.deepEqual(r.descriptors,['Brand mention']);
 assert.equal(r.source,'score');assert.match(r.recommendation,/brand feedback/);
});
test('optimization control scores are real evaluations without requiring another scoring call',()=>{
 const r=describe({optimization:{result:{control:{performance:78,performanceBand:'strong'}}}});
 assert.equal(r.score,78);assert.equal(r.source,'optimize');assert.equal(r.bandLabel,'Strong');
});
test('review order comes from returned numbers and keeps unscored content separate',()=>{
 const subject={...field(87),field:'subject_line'},preview=field(51),missing={field:'body:b0'};
 const result=prioritize([subject,missing,preview]);assert.equal(result.next,preview);
 assert.deepEqual(result.scored,[preview,subject]);assert.deepEqual(result.unscored,[missing]);
 assert.equal(describe(missing).status,'Not yet evaluated');
});
test('no score thresholds or guesses at absent/invalid scores; zero is a real score',()=>{
 assert.equal(describe(field(0)).inRange,true);assert.equal(describe(field(null)).score,null);
 assert.equal(describe(field(NaN)).score,null);assert.equal(describe(field(150)).inRange,false);
 assert.equal(describe({score:{variants:[]}}).status,'Score unavailable');
 assert.equal(prioritize([field(150)]).next,null);
});
test('compliance issues guide the next action only when returned',()=>{
 const r=describe(field(65,{compliance:{summary:'Review this claim.',issues:[{description:'An unsupported rate claim.'}]}}));
 assert.deepEqual(r.issues,['An unsupported rate claim.']);assert.match(r.recommendation,/flagged wording/);
 assert.equal(r.explanationUnavailable,false);
});
