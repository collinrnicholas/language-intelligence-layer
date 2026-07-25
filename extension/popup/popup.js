// ─── Persado Demo — Popup Logic ──────────────────────────────────
//
// Flow: Configure → Start Capture → Point at element + narrate →
// Stop & Process → Review transcript → Generate → Results
//
// Audio recording happens in an offscreen document (MediaRecorder).
// Element picking injects into the page. Both survive popup close.

const GATEWAY = 'http://localhost:8787';

// ─── DOM refs ────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const headerStatus = $('headerStatus');
const headerStatusText = $('headerStatusText');
const toast = $('toast');

const panelConfigure = $('panelConfigure');
const panelRecording = $('panelRecording');
const panelReview = $('panelReview');
const panelResults = $('panelResults');

const pageUrl = $('pageUrl');
const audienceSelect = $('audience');
const goalSelect = $('goal');
const btnStartCapture = $('btnStartCapture');

// Recording panel
const recTimer = $('recTimer');
const recElType = $('recElType');
const recElText = $('recElText');
const recElementCard = $('recElementCard');
const recHint = $('recHint');
const btnStopCapture = $('btnStopCapture');

// Review panel
const elType = $('elType');
const elText = $('elText');
const elContext = $('elContext');
const narrationBlock = $('narrationBlock');
const narrationText = $('narrationText');
const transcribingStatus = $('transcribingStatus');
const narrationFallback = $('narrationFallback');
const narrationInput = $('narrationInput');
const btnGenerate = $('btnGenerate');
const loadingGenerate = $('loadingGenerate');

// Results panel
const resultsContainer = $('resultsContainer');
const btnExportBrief = $('btnExportBrief');
const btnNewBrief = $('btnNewBrief');

// ─── State ───────────────────────────────────────────────────────

let capturedElement = null;
let narrationTranscript = '';
let recommendations = null;
let currentUrl = '';
let recordingActive = false;
let recSeconds = 0;
let recInterval = null;

// ─── Helpers ─────────────────────────────────────────────────────

function showToast(msg, kind = 'ok') {
  toast.textContent = msg;
  toast.className = 'toast ' + kind;
  setTimeout(() => { toast.className = 'toast'; }, 3000);
}

function setStatus(text, rec = false) {
  headerStatusText.textContent = text;
  headerStatus.className = rec ? 'header-status rec' : 'header-status';
}

function showPanel(panel) {
  [panelConfigure, panelRecording, panelReview, panelResults].forEach(p => p.classList.remove('active'));
  panel.classList.add('active');
}

// ─── Page detection ──────────────────────────────────────────────

async function detectPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      currentUrl = tab.url;
      try { const u = new URL(tab.url); pageUrl.textContent = u.hostname + u.pathname; }
      catch { pageUrl.textContent = tab.url.slice(0, 60); }
    }
  } catch { pageUrl.textContent = '(unknown)'; }
}

// ─── Element picker (injected) ───────────────────────────────────

