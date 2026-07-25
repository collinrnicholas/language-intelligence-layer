// ─── Persado Demo — Side Panel ───────────────────────────────────
//
// src/messages.js and src/boot.js are loaded as classic scripts BEFORE this
// module (see sidepanel.html) so the shared contract exists and any throw during
// this module's evaluation paints the fatal banner instead of dying silently.

const { MSG, KEYS, CTX, CONTENT_VERSION } = self.PERSADO;
const { GATEWAY_URL, ENDPOINTS, TIMEOUTS, ERR, DEMO_MODE, DEMO_DELAYS, DEMO_VARIANTS } = self.PERSADO_CONFIG;
const fatal = (e) => self.__persadoFatal?.(e);
const $ = (id) => {
  const el = document.getElementById(id);
  // A missing id used to fail later and far away; fail loudly at lookup instead.
  if (!el) throw new Error(`sidepanel.html is missing #${id}`);
  return el;
};

const pnlConfig=$('panelConfigure'),pnlRecord=$('panelRecord'),pnlResults=$('panelResults'),pnlBrief=$('panelBrief');
const pageUrlEl=$('pageUrl'),audienceSelect=$('audience'),goalChips=$('goalChips'),btnStart=$('btnStart');
const btnRecord=$('btnRecord'),btnStopRec=$('btnStopRec'),btnPause=$('btnPause');
const recLive=$('recLive'),recRetry=$('recRetry'),recRetryMsg=$('recRetryMsg');
const recTimer=$('recTimer'),recStatus=$('recStatus'),liveTranscript=$('liveTranscript');
const wave=$('wave'),waveStatic=$('waveStatic'),waveStaticFill=$('waveStaticFill');
const shotCount=$('shotCount'),shotStrip=$('shotStrip');
const transcriptBlock=$('transcriptBlock'),transcriptText=$('transcriptText');
const pnlProcess=$('panelProcess');
const procSub=$('procSub'),pbarFill=$('pbarFill'),briefLine=$('briefLine'),procErr=$('procErr');
const btnRetry=$('btnRetry'),btnStartOver=$('btnStartOver'),btnSaveAudio=$('btnSaveAudio');
const retainNote=$('retainNote'),offlineHint=$('offlineHint');
const resumeCard=$('resumeCard'),resumeMsg=$('resumeMsg'),btnResume=$('btnResume'),btnDiscard=$('btnDiscard'),btnSaveAudio2=$('btnSaveAudio2');
const stepGenerateLabel=$('stepGenerateLabel'),stepComplianceLabel=$('stepComplianceLabel');
const briefSub=$('briefSub'),briefCoverage=$('briefCoverage'),briefFields=$('briefFields');
const briefNarration=$('briefNarration'),briefShots=$('briefShots'),briefShotCount=$('briefShotCount');
const btnBriefContinue=$('btnBriefContinue'),btnCopyJson=$('btnCopyJson');
const capLine=$('capLine'),resultsContainer=$('resultsContainer'),btnExport=$('btnExportBrief'),btnNew=$('btnNewBrief'),btnBackToBrief=$('btnBackToBrief');
const headerStatus=$('headerStatus'),headerText=$('headerStatusText'),toast=$('toast');

const LISTENING='Listening — describe the problem and the audience.';
const PAUSED_MSG='Paused — nothing is being recorded.';

let narrationTranscript='',recommendations=null,currentUrl='',recSec=0,recTimerId=null,recPaused=false;
// Persisted when recording stops so the processing screen can report the real
// duration and screen count after the recording UI is gone.
let briefSec=0,shotTotal=0,lastAudio=null;
// The exact object POSTed to /v1/ai/recommend, kept for the Brief view and the
// variant cards' "Current" line.
let briefPayload=null;

const PRODUCT_LABELS={retail:'Retail Banking',cards:'Credit Cards',mortgage:'Mortgage & Lending',wealth:'Wealth Management',business:'Small Business Banking'};
// Mirrors REG_BY_AUDIENCE in gateway/server.mjs. The UI must never cite a
// regulation the model was not asked to check (claude-design.md §6).
const REG_BY_AUDIENCE={retail:'Reg DD',business:'Reg DD',wealth:'Reg DD',cards:'Reg Z',mortgage:'Reg Z'};

function tm(m,k='ok'){toast.textContent=m;toast.className='toast '+k;setTimeout(()=>toast.className='toast',4000);}
function sh(p){[pnlConfig,pnlRecord,pnlProcess,pnlBrief,pnlResults].forEach(x=>x.classList.remove('active'));p.classList.add('active');}
// Status chip colour follows real recorder state (§2): red RECORDING, amber
// PAUSED/WORKING/needs-attention, green READY/complete.
function st(t){headerText.textContent=t;headerStatus.className='hdr-st '+(/record/i.test(t)?'rec':/process|generat|error|pause|work/i.test(t)?'work':'');}

// ─── Objective chips (single-select) ─────────────────────────────
// Replaces the old <select id="goal">; `goalValue` is what reaches the gateway.
let goalValue=goalChips.querySelector('.chip.selected')?.dataset.value||'cross-sell';
goalChips.addEventListener('click',(e)=>{
  const chip=e.target.closest('.chip');if(!chip)return;
  goalChips.querySelectorAll('.chip').forEach(c=>{const on=c===chip;c.classList.toggle('selected',on);c.setAttribute('aria-checked',on?'true':'false');});
  goalValue=chip.dataset.value;
});

// ─── Timer ───────────────────────────────────────────────────────
function ut(s){const m=String(Math.floor(s/60)).padStart(2,'0'),ss=String(s%60).padStart(2,'0');recTimer.textContent=m+':'+ss;}
function mmss(s){return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}
function runTimer(){spt();recTimerId=setInterval(()=>{recSec++;ut(recSec);},1000);}
function stt(){recSec=0;ut(0);runTimer();}
function spt(){if(recTimerId){clearInterval(recTimerId);recTimerId=null;}}

// ─── Waveform ────────────────────────────────────────────────────
//
// The MediaStream lives in content.js and cannot cross into the panel, so
// content.js reduces each analyser frame to band magnitudes and posts
// AUDIO_LEVELS ~16x/sec. Each message contributes ONE new column here, and the
// columns scroll right-to-left.

const BARS=40,BAR_MIN=3,BAR_MAX=56;
const REDUCED=matchMedia('(prefers-reduced-motion: reduce)').matches;
const barTarget=new Array(BARS).fill(0);   // newest column at the end
const barShown=new Array(BARS).fill(0);    // eased toward target, so it glides
let barEls=[],waveRaf=null;

