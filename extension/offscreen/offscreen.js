// ─── Persado Demo — Offscreen Audio Recorder ─────────────────────
//
// Records audio via MediaRecorder, forwards blob to background worker
// for transcription via the gateway Whisper endpoint.

let mediaRecorder = null;
let chunks = [];

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START_RECORDING') startRecording();
  if (msg.type === 'STOP_RECORDING') stopRecording();
});

async function startRecording() {
  chunks = [];
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = () => {
        chrome.runtime.sendMessage({
          type: 'AUDIO_CAPTURED',
          audioData: reader.result, // base64 data URL
        });
      };
      reader.readAsDataURL(blob);
      stream.getTracks().forEach(t => t.stop());
    };
    mediaRecorder.start();
    chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' });
  } catch (err) {
    chrome.runtime.sendMessage({ type: 'RECORDING_ERROR', error: err.message });
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}
