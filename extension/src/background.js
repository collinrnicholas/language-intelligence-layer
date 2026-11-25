// ─── Persado Assist — Background Worker ──────────────────────────────────────
//
// Two jobs only:
//   1. Toolbar state: the icon dims on pages where the extension cannot work.
//   2. Authenticated relay from the side panel to the local gateway, which holds
//      the provider credentials. Every relayed request is short: paid runs answer
//      within the gateway's response budget and are then polled (JOB_STATUS), so
//      this worker never waits minutes on a fetch it could be stopped during.

// Classic (non-module) service worker so the shared message/key contract can be
// importScripts'd — content scripts cannot be ES modules, so messages.js has to
// be a classic script and this is the only way all contexts share one copy.
importScripts('messages.js', 'eligibility.js');
const { MSG, KEYS } = self.PERSADO;
const ELIG = self.PERSADO_ELIGIBILITY;

// THE single place the gateway URL is written (scripts/smoke.mjs checks it).
// 127.0.0.1 rather than localhost: `localhost` can resolve to ::1 while the
// gateway binds IPv4 only, and that failure looks identical to it being down.
const GATEWAY_URL = 'http://127.0.0.1:8788';
const INTEGRATIONS_PATH = '/v1/integrations';
// The gateway answers paid calls within ~8 s; anything slower is a fault, not a run.
const RELAY_TIMEOUT_MS = 20000;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

function relay(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

// ─── Toolbar state ───────────────────────────────────────────────
// The mark never changes color; a dimmed icon marks pages the extension cannot read.
const ICONS = { 16: 'public/icon16.png', 32: 'public/icon32.png', 48: 'public/icon48.png', 128: 'public/icon.png' };
const ICONS_DIM = { 16: 'public/icon16-disabled.png', 32: 'public/icon32-disabled.png', 48: 'public/icon48-disabled.png', 128: 'public/icon-disabled.png' };
// Pages where the extension cannot inject a script.
const UNSUPPORTED = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):|^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)|\.pdf(\?|#|$)/i;
let paintedIcon = null;

async function activeTabSupported() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return !!tab?.url && !UNSUPPORTED.test(tab.url);
  } catch { return true; } // can't tell → don't dim
}

async function paintAction() {
  const supported = await activeTabSupported();
  const want = supported ? 'normal' : 'dim';
  try {
    if (paintedIcon !== want) {
      await chrome.action.setIcon({ path: want === 'dim' ? ICONS_DIM : ICONS });
      paintedIcon = want;
    }
    await chrome.action.setTitle({ title: supported ? 'Persado Assist' : 'Persado Assist — not available on this page' });
    await chrome.action.setBadgeText({ text: '' });
  } catch (e) { console.warn('[persado] action paint failed', e); }
}

chrome.tabs.onActivated.addListener(() => paintAction());
chrome.tabs.onUpdated.addListener((_id, ci, tab) => { if (tab.active && (ci.url || ci.status === 'complete')) paintAction(); });
chrome.windows.onFocusChanged.addListener(() => paintAction());
chrome.runtime.onInstalled.addListener(() => paintAction());
chrome.runtime.onStartup.addListener(() => paintAction());
paintAction();