function buildWave(){
  if(REDUCED||barEls.length)return;
  wave.innerHTML='';
  barEls=Array.from({length:BARS},()=>{const b=document.createElement('div');b.className='bar';wave.appendChild(b);return b;});
}

function pushLevel(levels){
  if(!levels.length)return;
  // Weight the lower (speech) half above the rest so voice moves the bars, not hiss.
  const half=Math.max(1,Math.floor(levels.length/2));
  let lo=0,hi=0;
  for(let i=0;i<levels.length;i++){if(i<half)lo+=levels[i];else hi+=levels[i];}
  const lvl=Math.min(1,(lo/half)*1.2+(hi/Math.max(1,levels.length-half))*0.4);
  barTarget.shift();barTarget.push(lvl);
  if(REDUCED)waveStaticFill.style.width=Math.max(4,lvl*100).toFixed(1)+'%';
}

function waveTick(){
  waveRaf=requestAnimationFrame(waveTick);
  if(!barEls.length)return;   // nothing built yet (or reduced-motion): no-op
  for(let i=0;i<BARS;i++){
    barShown[i]+=(barTarget[i]-barShown[i])*0.35;
    // BAR_MIN floor: silence shows a baseline, never a flat dead line.
    barEls[i].style.height=(BAR_MIN+barShown[i]*(BAR_MAX-BAR_MIN)).toFixed(1)+'px';
  }
}
function startWave(){
  buildWave();
  barTarget.fill(0);barShown.fill(0);
  wave.classList.remove('paused');waveStatic.classList.remove('paused');
  if(!REDUCED&&!waveRaf)waveTick();
}
function stopWave(){if(waveRaf){cancelAnimationFrame(waveRaf);waveRaf=null;}}
/** Paused: stop advancing (bars hold their last heights) and dim to 40%. */
function freezeWave(f){
  wave.classList.toggle('paused',f);waveStatic.classList.toggle('paused',f);
  if(f)stopWave();else if(!REDUCED&&!waveRaf)waveTick();
}

// ─── Live transcript ─────────────────────────────────────────────
// content.js owns the accumulated FINAL text, so it survives every recogniser
// restart; the panel only mirrors what it is told.

let trFinal='',trInterim='';
const STICK_PX=24;
function renderTranscript(){
  const el=liveTranscript;
  // Read the live scroll position rather than caching a flag from the scroll
  // event: the event is delivered asynchronously, so a cached flag can still be
  // stale when text lands and would yank a reading user back to the bottom.
  const atBottom=el.scrollHeight-el.scrollTop-el.clientHeight<STICK_PX;
  if(!trFinal&&!trInterim){el.innerHTML='<span class="ph">Your words appear here as you speak.</span>';return;}
  el.textContent=trFinal;
  if(trInterim){const s=document.createElement('span');s.className='interim';s.textContent=trInterim;el.appendChild(s);}
  el.appendChild(Object.assign(document.createElement('span'),{className:'caret'}));
  if(atBottom)el.scrollTop=el.scrollHeight;   // follow only if they were at the bottom
}

// ─── Processing screen (1c) ──────────────────────────────────────
//
// Every step is driven by a real event. Steps 4 and 5 have NO separate backing
// call — compliance and lift are fields of the single /v1/ai/recommend response,
// so they stay Pending until that response is parsed and the fields are actually
// present (claude-design.md §7: never show a completed step for work that did
// not run). There is no step timer anywhere in this file.

const STEPS=['stepTranscribe','stepScreens','stepGenerate','stepCompliance','stepScore'];
// [floor, ceiling] per stage. The ceiling is never reached and is < 100 for every
// in-flight stage, so the bar cannot imply completion before the response lands.
const STAGE={transcribe:[6,26],screens:[28,46],generate:[48,88]};
const PROC_TIMEOUT_MS=90000;
let procPct=0,procCreep=null,procTimer=null,retryFn=null;

function setStep(id,state,reason){
  const el=$(id);if(!el)return;
  el.className='step'+(state&&state!=='pending'?' '+state:'');
  const r=el.querySelector('.step-r');
  if(r)r.textContent=reason||'';
}
function setProgress(pct){procPct=Math.min(100,pct);pbarFill.style.width=procPct.toFixed(1)+'%';}
/** Creep asymptotically toward the stage ceiling; never reaches it. */
function stage([floor,ceil]){
  stopCreep();
  setProgress(Math.max(procPct,floor));
  if(REDUCED)return;                       // reduced motion: jump only, no creep
  procCreep=setInterval(()=>{if(procPct<ceil)setProgress(procPct+(ceil-procPct)*0.08);},450);
}
function stopCreep(){if(procCreep){clearInterval(procCreep);procCreep=null;}}
function armTimeout(){
  clearTimeout(procTimer);
  procTimer=setTimeout(()=>{
    const active=STEPS.find(id=>$(id).classList.contains('active'));
    procFail(active||'stepGenerate','Timed out after 90 seconds — no response from the gateway.',retryFn);
  },PROC_TIMEOUT_MS);
}
function disarmTimeout(){clearTimeout(procTimer);procTimer=null;}

function procSubtitle(){
  const head=briefSec>0?`Your ${mmss(briefSec)} brief`:'Your brief';
  const subj=shotTotal>0?`${head} and ${shotTotal} captured screen${shotTotal===1?'':'s'} are`:`${head} is`;
  return `${subj} being turned into scored, compliance-checked copy.`;
}

// Chars of narration summary kept in the brief card. Sized so that
// summary + host/path + product line lands inside the card's two-line clamp.
const SUMMARY_MAX=52;
/** One condensed line from the transcript — no extra LLM call. */
function briefSummary(){
  // Before Whisper returns, fall back to the live transcript already captured
  // during recording, so the card shows real words instead of a placeholder.
  const t=(narrationTranscript||trFinal||'').replace(/\s+/g,' ').trim();
  let s='';
  if(t){
    const first=t.match(/^.{15,120}?[.!?](?=\s|$)/);
    s=first?first[0].trim():t;
    // Cap the summary segment so the page and product line still fit inside the
    // card's two-line clamp instead of being pushed out of view.
    if(s.length>SUMMARY_MAX)s=s.slice(0,SUMMARY_MAX).replace(/[\s,;]+\S*$/,'')+'…';
  }
  return [s||'Voice brief',shortUrl(currentUrl),PRODUCT_LABELS[audienceSelect.value]||audienceSelect.value]
    .filter(Boolean).join(' · ');
}

