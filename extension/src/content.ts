import type {
  SessionEvent,
  ClickEvent,
  ScrollEvent,
  DomSnapshotEvent,
  ConsoleErrorEvent,
  NetworkEvent,
  UrlEntry,
  RecordingState,
  MessageToContent,
} from './types';
import { resetSessionClock, sessionNowMs, startSessionClock } from './session-time';

// ─── Floating Indicator ──────────────────────────────────────────

let indicatorEl: HTMLDivElement | null = null;

function createIndicator() {
  if (indicatorEl) return;
  indicatorEl = document.createElement('div');
  indicatorEl.id = 'loupe-indicator';
  indicatorEl.innerHTML = '🔍 Loupe <span class="s-dot">●</span>';
  Object.assign(indicatorEl.style, {
    position: 'fixed',
    bottom: '16px',
    right: '16px',
    zIndex: '2147483647',
    background: '#12C97E',
    color: '#101317',
    padding: '8px 14px',
    borderRadius: '8px',
    fontSize: '13px',
    fontFamily: "'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif",
    fontWeight: '600',
    letterSpacing: '-0.01em',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    boxShadow: '0 4px 16px rgba(18, 201, 126, 0.3)',
    pointerEvents: 'none',
    transition: 'opacity 0.3s',
    opacity: '0',
  });
  const dot = indicatorEl.querySelector('.s-dot') as HTMLSpanElement;
  dot.style.color = '#e74c3c';
  dot.style.animation = 's-pulse 1.5s infinite';
  try {
  document.body.appendChild(indicatorEl);
  } catch {
    // Page not ready yet — will create on first recording start
  }
}

function setIndicator(visible: boolean, label?: string) {
  if (!indicatorEl) return;
  indicatorEl.style.opacity = visible ? '1' : '0';
  if (label) {
    indicatorEl.innerHTML = `🔭 ${label}`;
  }
}

// Inject keyframes for pulse animation
const styleSheet = document.createElement('style');
styleSheet.textContent = `@keyframes s-pulse { 0%,100% { opacity:1 } 50% { opacity:0.3 } }`;
document.head.appendChild(styleSheet);

console.log('[Loupe] Content script loaded');

// ─── State ─────────────────────────────────────────────────────

let recordingState: RecordingState = 'idle';
let project = '';
let flow = '';
let lastUrl = location.href;
let lastSnapshotTime = 0;
let lastScrollTime = 0;
const SNAPSHOT_INTERVAL = 2000;
const SCROLL_THROTTLE = 300;

// Narration — handled via injected script (page main world)
// Variables kept for state tracking

// ─── Helpers ───────────────────────────────────────────────────

function getSelector(el: EventTarget | null): string {
  if (!(el instanceof Element)) return 'unknown';
  if (el.id) return `#${el.id}`;
  if (el.className && typeof el.className === 'string') {
    const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
    if (cls) return `${el.tagName.toLowerCase()}.${cls}`;
  }
  return el.tagName.toLowerCase();
}

function sendEvent(event: SessionEvent) {
  if (recordingState !== 'recording') return;
  chrome.runtime.sendMessage({ type: 'UX_EVENT', event });
}

// ─── Click Capture ─────────────────────────────────────────────

document.addEventListener('click', (e: MouseEvent) => {
  if (recordingState !== 'recording') return;
  const target = e.target as HTMLElement;
  const event: ClickEvent = {
    type: 'click',
    timestamp: sessionNowMs(performance.now()),
    selector: getSelector(e.target),
    x: e.clientX,
    y: e.clientY,
    tagName: target.tagName || 'unknown',
    textContent: (target.textContent || '').trim().slice(0, 120),
    href: (target as HTMLAnchorElement).href || undefined,
  };
  sendEvent(event);

  // Trigger DOM snapshot on click — user interaction likely means state change
  captureDomSnapshot();
});

// ─── Scroll Capture (throttled) ────────────────────────────────

window.addEventListener('scroll', () => {
  if (recordingState !== 'recording') return;
  const now = performance.now();
  if (now - lastScrollTime < SCROLL_THROTTLE) return;
  lastScrollTime = now;

  const event: ScrollEvent = {
    type: 'scroll',
    timestamp: sessionNowMs(performance.now()),
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    maxScrollX: document.documentElement.scrollWidth - window.innerWidth,
    maxScrollY: document.documentElement.scrollHeight - window.innerHeight,
  };
  sendEvent(event);
});

// ─── Viewport — captured once at session start by background ─────

// ─── Route Change Capture (SPA) ───────────────────────────────

