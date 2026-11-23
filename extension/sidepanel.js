// ─── Language Intelligence Layer — Side Panel ────────────────────────────────
//
// src/messages.js and src/boot.js are loaded as classic scripts BEFORE this
// module (see sidepanel.html) so the shared contract exists and any throw during
// this module's evaluation paints the fatal banner instead of dying silently.

const { MSG, KEYS, CTX, CONTENT_VERSION } = self.PERSADO;
const { GATEWAY_URL, ENDPOINTS, TIMEOUTS, ERR, CAPTURE_SCREENSHOTS: CAPTURE_DEFAULT, ASSET_TYPES, DEMO_MODE, DEMO_DELAYS, DEMO_VARIANTS } = self.PERSADO_CONFIG;
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
const capLine=$('capLine'),resultsContainer=$('resultsContainer'),btnNew=$('btnNewBrief'),btnViewBrief=$('btnViewBrief');
const resHeading=$('resHeading'),resCtx=$('resCtx'),resOrig=$('resOrig'),resOrigText=$('resOrigText'),resNote=$('resNote');
const btnSendPortal=$('btnSendPortal'),portalResult=$('portalResult'),portalPayload=$('portalPayload'),portalDismiss=$('portalDismiss');
const headerStatus=$('headerStatus'),headerText=$('headerStatusText'),toast=$('toast');
// Scan screen (the panel's front door).
const pnlScan=$('panelScan'),scanSub=$('scanSub'),scanUrl=$('scanUrl'),scanCount=$('scanCount'),hdrPage=$('hdrPage');
const btnBackScan=$('btnBackScan'),resStale=$('resStale'),btnRescanStale=$('btnRescanStale'),btnRescan=$('btnRescan'),scanPriority=$('scanPriority'),scanList=$('scanList'),scanDetail=$('scanDetail');
const btnBackToScan=$('btnBackToScan'),pnlSettings=$('panelSettings'),btnSettings=$('btnSettings'),btnBackFromSettings=$('btnBackFromSettings'),apiKeyInput=$('apiKeyInput'),btnSaveKey=$('btnSaveKey'),btnClearKey=$('btnClearKey'),apiKeyState=$('apiKeyState'),btnOpenOptions=$('btnOpenOptions'),pickBar=$('pickBar'),btnCancelPick=$('btnCancelPick'),btnConfirm=$('btnConfirm'),btnOptimize=$('btnOptimize'),btnPick=$('btnPick');

const pnlMailchimp=$('panelMailchimp'),mcSub=$('mcSub'),mcList=$('mcList'),mcDetail=$('mcDetail'),mcSteps=$('mcSteps'),mcResult=$('mcResult'),mcActivity=$('mcActivity');
const btnMcRefresh=$('btnMcRefresh'),btnMcSettings=$('btnMcSettings'),btnMcOptimize=$('btnMcOptimize'),btnMcTestSend=$('btnMcTestSend'),btnMcRevert=$('btnMcRevert');
const usageDot=$('usageDot'),usageConn=$('usageConn'),usageNum=$('usageNum'),usageFill=$('usageFill'),usageOpen=$('usageOpen');
const brandInput=$('brandInput'),industrySelect=$('industrySelect'),btnTestPersado=$('btnTestPersado'),persadoConnState=$('persadoConnState');
const useConn=$('useConn'),useBal=$('useBal'),useBalLbl=$('useBalLbl'),useUsed=$('useUsed'),useReq=$('useReq'),useScore=$('useScore'),useOpt=$('useOpt'),useLast=$('useLast'),useNote=$('useNote');
const btnRefreshUsage=$('btnRefreshUsage'),btnResetUsage=$('btnResetUsage');
const mcKeyInput=$('mcKeyInput'),mcPrefixInput=$('mcPrefixInput'),mcTestEmails=$('mcTestEmails'),mcAllowBody=$('mcAllowBody'),btnMcConnect=$('btnMcConnect'),btnMcDisconnect=$('btnMcDisconnect'),mcState=$('mcState');

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
  await loadApiKey();
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
function sh(p){[pnlScan,pnlConfig,pnlRecord,pnlProcess,pnlBrief,pnlResults,pnlSettings,pnlMailchimp].forEach(x=>x.classList.remove('active'));p.classList.add('active');}
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
  scan:        {panel:pnlScan,    header:'Ready'},
  ready:       {panel:pnlConfig,  header:'Ready'},
  starting:    {panel:pnlRecord,  header:'Starting…', live:true},  // mounted, not yet confirmed live
  recording:   {panel:pnlRecord,  header:'Recording', live:true},
  paused:      {panel:pnlRecord,  header:'Paused',    live:true},  // live shell stays, frozen
  micError:    {panel:pnlRecord,  header:'Error',     retry:true}, // record panel, retry card shown
  working:     {panel:pnlProcess, header:'Working'},
  workingError:{panel:pnlProcess, header:'Error'},                 // process panel, its own error row
  brief:       {panel:pnlBrief,   header:'Done'},
  results:     {panel:pnlResults, header:'Done'},
  settings:    {panel:pnlSettings, header:'Settings'},
  mailchimp:   {panel:pnlMailchimp, header:'Mailchimp'},
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
  // The scan screen knows what page it is on; "Ready" told the reader nothing, so the
  // URL takes that slot. Every other screen keeps the status chip (REC / working).
  if(hdrPage)hdrPage.hidden=state!=='scan';
  if(state!=='scan'&&pickBar)pickBar.hidden=true;
  headerStatus.style.display=state==='scan'?'none':'';
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
function shortUrl(u){
  try{
    const x=new URL(u),segs=x.pathname.split('/').filter(Boolean),host=x.hostname.replace(/^www\./,'');
    // Enough of the path to know which page this is, without spending the header on it.
    if(!segs.length)return host;
    if(segs.length<=2)return host+'/'+segs.join('/');
    return `${host}/${segs[0]}/…/${segs[segs.length-1]}`;
  }catch{return u;}
}
/** The header shows the whole address — only the scheme and "www." are dropped, so a
 *  deep link is still readable in full. It wraps rather than being ellipsised. */
