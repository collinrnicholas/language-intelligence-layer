// ─── Project memory — store ──────────────────────────────────────
//
// Local, file-based, and ALWAYS reconstructible from runs/ (that guarantee
// doubles as the delete guarantee — remove a run, re-index, and every derived
// trace is gone). See docs/SESSION_MEMORY_SPIKE.md.
//
//   ~/.loupe/projects/<p>/memory/
//     manifest.json        — counters + rolling product frame
//     sessions.jsonl       — one line per analyzed run
//     opportunities.jsonl  — append-only lifecycle events (latest per key wins)
//     preferences.json     — explicit + inferred preferences (hint/pattern/rule)
//     memory-digest.md     — the ONLY artifact prompts ever read (digest.ts)
//
// Patterns are NOT stored — they are derived from opportunities.jsonl at
// digest time, so they can never drift from ground truth.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LoupeSession, Opportunity, OpportunityCategory, OpportunitySeverity } from '../cli.js';
import type { SessionUnderstanding } from '../ai/session-understanding.js';
import { parseSessionInput } from '../schema.js';
import { projectRoot, makeRunId } from '../paths.js';
import { findingSignature } from './signature.js';

export const MEMORY_SCHEMA_VERSION = 1;

// ─── Types ──────────────────────────────────────────────────────

export interface ProjectMemoryManifest {
  schemaVersion: number;
  project: string;
  createdAt: string;
  sessionCount: number;
  lastRunId: string | null;
  digestUpdatedAt: string | null;
  productFrame: { understanding: SessionUnderstanding; agreeingRuns: number } | null;
}

export interface SessionIndexEntry {
  runId: string;
  intent: 'review' | 'audit' | 'build-fast';
  flow: string;
  /** Origin + pathname only — never query strings or fragments (privacy). */
  origin: string;
  findingCounts: Partial<Record<OpportunitySeverity, number>>;
  narratedCount: number;
  at: string;
}

export type OpportunityEvent =
  | 'observed' | 'narrated' | 'built' | 'accepted' | 'rejected' | 'verified' | 'regressed';

export interface OpportunityMemoryEntry {
  key: string;                 // recurrence signature — stable across runs
  runId: string;
  findingId: string;
  event: OpportunityEvent;
  category: OpportunityCategory;
  severity: OpportunitySeverity;
  title: string;
  quote?: string;
  why?: string;
  at: string;
}

export type PreferenceStrength = 'hint' | 'pattern' | 'rule';

export interface PreferenceEntry {
  id: string;
  statement: string;
  source: 'explicit' | 'rejection';
  /** Stored strength. Effective strength is computed at digest time with decay. */
  strength: PreferenceStrength;
  evidence: string[];          // finding keys or run ids that justify it
  lastSeenRunId: string | null;
  at: string;
}

// ─── Paths ──────────────────────────────────────────────────────

export function memoryDir(project: string): string {
  return join(projectRoot(project), 'memory');
}
const manifestPath = (p: string) => join(memoryDir(p), 'manifest.json');
const sessionsPath = (p: string) => join(memoryDir(p), 'sessions.jsonl');
const opportunitiesPath = (p: string) => join(memoryDir(p), 'opportunities.jsonl');
const preferencesPath = (p: string) => join(memoryDir(p), 'preferences.json');
export const digestPath = (p: string) => join(memoryDir(p), 'memory-digest.md');

// ─── Low-level IO (torn/corrupt lines are skipped, never fatal — ADR-008 spirit) ──

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function readJsonl<T>(path: string, valid: (x: unknown) => x is T): T[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => { try { return JSON.parse(l) as unknown; } catch { return null; } })
      .filter(valid);
  } catch {
    return [];
  }
}

// ─── Runtime validators — malformed-but-parseable lines must not reach
//     derivePatterns()/digest generation (same quarantine spirit as ADR-008) ──