function procShow(){
  STEPS.forEach(id=>setStep(id,'pending'));
  procErr.style.display='none';
  procPct=0;setProgress(0);
  procSub.textContent=procSubtitle();
  briefLine.textContent=briefSummary();
  stepGenerateLabel.textContent=`Generating ${goalValue} variants`;
  stepComplianceLabel.textContent=`Compliance check — UDAAP, ${REG_BY_AUDIENCE[audienceSelect.value]||'Reg DD'}`;
  sh(pnlProcess);st('Working');
}

/** Fail one step, leave everything downstream Pending, and offer a way out. */
function procFail(id,reason,retry){
  stopCreep();disarmTimeout();
  setStep(id,'failed',reason);
  STEPS.slice(STEPS.indexOf(id)+1).forEach(s=>setStep(s,'pending'));
  retryFn=typeof retry==='function'?retry:null;
  btnRetry.style.display=retryFn?'':'none';
  procErr.style.display='';
  if(!pnlProcess.classList.contains('active'))sh(pnlProcess);
  st('Error');setActionState('ready');
}

btnRetry.addEventListener('click',()=>{const f=retryFn;if(f){procErr.style.display='none';retainNote.style.display='none';f();}});
btnResume.addEventListener('click',()=>{resumeCard.style.display='none';procShow();retryTranscribe();});
btnDiscard.addEventListener('click',async()=>{
  // Explicit only — a recording is never discarded automatically.
  await chrome.runtime.sendMessage({type:MSG.DISCARD_PENDING_AUDIO}).catch(()=>{});
  resumeCard.style.display='none';tm('Unsent brief discarded');
});
btnStartOver.addEventListener('click',()=>resetAll());

/**
 * Turn a typed failure into something a bank marketer can act on. A raw
 * "TypeError: Failed to fetch" is never shown — that string is what sent us here.
 */
function gatewayMessage(kind,error,url){
  const at=url||GATEWAY_URL;
  if(kind===ERR.UNREACHABLE)return `Can't reach the Persado service on this machine (${at}). Start it with \`npm run gateway\`, then Try again.`;
  if(kind===ERR.TIMEOUT)return "The service didn't respond in time. Check it is still running, then Try again.";
  if(kind==='no_pending_audio')return 'The recording is no longer available. Record the brief again.';
  // Reachable but unhappy: the gateway's own message is the useful one.
  return error||'The service returned an error.';
}

/** Non-blocking hint on the start screen so the user learns before narrating. */
async function refreshOfflineHint(){
  if(DEMO_MODE){offlineHint.style.display='none';return;}   // no calls to be offline for
  try{
    const h=await chrome.runtime.sendMessage({type:MSG.GATEWAY_HEALTH});
    if(h?.ok){offlineHint.style.display='none';return;}
    offlineHint.textContent=`Persado service offline at ${h?.url||GATEWAY_URL} — start it with \`npm run gateway\` before recording.`;
    offlineHint.style.display='';
  }catch{offlineHint.style.display='none';}
}

/** Offer the raw narration as a file so it is never trapped in the extension. */
async function saveAudio(){
  try{
    const p=await chrome.runtime.sendMessage({type:MSG.GET_PENDING_AUDIO});
    if(!p?.ok||!p.audioData){tm('No recording to save','err');return;}
    const blob=await fetch(p.audioData).then(r=>r.blob());
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download=`persado-brief-${new Date(p.at||Date.now()).toISOString().replace(/[:.]/g,'-')}.webm`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
    tm('Audio saved');
  }catch(e){tm('Could not save the audio','err');}
}
btnSaveAudio.addEventListener('click',saveAudio);
btnSaveAudio2.addEventListener('click',saveAudio);

function dispatchTranscribe(){
  if(!lastAudio){retryTranscribe();return;}   // no local copy — use the retained one
  procErr.style.display='none';retainNote.style.display='none';
  setStep('stepTranscribe','active');stage(STAGE.transcribe);armTimeout();
  chrome.runtime.sendMessage({type:MSG.TRANSCRIBE_AUDIO,audioData:lastAudio}).catch(()=>{});
}

/** Try again re-runs ONLY transcription, against the audio already retained. */
function retryTranscribe(){
  procErr.style.display='none';retainNote.style.display='none';
  setStep('stepTranscribe','active');stage(STAGE.transcribe);armTimeout();
  chrome.runtime.sendMessage({type:MSG.RETRY_TRANSCRIBE}).then((r)=>{
    if(r&&!r.ok&&r.kind==='no_pending_audio')procFail('stepTranscribe',gatewayMessage(r.kind,r.error),null);
  }).catch(()=>{});
}

// ─── Brief completeness ──────────────────────────────────────────
//
// A usable brief names four things. This is a DETERMINISTIC pass over the
// transcript — no LLM call, so it cannot fail, cost anything, or disagree with
// itself between runs. It returns null when it cannot evaluate, and the caller
// hides the component rather than showing four green ticks it did not earn
// (claude-design.md §7).

const COVERAGE_SPEC=[
  {key:'element', label:'Element to change',
   // Covered if the narration names the extracted element, its type, or any
   // on-page element word — i.e. it is talking about something real on the page.
   test:(t,hints)=>{
     const el=hints.element;
     if(el?.text){
       const words=(el.text.toLowerCase().match(/[a-z0-9%$]{4,}/g)||[]);
       if(words.some(w=>t.includes(w)))return true;
     }
     return /\b(headline|header|hero|title|cta|button|link|copy|banner|promo|subject line|body copy|offer)\b/.test(t);
   }},
  {key:'audience', label:'Audience',
   test:(t)=>/\b(customer|customers|member|members|audience|segment|user|users|prospect|holder|holders|existing|new|young|younger|older|professional|professionals|millennial|retiree|retirees|small business|shopper|saver|savers|borrower|cardholder|affluent|mass market)\b/.test(t)},
  {key:'objective', label:'Objective',
   // The chip is an explicit objective, so this is covered unless the user has
   // left the default AND never said anything objective-shaped.
   test:(t,hints)=>/\b(cross.?sell|upsell|acquire|acquisition|acquisitions|convert|conversion|conversions|engage|engagement|retain|retention|sign.?up|signups|open|apply|applications|adoption|activate|activation)\b/.test(t)
     ||(!!hints.goal&&/\b(objective|goal|trying to|want to|need to|aiming)\b/.test(t))},
  {key:'outcome', label:'Desired outcome',
   test:(t)=>/\b(increase|improve|lift|raise|boost|drive|reduce|lower|more|higher|better|fewer|less|so that|because|target|below target|underperform|flat|drop|dropping|declin)\w*\b/.test(t)},
];