// ═══ Authenticated local integration relay ═══════════════════════
// Provider credentials are read only by gateway/integrations.mjs. A pairing
// token authorizes this browser profile to use the local development gateway.
const OVERLAY_ALLOWED = new Set([MSG.MC_STATUS, MSG.MC_CONTEXT_CHANGED]);
function senderAllowed(msg, sender) {
  if (sender.id !== chrome.runtime.id) return false;
  const own = `chrome-extension://${chrome.runtime.id}/`;
  if (String(sender.url || '').startsWith(own) || sender.origin === own.slice(0, -1)) return true;
  // A runtime message without a tab is from our extension, never a web page.
  if (!sender.tab && !sender.url) return true;
  let host = '';
  try { host = new URL(sender.url || sender.tab?.url || '').hostname; } catch {}
  return OVERLAY_ALLOWED.has(msg.type) && /(^|\.)admin\.mailchimp\.com$/i.test(host);
}
const INTEGRATION_MESSAGES = new Set([
  MSG.PERSADO_TEST, MSG.PERSADO_SCORE, MSG.PERSADO_OPTIMIZE, MSG.USAGE_GET,
  MSG.JOB_STATUS, MSG.JOB_RETRY,
  MSG.MC_TEST, MSG.MC_STATUS, MSG.MC_DRAFTS, MSG.MC_INSIGHTS, MSG.MC_REPORT,
  MSG.MC_SCORE, MSG.MC_OPTIMIZE, MSG.MC_APPLY, MSG.MC_REVERT,
]);
async function integration(msg) {
  const stored = await chrome.storage.local.get([KEYS.PROXY_TOKEN, KEYS.PERSADO_SETTINGS]);
  const token = stored[KEYS.PROXY_TOKEN];
  if (!token) return { ok: false, kind: 'not_paired', error: 'Pair this extension with the local gateway in Settings. Provider keys belong in the gateway environment.' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RELAY_TIMEOUT_MS);
  try {
    const response = await fetch(GATEWAY_URL + INTEGRATIONS_PATH, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'X-Persado-Token': token },
      body: JSON.stringify({ ...msg, settings: stored[KEYS.PERSADO_SETTINGS] || {} }),
    });
    if (response.status === 404) return { ok: false, kind: 'gateway_old', error: 'Restart the Persado gateway with the updated code.' };
    const out = await response.json();
    if (out.ok && (msg.type === MSG.PERSADO_TEST || msg.type === MSG.MC_TEST)) {
      // Remove a legacy browser-stored provider key only after the replacement
      // environment credential has been successfully verified.
      await chrome.storage.local.remove(msg.type === MSG.PERSADO_TEST ? KEYS.API_KEY : KEYS.MC_API_KEY);
    }
    if (out.usage) relay({ type: MSG.USAGE_UPDATED, usage: out.usage });
    return out;
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, kind: 'gateway_timeout', error: 'The local Persado gateway did not answer. Any run it started is kept — check again in a moment.' };
    return { ok: false, kind: 'gateway_down', error: 'Cannot reach the local Persado gateway. Start it with provider credentials and the pairing token.' };
  } finally { clearTimeout(timer); }
}

// ── Billable eligibility gate ──────────────────────────────────────
// THE last word before a Persado run costs credits. The panel also filters, and
// the scanner also excludes, but neither is trusted here: a stored material, a
// retry, a stale payload or a future UI must still not carry consent furniture,
// a language switcher or a card field to the gateway. Mailchimp requests keep
// their platform-specific flow and are not classified by webpage heuristics.
function eligibilityBlock(msg) {
  if (!ELIG) return null;   // module failed to load: never silently unfiltered
  if (msg.type !== MSG.PERSADO_SCORE && msg.type !== MSG.PERSADO_OPTIMIZE) return null;
  const verdict = ELIG.gate({
    text: msg.text, kind: msg.kind, pageUrl: msg.pageUrl,
    eligibility: msg.eligibility, manual: msg.manual === true, batch: msg.batch === true,
  });
  if (verdict.ok) return null;
  return { ...verdict, ok: false, error: verdict.message };
}

const coalesced = new Map();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === MSG.MC_CONTEXT_CHANGED) {
    if (!senderAllowed(msg, sender) || !sender.tab) { sendResponse({ ok: false }); return false; }
    // Only a change hint crosses this boundary. The panel owns debouncing and
    // reads persisted API content; the page never submits copy or paid work.
    relay({ type: MSG.MC_CONTEXT_CHANGED, tabId: sender.tab.id });
    sendResponse({ ok: true });
    return false;
  }
  if (!INTEGRATION_MESSAGES.has(msg?.type)) return false;
  if (!senderAllowed(msg, sender)) { sendResponse({ ok: false, error: 'Not allowed from this context.' }); return false; }
  const blocked = eligibilityBlock(msg);
  if (blocked) { sendResponse(blocked); return false; }
  // Identical reads in flight share one request.
  const key = msg.type === MSG.MC_STATUS ? JSON.stringify([msg.type, msg.webId, msg.campaignId])
    : msg.type === MSG.JOB_STATUS ? JSON.stringify([msg.type, msg.cacheId]) : null;
  let request = key && coalesced.get(key);
  if (!request) {
    request = integration(msg);
    if (key) { coalesced.set(key, request); request.finally(() => coalesced.delete(key)); }
  }
  request.then(sendResponse).catch(() => sendResponse({ ok: false, error: 'The integration request failed.' }));
  return true;
});
