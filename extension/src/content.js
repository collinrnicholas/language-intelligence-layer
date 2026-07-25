// ─── Persado Demo — Content Script ───────────────────────────────
// getUserMedia runs here (page context = proper mic prompt).
// No UI — the side panel controls start/stop.

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let speechRecognition = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    startRecording().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'STOP_RECORDING') {
    stopRecording().then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

async function startRecording() {
  if (mediaRecorder) return;
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.start(100);
  startLiveTranscript();
  chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' }).catch(() => {});
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return { ok: false, error: 'Recorder not active' };
  stopLiveTranscript();
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

function startLiveTranscript() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  speechRecognition = new SR();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;
  speechRecognition.lang = 'en-US';
  speechRecognition.onresult = (event) => {
    let interim = '', final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += t + ' ';
      else interim += t;
    }
    chrome.runtime.sendMessage({ type: 'LIVE_TRANSCRIPT', text: final + interim }).catch(() => {});
  };
  speechRecognition.onerror = () => {};
  speechRecognition.start();
}

function stopLiveTranscript() {
  if (speechRecognition) { try { speechRecognition.stop(); } catch {} speechRecognition = null; }
}
