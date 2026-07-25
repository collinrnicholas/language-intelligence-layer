// ─── Persado Demo — Background Worker ────────────────────────────
//
// - Offscreen audio recording → Whisper transcription
// - Element capture relay (picker → storage → popup)
// - Recording badge on extension icon

const GATEWAY = 'http://localhost:8787';
const OFFSCREEN_PATH = 'offscreen/index.html';

// ─── Recording badge ─────────────────────────────────────────────

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {}
}

// ─── Offscreen document ──────────────────────────────────────────

async function ensureOffscreen() {
  try {
    const has = await chrome.offscreen.hasDocument();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['USER_MEDIA'],
        justification: 'Record narration audio for Persado marketing brief',
      });
    }
  } catch (e) {
    console.error('[Persado] Offscreen creation failed:', e.message);
    throw e;
  }
}

async function closeOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch {}
}

// ─── Audio recording (promise-based) ─────────────────────────────

let audioResolve = null;
let audioReject = null;
let audioTimer = null;

function clearAudioPromise() {
  if (audioTimer) { clearTimeout(audioTimer); audioTimer = null; }
  audioResolve = null;
  audioReject = null;
}

async function startRecording() {
  await ensureOffscreen();
  return new Promise((resolve, reject) => {
    audioResolve = resolve;
    audioReject = reject;
    chrome.runtime.sendMessage({ type: 'START_RECORDING' });
    // 90s max recording time
    audioTimer = setTimeout(() => {
      if (audioReject) { audioReject(new Error('Recording timeout (90s)')); clearAudioPromise(); }
    }, 90000);
  });
}

async function stopRecording() {
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  return new Promise((resolve, reject) => {
    audioResolve = resolve;
    audioReject = reject;
    // 15s for stop + transcribe
    audioTimer = setTimeout(() => {
      if (audioReject) { audioReject(new Error('Transcription timed out')); clearAudioPromise(); }
    }, 15000);
  });
}

// ─── Transcription ───────────────────────────────────────────────

async function transcribeAudio(dataUrl) {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  const form = new FormData();
  form.append('file', blob, 'narration.webm');

  const gwResp = await fetch(GATEWAY + '/v1/ai/transcribe', {
    method: 'POST', body: form,
  });

  if (!gwResp.ok) {
    const err = await gwResp.json().catch(() => ({}));
    const msg = err.error || 'Transcription failed';
    // Surface the actual API error (e.g. quota, auth)
    throw new Error(msg);
  }

  const data = await gwResp.json();
  return data.text || '(no speech detected)';
}

// ─── Message router ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ── Element capture from injected picker ──
  if (msg.type === 'PERSADO_ELEMENT_CAPTURED' && msg.element) {
    chrome.storage.local.set({ 'persado:pendingCapture': msg.element });
    // Also try to notify popup directly (silent fail if closed)
    chrome.runtime.sendMessage(msg).catch(() => {});
    return false;
  }

  // ── Offscreen callbacks ──
  if (msg.type === 'RECORDING_STARTED') {
    setBadge('●', '#EF4444');
    chrome.runtime.sendMessage(msg).catch(() => {});
    return false;
  }

  if (msg.type === 'RECORDING_ERROR') {
    setBadge('', '#000000');
    if (audioReject) { audioReject(new Error(msg.error)); clearAudioPromise(); }
    chrome.runtime.sendMessage(msg).catch(() => {});
    closeOffscreen();
    return false;
  }

  if (msg.type === 'AUDIO_CAPTURED' && msg.audioData) {
    transcribeAudio(msg.audioData)
      .then(transcript => {
        setBadge('', '#000000');
        if (audioResolve) { audioResolve(transcript); clearAudioPromise(); }
        chrome.runtime.sendMessage({ type: 'TRANSCRIPT_READY', transcript }).catch(() => {});
      })
      .catch(err => {
        setBadge('', '#000000');
        const msg = err.message.includes('429') || err.message.includes('quota')
          ? 'OpenAI API key is over quota — cannot transcribe. Top up your OpenAI account or use text input.'
          : err.message;
        if (audioReject) { audioReject(new Error(msg)); clearAudioPromise(); }
        chrome.runtime.sendMessage({ type: 'TRANSCRIPT_ERROR', error: msg }).catch(() => {});
      });
    closeOffscreen();
    return true;
  }

  // ── Popup recording commands ──
  if (msg.type === 'POPUP_START_RECORDING') {
    startRecording()
      .then(t => sendResponse({ ok: true, transcript: t }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'POPUP_STOP_RECORDING') {
    stopRecording()
      .then(t => sendResponse({ ok: true, transcript: t }))
      .catch(e => { closeOffscreen(); sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  return false;
});
