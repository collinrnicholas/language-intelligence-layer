import type {
  LoupeSession,
  MessageFromContent,
  MessageToContent,
  RecordingSession,
  TargetCapture,
} from './types';
import { sessionNowMsFrom, startSessionClock } from './session-time';
import { runDesktopCaptureFlow } from './target-capture.mjs';

/** Cap the long edge of a captured target so a 4K/5K grab never bloats the .loupe. */
const MAX_TARGET_LONG_EDGE = 2560;

// ─── Durable Storage Keys ──────────────────────────────────────
//
// MV3 service workers are evicted after ~30s idle. The in-progress recording is
// therefore mirrored to chrome.storage.local continuously so it survives an
// eviction (we rehydrate on wake) and a browser restart (we surface it for
// recovery instead of losing it). Completed sessions are keyed by id so a new
// recording can never overwrite an unexported one.
const ACTIVE_KEY = 'loupe:active';
const INTERRUPTED_KEY = 'loupe:interrupted';
const SESSION_KEY = (id: string) => `loupe:session:${id}`;
const SESSION_INDEX_KEY = 'loupe:sessionIndex';
const HEARTBEAT_ALARM = 'loupe-heartbeat';
const SCREENSHOT_MS = 2000;

interface SessionSummary {
  id: string;
  project: string;
  flow: string;
  timestamp: number;
  filename: string;
}

// ─── State ─────────────────────────────────────────────────────

let session: RecordingSession | null = null;
let activeTabId: number | null = null;
let screenshotInterval: ReturnType<typeof setInterval> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
// Memoized in-flight rehydration so concurrent cold-wake events share one load.
let hydrationPromise: Promise<void> | null = null;

// Screenshot JPEG quality — set in popup Settings ('standard' | 'high'), read
// from extension storage at recording start (popup localStorage is invisible
// to a service worker). Applies from the next recording, never mid-session.
let screenshotQuality = 85;

async function refreshScreenshotQuality(): Promise<void> {
  try {
    const r = await chrome.storage.local.get('loupe:settings');
    const q = (r['loupe:settings'] as { screenshotQuality?: string } | undefined)?.screenshotQuality;
    screenshotQuality = q === 'high' ? 95 : 85;
  } catch { /* keep current value */ }
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Durability helpers ────────────────────────────────────────

/** Debounced full-session mirror to storage (coalesces bursts of events). */
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistActive();
  }, SCREENSHOT_MS);
}

async function persistActive(): Promise<void> {
  if (!session) return;
  try {
    await chrome.storage.local.set({ [ACTIVE_KEY]: session });
  } catch (e) {
    console.error('[Loupe] Failed to persist active session:', e);
  }
}

async function clearActive(): Promise<void> {
  try {
    await chrome.storage.local.remove([ACTIVE_KEY, INTERRUPTED_KEY]);
  } catch { /* best effort */ }
}

/**
 * Guarantee `session` reflects persisted state BEFORE any caller inspects it.
 *
 * This is the fix for the rehydration race: every message/alarm handler awaits
 * this before checking `session?.state`, so a cold-woken worker can never
 * early-return and silently drop the very event that woke it.
 *
 * - Already in memory → resolves immediately (no storage hit).
 * - Load already in flight → returns the SAME promise; concurrent cold-wake
 *   events all await one load (no double-read, no second race).
 * - A non-interrupted in-progress session is rehydrated AND capture is re-armed,
 *   so recording continues without the popup. An interrupted session (browser
 *   restart) is left in storage for the explicit recovery flow.
 */