/** @returns {null|{items:{key,label,covered}[],covered:number}} */
function evaluateBrief(narration,hints){
  const t=(narration||'').toLowerCase();
  // Too little to judge — say nothing rather than guess.
  if(t.replace(/[^a-z]/g,'').length<25)return null;
  try{
    const items=COVERAGE_SPEC.map(c=>({key:c.key,label:c.label,covered:!!c.test(t,hints||{})}));
    return {items,covered:items.filter(i=>i.covered).length};
  }catch(e){console.warn('[persado] brief evaluation failed',e);return null;}
}

/** Renders into `host`; hides it when evaluation returned null. */
function renderCoverage(host,cov){
  if(!cov){host.style.display='none';host.innerHTML='';return;}
  host.style.display='';
  host.innerHTML=`<div class="sec-label">Brief coverage — ${cov.covered} of 4</div>`
    +`<div class="cov-list">`+cov.items.map(i=>
      `<div class="cov ${i.covered?'yes':'no'}"><span class="cov-i"></span>`
      +`<span class="cov-l">${esc(i.label)}</span>`
      +(i.covered?'':`<button class="cov-add" data-add="${i.key}">Add</button>`)
      +`</div>`).join('')+`</div>`;
}

// ─── Screens captured ────────────────────────────────────────────
function renderShots(thumbs,count){
  shotTotal=count||0;
  if(thumbs?.length)lastThumbs=thumbs.slice();   // reused by the Brief view
  shotCount.textContent=shotTotal;
  if(!thumbs?.length){shotStrip.innerHTML='<div class="ph-tile">waiting</div>';return;}
  shotStrip.innerHTML='';
  thumbs.forEach((src,i)=>{
    const im=document.createElement('img');im.src=src;im.alt='';
    if(i===thumbs.length-1)im.className='newest';   // newest carries the red border
    shotStrip.appendChild(im);
  });
  shotStrip.scrollLeft=shotStrip.scrollWidth;
}

// The chip is display-only: it shows hostname + first path segment, while
// `currentUrl` keeps the full URL that is sent to the gateway.
function shortUrl(u){try{const x=new URL(u),seg=x.pathname.split('/').filter(Boolean)[0];return x.hostname.replace(/^www\./,'')+(seg?'/'+seg:'');}catch{return u;}}
function showUrl(u){currentUrl=u;pageUrlEl.textContent=shortUrl(u);}

async function dp(){
  try{const[t]=await chrome.tabs.query({active:true,currentWindow:true});if(t?.url)showUrl(t.url);}
  catch{pageUrlEl.textContent='current page';}
}
chrome.tabs.onUpdated.addListener((tabId,ci,tab)=>{if(ci.url&&tab.active)showUrl(ci.url);});
chrome.tabs.onActivated.addListener(async(a)=>{try{const t=await chrome.tabs.get(a.tabId);if(t?.url)showUrl(t.url);}catch{}});

// ─── Messages ────────────────────────────────────────────────────

let levelMsgCount=0; // instrumentation for the AUDIO_LEVELS rate

chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.type===MSG.AUDIO_LEVELS){levelMsgCount++;pushLevel(msg.levels||[]);return;}
  if(msg.type===MSG.RECORDING_STARTED){recStartWaiter?.();return;}
  if(msg.type===MSG.CONTENT_ERROR){fatal('Recorder error in the page: '+msg.error);return;}
  if(msg.type===MSG.SHOTS_UPDATED){renderShots(msg.thumbs,msg.count);return;}
  if(msg.type===MSG.TRANSCRIPT_READY){
    narrationTranscript=msg.transcript;endRecordingUi();
    setStep('stepTranscribe','done');
    generateRecommendations(msg.transcript);
  }
  if(msg.type===MSG.TRANSCRIPT_ERROR){
    endRecordingUi();
    procFail('stepTranscribe',gatewayMessage(msg.kind,msg.error,msg.url),retryTranscribe);
    // Say plainly that the narration is safe, or offer to save it if it is not.
    if(msg.retained){
      retainNote.textContent='Your recording is saved on this device — Try again re-sends it, no need to record again.';
      btnSaveAudio.style.display='';
    }else{
      retainNote.textContent='This recording could not be held in memory. Save the audio to keep it.';
      btnSaveAudio.style.display='';
    }
    retainNote.style.display='';
  }
  if(msg.type===MSG.LIVE_TRANSCRIPT){
    if(typeof msg.final==='string'){trFinal=msg.final;trInterim=msg.interim||'';}
    else if(msg.text){trFinal=msg.text;trInterim='';}
    renderTranscript();
  }
});

// ─── Start screen → recording ────────────────────────────────────

btnStart.addEventListener('click',async()=>{
  narrationTranscript='';transcriptText.textContent='';transcriptBlock.style.display='none';
  recRetry.style.display='none';
  chrome.storage.local.remove([KEYS.RECORDING,KEYS.TRANSCRIPT,KEYS.RECORDING_START]);
  chrome.runtime.sendMessage({type:MSG.CLEAR_PAGE_CONTEXT}).catch(()=>{});
  sh(pnlRecord);
  await beginRecording();
});

// btnRecord is the retry affordance on the mic-error state.
btnRecord.addEventListener('click',()=>beginRecording());

/**
 * Starts a recording. The content-script injection sequence below is unchanged —
 * getUserMedia stays in the page context so the mic permission prompt works.
 */
/**
 * Guarantee a CURRENT content script in the tab before driving it.
 *
 * The old code assumed a successful sendMessage meant a usable script. After an
 * extension reload, an open tab still hosts the previous build; and re-running
 * the file used to throw a redeclaration error, leaving nothing listening. So:
 * PING, and only accept a reply whose version matches ours. messages.js is
 * injected alongside content.js because content.js reads the shared contract.
 */
