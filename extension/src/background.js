// ─── Persado Demo — Background Worker ────────────────────────────
//
// Relays messages between content script and sidepanel.
// Transcribes audio via gateway Whisper.
// Captures page context (screenshot + on-page copy) so the model sees the
// actual page instead of inventing copy for a page it has never seen.
// Drives the toolbar icon state system (see claude-design.md §4).

// Classic (non-module) service worker so the shared message/key contract can be
// importScripts'd — content scripts cannot be ES modules, so messages.js has to
// be a classic script and this is the only way all three contexts share one copy.
importScripts('messages.js', 'config.js');
const { MSG, KEYS, CTX } = self.PERSADO;
const { GATEWAY_URL, ENDPOINTS, TIMEOUTS, ERR } = self.PERSADO_CONFIG;

// Log the resolved target once, so "which URL is it even calling" is answerable
// from the service-worker console without reading code.
console.log('[persado] gateway →', GATEWAY_URL);
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

/**
 * phase 'start'  → reset, extract page copy, capture frame 0, begin the interval
 * phase 'stop'   → capture the final frame, end the interval
 * phase 'pause'  → suspend the interval (no frames while paused)
 * phase 'resume' → resume the interval
 */
async function capturePageContext({ phase, tabId, windowId }) {
  if (phase === 'pause') { stopShotTimer(); return { ok: true, paused: true }; }
  if (phase === 'resume') { shotTarget = { tabId, windowId }; startShotTimer(); return { ok: true }; }

  if (phase === 'start') {
    await writeCtx({ [CTX.FRAMES]: [], [CTX.ELEMENTS]: null, [CTX.CAPTURED_AT]: Date.now() });
    shotTarget = { tabId, windowId };
  }

  const results = await Promise.allSettled([
    addFrame(windowId),
    phase === 'start' && tabId
      ? chrome.scripting.executeScript({ target: { tabId }, func: extractPageElements })
      : Promise.resolve(null),
  ]);

  if (results[0].status === 'rejected') console.warn('[persado] screenshot capture failed', results[0].reason);
  if (results[1].status === 'fulfilled' && results[1].value) {
    const els = results[1].value?.[0]?.result;
    if (Array.isArray(els) && els.length) await writeCtx({ [CTX.ELEMENTS]: els });
  } else if (results[1].status === 'rejected') {
    console.warn('[persado] element extraction failed', results[1].reason);
  }

  if (phase === 'start') startShotTimer(); else stopShotTimer();
  const ctx = await readCtx();
  return { ok: true, frames: ctx[CTX.FRAMES]?.length || 0, elements: ctx[CTX.ELEMENTS]?.length || 0 };
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
