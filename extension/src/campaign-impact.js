// Pure calculations shared by the gateway and panel. Rates are fractions,
// relative uplift is not a percentage-point change, and no score is an input.
(function(root){
  const number=v=>typeof v==='number'&&Number.isFinite(v);
  const count=v=>number(v)&&Number.isSafeInteger(v)&&v>=0?v:null;
  const rate=v=>number(v)&&v>=0&&v<=1?v:null;
  function calculate(input){
    const {recipients,baselineClickRate,relativeUplift,conversionPerClick=null,averageOrderValue=null,currency=null}=input;
    const errors=[];
    if(count(recipients)===null)errors.push('Enter a valid recipient count.');
    if(rate(baselineClickRate)===null)errors.push('Enter a baseline click rate from 0% to 100%.');
    if(!number(relativeUplift)||relativeUplift < -1)errors.push('Enter a relative lift of at least −100%.');
    const projected=baselineClickRate*(1+relativeUplift);
    if(number(projected)&&projected>1)errors.push('The assumptions imply a click rate above 100%.');
    if(conversionPerClick!==null&&rate(conversionPerClick)===null)errors.push('Enter a click-to-conversion rate from 0% to 100%.');
    if(averageOrderValue!==null&&(!number(averageOrderValue)||averageOrderValue<0))errors.push('Enter a nonnegative average order value.');
    if(averageOrderValue!==null&&!/^[A-Z]{3}$/.test(currency||''))errors.push('Enter a three-letter currency code.');
    if(errors.length)return {ok:false,errors};
    const additionalClicks=recipients*baselineClickRate*relativeUplift;
    const conversions=conversionPerClick===null?null:additionalClicks*conversionPerClick;
    const revenue=conversions===null||averageOrderValue===null?null:conversions*averageOrderValue;
    if(![additionalClicks,projected,conversions,revenue].every(v=>v===null||number(v)))return {ok:false,errors:['The assumptions exceed the supported numeric range.']};
    return {ok:true,source:'user_scenario',additionalClicks,conversions,revenue,currency:revenue===null?null:currency,
      relativeUplift,percentagePointChange:baselineClickRate*relativeUplift*100,projectedClickRate:projected,
      uncertainty:null};
  }
  const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v??null);
  const segment=c=>canonical(c.recipients?.segment_opts||c.recipients?.segments||null);
  function baseline(current,campaigns,reports,{now=Date.now(),days=180}={}){
    const list=current.recipients?.list_id;
    const byId=new Map(reports.map(r=>[r.id,r]));
    const samples=[],seen=new Set();
    if(list)for(const c of campaigns){
      const r=byId.get(c.id),sent=count(r?.emails_sent),clickRate=rate(r?.clicks?.click_rate);
      const time=Date.parse(r?.send_time||c.send_time||'');
      if(c.id===current.id||c.status!=='sent'||c.type!=='regular'||c.recipients?.list_id!==list||r?.list_id!==list)continue;
      if(segment(c)!==segment(current)||c.tracking?.html_clicks!==true)continue;
      if(current.settings?.folder_id&&c.settings?.folder_id!==current.settings.folder_id)continue;
      if(sent===null||sent===0||clickRate===null||!Number.isFinite(time)||time>now||time<now-days*86400000)continue;
      if(seen.has(c.id))continue;seen.add(c.id);
      samples.push({campaignId:c.id,title:c.settings?.title||r.campaign_title||'Sent campaign',sendTime:r.send_time||c.send_time,
        emailsSent:sent,clickRate,uniqueClicks:count(r.clicks?.unique_clicks),uniqueClickers:count(r.clicks?.unique_subscriber_clicks)});
    }
    const emailsSent=samples.reduce((n,r)=>n+r.emailsSent,0);
    const clickRate=emailsSent?samples.reduce((n,r)=>n+r.emailsSent*r.clickRate,0)/emailsSent:null;
    return {available:clickRate!==null,clickRate,campaignCount:samples.length,emailsSent,samples,windowDays:days,
      method:'Mailchimp reported click rates weighted by emails sent',
      comparability:'Same audience, segment and regular email type'+(current.settings?.folder_id?', and campaign folder':'')+'. Campaign purpose is not otherwise verified.'};
  }
  function reach(c){
    return {count:count(c.status==='sent'?c.emails_sent:c.recipients?.recipient_count),
      kind:c.status==='sent'?'sent':'estimated',source:c.status==='sent'?'emails_sent':'recipients.recipient_count'};
  }
  root.PERSADO_IMPACT=Object.freeze({calculate,baseline,reach,count,rate});
})(typeof self!=='undefined'?self:globalThis);
