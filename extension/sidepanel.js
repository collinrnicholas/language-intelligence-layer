// ─── Persado Demo — Side Panel ───────────────────────────────────
const GATEWAY = 'http://localhost:8787';
const $ = (id) => document.getElementById(id);

const pnlConfig=$('panelConfigure'),pnlRecord=$('panelRecord'),pnlResults=$('panelResults');
const pageUrlEl=$('pageUrl'),audienceSelect=$('audience'),goalSelect=$('goal'),btnStart=$('btnStart');
const btnRecord=$('btnRecord'),btnStopRec=$('btnStopRec'),recTimer=$('recTimer'),recStatus=$('recStatus'),liveTranscript=$('liveTranscript');
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

async function dp(){
  try{const[t]=await chrome.tabs.query({active:true,currentWindow:true});if(t?.url){currentUrl=t.url;try{pageUrlEl.value=new URL(t.url).hostname+new URL(t.url).pathname}catch{pageUrlEl.value=t.url}}}
  catch{pageUrlEl.placeholder='current page';}
}
chrome.tabs.onUpdated.addListener((tabId,ci,tab)=>{if(ci.url&&tab.active){currentUrl=ci.url;try{pageUrlEl.value=new URL(ci.url).hostname+new URL(ci.url).pathname}catch{pageUrlEl.value=ci.url;}}});
chrome.tabs.onActivated.addListener(async(a)=>{try{const t=await chrome.tabs.get(a.tabId);if(t?.url){currentUrl=t.url;try{pageUrlEl.value=new URL(t.url).hostname+new URL(t.url).pathname}catch{pageUrlEl.value=t.url;}}}catch{}});

// ─── Messages ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.type==='TRANSCRIPT_READY'){narrationTranscript=msg.transcript;liveTranscript.style.display='none';spt();recTimer.style.display='none';btnStopRec.style.display='none';btnRecord.style.display='none';generateRecommendations(msg.transcript);}
  if(msg.type==='TRANSCRIPT_ERROR'){liveTranscript.style.display='none';spt();recTimer.style.display='none';btnStopRec.style.display='none';btnRecord.style.display='none';recStatus.textContent='Transcription failed — try again.';recStatus.style.color='#92400E';}
  if(msg.type==='LIVE_TRANSCRIPT'){
    liveTranscript.style.display='block';
    // Accumulate transcript — don't replace, append so user sees full history
    if (!liveTranscript._fullText) liveTranscript._fullText = '';
    const prev = liveTranscript._fullText;
    if (msg.text && msg.text.length > prev.length) {
      liveTranscript._fullText = msg.text;
      liveTranscript.textContent = msg.text;
      liveTranscript.scrollTop = liveTranscript.scrollHeight;
    }
  }
});

// ─── Configure → Record ──────────────────────────────────────────

btnStart.addEventListener('click',()=>{
  narrationTranscript='';transcriptText.textContent='';transcriptBlock.style.display='none';
  fallbackArea.style.display='none';fallbackInput.value='';genStatus.style.display='none';
  btnGenerate.style.display='none';recTimer.style.display='none';recStatus.textContent='';recStatus.style.color='';
  btnRecord.style.display='';btnStopRec.style.display='none';spt();
  liveTranscript._fullText='';liveTranscript.textContent='';liveTranscript.style.display='none';
  document.querySelector('.instructions').style.display='';
  chrome.storage.local.remove(['persado:recording','persado:transcript','persado:recordingStart']);
  sh(pnlRecord);st('Ready');
});

// ─── Record — sends START_RECORDING directly to content script ───

btnRecord.addEventListener('click',async()=>{
  try{
    const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id){recStatus.textContent='No active tab';recStatus.style.color='#EF4444';return;}
    try{await chrome.tabs.sendMessage(tab.id,{type:'START_RECORDING'});}
    catch{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['src/content.js']});await new Promise(r=>setTimeout(r,300));await chrome.tabs.sendMessage(tab.id,{type:'START_RECORDING'});}
  }catch(err){recStatus.textContent='Cannot access page. Refresh.';recStatus.style.color='#EF4444';return;}
  btnRecord.style.display='none';btnStopRec.style.display='';
  document.querySelector('.instructions').style.display='none';
  recStatus.textContent='Speak now — describe the problem.';recStatus.style.color='#EF4444';
  chrome.storage.local.set({'persado:recording':true,'persado:transcript':'','persado:recordingStart':Date.now()});
});

btnStopRec.addEventListener('click',async()=>{
  spt();btnStopRec.style.display='none';recTimer.style.display='none';
  recStatus.textContent='Processing…';recStatus.style.color='';
  chrome.storage.local.remove('persado:recording');st('Processing');
  try{
    const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error('No tab');
    chrome.tabs.sendMessage(tab.id,{type:'STOP_RECORDING'},(r)=>{
      if(chrome.runtime.lastError||!r?.ok){recStatus.textContent=(r?.error||'No audio')+' — type below.';recStatus.style.color='#92400E';fallbackArea.style.display='';btnGenerate.style.display='';st('Ready');return;}
      recStatus.textContent='Transcribing…';recStatus.style.color='';
      chrome.runtime.sendMessage({type:'TRANSCRIBE_AUDIO',audioData:r.audioData});
    });
  }catch(err){recStatus.textContent='Error — type below.';recStatus.style.color='#92400E';fallbackArea.style.display='';btnGenerate.style.display='';st('Ready');}
});

// ─── Generate ────────────────────────────────────────────────────