function isSessionEntry(x: unknown): x is SessionIndexEntry {
  const v = x as SessionIndexEntry;
  return !!v && typeof v === 'object'
    && typeof v.runId === 'string' && v.runId.length > 0
    && typeof v.flow === 'string'
    && typeof v.at === 'string'
    && (v.intent === 'review' || v.intent === 'audit' || v.intent === 'build-fast');
}

const OPPORTUNITY_EVENTS: readonly string[] =
  ['observed', 'narrated', 'built', 'accepted', 'rejected', 'verified', 'regressed'];

function isOpportunityEntry(x: unknown): x is OpportunityMemoryEntry {
  const v = x as OpportunityMemoryEntry;
  return !!v && typeof v === 'object'
    && typeof v.key === 'string' && v.key.length > 0
    && typeof v.runId === 'string'
    && typeof v.findingId === 'string'
    && typeof v.title === 'string'
    && typeof v.at === 'string'
    && OPPORTUNITY_EVENTS.includes(v.event as string);
}

function isPreferenceEntry(x: unknown): x is PreferenceEntry {
  const v = x as PreferenceEntry;
  return !!v && typeof v === 'object'
    && typeof v.id === 'string'
    && typeof v.statement === 'string' && v.statement.length > 0
    && (v.source === 'explicit' || v.source === 'rejection')
    && (v.strength === 'hint' || v.strength === 'pattern' || v.strength === 'rule')
    && Array.isArray(v.evidence);
}

function appendJsonl(path: string, entries: unknown[]): void {
  if (entries.length === 0) return;
  mkdirSync(memoryDirOf(path), { recursive: true });
  appendFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

function memoryDirOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

// ─── Manifest ───────────────────────────────────────────────────

export function loadManifest(project: string): ProjectMemoryManifest {
  return readJson(manifestPath(project), {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    project,
    createdAt: new Date().toISOString(),
    sessionCount: 0,
    lastRunId: null,
    digestUpdatedAt: null,
    productFrame: null,
  });
}

export function saveManifest(project: string, m: ProjectMemoryManifest): void {
  mkdirSync(memoryDir(project), { recursive: true });
  writeFileSync(manifestPath(project), JSON.stringify(m, null, 2), 'utf-8');
}

export function loadSessions(project: string): SessionIndexEntry[] {
  return readJsonl(sessionsPath(project), isSessionEntry);
}

export function loadOpportunityEvents(project: string): OpportunityMemoryEntry[] {
  return readJsonl(opportunitiesPath(project), isOpportunityEntry);
}

export function loadPreferences(project: string): PreferenceEntry[] {
  return readJson<unknown[]>(preferencesPath(project), []).filter(isPreferenceEntry);
}

export function savePreferences(project: string, prefs: PreferenceEntry[]): void {
  mkdirSync(memoryDir(project), { recursive: true });
  writeFileSync(preferencesPath(project), JSON.stringify(prefs, null, 2), 'utf-8');
}

// ─── Write hooks ────────────────────────────────────────────────

function stripUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return '';
  }
}

/** Called at the end of analyzeSession(): index the run + log finding events. */
export function recordAnalyzeRun(
  session: LoupeSession,
  runId: string,
  intent: 'review' | 'audit',
  findings: Opportunity[],
  understanding: SessionUnderstanding | null,
): void {
  const project = session.project;
  const at = new Date().toISOString();

  const counts: Partial<Record<OpportunitySeverity, number>> = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  const entry: SessionIndexEntry = {
    runId,
    intent,
    flow: session.flow,
    origin: stripUrl(session.urlTimeline[0]?.url),
    findingCounts: counts,
    narratedCount: findings.filter(f => f.narrated).length,
    at,
  };
  appendJsonl(sessionsPath(project), [entry]);

  const events: OpportunityMemoryEntry[] = findings.map(f => ({
    key: findingSignature(f),
    runId,
    findingId: f.id,
    event: f.narrated ? 'narrated' : 'observed',
    category: f.category,
    severity: f.severity,
    title: f.title.slice(0, 120),
    ...(f.narrated && typeof f.narrationNote === 'number'
      ? { quote: session.notes[f.narrationNote]?.text?.trim()?.slice(0, 200) }
      : {}),
    at,
  }));
  appendJsonl(opportunitiesPath(project), events);

  const manifest = loadManifest(project);
  manifest.sessionCount += 1;
  manifest.lastRunId = runId;
  if (understanding) {
    const prev = manifest.productFrame;
    // Agreement is fuzzy on purpose: models rephrase ("AI document assistant"
    // vs "AI Document Assistant for bids"). Same normalized productType OR the
    // same normalized primaryJob counts as the same frame.
    const agrees = !!prev && (
      normalizeFrameText(prev.understanding.productType) === normalizeFrameText(understanding.productType) ||
      normalizeFrameText(prev.understanding.primaryJob) === normalizeFrameText(understanding.primaryJob)
    );
    manifest.productFrame = {
      understanding,
      agreeingRuns: agrees ? prev.agreeingRuns + 1 : 1,
    };
  }
  saveManifest(project, manifest);
}

