// ─── Persado Assist — Side Panel ─────────────────────────────────────────────
//
// src/messages.js and src/boot.js are loaded as classic scripts BEFORE this
// module (see sidepanel.html) so the shared contract exists and any throw during
// this module's evaluation paints the fatal banner instead of dying silently.
//
// Two front doors: the page scan (any website) and the Mailchimp draft view.
// Every Persado call goes through the worker to the local gateway; paid runs are
// jobs the panel can leave and resume (src/jobs.js).

const { MSG, KEYS } = self.PERSADO;
const motion=self.PERSADO_MOTION;
const track=(name,props)=>self.PERSADO_ANALYTICS?.track(name,props);
const fatal = (e) => self.__persadoFatal?.(e);
const $ = (id) => {
  const el = document.getElementById(id);
  // A missing id used to fail later and far away; fail loudly at lookup instead.
  if (!el) throw new Error(`sidepanel.html is missing #${id}`);
  return el;
};

const pnlScan=$('panelScan'),pnlResults=$('panelResults'),pnlSettings=$('panelSettings'),pnlMailchimp=$('panelMailchimp');
const headerStatus=$('headerStatus'),headerText=$('headerStatusText'),toast=$('toast');
const scanSub=$('scanSub'),scanUrl=$('scanUrl'),scanCount=$('scanCount'),ctxBar=$('ctxBar'),ctxTitle=$('ctxTitle'),scanProgress=$('scanProgress');
const checkAllBar=$('checkAllBar'),checkAllTitle=$('checkAllTitle'),checkAllSub=$('checkAllSub'),btnCheckAll=$('btnCheckAll'),btnHdrClose=$('btnHdrClose');
const btnBackScan=$('btnBackScan'),resStale=$('resStale'),btnRescanStale=$('btnRescanStale'),btnRescan=$('btnRescan'),scanPriority=$('scanPriority'),scanList=$('scanList'),scanDetail=$('scanDetail');
const btnSettings=$('btnSettings'),btnBackFromSettings=$('btnBackFromSettings'),apiKeyInput=$('apiKeyInput'),btnSaveKey=$('btnSaveKey'),btnClearKey=$('btnClearKey'),apiKeyState=$('apiKeyState'),pickBar=$('pickBar'),btnCancelPick=$('btnCancelPick'),btnConfirm=$('btnConfirm'),btnOptimize=$('btnOptimize'),btnPick=$('btnPick');
const capLine=$('capLine'),resultsContainer=$('resultsContainer'),btnNew=$('btnNewBrief');
const resHeading=$('resHeading'),resCtx=$('resCtx'),resOrig=$('resOrig'),resNote=$('resNote');

const mcSub=$('mcSub'),mcList=$('mcList'),mcDetail=$('mcDetail'),mcSteps=$('mcSteps'),mcResult=$('mcResult'),mcActivity=$('mcActivity');
const btnMcRefresh=$('btnMcRefresh'),btnMcSettings=$('btnMcSettings');
const usageDot=$('usageDot'),usageConn=$('usageConn'),usageNum=$('usageNum'),usageFill=$('usageFill'),usageOpen=$('usageOpen');
const brandInput=$('brandInput'),industrySelect=$('industrySelect'),btnTestPersado=$('btnTestPersado'),persadoConnState=$('persadoConnState');
const useConn=$('useConn'),useBal=$('useBal'),useBalLbl=$('useBalLbl'),useUsed=$('useUsed'),useReq=$('useReq'),useScore=$('useScore'),useOpt=$('useOpt'),useLast=$('useLast'),useNote=$('useNote');
const btnRefreshUsage=$('btnRefreshUsage'),btnResetUsage=$('btnResetUsage');
const btnMcConnect=$('btnMcConnect'),mcState=$('mcState');

let currentUrl='';

function tm(m,k='ok'){toast.textContent=m;toast.className='toast '+k;setTimeout(()=>toast.className='toast',4000);}
// PRIMITIVES — only setUiState may call these.
function sh(p){const changed=!p.classList.contains('active');[pnlScan,pnlResults,pnlSettings,pnlMailchimp].forEach(x=>x.classList.remove('active'));p.classList.add('active');if(changed)motion.reveal(p);}
function st(t){headerText.textContent=t;headerStatus.className='hdr-st '+(/error|work/i.test(t)?'work':'');}

// ─── UI state — single source of truth ───────────────────────────
const UI_STATES={
  scan:      {panel:pnlScan,      header:'Ready'},
  results:   {panel:pnlResults,   header:'Done'},
  settings:  {panel:pnlSettings,  header:'Settings'},
  mailchimp: {panel:pnlMailchimp, header:'Mailchimp'},
};
let uiState=null;
function setUiState(state,{header}={}){
  const s=UI_STATES[state];
  if(!s){console.error('[persado] setUiState: unknown state',state);return;}
  // A results screen with nothing rendered is never valid: fall back to the scan.
  if(state==='results'&&!resultsContainer.childElementCount){console.error('[persado] results before render → scan');state='scan';}
  uiState=state;
  sh(UI_STATES[state].panel);
  st(header||UI_STATES[state].header);
  if(ctxBar)ctxBar.hidden=!(state==='scan'||state==='mailchimp');
  if(state!=='scan'&&pickBar)pickBar.hidden=true;
  headerStatus.style.display=state==='scan'?'none':'';
}

