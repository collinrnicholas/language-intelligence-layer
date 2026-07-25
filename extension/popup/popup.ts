// ─── Loupe popup ─────────────────────────────────────────────────
//
// Four views: Capture (default) · Sessions · Exports · Settings.
// Loupe's job ends at the build prompt: no agent selection, no execution.
//
// All recording/export/recovery messaging with the worker is unchanged from
// the previous popup (START_RECORDING, STOP_RECORDING, REQUEST_STATE,
// GET_RECOVERABLE, RECOVER_*, REFRESH_AND_START).

import type { RecordingState } from '../src/types';
import {
  loadSettings, saveSettings, type LoupeSettings,
  micAcknowledged, setMicAcknowledged, applyTheme,
  listSessions, deleteSession, type SessionSummary,
  listExports, type ExportRecord,
  triggerDownload, revealDownload, openDownloadsFolder,
  relativeTime, analyzeCommand, intentCommand, type Intent,
} from './data';

// ─── DOM helpers ───────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// Header / nav / toast
const headerStatus = $('headerStatus');
const headerStatusText = $('headerStatusText');
const navEl = $('nav');
const msgEl = $('msg');

// Views + capture panels
const views: Record<string, HTMLElement> = {
  capture: $('viewCapture'),
  sessions: $('viewSessions'),
  exports: $('viewExports'),
  settings: $('viewSettings'),
};
const panels: Record<string, HTMLElement> = {
  permission: $('panelPermission'),
  ready: $('panelReady'),
  recording: $('panelRecording'),
  saved: $('panelSaved'),
  recovered: $('panelRecovered'),
};

// Capture: ready
const projectInput = $<HTMLInputElement>('project');
const flowInput = $<HTMLInputElement>('flow');
const btnRecordReady = $<HTMLButtonElement>('btnRecordReady');
const btnViewAllSessions = $<HTMLButtonElement>('btnViewAllSessions');
const recentList = $('recentList');

// Capture: recording
const recTimer = $('recTimer');
const recUrlDisplay = $('recUrlDisplay');
const recClicks = $('recClicks');
const recScreenshots = $('recScreenshots');
const recWarn = $('recWarn');
const recPauseBtn = $<HTMLButtonElement>('recPauseBtn');
const recStopBtn = $<HTMLButtonElement>('recStopBtn');
const recStopBtn2 = $<HTMLButtonElement>('recStopBtn2');
const recTargetBtn = $<HTMLButtonElement>('recTargetBtn');
const recTargetScreenBtn = $<HTMLButtonElement>('recTargetScreenBtn');
const recTargetHint = $('recTargetHint');
const recTargetStatus = $('recTargetStatus');
const recTargetPreview = $<HTMLImageElement>('recTargetPreview');

// Capture: saved
const savedProject = $('savedProject');
const savedFlow = $('savedFlow');
const savedDuration = $('savedDuration');
const savedClicks = $('savedClicks');
const savedScreenshots = $('savedScreenshots');
const savedDOM = $('savedDOM');
const savedNotes = $('savedNotes');
const btnIntentBuild = $<HTMLButtonElement>('btnIntentBuild');
const btnIntentReview = $<HTMLButtonElement>('btnIntentReview');
const btnIntentAudit = $<HTMLButtonElement>('btnIntentAudit');
const btnSavedExport = $<HTMLButtonElement>('btnSavedExport');
const btnRecordAnother = $<HTMLButtonElement>('btnRecordAnother');

// Capture: mic intro + recovery
const btnAllowMic = $<HTMLButtonElement>('btnAllowMic');
const btnDenyMic = $<HTMLButtonElement>('btnDenyMic');
const recoveredProject = $('recoveredProject');
const recoveredFlow = $('recoveredFlow');
const recoveredEvents = $('recoveredEvents');
const recoveredScreens = $('recoveredScreens');
const btnRecoverResume = $<HTMLButtonElement>('btnRecoverResume');
const btnRecoverExport = $<HTMLButtonElement>('btnRecoverExport');
const btnRecoverDiscard = $<HTMLButtonElement>('btnRecoverDiscard');