function injectElementPicker() {
  document.querySelectorAll('#persado-picker-overlay, #persado-highlight').forEach(el => el.remove());

  let hovered = null;

  const overlay = document.createElement('div');
  overlay.id = 'persado-picker-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;';
  document.body.appendChild(overlay);

  const highlight = document.createElement('div');
  highlight.id = 'persado-highlight';
  highlight.style.cssText = 'position:fixed;z-index:2147483647;border:2px solid #E8388C;background:rgba(92,45,145,0.08);pointer-events:none;transition:all 0.1s;border-radius:4px;';
  document.body.appendChild(highlight);

  function classify(el) {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim().toLowerCase();
    if (tag === 'a' || tag === 'button' || el.getAttribute('role') === 'button') {
      if (/(apply|open|start|get started|sign up|learn more|see |try |compare)/i.test(text)) return 'CTA';
    }
    if (/^h[1-4]$/.test(tag)) return 'Headline';
    if (/^h[5-6]$/.test(tag) || /subhead/i.test(el.className || '')) return 'Subhead';
    if (/(guarantee|secure|trust|fdic|insured|protection|safe|backed)/i.test(text)) return 'Trust Line';
    if (/(offer|rate|bonus|cash|reward|save|earn|fee|apr|apy)/i.test(text)) return 'Promo';
    return 'Body Copy';
  }

  function context(el) {
    const p = el.closest('section, article, [class*="hero"], [class*="banner"], [class*="card"], [class*="feature"]');
    if (!p) return '';
    const ft = (p.textContent || '').trim().slice(0, 250);
    const et = (el.textContent || '').trim();
    return ft.replace(et, '⟦' + et + '⟧');
  }

  function sel(el) {
    if (el.id) return '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (cls) return el.tagName.toLowerCase() + '.' + cls;
    }
    return el.tagName.toLowerCase();
  }

  function pick(el) {
    const type = classify(el);
    const text = (el.textContent || '').trim().slice(0, 300);
    overlay.remove(); highlight.remove();
    chrome.runtime.sendMessage({
      type: 'PERSADO_ELEMENT_CAPTURED',
      element: { type, text, context: context(el), selector: sel(el) },
    });
  }

  overlay.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === highlight) return;
    hovered = el;
    const r = el.getBoundingClientRect();
    Object.assign(highlight.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  });

  overlay.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (hovered) pick(hovered); });
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { overlay.remove(); highlight.remove(); document.removeEventListener('keydown', esc); } });
}

// ─── Messages from background ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PERSADO_ELEMENT_CAPTURED' && msg.element) {
    capturedElement = msg.element;
    if (recordingActive) {
      recElType.textContent = msg.element.type;
      recElText.textContent = msg.element.text || '(empty)';
      recElementCard.style.display = 'block';
      recHint.textContent = 'Element captured! Keep narrating, or click another element. 🎤';
    } else {
      renderCapturedElement();
      showPanel(panelReview);
      setStatus('Ready');
    }
  }

  if (msg.type === 'RECORDING_STARTED') {
    recordingActive = true;
    startRecTimer();
  }

  if (msg.type === 'TRANSCRIPT_READY') {
    narrationTranscript = msg.transcript;
    transcribingStatus.style.display = 'none';
    narrationBlock.style.display = 'block';
    narrationText.textContent = msg.transcript;
    narrationFallback.style.display = 'none';
    btnGenerate.disabled = false;
    btnGenerate.textContent = '⚡ Generate Recommendations';
    setStatus('Ready');
  }

  if (msg.type === 'TRANSCRIPT_ERROR') {
    transcribingStatus.style.display = 'none';
    narrationFallback.style.display = '';
    btnGenerate.disabled = false;
    btnGenerate.textContent = '⚡ Generate Recommendations';
    showToast('Voice transcription failed — type narration instead', 'err');
    setStatus('Ready');
  }
});

// ─── Pending capture check ───────────────────────────────────────

async function checkPendingCapture() {
  try {
    const stored = await chrome.storage.local.get('persado:pendingCapture');
    if (stored['persado:pendingCapture']) {
      capturedElement = stored['persado:pendingCapture'];
      await chrome.storage.local.remove('persado:pendingCapture');
      renderCapturedElement();
    }
  } catch {}
}

function renderCapturedElement() {
  if (!capturedElement) return;
  elType.textContent = capturedElement.type;
  elText.textContent = capturedElement.text || '(empty)';
  elContext.textContent = capturedElement.context || '';
  elContext.style.display = capturedElement.context ? 'block' : 'none';
}

// ─── Recording timer ─────────────────────────────────────────────

function startRecTimer() {
  recSeconds = 0;
  recTimer.textContent = '00:00';
  recInterval = setInterval(() => {
    recSeconds++;
    const m = Math.floor(recSeconds / 60).toString().padStart(2, '0');
    const s = (recSeconds % 60).toString().padStart(2, '0');
    recTimer.textContent = m + ':' + s;
  }, 1000);
}

function stopRecTimer() {
  if (recInterval) { clearInterval(recInterval); recInterval = null; }
}

