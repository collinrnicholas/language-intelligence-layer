// ─── Persado Demo — Voice-First Brief Recorder ───────────────────
//
// Flow: Configure → Record Brief → Transcribe → Generate → Results

const GATEWAY = 'http://localhost:8787';

const $ = (id) => document.getElementById(id);

// ─── Panels ──────────────────────────────────────────────────────
const pnlConfig  = $('panelConfigure');
const pnlRecord  = $('panelRecord');
const pnlResults = $('panelResults');

// ─── Config ──────────────────────────────────────────────────────
const pageUrlEl      = $('pageUrl');
const audienceSelect = $('audience');
const goalSelect     = $('goal');
const btnStart       = $('btnStart');

// ─── Record ──────────────────────────────────────────────────────
const btnRecord      = $('btnRecord');
const btnStopRec     = $('btnStopRec');
const recTimer       = $('recTimer');
const recStatus      = $('recStatus');
const transcriptBlock = $('transcriptBlock');
const transcriptText  = $('transcriptText');
const fallbackArea   = $('fallbackArea');
const fallbackInput  = $('fallbackInput');
const genStatus      = $('genStatus');
const genSpinner     = $('genSpinner');
const genText        = $('genText');
const btnGenerate    = $('btnGenerate');

// ─── Results ─────────────────────────────────────────────────────
const resultsContainer = $('resultsContainer');
const btnExport = $('btnExportBrief');
const btnNew    = $('btnNewBrief');

// ─── Chrome ──────────────────────────────────────────────────────
const headerText = $('headerStatusText');
const toast      = $('toast');

// ─── State ───────────────────────────────────────────────────────
let narrationTranscript = '';
let recommendations = null;
let currentUrl = '';
let recSec = 0;
let recTimerId = null;

// ─── Helpers ─────────────────────────────────────────────────────

function toastMsg(m,k='ok'){toast.textContent=m;toast.className='toast '+k;setTimeout(()=>toast.className='toast',4000);}
function show(p){[pnlConfig,pnlRecord,pnlResults].forEach(x=>x.classList.remove('active'));p.classList.add('active');}
function status(t){headerText.textContent=t;}

function updateTimer(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  recTimer.textContent = m + ':' + s;
}

function startTimer(startSec = 0) {
  recSec = startSec;
  updateTimer(recSec);
  recTimer.style.display = 'block';
  recTimerId = setInterval(() => { recSec++; updateTimer(recSec); }, 1000);
}

function stopTimer() {
  if (recTimerId) { clearInterval(recTimerId); recTimerId = null; }
}

// ─── Page detection ──────────────────────────────────────────────

async function detectPage() {
  try{const[t]=await chrome.tabs.query({active:true,currentWindow:true});if(t?.url){currentUrl=t.url;try{pageUrlEl.textContent=new URL(t.url).hostname}catch{pageUrlEl.textContent=t.url.slice(0,40)}}}
  catch{pageUrlEl.textContent='current page';}
}

// ─── Messages from background (live updates) ─────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'RECORDING_STARTED') {
    // Recording confirmed active
    recStatus.textContent = 'Recording… speak clearly.';
    recStatus.style.color = '#EF4444';
    chrome.storage.local.set({'persado:recordingStart': Date.now()});
  }
  if (msg.type === 'RECORDING_ERROR') {
    stopTimer();
    recStatus.textContent = 'Mic error: ' + msg.error;
    recStatus.style.color = '#EF4444';
    btnRecord.style.display = '';
    btnStopRec.style.display = 'none';
    recTimer.style.display = 'none';
    chrome.storage.local.remove('persado:recording');
  }
  if (msg.type === 'TRANSCRIPT_READY') {
    narrationTranscript = msg.transcript;
    transcriptText.textContent = msg.transcript;
    transcriptBlock.style.display = 'block';
    fallbackArea.style.display = 'none';
    btnGenerate.style.display = '';
    recStatus.textContent = '';
    recStatus.style.color = '';
    stopTimer();
    recTimer.style.display = 'none';
    btnStopRec.style.display = 'none';
    btnRecord.style.display = 'none';
    status('Ready');
  }
  if (msg.type === 'TRANSCRIPT_ERROR') {
    fallbackArea.style.display = '';
    btnGenerate.style.display = '';
    recStatus.textContent = 'Transcription failed: ' + (msg.error || 'unknown error') + ' — type below.';
    recStatus.style.color = '#92400E';
    stopTimer();
    recTimer.style.display = 'none';
    btnStopRec.style.display = 'none';
    btnRecord.style.display = 'none';
    status('Ready');
  }
});