function ensureHydrated(): Promise<void> {
  if (session) return Promise.resolve();
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    try {
      const r = await chrome.storage.local.get([ACTIVE_KEY, INTERRUPTED_KEY]);
      if (session) return; // set by another path while we awaited storage
      const saved = r[ACTIVE_KEY] as RecordingSession | undefined;
      const interrupted = r[INTERRUPTED_KEY] as boolean | undefined;
      if (!saved || interrupted) return; // nothing to resume / held for recovery
      session = saved;
      startSessionClock(session.startTime);
      if (session.state === 'recording') {
        chrome.action.setBadgeText({ text: '●' });
        chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
        ensureCaptureRunning();
        console.log('[Loupe] Rehydrated in-progress recording on worker wake');
      }
    } finally {
      hydrationPromise = null;
    }
  })();
  return hydrationPromise;
}

// A fresh browser launch interrupts any in-progress recording: flag it so we
// recover (user choice) rather than silently resuming stale capture.
chrome.runtime.onStartup.addListener(async () => {
  try {
    const r = await chrome.storage.local.get(ACTIVE_KEY);
    if (r[ACTIVE_KEY]) await chrome.storage.local.set({ [INTERRUPTED_KEY]: true });
  } catch { /* ignore */ }
});

// On every worker startup, rehydrate (and re-arm capture) if a recording was live.
void ensureHydrated();

// ─── Screenshot capture (alarm-backed, survives eviction) ──────

async function captureScreenshot(): Promise<void> {
  if (!activeTabId || session?.state !== 'recording') return;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: screenshotQuality });
    if (session?.state === 'recording') {
      session.screenshots.push({ timestamp: sessionNowMsFrom(session.startTime), dataUrl });
      schedulePersist();
    }
  } catch (err) {
    // tab not capturable (e.g. chrome:// page) — skip this tick
  }
}

// ─── Desktop / other-app target capture ─────────────────────────
//
// captureVisibleTab only sees Chrome tabs. To capture a target design in a
// separate app (Figma desktop, Safari, any window/screen) we: (1) let the user
// pick a source via chrome.desktopCapture → streamId, (2) hand the streamId to
// the offscreen document, which alone has the DOM getUserMedia needs, and (3)
// get back a single JPEG frame.

/** Show the OS/Chrome source picker; resolves to a streamId, or '' if cancelled. */
function chooseDesktopStream(): Promise<string> {
  return new Promise((resolve) => {
    try {
      chrome.desktopCapture.chooseDesktopMedia(['screen', 'window'], (streamId) => resolve(streamId || ''));
    } catch {
      resolve('');
    }
  });
}

/** Ensure the offscreen document exists (desktop-frame capture only; mic capture
 *  lives in the content script, so this document is not used for audio). */
async function ensureOffscreenDocument(): Promise<void> {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/index.html',
    reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA],
    justification: 'Capture a target design screenshot from another app, window, or screen.',
  });
}

/** Full desktop-target capture: pick a source, grab one (downscaled) frame with a
 *  timeout. Delegates the orchestration to the pure, testable flow module. */
function captureDesktopTarget() {
  return runDesktopCaptureFlow({
    chooseStream: chooseDesktopStream,
    ensureOffscreen: ensureOffscreenDocument,
    requestFrame: (streamId) => chrome.runtime.sendMessage({ type: 'CAPTURE_DESKTOP_FRAME', streamId }),
  }, { timeoutMs: 15000 });
}

/** Decode a captured data URL, downscale if over the long-edge cap, and stamp
 *  provenance + dimensions. Runs in the service worker via OffscreenCanvas. */
async function finalizeCapture(dataUrl: string, sourceKind: TargetCapture['sourceKind']): Promise<TargetCapture> {
  const base = { sourceKind, capturedAtMs: Date.now() };
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    let { width, height } = bitmap;
    let out = dataUrl;
    const scale = Math.min(1, MAX_TARGET_LONG_EDGE / Math.max(width, height));
    if (scale < 1) {
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);
      out = await blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
    }
    bitmap.close();
    return { dataUrl: out, width, height, ...base };
  } catch {
    return { dataUrl, width: 0, height: 0, ...base };
  }
}

/** Blob → data URL without FileReader (unavailable in a service worker). */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