// Sessions
const sessionsSearch = $<HTMLInputElement>('sessionsSearch');
const sessionsProject = $<HTMLSelectElement>('sessionsProject');
const sessionsTime = $('sessionsTime');
const sessionsList = $('sessionsList');

// Exports
const exportsDestPath = $('exportsDestPath');
const btnExportsChangeDest = $<HTMLButtonElement>('btnExportsChangeDest');
const btnOpenDownloads = $<HTMLButtonElement>('btnOpenDownloads');
const exportsList = $('exportsList');

// Settings
const setPromptDest = $<HTMLInputElement>('setPromptDest');
const setRevealOnExport = $<HTMLInputElement>('setRevealOnExport');
const setQuality = $<HTMLSelectElement>('setQuality');
const setTheme = $<HTMLSelectElement>('setTheme');
const btnResetMicIntro = $<HTMLButtonElement>('btnResetMicIntro');
const btnCopyDiag = $<HTMLButtonElement>('btnCopyDiag');
const settingsVersion = $('settingsVersion');

// ─── State ─────────────────────────────────────────────────────

type Tab = 'capture' | 'sessions' | 'exports' | 'settings';
type CapturePanel = 'permission' | 'ready' | 'recording' | 'saved' | 'recovered';

let currentTab: Tab = 'capture';
let currentPanel: CapturePanel = 'ready';
let settings: LoupeSettings = loadSettings();
let timerInterval: ReturnType<typeof setInterval> | null = null;
let sessionStartTime: number | null = null;
let capturePoll: ReturnType<typeof setInterval> | null = null;
/** Most recent export from this popup instance — powers "Reveal .loupe Export". */
let lastExport: { downloadId: number; filename: string } | null = null;

// ─── Toast ─────────────────────────────────────────────────────

function showMsg(text: string, type: 'ok' | 'err' = 'ok') {
  msgEl.replaceChildren();
  msgEl.textContent = text;
  msgEl.className = `msg ${type}`;
  if (text) setTimeout(() => { msgEl.className = 'msg'; }, 4000);
  else msgEl.className = 'msg';
}

/** A message with an inline action button. Does not auto-clear. */
function showAction(text: string, label: string, onClick: () => void) {
  msgEl.replaceChildren();
  msgEl.className = 'msg err';
  msgEl.append(text + ' ');
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.style.cssText = 'margin-left:6px;padding:3px 9px;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;font:inherit;';
  btn.addEventListener('click', () => { showMsg(''); onClick(); });
  msgEl.append(btn);
}

function sendToBackground(msg: Record<string, unknown>) {
  return chrome.runtime.sendMessage(msg);
}

// ─── Navigation ────────────────────────────────────────────────

function showTab(tab: Tab) {
  currentTab = tab;
  Object.entries(views).forEach(([name, el]) => el.classList.toggle('active', name === tab));
  navEl.querySelectorAll<HTMLButtonElement>('.nav-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'sessions') void renderSessions();
  if (tab === 'exports') void renderExports();
  if (tab === 'settings') renderSettings();
}

navEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.nav-tab');
  if (btn?.dataset.tab) showTab(btn.dataset.tab as Tab);
});

function showPanel(panel: CapturePanel) {
  currentPanel = panel;
  Object.entries(panels).forEach(([name, el]) => el.classList.toggle('active', name === panel));
  updateHeaderStatus();
}

function updateHeaderStatus() {
  const captureTab = navEl.querySelector<HTMLButtonElement>('[data-tab="capture"]');
  const recording = currentPanel === 'recording';
  headerStatus.classList.toggle('rec', recording);
  captureTab?.classList.toggle('has-dot', recording);
  headerStatusText.textContent =
    recording ? 'Recording'
    : currentPanel === 'saved' ? 'Captured'
    : currentPanel === 'recovered' ? 'Recovered'
    : 'Ready';
}

// ─── Output destination (shown on Exports; edited in Settings) ─

