import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './helpers.mjs';
await load('language-intelligence.js');
const {describe,prioritize,comparison}=globalThis.PERSADO_INTELLIGENCE;
const field=(n,extra={})=>({field:'preview_text',text:'Saved preview',score:{kind:'score',variants:[{performance:n,...extra}]}});
test('numeric-only score remains neutral without a fabricated band, reason or lift',()=>{
 const r=describe(field(51));assert.equal(r.score,51);assert.equal(r.band,'');assert.equal(r.guidance,null);
 assert.doesNotMatch(JSON.stringify(r),/poor|weak|ROI|confidence|lift|fair/);
});
test('band labels come from the response rather than local thresholds',()=>{
 assert.equal(describe(field(51,{performanceBand:'fair'})).bandLabel,'Fair');
 assert.equal(describe(field(51,{performanceBand:'excellent'})).bandLabel,'Excellent');
 assert.equal(describe(field(87)).bandLabel,'');
});
test('short brand guidance quotes only an actual action clause, without ratings or emotional claims',()=>{
 const r=describe(field(51,{brandRationale:'Clear wording. To reflect the brand, tighten the phrasing.',brandAlignment:3,emotions:['CURIOSITY']}));
 assert.deepEqual(r.guidance,{text:'tighten the phrasing.',source:'Persado brand guidance'});
 assert.ok(!('brandFit' in r));assert.ok(!('emotions' in r));
 assert.equal(describe(field(51,{brandRationale:'It lacks a strong brand voice.'})).guidance,null);
 assert.equal(describe(field(51,{brandRationale:'Add '+ 'details '.repeat(30)})).guidance,null);
});
test('real performance feedback is distinguished from brand guidance without generating an explanation',()=>{
 const why='The message creates curiosity. A minor weakness is that the value is implied, so readers need context.';
 const g=describe(field(51,{performanceWhy:why,brandRationale:'Add urgency.'})).guidance;
 assert.deepEqual(g,{text:'A minor weakness is that the value is implied…',source:'Persado feedback'});
});
test('optimization control gives a genuine score without another scoring call',()=>{
 assert.equal(describe({optimization:{result:{control:{performance:78,performanceBand:'strong'}}}}).score,78);
});
test('review order separates unscored content and preserves zero',()=>{
 const a=field(87),b=field(51),missing={field:'body:b0'},zero=field(0);
 assert.deepEqual(prioritize([a,missing,b,zero]).scored,[zero,b,a]);
 assert.deepEqual(prioritize([a,missing]).unscored,[missing]);
 assert.equal(prioritize([field(150)]).next,null);assert.equal(describe(field(NaN)).score,null);
});
test('comparison caps choices at three, uses actual predictions and does not infer absent scores',()=>{
 const f={touchpoint:'preheader',optimization:{result:{alternatives:[{performance:71,touchpoints:{preheader:'First'}},{text:'Second'},{performance:0,text:'Third'},{performance:99,text:'Fourth'}]}}};
 assert.equal(comparison(f).text,'First');assert.equal(comparison(f).alternatives.length,3);
 assert.equal(comparison(f,1).score,null);assert.equal(comparison(f,2).score,0);assert.equal(comparison(f,3).index,0);
 assert.ok(!('uplift' in comparison(f)));
});
