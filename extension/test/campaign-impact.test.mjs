import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './helpers.mjs';
await load('campaign-impact.js');
const {calculate,baseline,reach}=globalThis.PERSADO_IMPACT;
const input={recipients:10000,baselineClickRate:.02,relativeUplift:.1,conversionPerClick:.05,averageOrderValue:100,currency:'USD'};
test('impact uses relative lift and click-to-conversion denominator, with no score inputs',()=>{
 const r=calculate(input);assert.equal(r.additionalClicks,20);assert.equal(r.conversions,1);assert.equal(r.revenue,100);
 assert.equal(r.percentagePointChange,.2);assert.equal(r.source,'user_scenario');assert.equal(r.uncertainty,null);
});
test('missing optional metrics remain absent; missing prerequisites never become zero',()=>{
 const r=calculate({...input,conversionPerClick:null});assert.equal(r.conversions,null);assert.equal(r.revenue,null);
 for(const k of ['recipients','baselineClickRate','relativeUplift'])assert.equal(calculate({...input,[k]:null}).ok,false);
 assert.equal(calculate({...input,currency:null}).ok,false);
});
test('zero volumes and rates remain genuine zeros, not unavailable',()=>{
 assert.equal(calculate({...input,recipients:0}).additionalClicks,0);
 assert.equal(calculate({...input,baselineClickRate:0}).revenue,0);
 assert.equal(calculate({...input,conversionPerClick:0}).conversions,0);
});
test('invalid rates, negative reach, impossible projected rates and overflow are refused',()=>{
 for(const patch of [{recipients:-1},{recipients:1.5},{baselineClickRate:2},{relativeUplift:-1.1},{relativeUplift:Infinity},{conversionPerClick:-.1},{averageOrderValue:-1},{baselineClickRate:.9,relativeUplift:1},{averageOrderValue:1e308,conversionPerClick:1}])assert.equal(calculate({...input,...patch}).ok,false,JSON.stringify(patch));
 assert.equal(calculate({...input,relativeUplift:-.5}).additionalClicks,-100);
});
test('draft reach uses only intended recipients and sent reach uses finalized volume',()=>{
 assert.deepEqual(reach({status:'save',emails_sent:999,recipients:{recipient_count:1}}),{count:1,kind:'estimated',source:'recipients.recipient_count'});
 assert.equal(reach({status:'save',emails_sent:0}).count,null);
 assert.equal(reach({status:'save',recipients:{recipient_count:0}}).count,0);
 assert.equal(reach({status:'sent',emails_sent:50,recipients:{recipient_count:100}}).count,50);
});
const now=Date.parse('2026-11-24T12:00:00Z');
const current={id:'draft',recipients:{list_id:'a'},settings:{}};
const campaign=(id,extra={})=>({id,type:'regular',status:'sent',recipients:{list_id:'a'},tracking:{html_clicks:true},settings:{},...extra});
const report=(id,sent,rate,extra={})=>({id,list_id:'a',emails_sent:sent,send_time:'2026-11-01T12:00:00Z',clicks:{click_rate:rate},...extra});
test('historical baseline is weighted by emails sent and lists its actual sample',()=>{
 const r=baseline(current,[campaign('a'),campaign('b'),campaign('b')],[report('a',100,.1),report('b',900,.02)],{now});
 assert.equal(r.clickRate,.028);assert.equal(r.emailsSent,1000);assert.equal(r.campaignCount,2);
});
test('baseline excludes mismatched audience, segment, purpose folder, tracking, invalid rates, old and zero sends',()=>{
 const campaigns=[campaign('wrong',{recipients:{list_id:'b'}}),campaign('seg',{recipients:{list_id:'a',segment_opts:{saved_segment_id:1}}}),campaign('off',{tracking:{html_clicks:false}}),campaign('old'),campaign('zero'),campaign('bad')];
 const reports=[report('wrong',100,.1,{list_id:'b'}),report('seg',100,.1),report('off',100,.1),report('old',100,.1,{send_time:'2020-01-01'}),report('zero',0,.2),report('bad',100,2)];
 assert.equal(baseline(current,campaigns,reports,{now}).available,false);
 assert.equal(baseline({...current,settings:{folder_id:'purpose'}},[campaign('a')],[report('a',100,.1)],{now}).available,false);
 assert.equal(baseline({...current,recipients:{}},[campaign('a')],[report('a',100,.1)],{now}).clickRate,null);
});