function renderOutputCard() {
  exportsDestPath.textContent = settings.promptDest;
  exportsDestPath.title = settings.promptDest;
}

function goToOutputSetting() {
  showTab('settings');
  setPromptDest.focus();
  setPromptDest.select();
}

btnExportsChangeDest.addEventListener('click', goToOutputSetting);
btnViewAllSessions.addEventListener('click', () => showTab('sessions'));

// ─── Timer ─────────────────────────────────────────────────────

function startTimer(startMs?: number) {
  // Anchor to the worker's authoritative session start when known, so the
  // timer shows true duration regardless of when the popup mounted.
  sessionStartTime = startMs || Date.now();
  timerInterval = setInterval(() => {
    if (!sessionStartTime) return;
    const secs = Math.floor((Date.now() - sessionStartTime) / 1000);
    const mins = Math.floor(secs / 60);
    const hrs = Math.floor(mins / 60);
    recTimer.textContent =
      `${String(hrs).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  }, 250);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  sessionStartTime = null;
  recTimer.textContent = '00:00:00';
}

// ─── Capture poll ──────────────────────────────────────────────

function startCapturePoll() {
  stopCapturePoll();
  const tick = async () => {
    try {
      const resp: any = await sendToBackground({ type: 'REQUEST_STATE' });
      if (resp && currentPanel === 'recording') {
        if (resp.startTime) sessionStartTime = resp.startTime;
        recClicks.textContent = String(resp.clicks || 0);
        recScreenshots.textContent = String(resp.screenshots || 0);
        if (resp.url) recUrlDisplay.textContent = resp.url;
        reflectTargetCaptured(!!resp.hasTarget);
        maybeWarnNotCapturing(resp);
      }
    } catch { /* ignore */ }
  };
  void tick();
  capturePoll = setInterval(tick, 500);
}

function stopCapturePoll() {
  if (capturePoll) { clearInterval(capturePoll); capturePoll = null; }
  hideRecWarn();
}

// If the session has been running for a few seconds with zero events while
// screenshots ARE accruing, the content script isn't capturing — surface a
// warning with a one-click refresh-and-restart.
const STUCK_AFTER_MS = 5000;
let recWarnShown = false;

function maybeWarnNotCapturing(resp: { startTime?: number; eventsCount?: number; screenshots?: number }) {
  const elapsed = resp.startTime ? Date.now() - resp.startTime : 0;
  const stuck = elapsed >= STUCK_AFTER_MS && (resp.eventsCount || 0) === 0 && (resp.screenshots || 0) > 0;
  if (stuck) showRecWarn(); else hideRecWarn();
}

function showRecWarn() {
  if (recWarnShown) return;
  recWarnShown = true;
  recWarn.replaceChildren();
  recWarn.style.cssText = 'margin:0 0 12px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.4;background:var(--danger-tint);border:1px solid var(--danger);color:var(--danger);';
  recWarn.append('⚠️ Not capturing this page — no events are being recorded. Refresh to fix (this restarts the recording). ');
  const btn = document.createElement('button');
  btn.textContent = 'Refresh & restart';
  btn.style.cssText = 'margin-top:6px;padding:4px 10px;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;font:inherit;';
  btn.addEventListener('click', refreshAndRecord);
  recWarn.append(btn);
  recWarn.hidden = false;
}

function hideRecWarn() {
  if (!recWarnShown) return;
  recWarnShown = false;
  recWarn.replaceChildren();
  recWarn.hidden = true;
}

// ─── Export helpers ────────────────────────────────────────────

async function exportLastSession(): Promise<void> {
  const result = await chrome.storage.local.get('lastSession');
  if (!result.lastSession) { showMsg('No captured session to export', 'err'); return; }
  const { filename, data } = result.lastSession as { filename: string; data: string };
  const downloadId = await triggerDownload(
    filename, data,
    { id: filename, project: settings.project, flow: settings.flow },
    { reveal: settings.revealOnExport },
  );
  if (downloadId !== null) lastExport = { downloadId, filename: filename.replace(/[^a-zA-Z0-9._-]/g, '_') };
}

async function exportSessionById(s: SessionSummary): Promise<void> {
  const result = await chrome.storage.local.get(`loupe:session:${s.id}`);
  const rec = result[`loupe:session:${s.id}`] as { filename: string; data: string } | undefined;
  if (!rec) { showMsg('Session not found', 'err'); return; }
  const downloadId = await triggerDownload(
    rec.filename, rec.data,
    { id: s.id, project: s.project, flow: s.flow },
    { reveal: settings.revealOnExport },
  );
  if (downloadId !== null) {
    lastExport = { downloadId, filename: rec.filename.replace(/[^a-zA-Z0-9._-]/g, '_') };
    showMsg('Exported to ~/Downloads/loupe/', 'ok');
  }
}

// ─── Recent sessions (Capture view) ────────────────────────────

function emptyState(big: string, sub: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'empty-state';
  const b = document.createElement('div');
  b.className = 'big';
  b.textContent = big;
  const s = document.createElement('div');
  s.textContent = sub;
  div.append(b, s);
  return div;
}

async function renderRecent() {
  const sessions = await listSessions();
  recentList.replaceChildren();
  if (sessions.length === 0) {
    recentList.append(emptyState('No sessions yet', 'Your captured sessions will appear here.'));
    return;
  }
  for (const s of sessions.slice(0, 3)) {
    const row = document.createElement('div');
    row.className = 'row-line';
    const main = document.createElement('div');
    main.className = 'row-main';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${s.project} · ${s.flow}`;
    main.append(name);
    const time = document.createElement('span');
    time.className = 'row-time';
    time.textContent = relativeTime(s.timestamp);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const exp = document.createElement('button');
    exp.className = 'link-btn';
    exp.textContent = 'Export';
    exp.addEventListener('click', () => void exportSessionById(s));
    actions.append(exp);
    row.append(main, time, actions);
    recentList.append(row);
  }
}

// ─── Sessions view ─────────────────────────────────────────────

let sessionsCache: SessionSummary[] = [];
let exportedIds = new Set<string>();

type TimeRange = 'all' | 'today' | 'week' | 'month';
let sessionsRange: TimeRange = 'all';

/** Calendar-based cutoff: midnight today / Monday this week / 1st this month. */
function rangeCutoff(range: TimeRange): number {
  if (range === 'all') return 0;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range === 'week') {
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dow);
  } else if (range === 'month') {
    d.setDate(1);
  }
  return d.getTime();
}

