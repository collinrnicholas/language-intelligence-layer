// ─── Persado Demo — Side Panel ───────────────────────────────────
//
// Sidepanel owns getUserMedia directly — persistent, user click context.
// Records audio → sends to background for transcription → auto-generates.

const GATEWAY = 'http://localhost:8787';

const $ = (id) => document.getElementById(id);

const pnlConfig  = $('panelConfigure');
const pnlRecord  = $('panelRecord');
const pnlResults = $('panelResults');

const pageUrlEl      = $('pageUrl');
const audienceSelect = $('audience');
const goalSelect     = $('goal');
const btnStart       = $('btnStart');

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

const resultsContainer = $('resultsContainer');
const btnExport = $('btnExportBrief');
const btnNew    = $('btnNewBrief');

const headerText = $('headerStatusText');
const toast      = $('toast');

let narrationTranscript = '';
let recommendations = null;
let currentUrl = '';
let recSec = 0;
let recTimerId = null;

// ─── Audio recorder (sidepanel-owned) ────────────────────────────
let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];

// ─── Helpers ─────────────────────────────────────────────────────

function toastMsg(m,k='ok'){toast.textContent=m;toast.className='toast '+k;setTimeout(()=>toast.className='toast',4000);}
function show(p){[pnlConfig,pnlRecord,pnlResults].forEach(x=>x.classList.remove('active'));p.classList.add('active');}
function status(t){headerText.textContent=t;}
function updateTimer(s){const m=String(Math.floor(s/60)).padStart(2,'0');const ss=String(s%60).padStart(2,'0');recTimer.textContent=m+':'+ss;}
function startTimer(){recSec=0;updateTimer(0);recTimer.style.display='block';recTimerId=setInterval(()=>{recSec++;updateTimer(recSec);},1000);}
function stopTimer(){if(recTimerId){clearInterval(recTimerId);recTimerId=null;}}

// ─── Page ────────────────────────────────────────────────────────

async function detectPage(){try{const[t]=await chrome.tabs.query({active:true,currentWindow:true});if(t?.url){currentUrl=t.url;try{pageUrlEl.textContent=new URL(t.url).hostname}catch{pageUrlEl.textContent=t.url.slice(0,40)}}}catch{pageUrlEl.textContent='current page';}}

// ─── Messages from background ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.type==='TRANSCRIPT_READY'){narrationTranscript=msg.transcript;transcriptText.textContent=msg.transcript;transcriptBlock.style.display='block';fallbackArea.style.display='none';btnGenerate.style.display='';recStatus.textContent='';stopTimer();recTimer.style.display='none';btnStopRec.style.display='none';btnRecord.style.display='none';status('Ready');}
  if(msg.type==='TRANSCRIPT_ERROR'){fallbackArea.style.display='';btnGenerate.style.display='';recStatus.textContent='Transcription failed: '+(msg.error||'unknown')+' — type below.';recStatus.style.color='#92400E';stopTimer();recTimer.style.display='none';btnStopRec.style.display='none';btnRecord.style.display='none';status('Ready');}
});

// ─── Start ───────────────────────────────────────────────────────

btnStart.addEventListener('click',()=>{
  narrationTranscript='';transcriptText.textContent='';transcriptBlock.style.display='none';
  fallbackArea.style.display='none';fallbackInput.value='';genStatus.style.display='none';
  btnGenerate.style.display='none';recTimer.style.display='none';recStatus.textContent='';recStatus.style.color='';
  btnRecord.style.display='';btnStopRec.style.display='none';stopTimer();
  document.querySelector('.instructions').style.display='';
  chrome.storage.local.remove(['persado:recording','persado:transcript','persado:recordingStart']);
  show(pnlRecord);status('Ready');
});

// ─── Record ──────────────────────────────────────────────────────