function displayUrl(u){
  if(!u)return '';
  // Whole address, no ellipsis. Only the scheme and "www." are dropped so it still
  // fits a 400px panel; the text stays clean for copying.
  return u.replace(/^[a-z]+:\/\//i,'').replace(/^www\./i,'').replace(/\/$/,'');
}
function showUrl(u){
  currentUrl=u;
  pageUrlEl.textContent=shortUrl(u);
  if(scanUrl){scanUrl.textContent=displayUrl(u);scanUrl.title=u||'';}
}

async function dp(){
  try{const[t]=await chrome.tabs.query({active:true,currentWindow:true});if(t?.url)showUrl(t.url);}
  catch{pageUrlEl.textContent='current page';}
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


// ─── Page scan ───────────────────────────────────────────────────
//
// The panel's front door no longer asks the user to describe the page. It reads
// the page, ranks the copy in it by opportunity (valuable slot × weak copy), and
// offers ONE decision: confirm what is there, or optimize the selected line.
//
// Every score shown here comes from PERSADO_SCAN.scoreCopy — local, rule-based,
// and itemised. No vendor score is claimed and nothing is invented.

const KIND_LABEL={cta:'Call to action',headline:'Headline',body:'Body copy'};
let resMaterialIndex=-1,scanResult=null,scanMaterial=null,scanBusy=false,scanMode='optimize';

const scoreClass=(n)=>n<60?'low':n<73?'mid':'hi';   // weak/fair · good · strong/excellent

async function injectScanner(tabId){
  // messages.js rides along because scan.js reads MSG from it, exactly as the
  // recorder does. Both files are idempotent.
  await chrome.scripting.executeScript({target:{tabId},files:['src/messages.js','src/scan.js']});
}

async function autoScan(){
  if(scanBusy)return;
  scanBusy=true;
  if(btnRescan){btnRescan.disabled=true;btnRescan.textContent='Refreshing…';}
  scanSub.textContent='Reading the page’s copy…';
  scanDetail.style.display='none';
  scanList.innerHTML='<div class="scan-empty">Scanning…</div>';
  try{
    const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error('No active tab.');
    if(tab.url)showUrl(tab.url);
    lastScanUrl=tab.url||lastScanUrl;
    await injectScanner(tab.id);
    const r=await chrome.tabs.sendMessage(tab.id,{type:MSG.SCAN_PAGE});
    if(!r?.ok)throw new Error(r?.error||'The page did not return a scan.');
    scanResult=r;
    // The product line is no longer a question on the scan screen; the scanner's
    // detection still travels with the result and seeds the rewrite prompt.
    const ms=r.materials||[];
    scanCount.textContent=ms.length?`${ms.length} found`:'nothing found';
    scanSub.textContent=ms.length
      ?'Ranked by how much attention the slot gets against how weak the copy is. The top one is the best place to start.'
      :'No buttons or headlines could be read here. Record a brief instead.';
    renderScanList();
  }catch(e){
    scanSub.textContent='This page could not be scanned.';
    scanCount.textContent='—';
    scanList.innerHTML=`<div class="scan-empty">${esc(e?.message||'Chrome does not allow scanning this page.')} Reload the page, or record a brief instead.</div>`;
  }finally{
    scanBusy=false;
    if(btnRescan){btnRescan.disabled=false;btnRescan.textContent='Refresh';}
  }
}

function renderScanList(){
  const ms=scanResult?.materials||[];
  if(!ms.length){scanDetail.style.display='none';return;}
  const top=ms[0];
  scanPriority.innerHTML=top
    ?`Start here: <b>${esc(trunc(top.text,64))}</b> — it takes ${top.prominence}% of the page’s attention and scores ${top.score} (${esc(top.band?.label||'')}), so it is the largest single gain on this page. Everything below it matters less.`
    :'';
  scanList.innerHTML=ms.map((m,i)=>`<div class="scan-row${i===0?' weak':''}" data-i="${i}" role="button" tabindex="0">`
    +`<div class="scan-row-k">${esc(KIND_LABEL[m.kind]||m.kind)}${m.aboveFold?' · above fold':''}</div>`
    +`<div class="scan-row-t">${esc(trunc(m.text,76))}</div>`
    +`<div class="scan-row-s">${i===0?'<span class="scan-badge">Start here</span>':''}`
    +`<span class="scan-score ${scoreClass(m.score)}">${m.score}</span>`
    +`<span class="scan-band ${m.band?.key||''}">${esc(m.band?.label||'')}</span></div></div>`).join('');
  selectMaterial(0);
}

function selectMaterial(i){
  const ms=scanResult?.materials||[];
  scanMaterial=ms[i]||null;
  scanList.querySelectorAll('.scan-row').forEach(r=>r.classList.toggle('sel',+r.dataset.i===i));
  renderScanDetail(scanMaterial);
}

function renderScanDetail(m){
  if(!m){scanDetail.style.display='none';return;}
  const issues=(m.issues||[]).slice(0,5);
  scanDetail.style.display='';
  scanDetail.innerHTML=`<div class="scan-d-title">Scores <b>${m.score}</b>/100 · ${esc(m.band?.label||'')} · ${esc((KIND_LABEL[m.kind]||m.kind).toLowerCase())} · ${m.prominence}% of the page’s attention</div>`
    +(m.cappedBy?`<div class="scan-cap">Topped out at ${esc(m.band?.label||'')}: ${esc(m.cappedBy.why)}.</div>`:'')
    +`<div class="scan-d-copy">“${esc(m.text)}”</div>`
    +`<div class="scan-why">${issues.length
      ?issues.map(x=>`<div class="scan-why-i"><b>−${x.points}</b><span><strong>${esc(x.label)}.</strong> ${esc(x.detail)}</span></div>`).join('')
      :'<div class="scan-why-i"><b>0</b><span>Nothing measurable is working against this copy — it is simply the highest-attention slot on the page.</span></div>'}</div>`;
}

scanList.addEventListener('click',(e)=>{
  const row=e.target.closest('.scan-row');if(!row)return;
  selectMaterial(+row.dataset.i);
});
scanList.addEventListener('keydown',(e)=>{
  const row=e.target.closest('.scan-row');if(!row)return;
  if(e.key==='Enter'||e.key===' '){e.preventDefault();selectMaterial(+row.dataset.i);}
});


// ─── Pick on page ────────────────────────────────────────────────
// For anything the scan skipped — a phrase inside a paragraph, an icon button
// with no text, an element behind a hover state. Selecting text first picks that
// phrase instead of the whole block.

// ─── Settings: Persado key, brand, usage, Mailchimp ─────────────
// The panel WRITES keys to chrome.storage.local and never reads them back into
// the UI or into a request: every Persado and Mailchimp call is made by the
// service worker (src/background.js), which is the only reader. `apiKey` below is
// only a presence flag for the status line.
let apiKey=null;
async function loadApiKey(){
  try{apiKey=!!(await chrome.storage.local.get(KEYS.API_KEY))[KEYS.API_KEY];}catch(e){apiKey=false;}
  return apiKey;
}
function renderKeyState(msg,kind){
  if(!apiKeyState)return;
  apiKeyState.className='set-state'+(kind?' '+kind:'');
  apiKeyState.textContent=msg||(apiKey?'Key saved on this device.':'No key saved yet.');
}
let settingsReturn='scan';
async function openSettings(){
  if(uiState&&uiState!=='settings')settingsReturn=uiState==='mailchimp'?'mailchimp':'scan';
  if(apiKeyInput)apiKeyInput.value='';
  await loadApiKey();renderKeyState();
  await loadSettingsForm();
  renderUsage(await worker({type:MSG.USAGE_GET}));
  setUiState('settings');
}
async function leaveSettings(){
  // Back goes to the front door for the tab that is active NOW (it may have
  // changed to or from Mailchimp while Settings was open).
  let onMc=settingsReturn==='mailchimp';
  try{const[t]=await chrome.tabs.query({active:true,currentWindow:true});if(t?.url)onMc=isMailchimpUrl(t.url);}catch{}
  if(onMc){showMailchimp();return;}
  if(scanResult){setUiState('scan');renderScanList();if(resMaterialIndex>=0)selectMaterial(resMaterialIndex);}
  else{setUiState('scan');autoScan();}
}
if(btnSettings)btnSettings.addEventListener('click',openSettings);
if(btnBackFromSettings)btnBackFromSettings.addEventListener('click',leaveSettings);
if(usageOpen)usageOpen.addEventListener('click',()=>{if(uiState!=='settings')openSettings();});
if(btnOpenOptions)btnOpenOptions.addEventListener('click',()=>{
  if(chrome.runtime.openOptionsPage)chrome.runtime.openOptionsPage();
});
if(btnSaveKey)btnSaveKey.addEventListener('click',async()=>{
  const v=(apiKeyInput.value||'').trim();
  if(!v){renderKeyState('Paste a key first.','err');apiKeyInput.focus();return;}
  try{
    await chrome.storage.local.set({[KEYS.API_KEY]:v});
    apiKey=true;apiKeyInput.value='';
    renderKeyState('Saved. Testing the connection…','on');
    await testPersado();
  }catch(e){renderKeyState('Could not save the key.','err');}
});
if(btnClearKey)btnClearKey.addEventListener('click',async()=>{
  try{
    await chrome.storage.local.remove(KEYS.API_KEY);
    apiKey=false;if(apiKeyInput)apiKeyInput.value='';
    renderKeyState('Key removed.','');
    renderUsage(await worker({type:MSG.USAGE_GET}));
  }catch(e){renderKeyState('Could not remove the key.','err');}
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
  const r=await chrome.storage.local.get([KEYS.PERSADO_SETTINGS,KEYS.MC_SETTINGS,KEYS.MC_API_KEY]).catch(()=>({}));
  return{persado:{brand:'',industry:'',...(r[KEYS.PERSADO_SETTINGS]||{})},mc:{serverPrefix:'',allowBodyOnBuilder:false,testEmails:'',...(r[KEYS.MC_SETTINGS]||{})},mcKey:!!r[KEYS.MC_API_KEY]};
}
async function loadSettingsForm(){
  const s=await readSettings();
  brandInput.value=s.persado.brand||'';industrySelect.value=s.persado.industry||'';
  mcPrefixInput.value=s.mc.serverPrefix||'';mcTestEmails.value=s.mc.testEmails||'';mcAllowBody.checked=!!s.mc.allowBodyOnBuilder;
  mcKeyInput.value='';
  renderMcState(s);
}
function renderMcState(s){
  if(s.mcKey&&s.mc.connectedAt){mcState.className='set-state on';mcState.textContent=`Connected to ${s.mc.accountName||'Mailchimp'} (${s.mc.dc||s.mc.serverPrefix}).`;}
  else if(s.mc.lastError){mcState.className='set-state err';mcState.textContent=s.mc.lastError;}
  else if(s.mcKey){mcState.className='set-state';mcState.textContent='Key saved, not yet verified.';}
  else{mcState.className='set-state';mcState.textContent='Not connected.';}
}
async function savePersadoSettings(){
  const s=await readSettings();
  await chrome.storage.local.set({[KEYS.PERSADO_SETTINGS]:{...s.persado,brand:brandInput.value.trim(),industry:industrySelect.value}});
}
brandInput.addEventListener('change',savePersadoSettings);
industrySelect.addEventListener('change',savePersadoSettings);
async function saveMcSettings(){
  const s=await readSettings();
  await chrome.storage.local.set({[KEYS.MC_SETTINGS]:{...s.mc,serverPrefix:mcPrefixInput.value.trim(),testEmails:mcTestEmails.value.trim(),allowBodyOnBuilder:mcAllowBody.checked}});
}
mcPrefixInput.addEventListener('change',saveMcSettings);
mcTestEmails.addEventListener('change',saveMcSettings);
mcAllowBody.addEventListener('change',saveMcSettings);
btnMcConnect.addEventListener('click',async()=>{
  const k=(mcKeyInput.value||'').trim();
  await saveMcSettings();
  const s=await readSettings();
  if(!k&&!s.mcKey){mcState.className='set-state err';mcState.textContent='Paste a Mailchimp API key first.';mcKeyInput.focus();return;}
  if(k)await chrome.storage.local.set({[KEYS.MC_API_KEY]:k});
  mcKeyInput.value='';
  btnMcConnect.disabled=true;btnMcConnect.textContent='Testing…';
  const r=await worker({type:MSG.MC_TEST});
  btnMcConnect.disabled=false;btnMcConnect.textContent='Save and test';
  renderMcState(await readSettings());
  if(!r.ok){mcState.className='set-state err';mcState.textContent=r.error;}
});
btnMcDisconnect.addEventListener('click',async()=>{
  await worker({type:MSG.MC_DISCONNECT});
  renderMcState(await readSettings());
});

// ─── Usage ──────────────────────────────────────────────────────
// Every number says where it came from. Persado's API has no balance endpoint,
// so "remaining" is a LOCAL ESTIMATE (runs started from this browser × the
// developer portal's published costs) unless Persado itself reported the quota
// exhausted — then it is 0, and says so.
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
  if(u.hasKey){
    usageNum.innerHTML=u.exhausted?'<b>0</b> runs left · per Persado'
      :`<b>${u.remaining}</b> / ${u.quota} runs left <span title="Local estimate">· est.</span>`;
    usageFill.style.width=Math.round((1-u.fraction)*100)+'%';
    usageFill.className=(u.exhausted||u.remaining<=10)?'low':'';
  }else{usageNum.textContent='';usageFill.style.width='0';}
  $('usageBar').title=u.hasKey?`Persado API usage. ${u.exhausted?'Persado reported this key’s quota exhausted.':`Estimated from ${u.requests} request(s) made from this browser since ${fmtWhen(u.since)}; Persado does not report a balance.`}`:'Add a Persado API key in Settings';
  if(useConn){
    useConn.textContent=u.connection?`${u.connection.ok?'Connected':'Failed'} · ${u.connection.message||''} · ${fmtWhen(u.connection.at)}`:(u.hasKey?'Not tested':'No key');
    useBalLbl.textContent=u.exhausted?'Balance':'Remaining (est.)';
    useBal.innerHTML=!u.hasKey?'—':u.exhausted?'0 — Persado reported the quota exhausted'
      :`${u.remaining} of ${u.quota} runs <span class="est">local estimate</span>`;
    useUsed.innerHTML=u.hasKey?`${u.used} runs <span class="est">${u.scoreRuns}×${u.costs.score} score + ${u.optimizeRuns}×${u.costs.optimize} optimize</span>`:'—';
    useReq.textContent=u.hasKey?`${u.requests}${u.failedRequests?` (${u.failedRequests} failed)`:''}`:'—';
    useScore.textContent=u.hasKey?String(u.scoreRuns):'—';
    useOpt.textContent=u.hasKey?String(u.optimizeRuns):'—';
    useLast.textContent=u.hasKey?fmtWhen(u.lastSuccessAt):'—';
    const hdrs=u.serverReported?Object.entries(u.serverReported.headers).map(([k,v])=>`${k}: ${v}`).join(', '):'';
    useNote.textContent=`Persado’s API does not report an account balance, so remaining runs are counted locally from requests made in this browser since ${fmtWhen(u.since)}, against the developer portal’s quota of ${u.quota}. `
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
if(btnResetUsage)btnResetUsage.addEventListener('click',async()=>{renderUsage(await worker({type:MSG.USAGE_RESET}));tm('Local usage count reset');});

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
    renderSingle('confirm',{material:picked,product:currentProduct()});
  }
});

// ─── Confirm / Optimize ──────────────────────────────────────────

function currentProduct(){return (scanResult?.productLine||'').trim();}

btnConfirm.addEventListener('click',()=>persadoRun('score'));

btnOptimize.addEventListener('click',()=>optimizeMaterial());
if(btnRescan)btnRescan.addEventListener('click',()=>autoScan());
// The result card is a dead end unless it can go back to the page's copy list.
function backToList(){
  clearPreview();
  if(resStale)resStale.hidden=true;
  if(!scanResult){setUiState('scan');autoScan();return;}
  setUiState('scan');
  renderScanList();
  if(resMaterialIndex>=0)selectMaterial(resMaterialIndex);
}
if(btnBackScan)btnBackScan.addEventListener('click',backToList);
// Escape leaves the result card too — the header button is small, and a screen you
// cannot leave with the keyboard is still a dead end.
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape')return;
  if(picking){e.preventDefault();cancelPick();return;}
  if(pnlSettings.classList.contains('active')){e.preventDefault();leaveSettings();return;}
  if(!pnlResults.classList.contains('active'))return;
  e.preventDefault();backToList();
});
if(btnRescanStale)btnRescanStale.addEventListener('click',()=>{if(resStale)resStale.hidden=true;setUiState('scan');autoScan();});

