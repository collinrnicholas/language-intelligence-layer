// ─── Persado Demo — Popup Logic ──────────────────────────────────
//
// States: Configure → Recording → Processing → Review → Results
// Recording survives popup close (offscreen doc + storage).

const GATEWAY = 'http://localhost:8787';

const $ = (id) => document.getElementById(id);

// ─── Panels ──────────────────────────────────────────────────────
const panelConfigure   = $('panelConfigure');
const panelRecording   = $('panelRecording');
const panelProcessing  = $('panelProcessing');
const panelReview      = $('panelReview');
const panelResults     = $('panelResults');

// ─── Configure ───────────────────────────────────────────────────
const pageUrl       = $('pageUrl');
const audienceSelect = $('audience');
const goalSelect    = $('goal');
const btnStart      = $('btnStartCapture');

// ─── Recording ───────────────────────────────────────────────────
const recTimer      = $('recTimer');
const recElCard     = $('recElementCard');
const recElType     = $('recElType');
const recElText     = $('recElText');
const recHint       = $('recHint');
const btnStop       = $('btnStopCapture');

// ─── Processing ──────────────────────────────────────────────────
const procStatus    = $('procStatus');
const procDetail    = $('procDetail');

// ─── Review ──────────────────────────────────────────────────────
const elType        = $('elType');
const elText        = $('elText');
const elContext     = $('elContext');
const narrationBlock = $('narrationBlock');
const narrationText  = $('narrationText');
const narrationFallback = $('narrationFallback');
const narrationInput = $('narrationInput');
const btnGenerate   = $('btnGenerate');
const loadingGen    = $('loadingGenerate');

// ─── Results ─────────────────────────────────────────────────────
const resultsContainer = $('resultsContainer');
const btnExport     = $('btnExportBrief');
const btnNew        = $('btnNewBrief');

// ─── Chrome ──────────────────────────────────────────────────────
const headerStatus  = $('headerStatus');
const headerText    = $('headerStatusText');
const toast         = $('toast');

// ─── State ───────────────────────────────────────────────────────
let capturedElement = null;
let narrationTranscript = '';
let recommendations = null;
let currentUrl = '';
let recording = false;
let recSec = 0;
let recTimerId = null;

// ─── Helpers ─────────────────────────────────────────────────────

function toastMsg(m, k='ok') { toast.textContent=m; toast.className='toast '+k; setTimeout(()=>toast.className='toast',3000); }
function status(t, r=false) { headerText.textContent=t; headerStatus.className=r?'header-status rec':'header-status'; }
function show(p) { [panelConfigure,panelRecording,panelProcessing,panelReview,panelResults].forEach(x=>x.classList.remove('active')); p.classList.add('active'); }

// ─── Page ────────────────────────────────────────────────────────

async function detectPage() {
  try {
    const [t] = await chrome.tabs.query({active:true,currentWindow:true});
    if (t?.url) { currentUrl=t.url; try{const u=new URL(t.url);pageUrl.textContent=u.hostname+u.pathname}catch{pageUrl.textContent=t.url.slice(0,60)} }
  } catch { pageUrl.textContent='(unknown)'; }
}

// ─── Element capture (storage-based, survives popup close) ───────

function renderEl() {
  if (!capturedElement) return;
  elType.textContent = capturedElement.type;
  elText.textContent = capturedElement.text||'(empty)';
  elContext.textContent = capturedElement.context||'';
  elContext.style.display = capturedElement.context?'block':'none';
}

function showRecEl() {
  if (!capturedElement) return;
  recElType.textContent=capturedElement.type;
  recElText.textContent=capturedElement.text||'(empty)';
  recElCard.style.display='block';
  recHint.textContent='Element captured! Keep narrating, or click another. 🎤';
}

async function loadPendingEl() {
  try {
    const s = await chrome.storage.local.get('persado:pendingCapture');
    if (s['persado:pendingCapture']) {
      capturedElement = s['persado:pendingCapture'];
      await chrome.storage.local.remove('persado:pendingCapture');
      return true;
    }
  } catch {}
  return false;
}

