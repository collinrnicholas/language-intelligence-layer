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
      comparable:sameJob&&context(variant)===context(control)}));
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
  root.PERSADO_INTELLIGENCE=Object.freeze({describe,prioritize,comparison,label});
})(typeof self!=='undefined'?self:globalThis);