async function renderSessions() {
  sessionsCache = await listSessions();
  exportedIds = new Set((await listExports()).map(e => e.id));

  // Project filter options (preserve selection when possible)
  const selected = sessionsProject.value;
  const projects = [...new Set(sessionsCache.map(s => s.project))].sort();
  sessionsProject.replaceChildren(new Option('All projects', ''));
  for (const p of projects) sessionsProject.append(new Option(p, p));
  if (projects.includes(selected)) sessionsProject.value = selected;

  renderSessionsList();
}

function renderSessionsList() {
  const q = sessionsSearch.value.trim().toLowerCase();
  const proj = sessionsProject.value;
  const cutoff = rangeCutoff(sessionsRange);
  const filtered = sessionsCache.filter(s =>
    s.timestamp >= cutoff &&
    (!proj || s.project === proj) &&
    (!q || `${s.project} ${s.flow}`.toLowerCase().includes(q)));

  sessionsList.replaceChildren();
  if (filtered.length === 0) {
    sessionsList.append(emptyState(
      sessionsCache.length === 0 ? 'No sessions yet' : 'No matching sessions',
      sessionsCache.length === 0
        ? 'Record a session from the Capture tab to get started.'
        : 'Try a different search or project filter.'));
    return;
  }

  for (const s of filtered) {
    const row = document.createElement('div');
    row.className = 'row-line';

    // Project and flow stacked — matches the Capture form's layout.
    const main = document.createElement('div');
    main.className = 'row-main';
    main.title = s.filename;
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.project;
    const sub = document.createElement('div');
    sub.className = 'sub plain';
    sub.textContent = s.flow;
    main.append(name, sub);

    const chip = document.createElement('span');
    chip.className = exportedIds.has(s.id) ? 'chip ok' : 'chip';
    chip.textContent = exportedIds.has(s.id) ? 'Exported' : 'Captured';

    const time = document.createElement('span');
    time.className = 'row-time';
    time.textContent = relativeTime(s.timestamp);

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const exp = document.createElement('button');
    exp.className = 'link-btn';
    exp.textContent = 'Export';
    exp.addEventListener('click', async () => {
      await exportSessionById(s);
      void renderSessions();
    });

    const del = document.createElement('button');
    del.className = 'link-btn danger';
    del.textContent = 'Delete';
    // Two-step confirm — no blocking dialogs inside a popup.
    del.addEventListener('click', async () => {
      if (del.dataset.confirm !== '1') {
        del.dataset.confirm = '1';
        del.textContent = 'Confirm?';
        setTimeout(() => { del.dataset.confirm = ''; del.textContent = 'Delete'; }, 2500);
        return;
      }
      await deleteSession(s.id);
      showMsg('Session deleted', 'ok');
      void renderSessions();
      void renderRecent();
    });

    actions.append(exp, del);
    row.append(main, chip, time, actions);
    sessionsList.append(row);
  }
}

