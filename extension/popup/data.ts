// ─── Popup data layer ────────────────────────────────────────────
//
// Storage model (all preserved from the previous popup — new fields only):
//   localStorage 'loupe_workspace'     — settings blob. Legacy fields (agent,
//     workspace, output, postAction) are kept on disk untouched so nothing
//     downstream breaks, but the UI no longer surfaces them: Loupe's contract
//     ends at writing build-prompt.md, so the popup only knows a destination.
//   localStorage 'loupe_mic_ack'       — first-run mic intro acknowledged.
//   chrome.storage 'loupe:sessionIndex'   — SessionSummary[] (written by worker).
//   chrome.storage 'loupe:session:<id>'   — exported session payloads.
//   chrome.storage 'lastSession'          — most recent capture payload.
//   chrome.storage 'loupe:settings'       — the subset the WORKER needs
//     (screenshot quality); popup localStorage is invisible to a service worker.
//   chrome.storage 'loupe:exportIndex'    — NEW: record of .loupe exports so the
//     Exports view can list and reveal them via chrome.downloads.

// ─── Settings ───────────────────────────────────────────────────

export interface LoupeSettings {
  project: string;
  flow: string;
  /** Where the Loupe CLI writes the generated build prompt. Display + CLI hint
   *  only — the extension itself never writes outside ~/Downloads. */
  promptDest: string;
  /** Reveal the exported .loupe file in the OS file manager after export. */
  revealOnExport: boolean;
  screenshotQuality: 'standard' | 'high';
  theme: 'system' | 'light' | 'dark';
  // Legacy fields — preserved verbatim for older readers; not shown in the UI.
  agent?: string;
  workspace?: string;
  output?: string;
  postAction?: string;
}

const SETTINGS_KEY = 'loupe_workspace';
const MIC_ACK_KEY = 'loupe_mic_ack';
const WORKER_SETTINGS_KEY = 'loupe:settings';
const EXPORT_INDEX_KEY = 'loupe:exportIndex';
const SESSION_INDEX_KEY = 'loupe:sessionIndex';

export const DEFAULT_PROMPT_DEST = '~/Projects/.ai/tasks/build-prompt.md';

const DEFAULTS: LoupeSettings = {
  project: '',
  flow: '',
  promptDest: DEFAULT_PROMPT_DEST,
  revealOnExport: false,
  screenshotQuality: 'standard',
  theme: 'system',
};

export function loadSettings(): LoupeSettings {
  let stored: Partial<LoupeSettings> = {};
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch { /* corrupted blob — fall back to defaults */ }

  const s: LoupeSettings = { ...DEFAULTS, ...stored };

  // Migration: older blobs carried workspace + output dir instead of a single
  // destination. Derive one so existing users keep their configured location.
  if (!stored.promptDest && (stored.workspace || stored.output)) {
    const root = (stored.workspace || '~/Projects').replace(/\/+$/, '');
    const dir = (stored.output || '.ai/tasks').replace(/^\/+|\/+$/g, '');
    s.promptDest = dir ? `${root}/${dir}/build-prompt.md` : `${root}/build-prompt.md`;
  }
  return s;
}

export function saveSettings(s: LoupeSettings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  // Mirror what the worker needs into extension storage it can actually read.
  try {
    void chrome.storage.local.set({
      [WORKER_SETTINGS_KEY]: { screenshotQuality: s.screenshotQuality },
    });
  } catch { /* ignore */ }
}

export function micAcknowledged(): boolean {
  try { return localStorage.getItem(MIC_ACK_KEY) === '1'; } catch { return false; }
}

export function setMicAcknowledged(on: boolean): void {
  try {
    if (on) localStorage.setItem(MIC_ACK_KEY, '1');
    else localStorage.removeItem(MIC_ACK_KEY);
  } catch { /* ignore */ }
}

// ─── Theme ──────────────────────────────────────────────────────

