// ─── Persado Demo — Content Script ───────────────────────────────
// getUserMedia runs here (page context = proper mic prompt).
// No UI — the side panel controls start/stop/pause.
//
// Also owns the audio analyser: the MediaStream cannot cross into the side
// panel, so amplitude is reduced to a few band magnitudes here and posted to
// the panel as AUDIO_LEVELS at a throttled rate (see LEVEL_HZ).

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let speechRecognition = null;
let paused = false;

// Accumulated FINAL transcript for the whole session. Kept here (not in the
// panel) so it survives every recogniser restart — pause/resume and the
// automatic restart after SpeechRecognition ends on its own.
let finalText = '';
let srWanted = false;

// ─── Audio levels ────────────────────────────────────────────────

const LEVEL_HZ = 16;  // posts per second — NOT per animation frame
const BANDS = 20;     // magnitudes per post, not the raw frequency buffer

let audioCtx = null, analyser = null, srcNode = null, rafId = null;

function startLevels(stream) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx = new AC();
  srcNode = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;                  // → 128 bins
  analyser.smoothingTimeConstant = 0.6;
  srcNode.connect(analyser);               // deliberately NOT to destination (no echo)

  const bins = new Uint8Array(analyser.frequencyBinCount);
  // Speech energy sits in the lower bins; ignore the top 40% of the spectrum.
  const usable = Math.floor(bins.length * 0.6);
  const per = Math.max(1, Math.floor(usable / BANDS));
  let last = 0;

  const tick = (ts) => {
    if (!analyser) return;
    rafId = requestAnimationFrame(tick);
    if (ts - last < 1000 / LEVEL_HZ) return;   // throttle to LEVEL_HZ
    last = ts;
    if (paused) return;
    analyser.getByteFrequencyData(bins);
    const levels = [];
    for (let b = 0; b < BANDS; b++) {
      let sum = 0;
      for (let i = 0; i < per; i++) sum += bins[b * per + i] || 0;
      levels.push(Math.round((sum / per / 255) * 1000) / 1000);
    }
    chrome.runtime.sendMessage({ type: 'AUDIO_LEVELS', levels }).catch(() => {});
  };
  rafId = requestAnimationFrame(tick);
}

function stopLevels() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  try { srcNode?.disconnect(); analyser?.disconnect(); } catch {}
  srcNode = null; analyser = null;
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
}

// ─── Messages ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    startRecording().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'STOP_RECORDING') {
    stopRecording().then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'PAUSE_RECORDING') {
    pauseRecording().then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'RESUME_RECORDING') {
    resumeRecording().then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

async function startRecording() {
  if (mediaRecorder) return;
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioChunks = [];
  finalText = '';
  paused = false;
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.start(100);
  startLevels(mediaStream);
  startLiveTranscript();
  chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' }).catch(() => {});
}

/** Pause keeps the SAME recorder and the SAME accumulated audio/transcript. */
async function pauseRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return { ok: false, error: 'Not recording' };
  paused = true;
  mediaRecorder.pause();
  stopLiveTranscript();                       // finalText is retained
  try { await audioCtx?.suspend(); } catch {}
  return { ok: true };
}

async function resumeRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'paused') return { ok: false, error: 'Not paused' };
  paused = false;
  mediaRecorder.resume();
  try { await audioCtx?.resume(); } catch {}
  startLiveTranscript();                      // new recogniser, same finalText
  return { ok: true };
}

async function stopRecording() {
  // A paused recorder is still a valid recorder to stop.
  if (!mediaRecorder || (mediaRecorder.state !== 'recording' && mediaRecorder.state !== 'paused')) {
    return { ok: false, error: 'Recorder not active' };
  }
  stopLiveTranscript();
  stopLevels();
  paused = false;
  return new Promise((resolve) => {
    mediaRecorder.onstop = () => {
      if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
      mediaRecorder = null;
      if (audioChunks.length === 0) { resolve({ ok: false, error: 'No audio captured' }); return; }
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = () => resolve({ ok: true, audioData: reader.result });
      reader.onerror = () => resolve({ ok: false, error: 'Failed to read audio' });
      reader.readAsDataURL(blob);
    };
    mediaRecorder.stop();
  });
}

// ─── Live transcript ─────────────────────────────────────────────
//
// `final` accumulates for the session; `interim` is only ever the current
// in-flight phrase. Sending them apart is what lets the panel show a caret
// after the interim text without ever duplicating settled text.

function startLiveTranscript() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  srWanted = true;
  speechRecognition = new SR();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;
  speechRecognition.lang = 'en-US';
  speechRecognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      // Segments may or may not already carry surrounding whitespace; normalise
      // to exactly one separating space so the transcript has no double gaps.
      if (event.results[i].isFinal) finalText += t.trim() + ' ';
      else interim += t;
    }
    chrome.runtime.sendMessage({
      type: 'LIVE_TRANSCRIPT',
      final: finalText,
      interim,
      text: finalText + interim,   // legacy field
    }).catch(() => {});
  };
  speechRecognition.onerror = () => {};
  // continuous recognition still ends on its own; restart unless we asked it to stop.
  speechRecognition.onend = () => {
    if (srWanted && !paused && speechRecognition) { try { speechRecognition.start(); } catch {} }
  };
  try { speechRecognition.start(); } catch {}
}

function stopLiveTranscript() {
  srWanted = false;
  if (speechRecognition) { try { speechRecognition.stop(); } catch {} speechRecognition = null; }
}
