// ─── Persado Demo — Popup Logic (simplified) ─────────────────────
//
// States: Configure → Pick Element → Narrate → Generate → Results
//
// No persistent recording session. Element picked via injected script
// (survives popup close). Narration recorded in offscreen doc while
// popup stays open. Each step is a single async round-trip.

const GATEWAY = 'http://localhost:8787';

const $ = (id) => document.getElementById(id);

// ─── Panels ──────────────────────────────────────────────────────
const pnlConfig   = $('panelConfigure');
const pnlPick     = $('panelPick');
const pnlNarrate  = $('panelNarrate');
const pnlResults  = $('panelResults');

// ─── Config ──────────────────────────────────────────────────────
const pageUrl       = $('pageUrl');
const audienceSelect = $('audience');
const goalSelect    = $('goal');
const btnPick       = $('btnPick');

// ─── Pick ────────────────────────────────────────────────────────
const pickElCard   = $('pickElCard');
const pickElType   = $('pickElType');
const pickElText   = $('pickElText');
const btnNarrate   = $('btnNarrate');

// ─── Narrate ─────────────────────────────────────────────────────
const narrateElType   = $('narrateElType');
const narrateElText   = $('narrateElText');
const narrateElCtx    = $('narrateElContext');
const btnRecord       = $('btnRecord');
const recStatus       = $('recStatus');
const recTimer        = $('recTimer');
const btnStopRec      = $('btnStopRec');
const narrationBlock  = $('narrationBlock');
const narrationText   = $('narrationText');
const narrateFallback = $('narrateFallback');
const narrationInput  = $('narrationInput');
const btnGenerate     = $('btnGenerate');
const genStatus       = $('genStatus');
const genSpinner      = $('genSpinner');

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
let recSec = 0;
let recTimerId = null;
let recordingNow = false;

// ─── Helpers ─────────────────────────────────────────────────────

function toastMsg(m,k='ok'){toast.textContent=m;toast.className='toast '+k;setTimeout(()=>toast.className='toast',3000);}
function status(t){headerText.textContent=t;headerStatus.className='header-status';}
function show(p){[pnlConfig,pnlPick,pnlNarrate,pnlResults].forEach(x=>x.classList.remove('active'));p.classList.add('active');}

// ─── Page ────────────────────────────────────────────────────────

async function detectPage() {
  try{const[t]=await chrome.tabs.query({active:true,currentWindow:true});if(t?.url){currentUrl=t.url;try{const u=new URL(t.url);pageUrl.textContent=u.hostname+u.pathname}catch{pageUrl.textContent=t.url.slice(0,60)}}}
  catch{pageUrl.textContent='(unknown)';}
}

// ─── Step 1: Pick Element ────────────────────────────────────────

btnPick.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id) { toastMsg('No active tab','err'); return; }
    await chrome.scripting.executeScript({target:{tabId:tab.id},func:injectPicker});
    toastMsg('Click any element on the page ✦');
  } catch(e) { toastMsg('Cannot access page: '+e.message,'err'); }
});

// ─── Handle element capture (can arrive while on any panel) ──────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PERSADO_ELEMENT_CAPTURED' && msg.element) {
    capturedElement = msg.element;
    pickElType.textContent = msg.element.type;
    pickElText.textContent = msg.element.text||'(empty)';
    pickElCard.style.display = 'block';
    btnNarrate.disabled = false;
    show(pnlPick);
    status('Element captured');
  }
});

// Check for element captured while popup was closed
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

// ─── Step 2: Narrate ─────────────────────────────────────────────

btnNarrate.addEventListener('click', () => {
  if (!capturedElement) return;
  narrateElType.textContent = capturedElement.type;
  narrateElText.textContent = capturedElement.text||'(empty)';
  narrateElCtx.textContent = capturedElement.context||'';
  narrateElCtx.style.display = capturedElement.context?'block':'none';
  narrationTranscript = '';
  narrationText.textContent = '';
  narrationBlock.style.display = 'none';
  narrateFallback.style.display = 'none';
  btnGenerate.style.display = 'none';
  genStatus.style.display = 'none';
  genSpinner.style.display = 'none';
  btnRecord.style.display = '';
  btnStopRec.style.display = 'none';
  recStatus.textContent = '';
  recTimer.style.display = 'none';
  show(pnlNarrate);
  status('Ready to narrate');
});

// Pick Different Element
const btnPickAgain = $('btnPickAgain');
btnPickAgain.addEventListener('click', () => {
  capturedElement = null;
  pickElCard.style.display = 'none';
  btnNarrate.disabled = true;
  show(pnlConfig);
  status('Ready');
});

// ─── Record narration (one-shot, popup stays open) ───────────────

