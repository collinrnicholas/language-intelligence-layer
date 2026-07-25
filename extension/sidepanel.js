// ─── Persado Capture — Side Panel ────────────────────────────────
//
// src/messages.js and src/boot.js are loaded as classic scripts BEFORE this
// module (see sidepanel.html) so the shared contract exists and any throw during
// this module's evaluation paints the fatal banner instead of dying silently.

const { MSG, KEYS, CTX, CONTENT_VERSION } = self.PERSADO;
const { GATEWAY_URL, ENDPOINTS, TIMEOUTS, ERR, CAPTURE_SCREENSHOTS: CAPTURE_DEFAULT, ASSET_TYPES, MOCK_SCORES, MOCK_LIFTS, MOCK_SCORE_STYLE, DEMO_MODE, DEMO_DELAYS, DEMO_VARIANTS } = self.PERSADO_CONFIG;
// Runtime value of the screen-capture toggle (options page → chrome.storage.local),
// falling back to the config default. A `let` so it can be refreshed; existing call
// sites keep using the name CAPTURE_SCREENSHOTS.
let CAPTURE_SCREENSHOTS = CAPTURE_DEFAULT;
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
const shotCount=$('shotCount'),shotStrip=$('shotStrip'),recScreens=$('recScreens'),briefScreens=$('briefScreens'),privacyNote=$('privacyNote'),captureFlag=$('captureFlag');
const stepScreensLabel=$('stepScreensLabel');
const transcriptBlock=$('transcriptBlock'),transcriptText=$('transcriptText');
const pnlProcess=$('panelProcess');
const procSub=$('procSub'),pbarFill=$('pbarFill'),briefLine=$('briefLine'),procErr=$('procErr');
const btnRetry=$('btnRetry'),btnStartOver=$('btnStartOver'),btnSaveAudio=$('btnSaveAudio');
const retainNote=$('retainNote'),offlineHint=$('offlineHint');
const resumeCard=$('resumeCard'),resumeMsg=$('resumeMsg'),btnResume=$('btnResume'),btnDiscard=$('btnDiscard'),btnSaveAudio2=$('btnSaveAudio2');
const stepGenerateLabel=$('stepGenerateLabel'),stepComplianceLabel=$('stepComplianceLabel');
const briefSub=$('briefSub'),briefCoverage=$('briefCoverage'),briefFields=$('briefFields');
const briefNarration=$('briefNarration'),btnNarrMore=$('btnNarrMore'),briefShots=$('briefShots'),briefShotCount=$('briefShotCount');
// Narration longer than this (~4 lines at the brief width) collapses behind a
// "Show more" toggle so the brief fits ~360px without scrolling.
const NARR_CLAMP_CHARS=200;
const btnBriefContinue=$('btnBriefContinue'),btnCopyJson=$('btnCopyJson');
const btnSendPersado=$('btnSendPersado'),handoffResult=$('handoffResult'),handoffPayload=$('handoffPayload');
const capLine=$('capLine'),resultsContainer=$('resultsContainer'),btnNew=$('btnNewBrief'),btnViewBrief=$('btnViewBrief');
const resHeading=$('resHeading'),resCtx=$('resCtx'),resOrig=$('resOrig'),resOrigText=$('resOrigText'),resNote=$('resNote');
const btnSendPortal=$('btnSendPortal'),portalResult=$('portalResult'),portalPayload=$('portalPayload'),portalDismiss=$('portalDismiss');
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