// ─── Start briefing flow ─────────────────────────────────────────

btnStart.addEventListener('click', () => {
  narrationTranscript = '';
  transcriptText.textContent = '';
  transcriptBlock.style.display = 'none';
  fallbackArea.style.display = 'none';
  fallbackInput.value = '';
  genStatus.style.display = 'none';
  btnGenerate.style.display = 'none';
  recTimer.style.display = 'none';
  recStatus.textContent = '';
  recStatus.style.color = '';
  btnRecord.style.display = '';
  btnStopRec.style.display = 'none';
  document.querySelector('.instructions').style.display = '';
  stopTimer();
  chrome.storage.local.remove(['persado:recording','persado:transcript','persado:recordingStart']);
  show(pnlRecord);
  status('Ready');
});

// ─── Record ──────────────────────────────────────────────────────

btnRecord.addEventListener('click', async () => {
  // Request mic permission HERE (user click = user activation)
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
  } catch (err) {
    let msg = err.message;
    if (err.name === 'NotAllowedError') msg = 'Microphone access denied — allow in browser settings';
    if (err.name === 'NotFoundError') msg = 'No microphone found';
    recStatus.textContent = msg;
    recStatus.style.color = '#EF4444';
    return;
  }

  btnRecord.style.display = 'none';
  btnStopRec.style.display = '';
  document.querySelector('.instructions').style.display = 'none';
  recStatus.textContent = 'Listening… speak clearly.';
  recStatus.style.color = '#EF4444';
  recTimer.style.display = 'none';

  chrome.storage.local.set({'persado:recording':true,'persado:transcript':''});
  chrome.runtime.sendMessage({type:'START_RECORDING_ONCE'});
});

btnStopRec.addEventListener('click', () => {
  stopTimer();
  btnStopRec.style.display = 'none';
  recTimer.style.display = 'none';
  recStatus.textContent = 'Transcribing…';
  recStatus.style.color = '';
  status('Processing');
  chrome.storage.local.remove('persado:recording');

  const steps = ['Transcribing your brief…','Identifying key themes…','Matching language patterns…'];
  let si = 0;
  const st = setInterval(() => { if (si < steps.length) { recStatus.textContent = steps[si]; si++; } }, 1200);

  chrome.runtime.sendMessage({type:'STOP_AND_TRANSCRIBE'}, async (r) => {
    clearInterval(st);

    if (chrome.runtime.lastError || !r?.ok) {
      const err = r?.error || chrome.runtime.lastError?.message || 'Transcription failed';
      recStatus.textContent = err + ' — type your brief below.';
      recStatus.style.color = '#92400E';
      fallbackArea.style.display = '';
      btnGenerate.style.display = '';
      return;
    }

    // Auto-generate: skip the review step, go straight to results
    narrationTranscript = r.transcript;
    recStatus.textContent = '';
    recStatus.style.color = '';
    await generateRecommendations(narrationTranscript);
  });
});

// ─── Generate ────────────────────────────────────────────────────

async function generateRecommendations(narration) {
  if (!narration) { toastMsg('No brief provided','err'); return; }

  btnGenerate.style.display = 'none';
  genStatus.style.display = 'block';
  genSpinner.style.display = 'block';
  recStatus.textContent = '';
  recStatus.style.color = '';
  transcriptBlock.style.display = 'none';
  fallbackArea.style.display = 'none';
  status('Generating');

  const steps = [
    'Generating optimized variants…',
    'Checking regulatory compliance…',
    'Estimating campaign impact…',
  ];
  let si = 0;
  genText.textContent = steps[0];
  const st = setInterval(() => { if (si < steps.length) { genText.textContent = steps[si]; si++; } }, 1500);

  try {
    const resp = await fetch(GATEWAY+'/v1/ai/recommend',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({narration,audience:audienceSelect.value,goal:goalSelect.value,pageUrl:currentUrl}),
    });
    if (!resp.ok) throw new Error((await resp.json().catch(()=>({error:'Gateway error'}))).error||'Gateway '+resp.status);
    const data = await resp.json();
    recommendations = data.variants||[];
    renderResults();
    show(pnlResults);
    status('Done');
  } catch(e) {
    toastMsg(e.message||'Generation failed','err');
    status('Error');
  } finally {
    clearInterval(st);
    genStatus.style.display = 'none';
    genSpinner.style.display = 'none';
  }
}

// Keep btnGenerate for fallback (text input) only
btnGenerate.addEventListener('click', () => {
  generateRecommendations(fallbackInput.value.trim());
});

// ─── Results ─────────────────────────────────────────────────────