const displayUrl=(u)=>(window.PERSADO_URL?window.PERSADO_URL.displayUrl(u):(u||'').replace(/^[a-z]+:\/\//i,''));
function showUrl(u){
  currentUrl=u;
  // Context row: the domain is what a reader needs to know where they are; the full
  // address (with its path) stays in the tooltip rather than eating the line.
  if(scanUrl){let host=u||'';try{host=new URL(u).hostname.replace(/^www\./,'');}catch{}
    scanUrl.textContent=host;scanUrl.title=u||'';}
}
// A panel that keeps showing the previous page's copy is worse than no panel, so
// navigation is not just a URL-chip update: a different URL while the scan is on
// screen re-runs the scan. Results are left alone — they belong to a specific
// element on a specific page — and the "Re-scan page" action covers that case.
let lastScanUrl=null, rescanTimer=null;
function onTabNavigated(tab){
  if(!tab?.url)return;
  previewOn=null;   // navigation restores the page; there is nothing left to undo
  showUrl(tab.url);
  // Mailchimp has its own front door. Moving between it and other sites swaps
  // screens only from the two front doors, never from a result being read.
  if(isMailchimpUrl(tab.url)){
    if(uiState==='scan'||uiState==='mailchimp'){lastScanUrl=tab.url;const w=webIdOf(tab.url);if(uiState!=='mailchimp'||w!==mcTabWebId)showMailchimp();}
    return;
  }
  if(uiState==='mailchimp'){lastScanUrl=null;setUiState('scan');autoScan();return;}
  if(tab.url===lastScanUrl)return;
  if(uiState!=='scan'){
    // Results belong to the page they came from. Don't throw them away while they
    // are being read — say so and offer the rescan.
    if(uiState==='results'&&resStale)resStale.hidden=false;
    return;
  }
  clearTimeout(rescanTimer);
  rescanTimer=setTimeout(()=>{if(uiState==='scan')autoScan();},350);   // coalesce redirect chains
}
chrome.tabs.onUpdated.addListener((tabId,ci,tab)=>{if(ci.url&&tab.active)onTabNavigated(tab);});
chrome.tabs.onActivated.addListener(async(a)=>{try{onTabNavigated(await chrome.tabs.get(a.tabId));}catch{}});


// ─── Page scan ───────────────────────────────────────────────────
//
// The panel's front door no longer asks the user to describe the page. It reads
// the page, ranks the copy in it by opportunity (valuable slot × weak copy), and
// offers ONE decision: confirm what is there, or optimize the selected line.
//
// Every score shown here comes from PERSADO_SCAN.scoreCopy — local, rule-based,
// and itemised. No vendor score is claimed and nothing is invented.

const KIND_LABEL={cta:'Call to action',headline:'Headline',body:'Body copy'};
const COST={score:1,optimize:5};
const credits=n=>`${n} credit${n===1?'':'s'}`;
let resMaterialIndex=-1,scanResult=null,scanMaterial=null,scanBusy=false;

const touchpointOf=m=>m.evaluationTouchpoint||({cta:'cta',body:'body',headline:'headline'})[m.kind]||'headline';
const webField=m=>({field:m.id||m.selector||'selected',text:m.text,touchpoint:touchpointOf(m),score:m.evaluation?.kind==='score'?m.evaluation:null,optimization:m.evaluation?.kind==='optimize'?{result:m.evaluation}:null});

// ─── Paid runs as recoverable jobs (src/jobs.js) ─────────────────
// A run that outlives one short request comes back as { status:'running', cacheId }.
// The panel remembers it (a hash of the copy, never the copy), polls with free
// status reads, and resumes it after the panel closes or the browser restarts.
const jobs=self.PERSADO_JOBS.create({worker:msg=>worker(msg),storage:chrome.storage.local,key:KEYS.JOBS});
const watchers=new Map();   // cacheId → { aborted }
function stopWatchers(){for(const s of watchers.values())s.aborted=true;watchers.clear();}
const JOB_LABEL={running:'In progress',stale:'Still processing',unavailable:'Unable to retrieve result'};
const ago=t=>{const s=Math.max(0,Math.round((Date.now()-(t||Date.now()))/1000));return s<60?'just now':s<3600?`${Math.round(s/60)} min ago`:`${Math.round(s/3600)} h ago`;};

function attachJob(m,op,r){
  const phase=self.PERSADO_JOBS.phase(r);
  m.job={cacheId:r.cacheId,op,startedAt:r.startedAt||m.job?.startedAt||Date.now(),phase,answer:r};
  if(r.cacheId)jobs.remember({cacheId:r.cacheId,op,surface:'web',kind:m.kind,textHash:self.PERSADO_JOBS.textHash(m.text),startedAt:m.job.startedAt});
  if(phase==='unavailable')track('api_error',{surface:'web',op,kind:String(r.status||r.kind||'unknown')});
  if(phase==='running'||phase==='stale')startWatch(m);
  refreshJobViews(m);
}
function startWatch(m,{resumed=false}={}){
  const id=m.job?.cacheId;
  if(!id||watchers.has(id))return;
  const signal={aborted:false};watchers.set(id,signal);
  jobs.watch(id,{signal,startedAt:m.job.startedAt,onUpdate:(phase,r)=>{
    if(!m.job||m.job.cacheId!==id)return;
    if(r?.usage)renderUsage(r.usage);
    if(phase==='done'){completeRun(m,m.job.op,r,{t0:m.job.startedAt,resumed});return;}
    const was=m.job.phase;m.job.phase=phase;m.job.answer=r;
    if(phase==='unavailable'&&was!=='unavailable')track('api_error',{surface:'web',op:m.job.op,kind:String(r?.status||r?.kind||'unknown')});
    refreshJobViews(m);
  }}).finally(()=>{if(watchers.get(id)===signal)watchers.delete(id);});
}
/** Re-attach unfinished runs to the copy they were started for, on this page. */
async function resumeJobs(){
  for(const m of scanResult?.materials||[]){
    if(m.job||m.evaluation)continue;
    const [j]=await jobs.find('web',m.text);
    if(!j)continue;
    m.job={cacheId:j.cacheId,op:j.op,startedAt:j.startedAt,phase:'running',answer:null};
    startWatch(m,{resumed:true});
  }
  renderScanList();
}
function refreshJobViews(m){
  if(scanResult?.materials?.includes(m))renderScanList();
  if(uiState==='results'&&resultMaterial===m)renderJobCard(m);
}
async function checkJobAgain(m){
  const r=await jobs.check(m.job.cacheId);
  if(self.PERSADO_JOBS.phase(r)==='done'){completeRun(m,m.job.op,r,{t0:m.job.startedAt,resumed:true});return;}
  attachJob(m,m.job.op,r);
}
async function retryJob(m,{confirmed=false}={}){
  const {cacheId,op}=m.job,uncertain=m.job.answer?.retry==='confirm';
  if(uncertain&&!confirmed)return;
  track(op==='score'?'check_started':'optimize_started',{surface:'web',touchpoint:touchpointOf(m),resumed:true});
  const r=await jobs.retry(cacheId,{confirmUncertain:uncertain});
  await jobs.forget(cacheId);
  handleRunAnswer(m,op,r,{t0:Date.now()});
}

/** The five job states, in plain words. Real status only — no percentages, no fake timers. */
function renderJobCard(m){
  resultMaterial=m;clearPreview();
  const {op,phase,answer:r,startedAt}=m.job,what=op==='score'?'Check':'Optimization';
  const title={running:`${what} in progress`,stale:'Still processing — check again',unavailable:'Unable to retrieve result'}[phase]||`${what} in progress`;
  resHeading.textContent=title;resCtx.textContent=KIND_LABEL[m.kind]||'Copy';
  capLine.textContent=`Started ${ago(startedAt)}`;resOrig.style.display='none';
  let body='',actions='';
  if(phase==='running'){
    body=op==='optimize'?'Persado usually takes a few minutes to write and evaluate new versions. You can close this panel; the result will be here when you come back.':'Persado is scoring this copy.';
  }else if(phase==='stale'){
    body=r?.checkFailed||r?.ok===false?'Persado could not be reached just now. The run is kept, and checking again is free.':'This is taking longer than usual. The run is kept, and checking again is free — nothing is charged twice.';
    actions='<button class="vc-optimize" data-job="check">Check again</button>';
  }else{
    const msg=r?.message||r?.error||'Persado did not return a result for this run.';
    body=esc(msg);
    if(r?.retry==='confirm')actions=`<button class="vc-copybtn" data-job="retry-ask">Try again…</button>`;
    else actions=`<button class="vc-optimize" data-job="retry">Try again · ${credits(COST[op])}</button>`;
    actions+='<button class="mc-secondary" data-job="dismiss">Dismiss</button>';
  }
  resultsContainer.innerHTML=`<div class="opt-card" aria-live="polite"><p class="opt-copy">${esc(m.text)}</p><p class="mc-state-message">${phase==='unavailable'?body:esc(body)}</p>${actions?`<div class="opt-act">${actions}</div>`:''}</div>`;
  resNote.style.display='none';
  finishSingle(phase==='unavailable'?'Needs attention':'Working');
}
resultsContainer.addEventListener('click',async e=>{
  const b=e.target.closest('[data-job]');if(!b||!resultMaterial?.job)return;
  const m=resultMaterial,act=b.dataset.job;
  if(act==='check'){b.disabled=true;b.textContent='Checking…';await checkJobAgain(m);return;}
  if(act==='retry-ask'){
    // A second, explicit confirmation for a run whose charge is unknown.
    b.outerHTML=`<button class="vc-optimize" data-job="retry-confirm">Confirm: this may use ${credits(COST[m.job.op])} again</button>`;return;
  }
  if(act==='retry'||act==='retry-confirm'){b.disabled=true;b.textContent='Starting…';await retryJob(m,{confirmed:act==='retry-confirm'});return;}
  if(act==='dismiss'){await jobs.forget(m.job.cacheId);m.job=null;backToList();}
});

async function injectScanner(tabId){
  // messages.js rides along because scan.js reads MSG from it; page-noise.js
  // supplies the cookie/language/chat filter. All three are idempotent.
  await chrome.scripting.executeScript({target:{tabId},files:['src/messages.js','src/page-noise.js','src/eligibility.js','src/scan.js']});
}

async function autoScan(){
  if(scanBusy)return;
  scanBusy=true;stopWatchers();
  if(btnRescan){btnRescan.disabled=true;btnRescan.dataset.busy='true';btnRescan.setAttribute('aria-busy','true');}
  scanSub.textContent='Reading the page’s copy…';
  if(ctxTitle)ctxTitle.textContent='Reading this page…';
  if(scanProgress)scanProgress.textContent='';
  scanDetail.style.display='none';
  checkAllBar.hidden=true;
  scanList.innerHTML='<div class="scan-empty">Scanning…</div>';
  try{
    const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error('No active tab.');
    if(tab.url)showUrl(tab.url);
    lastScanUrl=tab.url||lastScanUrl;
    await injectScanner(tab.id);
    let r=await chrome.tabs.sendMessage(tab.id,{type:MSG.SCAN_PAGE});
    if(!r?.ok)throw new Error(r?.error||'The page did not return a scan.');
    // A scan can land while the page is still painting and honestly find nothing.
    if(!(r.materials||[]).length){
      await new Promise(res=>setTimeout(res,700));
      try{
        const again=await chrome.tabs.sendMessage(tab.id,{type:MSG.SCAN_PAGE});
        if(again?.ok&&(again.materials||[]).length)r=again;
      }catch{}
    }
    scanResult=r;
    const ms=r.materials||[];
    track('content_detected',{surface:'web',count:ms.length});
    if(ctxTitle)ctxTitle.textContent=r.title||displayUrl(r.url||'')||'This page';
    scanCount.textContent=ms.length?`${ms.length} found`:'nothing found';
    scanSub.textContent=ms.length
      ?'Check the copy you want to improve.'
      :'No buttons or headlines could be read here. Use Pick on page to choose copy yourself.';
    if(!ms.length)scanList.innerHTML='<div class="scan-empty">No headlines or buttons found on this page. Use <b>Pick on page</b> to choose any copy yourself. Detecting copy is free.</div>';
    renderScanList();
    resumeJobs();
  }catch(e){
    scanSub.textContent='This page could not be scanned.';
    scanCount.textContent='—';
    scanList.innerHTML=`<div class="scan-empty">${esc(e?.message||'Chrome does not allow scanning this page.')} Reload the page and try again.</div>`;
  }finally{
    scanBusy=false;
    if(btnRescan){btnRescan.disabled=false;delete btnRescan.dataset.busy;btnRescan.removeAttribute('aria-busy');}
  }
}

// Three states, one vocabulary, in every context. A fourth, quiet group holds
// copy Persado could not judge, with its own next step, so it never hides under
// "Not checked".
const STATE_GROUPS=[{key:'worth',label:'Worth improving',dot:'worth'},{key:'good',label:'Looking good',dot:'good'},{key:'unchecked',label:'Not checked',dot:''},{key:'review',label:'Needs review',dot:''}];
const groupOf=(kind)=>kind==='good'?'good':(kind==='opportunity'||kind==='recommended')?'worth':kind==='unavailable'?'review':'unchecked';

/** Where the reader should start. Deterministic, local, and free — see src/priority.js. */
function reviewOrder(ms){
  if(self.PERSADO_PRIORITY)return self.PERSADO_PRIORITY.rank(ms,scanResult||{});
  return ms.map((material,index)=>({index,material,startHere:index===0,reason:''}));
}

function renderScanList(){
  const ms=scanResult?.materials||[];
  if(!ms.length){scanDetail.style.display='none';checkAllBar.hidden=true;return;}
  const order=reviewOrder(ms);
  const checked=ms.filter(m=>m.evaluation).length;
  scanCount.textContent=`${checked} of ${ms.length} checked`;
  if(scanProgress)scanProgress.textContent='';

  const groups={worth:[],good:[],unchecked:[],review:[]};
  order.forEach(row=>{
    const state=self.PERSADO_INTELLIGENCE.outcome(webField(row.material));
    groups[groupOf(state.kind)].push({...row,state});
  });

  scanList.innerHTML=STATE_GROUPS.filter(g=>groups[g.key].length).map(g=>
    `<div class="scan-group"><div class="scan-group-h"><span class="dot ${g.dot}"></span>${g.label}<span class="n">${groups[g.key].length}</span></div>`
    +groups[g.key].map(({index,material,state,startHere})=>{
      const icon=state.kind==='good'?'good':['recommended','opportunity'].includes(state.kind)?'worth':'neutral';
      const label=material.job?JOB_LABEL[material.job.phase]||'In progress':state.label;
      return `<div class="scan-row" data-i="${index}" role="button" tabindex="0">`
        +`<div class="scan-row-k">${startHere?'<span class="scan-hit">Start here</span>':''}<span>${esc(KIND_LABEL[material.kind]||material.kind)}</span></div>`
        +`<div class="scan-row-t">${esc(trunc(material.text,76))}</div>`
        +`<div class="scan-row-s mc-outcome"><i class="mc-state-icon ${icon}" aria-hidden="true"></i>${esc(label)}</div></div>`;
    }).join('')+'</div>').join('');

  const top=order[0];
  scanPriority.innerHTML=top
    ?`<b>Start here:</b> ${esc((KIND_LABEL[top.material.kind]||'copy').toLowerCase())} “${esc(trunc(top.material.text,48))}”${top.reason?` — ${esc(top.reason)}`:''}`
    :'';
  renderCheckAll();
  const keep=resMaterialIndex>=0&&ms[resMaterialIndex]?resMaterialIndex:top.index;
  selectMaterial(keep);
}

// ── Check all ───────────────────────────────────────────────────
// N is the number of items with no evaluation and no run in progress: a saved
// score is reused, never re-bought. Optimization is never chained onto this.

function checkAllPlan(){
  // Automatic batches only carry copy the eligibility policy cleared. Ambiguous
  // or excluded material stays in the list and waits for an explicit click.
  const pending=(scanResult?.materials||[]).filter(m=>!m.evaluation&&!m.job&&m.eligibility?.autoEligible===true);
  return {pending,cost:pending.length*COST.score};
}

function renderCheckAll(){
  const {pending,cost}=checkAllPlan();
  checkAllBar.hidden=!pending.length;
  if(!pending.length)return;
  checkAllTitle.textContent=`${pending.length} item${pending.length===1?'':'s'} not checked`;
  checkAllSub.textContent='1 credit each · a checked line is saved, so checking it again is free';
  btnCheckAll.textContent=`Check all · ${credits(cost)}`;
  btnCheckAll.disabled=checkAllBusy||!apiKey||!!lastUsage?.exhausted;
}

let checkAllBusy=false;
async function checkAll(){
  const {pending}=checkAllPlan();
  if(!pending.length||checkAllBusy)return;
  if(!apiKey){openSettings();return;}
  checkAllBusy=true;
  btnCheckAll.dataset.busy='true';btnCheckAll.setAttribute('aria-busy','true');btnCheckAll.disabled=true;
  let scored=0,failed=0;
  try{
    for(const m of pending){
      btnCheckAll.textContent=`Checking ${scored+failed+1} of ${pending.length}…`;
      const t0=Date.now();
      track('check_started',{surface:'web',touchpoint:touchpointOf(m)});
      const r=await worker({type:MSG.PERSADO_SCORE,...runPayload(m,{batch:true})});
      if(r.ok){scored++;handleRunAnswer(m,'score',r,{t0,quiet:true});}
      else{
        failed++;reportRunError(r,'score');
        if(r.kind==='no_key'||r.kind==='invalid_key'||r.kind==='quota_exhausted'||r.kind==='not_paired'){tm(r.error||'Checking stopped','err');break;}
      }
    }
  }finally{
    checkAllBusy=false;
    delete btnCheckAll.dataset.busy;btnCheckAll.removeAttribute('aria-busy');
    renderCheckAll();
    if(scored)tm(`${scored} checked${failed?` · ${failed} could not be checked`:''}`,'ok');
  }
}
btnCheckAll.addEventListener('click',checkAll);

function selectMaterial(i){
  const ms=scanResult?.materials||[];
  scanMaterial=ms[i]||null;
  resMaterialIndex=scanMaterial?i:-1;
  scanList.querySelectorAll('.scan-row').forEach(r=>r.classList.toggle('sel',+r.dataset.i===i));
  renderScanDetail(scanMaterial);
}

/** One primary action per state, with its cost on the button that spends it. */
function renderScanDetail(m){
  if(!m){scanDetail.style.display='none';return;}
  const issues=(m.issues||[]).slice(0,5),state=self.PERSADO_INTELLIGENCE.outcome(webField(m));
  const optimized=m.evaluation?.kind==='optimize';
  const message=m.job?`${JOB_LABEL[m.job.phase]||'In progress'} — open it to see the details.`:state.message;
  scanDetail.style.display='';
  scanDetail.innerHTML=`<p class="mc-state-message">${esc(message)}</p><div class="scan-d-copy">${esc(m.text)}</div>`
    +(m.evaluationCached?'<p class="mc-meta">Saved result — no credits used.</p>':'')
    +`<details class="mc-compare"><summary>Copy review</summary><p class="mc-meta">Quick local review, not a Persado result. Free.</p><div class="scan-why">${issues.length?issues.map(x=>`<div class="scan-why-i"><span><strong>${esc(x.label)}.</strong> ${esc(x.detail)}</span></div>`).join(''):'<p class="mc-meta">No local suggestions.</p>'}</div></details>`;
  const blocked=!apiKey||!!lastUsage?.exhausted;
  btnConfirm.textContent=`Check · ${credits(COST.score)}`;
  btnConfirm.hidden=state.kind!=='unchecked'||!!m.job;
  btnConfirm.disabled=blocked;
  btnOptimize.textContent=m.job?'View progress':optimized?'Show recommendation':`Find a better version · ${credits(COST.optimize)}`;
  // Check first while unchecked; the rewrite is primary only when Persado sees room.
  const rewritePrimary=!!m.job||state.kind==='opportunity'||state.kind==='recommended'||optimized;
  btnOptimize.classList.toggle('btn-primary',rewritePrimary);
  btnOptimize.classList.toggle('btn-outline',!rewritePrimary);
  btnOptimize.disabled=!m.job&&!optimized&&blocked;
}

// Hovering a row outlines the element it came from, so the list and the page are one
// object. Pointer-only: keyboard selection already moves focus and scrolls.
let highlightTimer=null,highlightedSelector=null;
function highlightOn(selector){
  if(!selector)return;
  clearTimeout(highlightTimer);
  highlightedSelector=selector;
  highlightTimer=setTimeout(async()=>{
    try{const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
      if(tab?.id)await chrome.tabs.sendMessage(tab.id,{type:MSG.SCAN_HIGHLIGHT,selector,on:true});}catch{}
  },60);
}
async function highlightOff(){
  clearTimeout(highlightTimer);
  if(!highlightedSelector)return;
  const selector=highlightedSelector;highlightedSelector=null;
  try{const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(tab?.id)await chrome.tabs.sendMessage(tab.id,{type:MSG.SCAN_HIGHLIGHT,selector,on:false});}catch{}
}
scanList.addEventListener('pointerover',(e)=>{
  const row=e.target.closest('.scan-row');if(!row)return;
  highlightOn((scanResult?.materials||[])[+row.dataset.i]?.selector);
});
scanList.addEventListener('pointerleave',highlightOff);
scanList.addEventListener('focusin',(e)=>{
  const row=e.target.closest('.scan-row');if(!row)return;
  highlightOn((scanResult?.materials||[])[+row.dataset.i]?.selector);
});
scanList.addEventListener('focusout',highlightOff);

scanList.addEventListener('keydown',(e)=>{
  const row=e.target.closest('.scan-row');if(!row)return;
  if(e.key==='Enter'||e.key===' '){e.preventDefault();selectMaterial(+row.dataset.i);}
});


// ─── Pick on page ────────────────────────────────────────────────
// For anything the scan skipped — a phrase inside a paragraph, an icon button
// with no text, an element behind a hover state. Selecting text first picks that
// phrase instead of the whole block.

// ─── Settings: local gateway pairing and non-secret request settings ───
let apiKey=false;
async function loadApiKey(){
  const u=await worker({type:MSG.USAGE_GET});apiKey=!!u.hasKey;return apiKey;
}
function renderKeyState(msg,kind){
  apiKeyState.className='set-state'+(kind?' '+kind:'');
  apiKeyState.textContent=msg||(apiKey?'Persado credential configured in gateway.':'Set PERSADO_API_KEY in the gateway environment.');
}
let settingsReturn='scan';
async function openSettings(){
  if(uiState&&uiState!=='settings')settingsReturn=uiState==='mailchimp'?'mailchimp':'scan';
  apiKeyInput.value='';await loadApiKey();renderKeyState();await loadSettingsForm();
  renderUsage(await worker({type:MSG.USAGE_GET}));setUiState('settings');
}
async function leaveSettings(){
  let onMc=settingsReturn==='mailchimp';
  try{const[t]=await chrome.tabs.query({active:true,currentWindow:true});if(t?.url)onMc=isMailchimpUrl(t.url);}catch{}
  if(onMc){showMailchimp();return;}
  if(scanResult){setUiState('scan');renderScanList();if(resMaterialIndex>=0)selectMaterial(resMaterialIndex);}
  else{setUiState('scan');autoScan();}
}
btnSettings.addEventListener('click',openSettings);
btnBackFromSettings.addEventListener('click',leaveSettings);
usageOpen.addEventListener('click',()=>{if(uiState!=='settings')openSettings();});
btnSaveKey.addEventListener('click',async()=>{
  const token=apiKeyInput.value.trim();
  if(token.length<32){renderKeyState('Enter the gateway pairing token (at least 32 characters).','err');return;}
  await chrome.storage.local.set({[KEYS.PROXY_TOKEN]:token});apiKeyInput.value='';
  const r=await testPersado();await loadApiKey();renderKeyState(r.ok?'Gateway paired and Persado verified.':r.error,r.ok?'on':'err');
});
btnClearKey.addEventListener('click',async()=>{
  await chrome.storage.local.remove(KEYS.PROXY_TOKEN);apiKey=false;
  renderKeyState('Gateway unpaired. Provider credentials remain in your secret manager.');
});

/** Message the worker; a dead worker or a reloaded extension reads as an error, not a hang. */
async function worker(msg){
  try{return await chrome.runtime.sendMessage(msg)||{ok:false,error:'No answer from the extension.'};}
  catch(e){return{ok:false,error:'The extension was reloaded. Close and reopen this panel.'};}
}

async function testPersado(){
  if(btnTestPersado){btnTestPersado.disabled=true;btnTestPersado.textContent='Testing…';}
  const r=await worker({type:MSG.PERSADO_TEST});
  if(btnTestPersado){btnTestPersado.disabled=false;btnTestPersado.textContent='Test connection';}
  if(persadoConnState){
    persadoConnState.className='set-state '+(r.ok?'on':'err');
    persadoConnState.textContent=r.ok?`Connected to Persado. ${r.channels?.length||0} channels available; this check used no runs.`:r.error;
  }
  if(r.usage)renderUsage(r.usage);
  return r;
}
if(btnTestPersado)btnTestPersado.addEventListener('click',testPersado);

// Industry values are Persado's (persado-api.js INDUSTRIES); the panel loads the
// API module only for this list and never calls it.
const INDUSTRY_LIST=['AUTOMOTIVE','B2B_SERVICES','CHARITIES_GOOD_WILL','CONSUMER_GOODS_SERVICES','DATING','EDUCATION','ENERGY','FASHION_APPAREL','FINANCIAL_SERVICES','GAMING_GAMBLING','HEALTHCARE','INSURANCE','INTERNET_CABLE','MEDIA_ENTERTAINMENT','OTHER','RETAIL_ECOMMERCE','TECHNOLOGY_APPS_SOFTWARE','TELECOMMUNICATIONS','TRAVEL_HOTELS'];
if(industrySelect&&industrySelect.options.length<2){
  for(const v of INDUSTRY_LIST){const o=document.createElement('option');o.value=v;o.textContent=v.toLowerCase().replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());industrySelect.appendChild(o);}
}
async function readSettings(){
  const r=await chrome.storage.local.get(KEYS.PERSADO_SETTINGS).catch(()=>({}));
  return {persado:{brand:'',industry:'',...(r[KEYS.PERSADO_SETTINGS]||{})}};
}
async function loadSettingsForm(){
  const s=await readSettings();brandInput.value=s.persado.brand;industrySelect.value=s.persado.industry;
  mcState.textContent='Mailchimp credentials are configured in the gateway environment.';
}
async function savePersadoSettings(){
  await chrome.storage.local.set({[KEYS.PERSADO_SETTINGS]:{brand:brandInput.value.trim(),industry:industrySelect.value}});
}
brandInput.addEventListener('change',savePersadoSettings);
industrySelect.addEventListener('change',savePersadoSettings);
btnMcConnect.addEventListener('click',async()=>{
  btnMcConnect.disabled=true;mcState.textContent='Checking Mailchimp…';
  const r=await worker({type:MSG.MC_TEST});btnMcConnect.disabled=false;
  mcState.className='set-state '+(r.ok?'on':'err');
  mcState.textContent=r.ok?`Connected to ${r.accountName||'Mailchimp'} (${r.dc}).`:r.error;
});

// ─── Usage ──────────────────────────────────────────────────────
// The gateway ledger reports estimated usage; no current balance is inferred.
const fmtWhen=(t)=>t?new Date(t).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'never';
let lastUsage=null;
function renderUsage(u){
  if(!u||u.ok===false&&!u.quota)return;
  lastUsage=u;
  const conn=!u.hasKey?{cls:'',t:'Persado API · Not set up'}
    :u.exhausted?{cls:'err',t:'Persado API · Quota used up'}
    :u.connection?.ok===false?{cls:'err',t:'Persado API · '+(u.connection.kind==='invalid_key'?'Key rejected':'Error')}
    :u.connection?.ok?{cls:'ok',t:'Persado API · Connected'}
    :{cls:'',t:'Persado API · Not tested'};
  usageDot.className='dot '+conn.cls;
  usageConn.textContent=conn.t;
  // No balance endpoint, so no balance is shown. A running estimate in the primary
  // flow reads as a balance and invites arithmetic nobody can verify; it belongs in
  // Settings, where the ledger and its cost sources are spelled out.
  const problem=!u.hasKey||u.exhausted||['invalid_key','error','quota'].includes(u.connection?.kind);
  usageNum.textContent='';
  $('usageBar').hidden=!problem;
  if(!u.hasKey)usageConn.textContent='Persado API · Set up in Settings';
  usageFill.style.width='0';
  $('usageBar').title='Account balance unavailable. Costs are configured estimates; usage headers from Persado are shown in Settings.';
  if(useConn){
    useConn.textContent=u.connection?`${u.connection.ok?'Connected':'Failed'} · ${u.connection.message||''} · ${fmtWhen(u.connection.at)}`:(u.hasKey?'Not tested':'No key');
    useBalLbl.textContent='Account balance';
    useBal.textContent=u.exhausted?'Insufficient credits — reported by Persado':'Unavailable — no documented balance endpoint';
    useUsed.innerHTML=u.hasKey?`${u.used} runs <span class="est">${u.scoreRuns}×${u.costs.score} score + ${u.optimizeRuns}×${u.costs.optimize} optimize</span>`:'—';
    useReq.textContent=u.hasKey?`${u.requests}${u.failedRequests?` (${u.failedRequests} failed)`:''}`:'—';
    useScore.textContent=u.hasKey?String(u.scoreRuns):'—';
    useOpt.textContent=u.hasKey?String(u.optimizeRuns):'—';
    useLast.textContent=u.hasKey?fmtWhen(u.lastSuccessAt):'—';
    const hdrs=u.serverReported?Object.entries(u.serverReported.headers).map(([k,v])=>`${k}: ${v}`).join(', '):'';
    useNote.textContent=`Account balance is unavailable. This gateway has tracked estimated credit usage since ${fmtWhen(u.since)}. `
      +`Costs: optimize ${u.costs.optimize} (${u.costSource.optimize}); score ${u.costs.score} (${u.costSource.score}). Runs made elsewhere with the same key are not counted.`
      +(hdrs?` Persado reported: ${hdrs}.`:'')
      +(u.lastError?` Last error: ${u.lastError.message}`:'');
  }
}
if(btnRefreshUsage)btnRefreshUsage.addEventListener('click',async()=>{
  // Refresh never spends a run: re-read the ledger, and re-check the key with
  // the free catalogue call.
  btnRefreshUsage.disabled=true;
  if(apiKey)await testPersado();else renderUsage(await worker({type:MSG.USAGE_GET}));
  btnRefreshUsage.disabled=false;
});
if(btnResetUsage)btnResetUsage.addEventListener('click',()=>tm('Usage is persisted by the gateway to protect against duplicate charges.'));

let picking=false,pickTabId=null;
function setPicking(on){
  picking=on;
  if(pickBar)pickBar.hidden=!on;
}
async function cancelPick(quiet){
  setPicking(false);
  if(pickTabId){
    try{await chrome.tabs.sendMessage(pickTabId,{type:MSG.SCAN_CANCEL});}catch(e){}
  }
  if(!quiet)tm('Picking cancelled');
}

btnPick.addEventListener('click',async()=>{
  try{
    const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error('No active tab.');
    await injectScanner(tab.id);
    const r=await chrome.tabs.sendMessage(tab.id,{type:MSG.SCAN_PICK});
    if(!r?.ok)throw new Error(r?.error||'Could not start picking.');
    pickTabId=tab.id;
    setPicking(true);
    tm(r.selection?'Using your selected text':'Click the copy on the page');
  }catch(e){tm(e?.message||'Could not start picking on this page','err');}
});

if(btnCancelPick)btnCancelPick.addEventListener('click',()=>cancelPick());

// scan.js reports the picked element from the page context.
chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.type===MSG.SCAN_CANCELLED){if(picking)cancelPick(true);tm('Picking cancelled');return;}
  if(msg.type===MSG.SCAN_BLOCKED){tm(msg.message||'That control is not marketing copy','err');return;}
  if(msg.type===MSG.SCAN_PICKED){
    if(!msg.material)return;
    if(picking)setPicking(false);
    if(!scanResult)scanResult={materials:[]};
    const picked={...msg.material,id:0};
    scanResult.materials=[picked,...(scanResult.materials||[])];
    renderScanList();
    selectMaterial(0);
    tm('Picked from the page');
    // Picking is a way of choosing what to work on, so it ends where choosing
    // anything else ends: the scored card for that copy.
    renderSelected(picked);
  }
});

