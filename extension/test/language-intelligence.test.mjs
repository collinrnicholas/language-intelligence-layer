import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './helpers.mjs';
await load('guard.js','language-intelligence.js');
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

test('highest comparable actual score is selected before the three-option cap, with original provider indices retained',()=>{
 const f={touchpoint:'preheader',score:{variants:[{performance:99}]},optimization:{result:{jobId:'job_a',channel:'EMAIL_SUBJECT_BODY',control:{performance:51},alternatives:[{rank:1,text:'First',performance:65},{rank:2,text:'Second',performance:69},{rank:3,text:'Third'},{rank:4,text:'Fourth',performance:67}]}}};
 const top=comparison(f);assert.equal(top.index,1);assert.equal(top.text,'Second');assert.equal(top.delta,18);assert.equal(top.top,true);
 assert.deepEqual(top.options.map(o=>o.index),[1,3,0]);
 const manual=comparison(f,0);assert.equal(manual.text,'First');assert.equal(manual.delta,14);assert.equal(manual.top,false);
 assert.equal(comparison(f,manual.index).index,0);
});
test('separate score jobs, missing scores and differing scoring contexts cannot manufacture an improvement',()=>{
 const result={jobId:'job_b',channel:'EMAIL_SUBJECT_BODY',control:{performance:51,scoringContext:'model-a'},alternatives:[{performance:80,scoringContext:'model-b',text:'Different context'},{performance:69,scoringContext:'model-a',text:'Comparable'},{text:'No score'}]};
 const f={score:{variants:[{performance:20}]},optimization:{result}};
 assert.equal(comparison(f).text,'Comparable');assert.equal(comparison(f).delta,18);
 assert.equal(comparison(f,0).delta,null);assert.equal(comparison(f,2).delta,null);
 delete result.control;assert.equal(comparison(f).delta,null);
});
test('template defaults do not displace marketer-authored opportunities merely because their score is lower',()=>{
 const custom=field(51),template={...field(12),templateDefault:true};assert.equal(prioritize([template,custom]).next,custom);
});

const {outcome,organize}=globalThis.PERSADO_INTELLIGENCE;
const potential=(n,projected,state='band_change')=>({current:n,projected,headroomPoints:projected-n,state});
const optimized=(alternatives,control=51,notice=null)=>({...field(control),touchpoint:'preheader',maxLength:150,optimization:{result:{kind:'optimize',jobId:'job_outcome',channel:'EMAIL_SUBJECT_BODY',control:{performance:control},alternatives,notice}}});
test('Looking good requires actual provider evidence, never an invented band threshold',()=>{
 assert.equal(outcome(field(87,{performanceBand:'excellent',potential:potential(87,87,'healthy')})).kind,'good');
 for(const n of [0,51,87,100])assert.equal(outcome(field(n,{performanceBand:'excellent'})).kind,'unavailable');
 assert.equal(outcome(field(87,{potential:{...potential(87,87,'healthy'),current:51}})).kind,'unavailable');
});
test('provider headroom before optimization does not claim a stronger version exists',()=>{
 const s=outcome(field(51,{performanceBand:'fair',potential:potential(51,70)}));
 assert.equal(s.kind,'opportunity');assert.equal(s.action,'optimize');assert.doesNotMatch(s.message,/available|stronger/);
});
test('recommendation picks the highest eligible evaluated alternative while preserving provider index',()=>{
 const f=optimized([{performance:99,rank:1,text:'Save 90% today'},{performance:65,rank:2,text:'Preview your message before sending'},{performance:69,rank:3,text:'One preview before the real send'}]);
 assert.equal(comparison(f).index,2);assert.equal(outcome(f).kind,'recommended');assert.equal(outcome(f).action,'apply');
 assert.match(outcome(f).message,/A stronger option is available/);
});
test('no-improvement results produce no recommendation or automatic retry',()=>{
 const floor=optimized([],87,{code:'performance_floor',message:'No improvement found'});
 assert.equal(outcome(floor).kind,'good');assert.equal(outcome(floor).action,null);
 const weaker=optimized([{performance:65,text:'Review your preview before sending'}],69);
 assert.equal(outcome(optimized([{performance:65,text:'Review your preview before sending'}],200)).kind,'unavailable');
 assert.equal(outcome(weaker).kind,'good');assert.doesNotMatch(outcome(weaker).message,/stronger option/);
});
test('unsafe, absent, unscored and differently scored alternatives cannot claim a stronger option',()=>{
 for(const f of [optimized([{performance:99,text:'Save 90% now'}]),optimized([{text:'Review your message before sending'}]),optimized([])])assert.equal(outcome(f).kind,'unavailable');
 const f=optimized([{performance:99,scoringContext:'different',text:'Review this clear message before sending'}]);assert.equal(outcome(f).kind,'unavailable');
 assert.equal(outcome({field:'subject_line',text:'Your next message is ready'}).kind,'unchecked');
});
test('applied is a separate UI state and never evidence of measured improvement',()=>{
 const s=outcome(field(69),{applied:true});assert.equal(s.kind,'applied');assert.equal(s.label,'Applied to campaign');assert.equal(s.action,null);
 assert.doesNotMatch(JSON.stringify(s),/lift|clicks|conversions|revenue|guarantee/);
});
test('recommendations precede pending work; subject and primary CTA break otherwise equal evidence ties',()=>{
 const preview=optimized([{performance:69,text:'One preview before sending'}]);
 const subject={...preview,field:'subject_line',touchpoint:'subject_line'};
 const waiting={...field(20,{potential:potential(20,50)}),field:'body:b0',location:'html',applyDisabledReason:'Read only'};
 const good={...field(87,{potential:potential(87,87,'healthy')}),field:'good'};
 const unchecked={field:'new',text:'Review this new message'};
 const r=organize([preview,waiting,subject,good,unchecked]);assert.equal(r.next,subject);assert.deepEqual(r.opportunities,[subject,preview,waiting]);assert.deepEqual(r.good,[good]);assert.deepEqual(r.unchecked,[unchecked]);assert.equal(r.checked,4);
 const after=organize([subject,good,unchecked],{appliedField:'subject_line'});assert.equal(after.next,unchecked);assert.deepEqual(after.applied,[subject]);
});

test('small headroom and small gains are not called opportunities (audit #7)',()=>{
 const {MIN_HEADROOM_POINTS:h,MIN_IMPROVEMENT_POINTS:g}=globalThis.PERSADO_INTELLIGENCE;
 assert.equal(outcome(field(60,{potential:potential(60,60+h-1)})).kind,'good');
 assert.equal(outcome(field(60,{potential:potential(60,60+h)})).kind,'opportunity');
 const opt=d=>optimized([{performance:51+d,text:'Review your message before you send it'}]);
 assert.equal(outcome(opt(g-1)).kind,'good');
 assert.equal(outcome(opt(g-1)).reason,'marginal_gain');
 assert.equal(outcome(opt(g)).kind,'recommended');
});

test('unavailable is explicit and recoverable, never grouped as unchecked',()=>{
 const s=outcome(field(51,{performanceBand:'fair'}));
 assert.equal(s.kind,'unavailable');assert.equal(s.action,'optimize');assert.notEqual(s.label,'Not checked');
});
