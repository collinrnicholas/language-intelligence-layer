// ─── Persado Demo — shared runtime config ────────────────────────
//
// THE single place the gateway URL is written. It used to be hardcoded in three
// files (sidepanel.js, background.js and the dead popup), which is exactly how a
// port or host change becomes a "Failed to fetch" nobody can explain.
// scripts/smoke.mjs fails if the base URL appears more than once under extension/.
//
// Classic script, like messages.js, so all contexts can load it the same way:
//   • side panel      <script src="src/config.js"> before the module
//   • service worker  importScripts('config.js')

(function (root) {
  // 127.0.0.1 rather than localhost on purpose: `localhost` can resolve to ::1
  // while a server bound only to IPv4 listens on 127.0.0.1 (or the reverse), and
  // the failure looks identical to the gateway being down. gateway/server.mjs
  // binds 127.0.0.1 explicitly to match. Both are in manifest host_permissions.
  const GATEWAY_URL = 'http://127.0.0.1:8787';

  const ENDPOINTS = Object.freeze({
    HEALTH: '/health',
    TRANSCRIBE: '/v1/ai/transcribe',
    RECOMMEND: '/v1/ai/recommend',
  });

  const TIMEOUTS = Object.freeze({
    HEALTH_MS: 2000,    // preflight — must feel instant
    REQUEST_MS: 60000,  // transcribe / recommend
  });

  // Typed failure kinds. The UI maps these to plain language; a raw
  // "TypeError: Failed to fetch" must never reach a user.
  const ERR = Object.freeze({
    UNREACHABLE: 'gateway_unreachable',
    TIMEOUT: 'gateway_timeout',
    GATEWAY: 'gateway_error',
  });

  root.PERSADO_CONFIG = Object.freeze({ GATEWAY_URL, ENDPOINTS, TIMEOUTS, ERR });
})(typeof self !== 'undefined' ? self : globalThis);