function handleRouteChange(to: string, navType: UrlEntry['navigationType']) {
  if (recordingState !== 'recording') return;
  const from = lastUrl;
  lastUrl = to;
  // Send as URL_CHANGE for the urlTimeline
  chrome.runtime.sendMessage({
    type: 'URL_CHANGE',
      entry: {
        url: to,
        timestamp: sessionNowMs(performance.now()),
      navigationType: navType,
    },
  });
  // Snap DOM after navigation
  setTimeout(() => captureDomSnapshot(), 500);
}

// Patch history methods for SPA route detection
const origPushState = history.pushState.bind(history);
history.pushState = function (...args) {
  origPushState(...args);
  handleRouteChange(location.href, 'pushstate');
};
const origReplaceState = history.replaceState.bind(history);
history.replaceState = function (...args) {
  origReplaceState(...args);
  handleRouteChange(location.href, 'pushstate');
};
window.addEventListener('popstate', () => handleRouteChange(location.href, 'popstate'));
window.addEventListener('hashchange', () => handleRouteChange(location.href, 'hashchange'));

// ─── DOM Snapshot ──────────────────────────────────────────────

// Region eligibility is AREA-DRIVEN, not class/tag-driven. The zones users
// narrate about (left rail, center column, right panel, header) are large
// layout blocks — but in a Tailwind app they're plain <div>s with no semantic
// tag and no "rail"/"panel" class, so a selector gate would never see them.
// Instead we consider any block-level element large enough to be a layout zone,
// regardless of tag/class, PLUS semantic landmarks as guaranteed-includes.

// Semantic landmarks always considered (guaranteed-includes), even if small.
const SEMANTIC_REGION_SELECTOR = [
  'header', 'nav', 'aside', 'main', 'footer', 'section',
  '[role="region"]', '[role="main"]', '[role="navigation"]',
  '[role="complementary"]', '[role="banner"]', '[role="contentinfo"]',
].join(',');

// Block-level container tags scanned for the area-driven pass. Broad on purpose
// (`div` is the point — it catches Tailwind layout divs); the size test, not the
// tag, decides eligibility. Non-container tags (span/svg/img/p/hN) are never
// layout zones, so excluding them just keeps the scan cheap.
const REGION_CANDIDATE_TAGS = 'div, section, article, aside, main, header, footer, nav, form, ul, ol';

// Cap region capture so the base64 .loupe doesn't balloon — keep the largest
// zones, which are the ones users narrate about. Interactives uncapped.
const MAX_REGIONS = 18;

// A layout zone is large in area OR spans a major axis. The axis test matters:
// a header/footer is wide but short (small area yet clearly a zone), a rail is
// tall but narrow — a pure area floor would miss both. Thickness floor drops
// hairline spanning rules/dividers.
const REGION_MIN_AREA_FRACTION = 0.10; // ≥10% of viewport area (center column, panels)
const REGION_SPAN_FRACTION = 0.6;      // ≥60% of a viewport axis (header bars, tall rails)
const REGION_MIN_THICKNESS_PX = 32;    // a spanning zone must be at least this thick
const REGION_OVERLAP_IOU = 0.9;        // treat near-identical nested boxes as one

function isLayoutSized(r: DOMRect, vw: number, vh: number): boolean {
  if (r.width <= 0 || r.height <= 0) return false;
  const areaBig = r.width * r.height >= vw * vh * REGION_MIN_AREA_FRACTION;
  const wideBar = r.width >= vw * REGION_SPAN_FRACTION && r.height >= REGION_MIN_THICKNESS_PX;
  const tallRail = r.height >= vh * REGION_SPAN_FRACTION && r.width >= REGION_MIN_THICKNESS_PX;
  return areaBig || wideBar || tallRail;
}

