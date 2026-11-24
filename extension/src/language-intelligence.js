// Presentation uses actual Persado fields, without thresholds or network calls.
(function(root){
  const text=v=>typeof v==='string'?v.trim():'';
  const label=v=>text(v).toLowerCase().replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
  const score=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
  function guidance(variant){
    const why=text(variant?.performanceWhy);
    const sentences=why.split(/(?<=[.!?])\s+/);
    const weakness=sentences.find(s=>/\b(weakness|implied|unclear|lacks|improve)\b/i.test(s));
    const candidate=weakness||sentences[0]||'';
    const excerpt=candidate.split(', so ')[0];
    if(excerpt&&excerpt.length<=160)return {text:excerpt+(excerpt!==candidate?'…':''),source:'Persado feedback'};
    // Quote a short actionable clause, never generate a reason for a score.
    const rationale=text(variant?.brandRationale);
    const clauses=rationale.split(/(?<=[.!?;])\s+/).map(s=>s.replace(/^To [^,]+,\s*/i,''));
    const action=clauses.find(s=>/^(add|use|tighten|clarify|replace|remove|highlight|focus|include|make|lead|avoid|keep|emphasize)\b/i.test(s)&&s.length<=140);
    return action?{text:action,source:'Persado brand guidance'}:null;
  }
  function describe(field){
    const explicit=field.score?.variants?.[0],control=field.optimization?.result?.control;
    const variant=explicit||control||null,n=score(variant?.performance),band=text(variant?.performanceBand);
    return {score:n,inRange:n!==null&&n>=0&&n<=100,band,bandLabel:label(band),evaluated:n!==null,
      status:n!==null?(band?label(band):'Scored'):field.score?'Score unavailable':'Not yet evaluated',
      guidance:guidance(variant),source:explicit?field.score.kind||'score':control?'optimize':null};
  }
  function comparison(field,index){
    const result=field.optimization?.result||{},control=result.control;
    const context=v=>JSON.stringify(v?.scoringContext??null);
    const sameJob=!!(result.jobId&&result.channel);
    const valid=n=>n!==null&&n>=0&&n<=100;
    const options=(result.alternatives||[]).map((variant,index)=>({variant,index,score:score(variant.performance),
      valid:typeof field.text==='string'?(root.PERSADO_GUARD?.validateRewrite(field.text,variant.touchpoints?.[field.touchpoint]||variant.text,{maxLength:field.maxLength})?.ok??null):null,
      comparable:sameJob&&context(variant)===context(control)})).filter(o=>o.valid!==false);
    options.sort((a,b)=>{
      const x=a.comparable&&valid(a.score),y=b.comparable&&valid(b.score);
      return x&&y?b.score-a.score||(a.variant.rank??a.index)-(b.variant.rank??b.index):x?-1:y?1:(a.variant.rank??a.index)-(b.variant.rank??b.index);
    });
    const limited=options.slice(0,3),chosen=limited.find(x=>x.index===index)||limited[0];
    const variant=chosen?.variant,originalScore=score(control?.performance);
    const delta=chosen?.comparable&&valid(chosen.score)&&valid(originalScore)?chosen.score-originalScore:null;
    return {alternatives:limited.map(x=>x.variant),options:limited,index:chosen?.index??0,variant:variant||null,
      top:!!(chosen&&chosen===limited[0]&&chosen.comparable&&valid(chosen.score)),
      originalScore,delta,score:chosen?.score??null,band:label(variant?.performanceBand),
      guidance:guidance(variant),text:variant?.touchpoints?.[field.touchpoint]||variant?.text||''};
  }
  function prioritize(fields){
    const scored=fields.filter(f=>describe(f).inRange).sort((a,b)=>Number(!!a.templateDefault)-Number(!!b.templateDefault)||describe(a).score-describe(b).score);
    return {scored,unscored:fields.filter(f=>!describe(f).inRange),next:scored[0]||null};
  }
  function outcome(field,{applied=false}={}){
    const info=describe(field),result=field.optimization?.result,choice=comparison(field);
    if(applied)return {kind:'applied',label:'Applied to campaign',message:'',action:null};
    if(choice.variant&&choice.options[0]?.valid===true&&choice.delta>0)
      return {kind:'recommended',label:'Worth improving',message:'A stronger option is available.',action:'apply',reason:'higher_comparable_score'};
    if(result){
      if(result.notice?.code==='performance_floor')return {kind:'good',label:'Looking good',message:'No changes recommended.',action:null,reason:'performance_floor'};
      if(choice.options.length&&choice.options.every(o=>o.valid===true&&o.comparable&&o.score!==null&&o.score>=0&&o.score<=100&&choice.originalScore!==null&&choice.originalScore>=0&&choice.originalScore<=100&&o.score<=choice.originalScore))
        return {kind:'good',label:'Looking good',message:'No changes recommended.',action:null,reason:'no_higher_returned_score'};
      return {kind:'unavailable',label:'Recommendation unavailable',message:choice.options.length?'Options need review.':'No usable recommendation returned.',action:'review',reason:'unverified_alternatives'};
    }
    const variant=field.score?.variants?.[0],p=variant?.potential;
    const potentialValid=p&&info.inRange&&p.current===info.score&&typeof p.projected==='number'&&p.projected>=0&&p.projected<=100&&p.headroomPoints===p.projected-p.current;
    if(potentialValid&&p.state==='healthy'&&p.headroomPoints===0)
      return {kind:'good',label:'Looking good',message:'No changes recommended.',action:null,reason:'provider_healthy_potential'};
    if(potentialValid&&p.headroomPoints>0)
      return {kind:'opportunity',label:'Worth improving',message:'An opportunity to improve.',action:'optimize',reason:'provider_headroom'};
    if(field.score||info.evaluated)return {kind:'unavailable',label:'Recommendation unavailable',message:'Checked; no recommendation evidence returned.',action:'review',reason:'insufficient_evidence'};
    return {kind:'unchecked',label:'Not checked',message:'Ready to check.',action:'score'};
  }
  function organize(fields,{appliedField=null}={}){
    const firstCta=fields.find(f=>f.touchpoint==='cta'&&!f.templateDefault);
    const context=f=>f.field==='subject_line'?0:f===firstCta?1:f.field==='preview_text'?2:f.touchpoint==='cta'?4:3;
    const states=new Map(fields.map(f=>[f.field,outcome(f,{applied:f.field===appliedField})]));
    const order=(a,b)=>Number(!!a.templateDefault)-Number(!!b.templateDefault)
      ||Number(!!a.applyDisabledReason)-Number(!!b.applyDisabledReason)
      ||Number(states.get(a.field).kind!=='recommended')-Number(states.get(b.field).kind!=='recommended')
      ||(describe(a).score??Infinity)-(describe(b).score??Infinity)||context(a)-context(b);
    const opportunities=fields.filter(f=>['recommended','opportunity'].includes(states.get(f.field).kind)).sort(order);
    const ofKind=kind=>fields.filter(f=>states.get(f.field).kind===kind).sort((a,b)=>Number(!!a.templateDefault)-Number(!!b.templateDefault)||context(a)-context(b));
    const unchecked=ofKind('unchecked'),unavailable=ofKind('unavailable');
    return {states,opportunities,good:ofKind('good'),unchecked,unavailable,applied:ofKind('applied'),
      checked:fields.filter(f=>describe(f).inRange).length,next:opportunities[0]||unchecked[0]||unavailable[0]||null};
  }
  root.PERSADO_INTELLIGENCE=Object.freeze({describe,prioritize,comparison,outcome,organize,label});
})(typeof self!=='undefined'?self:globalThis);
