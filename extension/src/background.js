// ─── Language Intelligence Layer — Background Worker ─────────────────────────
//
// Relays messages between content script and sidepanel.
// Transcribes audio via gateway Whisper.
// Captures page context (screenshot + on-page copy) so the model sees the
// actual page instead of inventing copy for a page it has never seen.
// Drives the toolbar icon state system (see claude-design.md §4).

// Classic (non-module) service worker so the shared message/key contract can be
// importScripts'd — content scripts cannot be ES modules, so messages.js has to
// be a classic script and this is the only way all three contexts share one copy.
importScripts('messages.js', 'config.js', 'guard.js', 'persado-api.js', 'usage.js', 'activity.js', 'adapters/mailchimp.js', 'optimizer.js');
const { MSG, KEYS, CTX } = self.PERSADO;
const { GATEWAY_URL, ENDPOINTS, TIMEOUTS, ERR, CAPTURE_SCREENSHOTS: CAPTURE_DEFAULT, DEMO_MODE, DEMO_DELAYS, DEMO_TRANSCRIPT } = self.PERSADO_CONFIG;

/** Current screen-capture setting: the options-page value, else the config default. */
async function captureEnabled() {
  try {
    const v = (await chrome.storage.local.get(KEYS.CAPTURE_SCREENSHOTS))[KEYS.CAPTURE_SCREENSHOTS];
    return typeof v === 'boolean' ? v : CAPTURE_DEFAULT;
  } catch { return CAPTURE_DEFAULT; }
}
// Resolved fresh at each recording start (see capturePageContext) and held for the
// session, so the worker being evicted/restarted mid-flow can't flip it.
let captureSession = CAPTURE_DEFAULT;

// Log the resolved target once, so "which URL is it even calling" is answerable
// from the service-worker console without reading code.
console.log('[persado] gateway →', GATEWAY_URL, DEMO_MODE ? '(DEMO MODE — transcribe/recommend are canned)' : '');
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

