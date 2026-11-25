// ─── Persado Assist — shared cross-context contract ──────────────────────────
//
// Single source of truth for every message type and storage key that crosses
// between the side panel, the service worker and the injected page scripts. A
// typo reads an undefined property instead of silently sending an unhandled
// string, and `npm run smoke` fails the build when a producer and consumer disagree.
//
// A CLASSIC script, not an ES module, because a script injected via
// chrome.scripting.executeScript cannot be a module. Loaded three ways:
//   • side panel      <script src="src/messages.js"> before the module
//   • service worker  importScripts('messages.js')
//   • page scripts    executeScript({ files: ['src/messages.js', 'src/scan.js'] })

(function (root) {
  const MSG = Object.freeze({
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
    SCAN_HIGHLIGHT: 'SCAN_HIGHLIGHT',
    // scan → panel: a pick was refused by the eligibility policy (never billable)
    SCAN_BLOCKED: 'SCAN_BLOCKED',
    SCAN_RESTORE: 'SCAN_RESTORE',

    // ── Persado (panel → worker → local gateway). Copy in, results out; never a key.
    PERSADO_TEST: 'PERSADO_TEST',
    PERSADO_SCORE: 'PERSADO_SCORE',
    PERSADO_OPTIMIZE: 'PERSADO_OPTIMIZE',
    USAGE_GET: 'USAGE_GET',
    // Paid runs are jobs: a short status read, and an explicit user retry.
    JOB_STATUS: 'JOB_STATUS',
    JOB_RETRY: 'JOB_RETRY',

    // ── Mailchimp (panel or the Mailchimp overlay → worker)
    MC_TEST: 'MC_TEST',
    MC_STATUS: 'MC_STATUS',
    MC_CONTEXT_CHANGED: 'MC_CONTEXT_CHANGED',
    MC_DRAFTS: 'MC_DRAFTS',
    MC_INSIGHTS: 'MC_INSIGHTS',
    MC_REPORT: 'MC_REPORT',
    MC_SCORE: 'MC_SCORE',
    MC_OPTIMIZE: 'MC_OPTIMIZE',
    MC_APPLY: 'MC_APPLY',
    MC_REVERT: 'MC_REVERT',

    // ── worker → panel (broadcast)
    USAGE_UPDATED: 'USAGE_UPDATED',
  });

  // Storage keys. Shared so a rename cannot leave one side reading a dead key.
  const KEYS = Object.freeze({
    // Legacy browser-stored provider keys. Never written any more; the worker
    // deletes them once the gateway credential is verified.
    API_KEY: 'persado:apiKey',
    MC_API_KEY: 'persado:mailchimpKey',
    // Local gateway pairing token (not a provider key).
    PROXY_TOKEN: 'persado:proxyToken',
    // Non-secret Persado request settings: { brand, industry }. brand is sent as
    // account.name, which Persado requires on every run.
    PERSADO_SETTINGS: 'persado:settings',
    // Unfinished paid runs started from a website, so a closed panel or a browser
    // restart can resume them (src/jobs.js). Holds job references and a text hash.
    JOBS: 'persado:jobs',
    // Local analytics buffer and install id (src/analytics.js). No copy, no URLs.
    ANALYTICS: 'persado:analytics',
  });

  root.PERSADO = Object.freeze({ MSG, KEYS });
})(typeof self !== 'undefined' ? self : globalThis);
