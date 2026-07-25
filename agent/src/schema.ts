import type { DestinationConfig, ImplementationPackage } from './destinations/types.js';
import type { SessionUnderstanding } from './ai/session-understanding.js';
import type {
  Evidence,
  LoupeSession,
  NoteEntry,
  Opportunity,
  OpportunityCategory,
  OpportunitySeverity,
  SessionEvent,
} from './cli.js';

export interface ParseResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}

const CATEGORIES: OpportunityCategory[] = [
  'UX',
  'Visual Design',
  'Accessibility',
  'Performance',
  'Design System',
  'Interaction',
  'Content',
  'Engineering',
];

const SEVERITIES: OpportunitySeverity[] = ['Critical', 'High', 'Medium', 'Low', 'Info'];
const DESTINATION_TYPES = ['local', 'claude-code', 'cursor', 'codex', 'gemini', 'clipboard', 'custom-command'];
const POST_ACTIONS = ['none', 'open-folder', 'copy-prompt', 'run-command'];

/**
 * v1 (legacy): the full session was embedded in the artifact and paths were
 * absolute. Still parsed for back-compat; new analyses write v2.
 */
export interface OpportunitiesArtifactV1 {
  version: 1;
  generatedAt: string;
  reportPath: string;
  sourceSessionPath: string;
  session: LoupeSession;
  opportunities: Opportunity[];
}

/**
 * v2: the session is *referenced*, not embedded, and all paths are relative to
 * the artifact's own directory — so the run dir is portable and the heavy
 * base64 payload (screenshots/audio) lives only in `session.loupe`.
 */
export interface OpportunitiesArtifactV2 {
  version: 2;
  generatedAt: string;
  runId: string;
  sessionFile: string;             // relative to this artifact's dir
  reportFile: string;              // relative to this artifact's dir
  screenshots: (string | null)[];  // relative paths; index === screenshotIndex
  opportunities: Opportunity[];
  // Optional product-level frame derived in analyze (before target generation)
  // and reused by build-this synthesis. Absent on low-narration/offline runs.
  sessionUnderstanding?: SessionUnderstanding;
}

export type OpportunitiesArtifact = OpportunitiesArtifactV1 | OpportunitiesArtifactV2;

export function parseSessionInput(data: unknown): ParseResult<LoupeSession> {
  const candidate = isRecord(data) && isRecord(data.session) ? data.session : data;
  return parseLoupeSession(candidate);
}

export function parseLoupeSession(data: unknown): ParseResult<LoupeSession> {
  const errors: string[] = [];
  if (!isRecord(data)) return fail('session must be an object');

  reqString(data, 'project', errors);
  reqString(data, 'flow', errors);
  reqString(data, 'startedAt', errors);
  reqString(data, 'endedAt', errors);
  reqArray(data, 'urlTimeline', errors);
  reqArray(data, 'events', errors);
  reqArray(data, 'screenshots', errors);
  reqObject(data, 'viewport', errors);
  reqObject(data, 'browser', errors);
  reqArray(data, 'notes', errors);

  const events = Array.isArray(data.events) ? data.events : [];
  events.forEach((event, i) => validateSessionEvent(event, `events[${i}]`, errors));

  const urlTimeline = Array.isArray(data.urlTimeline) ? data.urlTimeline : [];
  urlTimeline.forEach((entry, i) => {
    if (!isRecord(entry)) return errors.push(`urlTimeline[${i}] must be an object`);
    reqString(entry, 'url', errors, `urlTimeline[${i}]`);
    reqNumber(entry, 'timestamp', errors, `urlTimeline[${i}]`);
    if (!['pushstate', 'popstate', 'hashchange', 'hard', 'initial'].includes(String(entry.navigationType))) {
      errors.push(`urlTimeline[${i}].navigationType is invalid`);
    }
  });

  const screenshots = Array.isArray(data.screenshots) ? data.screenshots : [];
  screenshots.forEach((shot, i) => {
    if (!isRecord(shot)) return errors.push(`screenshots[${i}] must be an object`);
    reqNumber(shot, 'timestamp', errors, `screenshots[${i}]`);
    reqString(shot, 'dataUrl', errors, `screenshots[${i}]`);
  });

  const notes = Array.isArray(data.notes) ? data.notes : [];
  notes.forEach((note, i) => validateNote(note, `notes[${i}]`, errors));

  if (isRecord(data.viewport)) {
    reqNumber(data.viewport, 'width', errors, 'viewport');
    reqNumber(data.viewport, 'height', errors, 'viewport');
  }
  if (isRecord(data.browser)) reqString(data.browser, 'userAgent', errors, 'browser');
  if ('audioData' in data && data.audioData !== undefined && typeof data.audioData !== 'string') {
    errors.push('audioData must be a string when present');
  }
  if ('targetDesign' in data && data.targetDesign !== undefined) {
    const td = data.targetDesign;
    const ok = typeof td === 'string' || (isRecord(td) && typeof td.dataUrl === 'string');
    if (!ok) errors.push('targetDesign must be a string or an object with a dataUrl string');
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: data as unknown as LoupeSession, errors: [] };
}