function relay(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

/**
 * A failure the UI can explain. `kind` is one of ERR.*; the panel maps it to plain
 * language. A raw "TypeError: Failed to fetch" must never reach a bank marketer.
 */
function gwError(kind, message, extra = {}) {
  return Object.assign(new Error(message), { kind, url: GATEWAY_URL, ...extra });
}

/**
 * fetch with a timeout, translating transport failures into typed errors.
 * A rejected fetch() means the request never arrived — that is categorically
 * different from an HTTP error response, and the two used to be indistinguishable.
 */
async function gwFetch(path, init = {}, timeoutMs = TIMEOUTS.REQUEST_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(GATEWAY_URL + path, { ...init, signal: ac.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw gwError(ERR.TIMEOUT, `No response from the service within ${Math.round(timeoutMs / 1000)}s`);
    // TypeError: Failed to fetch / NetworkError — nothing is listening.
    throw gwError(ERR.UNREACHABLE, `Cannot reach the service at ${GATEWAY_URL}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Cheap preflight so a stopped gateway is reported as such, not as a bug. */
async function gatewayHealth() {
  try {
    const r = await gwFetch(ENDPOINTS.HEALTH, { method: 'GET' }, TIMEOUTS.HEALTH_MS);
    if (!r.ok) return { ok: false, kind: ERR.GATEWAY, url: GATEWAY_URL, error: `Service returned ${r.status}` };
    const body = await r.json().catch(() => ({}));
    return { ok: true, url: GATEWAY_URL, openai: !!body.openai, models: body.models };
  } catch (e) {
    return { ok: false, kind: e.kind || ERR.UNREACHABLE, url: GATEWAY_URL, error: e.message };
  }
}

async function transcribe(dataUrl) {
  const blob = await fetch(dataUrl).then(r => r.blob());   // data: URL, not the network
  if (blob.size < 100) throw gwError('audio_too_short', 'Audio too short — no speech detected');

  // Demo mode stubs THIS CALL ONLY. The recording above is real — it was captured
  // by a real microphone and is a real blob; we simply do not send it anywhere.
  if (DEMO_MODE) {
    console.warn('[persado] DEMO MODE: returning a canned transcript, no network call');
    await new Promise(r => setTimeout(r, DEMO_DELAYS.TRANSCRIBE_MS));
    return DEMO_TRANSCRIPT;
  }

  // Preflight: if the service is not there, say so instead of failing mid-upload
  // with a transport error that reads like a bug.
  const health = await gatewayHealth();
  if (!health.ok) throw gwError(health.kind, health.error);

  const fd = new FormData();
  fd.append('file', blob, 'narration.webm');
  const r = await gwFetch(ENDPOINTS.TRANSCRIBE, { method: 'POST', body: fd });
  if (!r.ok) {
    // Reachable but unhappy — surface the gateway's own message.
    const e = await r.json().catch(() => ({}));
    const msg = e.error || `Transcription failed (${r.status})`;
    if (msg.includes('429') || msg.includes('quota')) throw gwError(ERR.GATEWAY, 'OpenAI quota exceeded');
    if (msg.includes('401')) throw gwError(ERR.GATEWAY, 'API key invalid');
    throw gwError(ERR.GATEWAY, msg);
  }
  return (await r.json()).text || '(no speech detected)';
}

// ─── Pending audio retention ─────────────────────────────────────
//
// A failed transcription must never cost the user their narration. The audio is
// held in session storage (survives a panel close and worker eviction, never
// touches disk) until transcription SUCCEEDS or the user explicitly discards it.
// Exactly one pending recording is kept.

const AUDIO_KEY = KEYS.PENDING_AUDIO;
// chrome.storage.session has a ~10MB quota; stay well clear of it.
const MAX_AUDIO_CHARS = 7_000_000;

async function keepAudio(dataUrl) {
  if (!dataUrl) return { stored: false, reason: 'no audio' };
  if (dataUrl.length > MAX_AUDIO_CHARS) {
    // Do NOT silently drop it — the panel offers a download instead.
    console.warn('[persado] recording too large to retain', dataUrl.length);
    return { stored: false, reason: 'too_large', bytes: dataUrl.length };
  }
  try {
    await store.set({ [AUDIO_KEY]: { audioData: dataUrl, at: Date.now(), bytes: dataUrl.length } });
    return { stored: true, bytes: dataUrl.length };
  } catch (e) {
    console.warn('[persado] could not retain audio', e);
    return { stored: false, reason: 'storage_failed' };
  }
}
async function readAudio() {
  try { return (await store.get(AUDIO_KEY))[AUDIO_KEY] || null; } catch { return null; }
}
async function dropAudio() {
  try { await store.remove(AUDIO_KEY); } catch {}
}

/**
 * One transcription attempt against a retained recording. The audio is kept on
 * failure so Try again re-runs only this step, and cleared on success.
 */
async function runTranscribe(dataUrl) {
  try {
    const text = await transcribe(dataUrl);
    await dropAudio();
    chrome.storage.local.set({ [KEYS.TRANSCRIPT]: text });
    relay({ type: MSG.TRANSCRIPT_READY, transcript: text });
    return { ok: true, transcript: text };
  } catch (err) {
    setSessionState('ready');
    const pending = await readAudio();
    relay({
      type: MSG.TRANSCRIPT_ERROR,
      error: err.message,
      kind: err.kind || ERR.GATEWAY,
      url: err.url || GATEWAY_URL,
      retained: !!pending,           // did we keep the recording?
      at: pending?.at || null,
    });
    return { ok: false, error: err.message, kind: err.kind };
  }
}

// ─── Page context ────────────────────────────────────────────────
//
// Two silent frames per session (recording start + stop) plus the visible copy
// of the page. captureVisibleTab grabs the tab that is already on screen — it
// never opens a tab or window and nothing is drawn over the page.
//
// Everything here is best-effort. Any failure logs and leaves the field absent
// so recording and generation still work from narration alone.

const CTX_KEY = KEYS.PAGE_CONTEXT;
const store = chrome.storage.session || chrome.storage.local;
const MAX_SHOT_WIDTH = 1200;
const SHOT_QUALITY = 0.7;
const THUMB_WIDTH = 120;      // strip thumbnails only; the full frame is kept for the gateway
const SHOT_INTERVAL_MS = 25000;
const MAX_FRAMES = 6;         // bounds session-storage growth

let shotTimer = null;
let shotTarget = null;        // { tabId, windowId } for the periodic capture

async function readCtx() {
  try { return (await store.get(CTX_KEY))[CTX_KEY] || {}; } catch { return {}; }
}
async function writeCtx(patch) {
  try { await store.set({ [CTX_KEY]: { ...(await readCtx()), ...patch } }); } catch (e) { console.warn('[persado] ctx write failed', e); }
}

/**
 * Capture the visible tab once, returning both the full frame (for the gateway)
 * and a small thumbnail (for the panel's strip).
 */
async function captureScreenshot(windowId) {
  const raw = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
  try {
    return { full: await downscale(raw, MAX_SHOT_WIDTH, SHOT_QUALITY), thumb: await downscale(raw, THUMB_WIDTH, 0.6) };
  } catch (e) {
    console.warn('[persado] downscale failed, keeping full frame', e);
    return { full: raw, thumb: raw };
  }
}

// OffscreenCanvas + createImageBitmap work in a service worker; FileReader is
// avoided in favour of manual base64 so this stays SW-safe.
async function downscale(dataUrl, maxWidth, quality) {
  const bmp = await createImageBitmap(await fetch(dataUrl).then(r => r.blob()));
  const scale = Math.min(1, maxWidth / bmp.width);
  const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return 'data:image/jpeg;base64,' + btoa(s);
}

/** Injected on demand into the page. Must be self-contained (it is stringified). */
function extractPageElements() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vw = window.innerWidth, vh = window.innerHeight;

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 8) return false;
    if (r.bottom < 0 || r.top > vh * 3) return false; // ignore far-below-fold noise
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0.05;
  };

  const selectorFor = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el, d = 0; n && n.nodeType === 1 && d < 4; n = n.parentElement, d++) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      let p = n.tagName.toLowerCase();
      const sibs = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : [];
      if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      parts.unshift(p);
    }
    return parts.join(' > ');
  };

  const nearby = (el) => {
    const box = el.closest('section, article, header, main, form, div') || el.parentElement;
    if (!box) return '';
    const own = clean(el.innerText || el.textContent);
    return clean(clean(box.innerText).slice(0, 500).replace(own, ' ')).slice(0, 240);
  };

  const cands = [];
  const add = (el, type, bonus) => {
    if (!el || el.nodeType !== 1 || !visible(el)) return;
    const text = clean(el.tagName === 'INPUT'
      ? (el.value || el.getAttribute('aria-label'))
      : (el.innerText || el.textContent));
    if (!text || text.length < 2 || text.length > 200) return;
    const r = el.getBoundingClientRect();
    const onScreen = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
                   * Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const fs = parseFloat(getComputedStyle(el).fontSize) || 12;
    cands.push({
      type, text, selector: selectorFor(el), context: nearby(el),
      score: bonus + fs * 3 + onScreen / 500 + (r.top < vh ? 400 : 0),
    });
  };

  [...document.querySelectorAll('h1')].slice(0, 4).forEach(el => add(el, 'headline', 500));
  [...document.querySelectorAll('h2, [role="heading"]')].slice(0, 6).forEach(el => add(el, 'headline', 250));
  [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], a[class*="btn"], a[class*="Btn"], a[class*="cta"], a[class*="Cta"], a[class*="button"], a[class*="Button"]')]
    .slice(0, 12).forEach(el => add(el, 'cta', 300));

  const PROMO = /(\d+(\.\d+)?\s*%|\bAPY\b|\bAPR\b|\$\s?\d|no (monthly )?fee|fee-free|\bfree\b|\bsave\b|\bbonus\b|\boffer\b|limited time|cash ?back)/i;
  const TRUST = /(\bFDIC\b|insured|\bmember\b|secure|encrypt|trusted|award|rated|since \d{4}|guarantee|no credit check|\d[\d,]*\+?\s*(customers|members|users|reviews))/i;
  document.querySelectorAll('p, span, div, li, small, strong, em, h3, h4').forEach(el => {
    if (cands.length > 60) return;
    const t = clean(el.innerText || el.textContent);
    if (!t || t.length < 6 || t.length > 140) return;
    if (el.querySelector('p, span, div, li, h1, h2, h3, h4, button, a')) return; // leaf-ish only
    if (PROMO.test(t)) add(el, 'promo', 120);
    else if (TRUST.test(t)) add(el, 'trust', 100);
  });

  const seen = new Set();
  return cands
    .sort((a, b) => b.score - a.score)
    .filter(c => { const k = c.text.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 8)
    .map(({ score, ...c }) => c);
}

/**
 * Append one frame to the session, capped at MAX_FRAMES. frames[0] is always the
 * start frame — it is the one paired with the extracted element text and the one
 * sent to the gateway — so the cap drops the OLDEST MIDDLE frame, never index 0.
 */
async function addFrame(windowId) {
  const shot = await captureScreenshot(windowId);
  const ctx = await readCtx();
  const frames = Array.isArray(ctx[CTX.FRAMES]) ? ctx[CTX.FRAMES].slice() : [];
  frames.push(shot);
  if (frames.length > MAX_FRAMES) frames.splice(1, frames.length - MAX_FRAMES);
  await writeCtx({ [CTX.FRAMES]: frames });
  relay({ type: MSG.SHOTS_UPDATED, thumbs: frames.map(f => f.thumb), count: frames.length });
  return frames.length;
}

function stopShotTimer() {
  if (shotTimer) { clearInterval(shotTimer); shotTimer = null; }
}

/** Periodic capture so the count grows visibly during a long brief. */
function startShotTimer() {
  stopShotTimer();
  shotTimer = setInterval(() => {
    if (!shotTarget) return;
    addFrame(shotTarget.windowId).catch(e => console.warn('[persado] periodic capture skipped', e));
  }, SHOT_INTERVAL_MS);
}

/** Inject the extractor and store the result. The PRIMARY grounding path — runs
 *  in both capture modes. Returns the number of elements extracted. */
async function extractElements(tabId) {
  if (!tabId) return 0;
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: extractPageElements });
    const els = r?.[0]?.result;
    if (Array.isArray(els) && els.length) { await writeCtx({ [CTX.ELEMENTS]: els }); return els.length; }
  } catch (e) { console.warn('[persado] element extraction failed', e); }
  return 0;
}

/**
 * phase 'start'  → reset, extract page copy, (capture frame 0, begin interval*)
 * phase 'stop'   → (capture the final frame, end interval*)
 * phase 'pause'  → (suspend the interval*)
 * phase 'resume' → (resume the interval*)
 *
 * *Screenshots are gated on CAPTURE_SCREENSHOTS (default OFF, see config.js). When
 * OFF, captureVisibleTab is never called, no timer runs, and no frames are written
 * — only the DOM extraction runs. When ON, behaviour is exactly as before.
 */
async function capturePageContext({ phase, tabId, windowId }) {
  // Read the toggle at the moment recording STARTS (not at worker startup, which
  // may be arbitrarily stale) and hold it for the session; a mid-recording change
  // is intentionally ignored.
  if (phase === 'start') captureSession = await captureEnabled();
  const CAPTURE_SCREENSHOTS = captureSession;
  if (!CAPTURE_SCREENSHOTS) {
    // Screenshots opt-in and off: no pixels captured, no timer. Extraction only.
    if (phase === 'start') {
      await writeCtx({ [CTX.FRAMES]: [], [CTX.ELEMENTS]: null, [CTX.CAPTURED_AT]: Date.now() });
      const elements = await extractElements(tabId);
      return { ok: true, capture: false, frames: 0, elements };
    }
    return { ok: true, capture: false };   // pause/resume/stop are no-ops
  }

  if (phase === 'pause') { stopShotTimer(); return { ok: true, paused: true }; }
  if (phase === 'resume') { shotTarget = { tabId, windowId }; startShotTimer(); return { ok: true }; }

  if (phase === 'start') {
    await writeCtx({ [CTX.FRAMES]: [], [CTX.ELEMENTS]: null, [CTX.CAPTURED_AT]: Date.now() });
    shotTarget = { tabId, windowId };
  }

  const results = await Promise.allSettled([
    addFrame(windowId),
    phase === 'start' ? extractElements(tabId) : Promise.resolve(0),
  ]);
  if (results[0].status === 'rejected') console.warn('[persado] screenshot capture failed', results[0].reason);

  if (phase === 'start') startShotTimer(); else stopShotTimer();
  const ctx = await readCtx();
  return { ok: true, capture: true, frames: ctx[CTX.FRAMES]?.length || 0, elements: ctx[CTX.ELEMENTS]?.length || 0 };
}

// ─── Toolbar state (claude-design.md §4) ─────────────────────────
//
// The mark NEVER changes color — state is carried only by the corner badge,
// plus a dimmed icon for Disabled. Everything routes through setSessionState()
// so there are no scattered setBadgeText calls.
//
// On the pulsing recording dot: the design doc allows a steady red badge as a
// fallback, and that is what we ship. Animating via setIcon on a timer needs the
// service worker alive for the whole recording — MV3 evicts it after ~30s idle,
// which would freeze the icon on whichever frame happened to be last, sometimes
// the "off" one. A steady dot that is always correct beats a pulse that lies.

const STATE_KEY = KEYS.ACTION_STATE;
const ICONS = { 16: 'public/icon16.png', 32: 'public/icon32.png', 48: 'public/icon48.png', 128: 'public/icon.png' };
const ICONS_DIM = { 16: 'public/icon16-disabled.png', 32: 'public/icon32-disabled.png', 48: 'public/icon48-disabled.png', 128: 'public/icon-disabled.png' };
const RED = '#DC2828', AMBER = '#F59E0B', GREEN = '#10B981';

// Pages where the extension cannot inject a content script or capture a tab.
const UNSUPPORTED = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):|^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)|\.pdf(\?|#|$)/i;

let paintedIcon = null; // avoid redundant setIcon calls on every tab switch

async function activeTabSupported() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return !!tab?.url && !UNSUPPORTED.test(tab.url);
  } catch { return true; } // can't tell → don't dim
}

/** Persist the session state, then repaint against the current tab. */
async function setSessionState(state, count = 0) {
  try { await store.set({ [STATE_KEY]: { state, count } }); } catch {}
  await paintAction();
}

/** Disabled is derived from the active tab; everything else from session state. */
async function paintAction() {
  let visual = { state: 'ready', count: 0 };
  if (!(await activeTabSupported())) {
    visual = { state: 'disabled', count: 0 };
  } else {
    try { visual = (await store.get(STATE_KEY))[STATE_KEY] || visual; } catch {}
  }
  const { state, count } = visual;

  // Badge text is ' ' (not '') for a badge with no numeral: non-empty text is
  // what makes Chrome draw the pill, and a space renders as a plain colored dot.
  const badge = {
    ready:     { text: '', color: null, title: 'Persado — ready' },
    recording: { text: ' ', color: RED, title: 'Persado — recording' },
    working:   { text: '…', color: AMBER, title: 'Persado — working' },
    results:   {
      // The numeral only goes in when it fits legibly; otherwise a plain dot.
      text: count > 0 && count <= 99 ? String(count) : ' ',
      color: GREEN,
      title: `Persado — ${count} variant${count === 1 ? '' : 's'} ready`,
    },
    disabled:  { text: '', color: null, title: 'Persado — not available on this page' },
  }[state] || { text: '', color: null, title: 'Persado — ready' };

  const wantIcon = state === 'disabled' ? 'dim' : 'normal';
  try {
    if (paintedIcon !== wantIcon) {
      await chrome.action.setIcon({ path: wantIcon === 'dim' ? ICONS_DIM : ICONS });
      paintedIcon = wantIcon;
    }
    await chrome.action.setTitle({ title: badge.title });
    await chrome.action.setBadgeText({ text: badge.text });
    if (badge.color) {
      await chrome.action.setBadgeBackgroundColor({ color: badge.color });
      // Match the text color to the fill so a numeral-less badge reads as a
      // solid dot rather than a pill with a faint glyph in it.
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: badge.text.trim() ? '#FFFFFF' : badge.color });
      }
    }
  } catch (e) { console.warn('[persado] action paint failed', e); }
}

chrome.tabs.onActivated.addListener(() => paintAction());
chrome.tabs.onUpdated.addListener((_id, ci, tab) => { if (tab.active && (ci.url || ci.status === 'complete')) paintAction(); });
chrome.windows.onFocusChanged.addListener(() => paintAction());
chrome.runtime.onInstalled.addListener(() => setSessionState('ready'));
chrome.runtime.onStartup.addListener(() => setSessionState('ready'));
paintAction(); // also runs whenever the worker wakes, so the toolbar never goes stale

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Relay content script events to sidepanel
  if (msg.type === MSG.RECORDING_STARTED) { setSessionState('recording'); relay(msg); return false; }
  if (msg.type === MSG.LIVE_TRANSCRIPT) { relay(msg); return false; }
  if (msg.type === MSG.AUDIO_LEVELS) { relay(msg); return false; }
  if (msg.type === MSG.CONTENT_ERROR) { console.warn('[persado] content script error', msg.error); relay(msg); return false; }

  // The panel owns the generate step, so it reports results/reset back to us.
  if (msg.type === MSG.SET_ACTION_STATE) { setSessionState(msg.state, msg.count || 0); return false; }

  // Transcribe audio from sidepanel (or content script)
  if (msg.type === MSG.TRANSCRIBE_AUDIO && msg.audioData) {
    setSessionState('working');
    // Retain FIRST, attempt second: if anything below throws, the recording is
    // already safe. This ordering is the whole point.
    keepAudio(msg.audioData)
      .then(kept => runTranscribe(msg.audioData).then(r => sendResponse({ ...r, kept })))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Try again — re-runs only the failed step, against the retained recording.
  if (msg.type === MSG.RETRY_TRANSCRIBE) {
    setSessionState('working');
    readAudio()
      .then(p => p?.audioData
        ? runTranscribe(p.audioData)
        : { ok: false, error: 'The recording is no longer available.', kind: 'no_pending_audio' })
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Resume offer + the download escape hatch both read through this.
  if (msg.type === MSG.GET_PENDING_AUDIO) {
    readAudio().then(p => sendResponse(p ? { ok: true, at: p.at, bytes: p.bytes, audioData: p.audioData } : { ok: false }));
    return true;
  }
  if (msg.type === MSG.DISCARD_PENDING_AUDIO) {
    dropAudio().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === MSG.GATEWAY_HEALTH) {
    gatewayHealth().then(sendResponse);
    return true;
  }

  // Page context — never throws back to the caller; a miss just means no grounding.
  if (msg.type === MSG.CAPTURE_PAGE_CONTEXT) {
    capturePageContext(msg)
      .then(sendResponse)
      .catch(err => { console.warn('[persado] page context failed', err); sendResponse({ ok: false, error: err.message }); });
    return true;
  }
  if (msg.type === MSG.GET_PAGE_CONTEXT) { readCtx().then(sendResponse); return true; }
  if (msg.type === MSG.CLEAR_PAGE_CONTEXT) {
    stopShotTimer(); shotTarget = null;
    store.remove(CTX_KEY).catch(() => {}).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});


// ═══ Persado Autopilot ═══════════════════════════════════════════
//
// The service worker is the ONLY context that reads the Persado and Mailchimp
// keys. The side panel and the Mailchimp overlay send copy or a campaign id in
// and get results out; no response below ever contains a key, and nothing here
// logs one. Calls go straight from the worker to api.persado.com and
// <dc>.api.mailchimp.com over HTTPS (manifest host_permissions) — there is no
// proxy in between, so the keys never touch the local gateway either.

const API = self.PERSADO_API;
const MC = self.PERSADO_ADAPTERS.mailchimp;
const local = chrome.storage.local;
const usageStore = self.PERSADO_USAGE.makeStore({ storageKey: KEYS.USAGE, quota: API.RUN_QUOTA, storage: local });
const activity = self.PERSADO_ACTIVITY.makeLog({ storageKey: KEYS.ACTIVITY, storage: local });

async function readLocal(key, dflt = null) {
  try { const v = (await local.get(key))[key]; return v === undefined ? dflt : v; } catch { return dflt; }
}
async function persadoKey() { return (await readLocal(KEYS.API_KEY, '')) || ''; }
async function persadoSettings() { return { brand: '', industry: '', ...(await readLocal(KEYS.PERSADO_SETTINGS, {})) }; }
async function mcSettings() { return { serverPrefix: '', allowBodyOnBuilder: false, testEmails: '', ...(await readLocal(KEYS.MC_SETTINGS, {})) }; }

async function currentFingerprint() { return self.PERSADO_USAGE.fingerprint(await persadoKey()); }

/** Usage snapshot for the UI, with the provenance of every number. */
async function usageView() {
  const key = await persadoKey();
  const fp = await self.PERSADO_USAGE.fingerprint(key);
  const s = await usageStore.get(fp);
  return { hasKey: !!key, ...s, costs: API.COSTS, costSource: API.COST_SOURCE };
}

async function recordUsage(ev) {
  const fp = await currentFingerprint();
  const s = await usageStore.record(fp, { at: Date.now(), ...ev });
  const view = { hasKey: true, ...s, costs: API.COSTS, costSource: API.COST_SOURCE };
  broadcast({ type: MSG.USAGE_UPDATED, usage: view });
  return view;
}

/** To the panel (runtime) and to any open Mailchimp tab (overlay). */
function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
  chrome.tabs.query({ url: 'https://*.admin.mailchimp.com/*' })
    .then(tabs => tabs.forEach(t => chrome.tabs.sendMessage(t.id, msg).catch(() => {})))
    .catch(() => {});
}

/** Plain-language text for any failure; Persado's own kinds get Persado's wording. */
function explain(e) { return e instanceof API.PersadoError ? API.describeError(e) : (e?.message || String(e)); }
function errOut(e) {
  return { ok: false, kind: e?.kind || 'error', error: explain(e), requestId: e?.requestId || null, jobId: e?.jobId || null };
}

// ── Persado: connection, score, optimize (website flow) ──────────

async function persadoTest() {
  const key = await persadoKey();
  try {
    const r = await API.testConnection({ key });
    await recordUsage({ type: 'connection', ok: true, message: 'Connected', usageHeaders: r.usageHeaders });
    return { ok: true, channels: r.channels, limits: r.limits, usage: await usageView() };
  } catch (e) {
    if (key) await recordUsage({ type: 'connection', ok: false, kind: e.kind, message: API.describeError(e), usageHeaders: e.usageHeaders });
    return { ...errOut(e), usage: await usageView() };
  }
}

/** Brand sent as account.name: Settings value, else what the caller derived. */
async function accountFor(fallbackName) {
  const s = await persadoSettings();
  return { accountName: (s.brand || fallbackName || '').trim(), industry: s.industry || undefined };
}

const WEB_TOUCHPOINT = { cta: 'cta', headline: 'headline', body: 'body' };

async function persadoWeb(op, msg) {
  const key = await persadoKey();
  const touchpoint = WEB_TOUCHPOINT[msg.kind] || 'headline';
  const account = await accountFor(msg.brand);
  const base = { platform: 'web', pageUrl: msg.pageUrl || null };
  const cost = API.COSTS[op];
  try {
    if (!account.accountName) throw new API.PersadoError(API.KIND.INVALID_REQUEST, 'Persado needs a brand name. Add it in Settings.');
    const common = { key, channel: 'WEB_PAGE', ...account };
    const out = op === 'score'
      ? await API.score({ ...common, variants: [{ [touchpoint]: msg.text }] })
      : await API.optimize({ ...common, variant: { [touchpoint]: msg.text },
          alwaysUse: self.PERSADO_GUARD.protectedTokens(msg.text).filter(t => t.length <= API.LIMITS.MAX_ALWAYS_USE_LENGTH).slice(0, API.LIMITS.MAX_ALWAYS_USE),
          context: msg.context ? String(msg.context).slice(0, 2000) : undefined });
    const r = out.result;
    await recordUsage({ type: 'run', op, ok: true, cost, usageHeaders: out.usageHeaders });
    const scored = op === 'score' ? r.variants[0] : r.control;
    const top = r.alternatives[0] || null;
    await activity.add({ ...base, action: op, status: op === 'optimize' && !top ? 'no_change' : 'ok', source: r.source,
      persado: { jobId: r.jobId, requestId: r.requestId, kind: op, channel: 'WEB_PAGE', controlPerformance: scored?.performance ?? null,
        chosenPerformance: top?.performance ?? null, chosenRank: top?.rank ?? null, notice: r.notice },
      changes: op === 'optimize' && top ? [{ field: touchpoint, touchpoint, original: msg.text, optimized: top.touchpoints[touchpoint] || top.text, applied: false }] : [],
      message: op === 'score' ? 'Scored on the page' : top ? 'Optimized on the page (preview only)' : (r.notice?.message || 'No alternatives returned') });
    return { ok: true, touchpoint, result: r, usage: await usageView() };
  } catch (e) {
    await recordUsage({ type: 'run', op, ok: false, error: { kind: e.kind, message: e.message }, charged: !!e.jobId, cost, usageHeaders: e.usageHeaders });
    await activity.add({ ...base, action: op, status: 'failed', error: { kind: e.kind, message: API.describeError(e) },
      persado: { jobId: e.jobId || null, requestId: e.requestId || null, kind: op, channel: 'WEB_PAGE' } });
    return { ...errOut(e), usage: await usageView() };
  }
}

// ── Mailchimp ────────────────────────────────────────────────────

async function mcAdapter() {
  const key = await readLocal(KEYS.MC_API_KEY, '');
  const s = await mcSettings();
  return MC.create({ apiKey: key, serverPrefix: s.serverPrefix, allowBodyOnBuilder: !!s.allowBodyOnBuilder });
}

async function mcTest() {
  try {
    const a = await mcAdapter();
    const r = await a.test();
    const s = await mcSettings();
    await local.set({ [KEYS.MC_SETTINGS]: { ...s, accountName: r.accountName, dc: r.dc, connectedAt: Date.now(), lastError: null } });
    await activity.add({ platform: 'mailchimp', action: 'connect', status: 'ok', message: `Connected to ${r.accountName || 'Mailchimp'} (${r.dc})` });
    return { ok: true, accountName: r.accountName, dc: r.dc };
  } catch (e) {
    const s = await mcSettings();
    await local.set({ [KEYS.MC_SETTINGS]: { ...s, connectedAt: null, lastError: e.message } });
    return errOut(e);
  }
}

async function mcDisconnect() {
  await local.remove([KEYS.MC_API_KEY]);
  const s = await mcSettings();
  await local.set({ [KEYS.MC_SETTINGS]: { ...s, accountName: '', dc: '', connectedAt: null, lastError: null } });
  await activity.add({ platform: 'mailchimp', action: 'connect', status: 'ok', message: 'Disconnected; the Mailchimp key was removed from this browser' });
  return { ok: true };
}

async function snapshots() { return readLocal(KEYS.MC_SNAPSHOTS, {}); }
async function saveSnapshot(id, snap) {
  const all = await snapshots();
  all[id] = snap;
  // Keep the 20 most recent campaigns.
  const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 20);
  await local.set({ [KEYS.MC_SNAPSHOTS]: Object.fromEntries(keep) });
}

/** What the panel and overlay need to draw a campaign's state. Starts no run. */
async function mcStatus(msg) {
  const key = await readLocal(KEYS.MC_API_KEY, '');
  const s = await mcSettings();
  const out = { ok: true, connected: !!(key && s.connectedAt), accountName: s.accountName || '', persadoKey: !!(await persadoKey()),
    busy: [...mcBusy], usage: await usageView() };
  if (!out.connected || !msg.webId) return out;
  try {
    const a = await mcAdapter();
    const c = await a.findByWebId(msg.webId);
    out.campaign = c;
    if (c) {
      const snap = (await snapshots())[c.id];
      out.optimizedAt = snap?.appliedAt || null;
      out.canRevert = !!snap;
      out.activity = await activity.list({ platform: 'mailchimp', campaignId: c.id, limit: 5 });
    }
  } catch (e) { out.campaignError = errOut(e).error; }
  return out;
}

const mcBusy = new Set();

async function mcOptimize(msg, tabId) {
  const s = await persadoSettings();
  const ms = await mcSettings();
  let id = msg.campaignId;
  const progress = (step, label) => {
    const m = { type: MSG.AUTOPILOT_PROGRESS, platform: 'mailchimp', campaignId: id, step, label };
    broadcast(m);
  };
  try {
    const adapter = await mcAdapter();
    if (!id && msg.webId) id = (await adapter.findByWebId(msg.webId))?.id;
    if (!id) throw new MC.MailchimpError('not_found', 'This campaign is not a draft in the connected Mailchimp account.');
    if (mcBusy.has(id)) return { ok: false, kind: 'busy', error: 'This draft is already being optimized.' };
    const key = await persadoKey();
    if (!key) throw new API.PersadoError(API.KIND.NO_KEY, 'No Persado API key');
    // Duplicate protection: an untouched, already-optimized draft is not re-run
    // (it would spend 5 runs to rewrite Persado's own copy) unless asked.
    const snap = (await snapshots())[id];
    if (snap?.appliedFingerprint && !msg.force) {
      const now = await adapter.read(id).catch(() => null);
      if (now && now.fingerprint === snap.appliedFingerprint) {
        return { ok: false, kind: 'already_optimized', error: 'This draft is already optimized and has not changed since. Revert it, or run again anyway.' };
      }
    }
    mcBusy.add(id);
    setSessionState('working');
    const result = await self.PERSADO_OPTIMIZER.optimizeDraft({ id }, {
      adapter, persadoKey: key,
      account: { accountName: (s.brand || ms.accountName || '').trim(), industry: s.industry || undefined },
      onStep: progress,
      usage: recordUsage,
      log: (e) => activity.add(e),
      snapshot: (draft, accepted) => saveSnapshot(draft.ref.id, {
        id: draft.ref.id, webId: draft.ref.webId, at: Date.now(), settings: { subject_line: draft.settings.subject_line, preview_text: draft.settings.preview_text },
        html: draft.html, bodyWritten: accepted.some(c => c.location === 'html'), appliedFingerprint: null, appliedAt: null }),
    });
    if (result.status === 'ok' || result.status === 'partial' || result.status === 'unverified') {
      const after = await adapter.read(id).catch(() => null);
      const all = await snapshots();
      if (all[id]) { all[id].appliedFingerprint = after?.fingerprint || null; all[id].appliedAt = Date.now(); await local.set({ [KEYS.MC_SNAPSHOTS]: all }); }
    }
    setSessionState('ready');
    return { ok: true, ...result, usage: await usageView() };
  } catch (e) {
    setSessionState('ready');
    progress('error', explain(e));
    if (!(e instanceof API.PersadoError)) await activity.add({ platform: 'mailchimp', action: 'optimize', status: 'failed', campaignId: id || null, error: { kind: e.kind, message: e.message } });
    return { ...errOut(e), usage: await usageView() };
  } finally {
    if (id) mcBusy.delete(id);
  }
}

async function mcRevert(msg) {
  const id = msg.campaignId;
  const snap = (await snapshots())[id];
  if (!snap) return { ok: false, error: 'There is no saved original for this campaign.' };
  try {
    const a = await mcAdapter();
    await a.restore(snap);
    const all = await snapshots(); delete all[id]; await local.set({ [KEYS.MC_SNAPSHOTS]: all });
    await activity.add({ platform: 'mailchimp', action: 'revert', status: 'ok', campaignId: id, campaignWebId: snap.webId,
      message: 'Restored the subject line, preview text' + (snap.bodyWritten ? ' and body' : '') + ' saved before optimization' });
    broadcast({ type: MSG.AUTOPILOT_PROGRESS, platform: 'mailchimp', campaignId: id, step: 'reverted', label: 'Original restored' });
    return { ok: true };
  } catch (e) {
    await activity.add({ platform: 'mailchimp', action: 'revert', status: 'failed', campaignId: id, error: { kind: e.kind, message: e.message } });
    return errOut(e);
  }
}

async function mcTestSend(msg) {
  try {
    const a = await mcAdapter();
    const s = await mcSettings();
    const r = await a.sendTest(msg.campaignId, String(s.testEmails || '').split(/[,\s]+/));
    await activity.add({ platform: 'mailchimp', action: 'test_send', status: 'ok', campaignId: msg.campaignId, message: `Mailchimp test e-mail sent to ${r.sentTo.length} address(es)` });
    return { ok: true, sentTo: r.sentTo.length };
  } catch (e) {
    await activity.add({ platform: 'mailchimp', action: 'test_send', status: 'failed', campaignId: msg.campaignId, error: { kind: e.kind, message: e.message } });
    return errOut(e);
  }
}

// The Mailchimp overlay is a content script: it may ask for status (which
// carries the campaign's activity), optimize and revert — and only from a Mailchimp admin page. Every
// other message here is panel-only.
const OVERLAY_ALLOWED = new Set([MSG.MC_STATUS, MSG.MC_OPTIMIZE, MSG.MC_REVERT]);
function senderAllowed(msg, sender) {
  if (sender.id !== chrome.runtime.id) return false;
  // Our own pages (side panel, options — even when opened in a tab) are trusted.
  // Content scripts report the PAGE's URL, so they never match this origin.
  const own = `chrome-extension://${chrome.runtime.id}/`;
  if (!sender.tab || String(sender.url || '').startsWith(own) || sender.origin === own.slice(0, -1)) return true;
  let host = '';
  try { host = new URL(sender.url || sender.tab.url || '').hostname; } catch {}
  return OVERLAY_ALLOWED.has(msg.type) && /(^|\.)admin\.mailchimp\.com$/i.test(host);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    [MSG.PERSADO_TEST]: () => persadoTest(),
    [MSG.PERSADO_SCORE]: () => persadoWeb('score', msg),
    [MSG.PERSADO_OPTIMIZE]: () => persadoWeb('optimize', msg),
    [MSG.USAGE_GET]: () => usageView(),
    [MSG.USAGE_RESET]: async () => { await usageStore.reset(await currentFingerprint()); const u = await usageView(); broadcast({ type: MSG.USAGE_UPDATED, usage: u }); return u; },
    [MSG.MC_TEST]: () => mcTest(),
    [MSG.MC_DISCONNECT]: () => mcDisconnect(),
    [MSG.MC_STATUS]: () => mcStatus(msg),
    [MSG.MC_DRAFTS]: async () => { try { return { ok: true, drafts: await (await mcAdapter()).listDrafts(25) }; } catch (e) { return errOut(e); } },
    [MSG.MC_OPTIMIZE]: () => mcOptimize(msg, sender.tab?.id),
    [MSG.MC_REVERT]: () => mcRevert(msg),
    [MSG.MC_TEST_SEND]: () => mcTestSend(msg),
  };
  const h = handlers[msg?.type];
  if (!h) return false;
  if (!senderAllowed(msg, sender)) { sendResponse({ ok: false, error: 'Not allowed from this context.' }); return false; }
  Promise.resolve().then(h).then(sendResponse).catch(e => sendResponse(errOut(e)));
  return true;
});
