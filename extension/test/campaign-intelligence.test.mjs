import test from 'node:test';
import assert from 'node:assert/strict';
import {createCampaignIntelligence} from '../../gateway/campaign-intelligence.mjs';
const c={id:'d',status:'save',recipients:{list_id:'a',recipient_count:0},settings:{title:'Draft'}};
test('reporting coalesces/cache reads, expires them, and never invokes write or Persado APIs',async()=>{
 let now=1000,calls=0;
 const adapter=()=>({listSentCampaigns:async()=>{calls++;return [];},listReports:async()=>{calls++;return [];}});
 const s=createCampaignIntelligence({adapter,now:()=>now,ttlMs:100});
 const [a,b]=await Promise.all([s.insights(c),s.insights(c)]);
 assert.equal(calls,2);assert.equal(a.reach.count,0);assert.equal(a.baseline.available,false);assert.equal(a.forecast,null);
 await s.insights(c);assert.equal(calls,2);now+=101;await s.insights(c);assert.equal(calls,4);
});
test('transient reporting failures are not cached as successful empty history',async()=>{
 let fail=true;
 const s=createCampaignIntelligence({adapter:()=>({listSentCampaigns:async()=>[],listReports:async()=>{if(fail)throw Error('offline');return [];}})});
 await assert.rejects(s.insights(c),/offline/);fail=false;assert.equal((await s.insights(c)).baseline.available,false);
});
test('post-send metrics remain observations and absent ecommerce is not fabricated as tracked zero',async()=>{
 const s=createCampaignIntelligence({adapter:()=>({getCampaign:async()=>({...c,status:'sent',tracking:{ecomm360:false}}),getReport:async()=>({emails_sent:20,clicks:{click_rate:.1,unique_clicks:3,unique_subscriber_clicks:2},ecommerce:{total_orders:0,total_revenue:0}})})});
 const r=await s.report('d');assert.equal(r.emailsSent,20);assert.equal(r.uniqueClicks,3);assert.equal(r.ecommerce,null);
 assert.equal(r.attribution,'observed');assert.equal(r.verifiedIncrementalOutcome,null);
});
test('tracked ecommerce preserves actual metrics and currency without assuming a conversion rate',async()=>{
 const s=createCampaignIntelligence({adapter:()=>({getCampaign:async()=>({...c,status:'sent',tracking:{ecomm360:true}}),getReport:async()=>({ecommerce:{total_orders:2,total_revenue:40,currency_code:'EUR'}})})});
 const r=await s.report('d');assert.deepEqual(r.ecommerce,{orders:2,revenue:40,currency:'EUR'});assert.equal(r.clickRate,null);
 assert.ok(!('conversionRate' in r));
});
test('draft campaigns cannot produce a post-send report',async()=>{
 let requested=false;const s=createCampaignIntelligence({adapter:()=>({getCampaign:async()=>c,getReport:async()=>{requested=true;}})});
 await assert.rejects(s.report('d'),/after the campaign is sent/);assert.equal(requested,false);
});
