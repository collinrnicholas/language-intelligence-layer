// ─── Persado Demo — Background Service Worker ────────────────────
//
// - Relays element-capture messages from picker → popup
// - Manages offscreen document for audio recording
// - Transcribes captured audio via gateway Whisper endpoint

const GATEWAY = 'http://localhost:8787';
const OFFSCREEN_PATH = 'offscreen/index.html';

// ─── Audio recording ─────────────────────────────────────────────

let audioResolver = null;
let audioRejecter = null;

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Record narration audio for Persado marketing brief',
    });
  }
}

async function startAudioCapture() {
  await ensureOffscreen();
  return new Promise((resolve, reject) => {
    audioResolver = resolve;
    audioRejecter = reject;
    chrome.runtime.sendMessage({ type: 'START_RECORDING' });
    // Timeout after 60s
    setTimeout(() => {
      if (audioRejecter) {
        audioRejecter(new Error('Recording timeout'));
        audioResolver = null;
        audioRejecter = null;
      }
    }, 60000);
  });
}

function stopAudioCapture() {
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  // Return a promise that resolves when AUDIO_CAPTURED or RECORDING_ERROR arrives
  return new Promise((resolve, reject) => {
    audioResolver = resolve;
    audioRejecter = reject;
    // Timeout for the stop+transcribe round-trip
    setTimeout(() => {
      if (audioRejecter) {
        audioRejecter(new Error('Transcription timeout'));
        audioResolver = null;
        audioRejecter = null;
      }
    }, 30000);
  });
}

// ─── Message handling ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Element capture from injected picker
  if (msg.type === 'PERSADO_ELEMENT_CAPTURED' && msg.element) {
    chrome.storage.local.set({ 'persado:pendingCapture': msg.element });
    chrome.runtime.sendMessage({ type: 'PERSADO_ELEMENT_CAPTURED', element: msg.element }).catch(() => {});
    return false;
  }

  // Audio recording lifecycle callbacks from offscreen
  if (msg.type === 'RECORDING_STARTED') {
    chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' }).catch(() => {});
    return false;
  }

  if (msg.type === 'RECORDING_ERROR') {
    if (audioRejecter) { audioRejecter(new Error(msg.error)); audioResolver = null; audioRejecter = null; }
    chrome.runtime.sendMessage({ type: 'RECORDING_ERROR', error: msg.error }).catch(() => {});
    return false;
  }

  if (msg.type === 'AUDIO_CAPTURED' && msg.audioData) {
    // Transcribe immediately
    transcribeAudio(msg.audioData)
      .then(transcript => {
        if (audioResolver) { audioResolver(transcript); audioResolver = null; audioRejecter = null; }
        chrome.runtime.sendMessage({ type: 'TRANSCRIPT_READY', transcript }).catch(() => {});
      })
      .catch(err => {
        if (audioRejecter) { audioRejecter(err); audioResolver = null; audioRejecter = null; }
        chrome.runtime.sendMessage({ type: 'TRANSCRIPT_ERROR', error: err.message }).catch(() => {});
      });
    return true; // async response handled above
  }

  // Popup requests to start/stop recording
  if (msg.type === 'POPUP_START_RECORDING') {
    startAudioCapture()
      .then(transcript => sendResponse({ ok: true, transcript }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'POPUP_STOP_RECORDING') {
    stopAudioCapture()
      .then(transcript => sendResponse({ ok: true, transcript }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});

// ─── Transcription via gateway ───────────────────────────────────

async function transcribeAudio(dataUrl) {
  // Convert data URL to blob
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();

  const form = new FormData();
  form.append('file', blob, 'narration.webm');

  const gwResp = await fetch(GATEWAY + '/v1/ai/transcribe', {
    method: 'POST',
    body: form,
  });

  if (!gwResp.ok) {
    const err = await gwResp.json().catch(() => ({ error: 'Gateway error' }));
    throw new Error(err.error || 'Transcription failed');
  }

  const data = await gwResp.json();
  return data.text || '';
}

// ─── Close offscreen when done ───────────────────────────────────

// Clean up on extension unload (best effort)
chrome.runtime.onSuspend?.addListener?.(async () => {
  try { await chrome.offscreen.closeDocument(); } catch {}
});
