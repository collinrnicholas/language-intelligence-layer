// ─── Memory digest — the ONLY thing prompts read ─────────────────
//
// Deterministically regenerated on every memory write (no LLM), hard-capped,
// redacted at this single choke point. Prompts inject named sections via
// memoryPromptBlock(); nothing else in the pipeline touches memory files.
//
// Confidence levels (user-approved): hint / pattern / rule.
//   - explicit `--rule` preferences are rules immediately
//   - otherwise: 1 signal = hint, 2 = pattern, 3+ = rule
// Stale decay: anything not reinforced within the last DECAY_WINDOW analyzed
// runs is downgraded one level at digest time (rule→pattern→hint→dropped).
// Stored strength is never mutated — decay is computed, so re-indexing or a
// fresh reinforcing run restores standing automatically.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  loadManifest, saveManifest, loadSessions, loadOpportunityEvents, loadPreferences,
  memoryDir, digestPath,
  type OpportunityMemoryEntry, type PreferenceEntry, type PreferenceStrength,
} from './store.js';

const DIGEST_CHAR_CAP = 4800;      // ~1200 tokens
const DECAY_WINDOW = 5;            // runs without reinforcement → one-level downgrade
const RECURRING_MIN = 2;           // occurrences across distinct runs to count as recurring
const MAX_RECURRING = 8;
const MAX_REJECTED = 10;
const MAX_PREFS = 12;

// ─── Redaction (single choke point before anything can reach a prompt) ──