btnRecord.addEventListener('click', async () => {
  recordingNow = true;
  btnRecord.style.display = 'none';
  btnStopRec.style.display = '';
  recStatus.textContent = '🎤 Recording… speak your concern about this element';
  recStatus.style.color = '#EF4444';
  recSec = 0;
  recTimer.textContent = '00:00';
  recTimer.style.display = 'block';
  recTimerId = setInterval(() => {recSec++;const m=String(Math.floor(recSec/60)).padStart(2,'0');const s=String(recSec%60).padStart(2,'0');recTimer.textContent=m+':'+s;},1000);
  status('Recording');

  // Tell background to start recording via offscreen
  chrome.runtime.sendMessage({type:'START_RECORDING_ONCE'});
});

btnStopRec.addEventListener('click', () => {
  recordingNow = false;
  if (recTimerId) { clearInterval(recTimerId); recTimerId = null; }
  btnStopRec.style.display = 'none';
  recTimer.style.display = 'none';
  recStatus.textContent = 'Transcribing…';
  recStatus.style.color = 'var(--persado-purple)';
  status('Processing');

  const cycle = [
    ['Transcribing narration…',            ''],
    ['Identifying key themes…',            ''],
    ['Matching language patterns…',        ''],
  ];
  let ci = 0;
  const ct = setInterval(() => {
    if (ci < cycle.length) { recStatus.textContent = cycle[ci][0]; ci++; }
  }, 1200);

  chrome.runtime.sendMessage({type:'STOP_AND_TRANSCRIBE'}, (r) => {
    clearInterval(ct);
    recStatus.textContent = '';

    if (chrome.runtime.lastError || !r?.ok) {
      recStatus.textContent = 'Voice transcription unavailable — type below';
      recStatus.style.color = '#92400E';
      narrateFallback.style.display = '';
      btnGenerate.style.display = '';
      return;
    }

    narrationTranscript = r.transcript;
    narrationText.textContent = r.transcript;
    narrationBlock.style.display = 'block';
    narrateFallback.style.display = 'none';
    btnGenerate.style.display = '';
    recStatus.textContent = '';
    status('Ready');
  });
});

// ─── Step 3: Generate ────────────────────────────────────────────