/** The stored image data URL, from either the current object shape or a legacy string. */
function targetDataUrl(td: TargetCapture | string | undefined): string | null {
  if (!td) return null;
  return typeof td === 'string' ? td : td.dataUrl;
}

/**
 * Idempotent: (re)start the fine 2s screenshot cadence AND the eviction-survival
 * alarm. Safe to call repeatedly — on a cold wake we call it again to rearm the
 * setInterval that died with the previous worker instance.
 */
function ensureCaptureRunning(): void {
  if (!screenshotInterval) screenshotInterval = setInterval(captureScreenshot, SCREENSHOT_MS);
  // Timers don't keep an MV3 worker alive and die on eviction; this alarm fires
  // even after eviction and wakes the worker to re-arm capture. 0.5min ≈ floor.
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
}

function stopCapture(): void {
  if (screenshotInterval) { clearInterval(screenshotInterval); screenshotInterval = null; }
  chrome.alarms.clear(HEARTBEAT_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  void (async () => {
    await ensureHydrated();                 // ← rehydrate BEFORE judging state
    if (session?.state !== 'recording') { stopCapture(); return; }
    ensureCaptureRunning();                 // re-arm the loop if the worker was evicted
    await captureScreenshot();              // catch-up frame
    await persistActive();
  })();
});

// ─── Tab Tracking ──────────────────────────────────────────────

chrome.tabs.onActivated.addListener((info) => {
  activeTabId = info.tabId;
  console.log('[Loupe] Active tab:', activeTabId);
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]?.id) {
    activeTabId = tabs[0].id;
    console.log('[Loupe] Init tab:', activeTabId);
  }
});

// ─── Messages from Content Scripts ─────────────────────────────

chrome.runtime.onMessage.addListener((msg: MessageFromContent, sender, sendResponse) => {
  // Popup commands are handled by the other listener.
  if (!sender.tab && msg.type !== 'AUDIO_BLOB') return;
  // Return true + respond when done: this keeps the worker (and channel) alive
  // until the async handler completes, so a cold-woken worker isn't torn down
  // mid-rehydration. Content sends are fire-and-forget; the reply is ignored.
  handleContentMessage(msg, sender).finally(() => {
    try { sendResponse({ ok: true }); } catch { /* sender gone */ }
  });
  return true;
});

async function handleContentMessage(
  msg: MessageFromContent,
  sender: chrome.runtime.MessageSender
): Promise<void> {
  await ensureHydrated(); // ← BEFORE any session check, so nothing is dropped on cold wake

  if (msg.type === 'AUDIO_BLOB') {
    if (session) { session.audioData = msg.data; schedulePersist(); }
    return;
  }
  if (!sender.tab) return;
  if (session?.state !== 'recording') return;

  switch (msg.type) {
    case 'UX_EVENT':
      session.events.push(msg.event);
      schedulePersist();
      break;
    case 'URL_CHANGE':
      session.urlTimeline.push(msg.entry);
      schedulePersist();
      break;
    case 'CONSOLE_ERROR':
      session.events.push(msg.error);
      schedulePersist();
      break;
    case 'NETWORK_METRIC':
      session.events.push(msg.metric);
      schedulePersist();
      break;
  }
}

// ─── Mic via Content Script ────────────────────────────────────
// getUserMedia must run in the tab's web page context so Chrome shows
// the mic permission dialog for the site — visible to the user.
// Offscreen documents are headless; Chrome auto-dismisses dialogs there.