export function parseOpportunity(data: unknown, path = 'opportunity'): ParseResult<Opportunity> {
  const errors: string[] = [];
  validateOpportunity(data, path, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: data as Opportunity, errors: [] };
}

/**
 * Split a list of candidate findings into valid opportunities and a count of
 * dropped (malformed) ones. Used by `analyze` to quarantine bad AI output
 * without discarding the trusted deterministic findings — see ADR-008.
 */
export function quarantineOpportunities(findings: unknown[]): { valid: Opportunity[]; dropped: number } {
  const valid: Opportunity[] = [];
  let dropped = 0;
  for (const finding of findings) {
    if (parseOpportunity(finding).ok) valid.push(finding as Opportunity);
    else dropped++;
  }
  return { valid, dropped };
}

export function parseOpportunities(data: unknown, path = 'opportunities'): ParseResult<Opportunity[]> {
  if (!Array.isArray(data)) return fail(`${path} must be an array`);
  const errors: string[] = [];
  data.forEach((item, i) => validateOpportunity(item, `${path}[${i}]`, errors));
  return errors.length ? { ok: false, errors } : { ok: true, value: data as Opportunity[], errors: [] };
}

/** Shape-validate the optional SessionUnderstanding embedded in a v2 artifact.
 *  Kept inline (no ai-layer import) so schema stays free of pipeline dependencies. */
function isValidSessionUnderstanding(u: unknown): boolean {
  if (!isRecord(u)) return false;
  const strOk = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
  const strArrOk = (v: unknown): boolean => Array.isArray(v) && v.every(x => typeof x === 'string');
  if (!strOk(u.productType) || !strOk(u.primaryUser) || !strOk(u.primaryJob)) return false;
  if (!strArrOk(u.keyObjects) || !strArrOk(u.topPriorities)) return false;
  if (typeof u.confidence !== 'number' || !Number.isFinite(u.confidence) || u.confidence < 0 || u.confidence > 1) return false;
  if (u.invertedOrMissing !== undefined && typeof u.invertedOrMissing !== 'string') return false;
  return true;
}