function normalizeFrameText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Called from the Build This FAST path — there is no analysis run directory,
 * so the run id is synthesized (`build-fast-<ts>`) and the session line +
 * built events keep memory aware of packages produced without a review.
 * rebuildFromRuns() preserves these events (their run never exists on disk).
 */
export function recordFastBuild(
  session: LoupeSession,
  findings: Opportunity[],
): string {
  const runId = `build-fast-${makeRunId()}`;
  const at = new Date().toISOString();
  const counts: Partial<Record<OpportunitySeverity, number>> = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  appendJsonl(sessionsPath(session.project), [{
    runId,
    intent: 'build-fast',
    flow: session.flow,
    origin: stripUrl(session.urlTimeline[0]?.url),
    findingCounts: counts,
    narratedCount: 0,
    at,
  } satisfies SessionIndexEntry]);
  recordBuilt(session.project, runId, findings);
  return runId;
}

/** Called from build-this when findings enter a package. */
export function recordBuilt(
  project: string,
  runId: string,
  findings: Array<Pick<Opportunity, 'id' | 'category' | 'severity' | 'title'> & Partial<Opportunity>>,
): void {
  const at = new Date().toISOString();
  appendJsonl(opportunitiesPath(project), findings.map(f => ({
    key: findingSignature(f as Opportunity),
    runId,
    findingId: f.id,
    event: 'built' as const,
    category: f.category,
    severity: f.severity,
    title: f.title.slice(0, 120),
    at,
  })));
}

/** The human feedback verb behind `loupe memory mark`. Returns the entry, or
 *  null when the run/finding can't be found in the run's artifact. */
export function markOpportunity(
  project: string,
  runId: string,
  findingId: string,
  event: 'accepted' | 'rejected' | 'verified',
  why?: string,
): OpportunityMemoryEntry | null {
  const artifactPath = join(projectRoot(project), 'runs', runId, 'analysis', 'opportunities.json');
  const artifact = readJson<{ opportunities?: Opportunity[] }>(artifactPath, {});
  const finding = artifact.opportunities?.find(f => f.id === findingId);
  if (!finding) return null;

  const entry: OpportunityMemoryEntry = {
    key: findingSignature(finding),
    runId,
    findingId,
    event,
    category: finding.category,
    severity: finding.severity,
    title: finding.title.slice(0, 120),
    ...(why ? { why } : {}),
    at: new Date().toISOString(),
  };
  appendJsonl(opportunitiesPath(project), [entry]);

  // A rejection with a stated reason seeds an inferred preference (hint).
  // Repeated signals promote it — see effectiveStrength() in digest.ts.
  if (event === 'rejected' && why) {
    const prefs = loadPreferences(project);
    const existing = prefs.find(p => p.source === 'rejection' && p.statement === why);
    if (existing) {
      if (!existing.evidence.includes(entry.key)) existing.evidence.push(entry.key);
      existing.lastSeenRunId = runId;
    } else {
      prefs.push({
        id: `pref-${randomUUID()}`,
        statement: why,
        source: 'rejection',
        strength: 'hint',
        evidence: [entry.key],
        lastSeenRunId: runId,
        at: entry.at,
      });
    }
    savePreferences(project, prefs);
  }
  return entry;
}

