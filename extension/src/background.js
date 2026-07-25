// ─── Persado Demo — Background Worker ────────────────────────────

const GATEWAY = 'http://localhost:8787';

// ─── Side Panel ──────────────────────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ─── Safe messaging ──────────────────────────────────────────────

function safeSend(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ─── Offscreen ───────────────────────────────────────────────────

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/index.html',
    reasons: ['USER_MEDIA'],
    justification: 'Record narration for Persado marketing brief',
  });
  // Wait for offscreen script to load and register listener
  await new Promise(r => setTimeout(r, 300));
}

async function closeOffscreen() {
  try { if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument(); } catch {}
}

// ─── Transcription ───────────────────────────────────────────────

async function transcribe(dataUrl) {
  const blob = await fetch(dataUrl).then(r => r.blob());
  if (blob.size < 100) throw new Error('Audio too short or empty — no speech captured');
  const fd = new FormData();
  fd.append('file', blob, 'narration.webm');
  const r = await fetch(GATEWAY + '/v1/ai/transcribe', { method: 'POST', body: fd });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    const msg = e.error || 'Transcription failed';
    if (msg.includes('429') || msg.includes('quota')) throw new Error('OpenAI quota exceeded');
    if (msg.includes('401')) throw new Error('API key invalid');
    throw new Error(msg);
  }
  return (await r.json()).text || '(no speech detected)';
}

// ─── Messages ────────────────────────────────────────────────────

let pendingSend = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Offscreen callbacks — relay to sidepanel
  if (msg.type === 'RECORDING_STARTED') {
    chrome.storage.local.set({ 'persado:recordingStart': Date.now() });
    safeSend(msg);
    return false;
  }

  if (msg.type === 'RECORDING_ERROR') {
    chrome.storage.local.remove('persado:recording');
    if (pendingSend) { pendingSend({ ok: false, error: msg.error }); pendingSend = null; }
    safeSend(msg);
    closeOffscreen();
    return false;
  }

  if (msg.type === 'AUDIO_CAPTURED' && msg.audioData) {
    transcribe(msg.audioData)
      .then(text => {
        chrome.storage.local.set({ 'persado:transcript': text });
        chrome.storage.local.remove('persado:recording');
        if (pendingSend) { pendingSend({ ok: true, transcript: text }); pendingSend = null; }
        safeSend({ type: 'TRANSCRIPT_READY', transcript: text });
      })
      .catch(err => {
        chrome.storage.local.remove('persado:recording');
        chrome.storage.local.set({ 'persado:transcript': '' });
        if (pendingSend) { pendingSend({ ok: false, error: err.message }); pendingSend = null; }
        safeSend({ type: 'TRANSCRIPT_ERROR', error: err.message });
      });
    closeOffscreen();
    return false;
  }

  // Sidepanel: start one-shot recording
  if (msg.type === 'START_RECORDING_ONCE') {
    ensureOffscreen().then(() => {
      safeSend({ type: 'START_RECORDING' });
    }).catch(err => {
      safeSend({ type: 'RECORDING_ERROR', error: 'Microphone access failed: ' + err.message });
    });
    return false;
  }

  // Sidepanel: stop + transcribe
  if (msg.type === 'STOP_AND_TRANSCRIBE') {
    pendingSend = sendResponse;
    safeSend({ type: 'STOP_RECORDING' });
    setTimeout(() => {
      if (pendingSend) {
        pendingSend({ ok: false, error: 'Transcription timed out after 20s' });
        pendingSend = null;
        closeOffscreen();
      }
    }, 20000);
    return true;
  }

  return false;
});