// ─── Check / Optimize ────────────────────────────────────────────

btnConfirm.addEventListener('click',()=>persadoRun('score'));
btnOptimize.addEventListener('click',()=>optimizeMaterial());
if(btnRescan)btnRescan.addEventListener('click',()=>autoScan());
if(btnHdrClose)btnHdrClose.addEventListener('click',()=>window.close());
// The result card is a dead end unless it can go back to the page's copy list.
function backToList(){
  clearPreview();
  if(resStale)resStale.hidden=true;
  resultMaterial=null;
  if(!scanResult){setUiState('scan');autoScan();return;}
  setUiState('scan');
  renderScanList();
  if(resMaterialIndex>=0)selectMaterial(resMaterialIndex);
}
if(btnBackScan)btnBackScan.addEventListener('click',backToList);
// Escape leaves the result card too.
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape')return;
  if(picking){e.preventDefault();cancelPick();return;}
  if(pnlSettings.classList.contains('active')){e.preventDefault();leaveSettings();return;}
  if(!pnlResults.classList.contains('active'))return;
  e.preventDefault();backToList();
});
if(btnRescanStale)btnRescanStale.addEventListener('click',()=>{if(resStale)resStale.hidden=true;setUiState('scan');autoScan();});

/** A saved recommendation or a run in progress opens without spending anything. */
function optimizeMaterial(){
  const m=scanMaterial;if(!m)return;
  if(m.job){renderJobCard(m);return;}
  if(m.evaluation?.kind==='optimize'){renderSingle('optimize',m);return;}
  return persadoRun('optimize');
}