function getContentScriptFiles(): string[] {
  // Read the bundled hashed path from the manifest at runtime
  const manifest = chrome.runtime.getManifest();
  return manifest.content_scripts?.[0]?.js ?? [];
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/** True iff the content script is present and answering in this tab. */
async function pingContentScript(tabId: number, timeoutMs = 500): Promise<boolean> {
  try {
    const resp = await withTimeout(chrome.tabs.sendMessage(tabId, { type: 'PING' }), timeoutMs);
    return !!(resp && (resp as { ok?: boolean }).ok);
  } catch {
    return false;
  }
}

// Guarantee the content script is actually listening in the tab. A script that
// was declared-injected but orphaned (extension reloaded without a tab refresh)
// answers no PING, and a loader-based inject can silently no-op — so we inject
// AND re-verify with a follow-up PING rather than trusting executeScript. Throws
// when the tab can't be attached at all (chrome://, Web Store, or a page that
// blocks injection) so callers can prompt the user to refresh.
async function ensureContentScript(tabId: number): Promise<void> {
  if (await pingContentScript(tabId)) return;
  console.log('[Loupe] Injecting content script into tab', tabId);
  const files = getContentScriptFiles();
  if (!files.length) throw new Error('No content_scripts in manifest');
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
  } catch (e) {
    console.error('[Loupe] Inject failed (chrome:// or restricted page?):', e);
    throw e;
  }
  // Give the freshly-injected module a beat to register its onMessage listener.
  for (let i = 0; i < 6; i++) {
    if (await pingContentScript(tabId)) return;
    await delay(150);
  }
  throw new Error('content script unreachable after injection');
}

/** Reload a tab and resolve once it has finished loading (so a freshly-declared
 *  content script is guaranteed to be injected). */
function reloadTabAndWait(tabId: number, timeoutMs = 12000): Promise<void> {
  return new Promise((resolve, reject) => {
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        setTimeout(resolve, 300); // let the content script register listeners
      }
    };
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('reload timeout'));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.reload(tabId).catch((e) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(e);
    });
  });
}

async function startMic(): Promise<boolean> {
  if (!activeTabId) return false;
  try {
    await ensureContentScript(activeTabId);
    const resp = await chrome.tabs.sendMessage(activeTabId, { type: 'START_MIC' });
    console.log('[Loupe] Mic response:', resp);
    return resp?.ok === true;
  } catch (err) {
    console.error('[Loupe] Start mic failed:', err);
    return false;
  }
}

async function stopMic(): Promise<string | null> {
  if (!activeTabId) return null;
  try {
    const resp = await chrome.tabs.sendMessage(activeTabId, { type: 'STOP_MIC' });
    console.log('[Loupe] Mic stopped, audio length:', resp?.audioData?.length);
    return resp?.audioData || null;
  } catch {
    return null;
  }
}

// ─── Messages from Popup ────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: MessageToContent | { type: string }, sender, sendResponse) => {
  if (sender.tab) return; // only from popup
  handlePopupMessage(msg, sendResponse).catch((e) => {
    console.error('[Loupe] popup handler error:', e);
    try { sendResponse({ ok: false }); } catch { /* popup closed */ }
  });
  return true; // keep worker + channel alive until the async handler resolves
});

/**
 * Start a recording. Verifies the content script is actually attached to the
 * active tab FIRST — if it can't be reached (orphaned after an extension reload,
 * or a restricted page), returns { needsRefresh: true } instead of committing to
 * a screenshots-only session with no events, DOM snapshots, or audio. That
 * silent-failure mode is what produced empty recordings.
 */