/** Read the stored capture setting; the config default when nothing is stored. */
async function readStoredCapture(){
  try{const v=(await chrome.storage.local.get(KEYS.CAPTURE_SCREENSHOTS))[KEYS.CAPTURE_SCREENSHOTS];
    return typeof v==='boolean'?v:CAPTURE_DEFAULT;}catch{return CAPTURE_DEFAULT;}
}
/** Apply everything that depends on the capture flag (screens sections, privacy). */
function applyCaptureUI(){
  // A persistent header indicator whenever capture is on — someone whose screen is
  // being captured must never be unaware of it.
  captureFlag.style.display=CAPTURE_SCREENSHOTS?'':'none';
  recScreens.style.display=CAPTURE_SCREENSHOTS?'':'none';
  briefScreens.style.display=CAPTURE_SCREENSHOTS?'':'none';
  privacyNote.textContent=CAPTURE_SCREENSHOTS
    ?'Your narration, the page’s text, and screenshots of the page are sent — all stay on this device until you review the results.'
    :'Only your narration and the page’s text are sent — no screenshots are taken.';
}
/** Refresh the flag from storage and re-apply. Returns the current value. */
async function refreshCaptureFlag(){CAPTURE_SCREENSHOTS=await readStoredCapture();applyCaptureUI();return CAPTURE_SCREENSHOTS;}
// Human labels for the asset types (config ASSET_TYPES). Used in the context line
// and the Brief override select.
const ASSET_LABELS={'web-headline':'Web headline','web-cta':'Web CTA','email-subject':'Email subject','push':'Push','sms':'SMS','banner':'Banner','social':'Social'};
// Inferred from the extracted element type so the one-click flow needs no extra
// control; overridable in the Brief view. Values MUST be in ASSET_TYPES (smoke).
const ELEMENT_TO_ASSET={headline:'web-headline',cta:'web-cta',promo:'banner',trust:'web-headline'};
function inferAssetType(elType){return ELEMENT_TO_ASSET[elType]||'web-headline';}
// null unless the user overrides in the Brief view; cleared on a new recording.
let assetTypeOverride=null;

function tm(m,k='ok'){toast.textContent=m;toast.className='toast '+k;setTimeout(()=>toast.className='toast',4000);}
// PRIMITIVES — only setUiState may call these. sh() switches the active panel; st()
// renders the header chip. Calling them directly is what let the active panel, the
// header, and the .rec-live.on toggle drift apart (see setUiState).
function sh(p){[pnlConfig,pnlRecord,pnlProcess,pnlBrief,pnlResults].forEach(x=>x.classList.remove('active'));p.classList.add('active');}
// Status chip colour follows real recorder state (§2): red RECORDING, amber
// PAUSED/WORKING/needs-attention, green READY/complete.
function st(t){headerText.textContent=t;headerStatus.className='hdr-st '+(/record/i.test(t)?'rec':/process|generat|error|pause|work/i.test(t)?'work':'');}

// ─── UI state — single source of truth (Part 2) ──────────────────
//
// The active panel, the header chip, and the .rec-live.on / #recRetry toggle were
// previously set by ~10 independent call sites that could disagree — the failure
// mode was a live RECORDING header over a blank body. setUiState is now the ONLY
// place all three move, so they cannot desync. Every former sh()/st()/recLive
// mutation routes through here.
const UI_STATES={
  ready:       {panel:pnlConfig,  header:'Ready'},
  starting:    {panel:pnlRecord,  header:'Starting…', live:true},  // mounted, not yet confirmed live
  recording:   {panel:pnlRecord,  header:'Recording', live:true},
  paused:      {panel:pnlRecord,  header:'Paused',    live:true},  // live shell stays, frozen
  micError:    {panel:pnlRecord,  header:'Error',     retry:true}, // record panel, retry card shown
  working:     {panel:pnlProcess, header:'Working'},
  workingError:{panel:pnlProcess, header:'Error'},                 // process panel, its own error row
  brief:       {panel:pnlBrief,   header:'Done'},
  results:     {panel:pnlResults, header:'Done'},
};
let uiState=null;
// A panel must not be shown before its content is rendered. brief/results are
// filled by renderBrief()/renderResults() immediately before the switch; if that
// order is ever broken, fall back to Ready rather than showing an empty screen.
function paintable(state){
  if(state==='brief')   return briefFields.childElementCount>0;
  if(state==='results') return resultsContainer.childElementCount>0;
  return true;   // config/record/process contents are static markup, always present
}
function setUiState(state){
  const s=UI_STATES[state];
  if(!s){console.error('[persado] setUiState: unknown state',state);return;}
  if(!paintable(state)){console.error('[persado] setUiState('+state+') before its content was rendered → Ready');return setUiState('ready');}
  uiState=state;
  sh(s.panel);
  st(s.header);
  recLive.classList.toggle('on',!!s.live);
  recRetry.style.display=s.retry?'':'none';
  // Part 3: a blank record panel is never a valid end state. If the invariants are
  // ever violated (a future bug), heal to the visible retry rather than show nothing.
  if(assertUiCoherent().some(p=>p.includes('blank'))){
    recRetryMsg.textContent='Recording stopped unexpectedly. Try again.';
    recRetry.style.display='';recLive.classList.remove('on');
    console.warn('[persado] healed a blank record panel → retry');
  }
}

