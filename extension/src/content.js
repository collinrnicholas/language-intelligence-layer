// ─── Persado Demo — Content Script ───────────────────────────────
//
// Injects a floating record button into the page. User clicks it
// in the PAGE context → getUserMedia works natively with Chrome's
// permission prompt for the page origin.

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let floatingBtn = null;

// ─── Inject floating record button ───────────────────────────────

function injectRecordButton() {
  if (floatingBtn) return;

  floatingBtn = document.createElement('div');
  floatingBtn.id = 'persado-record-btn';
  floatingBtn.innerHTML = '🎙 Record Brief';
  Object.assign(floatingBtn.style, {
    position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
    background: 'linear-gradient(135deg, #5C2D91, #E8388C)', color: '#fff',
    padding: '12px 24px', borderRadius: '28px', fontFamily: 'Inter, sans-serif',
    fontSize: '14px', fontWeight: '700', cursor: 'pointer',
    boxShadow: '0 4px 20px rgba(92,45,145,0.4)', letterSpacing: '-0.01em',
  });
  document.body.appendChild(floatingBtn);

  floatingBtn.addEventListener('click', async () => {
    // getUserMedia in the PAGE context with a real user click
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      chrome.runtime.sendMessage({
        type: 'RECORDING_ERROR',
        error: err.name === 'NotAllowedError'
          ? 'Microphone denied — allow in browser settings'
          : err.message,
      });
      return;
    }

    audioChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };

    mediaRecorder.start(100);

    // Update button to recording state
    floatingBtn.textContent = '⏹ Stop Recording';
    floatingBtn.style.background = '#EF4444';
    floatingBtn.style.boxShadow = '0 4px 20px rgba(239,68,68,0.4)';

    chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' });
  });
}

function removeRecordButton() {
  if (floatingBtn) { floatingBtn.remove(); floatingBtn = null; }
}

// ─── Stop recording (called from background) ─────────────────────

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') {
    return { ok: false, error: 'Recorder not active' };
  }

  return new Promise((resolve) => {
    mediaRecorder.onstop = () => {
      if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
      mediaRecorder = null;
      removeRecordButton();

      if (audioChunks.length === 0) {
        resolve({ ok: false, error: 'No audio captured' });
        return;
      }

      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = () => resolve({ ok: true, audioData: reader.result });
      reader.onerror = () => resolve({ ok: false, error: 'Failed to read audio' });
      reader.readAsDataURL(blob);
    };
    mediaRecorder.stop();
  });
}

// ─── Message handling ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SHOW_RECORD_BUTTON') {
    injectRecordButton();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'HIDE_RECORD_BUTTON') {
    removeRecordButton();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'STOP_RECORDING') {
    stopRecording().then(sendResponse);
    return true;
  }

  return false;
});