async function beginRecording(
  project: string,
  flow: string
): Promise<{ ok: boolean; needsRefresh?: boolean; error?: string }> {
  if (!activeTabId) return { ok: false, error: 'No active tab' };

  await refreshScreenshotQuality();

  try {
    await ensureContentScript(activeTabId);
  } catch (e) {
    console.warn('[Loupe] Content script unreachable — prompting refresh:', e);
    return { ok: false, needsRefresh: true, error: 'content-script-unreachable' };
  }

  const now = Date.now();
  startSessionClock(now);
  session = {
    id: makeId(),
    state: 'recording',
    project,
    flow,
    startTime: now,
    events: [],
    urlTimeline: [],
    screenshots: [],
    viewport: { width: 0, height: 0 },
    notes: [],
  };
  void persistActive();
  chrome.action.setBadgeText({ text: '●' });
  chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
  // Capture initial URL for urlTimeline
  (async () => {
    try {
      const tab = await chrome.tabs.get(activeTabId!);
      if (tab.url && session) {
        session.urlTimeline.push({ url: tab.url, timestamp: 0, navigationType: 'initial' });
        schedulePersist();
      }
    } catch { /* tab may not be ready */ }
  })();
  // Capture initial viewport from tab
  chrome.tabs.get(activeTabId).then((tab) => {
    if (session && tab.width && tab.height) {
      session.viewport = { width: tab.width, height: tab.height };
    }
  }).catch(() => {});
  // Start screenshots (2s) + eviction-safe alarm heartbeat.
  ensureCaptureRunning();
  // Content script is confirmed ready → tell it to record, then start mic.
  (async () => {
    try {
      await chrome.tabs.sendMessage(activeTabId!, { type: 'START_RECORDING', project, flow } as MessageToContent);
    } catch (e) {
      console.error('[Loupe] START_RECORDING send failed:', e);
    }
    const micOk = await startMic();
    console.log('[Loupe] Mic started:', micOk);
  })();
  console.log('[Loupe] Recording started:', project, '/', flow);
  return { ok: true };
}

