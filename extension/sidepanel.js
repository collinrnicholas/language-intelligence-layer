// ─── Persado Demo — Side Panel ───────────────────────────────────
// Injects floating record button into page. User clicks → getUserMedia in page context.

const GATEWAY = 'http://localhost:8787';
const $ = (id) => document.getElementById(id);

const pnlConfig=$('panelConfigure'),pnlRecord=$('panelRecord'),pnlResults=$('panelResults');
const pageUrlEl=$('pageUrl'),audienceSelect=$('audience'),goalSelect=$('goal'),btnStart=$('btnStart');
const btnRecord=$('btnRecord'),btnStopRec=$('btnStopRec'),recTimer=$('recTimer'),recStatus=$('recStatus');
const transcriptBlock=$('transcriptBlock'),transcriptText=$('transcriptText');
const fallbackArea=$('fallbackArea'),fallbackInput=$('fallbackInput');
const genStatus=$('genStatus'),genSpinner=$('genSpinner'),genText=$('genText'),btnGenerate=$('btnGenerate');
const resultsContainer=$('resultsContainer'),btnExport=$('btnExportBrief'),btnNew=$('btnNewBrief');
const headerText=$('headerStatusText'),toast=$('toast');

let narrationTranscript='',recommendations=null,currentUrl='',recSec=0,recTimerId=null;

function tm(m,k='ok'){toast.textContent=m;toast.className='toast '+k;setTimeout(()=>toast.className='toast',4000);}
function sh(p){[pnlConfig,pnlRecord,pnlResults].forEach(x=>x.classList.remove('active'));p.classList.add('active');}
function st(t){headerText.textContent=t;}
function ut(s){const m=String(Math.floor(s/60)).padStart(2,'0'),ss=String(s%60).padStart(2,'0');recTimer.textContent=m+':'+ss;}
function stt(){recSec=0;ut(0);recTimer.style.display='block';recTimerId=setInterval(()=>{recSec++;ut(recSec);},1000);}
function spt(){if(recTimerId){clearInterval(recTimerId);recTimerId=null;}}

async function dp(){try{const[t]=await chrome.tabs.query({active:true,currentWindow:true});if(t?.url){currentUrl=t.url;try{pageUrlEl.textContent=new URL(t.url).hostname}catch{pageUrlEl.textContent=t.url.slice(0,40)}}}catch{pageUrlEl.textContent='current page';}}

// ─── Messages relayed from content script via background ─────────

chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.type==='RECORDING_STARTED'){
    // Recording is active on the page — show indicator in sidepanel
    stt();recStatus.textContent='🔴 Recording… speak now.';recStatus.style.color='#EF4444';
    st('Recording');
  }
  if(msg.type==='RECORDING_ERROR'){
    spt();recTimer.style.display='none';btnStopRec.style.display='none';btnRecord.style.display='';
    recStatus.textContent=msg.error||'Recording failed';recStatus.style.color='#EF4444';
    chrome.storage.local.remove('persado:recording');st('Ready');
  }
  if(msg.type==='TRANSCRIPT_READY'){
    // Auto-generate results immediately — no extra click
    narrationTranscript=msg.transcript;spt();recTimer.style.display='none';
    btnStopRec.style.display='none';btnRecord.style.display='none';
    recStatus.textContent='';recStatus.style.color='';
    transcriptBlock.style.display='block';transcriptText.textContent=msg.transcript;
    generateRecommendations(msg.transcript);
  }
  if(msg.type==='TRANSCRIPT_ERROR'){
    spt();recTimer.style.display='none';btnStopRec.style.display='none';btnRecord.style.display='none';
    recStatus.textContent='Transcription failed — type your brief below.';recStatus.style.color='#92400E';
    fallbackArea.style.display='';btnGenerate.style.display='';st('Ready');
  }
});

// ─── Start ───────────────────────────────────────────────────────