sessionsSearch.addEventListener('input', renderSessionsList);
sessionsProject.addEventListener('change', renderSessionsList);

sessionsTime.addEventListener('click', (e) => {
  const pill = (e.target as HTMLElement).closest<HTMLButtonElement>('.filter-pill');
  if (!pill?.dataset.range) return;
  sessionsRange = pill.dataset.range as TimeRange;
  sessionsTime.querySelectorAll('.filter-pill').forEach(p =>
    p.classList.toggle('active', p === pill));
  renderSessionsList();
});

// ─── Exports view ──────────────────────────────────────────────

async function renderExports() {
  renderOutputCard();
  const exports = await listExports();
  exportsList.replaceChildren();

  if (exports.length === 0) {
    exportsList.append(emptyState(
      'Nothing exported yet',
      'Stop a recording or export a session — the .loupe file lands in ~/Downloads/loupe/.'));
    return;
  }

  for (const e of exports) {
    const row = document.createElement('div');
    row.className = 'row-line';

    const main = document.createElement('div');
    main.className = 'row-main';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${e.project} · ${e.flow}`;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = e.filename;
    main.append(name, sub);

    const time = document.createElement('span');
    time.className = 'row-time';
    time.textContent = relativeTime(e.timestamp);

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const reveal = document.createElement('button');
    reveal.className = 'link-btn';
    reveal.textContent = 'Reveal';
    reveal.addEventListener('click', () => {
      try { revealDownload(e.downloadId); } catch { showMsg('File no longer in downloads', 'err'); }
    });

    const cmd = document.createElement('button');
    cmd.className = 'link-btn';
    cmd.textContent = 'Copy CLI';
    cmd.title = 'Copy the loupe analyze command for this session';
    cmd.addEventListener('click', () => {
      void navigator.clipboard?.writeText(analyzeCommand(e.filename));
      showMsg('Command copied — run it in your terminal', 'ok');
    });

    actions.append(reveal, cmd);
    row.append(main, time, actions);
    exportsList.append(row);
  }
}

btnOpenDownloads.addEventListener('click', () => openDownloadsFolder());

// ─── Settings view ─────────────────────────────────────────────

function renderSettings() {
  setPromptDest.value = settings.promptDest;
  setRevealOnExport.checked = settings.revealOnExport;
  setQuality.value = settings.screenshotQuality;
  setTheme.value = settings.theme;
}

function persistSettings(note = 'Saved') {
  saveSettings(settings);
  renderOutputCard();
  showMsg(note, 'ok');
}

setPromptDest.addEventListener('change', () => {
  settings.promptDest = setPromptDest.value.trim() || settings.promptDest;
  setPromptDest.value = settings.promptDest;
  persistSettings('Build prompt destination saved');
});

setRevealOnExport.addEventListener('change', () => {
  settings.revealOnExport = setRevealOnExport.checked;
  persistSettings();
});

setQuality.addEventListener('change', () => {
  settings.screenshotQuality = setQuality.value === 'high' ? 'high' : 'standard';
  persistSettings('Applies from the next recording');
});

setTheme.addEventListener('change', () => {
  settings.theme = (setTheme.value as LoupeSettings['theme']) || 'system';
  applyTheme(settings.theme);
  persistSettings();
});

btnResetMicIntro.addEventListener('click', () => {
  setMicAcknowledged(false);
  showMsg('The narration intro will show next time', 'ok');
});

btnCopyDiag.addEventListener('click', () => {
  const manifest = chrome.runtime.getManifest();
  const diag = [
    `Loupe ${(manifest as { version_name?: string }).version_name || manifest.version}`,
    navigator.userAgent,
  ].join('\n');
  void navigator.clipboard?.writeText(diag);
  showMsg('Diagnostics copied', 'ok');
});

// ─── Recovery ──────────────────────────────────────────────────

async function checkRecoverable(): Promise<boolean> {
  try {
    const resp: any = await sendToBackground({ type: 'GET_RECOVERABLE' });
    const r = resp?.recoverable;
    if (!r) return false;
    recoveredProject.textContent = r.project || '—';
    recoveredFlow.textContent = r.flow || '—';
    recoveredEvents.textContent = String(r.events || 0);
    recoveredScreens.textContent = String(r.screenshots || 0);
    showPanel('recovered');
    return true;
  } catch {
    return false;
  }
}

btnRecoverResume.addEventListener('click', async () => {
  const resp: any = await sendToBackground({ type: 'RECOVER_RESUME' }).catch(() => null);
  if (resp?.ok) {
    settings.project = resp.project || settings.project;
    settings.flow = resp.flow || settings.flow;
    showPanel('recording');
    startTimer();
    startCapturePoll();
  } else {
    showMsg('Could not resume recording', 'err');
  }
});

btnRecoverExport.addEventListener('click', async () => {
  const resp: any = await sendToBackground({ type: 'RECOVER_EXPORT' }).catch(() => null);
  if (resp?.ok) {
    await exportLastSession();
    showMsg('Recovered session exported', 'ok');
    showPanel('ready');
  } else {
    showMsg('Export failed', 'err');
  }
});

// Discard only runs on this explicit click — Loupe never auto-discards a session.
btnRecoverDiscard.addEventListener('click', async () => {
  await sendToBackground({ type: 'RECOVER_DISCARD' }).catch(() => null);
  showMsg('Recovered recording discarded', 'ok');
  showPanel('ready');
});

// ─── Mic intro ─────────────────────────────────────────────────

btnAllowMic.addEventListener('click', () => { setMicAcknowledged(true); showPanel('ready'); });
btnDenyMic.addEventListener('click', () => { setMicAcknowledged(true); showPanel('ready'); });

// ─── Record flow ───────────────────────────────────────────────

btnRecordReady.addEventListener('click', async () => {
  const project = projectInput.value.trim();
  const flow = flowInput.value.trim();
  if (!project || !flow) { showMsg('Enter project and flow first', 'err'); return; }

  settings.project = project;
  settings.flow = flow;
  saveSettings(settings);

  const resp: any = await sendToBackground({ type: 'START_RECORDING', project, flow }).catch(() => null);
  if (resp?.ok) {
    enterRecordingView();
  } else if (resp?.needsRefresh) {
    showAction('This page needs a refresh before Loupe can record it.', 'Refresh & record', refreshAndRecord);
  } else {
    showMsg('Failed to start recording', 'err');
  }
});

function enterRecordingView() {
  hideRecWarn();
  showTab('capture');
  showPanel('recording');
  startTimer();
  startCapturePoll();
}

async function refreshAndRecord() {
  const project = projectInput.value.trim();
  const flow = flowInput.value.trim();
  if (!project || !flow) { showMsg('Enter project and flow first', 'err'); return; }
  showMsg('Refreshing page…', 'ok');
  const resp: any = await sendToBackground({ type: 'REFRESH_AND_START', project, flow }).catch(() => null);
  if (resp?.ok) {
    enterRecordingView();
  } else if (resp?.needsRefresh) {
    showMsg('Still can’t attach — this page may block extensions.', 'err');
  } else {
    showMsg('Couldn’t start recording after refresh.', 'err');
  }
}

recPauseBtn.addEventListener('click', async () => {
  if (recPauseBtn.textContent === 'Pause') {
    await sendToBackground({ type: 'PAUSE_RECORDING' });
    recPauseBtn.textContent = 'Resume';
  } else {
    await sendToBackground({ type: 'RESUME_RECORDING' });
    recPauseBtn.textContent = 'Pause';
  }
});

/** Whether the popup has already loaded the preview for the current target. */
let targetPreviewShown = false;

/** Reflect whether the active session already carries a target design. */
function reflectTargetCaptured(has: boolean) {
  recTargetStatus.hidden = !has;
  recTargetHint.hidden = has;
  recTargetBtn.textContent = has ? 'Recapture Target Screenshot' : 'Capture Target Screenshot';
  if (has && !targetPreviewShown) {
    targetPreviewShown = true;
    void loadTargetPreview();
  } else if (!has) {
    targetPreviewShown = false;
    recTargetPreview.hidden = true;
    recTargetPreview.removeAttribute('src');
  }
}

/** Fetch the captured target image and show it as a confirm preview. */
async function loadTargetPreview() {
  try {
    const resp: any = await sendToBackground({ type: 'GET_TARGET' });
    if (resp?.dataUrl) {
      recTargetPreview.src = resp.dataUrl;
      recTargetPreview.hidden = false;
    }
  } catch { /* ignore — preview is best-effort */ }
}

/**
 * Shared capture flow for both target buttons. The desktop picker can close the
 * popup when the OS grabs focus — the background still stores the shot, so on
 * reopen the poll reflects it. We handle the in-popup response when it survives.
 */
async function captureTarget(
  btn: HTMLButtonElement,
  msgType: 'CAPTURE_TARGET' | 'CAPTURE_TARGET_SCREEN',
  failMsg: string,
) {
  recTargetBtn.disabled = true;
  recTargetScreenBtn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Capturing…';
  try {
    const resp: any = await sendToBackground({ type: msgType });
    if (resp?.ok) {
      reflectTargetCaptured(true);
      void loadTargetPreview(); // refresh preview even on recapture
      showMsg('Target design captured', 'ok');
    } else if (resp?.error === 'no-session') {
      showMsg('Start recording before capturing a target', 'err');
    } else if (resp?.error === 'cancelled') {
      // User dismissed the picker — no-op, no error noise.
    } else if (resp?.error === 'timeout') {
      showMsg('Capture timed out — try again and pick the source', 'err');
    } else {
      showMsg(failMsg, 'err');
    }
  } catch {
    // Popup likely closed while the picker was open; the background finishes and
    // stores the target regardless. Don't surface an error for that case.
  } finally {
    btn.textContent = prev;
    recTargetBtn.disabled = false;
    recTargetScreenBtn.disabled = false;
  }
}

recTargetBtn.addEventListener('click', () =>
  captureTarget(recTargetBtn, 'CAPTURE_TARGET', "This tab can't be captured — open your target in a normal web tab"));

recTargetScreenBtn.addEventListener('click', () =>
  captureTarget(recTargetScreenBtn, 'CAPTURE_TARGET_SCREEN', "Couldn't capture that source — try again and pick a window or screen"));

async function handleStop() {
  recStopBtn.disabled = true;
  recStopBtn2.disabled = true;
  recPauseBtn.disabled = true;
  stopTimer();
  stopCapturePoll();

  let resp: any = null;
  try { resp = await sendToBackground({ type: 'STOP_RECORDING' }); } catch { /* ignore */ }

  if (resp?.ok) {
    const s = resp.stats || {};
    savedProject.textContent = settings.project || projectInput.value.trim() || '—';
    savedFlow.textContent = settings.flow || flowInput.value.trim() || '—';
    savedDuration.textContent = `(${Math.floor((s.duration || 0) / 1000)}s)`;
    savedClicks.textContent = String(Math.max(0, (s.events || 0) - (s.domSnapshots || 0)));
    savedScreenshots.textContent = String(s.screenshots || 0);
    savedDOM.textContent = String(s.domSnapshots || 0);
    savedNotes.textContent = String(s.notes || 0);
    showPanel('saved');
    await exportLastSession();
    void renderRecent();
  } else {
    showMsg('Save failed', 'err');
    recStopBtn.disabled = false;
    recStopBtn2.disabled = false;
    recPauseBtn.disabled = false;
  }
  recStopBtn.disabled = false;
  recStopBtn2.disabled = false;
  recPauseBtn.disabled = false;
  recPauseBtn.textContent = 'Pause';
}

recStopBtn.addEventListener('click', handleStop);
recStopBtn2.addEventListener('click', handleStop);

// ─── Saved actions (intent cards) ──────────────────────────────
//
// The popup can't run the CLI — each card copies the one command that does
// what the user asked for, so the terminal step is paste-and-go.

function copyIntent(intent: Intent) {
  const cmd = intentCommand(intent, lastExport?.filename);
  void navigator.clipboard?.writeText(cmd);
  // Distinguish input from output: the copied command references the
  // RECORDING (~/Downloads/loupe/); the generated prompt lands at the
  // configured destination (default ~/Downloads/loupe-prompts/).
  showMsg(
    intent === 'build'
      ? 'Copied — paste in your terminal. The build prompt will be written to ~/Downloads/loupe-prompts/.'
      : `Copied — paste in your terminal: ${cmd}`,
    'ok',
  );
}

btnIntentBuild.addEventListener('click', () => copyIntent('build'));
btnIntentReview.addEventListener('click', () => copyIntent('review'));
btnIntentAudit.addEventListener('click', () => copyIntent('audit'));

btnSavedExport.addEventListener('click', () => {
  // The session auto-exports on stop — this reveals it (or falls back to the folder).
  if (lastExport) {
    try { revealDownload(lastExport.downloadId); return; } catch { /* fall through */ }
  }
  openDownloadsFolder();
});

btnRecordAnother.addEventListener('click', () => showPanel('ready'));

// ─── Worker state sync ─────────────────────────────────────────

async function requestState() {
  try {
    const resp: any = await sendToBackground({ type: 'REQUEST_STATE' });
    if (!resp) return;
    const state: RecordingState = resp.state || 'idle';

    if (state === 'recording' && currentPanel !== 'recording' && currentPanel !== 'saved') {
      startTimer(resp.startTime);
      startCapturePoll();
      showPanel('recording');
    } else if (state === 'idle' && currentPanel === 'recording') {
      stopTimer();
      stopCapturePoll();
      showPanel('ready');
    }
  } catch { /* ignore */ }
}

// ─── Init ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  settings = loadSettings();
  applyTheme(settings.theme);
  // Keep the worker's mirror fresh (covers users upgrading from older builds).
  saveSettings(settings);

  if (settings.project) projectInput.value = settings.project;
  if (settings.flow) flowInput.value = settings.flow;
  renderOutputCard();
  renderSettings();
  void renderRecent();

  // Version stays out of the chrome — chrome://extensions is the place for it.
  // The Settings→Advanced line keeps it purely for diagnostics.
  const manifest = chrome.runtime.getManifest();
  const version = 'v' + ((manifest as { version_name?: string }).version_name || manifest.version);
  settingsVersion.textContent = `Loupe ${version}`;

  // An interrupted recording takes priority over the normal flow.
  if (await checkRecoverable()) return;

  showPanel(micAcknowledged() ? 'ready' : 'permission');
  void requestState();
});

// React to OS theme changes while in system mode.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings.theme === 'system') applyTheme('system');
});

setInterval(requestState, 3000);