btnRecord.addEventListener('click',async ()=>{
  try{mediaStream=await navigator.mediaDevices.getUserMedia({audio:true});}
  catch(err){
    let m=err.message;
    if(err.name==='NotAllowedError')m='Microphone denied — click the lock icon in the address bar to allow.';
    if(err.name==='NotFoundError')m='No microphone found.';
    recStatus.textContent=m;recStatus.style.color='#EF4444';return;
  }
  audioChunks=[];mediaRecorder=new MediaRecorder(mediaStream,{mimeType:'audio/webm'});
  mediaRecorder.ondataavailable=(e)=>{if(e.data.size>0)audioChunks.push(e.data);};
  mediaRecorder.start(100);
  btnRecord.style.display='none';btnStopRec.style.display='';
  document.querySelector('.instructions').style.display='none';
  recStatus.textContent='Listening… speak clearly.';recStatus.style.color='#EF4444';
  startTimer();
  chrome.storage.local.set({'persado:recording':true,'persado:transcript':'','persado:recordingStart':Date.now()});
});

btnStopRec.addEventListener('click',()=>{
  stopTimer();btnStopRec.style.display='none';recTimer.style.display='none';
  recStatus.textContent='Transcribing…';recStatus.style.color='';
  chrome.storage.local.remove('persado:recording');status('Processing');

  if(!mediaRecorder||mediaRecorder.state!=='recording'){recStatus.textContent='Nothing to record — type below.';recStatus.style.color='#92400E';fallbackArea.style.display='';btnGenerate.style.display='';return;}

  const audioPromise=new Promise((resolve,reject)=>{
    mediaRecorder.onstop=()=>{
      if(mediaStream){mediaStream.getTracks().forEach(t=>t.stop());mediaStream=null;}mediaRecorder=null;
      if(audioChunks.length===0){reject(new Error('No audio captured'));return;}
      const blob=new Blob(audioChunks,{type:'audio/webm'});const reader=new FileReader();
      reader.onloadend=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Failed to read audio'));
      reader.readAsDataURL(blob);
    };
  });
  mediaRecorder.stop();

  audioPromise.then(audioData=>{
    chrome.runtime.sendMessage({type:'TRANSCRIBE_AUDIO',audioData},(r)=>{
      if(chrome.runtime.lastError||!r?.ok){recStatus.textContent=(r?.error||'Transcription failed')+' — type below.';recStatus.style.color='#92400E';fallbackArea.style.display='';btnGenerate.style.display='';return;}
      narrationTranscript=r.transcript;recStatus.textContent='';recStatus.style.color='';
      generateRecommendations(narrationTranscript);
    });
  }).catch(err=>{recStatus.textContent=err.message+' — type below.';recStatus.style.color='#92400E';fallbackArea.style.display='';btnGenerate.style.display='';});
});

// ─── Generate ────────────────────────────────────────────────────