// Dev-time invariant: it must be impossible to show RECORDING without the live UI
// mounted, or to mount .on outside the record panel, or to show the record panel
// blank. Logs loudly (never throws — a broken panel must not also be a dead one).
function assertUiCoherent(){
  const onRecord=pnlRecord.classList.contains('active');
  const live=recLive.classList.contains('on');
  const retry=recRetry.style.display!=='none';
  const recHdr=/record/i.test(headerText.textContent);
  const problems=[];
  if(recHdr && !(onRecord&&live)) problems.push('RECORDING header without a mounted live recorder');
  if(live && !onRecord)           problems.push('.on set while the record panel is not active');
  if(onRecord && !live && !retry) problems.push('record panel shown blank (neither live nor retry)');
  if(problems.length) console.error('[persado] UI INCOHERENT ['+uiState+']: '+problems.join('; '),{onRecord,live,retry,header:headerText.textContent});
  return problems;
}

// ─── Objective chips (single-select) ─────────────────────────────
// Replaces the old <select id="goal">; `goalValue` is what reaches the gateway.
let goalValue=goalChips.querySelector('.chip.selected')?.dataset.value||'cross-sell';
goalChips.addEventListener('click',(e)=>{
  const chip=e.target.closest('.chip');if(!chip)return;
  goalChips.querySelectorAll('.chip').forEach(c=>{const on=c===chip;c.classList.toggle('selected',on);c.setAttribute('aria-checked',on?'true':'false');});
  goalValue=chip.dataset.value;
  syncCtxSummary();
});
// The collapsed Context row must always state what is actually selected.
function syncCtxSummary(){
  const chip=goalChips.querySelector('.chip.selected');
  $('ctxSummary').textContent=`${PRODUCT_LABELS[audienceSelect.value]||audienceSelect.value} · ${chip?chip.textContent:goalValue}`;
}
audienceSelect.addEventListener('change',syncCtxSummary);

// Reflect an options-page toggle live — but not mid-recording (§ don't change it
// mid-recording). It always applies on the NEXT recording via beginRecording's refresh.
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local'||!changes[KEYS.CAPTURE_SCREENSHOTS])return;
  if(uiState==='recording'||uiState==='paused'||uiState==='starting')return;
  refreshCaptureFlag();
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
  // With capture off there are no screens to mention — ground on the page's copy.
  if(!CAPTURE_SCREENSHOTS)return `${head} and the copy on your page are being turned into scored, compliance-checked copy.`;
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
  stepScreensLabel.textContent=CAPTURE_SCREENSHOTS?'Read the captured screens':'Read the page copy';
  stepGenerateLabel.textContent=`Generating ${goalValue} variants`;
  stepComplianceLabel.textContent=`Compliance check — UDAAP, ${REG_BY_AUDIENCE[audienceSelect.value]||'Reg DD'}`;
  setUiState('working');
}