async function ensureContentScript(tabId){
  const ping=async()=>{try{return await chrome.tabs.sendMessage(tabId,{type:MSG.PING});}catch{return null;}};
  let r=await ping();
  if(r?.ok&&r.version===CONTENT_VERSION)return r;
  await chrome.scripting.executeScript({target:{tabId},files:['src/messages.js','src/content.js']});
  r=await ping();
  if(!r?.ok)throw new Error('The page did not respond after injecting the recorder. Reload the page and try again.');
  if(r.version!==CONTENT_VERSION)throw new Error(`Recorder version mismatch (page has ${r.version}, panel expects ${CONTENT_VERSION}). Reload the page.`);
  return r;
}

// Armed BEFORE START_RECORDING is sent, so the confirmation cannot be missed.
let recStartWaiter=null;
function awaitRecordingStarted(ms){
  return new Promise((resolve)=>{
    const t=setTimeout(()=>{recStartWaiter=null;resolve(false);},ms);
    recStartWaiter=()=>{clearTimeout(t);recStartWaiter=null;resolve(true);};
  });
}

async function beginRecording(){
  recRetry.style.display='none';
  recLive.classList.add('on');
  recStatus.textContent='Starting…';
  btnPause.disabled=false;btnStopRec.disabled=false;
  try{
    const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error('No active tab');
    const hello=await ensureContentScript(tab.id);
    // A recorder left running by an abandoned session would make START_RECORDING
    // a no-op; clear it first so we never drive a stale recorder.
    if(hello.recording)await chrome.tabs.sendMessage(tab.id,{type:MSG.STOP_RECORDING}).catch(()=>{});
    const confirmed=awaitRecordingStarted(3000);
    const started=await chrome.tabs.sendMessage(tab.id,{type:MSG.START_RECORDING});
    // sendMessage RESOLVES with {ok:false} on a mic failure — it does not throw.
    // Not checking this is what let the UI show a live session over a dead recorder.
    if(!started?.ok)throw new Error(started?.error||'The page did not start recording.');
    if(!await confirmed)throw new Error('No confirmation from the page that recording began.');
  }catch(err){
    const m=err?.message||'';
    recFailed(/denied|not allowed|permission|NotAllowed/i.test(m)
      ? 'Microphone access was blocked. Allow it for this site, then try again.'
      : (m||'Recording could not start on this page. Reload the page and try again.'));
    return false;
  }
  // Grounding capture — silent, fire-and-forget so it can never delay recording.
  capturePageContext('start');
  recPaused=false;btnPause.textContent='Pause';
  recStatus.textContent=LISTENING;
  trFinal='';trInterim='';renderTranscript();
  renderShots([],0);
  startWave();stt();
  st('Recording');
  chrome.storage.local.set({[KEYS.RECORDING]:true,[KEYS.TRANSCRIPT]:'',[KEYS.RECORDING_START]:Date.now()});
  return true;
}

/** Mic/stop/transcribe failure → show the retry state instead of the live UI. */
function recFailed(m){
  spt();stopWave();
  recLive.classList.remove('on');
  recRetry.style.display='';
  recRetryMsg.textContent=m;
  btnRecord.textContent='Try again';
  btnPause.disabled=false;btnStopRec.disabled=false;
  // RECORDING_STARTED may already have flipped the toolbar to recording.
  st('Error');setActionState('ready');
}

/** Tear down the live UI once recording is over (transcribing/generating next). */
function endRecordingUi(){
  spt();stopWave();recPaused=false;
  recLive.classList.remove('on');
}

// ─── Pause / Resume ──────────────────────────────────────────────
// Resuming continues the SAME MediaRecorder, so audio, transcript and captured
// screens all carry over.

btnPause.addEventListener('click',async()=>{
  const next=!recPaused;
  let r=null;
  try{
    const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error('No active tab');
    r=await chrome.tabs.sendMessage(tab.id,{type:next?MSG.PAUSE_RECORDING:MSG.RESUME_RECORDING});
  }catch{r=null;}
  if(!r?.ok){tm(r?.error||('Could not '+(next?'pause':'resume')),'err');return;}
  recPaused=next;
  if(recPaused){
    spt();freezeWave(true);
    btnPause.textContent='Resume';recStatus.textContent=PAUSED_MSG;
    st('Paused');capturePageContext('pause');
  }else{
    runTimer();freezeWave(false);              // recSec is NOT reset
    btnPause.textContent='Pause';recStatus.textContent=LISTENING;
    st('Recording');capturePageContext('resume');
  }
});

// ─── Stop ────────────────────────────────────────────────────────

btnStopRec.addEventListener('click',async()=>{
  spt();stopWave();
  briefSec=recSec;                       // real duration, kept for the 1c subtitle
  lastAudio=null;
  btnPause.disabled=true;btnStopRec.disabled=true;
  chrome.storage.local.remove(KEYS.RECORDING);
  // 1c owns everything from here, so step 1 is visible as Active while the audio
  // is still being pulled out of the page.
  endRecordingUi();
  procShow();
  setStep('stepTranscribe','active');stage(STAGE.transcribe);armTimeout();
  try{
    const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error('No tab');
    capturePageContext('stop');
    chrome.tabs.sendMessage(tab.id,{type:MSG.STOP_RECORDING},(r)=>{
      if(chrome.runtime.lastError||!r?.ok){
        procFail('stepTranscribe',(r?.error||'No audio captured')+'. Record the brief again.',null);
        return;
      }
      lastAudio=r.audioData;
      dispatchTranscribe();
    });
  }catch(err){procFail('stepTranscribe','The recording could not be stopped.',null);}
});

// The worker owns the toolbar icon/badge; the panel just reports transitions it
// alone knows about (results ready, brief reset).
function setActionState(state,count){chrome.runtime.sendMessage({type:MSG.SET_ACTION_STATE,state,count}).catch(()=>{});}

// ─── Page grounding ──────────────────────────────────────────────
//
// The background worker captures the screenshots + on-page copy; the panel only
// asks for it. Every call is best-effort — without grounding the model still
// generates from narration alone.

async function capturePageContext(phase){
  try{
    const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)return;
    await chrome.runtime.sendMessage({type:MSG.CAPTURE_PAGE_CONTEXT,phase,tabId:tab.id,windowId:tab.windowId});
  }catch(e){console.warn('[persado] page context capture failed',e);}
}

const TYPE_WORDS={headline:['headline','header','heading','title','h1'],cta:['cta','button','call to action','link','submit'],promo:['promo','promotion','offer','banner','deal','rate'],trust:['trust','badge','disclaimer','fine print','disclosure','legal']};
// Filler that appears in both narration and page copy — a hit on these is noise,
// not a reference, and would otherwise outweigh an explicit element-type mention.
const STOP=new Set('the and you your our for that this with not are but more less just very need needs want copy text feel feels was has have its from they them all can get got too why how what when about really think like look looks seems seem right now here there been being into out off over under again still also much many some any one two than then only page make sure work works'.split(' '));