async function handlePopupMessage(
  msg: MessageToContent | { type: string },
  sendResponse: (response?: unknown) => void
): Promise<void> {
  // Rehydrate first so every popup op (state, stop, pause, recovery) sees the
  // real in-progress session even on a cold-woken worker.
  await ensureHydrated();

  switch (msg.type) {
    case 'START_RECORDING': {
      const m = msg as MessageToContent & { type: 'START_RECORDING' };
      sendResponse(await beginRecording(m.project, m.flow));
      return;
    }

    case 'REFRESH_AND_START': {
      const m = msg as { type: 'REFRESH_AND_START'; project: string; flow: string };
      if (!activeTabId) {
        sendResponse({ ok: false, error: 'No active tab' });
        return;
      }
      try {
        await reloadTabAndWait(activeTabId);
      } catch (e) {
        console.error('[Loupe] Refresh-and-start: reload failed:', e);
        sendResponse({ ok: false, error: 'refresh-failed' });
        return;
      }
      sendResponse(await beginRecording(m.project, m.flow));
      return;
    }

    case 'STOP_RECORDING': {
      if (!session) {
        sendResponse({ ok: false, error: 'No active session' });
        return;
      }
      const snap = session;
      session = null;
      chrome.action.setBadgeText({ text: '' });
      stopCapture();
      // Neutralize the durable live-recording mirror BEFORE the slow, fallible
      // mic-stop + export below. If the worker is torn down during that window —
      // classically when the user closes the popup right after Stop — the
      // persisted session must never be rehydrated as an active recording.
      // Flagging it interrupted makes ensureHydrated() treat it as stopped (and
      // GET_RECOVERABLE offer it for recovery), instead of resuming it and
      // leaving the popup stuck on "recording" with the timer running. Both keys
      // are cleared on a successful export just below.
      try { await chrome.storage.local.set({ [INTERRUPTED_KEY]: true }); } catch { /* best effort */ }
      if (activeTabId) chrome.tabs.sendMessage(activeTabId, msg as MessageToContent).catch(() => {});
      // Stop mic and get audio, then export.
      const audioData = await stopMic();
      if (audioData) snap.audioData = audioData;
      const ok = await exportAndStore(snap);
      if (ok) {
        await clearActive();
      } else {
        // A failed write keeps the data recoverable instead of silently losing
        // it — persist the freshest snapshot (incl. audio) under the recovery
        // slot, still flagged interrupted so it never resumes as a live recording.
        try { await chrome.storage.local.set({ [ACTIVE_KEY]: snap, [INTERRUPTED_KEY]: true }); } catch { /* best effort */ }
      }
      console.log('[Loupe] Export done, ok:', ok, 'audio:', !!audioData);
      sendResponse({
        ok,
        stats: {
          screenshots: snap.screenshots.length,
          domSnapshots: snap.events.filter(e => e.type === 'dom_snapshot').length,
          notes: snap.notes.length,
          events: snap.events.length,
          duration: Date.now() - snap.startTime,
          target: !!snap.targetDesign,
        },
      });
      return;
    }

    case 'PAUSE_RECORDING': {
      if (session) { session.state = 'paused'; void persistActive(); }
      chrome.action.setBadgeText({ text: '⏸' });
      if (activeTabId) chrome.tabs.sendMessage(activeTabId, msg as MessageToContent).catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    case 'RESUME_RECORDING': {
      if (session) { session.state = 'recording'; void persistActive(); }
      chrome.action.setBadgeText({ text: '●' });
      chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
      ensureCaptureRunning(); // re-arm in case the loop lapsed while paused/evicted
      if (activeTabId) chrome.tabs.sendMessage(activeTabId, msg as MessageToContent).catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    case 'CAPTURE_TARGET': {
      // Grab the visible tab as the desired-state "target design". Because the
      // recording session is global, the user opens Loupe over whichever tab
      // shows their target (another site, Claude Design, a Figma frame) and
      // clicks — the shot rides inside the .loupe session, so build-this needs
      // no file and no CLI flag. Latest capture wins (re-capture replaces).
      if (!session) { sendResponse({ ok: false, error: 'no-session' }); return; }
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: screenshotQuality });
        session.targetDesign = await finalizeCapture(dataUrl, 'chrome-tab');
        void persistActive();
        sendResponse({ ok: true, url: session.urlTimeline.at(-1)?.url || '' });
      } catch (err) {
        // chrome://, the Web Store, or a PDF viewer can't be captured.
        sendResponse({ ok: false, error: 'capture-failed' });
      }
      return;
    }

    case 'CAPTURE_TARGET_SCREEN': {
      // Target design lives OUTSIDE Chrome (Figma desktop, Safari, any app or
      // screen). captureVisibleTab can't reach it, so we use the desktopCapture
      // picker → offscreen getUserMedia → one frame. Survives the popup closing
      // when the OS picker takes focus: the shot is stored on the session here.
      if (!session) { sendResponse({ ok: false, error: 'no-session' }); return; }
      const res = await captureDesktopTarget();
      if (res.ok) {
        session.targetDesign = {
          dataUrl: res.dataUrl, sourceKind: 'desktop', capturedAtMs: Date.now(),
          width: res.width, height: res.height,
        };
        void persistActive();
        sendResponse({ ok: true });
      } else {
        // 'cancelled' | 'timeout' | 'capture-failed' — the popup maps to copy.
        sendResponse({ ok: false, error: res.error });
      }
      return;
    }

    case 'GET_TARGET': {
      // The captured target image, for the popup's confirm preview.
      sendResponse({ dataUrl: targetDataUrl(session?.targetDesign) });
      return;
    }

    case 'REQUEST_STATE': {
      const s = session;
      sendResponse({
        state: s?.state || 'idle',
        project: s?.project || '',
        flow: s?.flow || '',
        startTime: s?.startTime || 0, // authoritative session start; popup derives elapsed from this
        eventsCount: s?.events.length || 0,
        clicks: s ? s.events.filter(e => e.type === 'click').length : 0,
        screenshots: s?.screenshots.length || 0,
        domSnapshots: s ? s.events.filter(e => e.type === 'dom_snapshot').length : 0,
        url: s?.urlTimeline.at(-1)?.url || '',
        hasTarget: !!s?.targetDesign,
      });
      return;
    }

    // ─── Recovery (popup) ──────────────────────────────────────
    // A recoverable session exists only when there is persisted in-progress data
    // and nothing is actively recording in this worker (the interrupted case;
    // a non-interrupted session is auto-resumed by ensureHydrated above).
    case 'GET_RECOVERABLE': {
      if (session) { sendResponse({ recoverable: null }); return; }
      const r = await chrome.storage.local.get(ACTIVE_KEY);
      const saved = r[ACTIVE_KEY] as RecordingSession | undefined;
      sendResponse({
        recoverable: saved ? {
          id: saved.id,
          project: saved.project,
          flow: saved.flow,
          events: saved.events.length,
          screenshots: saved.screenshots.length,
          startTime: saved.startTime,
        } : null,
      });
      return;
    }

    case 'RECOVER_RESUME': {
      const r = await chrome.storage.local.get(ACTIVE_KEY);
      const saved = r[ACTIVE_KEY] as RecordingSession | undefined;
      if (!saved) { sendResponse({ ok: false }); return; }
      session = saved;
      session.state = 'recording';
      startSessionClock(session.startTime);
      await chrome.storage.local.remove(INTERRUPTED_KEY);
      chrome.action.setBadgeText({ text: '●' });
      chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
      ensureCaptureRunning();
      void persistActive();
      sendResponse({ ok: true, project: saved.project, flow: saved.flow });
      return;
    }

    case 'RECOVER_EXPORT': {
      const r = await chrome.storage.local.get(ACTIVE_KEY);
      const saved = r[ACTIVE_KEY] as RecordingSession | undefined;
      if (!saved) { sendResponse({ ok: false }); return; }
      const ok = await exportAndStore(saved);
      if (ok) await clearActive();
      sendResponse({ ok });
      return;
    }

    // Only ever runs on an explicit user click — nothing is auto-discarded.
    case 'RECOVER_DISCARD': {
      await clearActive();
      sendResponse({ ok: true });
      return;
    }
  }
}