// ─── Timer ───────────────────────────────────────────────────────

function startTimer() { recSec=0; recTimer.textContent='00:00'; recTimerId=setInterval(()=>{recSec++;const m=String(Math.floor(recSec/60)).padStart(2,'0');const s=String(recSec%60).padStart(2,'0');recTimer.textContent=m+':'+s;},1000); }
function stopTimer() { if(recTimerId){clearInterval(recTimerId);recTimerId=null;} }

// ─── Messages from background ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PERSADO_ELEMENT_CAPTURED' && msg.element) {
    capturedElement = msg.element;
    if (recording) showRecEl();
    else { renderEl(); show(panelReview); status('Ready'); }
  }
  if (msg.type === 'RECORDING_STARTED') {
    recording=true; startTimer();
  }
  if (msg.type === 'TRANSCRIPT_READY') {
    narrationTranscript = msg.transcript;
    narrationText.textContent = msg.transcript;
    narrationBlock.style.display='block';
    narrationFallback.style.display='none';
    show(panelReview);
    status('Ready');
  }
  if (msg.type === 'TRANSCRIPT_ERROR') {
    narrationFallback.style.display='';
    show(panelReview);
    status('Ready');
    // Don't show error toast — the processing panel already showed the failure
  }
});

// ─── Start Capture ───────────────────────────────────────────────

btnStart.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id) { toastMsg('No active tab','err'); return; }

    // Inject element picker
    await chrome.scripting.executeScript({target:{tabId:tab.id},func:injectPicker});

    // Start audio via offscreen
    chrome.runtime.sendMessage({type:'POPUP_START_RECORDING'}, (r) => {
      if (chrome.runtime.lastError) toastMsg('Mic failed: '+chrome.runtime.lastError.message,'err');
    });

    recording = true;
    chrome.storage.local.set({'persado:recording':true});
    show(panelRecording);
    status('Recording', true);
    startTimer();
    toastMsg('Point at an element, narrate out loud 🎤');
  } catch(e) { toastMsg('Failed: '+e.message,'err'); }
});

// ─── Stop & Process ──────────────────────────────────────────────

btnStop.addEventListener('click', async () => {
  stopTimer();
  recording = false;
  chrome.storage.local.remove('persado:recording');

  // Load element from storage (captured while popup was closed)
  await loadPendingEl();

  show(panelProcessing);
  procStatus.textContent = 'Transcribing narration…';
  procDetail.textContent = 'Sending audio to speech recognition';
  status('Processing');

  // Cycle through meaningful status updates
  const statusCycle = [
    ['Analyzing narration…',         'Identifying key concerns and emotional signals'],
    ['Evaluating element context…',  'Mapping element type to marketing frameworks'],
    ['Building variants…',           'Applying language psychology and compliance rules'],
    ['Reasoning over lift models…',  'Generating predicted performance ranges'],
  ];
  let cycleIdx = 0;
  const cycleTimer = setInterval(() => {
    if (cycleIdx < statusCycle.length) {
      procStatus.textContent = statusCycle[cycleIdx][0];
      procDetail.textContent = statusCycle[cycleIdx][1];
      cycleIdx++;
    }
  }, 1500);

  chrome.runtime.sendMessage({type:'POPUP_STOP_RECORDING'}, (r) => {
    clearInterval(cycleTimer);

    if (chrome.runtime.lastError || !r?.ok) {
      // Transcription failed — show fallback immediately
      procStatus.textContent = 'Voice transcription unavailable';
      procDetail.textContent = r?.error || 'Speech service is not accessible. Type your narration below.';
      narrationFallback.style.display = '';
      setTimeout(() => {
        renderEl();
        show(panelReview);
        status('Ready');
      }, 1000);
      return;
    }

    if (r.transcript) {
      narrationTranscript = r.transcript;
      procStatus.textContent = 'Transcription complete';
      procDetail.textContent = 'Narration captured. Review below.';
    }

    setTimeout(() => {
      renderEl();
      narrationText.textContent = r.transcript || '';
      narrationBlock.style.display = r.transcript ? 'block' : 'none';
      narrationFallback.style.display = r.transcript ? 'none' : '';
      show(panelReview);
      status('Ready');
    }, 800);
  });
});

