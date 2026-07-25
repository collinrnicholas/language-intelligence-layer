// ─── Persado Demo — shared cross-context contract ────────────────
//
// Single source of truth for every message type and storage key that crosses
// between the side panel, the service worker and the content script. A typo now
// reads an undefined property instead of silently sending an unhandled string,
// and `npm run smoke` fails the build when a producer and consumer disagree.
//
// This file is deliberately a CLASSIC script, not an ES module, because a
// content script injected via chrome.scripting.executeScript cannot be a module.
// It is therefore loaded three different ways, all of which populate `PERSADO`:
//   • side panel      <script src="src/messages.js"> before the module
//   • service worker  importScripts('src/messages.js')
//   • content script  executeScript({ files: ['src/messages.js', 'src/content.js'] })

(function (root) {
  const MSG = Object.freeze({
    // ── panel → content script (via chrome.tabs.sendMessage)
    PING: 'PING',
    START_RECORDING: 'START_RECORDING',
    STOP_RECORDING: 'STOP_RECORDING',
    PAUSE_RECORDING: 'PAUSE_RECORDING',
    RESUME_RECORDING: 'RESUME_RECORDING',

    // ── content script → worker → panel (relayed)
    RECORDING_STARTED: 'RECORDING_STARTED',
    LIVE_TRANSCRIPT: 'LIVE_TRANSCRIPT',
    AUDIO_LEVELS: 'AUDIO_LEVELS',
    CONTENT_ERROR: 'CONTENT_ERROR',

    // ── panel → worker
    TRANSCRIBE_AUDIO: 'TRANSCRIBE_AUDIO',
    CAPTURE_PAGE_CONTEXT: 'CAPTURE_PAGE_CONTEXT',
    GET_PAGE_CONTEXT: 'GET_PAGE_CONTEXT',
    CLEAR_PAGE_CONTEXT: 'CLEAR_PAGE_CONTEXT',
    SET_ACTION_STATE: 'SET_ACTION_STATE',

    // ── worker → panel
    TRANSCRIPT_READY: 'TRANSCRIPT_READY',
    TRANSCRIPT_ERROR: 'TRANSCRIPT_ERROR',
    SHOTS_UPDATED: 'SHOTS_UPDATED',
  });

  // Storage keys. Shared so a rename cannot leave one side reading a dead key.
  const KEYS = Object.freeze({
    RECORDING: 'persado:recording',
    TRANSCRIPT: 'persado:transcript',
    RECORDING_START: 'persado:recordingStart',
    PAGE_CONTEXT: 'persado:pageContext',
    ACTION_STATE: 'persado:actionState',
  });

  // Field names inside the stored page-context object. The producer
  // (background.js) and the consumer (sidepanel.js) must agree; smoke.mjs
  // enforces it. Renaming `startShot` → `frames` without updating the reader is
  // exactly the regression that silently disabled the vision path once already.
  const CTX = Object.freeze({
    FRAMES: 'frames',        // [{ full, thumb }] — chronological captures
    ELEMENTS: 'elements',    // extracted on-page copy candidates
    CAPTURED_AT: 'capturedAt',
  });

  // Bumped whenever src/content.js changes. The panel refuses to drive a content
  // script whose version does not match, and injects a fresh copy instead.
  // smoke.mjs hashes content.js and fails if it changed without a bump.
  const CONTENT_VERSION = 2;
  // sha256(src/content.js), first 12 hex. smoke.mjs fails if content.js changed
  // without bumping the version above; it prints the value to paste in.
  const CONTENT_HASH = '423b552d0bb2';

  root.PERSADO = Object.freeze({ MSG, KEYS, CTX, CONTENT_VERSION });
})(typeof self !== 'undefined' ? self : globalThis);