// ─── Export ────────────────────────────────────────────────────

async function exportAndStore(snap: RecordingSession): Promise<boolean> {
  const endedAt = new Date().toISOString();
  console.log(`[Loupe] Packaging: ${snap.events.length} events, ${snap.screenshots.length} screenshots, ${snap.urlTimeline.length} urls`);

  const sessionFile: LoupeSession = {
    project: snap.project,
    flow: snap.flow,
    startedAt: new Date(snap.startTime).toISOString(),
    endedAt,
    urlTimeline: snap.urlTimeline,
    events: snap.events,
    screenshots: snap.screenshots,
    viewport: snap.viewport,
    browser: {
      userAgent: navigator.userAgent,
    },
    notes: snap.notes,
    audioData: snap.audioData,
    targetDesign: snap.targetDesign,
  };

  const json = JSON.stringify(sessionFile, null, 2);
  const project = snap.project.replace(/\s+/g, '-');
  const flow = snap.flow.replace(/\s+/g, '-');
  const filename = `loupe-${project}-${flow}-${snap.startTime}.loupe`;
  const record = { filename, data: json, timestamp: Date.now() };

  console.log(`[Loupe] Writing to storage: ${filename} (${json.length} bytes)`);

  // Lightweight index so the popup can list recent sessions without loading every
  // full (multi-MB) session payload into memory.
  let index: SessionSummary[] = [];
  try {
    const r = await chrome.storage.local.get(SESSION_INDEX_KEY);
    if (Array.isArray(r[SESSION_INDEX_KEY])) index = r[SESSION_INDEX_KEY] as SessionSummary[];
  } catch { /* start fresh */ }
  const summary: SessionSummary = {
    id: snap.id,
    project: snap.project,
    flow: snap.flow,
    timestamp: record.timestamp,
    filename,
  };
  index = [summary, ...index.filter(s => s.id !== snap.id)].slice(0, 20);

  try {
    await chrome.storage.local.set({
      [SESSION_KEY(snap.id)]: record,  // keyed — never overwrites another session
      'loupe:lastSessionId': snap.id,
      lastSession: record,             // back-compat pointer the popup reads to download
      [SESSION_INDEX_KEY]: index,
    });
  } catch (e) {
    console.error('[Loupe] Storage write failed:', e);
    return false;
  }

  console.log('[Loupe] Storage write complete');
  return true;
}