export function parseOpportunitiesArtifact(data: unknown): ParseResult<OpportunitiesArtifact> {
  const errors: string[] = [];
  if (!isRecord(data)) return fail('opportunities artifact must be an object');

  reqString(data, 'generatedAt', errors);
  const opportunities = parseOpportunities(data.opportunities);
  if (!opportunities.ok) errors.push(...opportunities.errors);

  if (data.version === 1) {
    // Legacy: session embedded, absolute paths.
    reqString(data, 'reportPath', errors);
    reqString(data, 'sourceSessionPath', errors);
    const session = parseLoupeSession(data.session);
    if (!session.ok) errors.push(...session.errors.map(e => `session.${e}`));
  } else if (data.version === 2) {
    // Current: session referenced by relative path, no embedded base64.
    reqString(data, 'runId', errors);
    reqString(data, 'sessionFile', errors);
    reqString(data, 'reportFile', errors);
    if (!Array.isArray(data.screenshots) || data.screenshots.some(s => s !== null && typeof s !== 'string')) {
      errors.push('screenshots must be an array of strings or nulls');
    }
    // Optional advisory frame: validate its shape, but never fail the whole
    // analyzed artifact over it — drop a malformed one so no garbage reaches
    // target generation / synthesis downstream.
    if (data.sessionUnderstanding !== undefined && !isValidSessionUnderstanding(data.sessionUnderstanding)) {
      delete (data as Record<string, unknown>).sessionUnderstanding;
    }
  } else {
    errors.push('version must be 1 or 2');
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: data as unknown as OpportunitiesArtifact, errors: [] };
}