/** Fail one step, leave everything downstream Pending, and offer a way out. */
function procFail(id,reason,retry){
  stopCreep();disarmTimeout();
  setStep(id,'failed',reason);
  STEPS.slice(STEPS.indexOf(id)+1).forEach(s=>setStep(s,'pending'));
  retryFn=typeof retry==='function'?retry:null;
  btnRetry.style.display=retryFn?'':'none';
  procErr.style.display='';
  setUiState('workingError');setActionState('ready');
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
  const n=cov.items.length;
  const list=`<div class="cov-list">`+cov.items.map(i=>
      `<div class="cov ${i.covered?'yes':'no'}"><span class="cov-i"></span>`
      +`<span class="cov-l">${esc(i.label)}</span>`
      +(i.covered?'':`<button class="cov-add" data-add="${i.key}">Add</button>`)
      +`</div>`).join('')+`</div>`;
  if(cov.covered>=n){
    // Everything is covered — the only case with nothing to act on. Collapse to a
    // single line (one check, "N of N"); tapping reveals the itemised list.
    host.innerHTML=`<button class="cov-sum" data-cov-toggle="1" aria-expanded="false">`
      +`<span class="cov-i"></span>`
      +`<span class="cov-sum-l">Brief coverage — ${cov.covered} of ${n}</span>`
      +`<span class="cov-caret"></span></button>`
      +`<div class="cov-detail" style="display:none;">${list}</div>`;
  }else{
    // Something is missing — show the full list so the gap (and its Add) is visible.
    host.innerHTML=`<div class="sec-label">Brief coverage — ${cov.covered} of ${n}</div>`+list;
  }
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
    assetTypeOverride=null;   // a new brief re-infers its asset type
    narrationTranscript=msg.transcript;endRecordingUi('working');
    setStep('stepTranscribe','done');
    generateRecommendations(msg.transcript);
  }
  if(msg.type===MSG.TRANSCRIPT_ERROR){
    endRecordingUi('working');
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

function recordingStartMessage(err){
  const name=err?.name||err?.errorName||'';
  const m=err?.message||String(err||'');
  const both=(name+' '+m);
  if(/NotFoundError|Requested device not found|device not found|no.*device/i.test(both)){
    return 'Chrome could not find a microphone. Connect or select an input, then try again. If a mic is connected, allow Chrome in macOS System Settings → Privacy & Security → Microphone.';
  }
  if(/denied|not allowed|permission|NotAllowed/i.test(both)){
    return 'Microphone access was blocked. Allow it for this site, then try again.';
  }
  if(/NotReadableError|TrackStartError|in use|hardware/i.test(both)){
    return 'Chrome found a microphone but could not start it. Close any app using the mic, then try again.';
  }
  return m||'Recording could not start on this page. Reload the page and try again.';
}

async function beginRecording(){
  await refreshCaptureFlag();   // the recording uses the setting as of its start
  setUiState('starting');
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
    if(!started?.ok){
      const e=new Error(started?.error||'The page did not start recording.');
      e.name=started?.errorName||'';
      throw e;
    }
    if(!await confirmed)throw new Error('No confirmation from the page that recording began.');
  }catch(err){
    recFailed(recordingStartMessage(err));
    return false;
  }
  // Grounding capture — silent, fire-and-forget so it can never delay recording.
  capturePageContext('start');
  recPaused=false;btnPause.textContent='Pause';
  recStatus.textContent=LISTENING;
  trFinal='';trInterim='';renderTranscript();
  renderShots([],0);
  startWave();stt();
  setUiState('recording');
  chrome.storage.local.set({[KEYS.RECORDING]:true,[KEYS.TRANSCRIPT]:'',[KEYS.RECORDING_START]:Date.now()});
  return true;
}

/** Mic/stop/transcribe failure → show the retry state instead of the live UI. */
function recFailed(m){
  spt();stopWave();
  recRetryMsg.textContent=m;
  btnRecord.textContent='Try again';
  btnPause.disabled=false;btnStopRec.disabled=false;
  setUiState('micError');   // record panel + retry card, .on cleared, header Error
  // RECORDING_STARTED may already have flipped the toolbar to recording.
  setActionState('ready');
}

/**
 * Tear down the live capture (timer, wave, analyser) and MOVE to `next`. It no
 * longer clears .on by hand — leaving .on dangling while the panel/header stayed
 * put was the blank-panel bug. Routing through setUiState makes that impossible.
 */
