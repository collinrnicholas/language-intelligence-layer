// ─── Canonical .loupe Session Format ────────────────────────────
//
// This is the contract between extension → analyzer → report.
// Every .loupe file is a LoupeSession.

export interface LoupeSession {
  project: string;
  flow: string;
  startedAt: string;        // ISO timestamp
  endedAt: string;          // ISO timestamp
  urlTimeline: UrlEntry[];
  events: SessionEvent[];
  screenshots: ScreenshotEntry[];
  viewport: ViewportInfo;
  browser: BrowserInfo;
  notes: NoteEntry[];
  audioData?: string;       // base64 audio/webm — embedded for now
  targetDesign?: TargetCapture | string; // "Capture Target Screenshot" (string = legacy)
}

/** A captured target design (desired state) with provenance + dimensions. */
export interface TargetCapture {
  dataUrl: string;                        // JPEG/PNG data URL (downscaled, long edge ≤ 2560)
  sourceKind: 'chrome-tab' | 'desktop';   // Chrome tab vs another app/screen
  capturedAtMs: number;                   // Date.now() at capture
  width: number;                          // stored image width  (0 if undetermined)
  height: number;                         // stored image height (0 if undetermined)
}

export interface UrlEntry {
  url: string;
  timestamp: number;        // ms from session start
  navigationType: 'pushstate' | 'popstate' | 'hashchange' | 'hard' | 'initial';
}

export type SessionEvent =
  | ClickEvent
  | ScrollEvent
  | DomSnapshotEvent
  | ConsoleErrorEvent
  | NetworkEvent;

export interface ClickEvent {
  type: 'click';
  timestamp: number;
  selector: string;
  x: number;
  y: number;
  tagName: string;
  textContent: string;
  href?: string;
}

export interface ScrollEvent {
  type: 'scroll';
  timestamp: number;
  scrollX: number;
  scrollY: number;
  maxScrollX: number;
  maxScrollY: number;
}

export interface DomSnapshotEvent {
  type: 'dom_snapshot';
  timestamp: number;
  url: string;
  html: string;             // trimmed to 10KB
  computedStyles: Record<string, Record<string, string>>;
}

export interface ConsoleErrorEvent {
  type: 'console_error';
  timestamp: number;
  message: string;
  source: string;
}

export interface NetworkEvent {
  type: 'network';
  timestamp: number;
  url: string;
  duration: number;
  initiatorType: string;
}

export interface ScreenshotEntry {
  timestamp: number;
  dataUrl: string;          // JPEG base64 data URL
}

export interface ViewportInfo {
  width: number;
  height: number;
}

export interface BrowserInfo {
  userAgent: string;
}

export interface NoteEntry {
  type: 'transcript' | 'manual';
  timestamp: number;
  endTimestamp?: number;    // for transcript segments
  text: string;
  source?: string;          // 'audio' | 'manual'
  confidence?: number;      // 0-1, for transcript segments
}

// ─── Extension Runtime Types (not in .loupe file) ────────────────

export type RecordingState = 'idle' | 'recording' | 'paused';

export interface RecordingSession {
  id: string;               // unique per recording — keys durable storage, prevents overwrite
  state: RecordingState;
  project: string;
  flow: string;
  startTime: number;        // Date.now(), converted to startedAt on export
  events: SessionEvent[];
  urlTimeline: UrlEntry[];
  screenshots: ScreenshotEntry[];
  viewport: ViewportInfo;
  notes: NoteEntry[];
  audioData?: string;       // base64 audio/webm blob (not in canonical format yet)
  targetDesign?: TargetCapture; // captured target design (desired state)
}

// ─── Messaging Types ─────────────────────────────────────────────

export type MessageFromContent =
  | { type: 'UX_EVENT'; event: SessionEvent }
  | { type: 'URL_CHANGE'; entry: UrlEntry }
  | { type: 'CONSOLE_ERROR'; error: ConsoleErrorEvent }
  | { type: 'NETWORK_METRIC'; metric: NetworkEvent }
  | { type: 'AUDIO_BLOB'; data: string };

export type MessageToContent =
  | { type: 'START_RECORDING'; project: string; flow: string }
  | { type: 'STOP_RECORDING' }
  | { type: 'PAUSE_RECORDING' }
  | { type: 'RESUME_RECORDING' }
  | { type: 'REQUEST_STATE' }
  | { type: 'START_MIC' }
  | { type: 'STOP_MIC' };