function renderResults() {
  if (!recommendations?.length) { resultsContainer.innerHTML='<div class="empty-state">No variants generated.</div>'; return; }
  resultsContainer.innerHTML = recommendations.map((v,i)=>`
    <div class="rec-card">
      <div class="rh"><div class="rn">Variant ${i+1}</div><div class="rv">${esc(v.copy)}</div></div>
      <div class="rb">
        <div class="rrationale">${esc(v.rationale||'')}</div>
        <div class="rr" style="margin-top:8px;justify-content:space-between;">
          <span class="badge ${v.compliance==='clear'?'clear':'flag'}">${v.compliance==='clear'?'✓ Compliance Clear':'⚠ '+esc(v.complianceNote||'Flag')}</span>
          <span class="badge lift">📈 ${esc(v.predictedLift||'+5–12%')} (illustrative)</span>
        </div>
      </div>
    </div>
  `).join('');
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

// ─── Export ──────────────────────────────────────────────────────

btnExport.addEventListener('click',()=>{
  if (!recommendations){toastMsg('Nothing to export','err');return;}
  const pl={retail:'Retail Banking',cards:'Credit Cards',mortgage:'Mortgage & Lending',wealth:'Wealth Management',business:'Small Business Banking'};
  const ob={acquisition:'Acquisition','cross-sell':'Cross-Sell',engagement:'Engagement',retention:'Retention',trust:'Trust & Compliance'};
  const md=[
    '# Persado Marketing Brief','',`**Page:** ${currentUrl}`,`**Product Line:** ${pl[audienceSelect.value]}`,
    `**Objective:** ${ob[goalSelect.value]}`,'','## Brief',`> ${narrationTranscript||fallbackInput.value||'(none)'}`,'',
    '## Recommendations','','> ⚠️ **Demo only.** Generated by general-purpose LLM standing in for Persado Motivation AI.','',
    ...recommendations.flatMap((v,i)=>[`### Variant ${i+1}`,`- **Copy:** ${v.copy}`,`- **Rationale:** ${v.rationale||'—'}`,
    `- **Compliance:** ${v.compliance==='clear'?'✓ Clear':'⚠ '+(v.complianceNote||'Flag')}`,
    `- **Predicted Lift:** ${v.predictedLift||'+5–12%'} *(illustrative)*`,'']),
  ].filter(Boolean).join('\n');
  navigator.clipboard.writeText(md).then(()=>toastMsg('Brief copied ✓')).catch(()=>{const t=document.createElement('textarea');t.value=md;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();toastMsg('Brief copied ✓');});
});

// ─── New Brief ───────────────────────────────────────────────────

btnNew.addEventListener('click',()=>{
  narrationTranscript='';recommendations=null;
  transcriptText.textContent='';transcriptBlock.style.display='none';
  fallbackArea.style.display='none';fallbackInput.value='';
  resultsContainer.innerHTML='';
  btnGenerate.style.display='none';genStatus.style.display='none';
  btnRecord.style.display='';btnStopRec.style.display='none';
  recTimer.style.display='none';recStatus.textContent='';recStatus.style.color='';
  stopTimer();
  chrome.storage.local.remove(['persado:recording','persado:transcript','persado:recordingStart']);
  show(pnlConfig);status('Ready');
});

// ─── Init (restore state after popup close) ──────────────────────

async function init() {
  await detectPage();

  // Show version
  try { document.getElementById('versionTag').textContent = 'v' + chrome.runtime.getManifest().version; } catch {}

  // Restore recording state
  try {
    const stored = await chrome.storage.local.get(['persado:recording','persado:transcript','persado:recordingStart']);

    if (stored['persado:recording']) {
      btnRecord.style.display = 'none';
      btnStopRec.style.display = '';
      recStatus.textContent = 'Recording in progress…';
      recStatus.style.color = '#EF4444';
      transcriptBlock.style.display = 'none';
      fallbackArea.style.display = 'none';
      btnGenerate.style.display = 'none';
      genStatus.style.display = 'none';
      show(pnlRecord);

      // Calculate elapsed from stored start time
      if (stored['persado:recordingStart']) {
        const elapsed = Math.floor((Date.now() - stored['persado:recordingStart']) / 1000);
        startTimer(elapsed);
      } else {
        startTimer(0);
      }
      status('Recording');
      return;
    }

    if (stored['persado:transcript']) {
      // Transcript arrived while popup was closed — auto-generate
      narrationTranscript = stored['persado:transcript'];
      await chrome.storage.local.remove('persado:transcript');
      show(pnlRecord);
      await generateRecommendations(narrationTranscript);
      return;
    }
  } catch {}

  status('Ready');
}

init();
