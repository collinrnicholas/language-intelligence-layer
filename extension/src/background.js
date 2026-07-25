// ─── Persado Demo — Background Worker ────────────────────────────
//
// Transcribes audio sent from sidepanel via gateway Whisper.

const GATEWAY = 'http://localhost:8787';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

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
  if (msg.type === 'TRANSCRIBE_AUDIO' && msg.audioData) {
    transcribe(msg.audioData)
      .then(text => {
        chrome.storage.local.set({ 'persado:transcript': text });
        sendResponse({ ok: true, transcript: text });
      })
      .catch(err => {
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }
  return false;
});
