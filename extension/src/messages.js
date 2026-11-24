// ─── Language Intelligence Layer — shared cross-context contract ─────────────
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
    RETRY_TRANSCRIBE: 'RETRY_TRANSCRIBE',
    GET_PENDING_AUDIO: 'GET_PENDING_AUDIO',
    DISCARD_PENDING_AUDIO: 'DISCARD_PENDING_AUDIO',
    GATEWAY_HEALTH: 'GATEWAY_HEALTH',
    CAPTURE_PAGE_CONTEXT: 'CAPTURE_PAGE_CONTEXT',
    GET_PAGE_CONTEXT: 'GET_PAGE_CONTEXT',
    CLEAR_PAGE_CONTEXT: 'CLEAR_PAGE_CONTEXT',
    SET_ACTION_STATE: 'SET_ACTION_STATE',

    // ── page scan (panel → tab, handled by src/scan.js)
    SCAN_PAGE: 'SCAN_PAGE',
    SCAN_PICK: 'SCAN_PICK',
    SCAN_CANCEL: 'SCAN_CANCEL',
    // scan.js → panel (picked element / cancelled)
    SCAN_PICKED: 'SCAN_PICKED',
    SCAN_CANCELLED: 'SCAN_CANCELLED',

    // ── page preview (panel → tab, handled by src/scan.js). Temporary: the page's
    // own copy is restored on SCAN_RESTORE, on navigation, or on reload.
    SCAN_PREVIEW: 'SCAN_PREVIEW',
    SCAN_RESTORE: 'SCAN_RESTORE',

    // ── Persado service (panel → worker). The worker is the only context that
    // reads the Persado key; these carry copy in and results out, never the key.
    PERSADO_TEST: 'PERSADO_TEST',
    PERSADO_SCORE: 'PERSADO_SCORE',
    PERSADO_OPTIMIZE: 'PERSADO_OPTIMIZE',
    USAGE_GET: 'USAGE_GET',
    USAGE_RESET: 'USAGE_RESET',

    // ── Mailchimp (panel or the Mailchimp overlay → worker)
    MC_TEST: 'MC_TEST',
    MC_DISCONNECT: 'MC_DISCONNECT',
    MC_STATUS: 'MC_STATUS',
    MC_CONTEXT_CHANGED: 'MC_CONTEXT_CHANGED',
    MC_DRAFTS: 'MC_DRAFTS',
    MC_SCORE: 'MC_SCORE',
    MC_OPTIMIZE: 'MC_OPTIMIZE',
    MC_APPLY: 'MC_APPLY',
    MC_REVERT: 'MC_REVERT',
    MC_TEST_SEND: 'MC_TEST_SEND',

    // ── worker → panel + overlay (broadcast)
    AUTOPILOT_PROGRESS: 'AUTOPILOT_PROGRESS',
    USAGE_UPDATED: 'USAGE_UPDATED',

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
    // The recorded audio awaiting a successful transcription. Session storage, so
    // it survives a panel close and worker eviction but never reaches disk — the
    // start screen promises audio stays on the device until results are reviewed.
    PENDING_AUDIO: 'persado:pendingAudio',
    // Screen-capture toggle, set from the options page. local storage (persists
    // across restarts). Absent → the config default (CAPTURE_SCREENSHOTS, off).
    // In a managed deployment this would be an administrator/enterprise-policy
    // decision, not an end-user preference.
    CAPTURE_SCREENSHOTS: 'persado:captureScreenshots',
    // The user's Persado API key, entered in Settings. local storage so it survives
    // a restart; never synced, never written anywhere but this profile.
    API_KEY: 'persado:apiKey',
    PROXY_TOKEN: 'persado:proxyToken',
    // Non-secret Persado request settings: { brand, industry }. brand is sent as
    // account.name, which Persado requires on every run.
    PERSADO_SETTINGS: 'persado:settings',
    // Local Persado usage ledger (src/usage.js). Holds counts and a 12-hex key
    // fingerprint — never the key.
    USAGE: 'persado:usage',
    // Activity log (src/activity.js): runs, writes, verifications, reverts.
    ACTIVITY: 'persado:activity',
    // Mailchimp API key. local storage, read only by the service worker.
    MC_API_KEY: 'persado:mailchimpKey',
    // Non-secret Mailchimp settings: { serverPrefix, allowBodyOnBuilder,
    // testEmails, accountName, dc, connectedAt }.
    MC_SETTINGS: 'persado:mailchimp',
    // Pre-write snapshots per campaign id, for Revert and duplicate detection.
    MC_SNAPSHOTS: 'persado:mcSnapshots',
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
  const CONTENT_VERSION = 6;
  // sha256(src/content.js), first 12 hex. smoke.mjs fails if content.js changed
  // without bumping the version above; it prints the value to paste in.
  const CONTENT_HASH = '4accd3244656';

  root.PERSADO = Object.freeze({ MSG, KEYS, CTX, CONTENT_VERSION });
})(typeof self !== 'undefined' ? self : globalThis);