/** Brand for account.name when Settings has none: the site's own name. */
function brandFromPage(){
  try{
    const h=new URL(scanResult?.url||currentUrl).hostname.replace(/^www\./,'');
    const parts=h.split('.');const core=parts.length>2&&parts.at(-2).length<=3?parts.at(-3):parts.at(-2)||parts[0];
    return core?core.charAt(0).toUpperCase()+core.slice(1):'';
  }catch{return '';}
}
function runPayload(m,{manual=false,batch=false}={}){
  return {text:m.text,kind:m.kind,pageUrl:scanResult?.url||currentUrl,brand:brandFromPage(),
    eligibility:m.eligibility||null,manual,batch,
    context:[scanResult?.title?`Page: ${scanResult.title}`:'',m.context?`Nearby copy: ${m.context}`:''].filter(Boolean).join('\n')};
}
function reportRunError(r,op){
  if(r.kind==='quota_exhausted')track('credits_insufficient',{surface:'web',op});
  else track('api_error',{surface:'web',op,kind:String(r.kind||'error')});
}

let runBusy=false,resultMaterial=null;
/**
 * Score or optimize the selected line with the real Persado API (through the
 * worker). The answer is either a finished result or a job to follow; nothing
 * here invents a number or a waiting time.
 */
async function persadoRun(op){
  const m=scanMaterial;
  if(!m){tm('Pick a piece of copy first','err');return;}
  if(runBusy)return;
  if(m.job){renderJobCard(m);return;}
  runBusy=true;
  const btn=document.activeElement?.tagName==='BUTTON'?document.activeElement:op==='score'?btnConfirm:btnOptimize;
  const label=btn.textContent;
  document.querySelector('.web-request-error')?.remove();
  btn.disabled=true;btn.dataset.busy='true';btn.setAttribute('aria-busy','true');btn.textContent=op==='score'?'Checking…':'Starting optimization…';
  const t0=Date.now();
  track(op==='score'?'check_started':'optimize_started',{surface:'web',touchpoint:touchpointOf(m)});
  try{
    // An explicit click is manual selection: it may check ambiguous copy, never
    // hard-excluded copy (the worker re-checks and refuses).
    const r=await worker({type:op==='score'?MSG.PERSADO_SCORE:MSG.PERSADO_OPTIMIZE,...runPayload(m,{manual:true})});
    handleRunAnswer(m,op,r,{t0,open:true});
  }finally{
    runBusy=false;delete btn.dataset.busy;btn.removeAttribute('aria-busy');btn.textContent=label;
    if(scanMaterial)renderScanDetail(scanMaterial);
  }
}

/** A worker answer → a result, a job to follow, or a shown error. */
function handleRunAnswer(m,op,r,{t0=Date.now(),open=false,quiet=false}={}){
  if(r.usage)renderUsage(r.usage);
  if(!r.ok){
    reportRunError(r,op);
    if(quiet)return;
    const error=document.createElement('p');error.className='mc-field-error web-request-error';error.setAttribute('role','alert');
    error.textContent=r.error||'Persado request failed';(uiState==='results'?resultsContainer:scanDetail).append(error);
    if(r.kind==='no_key'||r.kind==='invalid_key'||r.kind==='not_paired')openSettings();
    return;
  }
  if(self.PERSADO_JOBS.phase(r)==='done'){completeRun(m,op,r,{t0,open:open||(!quiet&&scanMaterial===m)});return;}
  attachJob(m,op,r);
  if(open&&!quiet)renderJobCard(m);
}

function completeRun(m,op,r,{t0=Date.now(),resumed=false,open=false}={}){
  if(m.job?.cacheId)jobs.forget(m.job.cacheId);
  m.job=null;
  m.evaluation=r.result;m.evaluationTouchpoint=r.touchpoint||touchpointOf(m);m.evaluationCached=!!r.cached;
  const state=self.PERSADO_INTELLIGENCE.outcome(webField(m));
  track(op==='score'?'check_completed':'optimize_completed',{surface:'web',touchpoint:touchpointOf(m),state:state.kind,cached:!!r.cached,resumed,duration_ms:Math.max(0,Date.now()-t0)});
  if(scanResult?.materials?.includes(m))renderScanList();
  const viewing=uiState==='results'&&resultMaterial===m;
  if(open||viewing)renderSingle(op,m);
  else if(resumed||op==='optimize')tm(op==='score'?'Check finished':'Recommendation ready');
}

let previewOn=null;   // { tabId, selector } while a preview is showing on the page
async function setPreview(on,m,text){
  try{
    const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error('No active tab.');
    await injectScanner(tab.id);
    const r=on
      ?await chrome.tabs.sendMessage(tab.id,{type:MSG.SCAN_PREVIEW,selector:m.selector,text,original:m.text})
      :await chrome.tabs.sendMessage(tab.id,{type:MSG.SCAN_RESTORE,selector:m.selector});
    if(on&&!r?.ok)throw new Error(r?.error||'Could not preview on this page.');
    previewOn=on?{tabId:tab.id,selector:m.selector}:null;
    return true;
  }catch(e){tm(e?.message||'Could not preview on this page','err');return false;}
}
async function clearPreview(){
  if(!previewOn)return;
  const p=previewOn;previewOn=null;
  try{await chrome.tabs.sendMessage(p.tabId,{type:MSG.SCAN_RESTORE,selector:p.selector});}catch{}
}

/** Scores and raw response fields: for inspection, never the primary workflow. */
function technicalDetails(m,ranked){
  const r=m.evaluation||{};
  const line=r.kind==='optimize'
    ?`Language score: ${ranked?.originalScore??'not returned'}${ranked?.variant?' → '+(ranked.score??'not returned'):''}`
    :`Language score: ${r.variants?.[0]?.performance??'not returned'}`;
  return `<details class="mc-compare"><summary>Technical details</summary><p class="mc-meta">${esc(line)}. Model scores are predictions, not measured results.</p><pre class="mc-response">${esc(JSON.stringify({jobId:r.jobId,channel:r.channel,variants:r.kind==='score'?r.variants:undefined,control:r.control,selected:ranked?.variant,notice:r.notice},null,2))}</pre></details>`;
}
function copyButton(text,label='Copy'){return `<button class="mc-secondary" data-copy="${esc(text)}">${esc(label)}</button>`;}

/** Picked copy before any Persado call: what it costs to check or improve it. */
function renderSelected(m){
  resultMaterial=m;clearPreview();
  resHeading.textContent='Selected copy';resCtx.textContent=KIND_LABEL[m.kind]||'Copy';
  capLine.textContent='Not sent to Persado yet';resOrig.style.display='none';
  resultsContainer.innerHTML=`<div class="opt-card"><p class="opt-copy">${esc(m.text)}</p>`
    +`<div class="opt-act"><button class="vc-optimize" data-run="score">Check · ${credits(COST.score)}</button><button class="vc-copybtn" data-run="optimize">Find a better version · ${credits(COST.optimize)}</button></div></div>`;
  resNote.style.display='none';
  finishSingle();
}

/**
 * A finished result. Recommendation first: the copy, one short reason when
 * Persado gave one, and the action. Original copy, other versions and scores
 * are one click away, never in front.
 */
