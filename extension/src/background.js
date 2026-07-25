// ─── Persado Demo — Background Worker ────────────────────────────
//
// Relays recording commands to content script (which owns getUserMedia).
// Transcribes audio via gateway Whisper endpoint.

const GATEWAY = 'http://localhost:8787';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ─── Safe messaging ──────────────────────────────────────────────

function safeSend(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ─── Transcription ───────────────────────────────────────────────

async function transcribe(dataUrl) {
  const blob = await fetch(dataUrl).then(r => r.blob());
  if (blob.size < 100) throw new Error('Audio too short — no speech detected');
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

// ─── Content script relay ────────────────────────────────────────

async function sendToActiveTab(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return chrome.tabs.sendMessage(tab.id, msg);
}

// ─── Messages ────────────────────────────────────────────────────

let pendingSend = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Audio blob from content script → transcribe
  if (msg.type === 'AUDIO_BLOB' && msg.data) {
    transcribe(msg.data)
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
    return false;
  }

  // Sidepanel: start recording → forward to content script
  if (msg.type === 'START_RECORDING_ONCE') {
    sendToActiveTab({ type: 'START_RECORDING' })
      .then(r => {
        if (r?.ok) {
          chrome.storage.local.set({ 'persado:recording': true, 'persado:recordingStart': Date.now() });
          safeSend({ type: 'RECORDING_STARTED' });
          sendResponse({ ok: true });
        } else {
          safeSend({ type: 'RECORDING_ERROR', error: r?.error || 'Failed to start recording' });
          sendResponse({ ok: false, error: r?.error || 'Failed to start recording' });
        }
      })
      .catch(err => {
        safeSend({ type: 'RECORDING_ERROR', error: err.message });
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  // Sidepanel: stop recording → forward to content script
  if (msg.type === 'STOP_AND_TRANSCRIBE') {
    pendingSend = sendResponse;
    sendToActiveTab({ type: 'STOP_RECORDING' })
      .then(r => {
        if (!r?.ok) {
          pendingSend({ ok: false, error: r?.error || 'Failed to stop recording' });
          pendingSend = null;
        }
        // If ok, wait for AUDIO_BLOB → transcribe → resolve
      })
      .catch(err => {
        pendingSend({ ok: false, error: err.message });
        pendingSend = null;
      });

    // Timeout
    setTimeout(() => {
      if (pendingSend) {
        pendingSend({ ok: false, error: 'Transcription timed out after 20s' });
        pendingSend = null;
      }
    }, 20000);
    return true;
  }

  return false;
});