async function generateRecommendations(narration){
  if(!narration){tm('No brief','err');return;}
  btnGenerate.style.display='none';genStatus.style.display='block';genSpinner.style.display='block';
  recStatus.textContent='';transcriptBlock.style.display='none';fallbackArea.style.display='none';
  st('Generating');genText.textContent='Generating optimized variants…';
  let si=0;const steps=['Generating optimized variants…','Checking regulatory compliance…','Estimating campaign impact…'];
  const sti=setInterval(()=>{if(si<steps.length){genText.textContent=steps[si];si++;}},1500);
  try{
    const resp=await fetch(GATEWAY+'/v1/ai/recommend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({narration,audience:audienceSelect.value,goal:goalSelect.value,pageUrl:currentUrl})});
    if(!resp.ok)throw new Error((await resp.json().catch(()=>({error:'Gateway error'}))).error||'Gateway '+resp.status);
    recommendations=(await resp.json()).variants||[];renderResults();sh(pnlResults);st('Done');
  }catch(e){tm(e.message||'Generation failed','err');st('Error');}
  finally{clearInterval(sti);genStatus.style.display='none';genSpinner.style.display='none';}
}
btnGenerate.addEventListener('click',()=>{generateRecommendations(fallbackInput.value.trim());});

// ─── Results ─────────────────────────────────────────────────────

function renderResults(){
  if(!recommendations?.length){resultsContainer.innerHTML='<div class="empty-state">No variants generated.</div>';return;}
  resultsContainer.innerHTML=recommendations.map((v,i)=>`<div class="rec-card"><div class="rh"><div class="rn">Variant ${i+1}</div><div class="rv">${esc(v.copy)}</div></div><div class="rb"><div class="rrationale">${esc(v.rationale||'')}</div><div class="rr" style="margin-top:8px;justify-content:space-between;"><span class="badge ${v.compliance==='clear'?'clear':'flag'}">${v.compliance==='clear'?'✓ Compliance Clear':'⚠ '+esc(v.complianceNote||'Flag')}</span><span class="badge lift">📈 ${esc(v.predictedLift||'+5–12%')} (illustrative)</span></div></div></div>`).join('');
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

// ─── Export PDF ──────────────────────────────────────────────────

btnExport.addEventListener('click',()=>{
  if(!recommendations){tm('Nothing to export','err');return;}
  const pl={retail:'Retail Banking',cards:'Credit Cards',mortgage:'Mortgage & Lending',wealth:'Wealth Management',business:'Small Business Banking'};
  const ob={acquisition:'Acquisition','cross-sell':'Cross-Sell',engagement:'Engagement',retention:'Retention',trust:'Trust & Compliance'};
  const vh=recommendations.map((v,i)=>`<div class="variant"><div class="v-num">Variant ${i+1}</div><div class="v-copy">${v.copy}</div><div class="v-rationale">${v.rationale||''}</div><div class="v-meta"><span class="pill ${v.compliance==='clear'?'clear':'flag'}">${v.compliance==='clear'?'✓ Compliance Clear':'⚠ '+(v.complianceNote||'Review')}</span><span class="pill lift">📈 ${v.predictedLift||'+5–12%'} (illustrative)</span></div></div>`).join('');
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Persado Brief</title><style>body{font-family:Inter,sans-serif;max-width:700px;margin:40px auto;color:#1A1128;line-height:1.6;font-size:14px}h1{font-size:24px;color:#5C2D91}.meta{color:#9088A0;font-size:12px;margin-bottom:24px}h2{font-size:16px;color:#5C2D91;margin-top:28px;border-bottom:1px solid #E8E4F0;padding-bottom:4px}blockquote{background:#F8F7FA;border-left:3px solid #5C2D91;padding:12px 16px;margin:12px 0;font-style:italic;color:#5C506C}.variant{background:#F8F7FA;border:1px solid #E8E4F0;border-radius:10px;padding:16px;margin:14px 0}.v-num{font-size:10px;font-weight:700;color:#5C2D91;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}.v-copy{font-size:15px;font-weight:700;margin-bottom:8px}.v-rationale{color:#5C506C;font-size:12px;margin-bottom:10px}.v-meta{display:flex;gap:8px}.pill{font-size:10px;font-weight:600;padding:3px 8px;border-radius:8px}.pill.clear{background:#ECFDF5;color:#065F46}.pill.flag{background:#FFFBEB;color:#92400E}.pill.lift{background:rgba(92,45,145,.08);color:#5C2D91}.disc{background:#FFFBEB;padding:10px 14px;border-radius:8px;font-size:11px;color:#92400E;margin-top:20px}@media print{body{margin:20px}}</style></head><body><h1>Persado Marketing Brief</h1><div class="meta">${currentUrl} · ${pl[audienceSelect.value]} · ${ob[goalSelect.value]}</div><h2>Brief</h2><blockquote>${narrationTranscript||'(none)'}</blockquote><h2>Recommendations</h2>${vh}<script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`;
  const w=window.open('','_blank','width=800,height=600');w.document.write(html);w.document.close();
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

async function init(){
  await dp();
  try{document.getElementById('versionTag').textContent='v'+chrome.runtime.getManifest().version;}catch{}
  try{const s=await chrome.storage.local.get(['persado:recording','persado:transcript']);
    if(s['persado:recording']){btnRecord.style.display='none';btnStopRec.style.display='';recStatus.textContent='Recording in progress…';recStatus.style.color='#EF4444';document.querySelector('.instructions').style.display='none';sh(pnlRecord);stt();st('Recording');return;}
    if(s['persado:transcript']){narrationTranscript=s['persado:transcript'];await chrome.storage.local.remove('persado:transcript');sh(pnlRecord);await generateRecommendations(narrationTranscript);return;}
  }catch{}
  st('Ready');
}
init();