// Intersection-over-union of two boxes — used to collapse redundant nesting
// (a wrapper and the child that fills it) down to a single captured region.
function boxIoU(a: DOMRect, b: DOMRect): number {
  const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const inter = ix * iy;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

// Area-driven region candidates: semantic landmarks (guaranteed) + any large
// block-level element regardless of class/tag. Ranked by area, deduped against
// near-identical ancestors so we keep the zones that partition the screen rather
// than the app-shell wrapper or deep leaves, then capped.
function collectRegionElements(): Element[] {
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  if (!vw || !vh) return [];

  const candidates = new Set<Element>(
    Array.from(document.querySelectorAll(SEMANTIC_REGION_SELECTOR))
  );
  for (const el of Array.from(document.querySelectorAll(REGION_CANDIDATE_TAGS))) {
    if (candidates.has(el)) continue; // semantic landmark, already guaranteed
    const r = el.getBoundingClientRect();
    if (!isLayoutSized(r, vw, vh)) continue;
    const disp = window.getComputedStyle(el).display;
    if (disp === 'none' || disp === 'contents' || disp === 'inline') continue;
    candidates.add(el);
  }

  const ranked = Array.from(candidates)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return { el, rect, area: rect.width * rect.height };
    })
    .filter((x) => x.area > 0)
    .sort((a, b) => b.area - a.area);

  const kept: { el: Element; rect: DOMRect }[] = [];
  for (const c of ranked) {
    if (kept.length >= MAX_REGIONS) break;
    const redundant = kept.some(
      (k) => (k.el.contains(c.el) || c.el.contains(k.el)) && boxIoU(k.rect, c.rect) >= REGION_OVERLAP_IOU
    );
    if (redundant) continue;
    kept.push({ el: c.el, rect: c.rect });
  }
  return kept.map((k) => k.el);
}

// Small, fixed property set. backgroundColor / border / boxShadow explain
// visual-hierarchy and "sections blend together" findings (regions sharing a
// background with no separating edge); overflow explains the "right rail shows
// partial/clipped content" finding (a region clipping its content vs scrolling
// it). We deliberately do NOT dump full computed styles.
//
// overflowX/overflowY are captured rather than the `overflow` shorthand, which
// computes to '' when the two axes differ — and the axis values are precisely
// what separate a clipped rail (hidden) from a scrollable one (auto/scroll).
// The CSS `border` shorthand computes to '' when the four sides differ, and
// naively joining borderWidth+borderStyle+borderColor produces a garbled
// per-side concatenation (e.g. "1px 0px 0px solid none none rgb() rgb() rgb()").
// Compose from per-side longhands instead: surface the visible edge(s) cleanly,
// or 'none' when there is no border. Downstream, 'none' is meaningful signal
// (regions blending with no separating edge).
function composeBorder(s: CSSStyleDeclaration): string {
  const sides = (['Top', 'Right', 'Bottom', 'Left'] as const).map(side => ({
    width: s.getPropertyValue(`border-${side.toLowerCase()}-width`),
    style: s.getPropertyValue(`border-${side.toLowerCase()}-style`),
    color: s.getPropertyValue(`border-${side.toLowerCase()}-color`),
  }));
  const visible = sides.filter(b => b.style !== 'none' && b.style !== 'hidden' && parseFloat(b.width) > 0);
  if (visible.length === 0) return 'none';
  const uniq = [...new Set(visible.map(b => `${b.width} ${b.style} ${b.color}`))];
  return uniq.length === 1 ? uniq[0] : uniq.join(' / ');
}

function snapshotStyles(el: Element): Record<string, string> {
  const s = window.getComputedStyle(el);
  return {
    color: s.color,
    backgroundColor: s.backgroundColor,
    fontSize: s.fontSize,
    fontFamily: s.fontFamily,
    padding: s.padding,
    margin: s.margin,
    borderRadius: s.borderRadius,
    border: composeBorder(s),
    boxShadow: s.boxShadow,
    overflowX: s.overflowX,
    overflowY: s.overflowY,
    width: s.width,
    height: s.height,
    display: s.display,
  };
}

function captureDomSnapshot() {
  if (recordingState !== 'recording') return;
  const now = performance.now();
  if (now - lastSnapshotTime < SNAPSHOT_INTERVAL / 2) return;
  lastSnapshotTime = now;

  // Computed styles of key interactive elements (uncapped) ...
  const styleMap: Record<string, Record<string, string>> = {};
  const interactives = document.querySelectorAll(
    'button, a, input, select, textarea, [role="button"], [tabindex]'
  );
  interactives.forEach((el) => {
    styleMap[getSelector(el)] = snapshotStyles(el);
  });

  // ... plus the largest layout zones (area-driven, capped), so visual-hierarchy
  // narration has measured backgrounds/borders/overflow to cite.
  collectRegionElements().forEach((el) => {
    const selector = getSelector(el);
    if (!styleMap[selector]) styleMap[selector] = snapshotStyles(el);
  });

  const event: DomSnapshotEvent = {
    type: 'dom_snapshot',
    timestamp: sessionNowMs(performance.now()),
    url: location.href,
    // Keep HTML small: just the body's innerHTML, trim to 10KB max
    html: (document.body?.innerHTML || '').slice(0, 10000),
    computedStyles: styleMap,
  };
  sendEvent(event);
}

// Periodic snapshots during recording
setInterval(() => captureDomSnapshot(), SNAPSHOT_INTERVAL);

// ─── Console Error Capture ─────────────────────────────────────

