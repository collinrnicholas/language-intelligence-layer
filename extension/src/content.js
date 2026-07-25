// ─── Persado Demo — Content Script ───────────────────────────────
//
// Owns getUserMedia (runs in page context — Chrome shows proper
// mic permission prompt). Manages MediaRecorder directly.
// Same approach as Loupe.

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    startRecording()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'STOP_RECORDING') {
    stopRecording()
      .then(dataUrl => sendResponse({ ok: true, audioData: dataUrl }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
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

  return new Promise((resolve, reject) => {
    mediaRecorder.onstart = () => resolve();
    mediaRecorder.onerror = () => reject(new Error('MediaRecorder error'));
    mediaRecorder.start(100);
  });
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') {
    throw new Error('Recorder not active');
  }

  return new Promise((resolve, reject) => {
    mediaRecorder.onstop = () => {
      if (audioChunks.length === 0) {
        reject(new Error('No audio captured'));
        return;
      }
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to read audio'));
      reader.readAsDataURL(blob);

      if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
      mediaRecorder = null;
    };
    mediaRecorder.stop();
  });
}