/** Prefer the element the narration actually names; otherwise the most prominent one. */
function pickElement(narration,elements){
  if(!elements?.length)return null;
  const low=(narration||'').toLowerCase();
  const words=new Set((low.match(/[a-z0-9$%]{3,}/g)||[]).filter(w=>!STOP.has(w)));
  let best=elements[0],bestScore=0;
  elements.forEach((el,i)=>{
    const toks=(el.text||'').toLowerCase().match(/[a-z0-9$%]{3,}/g)||[];
    let score=new Set(toks.filter(w=>words.has(w))).size*2;
    if((TYPE_WORDS[el.type]||[]).some(w=>low.includes(w)))score+=3; // naming the type is a strong signal
    score+=(elements.length-i)*0.05; // prominence tiebreak — elements arrive pre-sorted
    if(score>bestScore){bestScore=score;best=el;}
  });
  return bestScore>0?best:elements[0];
}

// ─── Brief view ──────────────────────────────────────────────────
//
// The captured artifact, shown as its own screen. Everything here comes from the
// payload the gateway actually received, so the demo cannot show a brief that
// differs from what was sent.

let briefCov=null,lastThumbs=[];

function renderBrief(){
  const b=briefPayload||{};
  const el=b.element;
  briefSub.textContent=`Captured in ${mmss(briefSec)}${shotTotal?` · ${shotTotal} screen${shotTotal===1?'':'s'}`:''} · ${(b.images||[]).length} sent to the model`;

  briefCov=evaluateBrief(narrationTranscript,{element:el,goal:b.goal});
  renderCoverage(briefCoverage,briefCov);

  const rows=[
    ['Page',`<span class="mono">${esc(b.pageUrl||currentUrl||'—')}</span>`],
    el?['Element',`${esc(el.type||'element')} · <span class="mono">${esc(el.selector||'')}</span><span class="sub">“${esc(el.text||'')}”</span>`]:null,
    ['Product line',esc(PRODUCT_LABELS[b.audience]||b.audience||'—')],
    ['Objective',esc(b.goal||'—')],
    (b.elements||[]).length?['Also on page',`${(b.elements||[]).length} other element${b.elements.length===1?'':'s'} extracted`]:null,
  ].filter(Boolean);
  briefFields.innerHTML=rows.map(([k,v])=>`<div class="bf"><div class="bf-k">${esc(k)}</div><div class="bf-v">${v}</div></div>`).join('');

  briefNarration.textContent=narrationTranscript||'(no narration captured)';
  briefShotCount.textContent=shotTotal||0;
  briefShots.innerHTML='';
  if(lastThumbs.length){
    lastThumbs.forEach((src,i)=>{const im=document.createElement('img');im.src=src;im.alt='';
      if(i===lastThumbs.length-1)im.className='newest';briefShots.appendChild(im);});
  }else{
    briefShots.innerHTML='<div class="ph-tile">none</div>';
  }
}

// One-tap gap filler: type the missing piece, or re-record just that piece.
briefCoverage.addEventListener('click',(e)=>{
  const btn=e.target.closest('.cov-add');if(!btn)return;
  const key=btn.dataset.add;
  const row=btn.closest('.cov');
  if(row.querySelector('.covfill'))return;
  const label=COVERAGE_SPEC.find(c=>c.key===key)?.label||'detail';
  const box=document.createElement('div');
  box.className='covfill';
  box.innerHTML=`<textarea placeholder="Add the ${esc(label.toLowerCase())} in your own words…"></textarea>`
    +`<div class="covfill-a"><button class="btn btn-outline btn-sm" data-save="1">Add to brief</button>`
    +`<button class="btn-quiet" data-rerec="1">Record instead</button></div>`;
  row.after(box);
  box.querySelector('textarea').focus();
});

briefCoverage.addEventListener('click',(e)=>{
  const box=e.target.closest('.covfill');if(!box)return;
  if(e.target.dataset.save){
    const text=box.querySelector('textarea').value.trim();
    if(!text)return;
    // Appended to the narration, so the brief stays a single record of what was
    // said plus what was added — and re-evaluated against the real text.
    narrationTranscript=(narrationTranscript+' '+text).trim();
    if(briefPayload)briefPayload.narration=narrationTranscript;
    box.remove();renderBrief();tm('Added to the brief');
  }
  if(e.target.dataset.rerec){
    box.remove();
    // Re-recording appends to this same brief rather than starting a new one.
    tm('Recording again — this adds to the same brief');
    sh(pnlRecord);beginRecording();
  }
});

btnBriefContinue.addEventListener('click',()=>{
  if(recommendations?.length){renderResults();sh(pnlResults);st('Done');}
  else generateRecommendations(narrationTranscript);
});

btnBackToBrief.addEventListener('click',()=>{renderBrief();sh(pnlBrief);});

btnCopyJson.addEventListener('click',async()=>{
  if(!briefPayload){tm('No brief to copy','err');return;}
  // Images are the real payload but unreadable as text; summarise them and keep
  // everything else byte-identical to what the gateway received.
  const shown={...briefPayload};
  if(shown.images)shown.images=shown.images.map((u,i)=>`<image ${i+1}: ${u.length} chars, ${u.slice(0,23)}…>`);
  try{
    await navigator.clipboard.writeText(JSON.stringify(shown,null,2));
    tm('Brief JSON copied');
  }catch{tm('Could not copy','err');}
});

// ─── Generate ────────────────────────────────────────────────────

/**
 * Send up to MAX_SEND frames: first, last, and two spread through the middle, so
 * the model sees the start state, the end state, and what happened between.
 */
const MAX_SEND=4;
function pickFrames(frames){
  if(!frames?.length)return [];
  if(frames.length<=MAX_SEND)return frames.slice();
  const mid=frames.slice(1,-1);
  return [frames[0],mid[Math.floor(mid.length/3)],mid[Math.floor(mid.length*2/3)],frames[frames.length-1]].filter(Boolean);
}