// ─── Generate ────────────────────────────────────────────────────

btnGenerate.addEventListener('click', async () => {
  if (!capturedElement) { toastMsg('No element captured','err'); return; }
  const narration = narrationTranscript || narrationInput.value.trim();
  if (!narration) { toastMsg('No narration provided','err'); return; }

  btnGenerate.style.display='none';
  loadingGen.classList.add('active');
  status('Generating…');

  try {
    const resp = await fetch(GATEWAY+'/v1/ai/recommend',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({element:capturedElement,narration,audience:audienceSelect.value,goal:goalSelect.value,pageUrl:currentUrl}),
    });
    if (!resp.ok) throw new Error((await resp.json().catch(()=>({error:'Gateway error'}))).error||'Gateway '+resp.status);
    const data = await resp.json();
    recommendations = data.variants||[];
    renderResults();
    show(panelResults);
    status('Done');
  } catch(e) {
    toastMsg(e.message||'Generation failed','err');
    status('Error');
  } finally {
    loadingGen.classList.remove('active');
    btnGenerate.style.display='';
  }
});

// ─── Results ─────────────────────────────────────────────────────

function renderResults() {
  if (!recommendations?.length) { resultsContainer.innerHTML='<div class="empty-state">No variants generated.</div>'; return; }
  resultsContainer.innerHTML = recommendations.map((v,i)=>`
    <div class="rec-card">
      <div class="rc-header">
        <div class="rc-number">Variant ${i+1}</div>
        <div class="rc-variant">${esc(v.copy)}</div>
      </div>
      <div class="rc-body">
        <div class="rc-rationale">${esc(v.rationale||'')}</div>
        <div class="rc-row" style="margin-top:8px;justify-content:space-between;">
          <span class="badge ${v.compliance==='clear'?'clear':'flag'}">${v.compliance==='clear'?'✓ Compliance Clear':'⚠ '+esc(v.complianceNote||'Flag')}</span>
          <span class="badge lift">📈 ${esc(v.predictedLift||'+5–12%')} (illustrative)</span>
        </div>
      </div>
    </div>
  `).join('');
}

function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

// ─── Export ──────────────────────────────────────────────────────

btnExport.addEventListener('click',()=>{
  if (!capturedElement||!recommendations) { toastMsg('Nothing to export','err'); return; }
  const aud={new:'New Customers',existing:'Existing Customers',lapsed:'Lapsed/Dormant'};
  const gl={conversions:'Conversions',clicks:'Clicks/CTR',trust:'Trust/Credibility'};
  const md=[
    '# Persado Marketing Brief','',
    `**Page:** ${currentUrl}`,`**Audience:** ${aud[audienceSelect.value]}`,
    `**Goal:** ${gl[goalSelect.value]}`,'',
    '## Captured Element',`- **Type:** ${capturedElement.type}`,
    `- **Current Copy:** "${capturedElement.text}"`,
    capturedElement.context?`- **Context:** ${capturedElement.context}`:'',
    `- **Selector:** \`${capturedElement.selector}\``,'',
    '## Narration',`> ${narrationText.textContent||'(none)'}`,'',
    '## Recommendations','',
    '> ⚠️ **Demo only.** Generated by a general-purpose LLM standing in for Persado Motivation AI.','',
    ...recommendations.flatMap((v,i)=>[`### Variant ${i+1}`,`- **Copy:** ${v.copy}`,`- **Rationale:** ${v.rationale||'—'}`,`- **Compliance:** ${v.compliance==='clear'?'✓ Clear':'⚠ '+(v.complianceNote||'Flag')}`,`- **Predicted Lift:** ${v.predictedLift||'+5–12%'} *(illustrative)*`,'']),
  ].filter(Boolean).join('\n');
  navigator.clipboard.writeText(md).then(()=>toastMsg('Brief copied ✓')).catch(()=>{const t=document.createElement('textarea');t.value=md;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();toastMsg('Brief copied ✓');});
});