/** Explicit preference (`loupe memory prefer`). `rule` skips promotion. */
export function addPreference(project: string, statement: string, rule: boolean): PreferenceEntry {
  const prefs = loadPreferences(project);
  const entry: PreferenceEntry = {
    id: `pref-${randomUUID()}`,
    statement: statement.trim(),
    source: 'explicit',
    strength: rule ? 'rule' : 'hint',
    evidence: [],
    lastSeenRunId: loadManifest(project).lastRunId,
    at: new Date().toISOString(),
  };
  prefs.push(entry);
  savePreferences(project, prefs);
  return entry;
}

// ─── Rebuild (loupe memory index) ───────────────────────────────

/**
 * Rebuild sessions.jsonl + opportunities.jsonl + manifest from runs/ ground
 * truth. Lifecycle events that only exist in memory (accepted/rejected/
 * verified from `mark`) are preserved by re-appending them after the rebuild —
 * unless their run no longer exists (deleting a run deletes its traces).
 */
export function rebuildFromRuns(project: string): { runs: number; events: number } {
  const runsDir = join(projectRoot(project), 'runs');
  const humanEvents = loadOpportunityEvents(project)
    .filter(e => e.event === 'accepted' || e.event === 'rejected' || e.event === 'verified' || e.event === 'built');

  // Start fresh — persist the zeroed manifest BEFORE re-recording, because
  // recordAnalyzeRun reloads it per run and increments from disk state.
  rmSync(sessionsPath(project), { force: true });
  rmSync(opportunitiesPath(project), { force: true });
  const manifest = loadManifest(project);
  manifest.sessionCount = 0;
  manifest.lastRunId = null;
  manifest.productFrame = null;
  saveManifest(project, manifest);

  let runs = 0;
  const runIds = existsSync(runsDir) ? readdirSync(runsDir).sort() : [];
  for (const runId of runIds) {
    const artifact = readJson<{
      opportunities?: Opportunity[];
      sessionUnderstanding?: SessionUnderstanding;
    }>(join(runsDir, runId, 'analysis', 'opportunities.json'), {});
    if (!artifact.opportunities) continue;
    // session.loupe may be `{ session }` (enriched writes) OR a raw
    // LoupeSession (verbatim copies of the original capture) — analyze
    // accepts both, so the rebuild must too.
    const parsedSession = parseSessionInput(
      readJson<unknown>(join(runsDir, runId, 'analysis', 'session.loupe'), null));
    if (!parsedSession.ok || !parsedSession.value) continue;
    const session = parsedSession.value;

    // Re-derive the analyze-time record. Intent wasn't persisted pre-memory;
    // infer audit when per-reviewer debug artifacts exist.
    const intent: 'review' | 'audit' =
      existsSync(join(runsDir, runId, 'analysis', 'debug', '02b_per_reviewer.json')) ||
      existsSync(join(runsDir, runId, 'analysis', 'debug', '02_per_reviewer.json'))
        ? 'audit' : 'review';
    // Temporarily bump counters via recordAnalyzeRun's own writes.
    recordAnalyzeRun(session, runId, intent, artifact.opportunities, artifact.sessionUnderstanding ?? null);
    runs++;
  }

  // Re-append surviving human/built events. Fast-build events have synthetic
  // run ids with no backing run directory — they always survive (their ground
  // truth is the routed package, which the rebuild cannot see).
  const survivingRunIds = new Set(runIds);
  const kept = humanEvents.filter(e =>
    survivingRunIds.has(e.runId) || e.runId.startsWith('build-fast-'));
  appendJsonl(opportunitiesPath(project), kept);
  return { runs, events: kept.length };
}

export function resetMemory(project: string, keepPreferences: boolean): void {
  const prefs = keepPreferences ? loadPreferences(project) : null;
  rmSync(memoryDir(project), { recursive: true, force: true });
  if (prefs && prefs.length > 0) savePreferences(project, prefs);
}
