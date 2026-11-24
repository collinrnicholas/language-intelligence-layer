// Presentation derived from actual Persado fields. No network calls or score
// thresholds. Scale/schema: official martechapi-cli USER_MANUAL §4/models.go.
(function(root){
  const text=value=>typeof value==='string'?value.trim():'';
  const list=value=>Array.isArray(value)?value.filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim()):[];
  const label=value=>text(value).toLowerCase().replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
  function describe(field){
    const explicit=field.score?.variants?.[0];
    const control=field.optimization?.result?.control;
    const variant=explicit||control||null;
    const score=typeof variant?.performance==='number'&&Number.isFinite(variant.performance)?variant.performance:null;
    const inRange=score!==null&&score>=0&&score<=100;
    const band=text(variant?.performanceBand);
    const rationale=text(variant?.brandRationale);
    const issues=(variant?.compliance?.issues||[]).map(i=>text(i?.description)).filter(Boolean);
    const compliance=text(variant?.compliance?.summary);
    const evaluated=score!==null;
    return {score,inRange,band,bandLabel:label(band),rationale,
      brandFit:typeof variant?.brandAlignment==='number'&&variant.brandAlignment>=0&&variant.brandAlignment<=5?variant.brandAlignment:null,
      emotions:list(variant?.emotions).map(label),descriptors:list(variant?.descriptors).map(label),
      compliance,issues,evaluated,
      status:evaluated?(band?label(band):'Evaluated'):field.score?'Score unavailable':'Not yet evaluated',
      interpretation:evaluated?'Predicted language performance, not measured campaign results.':null,
      explanationUnavailable:evaluated&&!rationale&&!compliance&&!issues.length,
      recommendation:issues.length?'Review the flagged wording before applying alternatives.':rationale
        ?'Use Persado’s brand feedback to revise this copy, or compare an optimized alternative.'
        :evaluated?'Compare an optimized alternative, or edit the saved copy in Mailchimp and score it again.'
        :'Score this element to evaluate its language, or optimize it directly.',
      source:explicit?field.score.kind||'score':control?'optimize':null,
    };
  }
  function prioritize(fields){
    // Neutral editorial review order, not a claim of ROI or a Persado ranking
    // across separate jobs. No band thresholds are derived from the numbers.
    const scored=fields.filter(f=>describe(f).inRange).sort((a,b)=>describe(a).score-describe(b).score);
    return {scored,unscored:fields.filter(f=>!describe(f).inRange),next:scored[0]||null};
  }
  root.PERSADO_INTELLIGENCE=Object.freeze({describe,prioritize,label});
})(typeof self!=='undefined'?self:globalThis);