async function generateRecommendations(narration){
  if(!narration){procFail('stepTranscribe','No brief was captured.',null);return;}
  narrationTranscript=narration;
  if(!pnlProcess.classList.contains('active'))procShow();
  briefLine.textContent=briefSummary();
  setStep('stepTranscribe','done');
  procErr.style.display='none';
  st('Working');armTimeout();

  // ── Step 2: read the captured screens
  setStep('stepScreens','active');stage(STAGE.screens);
  let ctx={};
  try{ctx=await chrome.runtime.sendMessage({type:MSG.GET_PAGE_CONTEXT})||{};}
  catch(e){console.warn('[persado] no page context',e);}
  const frames=Array.isArray(ctx[CTX.FRAMES])?ctx[CTX.FRAMES]:[];
  const elements=Array.isArray(ctx[CTX.ELEMENTS])?ctx[CTX.ELEMENTS]:[];
  shotTotal=frames.length;
  procSub.textContent=procSubtitle();

  // `full` is the 1200px frame; `thumb` is the 120px strip image and must never be sent.
  const images=pickFrames(frames).map(f=>f?.full).filter(u=>typeof u==='string'&&u.startsWith('data:image/'));
  // Regression guard: frames were captured but nothing reached the payload. This
  // exact class of bug (a renamed context field) silently disabled vision before.
  if(frames.length&&!images.length){
    console.error(`[persado] REGRESSION: ${frames.length} frame(s) captured but the payload has no images.`
      +' Check the stored frames shape in background.js — expected [{full,thumb}].');
  }
  if(frames.length)setStep('stepScreens','done');
  else setStep('stepScreens','skipped','No screens captured — generating from the narration alone.');

  // ── Step 3: generate
  const element=pickElement(narration,elements);
  setStep('stepGenerate','active');stage(STAGE.generate);
  console.log('[persado] grounding →',{element:element?.text,candidates:elements.length,
    framesCaptured:frames.length,imagesSent:images.length,
    imageBytes:images.reduce((n,u)=>n+u.length,0)});
  // Built once and RETAINED: the variant cards show `element.text` as the current
  // copy, and the Brief view copies this exact object as JSON. What the audience
  // sees is what the gateway received, not a reconstruction.
  briefPayload={
    narration,audience:audienceSelect.value,goal:goalValue,pageUrl:currentUrl,
    ...(element?{element}:{}),
    ...(elements.length>1?{elements:elements.filter(e=>e!==element)}:{}),
    ...(images.length?{images}:{}),
  };
  try{
    let variants;
    if(DEMO_MODE){
      // Stubs the network call only. The payload above was still assembled from a
      // real recording, real screenshots and real extracted copy.
      console.warn('[persado] DEMO MODE: returning canned variants, no network call');
      await new Promise(r=>setTimeout(r,DEMO_DELAYS.RECOMMEND_MS));
      variants=DEMO_VARIANTS.map(v=>({...v}));
    }else{
      const resp=await fetch(GATEWAY_URL+ENDPOINTS.RECOMMEND,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(briefPayload)});
      if(!resp.ok)throw new Error((await resp.json().catch(()=>({error:'Gateway error'}))).error||'Gateway '+resp.status);
      variants=(await resp.json()).variants||[];
    }
    if(!variants.length)throw new Error('The gateway returned no variants.');
    recommendations=variants;
    setStep('stepGenerate','done');

    // Steps 4 and 5 are fields of the response just parsed — tick them only if
    // the fields are actually there, and never before this point.
    const hasCompliance=variants.every(v=>typeof v.compliance==='string'&&v.compliance);
    setStep('stepCompliance',hasCompliance?'done':'skipped',hasCompliance?'':'The response carried no compliance fields.');
    // Always SKIPPED: no Motivation AI is wired in, so nothing scored these. The
    // gateway still returns predictedLift (contract unchanged) — we just refuse to
    // present a general-purpose model's guess as a score (claude-design.md §7).
    setStep('stepScore','skipped','Motivation AI is not connected in this prototype.');
    stopCreep();disarmTimeout();setProgress(100);

    // Brief hold so the finished checklist and the full bar actually render before
    // the next screen replaces them. Nothing is computed during it.
    await new Promise(r=>setTimeout(r,REDUCED?0:420));
    renderResults();
    // The captured brief is the point of the demo, so it is the screen we land on;
    // results are one tap away and stay reachable.
    renderBrief();sh(pnlBrief);st('Done');
    setActionState('results',recommendations.length);
  }catch(e){
    procFail('stepGenerate',gatewayMessage(e.kind,e.message,e.url),()=>generateRecommendations(narration));
  }
}

// ─── Results ─────────────────────────────────────────────────────

