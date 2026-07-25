// ─── Persado Demo — Content Script ───────────────────────────────
//
// getUserMedia runs here (page context = proper mic prompt). No UI — the side
// panel controls start/stop/pause. Also owns the audio analyser, because the
// MediaStream cannot cross into the panel.
//
// IDEMPOTENT BY CONSTRUCTION. The whole file is an IIFE with no top-level
// bindings, so re-injecting it can never throw "Identifier 'x' has already been
// declared" the way a file full of top-level `let` does. Re-running it either
// no-ops (same version already live) or cleanly replaces an older build:
// the previous listener is removed and its recorder torn down first.
//
// Bump PERSADO.CONTENT_VERSION in src/messages.js whenever this file changes.

(function () {
  if (!self.PERSADO) {
    // messages.js must be injected first: executeScript({ files: [messages, content] }).
    console.error('[persado] content.js loaded without src/messages.js — aborting');
    return;
  }
  const { MSG, CONTENT_VERSION } = self.PERSADO;

  const live = self.__persadoContent;
  if (live && live.version === CONTENT_VERSION) return;   // already current — no-op
  if (live) {
    // Older build still resident in this isolated world: unhook it completely so
    // we never end up with two listeners racing over one recorder.
    try { chrome.runtime.onMessage.removeListener(live.listener); } catch {}
    try { live.teardown(); } catch (e) { console.warn('[persado] old content teardown failed', e); }
  }

  // ── All state lives on this object, never as top-level bindings.
  const S = {
    mediaRecorder: null,
    mediaStream: null,
    audioChunks: [],
    speechRecognition: null,
    paused: false,
    // Accumulated FINAL transcript for the whole session. Kept here (not in the
    // panel) so it survives every recogniser restart — pause/resume and the
    // automatic restart after SpeechRecognition ends on its own.
    finalText: '',
    srWanted: false,
    audioCtx: null,
    analyser: null,
    srcNode: null,
    rafId: null,
  };

  const LEVEL_HZ = 16;  // posts per second — NOT per animation frame
  const BANDS = 20;     // magnitudes per post, not the raw frequency buffer

  const report = (error) => {
    try { chrome.runtime.sendMessage({ type: MSG.CONTENT_ERROR, error: String(error && error.stack || error) }).catch(() => {}); } catch {}
  };

  // ── Audio levels ───────────────────────────────────────────────

  function startLevels(stream) {
    const AC = self.AudioContext || self.webkitAudioContext;
    if (!AC) return;
    S.audioCtx = new AC();
    S.srcNode = S.audioCtx.createMediaStreamSource(stream);
    S.analyser = S.audioCtx.createAnalyser();
    S.analyser.fftSize = 256;                  // → 128 bins
    S.analyser.smoothingTimeConstant = 0.6;
    S.srcNode.connect(S.analyser);             // deliberately NOT to destination (no echo)

    const bins = new Uint8Array(S.analyser.frequencyBinCount);
    // Speech energy sits in the lower bins; ignore the top 40% of the spectrum.
    const usable = Math.floor(bins.length * 0.6);
    const per = Math.max(1, Math.floor(usable / BANDS));
    let last = 0;

    const tick = (ts) => {
      if (!S.analyser) return;
      S.rafId = requestAnimationFrame(tick);
      if (ts - last < 1000 / LEVEL_HZ) return;   // throttle to LEVEL_HZ
      last = ts;
      if (S.paused) return;
      S.analyser.getByteFrequencyData(bins);
      const levels = [];
      for (let b = 0; b < BANDS; b++) {
        let sum = 0;
        for (let i = 0; i < per; i++) sum += bins[b * per + i] || 0;
        levels.push(Math.round((sum / per / 255) * 1000) / 1000);
      }
      chrome.runtime.sendMessage({ type: MSG.AUDIO_LEVELS, levels }).catch(() => {});
    };
    S.rafId = requestAnimationFrame(tick);
  }

  function stopLevels() {
    if (S.rafId) cancelAnimationFrame(S.rafId);
    S.rafId = null;
    try { S.srcNode?.disconnect(); S.analyser?.disconnect(); } catch {}
    S.srcNode = null; S.analyser = null;
    if (S.audioCtx) { S.audioCtx.close().catch(() => {}); S.audioCtx = null; }
  }

  // ── Recording ──────────────────────────────────────────────────

  /**
   * NEVER resolves ok:true without a recorder that actually started. The old
   * version early-returned when one already existed and still reported success,
   * which let the panel show a live recording UI over a dead recorder.
   */
  async function startRecording() {
    if (S.mediaRecorder) return { ok: false, error: 'Recorder already active' };
    S.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    S.audioChunks = [];
    S.finalText = '';
    S.paused = false;
    S.mediaRecorder = new MediaRecorder(S.mediaStream, { mimeType: 'audio/webm' });
    S.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) S.audioChunks.push(e.data); };
    S.mediaRecorder.start(100);
    startLevels(S.mediaStream);
    startLiveTranscript();
    chrome.runtime.sendMessage({ type: MSG.RECORDING_STARTED }).catch(() => {});
    return { ok: true, state: S.mediaRecorder.state };
  }

  /** Pause keeps the SAME recorder and the SAME accumulated audio/transcript. */
  async function pauseRecording() {
    if (!S.mediaRecorder || S.mediaRecorder.state !== 'recording') return { ok: false, error: 'Not recording' };
    S.paused = true;
    S.mediaRecorder.pause();
    stopLiveTranscript();                       // finalText is retained
    try { await S.audioCtx?.suspend(); } catch {}
    return { ok: true };
  }

  async function resumeRecording() {
    if (!S.mediaRecorder || S.mediaRecorder.state !== 'paused') return { ok: false, error: 'Not paused' };
    S.paused = false;
    S.mediaRecorder.resume();
    try { await S.audioCtx?.resume(); } catch {}
    startLiveTranscript();                      // new recogniser, same finalText
    return { ok: true };
  }

  async function stopRecording() {
    // A paused recorder is still a valid recorder to stop.
    if (!S.mediaRecorder || (S.mediaRecorder.state !== 'recording' && S.mediaRecorder.state !== 'paused')) {
      return { ok: false, error: 'Recorder not active' };
    }
    stopLiveTranscript();
    stopLevels();
    S.paused = false;
    return new Promise((resolve) => {
      S.mediaRecorder.onstop = () => {
        if (S.mediaStream) { S.mediaStream.getTracks().forEach(t => t.stop()); S.mediaStream = null; }
        S.mediaRecorder = null;
        if (S.audioChunks.length === 0) { resolve({ ok: false, error: 'No audio captured' }); return; }
        const blob = new Blob(S.audioChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => resolve({ ok: true, audioData: reader.result });
        reader.onerror = () => resolve({ ok: false, error: 'Failed to read audio' });
        reader.readAsDataURL(blob);
      };
      S.mediaRecorder.stop();
    });
  }

  /** Hard stop with no reporting — used when an older build is being replaced. */
  function teardown() {
    S.srWanted = false;
    try { S.speechRecognition?.stop(); } catch {}
    S.speechRecognition = null;
    stopLevels();
    try { if (S.mediaRecorder && S.mediaRecorder.state !== 'inactive') S.mediaRecorder.stop(); } catch {}
    try { S.mediaStream?.getTracks().forEach(t => t.stop()); } catch {}
    S.mediaRecorder = null; S.mediaStream = null; S.audioChunks = [];
  }

  // ── Live transcript ────────────────────────────────────────────
  //
  // `final` accumulates for the session; `interim` is only ever the current
  // in-flight phrase. Sending them apart is what lets the panel show a caret
  // after the interim text without ever duplicating settled text.

  function startLiveTranscript() {
    const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
    if (!SR) return;
    S.srWanted = true;
    S.speechRecognition = new SR();
    S.speechRecognition.continuous = true;
    S.speechRecognition.interimResults = true;
    S.speechRecognition.lang = 'en-US';
    S.speechRecognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        // Segments may or may not already carry surrounding whitespace; normalise
        // to exactly one separating space so the transcript has no double gaps.
        if (event.results[i].isFinal) S.finalText += t.trim() + ' ';
        else interim += t;
      }
      chrome.runtime.sendMessage({
        type: MSG.LIVE_TRANSCRIPT,
        final: S.finalText,
        interim,
        text: S.finalText + interim,   // legacy field
      }).catch(() => {});
    };
    S.speechRecognition.onerror = () => {};
    // continuous recognition still ends on its own; restart unless we asked it to stop.
    S.speechRecognition.onend = () => {
      if (S.srWanted && !S.paused && S.speechRecognition) { try { S.speechRecognition.start(); } catch {} }
    };
    try { S.speechRecognition.start(); } catch {}
  }

  function stopLiveTranscript() {
    S.srWanted = false;
    if (S.speechRecognition) { try { S.speechRecognition.stop(); } catch {} S.speechRecognition = null; }
  }

  // ── Messages ───────────────────────────────────────────────────

  const listener = (msg, sender, sendResponse) => {
    // The handshake: the panel refuses to drive a version it does not expect.
    if (msg.type === MSG.PING) {
      sendResponse({ ok: true, version: CONTENT_VERSION, recording: !!S.mediaRecorder });
      return false;
    }
    const run = { [MSG.START_RECORDING]: startRecording, [MSG.STOP_RECORDING]: stopRecording,
                  [MSG.PAUSE_RECORDING]: pauseRecording, [MSG.RESUME_RECORDING]: resumeRecording }[msg.type];
    if (!run) return false;
    run().then(r => sendResponse(r || { ok: true }))
         .catch(e => { report(e); sendResponse({ ok: false, error: e && e.message || String(e) }); });
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);

  self.addEventListener('error', (e) => report(e.error || e.message));
  self.addEventListener('unhandledrejection', (e) => report(e.reason));

  self.__persadoContent = { version: CONTENT_VERSION, listener, teardown };
})();
