// ─── Persado Capture — shared runtime config ─────────────────────
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

  // ── Demo mode ──────────────────────────────────────────────────
  //
  // OFF BY DEFAULT. When true, ONLY the two network calls (transcribe, recommend)
  // return canned responses after a realistic delay. Everything that makes the
  // demo worth watching still runs for real: microphone, waveform, screenshots,
  // element extraction, the coverage check. This exists so a dead gateway, a slow
  // API or a hotel network cannot end a presentation — not to fake the product.
  //
  // The panel shows a persistent "Demo mode" indicator whenever this is true, so
  // a canned run can never be mistaken for a live one.
  const DEMO_MODE = false;

  const DEMO_DELAYS = Object.freeze({ TRANSCRIBE_MS: 2200, RECOMMEND_MS: 3200 });

  const DEMO_TRANSCRIPT =
    'Our premier checking landing page is getting good paid traffic but the main '
    + 'call to action converts well below target. The button just says Open Your '
    + 'Account, which feels generic for a premium product. The audience is younger '
    + 'professionals opening their first serious account, and we want to cross-sell '
    + 'the high-yield savings account to them. We need to lift signups this quarter.';

  const DEMO_VARIANTS = Object.freeze([
    { copy: 'Open your account in 3 minutes',
      rationale: 'Replaces a generic instruction with a concrete time cost, which reduces perceived friction at the decision point.',
      compliance: 'clear', complianceNote: '', predictedLift: '+8–14%' },
    { copy: 'Start earning 4.30% APY today',
      rationale: 'Leads with the rate to anchor value before the ask; requires the APY qualifier to stay compliant.',
      compliance: 'flag', complianceNote: 'Reg DD — APY stated without its compounding basis or qualifying conditions',
      predictedLift: '+12–20%' },
    { copy: 'Join 40,000 professionals banking smarter',
      rationale: 'Social proof reframes the action as joining an existing group rather than starting a transaction.',
      compliance: 'clear', complianceNote: '', predictedLift: '+9–15%' },
  ]);

  root.PERSADO_CONFIG = Object.freeze({
    GATEWAY_URL, ENDPOINTS, TIMEOUTS, ERR,
    DEMO_MODE, DEMO_DELAYS, DEMO_TRANSCRIPT, DEMO_VARIANTS,
  });
})(typeof self !== 'undefined' ? self : globalThis);