function renderResults(){
  // Real duration; the click and thread counts are structural facts about this
  // flow, not invented benchmark figures.
  capLine.innerHTML=`Brief captured in <b>${esc(mmss(briefSec))}</b> · <b>1</b> click · <b>0</b> email threads`;
  if(!recommendations?.length){resultsContainer.innerHTML='<div class="empty-state">No variants generated.</div>';return;}
  // `current` is the copy actually on the page, so the card reads current → proposed
  // and the grounding is visible rather than implied. Omitted when nothing was
  // extracted — a placeholder would imply we had it.
  const current=briefPayload?.element?.text||'';
  resultsContainer.innerHTML=recommendations.map((v,i)=>`<div class="rec-card">`
    +`<div class="rh">`
      +`<div class="rn">Variant ${i+1}</div>`
      +(current?`<div class="rc"><span class="rc-l">Current</span><span class="rc-t">${esc(current)}</span></div>`:'')
      +`<div class="rv">${esc(v.copy)}</div>`
    +`</div>`
    +`<div class="rb">`
      +`<div class="rrationale">${esc(v.rationale||'')}</div>`
      +`<div class="rr" style="margin-top:8px;justify-content:space-between;">`
        +`<span class="badge ${v.compliance==='clear'?'clear':'flag'}">${v.compliance==='clear'?'Compliance: clear':'Compliance: '+esc(v.complianceNote||'review')}</span>`
        // The integration seam, shown as an empty slot rather than GPT-4o's guess
        // dressed up as a score. predictedLift still arrives; we just don't print it.
        +`<span class="badge seam">Motivation AI score — not connected</span>`
      +`</div>`
    +`</div>`
  +`</div>`).join('');
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

// ─── Export PDF ──────────────────────────────────────────────────

btnExport.addEventListener('click',()=>{
  if(!recommendations){tm('Nothing to export','err');return;}
  const pl={retail:'Retail Banking',cards:'Credit Cards',mortgage:'Mortgage & Lending',wealth:'Wealth Management',business:'Small Business Banking'};
  // Must track the objective chip set, or a new objective exports as "undefined".
  const ob={'cross-sell':'Cross-Sell',acquisition:'Acquisition',engagement:'Engagement',conversion:'Conversion',retention:'Retention'};
  const vh=recommendations.map((v,i)=>`<div class="variant"><div class="v-num">Variant ${i+1}</div><div class="v-copy">${v.copy}</div><div class="v-rationale">${v.rationale||''}</div><div class="v-meta"><span class="pill ${v.compliance==='clear'?'clear':'flag'}">${v.compliance==='clear'?'✓ Compliance Clear':'⚠ '+(v.complianceNote||'Review')}</span><span class="pill lift">📈 ${v.predictedLift||'+5–12%'} (illustrative)</span></div></div>`).join('');
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Persado Brief</title><style>body{font-family:Inter,sans-serif;max-width:700px;margin:40px auto;color:#1A1128;line-height:1.6;font-size:14px}h1{font-size:24px;color:#5C2D91}.meta{color:#9088A0;font-size:12px;margin-bottom:24px}h2{font-size:16px;color:#5C2D91;margin-top:28px;border-bottom:1px solid #E8E4F0;padding-bottom:4px}blockquote{background:#F8F7FA;border-left:3px solid #5C2D91;padding:12px 16px;margin:12px 0;font-style:italic;color:#5C506C}.variant{background:#F8F7FA;border:1px solid #E8E4F0;border-radius:10px;padding:16px;margin:14px 0}.v-num{font-size:10px;font-weight:700;color:#5C2D91;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}.v-copy{font-size:15px;font-weight:700;margin-bottom:8px}.v-rationale{color:#5C506C;font-size:12px;margin-bottom:10px}.v-meta{display:flex;gap:8px}.pill{font-size:10px;font-weight:600;padding:3px 8px;border-radius:8px}.pill.clear{background:#ECFDF5;color:#065F46}.pill.flag{background:#FFFBEB;color:#92400E}.pill.lift{background:rgba(92,45,145,.08);color:#5C2D91}.disc{background:#FFFBEB;padding:10px 14px;border-radius:8px;font-size:11px;color:#92400E;margin-top:20px}@media print{body{margin:20px}}</style></head><body><h1>Persado Marketing Brief</h1><div class="meta">${currentUrl} · ${pl[audienceSelect.value]} · ${ob[goalValue]}</div><h2>Brief</h2><blockquote>${narrationTranscript||'(none)'}</blockquote><h2>Recommendations</h2>${vh}<script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`;
  const w=window.open('','_blank','width=800,height=600');w.document.write(html);w.document.close();
});

// ─── New ─────────────────────────────────────────────────────────

function resetAll(){
  // Start over is an explicit discard of the retained recording — the only path
  // besides a successful transcription that drops it.
  chrome.runtime.sendMessage({type:MSG.DISCARD_PENDING_AUDIO}).catch(()=>{});
  resumeCard.style.display='none';retainNote.style.display='none';
  // Best-effort: never abandon a live recorder in the page.
  chrome.tabs.query({active:true,currentWindow:true})
    .then(([t])=>t?.id&&chrome.tabs.sendMessage(t.id,{type:MSG.STOP_RECORDING}).catch(()=>{}))
    .catch(()=>{});
  narrationTranscript='';recommendations=null;briefPayload=null;briefCov=null;lastThumbs=[];transcriptText.textContent='';transcriptBlock.style.display='none';
  resultsContainer.innerHTML='';
  recRetry.style.display='none';recLive.classList.remove('on');procErr.style.display='none';
  recStatus.textContent='';trFinal='';trInterim='';recSec=0;briefSec=0;shotTotal=0;lastAudio=null;retryFn=null;
  ut(0);spt();stopWave();stopCreep();disarmTimeout();setProgress(0);
  STEPS.forEach(id=>setStep(id,'pending'));
  btnPause.disabled=false;btnStopRec.disabled=false;
  chrome.storage.local.remove([KEYS.RECORDING,KEYS.TRANSCRIPT,KEYS.RECORDING_START]);
  chrome.runtime.sendMessage({type:MSG.CLEAR_PAGE_CONTEXT}).catch(()=>{});setActionState('ready');
  sh(pnlConfig);st('Ready');
}
btnNew.addEventListener('click',resetAll);

/** "You have an unsent brief from {time}" — shown on the start screen. */
async function offerResume(){
  try{
    const p=await chrome.runtime.sendMessage({type:MSG.GET_PENDING_AUDIO});
    if(!p?.ok)return false;
    const when=new Date(p.at||Date.now());
    const hhmm=when.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
    resumeMsg.textContent=`You have an unsent brief from ${hhmm} that was never transcribed. Try again to send it, or discard it.`;
    resumeCard.style.display='';
    return true;
  }catch{return false;}
}

async function init(){
  // Impossible to mistake a canned run for a live one.
  if(DEMO_MODE)$('demoFlag').style.display='';
  await dp();
  // The version strip is gone from the header (design target); keep the version
  // discoverable on hover instead of adding a visible element back.
  try{$('brandLockup').title='Persado Demo v'+chrome.runtime.getManifest().version;}catch{}
  refreshOfflineHint();
  await offerResume();
  try{const s=await chrome.storage.local.get([KEYS.RECORDING,KEYS.TRANSCRIPT,KEYS.RECORDING_START]);
    if(s[KEYS.RECORDING]){
      // Reopened mid-session: content.js is still recording and still posting
      // levels/transcript, so reattach the live UI and pick the clock back up.
      recSec=Math.max(0,Math.round((Date.now()-(s[KEYS.RECORDING_START]||Date.now()))/1000));
      recLive.classList.add('on');recStatus.textContent=LISTENING;
      renderTranscript();renderShots([],0);
      startWave();ut(recSec);runTimer();
      sh(pnlRecord);st('Recording');
      try{const c=await chrome.runtime.sendMessage({type:MSG.GET_PAGE_CONTEXT});
        const cf=c?.[CTX.FRAMES];if(cf?.length)renderShots(cf.map(f=>f.thumb),cf.length);}catch{}
      return;
    }
    if(s[KEYS.TRANSCRIPT]){
      narrationTranscript=s[KEYS.TRANSCRIPT];
      await chrome.storage.local.remove(KEYS.TRANSCRIPT);
      procShow();setStep('stepTranscribe','done');
      await generateRecommendations(narrationTranscript);return;
    }
  }catch{}
  st('Ready');
}
init().catch(fatal);