async function generateRecommendations(narration){
  if(!narration){toastMsg('No brief','err');return;}
  btnGenerate.style.display='none';genStatus.style.display='block';genSpinner.style.display='block';
  recStatus.textContent='';recStatus.style.color='';transcriptBlock.style.display='none';fallbackArea.style.display='none';
  status('Generating');
  const steps=['Generating optimized variants…','Checking regulatory compliance…','Estimating campaign impact…'];
  let si=0;genText.textContent=steps[0];
  const st=setInterval(()=>{if(si<steps.length){genText.textContent=steps[si];si++;}},1500);
  try{
    const resp=await fetch(GATEWAY+'/v1/ai/recommend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({narration,audience:audienceSelect.value,goal:goalSelect.value,pageUrl:currentUrl})});
    if(!resp.ok)throw new Error((await resp.json().catch(()=>({error:'Gateway error'}))).error||'Gateway '+resp.status);
    recommendations=(await resp.json()).variants||[];renderResults();show(pnlResults);status('Done');
  }catch(e){toastMsg(e.message||'Generation failed','err');status('Error');}
  finally{clearInterval(st);genStatus.style.display='none';genSpinner.style.display='none';}
}
btnGenerate.addEventListener('click',()=>{generateRecommendations(fallbackInput.value.trim());});

// ─── Results ─────────────────────────────────────────────────────

function renderResults(){
  if(!recommendations?.length){resultsContainer.innerHTML='<div class="empty-state">No variants generated.</div>';return;}
  resultsContainer.innerHTML=recommendations.map((v,i)=>`<div class="rec-card"><div class="rh"><div class="rn">Variant ${i+1}</div><div class="rv">${esc(v.copy)}</div></div><div class="rb"><div class="rrationale">${esc(v.rationale||'')}</div><div class="rr" style="margin-top:8px;justify-content:space-between;"><span class="badge ${v.compliance==='clear'?'clear':'flag'}">${v.compliance==='clear'?'✓ Compliance Clear':'⚠ '+esc(v.complianceNote||'Flag')}</span><span class="badge lift">📈 ${esc(v.predictedLift||'+5–12%')} (illustrative)</span></div></div></div>`).join('');
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

// ─── Export ──────────────────────────────────────────────────────

btnExport.addEventListener('click',()=>{
  if(!recommendations){toastMsg('Nothing to export','err');return;}
  const pl={retail:'Retail Banking',cards:'Credit Cards',mortgage:'Mortgage & Lending',wealth:'Wealth Management',business:'Small Business Banking'};
  const ob={acquisition:'Acquisition','cross-sell':'Cross-Sell',engagement:'Engagement',retention:'Retention',trust:'Trust & Compliance'};
  const md=['# Persado Marketing Brief','',`**Page:** ${currentUrl}`,`**Product Line:** ${pl[audienceSelect.value]}`,`**Objective:** ${ob[goalSelect.value]}`,'','## Brief',`> ${narrationTranscript||fallbackInput.value||'(none)'}`,'','## Recommendations','','> ⚠️ **Demo only.** Generated by general-purpose LLM standing in for Persado Motivation AI.','',...recommendations.flatMap((v,i)=>[`### Variant ${i+1}`,`- **Copy:** ${v.copy}`,`- **Rationale:** ${v.rationale||'—'}`,`- **Compliance:** ${v.compliance==='clear'?'✓ Clear':'⚠ '+(v.complianceNote||'Flag')}`,`- **Predicted Lift:** ${v.predictedLift||'+5–12%'} *(illustrative)*`,''])].filter(Boolean).join('\n');
  navigator.clipboard.writeText(md).then(()=>toastMsg('Brief copied ✓')).catch(()=>{const t=document.createElement('textarea');t.value=md;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();toastMsg('Brief copied ✓');});
});

// ─── New ─────────────────────────────────────────────────────────

btnNew.addEventListener('click',()=>{
  narrationTranscript='';recommendations=null;transcriptText.textContent='';transcriptBlock.style.display='none';
  fallbackArea.style.display='none';fallbackInput.value='';resultsContainer.innerHTML='';
  btnGenerate.style.display='none';genStatus.style.display='none';btnRecord.style.display='';btnStopRec.style.display='none';
  recTimer.style.display='none';recStatus.textContent='';recStatus.style.color='';stopTimer();
  document.querySelector('.instructions').style.display='';
  chrome.storage.local.remove(['persado:recording','persado:transcript','persado:recordingStart']);
  show(pnlConfig);status('Ready');
});

// ─── Init ────────────────────────────────────────────────────────

async function init(){
  await detectPage();
  try{document.getElementById('versionTag').textContent='v'+chrome.runtime.getManifest().version;}catch{}
  try{
    const s=await chrome.storage.local.get(['persado:recording','persado:transcript','persado:recordingStart']);
    if(s['persado:recording']){btnRecord.style.display='none';btnStopRec.style.display='';recStatus.textContent='Recording in progress…';recStatus.style.color='#EF4444';transcriptBlock.style.display='none';fallbackArea.style.display='none';btnGenerate.style.display='none';genStatus.style.display='none';document.querySelector('.instructions').style.display='none';show(pnlRecord);if(s['persado:recordingStart']){const e=Math.floor((Date.now()-s['persado:recordingStart'])/1000);recSec=e;updateTimer(e);recTimer.style.display='block';recTimerId=setInterval(()=>{recSec++;updateTimer(recSec);},1000);}status('Recording');return;}
    if(s['persado:transcript']){narrationTranscript=s['persado:transcript'];await chrome.storage.local.remove('persado:transcript');show(pnlRecord);await generateRecommendations(narrationTranscript);return;}
  }catch{}
  status('Ready');
}
init();