// ─── Start Capture ───────────────────────────────────────────────

btnStartCapture.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { showToast('No active tab found', 'err'); return; }

    // Inject element picker
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectElementPicker,
    });

    // Start audio recording via offscreen
    chrome.runtime.sendMessage({ type: 'POPUP_START_RECORDING' }, (resp) => {
      // Response comes after STOP — not used here
      if (chrome.runtime.lastError) {
        showToast('Mic access failed. ' + chrome.runtime.lastError.message, 'err');
      }
    });

    // Show recording panel
    showPanel(panelRecording);
    setStatus('Recording', true);
    startRecTimer();
    recordingActive = true;

    // Store recording state for re-open after popup close
    chrome.storage.local.set({ 'persado:recording': true });

    showToast('Point at an element + narrate 🎤');
  } catch (err) {
    showToast('Failed: ' + err.message, 'err');
  }
});

// ─── Stop Capture ────────────────────────────────────────────────

btnStopCapture.addEventListener('click', () => {
  stopRecTimer();
  recordingActive = false;
  setStatus('Processing…');
  chrome.storage.local.remove('persado:recording');

  // Stop recording and get transcript
  chrome.runtime.sendMessage({ type: 'POPUP_STOP_RECORDING' }, (resp) => {
    if (chrome.runtime.lastError) {
      showToast('Error stopping recording', 'err');
      showPanel(panelReview);
      narrationFallback.style.display = '';
      return;
    }
    if (resp?.ok && resp.transcript) {
      narrationTranscript = resp.transcript;
      narrationText.textContent = resp.transcript;
      narrationBlock.style.display = 'block';
    } else {
      narrationFallback.style.display = '';
      if (resp?.error) showToast(resp.error, 'err');
    }
    // Check for element
    if (capturedElement) renderCapturedElement();
    showPanel(panelReview);
    setStatus('Ready');
    btnGenerate.disabled = false;
    btnGenerate.textContent = '⚡ Generate Recommendations';
  });

  // Show transcribing state immediately
  showPanel(panelReview);
  transcribingStatus.style.display = 'block';
  btnGenerate.disabled = true;
  btnGenerate.textContent = 'Transcribing…';
  setStatus('Transcribing…');
});

// ─── Generate ────────────────────────────────────────────────────

btnGenerate.addEventListener('click', async () => {
  if (!capturedElement) { showToast('No element captured', 'err'); return; }

  const narration = narrationTranscript || narrationInput.value.trim();
  if (!narration) { showToast('No narration provided', 'err'); return; }

  // If typed, show it
  if (!narrationTranscript && narration) {
    narrationText.textContent = narration;
    narrationBlock.style.display = 'block';
    narrationFallback.style.display = 'none';
  }

  const brief = {
    element: capturedElement,
    narration,
    audience: audienceSelect.value,
    goal: goalSelect.value,
    pageUrl: currentUrl,
  };

  btnGenerate.style.display = 'none';
  loadingGenerate.classList.add('active');
  setStatus('Generating…');

  try {
    const resp = await fetch(GATEWAY + '/v1/ai/recommend', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(brief),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Gateway error' }));
      throw new Error(err.error || 'Gateway returned ' + resp.status);
    }
    const data = await resp.json();
    recommendations = data.variants || [];
    renderResults();
    showPanel(panelResults);
    setStatus('Done');
  } catch (err) {
    showToast(err.message || 'Generation failed', 'err');
    setStatus('Error');
  } finally {
    loadingGenerate.classList.remove('active');
    btnGenerate.style.display = '';
  }
});

// ─── Results ─────────────────────────────────────────────────────