btnStart.addEventListener('click',()=>{
  narrationTranscript='';transcriptText.textContent='';transcriptBlock.style.display='none';
  fallbackArea.style.display='none';fallbackInput.value='';genStatus.style.display='none';
  btnGenerate.style.display='none';recTimer.style.display='none';recStatus.textContent='';recStatus.style.color='';
  btnRecord.style.display='';btnStopRec.style.display='none';spt();
  document.querySelector('.instructions').style.display='';
  chrome.storage.local.remove(['persado:recording','persado:transcript','persado:recordingStart']);
  sh(pnlRecord);st('Ready');
});

// ─── Record — injects floating button into PAGE ──────────────────

btnRecord.addEventListener('click',async()=>{
  try{
    const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id){recStatus.textContent='No active tab';recStatus.style.color='#EF4444';return;}
    try{await chrome.tabs.sendMessage(tab.id,{type:'SHOW_RECORD_BUTTON'});}
    catch{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['src/content.js']});await new Promise(r=>setTimeout(r,300));await chrome.tabs.sendMessage(tab.id,{type:'SHOW_RECORD_BUTTON'});}
  }catch(err){recStatus.textContent='Cannot access page. Refresh and retry.';recStatus.style.color='#EF4444';return;}
  btnRecord.style.display='none';btnStopRec.style.display='';
  document.querySelector('.instructions').style.display='none';
  recStatus.textContent='Click the purple Record button on the page → speak.';recStatus.style.color='#5C2D91';
  chrome.storage.local.set({'persado:recording':true,'persado:transcript':'','persado:recordingStart':Date.now()});
});

// ─── Stop — tells content script to stop, then transcribes ───────

btnStopRec.addEventListener('click',async()=>{
  spt();btnStopRec.style.display='none';recTimer.style.display='none';
  recStatus.textContent='Processing…';recStatus.style.color='';
  chrome.storage.local.remove('persado:recording');st('Processing');
  try{
    const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error('No active tab');
    chrome.tabs.sendMessage(tab.id,{type:'STOP_RECORDING'},(r)=>{
      if(chrome.runtime.lastError){recStatus.textContent='Recording stopped — type below.';recStatus.style.color='#92400E';fallbackArea.style.display='';btnGenerate.style.display='';st('Ready');return;}
      if(!r?.ok){recStatus.textContent=(r?.error||'No audio')+' — type below.';recStatus.style.color='#92400E';fallbackArea.style.display='';btnGenerate.style.display='';st('Ready');return;}
      // Got audio — send to background for transcription
      recStatus.textContent='Transcribing…';recStatus.style.color='';
      chrome.runtime.sendMessage({type:'TRANSCRIBE_AUDIO',audioData:r.audioData});
    });
  }catch(err){recStatus.textContent='Error — type below.';recStatus.style.color='#92400E';fallbackArea.style.display='';btnGenerate.style.display='';st('Ready');}
});

// ─── Generate (called automatically on transcript ready) ─────────