export function applyTheme(theme: LoupeSettings['theme']): void {
  const dark = theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

// ─── Sessions ───────────────────────────────────────────────────

export interface SessionSummary {
  id: string;
  project: string;
  flow: string;
  timestamp: number;
  filename: string;
}

export async function listSessions(): Promise<SessionSummary[]> {
  try {
    const r = await chrome.storage.local.get(SESSION_INDEX_KEY);
    const idx = r[SESSION_INDEX_KEY];
    if (Array.isArray(idx) && idx.length > 0) return idx as SessionSummary[];
    // Empty index but sessions may exist from builds that predate the index —
    // rebuild it from the stored records once, then it stays maintained.
    return await rebuildSessionIndex();
  } catch {
    return [];
  }
}

interface StoredSessionRecord { filename?: string; data?: string; timestamp?: number }

function summaryFromRecord(id: string, rec: StoredSessionRecord): SessionSummary {
  // The payload opens with `"project"` and `"flow"` (LoupeSession field order),
  // so a head-slice regex avoids parsing a multi-MB JSON string just for two fields.
  const head = (rec.data || '').slice(0, 4000);
  const unesc = (s: string): string => {
    try { return JSON.parse(`"${s}"`) as string; } catch { return s; }
  };
  const project = /"project":\s*"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
  const flow = /"flow":\s*"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
  const tsFromName = Number(/-(\d{10,})\.loupe$/.exec(rec.filename || '')?.[1]);
  return {
    id,
    project: project !== undefined ? unesc(project) : '(unknown)',
    flow: flow !== undefined ? unesc(flow) : '',
    timestamp: rec.timestamp ?? (Number.isFinite(tsFromName) ? tsFromName : 0),
    filename: rec.filename || '',
  };
}

/** One-time recovery: rebuild the index from `loupe:session:*` records and
 *  promote a legacy `lastSession`-only capture to a keyed record. */
async function rebuildSessionIndex(): Promise<SessionSummary[]> {
  const SESSION_PREFIX = 'loupe:session:';
  const entries: SessionSummary[] = [];
  const writes: Record<string, unknown> = {};
  const seenFilenames = new Set<string>();

  // Prefer getKeys() (Chrome 130+) so we never hold every multi-MB payload at
  // once; fall back to get(null) on older Chrome.
  const getKeys = (chrome.storage.local as unknown as { getKeys?: () => Promise<string[]> }).getKeys;
  let sessionKeys: string[];
  let bulk: Record<string, unknown> | undefined;
  if (typeof getKeys === 'function') {
    sessionKeys = (await getKeys.call(chrome.storage.local)).filter(k => k.startsWith(SESSION_PREFIX));
  } else {
    bulk = (await chrome.storage.local.get(null)) as Record<string, unknown>;
    sessionKeys = Object.keys(bulk).filter(k => k.startsWith(SESSION_PREFIX));
  }

  for (const key of sessionKeys) {
    const rec = (bulk ? bulk[key] : (await chrome.storage.local.get(key))[key]) as StoredSessionRecord | undefined;
    if (!rec?.filename || typeof rec.data !== 'string') continue;
    entries.push(summaryFromRecord(key.slice(SESSION_PREFIX.length), rec));
    seenFilenames.add(rec.filename);
  }

  // Oldest builds wrote only `lastSession` — make it a first-class session.
  const lastR: Record<string, unknown> =
    bulk ?? ((await chrome.storage.local.get('lastSession')) as Record<string, unknown>);
  const last = lastR['lastSession'] as StoredSessionRecord | undefined;
  if (last?.filename && typeof last.data === 'string' && !seenFilenames.has(last.filename)) {
    const id = `legacy-${Number(/-(\d{10,})\.loupe$/.exec(last.filename)?.[1]) || Date.now()}`;
    writes[`${SESSION_PREFIX}${id}`] = last;
    entries.push(summaryFromRecord(id, last));
  }

  entries.sort((a, b) => b.timestamp - a.timestamp);
  const index = entries.slice(0, 20);
  if (index.length > 0) writes[SESSION_INDEX_KEY] = index;
  if (Object.keys(writes).length > 0) await chrome.storage.local.set(writes);
  return index;
}

/** Remove one captured session: its payload and its index entry. */
export async function deleteSession(id: string): Promise<void> {
  const sessions = await listSessions();
  await chrome.storage.local.set({
    [SESSION_INDEX_KEY]: sessions.filter(s => s.id !== id),
  });
  await chrome.storage.local.remove(`loupe:session:${id}`);
}

// ─── Exports ────────────────────────────────────────────────────

export interface ExportRecord {
  id: string;          // session id ('' for legacy lastSession exports)
  project: string;
  flow: string;
  filename: string;
  timestamp: number;   // when the export happened
  downloadId: number;  // chrome.downloads id, for reveal-in-folder
}

export async function listExports(): Promise<ExportRecord[]> {
  try {
    const r = await chrome.storage.local.get(EXPORT_INDEX_KEY);
    const idx = r[EXPORT_INDEX_KEY];
    return Array.isArray(idx) ? (idx as ExportRecord[]) : [];
  } catch {
    return [];
  }
}

async function recordExport(entry: ExportRecord): Promise<void> {
  const all = await listExports();
  // Newest first; re-exporting the same session replaces its previous record.
  const rest = all.filter(e => !(e.id && e.id === entry.id));
  await chrome.storage.local.set({ [EXPORT_INDEX_KEY]: [entry, ...rest].slice(0, 50) });
}

export async function removeExport(downloadId: number): Promise<void> {
  const all = await listExports();
  await chrome.storage.local.set({
    [EXPORT_INDEX_KEY]: all.filter(e => e.downloadId !== downloadId),
  });
}

// ─── Downloads ──────────────────────────────────────────────────

interface ExportMeta { id: string; project: string; flow: string }

/** Download a .loupe payload into ~/Downloads/loupe/ and record the export. */
export function triggerDownload(
  filename: string,
  data: string,
  meta: ExportMeta,
  opts: { reveal?: boolean } = {},
): Promise<number | null> {
  return new Promise((resolve) => {
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    // octet-stream, NOT application/json: Chrome rewrites unknown extensions
    // to match the MIME type, silently turning name.loupe into name.json —
    // which broke every copied CLI command referencing the .loupe filename.
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: `loupe/${safeName}`, saveAs: false }, (downloadId) => {
      URL.revokeObjectURL(url);
      if (typeof downloadId === 'number') {
        void recordExport({
          ...meta,
          filename: safeName,
          timestamp: Date.now(),
          downloadId,
        });
        if (opts.reveal) {
          try { chrome.downloads.show(downloadId); } catch { /* ignore */ }
        }
        resolve(downloadId);
      } else {
        resolve(null);
      }
    });
  });
}

export function revealDownload(downloadId: number): void {
  chrome.downloads.show(downloadId);
}

export function openDownloadsFolder(): void {
  chrome.downloads.showDefaultFolder();
}

// ─── Misc ───────────────────────────────────────────────────────

export function relativeTime(ts: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** The CLI command that turns a captured session into a build prompt. */
export function analyzeCommand(filename?: string): string {
  return filename
    ? `loupe analyze ~/Downloads/loupe/${filename}`
    : 'loupe analyze ~/Downloads/loupe/';
}

export type Intent = 'build' | 'review' | 'audit';

/** Intent → CLI command. The extension never runs pipelines itself; each card
 *  hands the user the one command that does what they asked for. */
export function intentCommand(intent: Intent, filename?: string): string {
  const file = filename ? `~/Downloads/loupe/${filename}` : '~/Downloads/loupe/<session>';
  switch (intent) {
    case 'build': return `loupe build-this ${file}`;
    case 'review': return `loupe review ${file}`;
    case 'audit': return `loupe audit ${file}`;
  }
}