export function parseDestinationConfig(data: unknown): ParseResult<DestinationConfig> {
  const errors: string[] = [];
  if (!isRecord(data)) return fail('destination must be an object');
  reqString(data, 'id', errors);
  reqString(data, 'name', errors);
  if (!DESTINATION_TYPES.includes(String(data.type))) errors.push('type is invalid');
  if (!POST_ACTIONS.includes(String(data.postAction))) errors.push('postAction is invalid');
  for (const key of ['workspace', 'output', 'command']) {
    if (key in data && data[key] !== undefined && typeof data[key] !== 'string') errors.push(`${key} must be a string`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: data as unknown as DestinationConfig, errors: [] };
}

export function parseImplementationPackage(data: unknown): ParseResult<ImplementationPackage> {
  const errors: string[] = [];
  if (!isRecord(data)) return fail('implementation package must be an object');
  reqString(data, 'packageDir', errors);
  reqArray(data, 'files', errors);
  reqNumber(data, 'screenshotCount', errors);
  reqString(data, 'project', errors);
  reqString(data, 'flow', errors);
  if (Array.isArray(data.files) && data.files.some(f => typeof f !== 'string')) errors.push('files must contain only strings');
  return errors.length ? { ok: false, errors } : { ok: true, value: data as unknown as ImplementationPackage, errors: [] };
}

export function maxSessionTimestamp(session: LoupeSession): number {
  const values = [
    ...session.events.map(e => e.timestamp),
    ...session.screenshots.map(s => s.timestamp),
    ...session.urlTimeline.map(u => u.timestamp),
    ...session.notes.flatMap(n => [n.timestamp, n.endTimestamp ?? n.timestamp]),
  ];
  return values.length ? Math.max(...values) : 0;
}

export function expectedDurationMs(session: LoupeSession): number {
  const start = new Date(session.startedAt).getTime();
  const end = new Date(session.endedAt).getTime();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function validateOpportunity(data: unknown, path: string, errors: string[]): void {
  if (!isRecord(data)) {
    errors.push(`${path} must be an object`);
    return;
  }
  reqString(data, 'id', errors, path);
  if (!CATEGORIES.includes(data.category as OpportunityCategory)) errors.push(`${path}.category is invalid`);
  if (!SEVERITIES.includes(data.severity as OpportunitySeverity)) errors.push(`${path}.severity is invalid`);
  for (const key of ['title', 'description', 'page', 'whyItMatters', 'suggestedFix']) {
    reqString(data, key, errors, path);
  }
  if ('selector' in data && data.selector !== undefined && data.selector !== null && typeof data.selector !== 'string') {
    errors.push(`${path}.selector must be a string`);
  }
  reqNumber(data, 'timestamp', errors, path);
  reqNumber(data, 'confidence', errors, path);
  if (typeof data.confidence === 'number' && (data.confidence < 0 || data.confidence > 1)) {
    errors.push(`${path}.confidence must be between 0 and 1`);
  }
  if ('evidence' in data && data.evidence !== undefined) validateEvidence(data.evidence, `${path}.evidence`, errors);
  if ('acceptanceCriteria' in data && data.acceptanceCriteria !== undefined) validateStringArray(data.acceptanceCriteria, `${path}.acceptanceCriteria`, errors);
  if ('designTokens' in data && data.designTokens !== undefined) validateStringArray(data.designTokens, `${path}.designTokens`, errors);
}

function validateEvidence(data: unknown, path: string, errors: string[]): void {
  if (!isRecord(data)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!Array.isArray(data.events) || data.events.some(e => typeof e !== 'number')) errors.push(`${path}.events must be a number array`);
  for (const key of ['screenshotIndex', 'domSnapshotTimestamp']) {
    if (key in data && data[key] !== undefined && typeof data[key] !== 'number') errors.push(`${path}.${key} must be a number`);
  }
  for (const key of ['url', 'selector']) {
    if (key in data && data[key] !== undefined && typeof data[key] !== 'string') errors.push(`${path}.${key} must be a string`);
  }
}

function validateSessionEvent(data: unknown, path: string, errors: string[]): void {
  if (!isRecord(data)) {
    errors.push(`${path} must be an object`);
    return;
  }
  reqString(data, 'type', errors, path);
  reqNumber(data, 'timestamp', errors, path);
  switch (data.type) {
    case 'click':
      reqString(data, 'selector', errors, path);
      reqNumber(data, 'x', errors, path);
      reqNumber(data, 'y', errors, path);
      reqString(data, 'tagName', errors, path);
      reqString(data, 'textContent', errors, path);
      break;
    case 'scroll':
      for (const key of ['scrollX', 'scrollY', 'maxScrollX', 'maxScrollY']) reqNumber(data, key, errors, path);
      break;
    case 'dom_snapshot':
      reqString(data, 'url', errors, path);
      reqString(data, 'html', errors, path);
      reqObject(data, 'computedStyles', errors, path);
      break;
    case 'console_error':
      reqString(data, 'message', errors, path);
      reqString(data, 'source', errors, path);
      break;
    case 'network':
      reqString(data, 'url', errors, path);
      reqNumber(data, 'duration', errors, path);
      reqString(data, 'initiatorType', errors, path);
      break;
    default:
      errors.push(`${path}.type is invalid`);
  }
}

function validateNote(data: unknown, path: string, errors: string[]): void {
  if (!isRecord(data)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!['transcript', 'manual'].includes(String(data.type))) errors.push(`${path}.type is invalid`);
  reqNumber(data, 'timestamp', errors, path);
  reqString(data, 'text', errors, path);
  if ('endTimestamp' in data && data.endTimestamp !== undefined && typeof data.endTimestamp !== 'number') {
    errors.push(`${path}.endTimestamp must be a number`);
  }
}

function reqString(data: Record<string, unknown>, key: string, errors: string[], path = ''): void {
  if (typeof data[key] !== 'string') errors.push(`${path ? `${path}.` : ''}${key} must be a string`);
}

function reqNumber(data: Record<string, unknown>, key: string, errors: string[], path = ''): void {
  if (typeof data[key] !== 'number' || !Number.isFinite(data[key])) errors.push(`${path ? `${path}.` : ''}${key} must be a finite number`);
}

function reqArray(data: Record<string, unknown>, key: string, errors: string[], path = ''): void {
  if (!Array.isArray(data[key])) errors.push(`${path ? `${path}.` : ''}${key} must be an array`);
}

function reqObject(data: Record<string, unknown>, key: string, errors: string[], path = ''): void {
  if (!isRecord(data[key])) errors.push(`${path ? `${path}.` : ''}${key} must be an object`);
}

function validateStringArray(data: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(data) || data.some(item => typeof item !== 'string')) errors.push(`${path} must be a string array`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fail<T>(message: string): ParseResult<T> {
  return { ok: false, errors: [message] };
}
