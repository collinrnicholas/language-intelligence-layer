// ─── Persado Demo — Side Panel ───────────────────────────────────
// Recording runs in an invisible offscreen document — nothing ever
// covers the page. The panel handles the one-time mic grant: native
// prompt from the panel if Chrome allows it, else a small
// self-closing popup window. Never a full tab.

const GATEWAY = 'http://localhost:8787';
const $ = (id) => document.getElementById(id);

const viewMain=$('viewMain'),viewResults=$('viewResults');
const stateIdle=$('stateIdle'),stateRecording=$('stateRecording'),stateProcessing=$('stateProcessing');
const pageUrlEl=$('pageUrl'),audienceSelect=$('audience'),goalSelect=$('goal');
const btnRecord=$('btnRecord'),btnStopRec=$('btnStopRec'),recTimer=$('recTimer'),recStatus=$('recStatus'),liveTranscript=$('liveTranscript');
const procText=$('procText'),briefQuote=$('briefQuote');
const resultsContainer=$('resultsContainer'),btnExport=$('btnExportBrief'),btnNew=$('btnNewBrief');
const statusChip=$('statusChip'),toast=$('toast');

let narrationTranscript='',recommendations=null,currentUrl='',recSec=0,recTimerId=null,procStepTimer=null;

// ─── UI helpers ──────────────────────────────────────────────────

function tm(m,k='ok'){toast.textContent=m;toast.className='toast '+k;setTimeout(()=>toast.className='toast',4000);}

function showView(v){
  [viewMain,viewResults].forEach(x=>x.classList.remove('active'));
  v.classList.add('active');
}

function setStatus(text,live=false){
  statusChip.textContent=text;
  statusChip.classList.toggle('live',live);
}

function setRecState(state){ // 'idle' | 'recording' | 'processing'
  [stateIdle,stateRecording,stateProcessing].forEach(x=>x.classList.remove('active'));
  ({idle:stateIdle,recording:stateRecording,processing:stateProcessing})[state].classList.add('active');
}

function showRecError(msg){
  recError.textContent=msg;
  recError.style.display=msg?'block':'none';
}

function ut(s){const m=String(Math.floor(s/60)).padStart(2,'0'),ss=String(s%60).padStart(2,'0');recTimer.textContent=m+':'+ss;}
function stt(s=0){recSec=s;ut(recSec);recTimerId=setInterval(()=>{recSec++;ut(recSec);},1000);}
function spt(){if(recTimerId){clearInterval(recTimerId);recTimerId=null;}}
function stopProcSteps(){if(procStepTimer){clearInterval(procStepTimer);procStepTimer=null;}}

function backToIdle(errorMsg){
  spt();stopProcSteps();
  briefQuote.style.display='none';briefQuote.textContent='';
  setRecState('idle');
  showRecError(errorMsg||'');
  chrome.storage.local.remove(['persado:recording','persado:recordingStart']);
  setStatus('Ready');
}

async function dp(){
  try{
    const[t]=await chrome.tabs.query({active:true,currentWindow:true});
    if(t?.url){currentUrl=t.url;try{pageUrlEl.value=new URL(t.url).hostname+new URL(t.url).pathname;}catch{pageUrlEl.value=t.url;}}
  }catch{pageUrlEl.placeholder='current page';}
}

// Update page URL dynamically when user switches tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active) {
    currentUrl = changeInfo.url;
    try { pageUrlEl.value = new URL(changeInfo.url).hostname + new URL(changeInfo.url).pathname; } catch { pageUrlEl.value = changeInfo.url; }
  }
});
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab?.url) {
      currentUrl = tab.url;
      try { pageUrlEl.value = new URL(tab.url).hostname + new URL(tab.url).pathname; } catch { pageUrlEl.value = tab.url; }
    }
  } catch {}
});

// ─── Messages from background worker ────────────────────────────

chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.type==='TRANSCRIPT_READY'){
    narrationTranscript=msg.transcript;
    chrome.storage.local.remove('persado:transcript');
    briefQuote.textContent='"'+msg.transcript+'"';
    briefQuote.style.display='block';
    liveTranscript.style.display='none';
    generateRecommendations(msg.transcript);
  }
  if(msg.type==='TRANSCRIPT_ERROR'){
    liveTranscript.style.display='none';
    backToIdle('Transcription failed: '+(msg.error||'unknown')+' — try recording again.');
  }
  if(msg.type==='LIVE_TRANSCRIPT'){
    liveTranscript.style.display='block';
    liveTranscript.textContent=msg.text||'';
  }
});

// ─── One-time mic grant ──────────────────────────────────────────
// Offscreen docs can't show permission prompts, so the grant must
// come from a visible extension context — once, remembered forever.

async function micPermissionState(){
  try{return (await navigator.permissions.query({name:'microphone'})).state;}
  catch{return 'prompt';}
}