btnGenerate.addEventListener('click', async () => {
  if (!capturedElement) { toastMsg('No element','err'); return; }
  const narration = narrationTranscript || narrationInput.value.trim();
  if (!narration) { toastMsg('No narration','err'); return; }

  btnGenerate.style.display = 'none';
  genStatus.style.display = 'block';
  genSpinner.style.display = 'block';
  status('Generating');

  const al = audienceSelect.selectedOptions[0]?.text || 'Customers';
  const gl = goalSelect.selectedOptions[0]?.text || 'performance';
  const cycle = [
    ['Generating optimized variants…',     'Applying '+gl.toLowerCase()+'-focused frameworks for '+al],
    ['Checking regulatory compliance…',    'Verifying against UDAAP and disclosure guidelines'],
    ['Estimating campaign impact…',        'Predicting lift based on similar finance campaigns'],
  ];
  let ci = 0;
  const ct = setInterval(() => {
    if (ci < cycle.length) { genStatus.textContent = cycle[ci][0]; ci++; }
  }, 1500);

  try {
    const resp = await fetch(GATEWAY+'/v1/ai/recommend',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({element:capturedElement,narration,audience:audienceSelect.value,goal:goalSelect.value,pageUrl:currentUrl}),
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
    clearInterval(ct);
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

function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

// ─── Export ──────────────────────────────────────────────────────

btnExport.addEventListener('click',()=>{
  if (!capturedElement||!recommendations){toastMsg('Nothing to export','err');return;}
  const pl={retail:'Retail Banking',cards:'Credit Cards',mortgage:'Mortgage & Lending',wealth:'Wealth Management',business:'Small Business Banking'};
  const ob={acquisition:'Acquisition','cross-sell':'Cross-Sell',engagement:'Engagement',retention:'Retention',trust:'Trust & Compliance'};
  const md=[
    '# Persado Marketing Brief','',`**Page:** ${currentUrl}`,`**Product Line:** ${pl[audienceSelect.value]}`,
    `**Objective:** ${ob[goalSelect.value]}`,'','## Captured Element',`- **Type:** ${capturedElement.type}`,
    `- **Current Copy:** "${capturedElement.text}"`,capturedElement.context?`- **Context:** ${capturedElement.context}`:'',
    `- **Selector:** \`${capturedElement.selector}\``,'','## Narration',`> ${narrationText.textContent||'(none)'}`,'',
    '## Recommendations','','> ⚠️ **Demo only.** Generated by a general-purpose LLM standing in for Persado Motivation AI.','',
    ...recommendations.flatMap((v,i)=>[`### Variant ${i+1}`,`- **Copy:** ${v.copy}`,`- **Rationale:** ${v.rationale||'—'}`,
    `- **Compliance:** ${v.compliance==='clear'?'✓ Clear':'⚠ '+(v.complianceNote||'Flag')}`,
    `- **Predicted Lift:** ${v.predictedLift||'+5–12%'} *(illustrative)*`,'']),
  ].filter(Boolean).join('\n');
  navigator.clipboard.writeText(md).then(()=>toastMsg('Brief copied ✓')).catch(()=>{const t=document.createElement('textarea');t.value=md;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();toastMsg('Brief copied ✓');});
});

// ─── New Brief ───────────────────────────────────────────────────

btnNew.addEventListener('click',()=>{
  capturedElement=null;recommendations=null;narrationTranscript='';
  narrationText.textContent='';narrationBlock.style.display='none';
  narrateFallback.style.display='none';narrationInput.value='';
  resultsContainer.innerHTML='';
  btnGenerate.style.display='';genStatus.style.display='none';genSpinner.style.display='none';
  btnRecord.style.display='';btnStopRec.style.display='none';
  recStatus.textContent='';recTimer.style.display='none';
  pickElCard.style.display='none';btnNarrate.disabled=true;
  show(pnlConfig);status('Ready');
});

// ─── Element Picker (injected) ───────────────────────────────────

function injectPicker() {
  document.querySelectorAll('#persado-picker-overlay,#persado-highlight').forEach(e=>e.remove());
  let hovered=null;
  const ov=document.createElement('div');ov.id='persado-picker-overlay';ov.style.cssText='position:fixed;inset:0;z-index:2147483646;cursor:crosshair;';document.body.appendChild(ov);
  const hl=document.createElement('div');hl.id='persado-highlight';hl.style.cssText='position:fixed;z-index:2147483647;border:2px solid #E8388C;background:rgba(92,45,145,0.08);pointer-events:none;transition:all 0.1s;border-radius:4px;';document.body.appendChild(hl);
  function cl(el){const t=(el.textContent||'').trim().toLowerCase();const g=el.tagName.toLowerCase();if(g==='a'||g==='button'||el.getAttribute('role')==='button'){if(/(apply|open|start|get started|sign up|learn more|see |try |compare)/i.test(t))return'CTA'}if(/^h[1-4]$/.test(g))return'Headline';if(/^h[5-6]$/.test(g)||/subhead/i.test(el.className||''))return'Subhead';if(/(guarantee|secure|trust|fdic|insured|protection|safe|backed)/i.test(t))return'Trust Line';if(/(offer|rate|bonus|cash|reward|save|earn|fee|apr|apy)/i.test(t))return'Promo';return'Body Copy';}
  function ctx(el){const p=el.closest('section,article,[class*="hero"],[class*="banner"],[class*="card"],[class*="feature"]');if(!p)return'';const f=(p.textContent||'').trim().slice(0,250);return f.replace((el.textContent||'').trim(),'⟦'+(el.textContent||'').trim()+'⟧');}
  function sel(el){if(el.id)return'#'+el.id;if(el.className&&typeof el.className==='string'){const c=el.className.trim().split(/\s+/).slice(0,2).join('.');if(c)return el.tagName.toLowerCase()+'.'+c}return el.tagName.toLowerCase();}
  function pick(el){ov.remove();hl.remove();chrome.runtime.sendMessage({type:'PERSADO_ELEMENT_CAPTURED',element:{type:cl(el),text:(el.textContent||'').trim().slice(0,300),context:ctx(el),selector:sel(el)}});}
  ov.addEventListener('mousemove',e=>{const el=document.elementFromPoint(e.clientX,e.clientY);if(!el||el===ov||el===hl)return;hovered=el;const r=el.getBoundingClientRect();hl.style.left=r.left+'px';hl.style.top=r.top+'px';hl.style.width=r.width+'px';hl.style.height=r.height+'px';});
  ov.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();if(hovered)pick(hovered);});
  document.addEventListener('keydown',function esc(e){if(e.key==='Escape'){ov.remove();hl.remove();document.removeEventListener('keydown',esc);}});
}

// ─── Init ────────────────────────────────────────────────────────

async function init() {
  await detectPage();
  const hasEl = await loadPendingEl();
  if (hasEl) {
    pickElType.textContent = capturedElement.type;
    pickElText.textContent = capturedElement.text||'(empty)';
    pickElCard.style.display = 'block';
    btnNarrate.disabled = false;
    show(pnlPick);
  }
  status('Ready');
}

init();
