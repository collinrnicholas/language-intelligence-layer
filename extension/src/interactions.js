// Small presentation-only helpers. No provider requests, timers for fake work,
// score interpolation or dependencies. CSS owns the shared motion tokens.
(function(root){
  const doc=root.document,preference=root.matchMedia?.('(prefers-reduced-motion: reduce)');
  const active=new Map(),disclosures=new Map();
  const enabled=()=>!preference?.matches;
  const token=(name,fallback)=>{try{return root.getComputedStyle(doc.documentElement).getPropertyValue(name).trim()||fallback;}catch{return fallback;}};
  const duration=name=>parseFloat(token(name,'200ms'))||200;
  function stop(el){const old=active.get(el);if(old){active.delete(el);old.cancel();}}
  function play(el,frames,time='--motion-standard',done){
    if(!el)return null;stop(el);
    if(!enabled()||!el.animate){done?.();return null;}
    try{
      const animation=el.animate(frames,{duration:duration(time),easing:token('--motion-ease','ease-out')});
      active.set(el,animation);
      animation.finished.then(()=>{if(active.get(el)===animation){active.delete(el);done?.();}},()=>{});
      return animation;
    }catch{done?.();return null;}
  }
  function reveal(el){return play(el,[{opacity:.35,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}]);}
  function confirm(el){return play(el,[{backgroundColor:token('--green-bg','#ECFDF5')},{backgroundColor:'transparent'}],'--motion-layout');}
  function key(el){return el.nodeType===1?(el.dataset.key||el.dataset.motionKey||null):null;}
  function update(container,html){
    const before=new Map([...container.querySelectorAll('[data-key]')].map(el=>[el.dataset.key,el.getBoundingClientRect()]));
    const old=new Map([...container.querySelectorAll('[data-key],[data-motion-key]')].map(el=>[key(el),el]));
    const template=doc.createElement('template');template.innerHTML=html;
    const used=new Set();
    function patch(parent,source){
      const previous=[...parent.childNodes],children=[];
      for(const fresh of [...source.childNodes]){
        const k=key(fresh);
        let target=k?old.get(k):previous[children.length];
        if(!target||used.has(target)||target.nodeType!==fresh.nodeType||target.nodeName!==fresh.nodeName||(!k&&key(target)))target=fresh.cloneNode(false);
        used.add(target);
        if(fresh.nodeType===1){
          // An interrupted disclosure must settle before syncing its real state.
          if(disclosures.has(target)){stop(target);disclosures.delete(target);target.style.height='';target.style.overflow='';}
          for(const a of [...target.attributes])if(!fresh.hasAttribute(a.name))target.removeAttribute(a.name);
          for(const a of fresh.attributes)if(target.getAttribute(a.name)!==a.value)target.setAttribute(a.name,a.value);
          patch(target,fresh);
          if(fresh.tagName==='SELECT')target.value=fresh.value;
        }else if(target.nodeValue!==fresh.nodeValue)target.nodeValue=fresh.nodeValue;
        children.push(target);
      }
      if(children.length!==parent.childNodes.length||children.some((c,i)=>parent.childNodes[i]!==c))parent.replaceChildren(...children);
    }
    patch(container,template.content);
    for(const el of container.querySelectorAll('[data-key]')){
      const from=before.get(el.dataset.key),to=el.getBoundingClientRect();
      if(!from||!from.height||!to.height)continue;
      const dy=from.top-to.top;
      if(Math.abs(dy)>1&&Math.abs(dy)<root.innerHeight)play(el,[{transform:`translateY(${dy}px)`},{transform:'translateY(0)'}],'--motion-layout');
    }
  }
  function disclose(details,open){
    const current=details.getBoundingClientRect().height;
    stop(details);disclosures.delete(details);details.style.height='';details.style.overflow='';
    if(!enabled()||!details.animate){details.open=open;return;}
    if(open)details.open=true;
    const summary=details.querySelector(':scope > summary');
    const destination=open?details.getBoundingClientRect().height:summary?.getBoundingClientRect().height||current;
    details.style.overflow='clip';details.style.height=current+'px';
    disclosures.set(details,open);
    play(details,[{height:current+'px'},{height:destination+'px'}],'--motion-standard',()=>{
      details.open=open;details.style.height='';details.style.overflow='';disclosures.delete(details);
    });
  }
  doc?.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button>0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    const summary=event.target.closest?.('summary'),details=summary?.parentElement;
    if(!details||details.tagName!=='DETAILS'||event.target.closest('button,a,input,select,textarea'))return;
    event.preventDefault();
    disclose(details,!(disclosures.has(details)?disclosures.get(details):details.open));
  });
  preference?.addEventListener('change',()=>{
    if(enabled())return;
    for(const [details,open] of disclosures){stop(details);details.open=open;details.style.height='';details.style.overflow='';}
    disclosures.clear();for(const el of [...active.keys()])stop(el);
  });
  root.PERSADO_MOTION=Object.freeze({enabled,reveal,confirm,update,disclose});
})(typeof self!=='undefined'?self:globalThis);