async function ensureMicGrant(){
  const state=await micPermissionState();
  if(state==='granted')return true;
  if(state==='denied'){
    showRecError('Microphone is blocked for this extension. Open chrome://settings/content/microphone, remove the block, then try again.');
    return false;
  }
  // Try the native prompt from the side panel (small bubble by the address bar)
  try{
    const s=await navigator.mediaDevices.getUserMedia({audio:true});
    s.getTracks().forEach(t=>t.stop());
    return true;
  }catch(err){
    if(err.name==='NotFoundError'){
      showRecError('No microphone found — connect a mic and try again.');
      return false;
    }
    // Prompt suppressed in the side panel — fall back to a small
    // self-closing popup window (never a full tab).
    return await popupGrant();
  }
}

function popupGrant(){
  showRecError('');
  setStatus('Mic setup');
  return new Promise((resolve)=>{
    let done=false;
    const listener=(msg)=>{
      if(msg.type!=='MIC_GRANT_RESULT'||done)return;
      done=true;chrome.runtime.onMessage.removeListener(listener);
      setStatus('Ready');
      if(msg.ok){resolve(true);}
      else{
        showRecError(msg.error==='NotFoundError'
          ?'No microphone found — connect a mic and try again.'
          :'Microphone permission was not granted — try again.');
        resolve(false);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    chrome.windows.create({url:chrome.runtime.getURL('micgrant.html'),type:'popup',width:420,height:300,focused:true});
    setTimeout(()=>{if(!done){done=true;chrome.runtime.onMessage.removeListener(listener);setStatus('Ready');resolve(false);}},120000);
  });
}

// ─── Record — offscreen capture, nothing covers the page ─────────

btnRecord.addEventListener('click',async()=>{
  btnRecord.disabled=true;
  showRecError('');
  try{
    if(!await ensureMicGrant())return;

    const r=await chrome.runtime.sendMessage({type:'START_RECORDING'}).catch(()=>null);
    if(!r?.ok){
      showRecError(r?.error==='mic-not-granted'
        ?'Microphone permission missing — click Record to grant it.'
        :'Could not start recording: '+(r?.error||'no response'));
      return;
    }

    setRecState('recording');
    stt();
    setStatus('Recording',true);
    chrome.storage.local.set({'persado:recording':true,'persado:recordingStart':Date.now()});
  }finally{
    btnRecord.disabled=false;
  }
});

// ─── Stop ────────────────────────────────────────────────────────

btnStopRec.addEventListener('click',async()=>{
  spt();
  setRecState('processing');
  procText.textContent='Transcribing…';
  setStatus('Processing');
  chrome.storage.local.remove(['persado:recording','persado:recordingStart']);

  const r=await chrome.runtime.sendMessage({type:'STOP_RECORDING'}).catch(()=>null);
  if(!r?.ok){
    backToIdle((r?.error||'Recording failed')+' — try recording again.');
    return;
  }
  // TRANSCRIPT_READY / TRANSCRIPT_ERROR arrives via broadcast
});

// ─── Generate ────────────────────────────────────────────────────

async function generateRecommendations(narration){
  if(!narration){tm('No brief recorded','err');backToIdle();return;}
  setRecState('processing');
  setStatus('Generating');
  const steps=['Generating variants…','Checking compliance…','Estimating impact…'];
  let si=0;
  procText.textContent=steps[0];
  stopProcSteps();
  procStepTimer=setInterval(()=>{si++;if(si<steps.length)procText.textContent=steps[si];},1500);
  try{
    const resp=await fetch(GATEWAY+'/v1/ai/recommend',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({narration,audience:audienceSelect.value,goal:goalSelect.value,pageUrl:currentUrl}),
    });
    if(!resp.ok)throw new Error((await resp.json().catch(()=>({error:'Gateway error'}))).error||'Gateway '+resp.status);
    recommendations=(await resp.json()).variants||[];
    renderResults();
    briefQuote.style.display='none';
    showView(viewResults);
    setRecState('idle');
    setStatus('Done');
  }catch(e){
    tm(e.message||'Generation failed','err');
    backToIdle('Generation failed — try recording again.');
  }finally{
    stopProcSteps();
  }
}

// ─── Results ─────────────────────────────────────────────────────

function renderResults(){
  if(!recommendations?.length){
    resultsContainer.innerHTML='<div class="empty-state">No variants generated.</div>';
    return;
  }
  resultsContainer.innerHTML=recommendations.map((v,i)=>{
    const clear=v.compliance==='clear';
    const pill=clear
      ?'<span class="pill ok">Compliance: Clear</span>'
      :`<span class="pill warn">Compliance: ${esc(v.complianceNote||'Review')}</span>`;
    return `
    <div class="variant-card">
      <div class="variant-label">VARIANT ${i+1}</div>
      <div class="variant-copy">${esc(v.copy)}</div>
      <div class="variant-rationale">${esc(v.rationale||'')}</div>
      <div class="variant-foot">
        ${pill}
        <span class="lift">Est. lift <b>${esc(v.predictedLift||'+5–12%')}</b></span>
      </div>
    </div>`;
  }).join('');
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

// ─── Export ──────────────────────────────────────────────────────

btnExport.addEventListener('click',()=>{
  if(!recommendations){tm('Nothing to export','err');return;}
  const pl={retail:'Retail Banking',cards:'Credit Cards',mortgage:'Mortgage & Lending',wealth:'Wealth Management',business:'Small Business Banking'};
  const ob={acquisition:'Acquisition','cross-sell':'Cross-Sell',engagement:'Engagement',retention:'Retention',trust:'Trust & Compliance'};
  const variantsHtml=recommendations.map((v,i)=>`
    <div class="variant">
      <div class="v-num">Variant ${i+1}</div>
      <div class="v-copy">${v.copy}</div>
      <div class="v-rationale">${v.rationale||''}</div>
      <div class="v-meta">
        <span class="pill ${v.compliance==='clear'?'clear':'flag'}">${v.compliance==='clear'?'✓ Compliance Clear':'⚠ '+(v.complianceNote||'Review')}</span>
        <span class="pill lift">📈 ${v.predictedLift||'+5–12%'} (illustrative)</span>
      </div>
    </div>
  `).join('');
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Persado Marketing Brief</title>
<style>
  body{font-family:Inter,-apple-system,sans-serif;max-width:700px;margin:40px auto;color:#1A1128;line-height:1.6;font-size:14px;}
  h1{font-size:24px;color:#5C2D91;margin-bottom:4px;}
  .meta{color:#9088A0;font-size:12px;margin-bottom:24px;}
  h2{font-size:16px;color:#5C2D91;margin-top:28px;border-bottom:1px solid #E8E4F0;padding-bottom:4px;}
  blockquote{background:#F8F7FA;border-left:3px solid #5C2D91;padding:12px 16px;margin:12px 0;font-style:italic;color:#5C506C;}
  .variant{background:#F8F7FA;border:1px solid #E8E4F0;border-radius:10px;padding:16px;margin:14px 0;}
  .v-num{font-size:10px;font-weight:700;color:#5C2D91;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;}
  .v-copy{font-size:15px;font-weight:700;margin-bottom:8px;}
  .v-rationale{color:#5C506C;font-size:12px;margin-bottom:10px;}
  .v-meta{display:flex;gap:8px;}
  .pill{font-size:10px;font-weight:600;padding:3px 8px;border-radius:8px;}
  .pill.clear{background:#ECFDF5;color:#065F46;}
  .pill.flag{background:#FFFBEB;color:#92400E;}
  .pill.lift{background:rgba(92,45,145,.08);color:#5C2D91;}
  .disc{background:#FFFBEB;padding:10px 14px;border-radius:8px;font-size:11px;color:#92400E;margin-top:20px;}
  @media print{body{margin:20px;}}
</style></head><body>
<h1>Persado Marketing Brief</h1>
<div class="meta">${currentUrl} · ${pl[audienceSelect.value]} · ${ob[goalSelect.value]}</div>
<h2>Brief</h2>
<blockquote>${narrationTranscript||'(none)'}</blockquote>
<h2>Recommendations</h2>
${variantsHtml}
<div class="disc">⚠ Demo only. Generated by a general-purpose LLM standing in for Persado Motivation AI. Compliance flags are illustrative. Predicted lift is stubbed.</div>
<script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script>
</body></html>`;
  const w=window.open('','_blank','width=800,height=600');
  w.document.write(html);w.document.close();
});

// ─── New brief ───────────────────────────────────────────────────

btnNew.addEventListener('click',()=>{
  narrationTranscript='';recommendations=null;
  resultsContainer.innerHTML='';
  briefQuote.style.display='none';briefQuote.textContent='';
  spt();stopProcSteps();
  showRecError('');
  chrome.storage.local.remove(['persado:recording','persado:transcript','persado:recordingStart']);
  showView(viewMain);
  setRecState('idle');
  setStatus('Ready');
});

// ─── Init ────────────────────────────────────────────────────────

async function init(){
  await dp();
  try{$('versionTag').textContent='v'+chrome.runtime.getManifest().version;}catch{}
  try{
    const s=await chrome.storage.local.get(['persado:recording','persado:recordingStart','persado:transcript']);
    if(s['persado:recording']){
      // Recording lives in the offscreen doc — it survived the panel closing. Resume UI.
      const elapsed=s['persado:recordingStart']?Math.floor((Date.now()-s['persado:recordingStart'])/1000):0;
      setRecState('recording');
      stt(elapsed);
      setStatus('Recording',true);
      return;
    }
    if(s['persado:transcript']){
      narrationTranscript=s['persado:transcript'];
      await chrome.storage.local.remove('persado:transcript');
      await generateRecommendations(narrationTranscript);
      return;
    }
  }catch{}
  setStatus('Ready');
}
init();
