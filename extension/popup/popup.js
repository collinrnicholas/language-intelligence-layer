// ─── Persado Demo — Voice-First Brief Recorder ───────────────────
//
// Flow: Configure → Record Brief → Transcribe → Generate → Results
// No element selection. The marketer describes their problem by voice.

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
const fallbackInput  = $('fallbackInput');
const fallbackArea   = $('fallbackArea');
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

function toastMsg(m,k='ok'){toast.textContent=m;toast.className='toast '+k;setTimeout(()=>toast.className='toast',3000);}
function show(p){[pnlConfig,pnlRecord,pnlResults].forEach(x=>x.classList.remove('active'));p.classList.add('active');}
function status(t){headerText.textContent=t;}

// ─── Page detection ──────────────────────────────────────────────

async function detectPage() {
  try{const[t]=await chrome.tabs.query({active:true,currentWindow:true});if(t?.url){currentUrl=t.url;try{pageUrlEl.textContent=new URL(t.url).hostname}catch{pageUrlEl.textContent=t.url.slice(0,40)}}}
  catch{pageUrlEl.textContent='current page';}
}

// ─── Start briefing flow ─────────────────────────────────────────

btnStart.addEventListener('click', () => {
  // Reset
  narrationTranscript = '';
  transcriptText.textContent = '';
  transcriptBlock.style.display = 'none';
  fallbackArea.style.display = 'none';
  fallbackInput.value = '';
  genStatus.style.display = 'none';
  btnGenerate.style.display = 'none';
  recTimer.textContent = '';
  recTimer.style.display = 'none';
  recStatus.textContent = '';
  btnRecord.style.display = '';
  btnStopRec.style.display = 'none';

  show(pnlRecord);
  status('Ready');
});

// ─── Record ──────────────────────────────────────────────────────

btnRecord.addEventListener('click', () => {
  btnRecord.style.display = 'none';
  btnStopRec.style.display = '';
  recStatus.textContent = 'Listening… describe the marketing problem.';
  recSec = 0;
  recTimer.textContent = '00:00';
  recTimer.style.display = 'block';
  recTimerId = setInterval(() => {recSec++;const m=String(Math.floor(recSec/60)).padStart(2,'0');const s=String(recSec%60).padStart(2,'0');recTimer.textContent=m+':'+s;},1000);

  // Persist recording state so popup can restore on reopen
  chrome.storage.local.set({'persado:recording':true,'persado:transcript':''});

  chrome.runtime.sendMessage({type:'START_RECORDING_ONCE'});
});

btnStopRec.addEventListener('click', () => {
  if (recTimerId) { clearInterval(recTimerId); recTimerId = null; }
  btnStopRec.style.display = 'none';
  recTimer.style.display = 'none';
  recStatus.textContent = 'Transcribing…';
  status('Processing');

  chrome.storage.local.remove('persado:recording');

  const steps = [
    'Transcribing your brief…',
    'Identifying key themes…',
    'Matching language patterns…',
  ];
  let si = 0;
  const st = setInterval(() => { if (si < steps.length) { recStatus.textContent = steps[si]; si++; } }, 1200);

  chrome.runtime.sendMessage({type:'STOP_AND_TRANSCRIBE'}, (r) => {
    clearInterval(st);
    recStatus.textContent = '';

    if (chrome.runtime.lastError || !r?.ok) {
      recStatus.textContent = 'Voice unavailable — type your brief below.';
      fallbackArea.style.display = '';
      btnGenerate.style.display = '';
      return;
    }

    narrationTranscript = r.transcript;
    transcriptText.textContent = r.transcript;
    transcriptBlock.style.display = 'block';
    fallbackArea.style.display = 'none';
    btnGenerate.style.display = '';
    recStatus.textContent = '';
    status('Ready');
  });
});

// ─── Generate ────────────────────────────────────────────────────

btnGenerate.addEventListener('click', async () => {
  const narration = narrationTranscript || fallbackInput.value.trim();
  if (!narration) { toastMsg('No brief provided','err'); return; }

  btnGenerate.style.display = 'none';
  genStatus.style.display = 'block';
  genSpinner.style.display = 'block';
  status('Generating');

  const al = audienceSelect.selectedOptions[0]?.text || 'Customers';
  const gl = goalSelect.selectedOptions[0]?.text || 'performance';
  const steps = [
    ['Generating optimized variants…',  'Applying '+gl.toLowerCase()+'-focused frameworks for '+al],
    ['Checking regulatory compliance…', 'Verifying against UDAAP and disclosure guidelines'],
    ['Estimating campaign impact…',     'Predicting lift based on similar finance campaigns'],
  ];
  let si = 0;
  const st = setInterval(() => { if (si < steps.length) { genText.textContent = steps[si][0]; si++; } }, 1500);

  try {
    const resp = await fetch(GATEWAY+'/v1/ai/recommend',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        narration,
        audience: audienceSelect.value,
        goal: goalSelect.value,
        pageUrl: currentUrl,
      }),
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
    btnGenerate.style.display = '';
  }
});

// ─── Results ─────────────────────────────────────────────────────

function renderResults() {
  if (!recommendations?.length) { resultsContainer.innerHTML='<div class="empty-state">No variants generated.</div>'; return; }
  resultsContainer.innerHTML = recommendations.map((v,i)=>`
    <div class="rec-card">
      <div class="rh">
        <div class="rn">Variant ${i+1}</div>
        <div class="rv">${esc(v.copy)}</div>
      </div>
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
    `**Objective:** ${ob[goalSelect.value]}`,'','## Brief',
    `> ${narrationTranscript||fallbackInput.value||'(none)'}`,'',
    '## Recommendations','','> ⚠️ **Demo only.** Generated by a general-purpose LLM standing in for Persado Motivation AI.','',
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
  recTimer.style.display='none';recStatus.textContent='';
  show(pnlConfig);status('Ready');
});

// ─── Init ────────────────────────────────────────────────────────

async function init() {
  await detectPage();

  // Show version from manifest
  try {
    const manifest = chrome.runtime.getManifest();
    document.getElementById('versionTag').textContent = 'v' + manifest.version;
  } catch {}

  // Check if recording was active when popup closed
  try {
    const stored = await chrome.storage.local.get(['persado:recording','persado:transcript']);
    if (stored['persado:recording']) {
      // Restore recording state
      btnRecord.style.display = 'none';
      btnStopRec.style.display = '';
      recStatus.textContent = 'Recording in progress…';
      recTimer.textContent = '--:--';
      recTimer.style.display = 'block';
      transcriptBlock.style.display = 'none';
      fallbackArea.style.display = 'none';
      btnGenerate.style.display = 'none';
      genStatus.style.display = 'none';
      show(pnlRecord);
      status('Recording');
      return;
    }
    if (stored['persado:transcript']) {
      // Transcript arrived while popup was closed
      narrationTranscript = stored['persado:transcript'];
      transcriptText.textContent = narrationTranscript;
      transcriptBlock.style.display = 'block';
      fallbackArea.style.display = 'none';
      btnGenerate.style.display = '';
      btnRecord.style.display = 'none';
      btnStopRec.style.display = 'none';
      recTimer.style.display = 'none';
      recStatus.textContent = '';
      show(pnlRecord);
      await chrome.storage.local.remove('persado:transcript');
      status('Ready');
      return;
    }
  } catch {}

  status('Ready');
}
init();