function renderResults() {
  if (!recommendations?.length) {
    resultsContainer.innerHTML = '<div class="empty-state">No variants generated.</div>';
    return;
  }
  resultsContainer.innerHTML = recommendations.map((v, i) => `
    <div class="rec-card">
      <div class="rc-header">
        <div class="rc-number">Variant ${i + 1}</div>
        <div class="rc-variant">${esc(v.copy)}</div>
      </div>
      <div class="rc-body">
        <div class="rc-rationale">${esc(v.rationale || '')}</div>
        <div class="rc-row" style="margin-top:8px;justify-content:space-between;">
          <span class="badge ${v.compliance === 'clear' ? 'clear' : 'flag'}">
            ${v.compliance === 'clear' ? '✓ Compliance Clear' : '⚠ ' + esc(v.complianceNote || 'Flag')}
          </span>
          <span class="badge lift">📈 ${esc(v.predictedLift || '+5–12%')} (illustrative)</span>
        </div>
      </div>
    </div>
  `).join('');
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ─── Export ──────────────────────────────────────────────────────

btnExportBrief.addEventListener('click', () => {
  if (!capturedElement || !recommendations) { showToast('Nothing to export', 'err'); return; }
  const aud = { new: 'New Customers', existing: 'Existing Customers', lapsed: 'Lapsed / Dormant' };
  const gl = { conversions: 'Conversions', clicks: 'Clicks / CTR', trust: 'Trust / Credibility' };
  const md = [
    '# Persado Marketing Brief', '',
    `**Page:** ${currentUrl}`,
    `**Audience:** ${aud[audienceSelect.value]}`,
    `**Goal:** ${gl[goalSelect.value]}`, '',
    '## Captured Element',
    `- **Type:** ${capturedElement.type}`,
    `- **Current Copy:** "${capturedElement.text}"`,
    capturedElement.context ? `- **Surrounding Context:** ${capturedElement.context}` : '',
    `- **Selector:** \`${capturedElement.selector}\``, '',
    '## Narration',
    `> ${narrationText.textContent || '(none)'}`, '',
    '## Recommendations', '',
    '> ⚠️ **Demo only.** Generated by a general-purpose LLM standing in for Persado Motivation AI.', '',
    ...recommendations.flatMap((v, i) => [
      `### Variant ${i + 1}`,
      `- **Copy:** ${v.copy}`,
      `- **Rationale:** ${v.rationale || '—'}`,
      `- **Compliance:** ${v.compliance === 'clear' ? '✓ Clear' : '⚠ ' + (v.complianceNote || 'Flag')}`,
      `- **Predicted Lift:** ${v.predictedLift || '+5–12%'} *(illustrative)*`, '',
    ]),
  ].filter(Boolean).join('\n');

  navigator.clipboard.writeText(md).then(() => showToast('Brief copied ✓'))
    .catch(() => { const ta = document.createElement('textarea'); ta.value = md; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); showToast('Brief copied ✓'); });
});

// ─── New Brief ───────────────────────────────────────────────────

btnNewBrief.addEventListener('click', () => {
  capturedElement = null; recommendations = null; narrationTranscript = '';
  narrationText.textContent = ''; narrationBlock.style.display = 'none';
  narrationFallback.style.display = 'none'; narrationInput.value = '';
  resultsContainer.innerHTML = ''; transcribingStatus.style.display = 'none';
  btnGenerate.disabled = false; btnGenerate.textContent = '⚡ Generate Recommendations';
  showPanel(panelConfigure); setStatus('Ready');
});

// ─── Init ────────────────────────────────────────────────────────

async function init() {
  await detectPage();
  await checkPendingCapture();

  // Check if we were recording when popup reopened
  try {
    const stored = await chrome.storage.local.get('persado:recording');
    if (stored['persado:recording']) {
      recordingActive = true;
      showPanel(panelRecording);
      setStatus('Recording', true);
      startRecTimer();
      if (capturedElement) {
        recElType.textContent = capturedElement.type;
        recElText.textContent = capturedElement.text || '(empty)';
        recElementCard.style.display = 'block';
        recHint.textContent = 'Element captured! Keep narrating, or click another. 🎤';
      }
    }
  } catch {}

  if (capturedElement && !recordingActive) {
    renderCapturedElement();
    showPanel(panelReview);
  }

  setStatus('Ready');
  // Recording picks up later via message
  if (recordingActive) setStatus('Recording', true);
}

init();