function endRecordingUi(next='working'){
  spt();stopWave();recPaused=false;
  setUiState(next);
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
    setUiState('paused');capturePageContext('pause');
  }else{
    runTimer();freezeWave(false);              // recSec is NOT reset
    btnPause.textContent='Pause';recStatus.textContent=LISTENING;
    setUiState('recording');capturePageContext('resume');
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
  endRecordingUi('working');
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
  handoffResult.style.display='none';   // a fresh brief has not been handed off
  const b=briefPayload||{};
  const el=b.element;
  briefSub.textContent=CAPTURE_SCREENSHOTS
    ?`Captured in ${mmss(briefSec)}${shotTotal?` · ${shotTotal} screen${shotTotal===1?'':'s'}`:''} · ${(b.images||[]).length} sent to the model`
    :`Captured in ${mmss(briefSec)} · page text read · no screenshots`;

  briefCov=evaluateBrief(narrationTranscript,{element:el,goal:b.goal});
  renderCoverage(briefCoverage,briefCov);

  const rows=[
    ['Page',`<span class="mono">${esc(b.pageUrl||currentUrl||'—')}</span>`],
    el?['Element',`<span class="bf-el"${el.selector?` title="${esc(el.selector)}"`:''}>${esc(el.type||'element')}</span><span class="sub">“${esc(el.text||'')}”</span>`]:null,
    ['Product line',esc(PRODUCT_LABELS[b.audience]||b.audience||'—')],
    ['Objective',esc(b.goal||'—')],
    ['Asset type',`<select class="asset-sel" id="assetSelect" aria-label="Asset type">${ASSET_TYPES.map(t=>`<option value="${t}"${t===(b.assetType||'web-headline')?' selected':''}>${esc(ASSET_LABELS[t])}</option>`).join('')}</select>`],
    (b.elements||[]).length?['Also on page',`${(b.elements||[]).length} other element${b.elements.length===1?'':'s'} extracted`]:null,
  ].filter(Boolean);
  briefFields.innerHTML=rows.map(([k,v])=>`<div class="bf"><div class="bf-k">${esc(k)}</div><div class="bf-v">${v}</div></div>`).join('');

  const narr=narrationTranscript||'(no narration captured)';
  briefNarration.textContent=narr;
  // Clamp long narration to ~4 lines behind a "Show more" toggle so the brief
  // fits without scrolling. Threshold is a character heuristic — the panel is
  // hidden when this renders, so measured heights are unreliable.
  const longNarr=narr.length>NARR_CLAMP_CHARS;
  briefNarration.classList.toggle('clamp',longNarr);
  btnNarrMore.style.display=longNarr?'':'none';
  btnNarrMore.textContent='Show more';
  briefShotCount.textContent=shotTotal||0;
  briefShots.innerHTML='';
  if(lastThumbs.length){
    lastThumbs.forEach((src,i)=>{const im=document.createElement('img');im.src=src;im.alt='';
      if(i===lastThumbs.length-1)im.className='newest';briefShots.appendChild(im);});
  }else{
    briefShots.innerHTML='<div class="ph-tile">none</div>';
  }
}

// Override the inferred asset type — re-runs generation against the SAME brief
// (no re-record), so the copy's length and shape change to fit the new format.
briefFields.addEventListener('change',(e)=>{
  const sel=e.target.closest('.asset-sel');if(!sel)return;
  assetTypeOverride=sel.value;
  generateRecommendations(narrationTranscript);
});

// Expand the collapsed "N of N" summary line into the full itemised list.
briefCoverage.addEventListener('click',(e)=>{
  const sum=e.target.closest('.cov-sum');if(!sum)return;
  const detail=briefCoverage.querySelector('.cov-detail');if(!detail)return;
  const open=detail.style.display==='none';
  detail.style.display=open?'':'none';
  sum.setAttribute('aria-expanded',open?'true':'false');
});

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
    beginRecording();
  }
});

// Brief → variants, one tap. If generation somehow has not run yet, fall back to
// kicking it off (the brief is only reachable post-results in the normal flow).
btnBriefContinue.addEventListener('click',()=>{
  if(recommendations?.length){renderResults();setUiState('results');}
  else generateRecommendations(narrationTranscript);
});

// Results → brief, one tap. The brief was rendered when results first opened, so
// this only needs to swap the visible panel.
btnViewBrief.addEventListener('click',()=>{
  if(!briefPayload){tm('No brief captured','err');return;}
  renderBrief();setUiState('brief');
});

// Expand/collapse the clamped narration.
btnNarrMore.addEventListener('click',()=>{
  const clamped=briefNarration.classList.toggle('clamp');
  btnNarrMore.textContent=clamped?'Show more':'Show less';
});

