// ─── Persado Demo — Background Worker (simplified) ───────────────
//
// - START_RECORDING_ONCE → open offscreen, start MediaRecorder
// - STOP_AND_TRANSCRIBE → stop recorder, transcribe via Whisper, respond
// - Element capture relay

const GATEWAY = 'http://localhost:8787';

// ─── Offscreen ───────────────────────────────────────────────────

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/index.html',
    reasons: ['USER_MEDIA'],
    justification: 'Record narration for Persado marketing brief',
  });
}

async function closeOffscreen() {
  try { if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument(); } catch {}
}

// ─── Transcription ───────────────────────────────────────────────

async function transcribe(dataUrl) {
  const blob = await fetch(dataUrl).then(r => r.blob());
  const fd = new FormData();
  fd.append('file', blob, 'narration.webm');
  const r = await fetch(GATEWAY + '/v1/ai/transcribe', { method: 'POST', body: fd });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || 'Transcription failed');
  }
  return (await r.json()).text || '';
}

// ─── Messages ────────────────────────────────────────────────────

let pendingSend = null; // sendResponse for active stop+transcribe request

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Element capture
  if (msg.type === 'PERSADO_ELEMENT_CAPTURED' && msg.element) {
    chrome.storage.local.set({ 'persado:pendingCapture': msg.element });
    chrome.runtime.sendMessage(msg).catch(() => {});
    return false;
  }

  // Offscreen callbacks
  if (msg.type === 'RECORDING_STARTED') {
    chrome.runtime.sendMessage(msg).catch(() => {});
    return false;
  }

  if (msg.type === 'RECORDING_ERROR') {
    if (pendingSend) { pendingSend({ ok: false, error: msg.error }); pendingSend = null; }
    chrome.runtime.sendMessage(msg).catch(() => {});
    closeOffscreen();
    return false;
  }

  if (msg.type === 'AUDIO_CAPTURED' && msg.audioData) {
    transcribe(msg.audioData)
      .then(text => {
        if (pendingSend) { pendingSend({ ok: true, transcript: text }); pendingSend = null; }
        chrome.runtime.sendMessage({ type: 'TRANSCRIPT_READY', transcript: text }).catch(() => {});
      })
      .catch(err => {
        if (pendingSend) { pendingSend({ ok: false, error: err.message }); pendingSend = null; }
        chrome.runtime.sendMessage({ type: 'TRANSCRIPT_ERROR', error: err.message }).catch(() => {});
      });
    closeOffscreen();
    return false;
  }

  // Popup: start one-shot recording
  if (msg.type === 'START_RECORDING_ONCE') {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage({ type: 'START_RECORDING' });
    }).catch(err => {
      chrome.runtime.sendMessage({ type: 'RECORDING_ERROR', error: err.message });
    });
    return false;
  }

  // Popup: stop + transcribe
  if (msg.type === 'STOP_AND_TRANSCRIBE') {
    pendingSend = sendResponse;
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    // Timeout: 20s
    setTimeout(() => {
      if (pendingSend) {
        pendingSend({ ok: false, error: 'Transcription timed out' });
        pendingSend = null;
        closeOffscreen();
      }
    }, 20000);
    return true; // async
  }

  return false;
});