function optimizeMaterial(){return persadoRun('optimize');}

/** Brand for account.name when Settings has none: the site's own name. */
function brandFromPage(){
  try{
    const h=new URL(scanResult?.url||currentUrl).hostname.replace(/^www\./,'');
    const parts=h.split('.');const core=parts.length>2&&parts.at(-2).length<=3?parts.at(-3):parts.at(-2)||parts[0];
    return core?core.charAt(0).toUpperCase()+core.slice(1):'';
  }catch{return '';}
}

let runBusy=false;
/**
 * Score or optimize the selected line with the real Persado API (through the
 * worker). Score is one run; optimize is one run that returns ranked
 * alternatives. Nothing here invents a number: every figure on the result card
 * is a field of Persado's response, and an absent field renders as absent.
 */
async function persadoRun(op){
  const m=scanMaterial;
  if(!m){tm('Pick a piece of copy first','err');return;}
  if(runBusy)return;
  runBusy=true;
  const btn=op==='score'?btnConfirm:btnOptimize;
  const label=btn.textContent;
  btn.disabled=true;btn.textContent=op==='score'?'Scoring…':'Optimizing…';
  if(op==='optimize')tm('Persado optimize runs can take a minute or two','ok');
  try{
    const r=await worker({type:op==='score'?MSG.PERSADO_SCORE:MSG.PERSADO_OPTIMIZE,
      text:m.text,kind:m.kind,pageUrl:scanResult?.url||currentUrl,brand:brandFromPage(),
      context:[scanResult?.title?`Page: ${scanResult.title}`:'',m.context?`Nearby copy: ${m.context}`:'',`Objective: ${goalValue}`].filter(Boolean).join('\n')});
    if(r.usage)renderUsage(r.usage);
    if(!r.ok){tm(r.error||'Persado request failed','err');if(r.kind==='no_key'||r.kind==='invalid_key')openSettings();return;}
    renderSingle(op,{material:m,result:r.result,touchpoint:r.touchpoint,product:currentProduct()});
  }finally{
    runBusy=false;btn.disabled=false;btn.textContent=label;
  }
}

