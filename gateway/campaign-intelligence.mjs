// Read-only, bounded Mailchimp reporting. This service never calls Persado.
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const context=vm.createContext({});
vm.runInContext(readFileSync(new URL('../extension/src/campaign-impact.js',import.meta.url),'utf8'),context);
export const impact=context.PERSADO_IMPACT;
export function createCampaignIntelligence({adapter,now=Date.now,ttlMs=300000}={}){
  const cache=new Map(),inflight=new Map();
  async function cached(key,fn){
    const old=cache.get(key);if(old&&now()-old.at<ttlMs)return {...old.data,cached:true};
    if(inflight.has(key))return inflight.get(key);
    const task=(async()=>{const data=await fn();cache.set(key,{at:now(),data});if(cache.size>50)cache.delete(cache.keys().next().value);return data;})();
    inflight.set(key,task);try{return await task;}finally{inflight.delete(key);}
  }
  function metrics(c,r){
    const ecommerce=c.tracking?.ecomm360===true||r.ecommerce?.total_orders>0||r.ecommerce?.total_revenue>0;
    return {campaignId:c.id,title:c.settings?.title||r.campaign_title||'',status:c.status,sendTime:r.send_time||null,
      emailsSent:impact.count(r.emails_sent),clickRate:impact.rate(r.clicks?.click_rate),uniqueClicks:impact.count(r.clicks?.unique_clicks),
      uniqueClickers:impact.count(r.clicks?.unique_subscriber_clicks),
      ecommerce:ecommerce?{orders:impact.count(r.ecommerce?.total_orders),revenue:typeof r.ecommerce?.total_revenue==='number'&&Number.isFinite(r.ecommerce.total_revenue)&&r.ecommerce.total_revenue>=0?r.ecommerce.total_revenue:null,currency:typeof r.ecommerce?.currency_code==='string'?r.ecommerce.currency_code:null}:null,
      source:'Mailchimp report',fetchedAt:now(),attribution:'observed',verifiedIncrementalOutcome:null};
  }
  return {
    insights(c){return cached('insights:'+c.id+':'+JSON.stringify([c.recipients,c.settings?.folder_id,c.status]),async()=>{
      const a=adapter(),list=c.recipients?.list_id;
      const [campaigns,reports]=await Promise.all([list?a.listSentCampaigns(list):[],a.listReports()]);
      // The list endpoint is bounded; fetch missing selected reports, at most ten.
      const ids=new Set(reports.map(r=>r.id));
      const missing=campaigns.filter(x=>!ids.has(x.id)).slice(0,10);
      for(const item of missing){try{reports.push(await a.getReport(item.id));}catch(e){if(e.kind!=='not_found')throw e;}}
      return {baseline:impact.baseline(c,campaigns,reports,{now:now()}),
        history:reports.slice(0,30).map(r=>({campaignId:r.id,title:r.campaign_title||'Sent campaign',sendTime:r.send_time||null})),
        reach:impact.reach(c),status:c.status,fetchedAt:now(),forecast:null};
    });},
    report(id){return cached('report:'+id,async()=>{
      const a=adapter(),c=await a.getCampaign(id);
      if(c.status!=='sent')throw Object.assign(new Error('Post-send reporting is available after the campaign is sent.'),{kind:'report_unavailable'});
      return metrics(c,await a.getReport(id));
    });},
  };
}
