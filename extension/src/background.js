// ─── Persado Demo — Background Worker ────────────────────────────
//
// Relays messages between content script and sidepanel.
// Transcribes audio via gateway Whisper.

const GATEWAY = 'http://localhost:8787';
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

function relay(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Relay content script events to sidepanel
  if (msg.type === 'RECORDING_STARTED') { relay(msg); return false; }
  if (msg.type === 'RECORDING_ERROR') { relay(msg); return false; }

  // Transcribe audio from sidepanel (or content script)
  if (msg.type === 'TRANSCRIBE_AUDIO' && msg.audioData) {
    transcribe(msg.audioData)
      .then(text => {
        chrome.storage.local.set({ 'persado:transcript': text });
        relay({ type: 'TRANSCRIPT_READY', transcript: text });
        sendResponse({ ok: true, transcript: text });
      })
      .catch(err => {
        relay({ type: 'TRANSCRIPT_ERROR', error: err.message });
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  return false;
});