function perfTag(v){
  if(!v)return '';
  const t=[];
  if(typeof v.performance==='number')t.push(`<span class="p-tag">Persado score <b>${v.performance}</b>${v.performanceBand?` · ${esc(String(v.performanceBand).toLowerCase())}`:''}</span>`);
  if(typeof v.brandAlignment==='number')t.push(`<span class="p-tag" title="${esc(v.brandRationale||'')}">Brand alignment ${v.brandAlignment}</span>`);
  if(v.compliance){
    const risk=String(v.compliance.risk||'');
    const cls=/^(none|no|low)/i.test(risk)?'clear':/(high|medium|moderate)/i.test(risk)?'flag':'';
    const issue=(v.compliance.issues||[]).find(i=>i.description)?.description;
    t.push(`<span class="p-tag ${cls}" title="${esc(v.compliance.summary||issue||'')}">Compliance: ${esc([v.compliance.state,risk&&('risk '+risk.toLowerCase())].filter(Boolean).join(' · ')||'reported')}</span>`);
  }
  for(const e of (v.emotions||[]).slice(0,2))t.push(`<span class="p-tag">${esc(e)}</span>`);
  return t.length?`<div class="p-meta">${t.join('')}</div>`:'';
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

function renderSingle(mode,sel){
  if(resStale)resStale.hidden=true;
  clearPreview();
  resMaterialIndex=(scanResult?.materials||[]).findIndex(x=>sel.material&&x.id===sel.material.id);
  const m=sel.material;
  scanMode=mode;
  briefPayload=null;recommendations=null;
  const r=sel.result;

  // "confirm" = a picked line shown before any Persado call: measured locally only.
  if(mode==='confirm'||!r){
    resHeading.textContent='Selected copy';
    resCtx.innerHTML=[(KIND_LABEL[m.kind]||'').toUpperCase()].filter(Boolean).map(x=>`<span class="nw">${esc(x)}</span>`).join('');
    capLine.textContent='Not sent to Persado yet';
    resOrig.style.display='none';
    resultsContainer.innerHTML=`<div class="opt-card"><div class="opt-copy">${esc(m.text)}</div>`
      +`<div class="opt-delta">Score it or optimize it with Persado.</div>`
      +`<div class="opt-act"><button class="vc-copybtn" id="btnScoreFromCard">Score</button><button class="vc-optimize" id="btnOptFromCard">Optimize</button></div></div>`;
    resNote.style.display='none';
    resultsContainer.querySelector('#btnScoreFromCard').onclick=()=>persadoRun('score');
    resultsContainer.querySelector('#btnOptFromCard').onclick=()=>persadoRun('optimize');
    finishSingle();return;
  }

  const meta=`<div class="res-note" style="display:block;margin-top:10px;">Persado ${esc(r.kind||mode)} job <span class="mono">${esc(r.jobId||'')}</span>${r.requestId?` · request ${esc(r.requestId)}`:''}${r.source==='demo'?' · demo fixture':''}</div>`;
  if(mode==='score'){
    const v=r.variants[0]||null;
    resHeading.textContent='Scored by Persado';
    resCtx.innerHTML=[(KIND_LABEL[m.kind]||'').toUpperCase(),'WEB PAGE'].map(x=>`<span class="nw">${esc(x)}</span>`).join(' · ');
    capLine.textContent='1 score run · nothing rewritten';
    resOrig.style.display='none';
    resultsContainer.innerHTML=`<div class="opt-card">`
      +`<div class="opt-top"><span class="opt-label">As written</span>${typeof v?.performance==='number'?`<span class="opt-score">Persado<b>${v.performance}</b></span>`:''}</div>`
      +`<div class="opt-copy">${esc(m.text)}</div>`
      +(v?perfTag(v):'<div class="opt-delta">Persado returned no score for this copy.</div>')
      +(typeof v?.performance!=='number'&&v?'<div class="opt-delta">Persado returned no performance score for this channel.</div>':'')
      +`<div class="opt-act"><button class="vc-optimize" id="btnOptFromCard">Optimize this</button><button class="vc-copybtn" id="btnCopyOpt">Copy</button></div>`
      +`</div>`+meta;
    resNote.style.display='none';
    resultsContainer.querySelector('#btnOptFromCard').onclick=()=>persadoRun('optimize');
    const cb=resultsContainer.querySelector('#btnCopyOpt');
    cb.onclick=()=>navigator.clipboard.writeText(m.text).then(()=>{cb.textContent='Copied';}).catch(()=>tm('Could not copy','err'));
    finishSingle();return;
  }

  // optimize
  const tp=sel.touchpoint;
  const alts=r.alternatives||[];
  const best=alts[0]||null;
  const copyOf=(a)=>a?.touchpoints?.[tp]||a?.text||'';
  resHeading.textContent=best?'Optimized by Persado':'No better version found';
  resCtx.innerHTML=[(KIND_LABEL[m.kind]||'').toUpperCase(),'WEB PAGE'].map(x=>`<span class="nw">${esc(x)}</span>`).join(' · ');
  capLine.textContent=`1 optimize run · ${alts.length} alternative${alts.length===1?'':'s'} ranked by Persado`;
  resOrigText.textContent=m.text+(typeof r.control?.performance==='number'?`  ·  Persado score ${r.control.performance}`:'');
  resOrig.style.display='';
  if(!best){
    resultsContainer.innerHTML=`<div class="opt-card"><div class="opt-delta">${esc(r.notice?.message||'Persado returned no alternatives for this copy.')}${r.notice?.code?` (${esc(r.notice.code)})`:''}</div></div>`+meta;
    resNote.style.display='none';finishSingle();return;
  }
  const copy=copyOf(best);
  const delta=typeof best.performance==='number'&&typeof r.control?.performance==='number'
    ?`Persado score <b>${r.control.performance}</b> → <b>${best.performance}</b>`:'';
  resultsContainer.innerHTML=`<div class="opt-card">`
    +`<div class="opt-top"><span class="opt-label">Rank 1</span>${typeof best.performance==='number'?`<span class="opt-score">Persado<b>${best.performance}</b></span>`:''}</div>`
    +`<div class="opt-copy">${esc(copy)}</div>`
    +perfTag(best)
    +(delta?`<div class="opt-delta">${delta}</div>`:'')
    +`<div class="opt-act"><button class="vc-optimize" id="btnPreview">Preview on page</button>`
    +`<button class="vc-copybtn" id="btnCopyOpt">Copy</button></div>`
    +(alts.length>1?`<details class="p-alts"><summary>${alts.length-1} more from Persado</summary>`
      +alts.slice(1).map((a,i)=>`<div class="p-alt"><span>${esc(copyOf(a))}</span><span>${typeof a.performance==='number'?`<b>${a.performance}</b>`:''}</span><button class="vc-copybtn" data-alt="${i+1}">Preview</button></div>`).join('')
      +`</details>`:'')
    +`</div>`+meta;
  resNote.textContent='Previews swap the text in this tab only. Reloading or leaving the page restores the site; nothing is saved to it.';
  resNote.style.display='';
  const pv=resultsContainer.querySelector('#btnPreview');
  let showing=null;
  const show=async(text,btn)=>{
    if(showing===text){await setPreview(false,m);showing=null;btn.textContent=btn===pv?'Preview on page':'Preview';return;}
    if(await setPreview(true,m,text)){
      resultsContainer.querySelectorAll('[data-alt],#btnPreview').forEach(b=>b.textContent=b===pv?'Preview on page':'Preview');
      showing=text;btn.textContent='Restore original';
    }
  };
  pv.onclick=()=>show(copy,pv);
  resultsContainer.querySelectorAll('[data-alt]').forEach(b=>b.onclick=()=>show(copyOf(alts[+b.dataset.alt]),b));
  const cb=resultsContainer.querySelector('#btnCopyOpt');
  cb.onclick=()=>navigator.clipboard.writeText(copy).then(()=>{cb.textContent='Copied';cb.classList.add('done');}).catch(()=>tm('Could not copy','err'));
  finishSingle();
}
function finishSingle(){
  btnViewBrief.style.display='none';
  btnSendPortal.style.display='none';
  btnNewBrief.textContent='Back to list';
  setUiState('results');
}

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
      // Stubs the network call only, and every variant says so (source:'demo').
      console.warn('[persado] DEMO MODE: returning canned variants, no network call');
      await new Promise(r=>setTimeout(r,DEMO_DELAYS.RECOMMEND_MS));
      variants=DEMO_VARIANTS.map(v=>({...v,source:'demo',performance:null}));
    }else{
      // Persado optimizes the page's real copy; the narration is the context.
      if(!element?.text)throw new Error('No on-page copy was found to optimize. Pick a line on the page instead.');
      const r=await worker({type:MSG.PERSADO_OPTIMIZE,text:element.text,kind:element.type==='cta'?'cta':'headline',
        pageUrl:currentUrl,brand:brandFromPage(),context:`Marketer's brief (verbatim): ${narration}\nObjective: ${goalValue}`});
      if(r.usage)renderUsage(r.usage);
      if(!r.ok)throw new Error(r.error||'Persado request failed');
      const tp=r.touchpoint;
      variants=(r.result.alternatives||[]).slice(0,3).map(a=>({copy:a.touchpoints?.[tp]||a.text,rationale:a.brandRationale||'',
        emotion:(a.emotions||[])[0]||'',performance:a.performance,performanceBand:a.performanceBand,persadoCompliance:a.compliance,
        rank:a.rank,source:r.result.source,jobId:r.result.jobId}));
      if(!variants.length)throw new Error(r.result.notice?.message||'Persado returned no alternatives for this copy.');
    }
    if(!variants.length)throw new Error('No variants were returned.');
    recommendations=variants;
    setStep('stepGenerate','done');

    // Steps 4 and 5 are fields of the response just parsed — tick them only if
    // the fields are actually there, and never before this point.
    const hasCompliance=variants.every(v=>v.persadoCompliance);
    setStep('stepCompliance',hasCompliance?'done':'skipped',hasCompliance?'':'Persado returned no compliance result for these variants.');
    const hasScore=variants.some(v=>typeof v.performance==='number');
    setStep('stepScore',hasScore?'done':'skipped',hasScore?'':(DEMO_MODE?'Demo fixture — not scored.':'Persado returned no performance score.'));
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
    procFail('stepGenerate',e.message||'Persado request failed',()=>generateRecommendations(narration));
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
  // The scan screen hid these; the narrated flow still needs them.
  btnViewBrief.style.display='';btnSendPortal.style.display='';
  const n=recommendations?.length||0;
  const b=briefPayload||{};
  // Dynamic heading, singular at 1.
  resHeading.textContent=`${n} variant${n===1?'':'s'} ready`;
  // Context line: OBJECTIVE · PRODUCT LINE · ELEMENT TYPE (type omitted if unknown).
  // Each segment is kept whole (nowrap span); only the " · " separators are break
  // opportunities, so a phrase like "RETAIL BANKING" never splits across lines.
  resCtx.innerHTML=[b.goal||goalValue,PRODUCT_LABELS[b.audience||audienceSelect.value]||b.audience,ASSET_LABELS[b.assetType]]
    .filter(Boolean).map(s=>`<span class="nw">${esc(String(s).toUpperCase())}</span>`).join(' · ');
  // Demoted time-saved line — real duration, structural counts, not a boxed callout.
  capLine.textContent=`Brief captured in ${mmss(briefSec)} · 1 click`;
  // ONE original block from the page — no strikethrough. Omitted when nothing extracted.
  const current=b.element?.text||'';
  resOrigText.textContent=current;
  resOrig.style.display=current?'':'none';

  if(!n){resultsContainer.innerHTML='<div class="empty-state">No variants generated.</div>';return;}
  // No card is "in use" on arrival — that green state now reflects an explicit
  // choice (clicking Use this), not a default.
  selectedVariant=-1;
  const reg=REG_BY_AUDIENCE[b.audience||audienceSelect.value]||'Reg DD';
  // Persado ranks the alternatives; rank 1 is the top pick. No local ranking.
  const topIdx=recommendations.findIndex(v=>v.rank===1);
  resultsContainer.innerHTML=recommendations.map((v,i)=>vcard(v,i,reg,topIdx)).join('');
  resNote.textContent=recommendations[0]?.source==='demo'
    ?'Demo fixture: these variants are canned and were not scored by Persado.'
    :`Scores, ranks and compliance from Persado (job ${recommendations[0]?.jobId||''}).`;
  resNote.style.display='';
}