/** The payload as it would go over the wire, with images summarised for reading. */
function readablePayload(){
  const p={...(briefPayload||{})};
  if(p.images)p.images=p.images.map((u,i)=>`<image ${i+1}: ${u.length} chars, ${u.slice(0,23)}…>`);
  return JSON.stringify(p,null,2);
}

// Deliberately a stub: it shows the exact object a real integration would receive,
// so the remaining work reads as plumbing. Never claims to have sent anything.
btnSendPersado.addEventListener('click',()=>{
  if(!briefPayload){tm('No brief to send','err');return;}
  handoffPayload.textContent=readablePayload();
  handoffResult.style.display='';
  handoffResult.scrollIntoView({block:'nearest'});
});

btnCopyJson.addEventListener('click',async()=>{
  if(!briefPayload){tm('No brief to copy','err');return;}
  // Images are the real payload but unreadable as text; summarise them and keep
  // everything else byte-identical to what the gateway received.
  try{
    await navigator.clipboard.writeText(readablePayload());
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
  setUiState('working');armTimeout();

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
  if(CAPTURE_SCREENSHOTS){
    if(frames.length)setStep('stepScreens','done');
    else setStep('stepScreens','skipped','No screens captured — generating from the narration alone.');
  }else{
    // Capture off: the step reads the PAGE COPY. Done only if the DOM extraction
    // actually returned something; never claim work that did not run (§7).
    if(elements.length)setStep('stepScreens','done');
    else setStep('stepScreens','skipped','No on-page copy could be read — generating from the narration alone.');
  }

  // ── Step 3: generate
  const element=pickElement(narration,elements);
  setStep('stepGenerate','active');stage(STAGE.generate);
  console.log('[persado] grounding →',{element:element?.text,candidates:elements.length,
    framesCaptured:frames.length,imagesSent:images.length,
    imageBytes:images.reduce((n,u)=>n+u.length,0)});
  // Built once and RETAINED: the variant cards show `element.text` as the current
  // copy, and the Brief view copies this exact object as JSON. What the audience
  // sees is what the gateway received, not a reconstruction.
  const assetType=assetTypeOverride||inferAssetType(element?.type);
  briefPayload={
    narration,audience:audienceSelect.value,goal:goalValue,pageUrl:currentUrl,assetType,
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
    // Land on results — the variants are the payoff. The brief becomes a
    // destination reached with one tap ("View brief") and left with one tap
    // ("Back to variants"); we render it now so it is ready behind that tap.
    renderResults();
    renderBrief();setUiState('results');
    setActionState('results',recommendations.length);
  }catch(e){
    procFail('stepGenerate',gatewayMessage(e.kind,e.message,e.url),()=>generateRecommendations(narration));
  }
}

// ─── Results ─────────────────────────────────────────────────────

// The model's rhetorical-approach tags. A pill renders ONLY for a value in this
// set — no fallback label — so an absent/unknown emotion just shows nothing.
const EMOTIONS_SET=new Set(['exclusivity','achievement','gratification','curiosity','safety','urgency','recognition','encouragement']);
let selectedVariant=-1;
function trunc(s,n){s=String(s);return s.length>n?s.slice(0,n-1).trimEnd()+'…':s;}

function renderResults(){
  portalResult.style.display='none';selectedVariant=-1;
  const n=recommendations?.length||0;
  const b=briefPayload||{};
  // Dynamic heading, singular at 1.
  resHeading.textContent=`${n} variant${n===1?'':'s'} ready`;
  // Context line: OBJECTIVE · PRODUCT LINE · ELEMENT TYPE (type omitted if unknown).
  resCtx.textContent=[b.goal||goalValue,PRODUCT_LABELS[b.audience||audienceSelect.value]||b.audience,ASSET_LABELS[b.assetType]]
    .filter(Boolean).join(' · ').toUpperCase();
  // Demoted time-saved line — real duration, structural counts, not a boxed callout.
  capLine.textContent=`Brief captured in ${mmss(briefSec)} · 1 click · 0 email threads`;
  // ONE original block from the page — no strikethrough. Omitted when nothing extracted.
  const current=b.element?.text||'';
  resOrigText.textContent=current;
  resOrig.style.display=current?'':'none';

  if(!n){resultsContainer.innerHTML='<div class="empty-state">No variants generated.</div>';return;}
  const reg=REG_BY_AUDIENCE[b.audience||audienceSelect.value]||'Reg DD';
  resultsContainer.innerHTML=recommendations.map((v,i)=>vcard(v,i,reg)).join('');
  // Single footnote — the scores above are sample data, not model output.
  resNote.textContent='Scores are sample data, not Motivation AI output.';
  resNote.style.display='';
}

function vcard(v,i,reg){
  const emo=(v.emotion||'').trim();
  const emoOk=EMOTIONS_SET.has(emo.toLowerCase());
  // Surface a missing/invalid tag rather than swallowing it — a blank slot on the
  // card is a symptom, and this is where to see the cause.
  if(!emoOk)console.warn(`[persado] variant ${i+1} has no valid emotion (got ${JSON.stringify(v.emotion)}) — no pill rendered`);
  const emoPill=emoOk?`<span class="emotion">${esc(emo)}</span>`:'<span></span>';
  // Compliance is a model OPINION, not a pass: no checkmark, one line, "illustrative".
  const clear=v.compliance==='clear';
  const comp=clear
    ? `<span class="comp clear">UDAAP · ${esc(reg)} · illustrative</span>`
    : `<span class="comp flag" title="${esc(v.complianceNote||'')}">Review: ${esc(trunc(v.complianceNote||'flagged',44))}</span>`;
  return `<div class="vcard" data-i="${i}">`
    +`<div class="vc-top">${emoPill}${scoreSlot(i)}</div>`
    +`<div class="vc-copy">${esc(v.copy)}</div>`
    +`<div class="vc-why">${esc(v.rationale||'')}</div>`
    +`<div class="vc-foot">${comp}`
      +`<span class="vc-act">`
        +`<button class="btn-quiet vc-copybtn" data-i="${i}">Copy</button>`
        +`<button class="vc-use" data-i="${i}">Use this</button>`
      +`</span></div>`
  +`</div>`;
}
/**
 * Sample Motivation AI score — deterministic (MOCK_SCORES/MOCK_LIFTS in config),
 * NEVER the gateway's predictedLift. 'index' (default) reads as a neutral score;
 * 'lift' reads as a CTR-lift % per the original mockup. Marked "sample" either way.
 */
function scoreSlot(i){
  if(MOCK_SCORE_STYLE==='lift'){
    const pct=MOCK_LIFTS[i%MOCK_LIFTS.length];
    return `<span class="vc-score lift">+${pct}% CTR</span>`;
  }
  const val=MOCK_SCORES[i%MOCK_SCORES.length];
  return `<span class="vc-score"><span class="lbl">Motivation AI</span> <b>${val}</b> <span class="mark">· sample</span></span>`;
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

// Selection (one at a time) + Copy — delegated once, reads the live recommendations.
resultsContainer.addEventListener('click',(e)=>{
  const use=e.target.closest('.vc-use');
  if(use){
    selectedVariant=+use.dataset.i;
    resultsContainer.querySelectorAll('.vcard').forEach(c=>c.classList.toggle('sel',+c.dataset.i===selectedVariant));
    return;
  }
  const cp=e.target.closest('.vc-copybtn');
  if(cp){
    const v=recommendations?.[+cp.dataset.i];
    if(!v)return;
    navigator.clipboard.writeText(v.copy).then(()=>tm('Copied')).catch(()=>tm('Could not copy','err'));
  }
});

/** The full delivery payload a Portal integration would receive: brief + variants. */
function portalPayloadText(){
  const brief={...(briefPayload||{})};
  if(brief.images)brief.images=brief.images.map((u,i)=>`<image ${i+1}: ${u.length} chars, ${u.slice(0,23)}…>`);
  // Redact the stand-in model's predictedLift: it is a fabricated number and this
  // dump is shown on screen. The score is Motivation AI's job — render the same
  // seam the cards do, so no invented figure is ever visible on the results screen.
  const variants=(recommendations||[]).map(({predictedLift,...v})=>({...v,motivationAIScore:'not connected in this prototype'}));
  return JSON.stringify({brief,variants},null,2);
}
// Stub: shows the exact object a real Portal integration would receive, labelled
// not connected. Never claims to have sent anything.
btnSendPortal.addEventListener('click',()=>{
  if(!recommendations?.length){tm('Nothing to send','err');return;}
  portalPayload.textContent=portalPayloadText();
  portalResult.style.display='';
});
portalDismiss.addEventListener('click',()=>{portalResult.style.display='none';});

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
  resultsContainer.innerHTML='';selectedVariant=-1;portalResult.style.display='none';
  procErr.style.display='none';
  recStatus.textContent='';trFinal='';trInterim='';recSec=0;briefSec=0;shotTotal=0;lastAudio=null;retryFn=null;assetTypeOverride=null;
  ut(0);spt();stopWave();stopCreep();disarmTimeout();setProgress(0);
  STEPS.forEach(id=>setStep(id,'pending'));
  btnPause.disabled=false;btnStopRec.disabled=false;
  chrome.storage.local.remove([KEYS.RECORDING,KEYS.TRANSCRIPT,KEYS.RECORDING_START]);
  chrome.runtime.sendMessage({type:MSG.CLEAR_PAGE_CONTEXT}).catch(()=>{});setActionState('ready');
  setUiState('ready');
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
  syncCtxSummary();
  // Screen capture is opt-in (options page). Reflect the stored setting across the
  // screens sections and the privacy note.
  await refreshCaptureFlag();
  // Impossible to mistake a canned run for a live one.
  if(DEMO_MODE)$('demoFlag').style.display='';
  await dp();
  // The version strip is gone from the header (design target); keep the version
  // discoverable on hover instead of adding a visible element back.
  try{$('brandLockup').title='Persado Capture v'+chrome.runtime.getManifest().version;}catch{}
  refreshOfflineHint();
  // A pending unsent brief means a recording that was STOPPED and failed to
  // transcribe — so the page is not recording. Honour that offer and stop; do not
  // let the recording branch below override it (its return value was discarded before).
  if(await offerResume()){setUiState('ready');return;}
  // No recording runs for hours; a flag older than this is a leftover, not a session.
  const STALE_RECORDING_MS=2*60*60*1000;
  try{const s=await chrome.storage.local.get([KEYS.RECORDING,KEYS.TRANSCRIPT,KEYS.RECORDING_START]);
    if(s[KEYS.RECORDING]){
      // KEYS.RECORDING is a CLAIM, not a fact. Verify the page is ACTUALLY recording
      // before mounting the live UI — a stale flag (extension reload, page nav,
      // worker restart) otherwise resurrects a ghost session over a dead recorder.
      const startedAt=s[KEYS.RECORDING_START]||0;
      let live=false;
      if(startedAt && Date.now()-startedAt<STALE_RECORDING_MS){
        try{const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
          if(tab?.id){const hello=await chrome.tabs.sendMessage(tab.id,{type:MSG.PING}).catch(()=>null);
            live=!!(hello?.ok&&hello.version===CONTENT_VERSION&&hello.recording);}}catch{}
      }
      if(live){
        // Genuinely mid-session: content.js is recording and still posting levels/
        // transcript, so reattach the live UI and pick the clock back up.
        recSec=Math.max(0,Math.round((Date.now()-startedAt)/1000));
        recStatus.textContent=LISTENING;
        renderTranscript();renderShots([],0);
        startWave();ut(recSec);runTimer();
        setUiState('recording');
        try{const c=await chrome.runtime.sendMessage({type:MSG.GET_PAGE_CONTEXT});
          const cf=c?.[CTX.FRAMES];if(cf?.length)renderShots(cf.map(f=>f.thumb),cf.length);}catch{}
        return;
      }
      // Stale, expired, or unverifiable → clear the ghost flag and fall through to Ready.
      console.warn('[persado] stale recording flag (page not recording) — clearing');
      await chrome.storage.local.remove([KEYS.RECORDING,KEYS.RECORDING_START]);
    }
    if(s[KEYS.TRANSCRIPT]){
      narrationTranscript=s[KEYS.TRANSCRIPT];
      await chrome.storage.local.remove(KEYS.TRANSCRIPT);
      procShow();setStep('stepTranscribe','done');
      await generateRecommendations(narrationTranscript);return;
    }
  }catch{}
  setUiState('ready');
}
init().catch(fatal);