const origConsoleError = console.error;
console.error = function (...args: unknown[]) {
  origConsoleError.apply(console, args);
  if (recordingState !== 'recording') return;
  const error: ConsoleErrorEvent = {
    type: 'console_error',
    timestamp: sessionNowMs(performance.now()),
    message: args.map(String).join(' ').slice(0, 500),
    source: (new Error().stack || '').split('\n')[2]?.trim() || 'unknown',
  };
  chrome.runtime.sendMessage({ type: 'CONSOLE_ERROR', error });
};

// ─── Network Timing (Performance API) ──────────────────────────

function captureNetworkMetrics() {
  if (recordingState !== 'recording') return;
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  // Only capture recent entries
  const recent = entries.slice(-10);
  recent.forEach((entry) => {
    const metric: NetworkEvent = {
      type: 'network',
      url: entry.name.slice(0, 200),
      duration: Math.round(entry.duration),
      initiatorType: entry.initiatorType || 'other',
      timestamp: sessionNowMs(performance.now()),
    };
    chrome.runtime.sendMessage({ type: 'NETWORK_METRIC', metric });
  });
}

setInterval(() => captureNetworkMetrics(), 5000);

// ─── Mic Recording (content script owns getUserMedia) ──────────

let micRecorder: MediaRecorder | null = null;
let micStream: MediaStream | null = null;
// ALL recorded audio accumulates here for the whole session (one shared buffer).
// The previous design used a second buffer that only collected post-stop chunks,
// so the exported audio was just the final ~1KB flush.
let micChunks: Blob[] = [];
let micStopResolve: ((dataUrl: string | null) => void) | null = null;

async function startMicCapture(): Promise<{ ok: boolean; error?: string }> {
  if (micRecorder) return { ok: true };
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micChunks = [];
    micRecorder = new MediaRecorder(micStream, { mimeType: 'audio/webm' });
    micRecorder.ondataavailable = (e) => { if (e.data.size > 0) micChunks.push(e.data); };
    micRecorder.onstop = () => {
      const finish = (dataUrl: string | null) => {
        if (dataUrl) chrome.runtime.sendMessage({ type: 'AUDIO_BLOB', data: dataUrl }).catch(() => {});
        micStopResolve?.(dataUrl);
        micStopResolve = null;
      };
      // Build the blob from the FULL session buffer, not just the final chunk.
      if (micChunks.length > 0) {
        const blob = new Blob(micChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => finish(reader.result as string);
        reader.onerror = () => finish(null);
        reader.readAsDataURL(blob);
      } else {
        finish(null);
      }
      if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
      micRecorder = null;
    };
    micRecorder.start(1000);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}

function stopMicCapture(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!micRecorder || micRecorder.state === 'inactive') {
      resolve(null);
      return;
    }
    // onstop (set in startMicCapture) flushes a final dataavailable into micChunks,
    // then resolves this promise with the complete recording.
    micStopResolve = resolve;
    micRecorder.stop();
  });
}

// ─── Messaging ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: MessageToContent | { type: 'PING' }, _sender, sendResponse) => {
  switch (msg.type) {
    case 'PING':
      sendResponse({ ok: true });
      break;

    case 'START_RECORDING':
      startSessionClock(performance.now());
      project = msg.project;
      flow = msg.flow;
      lastUrl = location.href;
      recordingState = 'recording';
      createIndicator();
      setIndicator(true, `Loupe · ${project} · ${flow}`);
      console.log(`[Loupe] Recording started — ${project} / ${flow}`);
      captureDomSnapshot();
      sendResponse({ state: 'recording' });
      break;

    case 'STOP_RECORDING':
      recordingState = 'idle';
      resetSessionClock();
      setIndicator(false);
      console.log(`[Loupe] Recording stopped`);
      captureDomSnapshot();
      sendResponse({ state: 'idle' });
      break;

    case 'PAUSE_RECORDING':
      recordingState = 'paused';
      setIndicator(true, 'Loupe · paused');
      sendResponse({ state: 'paused' });
      break;

    case 'RESUME_RECORDING':
      recordingState = 'recording';
      setIndicator(true, `Loupe · ${project} · ${flow}`);
      sendResponse({ state: 'recording' });
      break;

    case 'REQUEST_STATE':
      sendResponse({ state: recordingState, project, flow });
      break;

    case 'START_MIC':
      startMicCapture().then(sendResponse);
      return true; // async response

    case 'STOP_MIC':
      stopMicCapture().then((dataUrl) => {
        sendResponse({ ok: true, audioData: dataUrl });
      });
      return true; // async
  }
});