function vcard(v,i,reg,topIdx){
  const emo=(v.emotion||'').trim();
  const emoPill=emo?`<span class="emotion">${esc(emo.toLowerCase())}</span>`:'<span></span>';
  // Compliance is shown only as Persado reported it; with no report, no badge.
  const pc=v.persadoCompliance;
  const risk=String(pc?.risk||'');
  const comp=pc
    ? `<span class="comp ${/^(none|no|low)/i.test(risk)?'clear':'flag'}" title="${esc(pc.summary||'')}">Compliance: ${esc([pc.state,risk&&('risk '+risk.toLowerCase())].filter(Boolean).join(' · ')||'reported')}</span>`
    : '<span></span>';
  const top=i===topIdx?'<span class="toppick">TOP PICK</span>':'';
  const sel=i===selectedVariant;
  const why=v.rationale?`<details class="vc-why"><summary>Why this works</summary><p class="vc-why-p">${esc(v.rationale)}</p></details>`:'';
  return `<div class="vcard${sel?' sel':''}" data-i="${i}">`
    +`<div class="vc-top">${emoPill}<span class="vc-right">${top}${scoreSlot(v)}</span></div>`
    +`<div class="vc-copy">${esc(v.copy)}</div>`
    +why
    +`<div class="vc-foot">${comp}`
      +`<span class="vc-act">`
        +`<button class="vc-copybtn" data-i="${i}">Copy</button>`
        +`<button class="vc-use" data-i="${i}">${sel?'In use':'Use this'}</button>`
      +`</span></div>`
  +`</div>`;
}
/** Persado's performance score when it returned one; nothing otherwise. */
function scoreSlot(v){
  if(typeof v.performance!=='number')return '';
  return `<span class="vc-score"><span class="mark">PERSADO</span> <b>${v.performance}</b></span>`;
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

// Selection (one at a time) + Copy — delegated once, reads the live recommendations.
resultsContainer.addEventListener('click',(e)=>{
  const use=e.target.closest('.vc-use');
  if(use){
    selectedVariant=+use.dataset.i;
    // One card in use at a time: the chosen card turns green ("In use"), the rest
    // revert to the ink "Use this". Card border follows via the .sel class.
    resultsContainer.querySelectorAll('.vcard').forEach(c=>{
      const on=+c.dataset.i===selectedVariant;
      c.classList.toggle('sel',on);
      const b=c.querySelector('.vc-use');if(b)b.textContent=on?'In use':'Use this';
    });
    return;
  }
  const cp=e.target.closest('.vc-copybtn');
  if(cp){
    const v=recommendations?.[+cp.dataset.i];
    if(!v)return;
    navigator.clipboard.writeText(v.copy).then(()=>{
      // Inline confirmation on the button itself for 2s, then revert.
      cp.textContent='Copied';cp.classList.add('done');
      clearTimeout(cp._copiedTimer);
      cp._copiedTimer=setTimeout(()=>{cp.textContent='Copy';cp.classList.remove('done');},2000);
    }).catch(()=>tm('Could not copy','err'));
  }
});

/** The full delivery payload a Portal integration would receive: brief + variants. */
function portalPayloadText(){
  const brief={...(briefPayload||{})};
  if(brief.images)brief.images=brief.images.map((u,i)=>`<image ${i+1}: ${u.length} chars, ${u.slice(0,23)}…>`);
  // Redact the stand-in model's predictedLift: it is a fabricated number and this
  // dump is shown on screen. The score is Motivation AI's job — render the same
  // seam the cards do, so no invented figure is ever visible on the results screen.
  const variants=(recommendations||[]).map(({predictedLift,...v})=>v);
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
  setUiState('scan');autoScan();
}
// Record-a-brief is retained but is no longer the front door, so it must not be a
// one-way trip: this returns to the page scan without discarding anything.
if(btnBackToScan)btnBackToScan.addEventListener('click',()=>{setUiState('scan');autoScan();});
btnNew.addEventListener('click',()=>{(scanResult&&scanMode)?backToList():resetAll();});

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

// ─── Mailchimp ──────────────────────────────────────────────────
// When the active tab is Mailchimp, the panel's front door is the account's
// draft campaigns instead of a page scan (scanning Mailchimp's own UI would
// only find Mailchimp's buttons). The run itself happens in the worker; this
// screen draws its steps, the original-versus-optimized result, and Revert /
// Send test. Sending to an audience is never offered here.

const MC_HOST=/^https:\/\/[^/]*\.admin\.mailchimp\.com\//i;
const isMailchimpUrl=(u)=>MC_HOST.test(u||'');
const webIdOf=(u)=>{try{const x=new URL(u);const id=x.searchParams.get('id');return /\/campaigns\//.test(x.pathname)&&/^\d+$/.test(id||'')?Number(id):null;}catch{return null;}};
const MC_STEPS=[['read','Reading campaign'],['optimize','Optimizing with Persado'],['write','Updating Mailchimp draft'],['verify','Verifying saved draft']];
const MC_FIELD={subject_line:'Subject line',preview_text:'Preview text'};
const mcFieldLabel=(c)=>MC_FIELD[c.field]||({headline:'Headline',subheadline:'Subheadline',body:'Body',cta:'Button'}[c.touchpoint])||c.field;
let mcDrafts=[],mcSel=null,mcRun={running:false,step:null,error:null,result:null},mcTabWebId=null;

async function showMailchimp(){
  setUiState('mailchimp');
  try{const[t]=await chrome.tabs.query({active:true,currentWindow:true});mcTabWebId=webIdOf(t?.url);}catch{}
  await loadDrafts();
}

async function loadDrafts(){
  mcSub.textContent='Loading drafts…';
  const st=await worker({type:MSG.MC_STATUS,webId:mcTabWebId});
  if(st.usage)renderUsage(st.usage);
  if(!st.persadoKey){mcSub.textContent='Add your Persado API key in Settings to optimize drafts.';mcList.innerHTML='';mcDetail.hidden=true;mcButtons();return;}
  if(!st.connected){mcSub.textContent='Connect your Mailchimp account in Settings.';mcList.innerHTML='';mcDetail.hidden=true;mcButtons();return;}
  const r=await worker({type:MSG.MC_DRAFTS});
  if(!r.ok){mcSub.textContent=r.error;mcList.innerHTML='';mcButtons();return;}
  mcDrafts=r.drafts||[];
  mcSub.textContent=mcDrafts.length?`${st.accountName||'Mailchimp'} · ${mcDrafts.length} draft${mcDrafts.length===1?'':'s'}`:`${st.accountName||'Mailchimp'} · no draft campaigns`;
  // Pre-select the campaign open in the editor, else keep the selection, else the newest.
  const pick=mcDrafts.find(d=>mcTabWebId&&Number(d.webId)===mcTabWebId)||mcDrafts.find(d=>d.id===mcSel?.id)||mcDrafts[0]||null;
  mcSelect(pick?.id);
}

function mcSelect(id){
  const changed=id!==mcSel?.id;
  mcSel=mcDrafts.find(d=>d.id===id)||null;
  if(changed&&!mcRun.running)mcRun={running:false,step:null,error:null,result:null};
  mcList.innerHTML=mcDrafts.map(d=>`<div class="scan-row${d.id===mcSel?.id?' sel':''}" data-id="${esc(d.id)}" role="button" tabindex="0">`
    +`<div class="scan-row-k">${esc(d.contentType==='html'?'Custom HTML':d.contentType==='multichannel'?'New builder':'Drag-and-drop')}${mcTabWebId&&Number(d.webId)===mcTabWebId?' · open in editor':''}</div>`
    +`<div class="scan-row-t">${esc(d.title||d.subject||'(untitled draft)')}</div>`
    +`<div class="scan-row-s"></div></div>`).join('')||'<div class="scan-empty">Create a draft campaign in Mailchimp, then Refresh.</div>';
  renderMcDetail();
}
mcList.addEventListener('click',e=>{const r=e.target.closest('.scan-row');if(r)mcSelect(r.dataset.id);});
mcList.addEventListener('keydown',e=>{const r=e.target.closest('.scan-row');if(r&&(e.key==='Enter'||e.key===' ')){e.preventDefault();mcSelect(r.dataset.id);}});

function mcButtons(){
  btnMcOptimize.disabled=!mcSel||mcRun.running;
  btnMcOptimize.textContent=mcRun.running?'Optimizing…':'Optimize draft';
  btnMcTestSend.disabled=!mcSel||mcRun.running;
}

async function renderMcDetail(){
  mcButtons();
  if(!mcSel){mcDetail.hidden=true;btnMcRevert.hidden=true;return;}
  mcDetail.hidden=false;
  // Steps: only those that actually started are marked.
  const at=MC_STEPS.findIndex(([k])=>k===mcRun.step);
  const failed=!!mcRun.error;
  mcSteps.innerHTML=mcRun.step||mcRun.result?MC_STEPS.map(([k,l],i)=>{
    const cls=mcRun.step==='done'||(mcRun.result&&!failed)?'done':i<at?'done':i===at?(failed?'err':'active'):'';
    return `<div class="mc-step ${cls}"><span class="dot"></span>${esc(l)}</div>`;}).join(''):'';
  let html=`<div class="mc-chg"><div class="mc-chg-f">Subject line</div><div class="mc-now">${esc(mcSel.subject||'(none)')}</div>`
    +`<div class="mc-chg-f" style="margin-top:6px;">Preview text</div><div class="mc-now">${esc(mcSel.previewText||'(none)')}</div></div>`;
  if(mcRun.error)html=`<div class="mc-note err">${esc(mcRun.error)}</div>`+(mcRun.errorKind==='already_optimized'?`<div class="scan-alt"><button class="btn-quiet" id="btnMcForce">Run again anyway</button></div>`:'')+html;
  const r=mcRun.result;
  if(r){
    const applied=(r.changes||[]).filter(c=>c.applied);
    const perf=r.persado?.controlPerformance!=null&&r.alternative?.performance!=null?` Persado score ${r.persado.controlPerformance} → ${r.alternative.performance} (rank ${r.alternative.rank??'–'}).`:'';
    const msg=r.status==='nothing_eligible'?'Nothing in this draft is eligible to optimize.'
      :r.status==='no_change'?(r.message||'Persado returned nothing that passed the safeguards. The draft is unchanged.')
      :r.status==='unverified'?'Written, but Mailchimp did not read every change back. Check the draft, or Revert.'
      :`${applied.length} field${applied.length===1?'':'s'} updated and verified in Mailchimp.${perf} Reload the Mailchimp editor to see them.`;
    html=`<div class="mc-note ${r.status==='ok'?'ok':r.status==='partial'?'ok':'warn'}">${esc(msg)}</div>`
      +(r.changes||[]).map(c=>`<div class="mc-chg"><div class="mc-chg-f">${esc(mcFieldLabel(c))}${c.applied?'':' · kept'}</div>`
        +(c.applied?`<div class="mc-was">${esc(c.original)}</div><div class="mc-now">${esc(c.optimized)}</div>`
          :`<div class="mc-now">${esc(c.original)}</div>${c.reasons?.length?`<div class="mc-why">${esc(c.reasons[0])}</div>`:''}`)+`</div>`).join('')
      +((r.skipped||[]).filter(x=>x.text||x.field==='body').length?`<div class="mc-note">Not sent: ${esc((r.skipped||[]).filter(x=>x.text||x.field==='body').map(x=>`${x.field==='body'?'body':x.text.slice(0,40)} (${x.reason})`).join('; '))}</div>`:'')
      +(r.persado?.jobId?`<div class="mc-act-i"><span class="meta">Persado job ${esc(r.persado.jobId)}${r.persado.requestId?' · request '+esc(r.persado.requestId):''}</span></div>`:'');
  }
  mcResult.innerHTML=html;
  const f=mcResult.querySelector('#btnMcForce');if(f)f.onclick=()=>mcOptimize(true);
  // Status (revert + activity) is re-read only between runs, not on every step.
  if(mcRun.running){btnMcRevert.hidden=true;return;}
  const st=await worker({type:MSG.MC_STATUS,webId:mcSel.webId});
  btnMcRevert.hidden=!st.canRevert||mcRun.running;
  const acts=st.activity||[];
  mcActivity.innerHTML=acts.length?acts.map(a=>`<div class="mc-act-i"><b>${esc(a.action)}</b> · ${esc(a.status)} · ${esc(fmtWhen(a.at))}${a.source==='demo'?' · demo fixture':''}`
    +(a.message?`<div>${esc(a.message)}</div>`:'')+(a.error?`<div class="mc-why">${esc(a.error.message)}</div>`:'')
    +(a.persado?.jobId?`<div class="meta">job ${esc(a.persado.jobId)}</div>`:'')+`</div>`).join(''):'<div class="mc-act-i">No activity for this draft yet.</div>';
}

async function mcOptimize(force){
  if(!mcSel||mcRun.running)return;
  mcRun={running:true,step:'read',error:null,result:null};
  renderMcDetail();
  const r=await worker({type:MSG.MC_OPTIMIZE,campaignId:mcSel.id,force:!!force});
  if(r.usage)renderUsage(r.usage);
  mcRun={running:false,step:r.ok?'done':mcRun.step,error:r.ok?null:r.error,errorKind:r.ok?null:r.kind,result:r.ok?r:null};
  // Pick up the new subject/preview for the list.
  if(r.ok&&(r.status==='ok'||r.status==='partial'||r.status==='unverified')){
    const d=await worker({type:MSG.MC_DRAFTS});
    if(d.ok){mcDrafts=d.drafts;mcSel=mcDrafts.find(x=>x.id===mcSel.id)||mcSel;}
  }
  renderMcDetail();
}
btnMcOptimize.addEventListener('click',()=>mcOptimize(false));
btnMcRefresh.addEventListener('click',loadDrafts);
btnMcSettings.addEventListener('click',openSettings);
btnMcRevert.addEventListener('click',async()=>{
  if(!mcSel)return;
  btnMcRevert.disabled=true;
  const r=await worker({type:MSG.MC_REVERT,campaignId:mcSel.id});
  btnMcRevert.disabled=false;
  if(!r.ok){tm(r.error,'err');return;}
  tm('Original restored in Mailchimp');
  mcRun={running:false,step:null,error:null,result:null};
  await loadDrafts();
});
btnMcTestSend.addEventListener('click',async()=>{
  if(!mcSel)return;
  btnMcTestSend.disabled=true;
  const r=await worker({type:MSG.MC_TEST_SEND,campaignId:mcSel.id});
  btnMcTestSend.disabled=false;
  if(!r.ok){tm(r.error,'err');if(/test e-mail address/i.test(r.error||''))openSettings();return;}
  tm(`Mailchimp sent a test to ${r.sentTo} address${r.sentTo===1?'':'es'}`);
  renderMcDetail();
});

chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.type===MSG.USAGE_UPDATED){renderUsage(msg.usage);return;}
  if(msg.type===MSG.AUTOPILOT_PROGRESS){
    if(!mcSel||msg.campaignId!==mcSel.id)return;
    if(msg.step==='reverted'){if(uiState==='mailchimp')loadDrafts();return;}
    // A run started from the Mailchimp overlay reports here too; when it ends,
    // re-read the drafts so the panel shows the saved copy.
    if(msg.step==='done'){mcRun.step='done';if(!mcRun.running&&uiState==='mailchimp')loadDrafts();return;}
    if(msg.step==='error'){mcRun.error=msg.label;}
    else mcRun.step=msg.step;
    if(uiState==='mailchimp')renderMcDetail();
  }
});

async function init(){
  syncCtxSummary();
  // Screen capture is opt-in (options page). Reflect the stored setting across the
  // screens sections and the privacy note.
  await refreshCaptureFlag();
  // Impossible to mistake a canned run for a live one.
  if(DEMO_MODE)$('demoFlag').style.display='';
  await dp();
  worker({type:MSG.USAGE_GET}).then(renderUsage);
  // The [Persado] wordmark was removed (Chrome's native side-panel bar already shows
  // the mark); keep the version discoverable on hover via the header status chip and
  // the results Done status, both of which persist.
  const ver='Persado Autopilot v'+chrome.runtime.getManifest().version;
  try{$('headerStatus').title=ver;}catch{}
  try{$('resStatus').title=ver;}catch{}
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
  // Nothing recorded yet. On Mailchimp, show the drafts; anywhere else, read the
  // page and put the weakest copy in front of them.
  try{const[t]=await chrome.tabs.query({active:true,currentWindow:true});
    if(isMailchimpUrl(t?.url)){lastScanUrl=t.url;await showMailchimp();return;}}catch{}
  setUiState('scan');
  autoScan();
}
init().catch(fatal);