function renderSingle(mode,m){
  if(resStale)resStale.hidden=true;
  clearPreview();
  resultMaterial=m;
  resMaterialIndex=(scanResult?.materials||[]).indexOf(m);
  const r=m.evaluation;
  if(!r){renderSelected(m);return;}
  const state=self.PERSADO_INTELLIGENCE.outcome(webField(m));
  resHeading.textContent=state.label;resCtx.textContent=KIND_LABEL[m.kind]||'Copy';
  capLine.textContent=state.message+(m.evaluationCached?' Saved result — no credits used.':'');
  resOrig.style.display='none';
  const optimizeBtn=(primary)=>`<button class="${primary?'vc-optimize':'vc-copybtn'}" data-run="optimize">Find a better version · ${credits(COST.optimize)}</button>`;

  if(r.kind==='score'){
    const act=state.kind==='opportunity'||state.kind==='unavailable'?`<div class="opt-act">${optimizeBtn(state.kind==='opportunity')}</div>`
      :`<details class="mc-compare"><summary>More actions</summary>${optimizeBtn(false)}</details>`;
    resultsContainer.innerHTML=`<div class="opt-card"><p class="opt-copy">${esc(m.text)}</p>${act}${technicalDetails(m)}</div>`;
    resNote.style.display='none';
    finishSingle();return;
  }

  const tp=touchpointOf(m),ranked=self.PERSADO_INTELLIGENCE.comparison(webField(m));
  const copyOf=a=>a?.touchpoints?.[tp]||a?.text||'';
  const alts=ranked.alternatives,recommended=state.kind==='recommended'?ranked:null;
  const others=alts.filter(a=>!recommended||a!==recommended.variant);
  const reason=recommended?.guidance;
  let html='<div class="opt-card">';
  if(recommended){
    html+=`<div class="sec-label">Recommended</div><p class="opt-copy">${esc(recommended.text)}</p>`
      +(reason?`<p class="mc-meta">${esc(reason.text)}</p>`:'')
      +`<div class="opt-act">${copyButton(recommended.text,'Copy this version').replace('mc-secondary','vc-optimize')}<button class="vc-copybtn" data-preview="${esc(recommended.text)}">Preview on page</button></div>`
      +`<details class="mc-compare"><summary>Original copy</summary><p class="mc-current">${esc(m.text)}</p></details>`;
  }else{
    html+=`<p class="opt-copy">${esc(m.text)}</p>`;
  }
  if(others.length){
    const title=recommended?`Other versions · ${others.length}`:state.kind==='good'?`Versions Persado tried · ${others.length}`:`Versions Persado returned · ${others.length}`;
    html+=`<details class="p-alts"><summary>${title}</summary>${others.map(a=>`<div class="p-alt"><span>${esc(copyOf(a))}</span>${copyButton(copyOf(a))}<button class="vc-copybtn" data-preview="${esc(copyOf(a))}">Preview</button></div>`).join('')}</details>`;
  }
  html+=technicalDetails(m,ranked)+'</div>';
  resultsContainer.innerHTML=html;
  resNote.textContent=alts.length?'Preview changes this tab only, never your site. To use a version, copy it into your site’s editor.':'';
  resNote.style.display=resNote.textContent?'':'none';
  finishSingle();
}
let previewText=null;
resultsContainer.addEventListener('click',async e=>{
  const m=resultMaterial;if(!m)return;
  const run=e.target.closest('[data-run]');
  if(run){scanMaterial=m;persadoRun(run.dataset.run);return;}
  const cp=e.target.closest('[data-copy]');
  if(cp){
    try{await navigator.clipboard.writeText(cp.dataset.copy);cp.textContent='Copied';cp.classList.add('done');
      track('recommendation_applied',{surface:'web',touchpoint:touchpointOf(m)});}
    catch{tm('Could not copy','err');}
    return;
  }
  const pv=e.target.closest('[data-preview]');
  if(pv){
    const text=pv.dataset.preview;
    resultsContainer.querySelectorAll('[data-preview]').forEach(b=>{if(b!==pv)b.textContent=b.textContent==='Restore original'?(b.closest('.p-alt')?'Preview':'Preview on page'):b.textContent;});
    if(previewText===text){await setPreview(false,m);previewText=null;pv.textContent=pv.closest('.p-alt')?'Preview':'Preview on page';return;}
    if(await setPreview(true,m,text)){previewText=text;pv.textContent='Restore original';}
  }
});
function finishSingle(header){
  previewText=null;
  motion.reveal(resultsContainer.querySelector('.opt-card'));
  btnNew.textContent='Back to list';
  setUiState('results',{header});
}


function trunc(s,n){s=String(s);return s.length>n?s.slice(0,n-1).trimEnd()+'…':s;}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
btnNew.addEventListener('click',()=>backToList());

// ─── Mailchimp ──────────────────────────────────────────────────
// When the active tab is Mailchimp, the panel's front door is the account's
// draft campaigns instead of a page scan (scanning Mailchimp's own UI would
// only find Mailchimp's buttons). The run itself happens in the worker; this
// screen draws its steps, the original-versus-optimized result, and Revert /
// Send test. Sending to an audience is never offered here.