// ─── New ─────────────────────────────────────────────────────────

btnNew.addEventListener('click',()=>{
  capturedElement=null;recommendations=null;narrationTranscript='';
  narrationText.textContent='';narrationBlock.style.display='none';
  narrationFallback.style.display='none';narrationInput.value='';
  resultsContainer.innerHTML='';
  btnGenerate.style.display='';loadingGen.classList.remove('active');
  show(panelConfigure);status('Ready');
});

// ─── Element Picker (injected) ───────────────────────────────────

function injectPicker() {
  document.querySelectorAll('#persado-picker-overlay,#persado-highlight').forEach(e=>e.remove());
  let hovered=null;
  const ov=document.createElement('div');ov.id='persado-picker-overlay';ov.style.cssText='position:fixed;inset:0;z-index:2147483646;cursor:crosshair;';document.body.appendChild(ov);
  const hl=document.createElement('div');hl.id='persado-highlight';hl.style.cssText='position:fixed;z-index:2147483647;border:2px solid #E8388C;background:rgba(92,45,145,0.08);pointer-events:none;transition:all 0.1s;border-radius:4px;';document.body.appendChild(hl);

  function cl(el){const t=(el.textContent||'').trim().toLowerCase();const g=el.tagName.toLowerCase();if(g==='a'||g==='button'||el.getAttribute('role')==='button'){if(/(apply|open|start|get started|sign up|learn more|see |try |compare)/i.test(t))return'CTA'}if(/^h[1-4]$/.test(g))return'Headline';if(/^h[5-6]$/.test(g)||/subhead/i.test(el.className||''))return'Subhead';if(/(guarantee|secure|trust|fdic|insured|protection|safe|backed)/i.test(t))return'Trust Line';if(/(offer|rate|bonus|cash|reward|save|earn|fee|apr|apy)/i.test(t))return'Promo';return'Body Copy';}
  function ctx(el){const p=el.closest('section,article,[class*="hero"],[class*="banner"],[class*="card"],[class*="feature"]');if(!p)return'';const f=(p.textContent||'').trim().slice(0,250);return f.replace((el.textContent||'').trim(),'⟦'+(el.textContent||'').trim()+'⟧');}
  function sel(el){if(el.id)return'#'+el.id;if(el.className&&typeof el.className==='string'){const c=el.className.trim().split(/\s+/).slice(0,2).join('.');if(c)return el.tagName.toLowerCase()+'.'+c;}return el.tagName.toLowerCase();}
  function pick(el){ov.remove();hl.remove();chrome.runtime.sendMessage({type:'PERSADO_ELEMENT_CAPTURED',element:{type:cl(el),text:(el.textContent||'').trim().slice(0,300),context:ctx(el),selector:sel(el)}});}

  ov.addEventListener('mousemove',e=>{const el=document.elementFromPoint(e.clientX,e.clientY);if(!el||el===ov||el===hl)return;hovered=el;const r=el.getBoundingClientRect();hl.style.left=r.left+'px';hl.style.top=r.top+'px';hl.style.width=r.width+'px';hl.style.height=r.height+'px';});
  ov.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();if(hovered)pick(hovered);});
  document.addEventListener('keydown',function esc(e){if(e.key==='Escape'){ov.remove();hl.remove();document.removeEventListener('keydown',esc);}});
}

// ─── Init ────────────────────────────────────────────────────────

async function init() {
  await detectPage();
  const hasEl = await loadPendingEl();

  // Check recording state (survives popup close)
  try {
    const s = await chrome.storage.local.get('persado:recording');
    if (s['persado:recording']) {
      recording = true;
      show(panelRecording);
      status('Recording', true);
      startTimer();
      if (capturedElement) showRecEl();
      return;
    }
  } catch {}

  if (capturedElement) { renderEl(); show(panelReview); }
  status('Ready');
}

init();
