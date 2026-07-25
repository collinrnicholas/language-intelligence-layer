// ─── Persado Demo — Offscreen Audio Recorder ─────────────────────

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

    // Check audio is actually flowing
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) throw new Error('No audio track available');
    if (audioTrack.muted) throw new Error('Microphone is muted');

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onerror = () => {
      chrome.runtime.sendMessage({ type: 'RECORDING_ERROR', error: 'MediaRecorder error' });
    };
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      if (blob.size === 0) {
        chrome.runtime.sendMessage({ type: 'RECORDING_ERROR', error: 'No audio data captured — mic may be disconnected' });
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        chrome.runtime.sendMessage({ type: 'AUDIO_CAPTURED', audioData: reader.result });
      };
      reader.readAsDataURL(blob);
      stream.getTracks().forEach(t => t.stop());
    };

    mediaRecorder.start(100); // collect data every 100ms for responsiveness
    chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' });
  } catch (err) {
    let msg = err.message;
    if (err.name === 'NotAllowedError') msg = 'Microphone permission denied — allow mic access in browser settings';
    if (err.name === 'NotFoundError') msg = 'No microphone found — connect a mic and try again';
    if (err.name === 'NotReadableError') msg = 'Microphone is in use by another app — close other apps and retry';
    chrome.runtime.sendMessage({ type: 'RECORDING_ERROR', error: msg });
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  } else {
    chrome.runtime.sendMessage({ type: 'RECORDING_ERROR', error: 'Recorder was not active' });
  }
}