async function generateRecommendations(narration){
  if(!narration){tm('No brief','err');return;}
  btnGenerate.style.display='none';genStatus.style.display='block';genSpinner.style.display='block';
  recStatus.textContent='';transcriptBlock.style.display='none';fallbackArea.style.display='none';
  st('Generating');
  genText.textContent='Generating optimized variants…';
  let si=0;const steps=['Generating optimized variants…','Checking regulatory compliance…','Estimating campaign impact…'];
  const sti=setInterval(()=>{if(si<steps.length){genText.textContent=steps[si];si++;}},1500);
  try{
    const resp=await fetch(GATEWAY+'/v1/ai/recommend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({narration,audience:audienceSelect.value,goal:goalSelect.value,pageUrl:currentUrl})});
    if(!resp.ok)throw new Error((await resp.json().catch(()=>({error:'Gateway error'}))).error||'Gateway '+resp.status);
    recommendations=(await resp.json()).variants||[];renderResults();sh(pnlResults);st('Done');
  }catch(e){tm(e.message||'Generation failed','err');st('Error');}
  finally{clearInterval(sti);genStatus.style.display='none';genSpinner.style.display='none';}
}
// Generate button only used for text fallback
btnGenerate.addEventListener('click',()=>{generateRecommendations(fallbackInput.value.trim());});

// ─── Results ─────────────────────────────────────────────────────

function renderResults(){
  if(!recommendations?.length){resultsContainer.innerHTML='<div class="empty-state">No variants generated.</div>';return;}
  resultsContainer.innerHTML=recommendations.map((v,i)=>`<div class="rec-card"><div class="rh"><div class="rn">Variant ${i+1}</div><div class="rv">${esc(v.copy)}</div></div><div class="rb"><div class="rrationale">${esc(v.rationale||'')}</div><div class="rr" style="margin-top:8px;justify-content:space-between;"><span class="badge ${v.compliance==='clear'?'clear':'flag'}">${v.compliance==='clear'?'✓ Compliance Clear':'⚠ '+esc(v.complianceNote||'Flag')}</span><span class="badge lift">📈 ${esc(v.predictedLift||'+5–12%')} (illustrative)</span></div></div></div>`).join('');
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

// ─── Export ──────────────────────────────────────────────────────

btnExport.addEventListener('click',()=>{
  if(!recommendations){tm('Nothing to export','err');return;}
  const pl={retail:'Retail Banking',cards:'Credit Cards',mortgage:'Mortgage & Lending',wealth:'Wealth Management',business:'Small Business Banking'};
  const ob={acquisition:'Acquisition','cross-sell':'Cross-Sell',engagement:'Engagement',retention:'Retention',trust:'Trust & Compliance'};
  const md=['# Persado Marketing Brief','',`**Page:** ${currentUrl}`,`**Product Line:** ${pl[audienceSelect.value]}`,`**Objective:** ${ob[goalSelect.value]}`,'','## Brief',`> ${narrationTranscript||fallbackInput.value||'(none)'}`,'','## Recommendations','','> ⚠️ **Demo only.** Generated by general-purpose LLM standing in for Persado Motivation AI.','',...recommendations.flatMap((v,i)=>[`### Variant ${i+1}`,`- **Copy:** ${v.copy}`,`- **Rationale:** ${v.rationale||'—'}`,`- **Compliance:** ${v.compliance==='clear'?'✓ Clear':'⚠ '+(v.complianceNote||'Flag')}`,`- **Predicted Lift:** ${v.predictedLift||'+5–12%'} *(illustrative)*`,''])].filter(Boolean).join('\n');
  navigator.clipboard.writeText(md).then(()=>tm('Brief copied ✓')).catch(()=>{const t=document.createElement('textarea');t.value=md;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();tm('Brief copied ✓');});
});

// ─── New ─────────────────────────────────────────────────────────

btnNew.addEventListener('click',()=>{
  narrationTranscript='';recommendations=null;transcriptText.textContent='';transcriptBlock.style.display='none';
  fallbackArea.style.display='none';fallbackInput.value='';resultsContainer.innerHTML='';
  btnGenerate.style.display='none';genStatus.style.display='none';btnRecord.style.display='';btnStopRec.style.display='none';
  recTimer.style.display='none';recStatus.textContent='';recStatus.style.color='';spt();
  document.querySelector('.instructions').style.display='';
  chrome.storage.local.remove(['persado:recording','persado:transcript','persado:recordingStart']);
  sh(pnlConfig);st('Ready');
});

// ─── Init ────────────────────────────────────────────────────────

async function init(){
  await dp();
  try{document.getElementById('versionTag').textContent='v'+chrome.runtime.getManifest().version;}catch{}
  try{
    const s=await chrome.storage.local.get(['persado:recording','persado:transcript']);
    if(s['persado:recording']){btnRecord.style.display='none';btnStopRec.style.display='';recStatus.textContent='Recording in progress…';recStatus.style.color='#EF4444';document.querySelector('.instructions').style.display='none';sh(pnlRecord);stt();st('Recording');return;}
    if(s['persado:transcript']){narrationTranscript=s['persado:transcript'];await chrome.storage.local.remove('persado:transcript');sh(pnlRecord);await generateRecommendations(narrationTranscript);return;}
  }catch{}
  st('Ready');
}
init();