const MC_HOST=/^https:\/\/[^/]*\.admin\.mailchimp\.com\//i;
const isMailchimpUrl=u=>MC_HOST.test(u||'');
const webIdOf=u=>{try{const x=new URL(u),id=x.searchParams.get('id');return /\/campaigns\//.test(x.pathname)&&/^\d+$/.test(id||'')?Number(id):null;}catch{return null;}};
let mcSel=null,mcTabWebId=null,mcTabId=null,mcEpoch=0,mcBusyUi=false,mcUndo=[],mcFeedback='',mcFeedbackError=false;
let mcLoad=null,mcQueued=false,mcRefreshTimer=null,mcSettleTimer=null,mcFeedbackTimer=null,mcViewSignature='',mcWorkingField=null;
let mcDataRevision=0,mcWorkingOp=null,mcApplied=null,mcJobTimer=null,mcPersistWatch=null;
const mcFailures=new Map();
const mcFailureKey=f=>mcSel?.id+':'+f.field+':'+f.text;
function expandMcField(f){
  mcExpanded.clear();if(!f)return;mcExpanded.add(f.field);
  const kind=intelligence.outcome(f).kind;
  if(kind==='unchecked')mcExpanded.add('unchecked');else if(kind==='unavailable')mcExpanded.add('unavailable');else if(kind==='good')mcExpanded.add('good');
  if(f.location==='html'){mcExpanded.add(f.touchpoint==='cta'?'buttons':'body');if(f.templateDefault)mcExpanded.add('templates');}
}
const mcExpanded=new Set(['subject_line']);
const intelligence=self.PERSADO_INTELLIGENCE,impact=self.PERSADO_IMPACT;
const mcChoices=new Map();
const mcOverview=$('mcOverview'),mcImpact=$('mcImpact');
let mcInsights=null,mcInsightsLoading=null,mcOverviewSignature='';
const mcConnection=$('mcConnection'),mcCount=$('mcCount');
const mcLabel=f=>f.touchpoint==='cta'?f.text:({subject_line:'Subject line',preview_text:'Preview text'})[f.field]||({headline:'Headline',subheadline:'Subheadline',body:'Copy block'})[f.touchpoint]||'Copy block';
function mcConnectionState(ok,label){mcConnection.classList.toggle('connected',ok);mcConnection.textContent=label||(ok?'Mailchimp':'Connection needs attention');mcConnection.setAttribute('aria-label',ok?'Mailchimp connected':label||'Connection needs attention');}
function mcNotice(text,error=false){
  clearTimeout(mcFeedbackTimer);mcFeedback=text||'';mcFeedbackError=error;
  mcSteps.textContent=mcFeedback;mcSteps.classList.toggle('error',error);
  if(text&&!error)mcFeedbackTimer=setTimeout(()=>{mcFeedback='';mcSteps.textContent='';},4000);
}
function mcContext(){
  mcSub.textContent=mcSel?.title||'Untitled draft';mcSub.title=mcSub.textContent;
  const fields=mcSel?.fields||[],checked=intelligence.organize(fields).checked;
  // Same row as a public page, different facts: who we are connected to, which draft,
  // and how far the checking has got.
  if(uiState==='mailchimp'){
    if(ctxTitle)ctxTitle.textContent=mcSel?.title||'Untitled draft';
    if(scanUrl){const s=mcSel?.status||'draft';scanUrl.textContent=`Mailchimp · ${s}`;}
    if(scanCount)scanCount.textContent=`${checked} of ${fields.length} checked`;
  }
  mcCount.textContent=`${checked} checked · ${fields.length-checked} remaining`;
  renderMcOverview();
}
const mcNumber=n=>new Intl.NumberFormat(undefined,n!==0&&Math.abs(n)<.01?{maximumSignificantDigits:3}:{maximumFractionDigits:2}).format(n);
const mcPercent=n=>n==null?'Unavailable':mcNumber(n*100)+'%';
async function loadMcInsights(epoch){
  if(!mcSel||mcInsightsLoading?.id===mcSel.id)return;
  if(mcInsights?.id===mcSel.id&&Date.now()-mcInsights.at<300000)return;
  const id=mcSel.id,request={id};mcInsightsLoading=request;
  const r=await worker({type:MSG.MC_INSIGHTS,campaignId:id,...(mcTabWebId?{webId:mcTabWebId}:{})});
  if(mcInsightsLoading===request)mcInsightsLoading=null;
  if(epoch!==mcEpoch||mcSel?.id!==id)return;
  mcInsights={id,at:Date.now(),...r};renderMcOverview();
  if(r.languageUpdated)scheduleMcRefresh(100);
}
function renderMcOverview(){
  if(!mcSel)return;
  const insights=mcInsights?.id===mcSel.id?mcInsights:null;
  const reach=mcSel.reach||insights?.reach;
  const signature=JSON.stringify([mcSel.id,reach,insights,mcUndo]);if(signature===mcOverviewSignature)return;
  mcOverviewSignature=signature;
  const baseline=insights?.baseline;
  const reachLabel=reach?.count!=null?`${reach.kind==='sent'?'Sent':'Estimated reach'} · ${mcNumber(reach.count)} ${reach.kind==='sent'?(reach.count===1?'email':'emails'):(reach.count===1?'recipient':'recipients')}`:'Estimated reach unavailable';
  const history=insights?.history||[];
  const signed=n=>(n>=0?'+':'')+mcNumber(n)+'%';
  const modelOutputs=(insights?.modelOutputs||[]).map(x=>{
    const p=x.potential,c=p.clicks,v=p.conversions;
    return `<div class="mc-meta">${x.field==='subject_line'?'Subject line':'Preview text'} · optimization potential`
      +(c?.total!=null?`<br>Click uplift potential: ${esc(signed(c.total))}`:'')
      +(v?.total!=null?`<br>Conversion uplift potential: ${esc(signed(v.total))}`:'')
      +`</div>`;
  }).join('');
  const modelHtml=modelOutputs?'<details><summary>Persado model output</summary>'+modelOutputs+'<p class="mc-meta">Relative to current language; projected optimization potential, not a selected rewrite. Calibration and confidence interval unavailable.</p></details>':'';
  const undoDetails=mcUndo.length?`<div>${mcUndo.slice(-1).map(u=>`<button class="mc-secondary" data-context-undo="${esc(u.undoId)}">Undo last saved edit</button>`).join('')}</div>`:'';
  const contextHtml=`<div>${esc(reachLabel)}</div>`+(!baseline?.available?'<div>Historical baseline unavailable.</div>':'')+undoDetails;
  mcOverview.innerHTML=(reach?.count>1?`<div>${esc(reachLabel)}</div>`:'')+(baseline?.available
    ?`<details><summary>Historical click rate · ${esc(mcPercent(baseline.clickRate))}</summary><p>${esc(baseline.method)} · ${baseline.campaignCount} campaigns · ${mcNumber(baseline.emailsSent)} emails sent · last ${baseline.windowDays} days.</p><p>${esc(baseline.comparability)}</p><ul class="mc-baseline-list">${baseline.samples.map(x=>`<li>${esc(x.title)} · ${esc(mcPercent(x.clickRate))} · ${mcNumber(x.emailsSent)} sent</li>`).join('')}</ul></details>`
    :'')
    +(history.length?`<details><summary>Post-send reports · ${history.length}</summary><select class="mc-option" aria-label="Sent campaign report">${history.map(r=>`<option value="${esc(r.campaignId)}">${esc(r.title)}</option>`).join('')}</select><button class="mc-secondary" data-report>View observed results</button><div class="mc-report-result" role="status"></div></details>`:'');
  // Keep scenario inputs stable during ordinary campaign/status synchronization.
  if(mcImpact.dataset.campaign===mcSel.id){
    mcImpact.querySelector('.mc-model-output').innerHTML=modelHtml;mcImpact.querySelector('.mc-context-meta').innerHTML=contextHtml;
    const input=mcImpact.querySelector('[name="baseline"]');
    if(baseline?.available&&input&&!input.value&&document.activeElement!==input&&!mcImpact.dataset.baseline){input.value=baseline.clickRate*100;mcImpact.dataset.baseline='set';}
    return;
  }
  mcImpact.dataset.campaign=mcSel.id;
  delete mcImpact.dataset.baseline;
  mcImpact.innerHTML='<details class="mc-impact"><summary>Campaign details</summary><div class="mc-context-meta">'+contextHtml+'</div><div class="mc-model-output">'+modelHtml+'</div><details><summary>Illustrative scenario</summary><p>User assumptions · not a Persado prediction</p>'
    +`<form><label>Recipients<input name="recipients" aria-label="Scenario recipients" type="number" min="0" step="1" required value="${reach?.count??''}"></label>`
    +`<label>Baseline click rate (%)<input name="baseline" type="number" min="0" max="100" step="any" required value="${baseline?.clickRate!=null?baseline.clickRate*100:''}"></label>`
    +'<label>Relative lift (%)<input name="lift" type="number" min="-100" step="any" required></label>'
    +'<label>Click-to-conversion rate (%) · optional<input name="conversion" type="number" min="0" max="100" step="any"></label>'
    +'<label>Average order value · optional<input name="order" type="number" min="0" step="any"></label>'
    +'<label>Currency · for revenue<input name="currency" maxlength="3" placeholder="e.g. USD" autocomplete="off"></label>'
    +'<div class="mc-actions"><button type="submit">Calculate scenario</button></div><output aria-live="polite"></output></form></details></details>';
}
mcImpact.addEventListener('submit',e=>{
  e.preventDefault();const form=e.target,values=new FormData(form);
  const value=name=>{const v=String(values.get(name)||'').trim();return v===''?null:Number(v);};
  const result=impact.calculate({recipients:value('recipients'),baselineClickRate:value('baseline')===null?null:value('baseline')/100,
    relativeUplift:value('lift')===null?null:value('lift')/100,conversionPerClick:value('conversion')===null?null:value('conversion')/100,
    averageOrderValue:value('order'),currency:String(values.get('currency')||'').trim().toUpperCase()});
  form.querySelector('output').textContent=result.ok?`Illustrative scenario: ${mcNumber(result.additionalClicks)} incremental clicks`
    +(result.conversions!==null?` · ${mcNumber(result.conversions)} potential ${result.conversions===1?'conversion':'conversions'}`:'')
    +(result.revenue!==null?` · ${result.currency} ${mcNumber(result.revenue)} potential revenue`:'')
    +`. ${mcNumber(result.relativeUplift*100)}% relative lift = ${mcNumber(result.percentagePointChange)} percentage points. No confidence interval available.`:result.errors.join(' ');
});
mcOverview.addEventListener('click',async e=>{
  const button=e.target.closest('[data-report]');if(!button)return;
  const target=button.closest('details'),id=target.querySelector('select').value,epoch=mcEpoch;
  button.disabled=true;target.querySelector('.mc-report-result').textContent='Loading report…';
  const r=await worker({type:MSG.MC_REPORT,campaignId:id});if(epoch!==mcEpoch)return;
  button.disabled=false;
  target.querySelector('.mc-report-result').textContent=r.ok?`${r.report.title}: ${r.report.emailsSent==null?'send count unavailable':mcNumber(r.report.emailsSent)+' emails sent'} · click rate ${mcPercent(r.report.clickRate)}`
    +(r.report.uniqueClicks!==null?` · ${mcNumber(r.report.uniqueClicks)} unique clicks`:'')
    +(r.report.ecommerce?` · ${r.report.ecommerce.orders==null?'orders unavailable':mcNumber(r.report.ecommerce.orders)+' orders'}${r.report.ecommerce.revenue!==null&&r.report.ecommerce.currency?' · '+r.report.ecommerce.currency+' '+mcNumber(r.report.ecommerce.revenue)+' tracked revenue':''}`:' · Ecommerce tracking unavailable')
    +'. Observed results; incremental impact not established.':r.error;
});
async function showMailchimp(){
  const epoch=++mcEpoch;clearTimeout(mcRefreshTimer);clearTimeout(mcSettleTimer);mcQueued=false;
  mcSel=null;mcUndo=[];mcApplied=null;mcBusyUi=false;mcViewSignature='';mcInsights=null;mcInsightsLoading=null;mcOverviewSignature='';mcChoices.clear();mcFailures.clear();mcOverview.innerHTML='';mcImpact.innerHTML='';delete mcImpact.dataset.campaign;mcExpanded.clear();mcExpanded.add('subject_line');
  mcDetail.hidden=true;mcActivity.innerHTML='';mcList.innerHTML='<div class="mc-skeleton" role="status" aria-label="Loading campaign"><i></i><i></i><i></i></div>';mcCount.textContent='';
  mcSub.textContent='Identifying campaign…';mcNotice('');
  mcConnectionState(false,'Connecting to Mailchimp');setUiState('mailchimp');
  try{const[t]=await chrome.tabs.query({active:true,currentWindow:true});if(epoch!==mcEpoch)return;mcTabId=t?.id;mcTabWebId=webIdOf(t?.url);}catch{mcTabWebId=null;mcTabId=null;}
  await loadDrafts(epoch);
}
function scheduleMcRefresh(delay=1200){
  clearTimeout(mcRefreshTimer);
  mcRefreshTimer=setTimeout(()=>{
    if(uiState!=='mailchimp'||document.hidden)return;
    if(mcBusyUi){mcQueued=true;return;}
    loadDrafts(mcEpoch,true);
  },delay);
}
async function loadDrafts(epoch=mcEpoch,quiet=false){
  if(mcLoad?.epoch===epoch){mcQueued=true;return mcLoad.promise;}
  if(mcBusyUi){mcQueued=true;return;}
  const selectedId=mcSel?.id,revision=mcDataRevision;
  const task=(async()=>{
    const st=await worker({type:MSG.MC_STATUS,...(selectedId?{campaignId:selectedId}:{}),...(mcTabWebId?{webId:mcTabWebId}:{})});
    if(epoch!==mcEpoch||uiState!=='mailchimp')return;
    if(revision!==mcDataRevision){mcQueued=true;return;}
    if(st.usage)renderUsage(st.usage);
    mcConnectionState(!!(st.ok&&st.connected));
    if(st.ok&&st.campaign){
      const prev=mcSel?.id===st.campaign.id?mcSel:null;
      checkPersistence(st.campaign);
      // Runs that finished while the panel was away or polling.
      for(const f of st.campaign.fields||[]){
        const before=prev?.fields?.find(x=>x.field===f.field);
        if(before?.job?.status==='running'&&!f.job){const op=before.job.op;if(op==='optimize'?f.optimization:f.score)track(op==='score'?'check_completed':'optimize_completed',{surface:'mailchimp',touchpoint:f.touchpoint,state:intelligence.outcome(f).kind,resumed:true});}
      }
      if(!prev)track('content_detected',{surface:'mailchimp',count:(st.campaign.fields||[]).length});
      const first=!mcSel?.fields;mcSel=st.campaign;mcUndo=st.undo||[];mcList.innerHTML='';mcContext();
      if(first)expandMcField(intelligence.organize(mcSel.fields||[]).next);
      const signature=JSON.stringify([mcSel,mcUndo,!!lastUsage?.hasKey,!!lastUsage?.exhausted]);
      if(signature!==mcViewSignature){mcViewSignature=signature;renderMcDetail();}
      loadMcInsights(epoch);
      return;
    }
    // Keep a known draft visible during transient network failures. A campaign
    // mismatch/non-draft must clear stale actions immediately.
    if(quiet&&mcSel&&['gateway_down','rate_limited','unavailable','timeout','unreachable'].includes(st.kind)){
      mcNotice(st.error||'Could not refresh. Try again shortly.',true);return;
    }
    mcSel=null;mcDetail.hidden=true;mcActivity.innerHTML='';mcCount.textContent='';
    mcSub.textContent='Select a campaign';mcSub.title='';
    mcNotice(st.error||(!st.connected?'Open Settings to connect Mailchimp.':'Choose a draft to review.'),!st.ok);
    if(!st.ok&&!['not_found','selection_required','ambiguous','not_draft'].includes(st.kind))return;
    const r=await worker({type:MSG.MC_DRAFTS});if(epoch!==mcEpoch)return;
    if(!r.ok){mcNotice(r.error,true);return;}
    mcList.innerHTML=(r.drafts||[]).map(d=>`<button class="mc-choice" data-campaign="${esc(d.id)}">${esc(d.title||d.subject||'Untitled draft')}</button>`).join('')||'<p class="mc-empty">No draft campaigns.</p>';
  })();
  mcLoad={epoch,promise:task};
  try{await task;}finally{
    if(mcLoad?.promise===task){mcLoad=null;mcList.querySelector('.mc-skeleton')?.remove();}
    if(epoch===mcEpoch&&mcQueued){mcQueued=false;scheduleMcRefresh(2000);}
  }
}
/**
 * After Apply, the next reads confirm the text is still there. If Mailchimp has
 * the previous text again, an editor that was open during Apply most likely
 * saved over it; say so plainly instead of showing a stale "Applied".
 */
function checkPersistence(c){
  const w=mcPersistWatch;
  if(!w||w.campaignId!==c.id)return;
  if(Date.now()>w.until){mcPersistWatch=null;return;}
  const cur=w.field==='subject_line'?c.subject:c.previewText,label=w.field==='subject_line'?'subject line':'preview text';
  if(cur===w.text)return;
  mcPersistWatch=null;
  track('api_error',{surface:'mailchimp',kind:'apply_not_persisted'});
  mcNotice(cur===w.original
    ?`Mailchimp has the previous ${label} again, most likely saved from an editor that was open when you applied. Reload the Mailchimp page, then apply again.`
    :`The ${label} was changed in Mailchimp after you applied. Undo is no longer available for it.`,true);
}
mcList.addEventListener('click',async e=>{
  const b=e.target.closest('[data-campaign]');if(!b)return;
  ++mcEpoch;mcTabWebId=null;mcViewSignature='';mcExpanded.clear();mcExpanded.add('subject_line');
  mcSel={id:b.dataset.campaign};mcNotice('');await loadDrafts(mcEpoch);
});
function renderMcDetail(){
  mcDetail.hidden=!mcSel;if(!mcSel)return;
  mcDetail.setAttribute('aria-busy',String(mcBusyUi));
  const focused=document.activeElement;
  const focusKey=focused?.dataset?.op?{op:focused.dataset.op,field:focused.dataset.field,index:focused.dataset.index}:null;
  const scroll=mcResult.closest('.mc-wrap')?.scrollTop||0,fields=mcSel.fields||[];
  const applied=mcApplied&&mcApplied.campaignId===mcSel.id&&fields.some(f=>f.field===mcApplied.field&&f.text===mcApplied.text)&&mcUndo.some(u=>u.undoId===mcApplied.undoId);
  const priority=intelligence.organize(fields,{appliedField:applied?mcApplied.field:null});
  const disabled=mcBusyUi||!lastUsage?.hasKey,paidDisabled=disabled||!!lastUsage?.exhausted;
  const isOpen=key=>mcExpanded.has(key)?' open':'';
  const row=f=>{
    const state=priority.states.get(f.field),info=intelligence.describe(f),choiceKey=mcSel.id+':'+f.field+':'+(f.optimization?.cacheId||'');
    const comparison=intelligence.comparison(f,mcChoices.get(choiceKey)),pending=mcBusyUi&&mcWorkingField===f.field;
    const ready=state.kind==='recommended',selectedHigher=comparison.delta>0;
    const reviewOnly=!!f.applyDisabledReason,optimizeLabel=reviewOnly?'Find a better version · 5 credits · review only':'Find a better version · 5 credits';
    // A run started earlier (this panel, another session, or before a restart) that has no result yet.
    const job=f.job&&!(f.job.op==='optimize'?f.optimization:f.score)?f.job:null;
    const jobLabel=job?(job.status==='running'?(job.op==='optimize'?'Optimization in progress':'Check in progress'):'Unable to retrieve result'):null;
    const editorOpen=!reviewOnly&&mcTabWebId!=null&&Number(mcSel.webId)===Number(mcTabWebId);
    const primary=priority.next?.field===f.field,failed=mcFailures.get(mcFailureKey(f));
    const workLabel=mcWorkingOp===MSG.MC_SCORE?'Checking…':mcWorkingOp===MSG.MC_OPTIMIZE?'Finding a version…':mcWorkingOp===MSG.MC_REVERT?'Restoring…':'Saving…';
    const button=(op,label,{index=null,secondary=false}={})=>`<button class="${secondary?'mc-secondary':op==='apply'?'mc-apply':''}" data-op="${op}" data-field="${esc(f.field)}" ${index!==null?`data-index="${index}"`:''} ${pending?'data-busy="true"':''} ${(op==='score'||op==='optimize'?paidDisabled:disabled)?'disabled':''}>${pending?workLabel:label}</button>`;
    const result=state.kind==='applied'?mcApplied.response:f.optimization?.result;
    const detailComparison=state.kind==='applied'?mcApplied.comparison:comparison;
    const control=result?.control,variant=ready?comparison.variant:f.score?.variants?.[0]||control;
    const scoreLine=detailComparison?.variant&&detailComparison.originalScore!==null
      ?`Language score: ${esc(detailComparison.originalScore)}${control?.performanceBand?' ('+esc(intelligence.label(control.performanceBand))+')':''} → ${detailComparison.score!==null?esc(detailComparison.score)+(detailComparison.band?' ('+esc(detailComparison.band)+')':''):'not returned'}`
      :info.evaluated?`Language score: ${esc(info.score)}${info.inRange?'/100':''}${info.bandLabel?' · '+esc(info.bandLabel):''}`:'No language score returned.';
    const responseFields={score:f.score||null,optimization:result?{jobId:result.jobId,channel:result.channel,notice:result.notice,control,selected:detailComparison?.variant}:null};
    const moreActions=state.kind!=='opportunity'&&state.kind!=='recommended'&&state.kind!=='applied'?`<div class="mc-actions">${button('optimize',optimizeLabel,{secondary:true})}</div>`:'';
    const details=`<details class="mc-compare" data-key="details:${esc(f.field)}"${isOpen('details:'+f.field)}><summary>${state.kind==='unchecked'?'More actions':'Technical details'}</summary><p class="mc-meta">${scoreLine}</p>`
      +(info.evaluated?'<p class="mc-meta">Model scoring, not measured campaign outcomes.</p>':'')+moreActions
      +`<details class="mc-compare"><summary>Raw response</summary><pre class="mc-response">${esc(JSON.stringify(responseFields,null,2))}</pre></details></details>`;
    const rationale=variant?.performanceWhy||variant?.brandRationale;
    const why=rationale?`<details class="mc-compare" data-key="why:${esc(f.field)}"${isOpen('why:'+f.field)}><summary>Why this recommendation?</summary><p class="mc-meta">${variant.performanceWhy?'Persado performance feedback':'Persado brand guidance'}: ${esc(rationale)}</p></details>`:'';
    const selection=comparison.options.length>1?`<select class="mc-option" data-choice="${esc(f.field)}" aria-label="Choose another version" ${mcBusyUi?'disabled':''}>${comparison.options.map((o,i)=>`<option value="${o.index}" ${comparison.index===o.index?'selected':''}>${i===0&&ready?'Recommended':esc((o.variant.touchpoints?.[f.touchpoint]||o.variant.text||'Copy option').slice(0,38))}${!o.comparable?' · separate context':''}</option>`).join('')}</select>`:'';
    const useButton=!f.applyDisabledReason?(editorOpen?`<p class="mc-meta">Save and close the ${esc(mcLabel(f).toLowerCase())} editor in Mailchimp first. Persado Assist can’t see unsaved changes there.</p>`:'')+button('apply',ready&&selectedHigher?'Use this version':'Use selected version',{index:comparison.index}):`<p class="mc-meta">Review only. Persado Assist doesn’t edit email body copy, so paste this version into Mailchimp yourself.</p><button class="mc-apply" data-op="copy" data-field="${esc(f.field)}" data-copy="${esc(comparison.text)}">Copy this version</button>`;
    const options=comparison.options.length?`<details class="mc-compare" data-key="options:${esc(f.field)}"${isOpen('options:'+f.field)}><summary>Other options${comparison.options.length>1?' · '+(comparison.options.length-1):''}</summary>${selection}${!ready?`<p class="mc-current">${esc(comparison.text)}</p>${useButton}`:''}</details>`:'';
    const original=`<details class="mc-compare" data-key="original:${esc(f.field)}"${isOpen('original:'+f.field)}><summary>Original copy</summary><p class="mc-current">${esc(f.text)}</p></details>`;
    const message=ready?(selectedHigher?'A stronger option is available.':'Review this option before using it.'):state.message;
    const content=ready?`<div data-motion-key="recommended:${esc(f.field)}"><p class="mc-recommended-copy">${esc(comparison.text)}</p>${useButton}${options}${original}${why}${details}</div>`
      :`<p class="mc-current">${esc(f.text)}</p>`
        +(state.kind==='unchecked'?`<div class="mc-actions">${button('score','Check · 1 credit')}</div>`:state.kind==='opportunity'?`<div class="mc-actions">${button('optimize',optimizeLabel)}</div>`:'')+(state.kind==='applied'&&mcApplied.original?`<details class="mc-compare" data-key="original:${esc(f.field)}"${isOpen('original:'+f.field)}><summary>Original copy</summary><p class="mc-current">${esc(mcApplied.original)}</p></details>`:'')+options+why+details;
    let rowMessage=message,rowContent=content;
    if(job){
      const cost=job.op==='optimize'?5:1;
      rowMessage=job.status==='running'
        ?`Started ${ago(job.startedAt)}. ${job.op==='optimize'?'Persado usually takes a few minutes.':''} You can close this panel; the result will appear here.`
        :(job.error||'Persado did not return a result for this run.');
      rowContent=`<p class="mc-current">${esc(f.text)}</p>`+(job.status==='running'
        ?`<div class="mc-actions"><button class="mc-secondary" data-op="check-job" data-field="${esc(f.field)}">Check again</button></div>`
        :job.status==='unknown'
          ?`<p class="mc-meta">Persado may already have charged for this run.</p><div class="mc-actions"><button class="mc-secondary" data-op="retry-ask" data-field="${esc(f.field)}" data-cache="${esc(job.cacheId)}" data-cost="${cost}">Try again…</button></div>`
          :`<div class="mc-actions"><button data-op="retry" data-field="${esc(f.field)}" data-cache="${esc(job.cacheId)}" ${paidDisabled?'disabled':''}>Try again · ${cost} credit${cost===1?'':'s'}</button></div>`);
    }
    const icon=state.kind==='good'||state.kind==='applied'?'good':ready||state.kind==='opportunity'?'worth':'neutral';
    return `<details class="mc-row${primary?' primary':''}" data-key="${esc(f.field)}" aria-busy="${pending}"${isOpen(f.field)}>`
      +`<summary><span class="mc-summary-copy"><span class="mc-heading">${esc(mcLabel(f))}</span><span class="mc-outcome"><i class="mc-state-icon ${icon}" aria-hidden="true"></i>${esc(pending?workLabel:jobLabel||state.label)}</span></span>`
      +(state.kind==='unchecked'&&!job?`<button class="mc-summary-action" data-op="score" data-field="${esc(f.field)}" ${paidDisabled?'disabled':''}>Check · 1 credit</button>`:'')+'</summary>'
      +`<div class="mc-row-content">${rowMessage?`<p class="mc-state-message">${esc(rowMessage)}</p>`:''}${rowContent}`
      +(failed?`<p class="mc-field-error" role="alert">${esc(failed.error)}</p>`:'')
      +(lastUsage?.exhausted&&['unchecked','opportunity','unavailable'].includes(state.kind)?'<p class="mc-field-error">No API credits available. Review usage in Settings.</p>':'')+'</div></details>';
  };
  const group=(key,title,items,body=items.map(row).join(''))=>items.length?`<details class="mc-group" data-key="${key}"${isOpen(key)}><summary><span class="mc-heading">${title}</span><span class="mc-count">${items.length}</span></summary>${body}</details>`:'';
  const uncheckedRows=()=>{
    const body=priority.unchecked.filter(f=>f.location==='html'&&f.touchpoint!=='cta'),buttons=priority.unchecked.filter(f=>f.touchpoint==='cta');
    const custom=buttons.filter(f=>!f.templateDefault),templates=buttons.filter(f=>f.templateDefault);
    return priority.unchecked.filter(f=>f.location!=='html').map(row).join('')+group('body','Email body',body)
      +group('buttons','Button language',buttons,custom.map(row).join('')+group('templates','Template buttons',templates));
  };
  // Runs in progress or needing a decision are shown first, never folded into a collapsed group.
  const active=fields.filter(f=>f.job&&!(f.job.op==='optimize'?f.optimization:f.score));
  const notActive=list=>list.filter(f=>!active.includes(f));
  for(const k of ['opportunities','good','unchecked','unavailable','applied'])priority[k]=notActive(priority[k]);
  let html=active.length?'<div class="mc-review-heading">In progress</div>'+active.map(row).join(''):'';
  html+=priority.opportunities.length?'<div class="mc-review-heading">Recommended actions</div>'+priority.opportunities.map(row).join(''):'';
  html+=priority.applied.map(row).join('')+group('good','Looking good',priority.good)
    +group('unchecked','Not checked',priority.unchecked,uncheckedRows())+group('unavailable','Needs review',priority.unavailable);
  if(!fields.length)html='<p class="mc-empty">No eligible content detected.</p>';
  motion.update(mcResult,html);
  motion.update(mcActivity,applied?`<div class="mc-saved" data-motion-key="applied" data-confirmed="true"><span>Applied to campaign</span>${mcTabId&&mcTabWebId!=null&&Number(mcSel.webId)===Number(mcTabWebId)?'<button class="mc-undo" data-reload-tab title="Save any open edits in Mailchimp first">Reload Mailchimp</button>':''}<button class="mc-undo" data-undo="${esc(mcApplied.undoId)}" ${mcBusyUi?'disabled':''} ${mcBusyUi&&mcWorkingOp===MSG.MC_REVERT?'data-busy="true"':''}>${mcBusyUi&&mcWorkingOp===MSG.MC_REVERT?'Restoring…':'Undo'}</button></div>`:'');
  mcImpact.querySelectorAll('[data-context-undo]').forEach(b=>{b.disabled=mcBusyUi;b.dataset.busy=String(mcBusyUi&&mcWorkingOp===MSG.MC_REVERT);});
  const wrap=mcResult.closest('.mc-wrap');if(wrap)wrap.scrollTop=scroll;
  // A run in progress is followed with short status reads (MC_STATUS adopts finished jobs).
  if(fields.some(f=>f.job?.status==='running')&&!mcJobTimer)mcJobTimer=setTimeout(()=>{mcJobTimer=null;scheduleMcRefresh(0);},5000);
  if(focusKey){const selector=`[data-op="${CSS.escape(focusKey.op)}"][data-field="${CSS.escape(focusKey.field)}"]${focusKey.index!=null?`[data-index="${CSS.escape(focusKey.index)}"]`:''}`;[...mcResult.querySelectorAll(selector)].find(el=>el.getClientRects().length)?.focus({preventScroll:true});}
}
mcResult.addEventListener('toggle',e=>{
  const key=e.target.dataset?.key;if(!key)return;
  if(e.target.open){mcExpanded.add(key);if(e.target.classList.contains('mc-row')){mcResult.querySelectorAll('.mc-row[open]').forEach(row=>{if(row!==e.target){mcExpanded.delete(row.dataset.key);motion.disclose(row,false);}});}}else mcExpanded.delete(key);
},true);
async function mcAction(msg,success){
  if(!mcSel||mcBusyUi)return;
  ++mcDataRevision;
  const epoch=mcEpoch,id=mcSel.id,actionFocus=document.activeElement;
  const restoreActionFocus=()=>document.activeElement===document.body||document.activeElement===actionFocus;
  const actionField=msg.field||mcUndo.find(u=>u.undoId===msg.undoId)?.field;
  const originalField=mcSel.fields.find(f=>f.field===msg.field),comparison=originalField?intelligence.comparison(originalField,msg.alternativeIndex):null;
  if(originalField)mcFailures.delete(mcFailureKey(originalField));
  mcBusyUi=true;mcWorkingField=actionField;if(actionField)mcExpanded.add(actionField);
  mcWorkingOp=msg.type;
  mcNotice('');renderMcDetail();
  const runOp=msg.type===MSG.MC_SCORE?'score':msg.type===MSG.MC_OPTIMIZE?'optimize':null,t0=Date.now();
  if(runOp)track(runOp==='score'?'check_started':'optimize_started',{surface:'mailchimp',touchpoint:originalField?.touchpoint});
  const r=await worker({...msg,campaignId:id,...(mcTabWebId?{webId:mcTabWebId}:{})});
  if(epoch!==mcEpoch||mcSel?.id!==id)return;
  mcBusyUi=false;mcWorkingField=null;mcWorkingOp=null;if(r.usage)renderUsage(r.usage);
  if(!r.ok)track(r.kind==='quota_exhausted'?'credits_insufficient':'api_error',{surface:'mailchimp',op:runOp||undefined,kind:String(r.kind||'error')});
  else if(runOp&&r.status==='done'){
    const done={...originalField,...(runOp==='score'?{score:r.result}:{optimization:{result:r.result}})};
    track(runOp==='score'?'check_completed':'optimize_completed',{surface:'mailchimp',touchpoint:originalField?.touchpoint,state:intelligence.outcome(done).kind,cached:!!r.cached,duration_ms:Date.now()-t0});
  }
  else if(msg.type===MSG.MC_APPLY){
    track('recommendation_applied',{surface:'mailchimp',touchpoint:originalField?.touchpoint});
    // Re-read later to confirm the change persisted (an editor open in Mailchimp
    // can write the old text back on its next save).
    if(r.verified&&r.campaign)mcPersistWatch={campaignId:id,field:msg.field,text:msg.field==='subject_line'?r.campaign.subject:r.campaign.previewText,original:originalField?.text,until:Date.now()+10*60000};
    setTimeout(()=>scheduleMcRefresh(0),60000);
  }
  else if(msg.type===MSG.MC_REVERT){track('undo_used',{surface:'mailchimp'});mcPersistWatch=null;}
  if(!r.ok&&originalField){mcFailures.set(mcFailureKey(originalField),{error:r.error,kind:r.kind});mcNotice('');}else mcNotice(r.ok?(msg.type===MSG.MC_REVERT?success:''):r.error,!r.ok);
  if(r.ok&&r.verified&&r.settingsOnly&&r.campaign){
    const fields=mcSel.fields.map(f=>{
      const text=f.field==='subject_line'?r.campaign.subject:f.field==='preview_text'?r.campaign.previewText:f.text;
      return text===f.text?f:{...f,text,score:r.predictions?.[f.field]||null,optimization:null};
    });
    mcSel={...mcSel,...r.campaign,fields,fingerprint:null};mcUndo=r.undo||[];
    mcApplied=msg.type===MSG.MC_APPLY?{campaignId:id,field:msg.field,text:fields.find(f=>f.field===msg.field)?.text,undoId:r.undoId,comparison,original:originalField?.text,response:originalField?.optimization?.result}:null;
    const restoreFocus=restoreActionFocus();
    if(msg.type===MSG.MC_APPLY)mcNotice('');
    if(mcApplied)expandMcField(intelligence.organize(fields,{appliedField:mcApplied.field}).next);
    else if(msg.type===MSG.MC_REVERT)expandMcField(fields.find(f=>f.field===actionField));
    mcViewSignature='';mcContext();renderMcDetail();if(mcApplied){motion.confirm(mcActivity.firstElementChild);if(restoreFocus){const next=intelligence.organize(fields,{appliedField:mcApplied.field}).next;const row=[...mcResult.querySelectorAll('.mc-row')].find(el=>el.dataset.key===next?.field);(row?.querySelector(':scope > summary')||mcActivity.querySelector('button'))?.focus({preventScroll:true});}}
    else if(restoreFocus)[...mcResult.querySelectorAll('.mc-row')].find(el=>el.dataset.key===actionField)?.querySelector('summary')?.focus({preventScroll:true});
    // The save is already verified. Refresh body/cache metadata in the
    // background rather than blocking the confirmed UI on two more API reads.
    scheduleMcRefresh(300);
    return;
  }
  // Always re-read after an explicit action, including a stale-content error.
  // A newer edit clears the old score/alternative without starting another job.
  const restoreFocus=restoreActionFocus();
  await loadDrafts(epoch);renderMcDetail();
  if(r.ok){const row=[...mcResult.querySelectorAll('.mc-row')].find(el=>el.dataset.key===msg.field);if(msg.type===MSG.MC_OPTIMIZE)motion.reveal(row?.querySelector('[data-motion-key]'));else motion.confirm(row?.querySelector('.mc-outcome'));if(restoreFocus)row?.querySelector('.mc-row-content button')?.focus({preventScroll:true});}
  if(mcQueued){mcQueued=false;scheduleMcRefresh(1200);}
}
mcResult.addEventListener('change',e=>{
  const field=e.target.dataset.choice;if(!field||!mcSel)return;
  const f=mcSel.fields.find(x=>x.field===field);if(!f)return;
  mcChoices.set(mcSel.id+':'+field+':'+(f.optimization?.cacheId||''),Number(e.target.value));renderMcDetail();motion.reveal(e.target.closest('.mc-row')?.querySelector('[data-motion-key]'));
});
mcResult.addEventListener('click',e=>{
  const b=e.target.closest('[data-op]');if(!b||b.disabled||!mcSel)return;
  const f=mcSel.fields.find(x=>x.field===b.dataset.field);if(!f)return;
  const op=b.dataset.op;
  e.preventDefault();e.stopPropagation();
  if(op==='review'){mcExpanded.add(f.field);renderMcDetail();return;}
  if(op==='copy'){
    navigator.clipboard.writeText(b.dataset.copy||'').then(()=>{b.textContent='Copied';track('recommendation_applied',{surface:'mailchimp',touchpoint:f.touchpoint,state:'copied'});}).catch(()=>tm('Could not copy','err'));
    return;
  }
  if(op==='check-job'){b.disabled=true;b.textContent='Checking…';scheduleMcRefresh(0);return;}
  if(op==='retry-ask'){
    // Second, explicit confirmation for a run whose charge is unknown.
    b.outerHTML=`<button data-op="retry-confirm" data-field="${esc(f.field)}" data-cache="${esc(b.dataset.cache)}">Confirm: this may use ${esc(b.dataset.cost)} credit${b.dataset.cost==='1'?'':'s'} again</button>`;
    return;
  }
  if(op==='retry'||op==='retry-confirm'){mcRetry(f,b.dataset.cache,op==='retry-confirm');return;}
  if(f.location==='html'){mcExpanded.add(f.touchpoint==='cta'?'buttons':'body');if(f.templateDefault)mcExpanded.add('templates');}
  mcAction({type:op==='score'?MSG.MC_SCORE:op==='optimize'?MSG.MC_OPTIMIZE:MSG.MC_APPLY,
    field:f.field,text:f.text,cacheId:f.optimization?.cacheId,alternativeIndex:Number(b.dataset.index||0)},
    op==='apply'?'Applied to campaign':op==='score'?'Checked.':'Recommendation ready.');
});
mcImpact.addEventListener('click',e=>{const b=e.target.closest('[data-context-undo]');if(b)mcAction({type:MSG.MC_REVERT,undoId:b.dataset.contextUndo},'Original restored.');});
mcActivity.addEventListener('click',e=>{
  if(e.target.closest('[data-reload-tab]')){if(mcTabId)chrome.tabs.reload(mcTabId).catch(()=>{});return;}
  const b=e.target.closest('[data-undo]');if(b)mcAction({type:MSG.MC_REVERT,undoId:b.dataset.undo},'Original restored.');
});
/** User-initiated retry of a failed or unknown run. Never automatic. */
async function mcRetry(f,cacheId,confirmUncertain){
  if(!mcSel||mcBusyUi)return;
  const epoch=mcEpoch,op=f.job?.op||'optimize';
  mcBusyUi=true;mcWorkingField=f.field;mcWorkingOp=op==='score'?MSG.MC_SCORE:MSG.MC_OPTIMIZE;renderMcDetail();
  track(op==='score'?'check_started':'optimize_started',{surface:'mailchimp',touchpoint:f.touchpoint,resumed:true});
  const r=await worker({type:MSG.JOB_RETRY,cacheId,confirmUncertain});
  if(epoch!==mcEpoch)return;
  mcBusyUi=false;mcWorkingField=null;mcWorkingOp=null;if(r.usage)renderUsage(r.usage);
  if(!r.ok){mcFailures.set(mcFailureKey(f),{error:r.error,kind:r.kind});track(r.kind==='quota_exhausted'?'credits_insufficient':'api_error',{surface:'mailchimp',op,kind:String(r.kind||'error')});}
  mcViewSignature='';await loadDrafts(epoch);renderMcDetail();
}
btnMcRefresh.addEventListener('click',()=>{if(!mcBusyUi){mcInsights=null;loadDrafts(mcEpoch,true);}});
btnMcSettings.addEventListener('click',openSettings);
chrome.runtime.onMessage.addListener(msg=>{
  if(msg.type===MSG.USAGE_UPDATED)renderUsage(msg.usage);
  if(msg.type===MSG.MC_CONTEXT_CHANGED&&msg.tabId===mcTabId&&uiState==='mailchimp'){
    scheduleMcRefresh();clearTimeout(mcSettleTimer);mcSettleTimer=setTimeout(()=>scheduleMcRefresh(0),5000);
  }
});
// Read-only fallback for saves in iframes and changes outside this Chrome tab.
// While hidden or performing a paid/write action, no refresh is submitted.
setInterval(()=>{if(uiState==='mailchimp'&&!document.hidden&&!mcBusyUi&&mcSel)scheduleMcRefresh(0);},15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&uiState==='mailchimp')scheduleMcRefresh(300);});
window.addEventListener('focus',()=>{if(uiState==='mailchimp')scheduleMcRefresh(300);});


async function init(){
  await loadApiKey();
  worker({type:MSG.USAGE_GET}).then(renderUsage);
  // Keep the version discoverable on hover via the header status chip.
  try{$('headerStatus').title='Persado Assist v'+chrome.runtime.getManifest().version;}catch{}
  track('panel_opened');
  // On Mailchimp, show the drafts; anywhere else, read the page.
  try{const[t]=await chrome.tabs.query({active:true,currentWindow:true});
    if(t?.url)showUrl(t.url);
    if(isMailchimpUrl(t?.url)){lastScanUrl=t.url;await showMailchimp();return;}}catch{}
  setUiState('scan');
  autoScan();
}
init().catch(fatal);