const REDACTIONS: Array<[RegExp, string]> = [
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]'],
  [/\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi, '[redacted-token]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]'],
  [/\b(eyJ[A-Za-z0-9_-]{10,})\b/g, '[redacted-jwt]'],
  [/[?&][^\s"']*/g, ''], // query strings, wherever a full URL slipped through
];

export function redact(text: string): string {
  let out = text;
  for (const [re, sub] of REDACTIONS) out = out.replace(re, sub);
  return out;
}

// ─── Effective strength (promotion + decay) ─────────────────────

const ORDER: PreferenceStrength[] = ['hint', 'pattern', 'rule'];

function promoteBySignals(base: PreferenceStrength, signals: number): PreferenceStrength {
  const fromSignals: PreferenceStrength = signals >= 3 ? 'rule' : signals === 2 ? 'pattern' : 'hint';
  return ORDER[Math.max(ORDER.indexOf(base), ORDER.indexOf(fromSignals))];
}

function decayOneLevel(s: PreferenceStrength): PreferenceStrength | null {
  const i = ORDER.indexOf(s);
  return i <= 0 ? null : ORDER[i - 1];
}

/** Exported for tests: promotion by signals, then decay when stale. */
export function effectiveStrength(
  pref: PreferenceEntry,
  recentRunIds: string[],
): PreferenceStrength | null {
  const signals = pref.source === 'explicit' ? Math.max(1, pref.evidence.length) : pref.evidence.length;
  let strength = pref.strength === 'rule'
    ? 'rule' as PreferenceStrength                 // explicit rules start at rule
    : promoteBySignals(pref.strength, signals);
  const reinforced = pref.lastSeenRunId !== null && recentRunIds.includes(pref.lastSeenRunId);
  if (!reinforced && recentRunIds.length >= DECAY_WINDOW) {
    const decayed = decayOneLevel(strength);
    if (!decayed) return null;                      // hint + stale → dropped from digest
    strength = decayed;
  }
  return strength;
}

// ─── Pattern derivation (from the event log — never stored) ─────

export interface DerivedPattern {
  key: string;
  title: string;
  occurrences: number;         // distinct runs it was observed/narrated in
  runIds: string[];
  status: 'open' | 'built' | 'verified' | 'rejected' | 'regressed';
  narrated: boolean;
}

const STATUS_RANK: Record<string, DerivedPattern['status']> = {
  regressed: 'regressed', rejected: 'rejected', verified: 'verified', built: 'built',
};

export function derivePatterns(events: OpportunityMemoryEntry[]): DerivedPattern[] {
  const byKey = new Map<string, OpportunityMemoryEntry[]>();
  for (const e of events) {
    const arr = byKey.get(e.key) ?? [];
    arr.push(e);
    byKey.set(e.key, arr);
  }
  const out: DerivedPattern[] = [];
  for (const [key, evts] of byKey) {
    const seenRuns = [...new Set(
      evts.filter(e => e.event === 'observed' || e.event === 'narrated').map(e => e.runId),
    )].sort();
    if (seenRuns.length === 0) continue;
    // Lifecycle: latest terminal event wins; regression re-opens.
    let status: DerivedPattern['status'] = 'open';
    for (const e of [...evts].sort((a, b) => a.at.localeCompare(b.at))) {
      if (e.event in STATUS_RANK) status = STATUS_RANK[e.event];
      if (e.event === 'observed' || e.event === 'narrated') {
        if (status === 'verified' || status === 'built') status = 'regressed';
      }
    }
    out.push({
      key,
      title: evts[evts.length - 1].title,
      occurrences: seenRuns.length,
      runIds: seenRuns.slice(-5),
      status,
      narrated: evts.some(e => e.event === 'narrated'),
    });
  }
  return out.sort((a, b) => b.occurrences - a.occurrences);
}

// ─── Digest generation ──────────────────────────────────────────

export function generateDigest(project: string): string {
  const manifest = loadManifest(project);
  const sessions = loadSessions(project);
  const events = loadOpportunityEvents(project);
  const prefs = loadPreferences(project);
  const recentRunIds = sessions.slice(-DECAY_WINDOW).map(s => s.runId);

  const lines: string[] = [
    `# Project Memory — ${project}`,
    `_${manifest.sessionCount} analyzed session(s) · updated ${new Date().toISOString()}_`,
    '',
  ];

  // Product frame — mirrors productContextBlock's confidence discipline.
  if (manifest.productFrame && manifest.productFrame.understanding.confidence >= 0.5) {
    const u = manifest.productFrame.understanding;
    lines.push('## Product frame');
    lines.push(`- product: ${u.productType} (stable across ${manifest.productFrame.agreeingRuns} run(s))`);
    lines.push(`- primary user: ${u.primaryUser}`);
    lines.push(`- primary job: ${u.primaryJob}`);
    if (u.topPriorities.length) lines.push(`- user priorities: ${u.topPriorities.join('; ')}`);
    lines.push('');
  }

  // Preferences — rules first; effective strength after promotion + decay.
  const effective = prefs
    .map(p => ({ p, strength: effectiveStrength(p, recentRunIds) }))
    .filter((x): x is { p: PreferenceEntry; strength: PreferenceStrength } => x.strength !== null)
    .sort((a, b) => ORDER.indexOf(b.strength) - ORDER.indexOf(a.strength))
    .slice(0, MAX_PREFS);
  if (effective.length > 0) {
    lines.push('## Preferences');
    for (const { p, strength } of effective) {
      lines.push(`- [${strength}] ${p.statement} _(source: ${p.source}, signals: ${Math.max(1, p.evidence.length)})_`);
    }
    lines.push('');
  }

  // Open recurring issues.
  const patterns = derivePatterns(events)
    .filter(pat => pat.occurrences >= RECURRING_MIN && (pat.status === 'open' || pat.status === 'regressed'))
    .slice(0, MAX_RECURRING);
  if (patterns.length > 0) {
    lines.push('## Open recurring issues');
    for (const pat of patterns) {
      lines.push(`- ${pat.title} — seen in ${pat.occurrences} runs (${pat.runIds.join(', ')})${pat.status === 'regressed' ? ' · REGRESSED after a fix' : ''}${pat.narrated ? '' : ' · never narrated'}`);
    }
    lines.push('');
  }

  // Prior rejections — CAUTION, not a hard ban. A single rejection is a weak
  // signal; contexts change and users change their minds. Strength surfaces
  // per item so the model can weigh it, and the framing explicitly yields to
  // the current session's narration.
  const rejectedEvents = events.filter(e => e.event === 'rejected');
  const rejectionCounts = new Map<string, number>();
  for (const r of rejectedEvents) rejectionCounts.set(r.key, (rejectionCounts.get(r.key) ?? 0) + 1);
  const seenKeys = new Set<string>();
  const rejected = rejectedEvents
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter(r => !seenKeys.has(r.key) && (seenKeys.add(r.key), true))
    .slice(0, MAX_REJECTED);
  if (rejected.length > 0) {
    lines.push('## Prior rejections (caution)');
    lines.push('_Previously declined. Do not re-propose UNLESS the current session\'s narration explicitly raises it again — current narration always wins._');
    for (const r of rejected) {
      const n = rejectionCounts.get(r.key) ?? 1;
      const strength = n >= 3 ? 'firm' : n === 2 ? 'repeated' : 'once';
      lines.push(`- [${strength}] ${r.title}${r.why ? ` — "${r.why}"` : ''}`);
    }
    lines.push('');
  }

  let digest = redact(lines.join('\n'));
  if (digest.length > DIGEST_CHAR_CAP) {
    digest = digest.slice(0, DIGEST_CHAR_CAP) + '\n_…truncated at cap_\n';
  }

  mkdirSync(memoryDir(project), { recursive: true });
  writeFileSync(digestPath(project), digest, 'utf-8');
  manifest.digestUpdatedAt = new Date().toISOString();
  saveManifest(project, manifest);
  return digest;
}

// ─── Prompt injection (Build This + Redesign only, per approval) ─

export type DigestSection = 'Product frame' | 'Preferences' | 'Open recurring issues' | 'Prior rejections (caution)';

function readDigest(project: string): string {
  const p = digestPath(project);
  try {
    return existsSync(p) ? readFileSync(p, 'utf-8') : '';
  } catch {
    return '';
  }
}

/** Slice named sections out of the digest for a prompt. '' when memory is empty
 *  — callers `.filter(s => s !== '')` it away like productContextBlock. */
export function memoryPromptBlock(project: string, sections: DigestSection[]): string {
  const digest = readDigest(project);
  if (!digest) return '';

  const picked: string[] = [];
  for (const section of sections) {
    const re = new RegExp(`^## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=\\n## |$)`, 'm');
    const m = re.exec(digest);
    if (m && m[1].trim()) picked.push(`## ${section}\n${m[1].trim()}`);
  }
  if (picked.length === 0) return '';

  return [
    'PROJECT MEMORY (distilled from prior sessions of this project; context only —',
    'never cite it as something observed in THIS session; [rule] preferences are',
    'constraints, [pattern]/[hint] are guidance). Do NOT add BUILD changes solely',
    'from memory — every proposed change must be grounded in the CURRENT session\'s',
    'evidence; memory only frames, prioritizes, or suppresses.',
    ...picked,
  ].join('\n');
}
