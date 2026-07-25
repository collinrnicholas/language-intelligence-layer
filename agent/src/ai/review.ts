import type { LoupeSession, Opportunity, OpportunityCategory } from '../cli.js';
import { callLLM } from '../llm/index.js';
import { parseOpportunities } from '../schema.js';
import { selectKeyframes } from './keyframes.js';
import { productContextBlock, type SessionUnderstanding } from './session-understanding.js';
import { reviewer as pm } from './reviewers/product-manager.js';
import { reviewer as pd } from './reviewers/product-designer.js';
import { reviewer as dsl } from './reviewers/design-systems-lead.js';
import { reviewer as a11y } from './reviewers/accessibility-engineer.js';
import { reviewer as fe } from './reviewers/frontend-engineer.js';

const REVIEWERS = [pm, pd, dsl, a11y, fe];

// ─── Types ──────────────────────────────────────────────────────

export interface ReviewerResult {
  name: string;
  description: string;
  findings: Opportunity[];
}

export interface MergedOpportunity extends Opportunity {
  reviewedBy: string[];  // reviewer names that found this
  originalIds: string[];  // original finding IDs
}

export interface CategoryScore {
  category: OpportunityCategory;
  score: number;         // 0-100
  deductions: number;
  findingCount: number;
}

export interface ExperienceScore {
  overall: number;        // 0-100
  categories: CategoryScore[];
  totalFindings: number;
}

export interface ReviewOutput {
  findings: MergedOpportunity[];
  score: ExperienceScore;
  top5: MergedOpportunity[];
  reviewedBy: string[];
  perReviewer: ReviewerResult[];  // raw per-reviewer findings before merge (debug / audit)
}

// ─── Scoring ────────────────────────────────────────────────────

const SEVERITY_DEDUCTION: Record<string, number> = {
  Critical: -20,
  High: -10,
  Medium: -5,
  Low: -2,
  Info: 0,
};

export function calculateScore(findings: MergedOpportunity[]): ExperienceScore {
  const categories = new Map<OpportunityCategory, { deductions: number; count: number }>();
  let totalDeduction = 0;

  for (const f of findings) {
    const cat = f.category;
    if (!categories.has(cat)) {
      categories.set(cat, { deductions: 0, count: 0 });
    }
    const c = categories.get(cat)!;
    const penalty = SEVERITY_DEDUCTION[f.severity] || 0;
    c.deductions += penalty;
    c.count++;
    totalDeduction += penalty;
  }

  const overall = Math.max(0, 100 + totalDeduction);

  const categoryScores: CategoryScore[] = (
    ['UX', 'Visual Design', 'Accessibility', 'Performance',
     'Design System', 'Interaction', 'Content', 'Engineering'] as OpportunityCategory[]
  ).map(cat => {
    const c = categories.get(cat);
    return {
      category: cat,
      score: c ? Math.max(0, 100 + c.deductions) : 100,
      deductions: c ? c.deductions : 0,
      findingCount: c ? c.count : 0,
    };
  });

  return {
    overall,
    categories: categoryScores,
    totalFindings: findings.length,
  };
}

// ─── Merge + Dedupe ─────────────────────────────────────────────

export function mergeFindings(allResults: ReviewerResult[]): MergedOpportunity[] {
  const merged: MergedOpportunity[] = [];

  for (const result of allResults) {
    for (const finding of result.findings) {
      // Check if this finding overlaps with an existing merged finding
      const matchIdx = merged.findIndex(m => {
        // Same URL + same selector + similar title
        if (m.page && finding.page && m.page === finding.page &&
            m.selector && finding.selector && m.selector === finding.selector) {
          if (titleSimilarity(m.title, finding.title) > 0.6) return true;
        }
        // Same timestamp ±5s + same category
        if (m.category === finding.category &&
            Math.abs(m.timestamp - finding.timestamp) < 5000) {
          if (titleSimilarity(m.title, finding.title) > 0.5) return true;
        }
        return false;
      });

      if (matchIdx >= 0) {
        // Merge: add reviewer, keep highest severity
        const existing = merged[matchIdx];
        if (!existing.reviewedBy.includes(result.name)) {
          existing.reviewedBy.push(result.name);
        }
        existing.originalIds.push(finding.id);
        // Promote severity if the new one is worse
        if (severityRank(finding.severity) > severityRank(existing.severity)) {
          existing.severity = finding.severity;
          existing.title = finding.title;
          existing.description = finding.description;
        }
        // Merge description if different
        if (finding.description !== existing.description &&
            !existing.description.includes(finding.description)) {
          existing.description += '\n\n' + finding.description;
        }
        // Take highest confidence
        if (finding.confidence > existing.confidence) {
          existing.confidence = finding.confidence;
        }
      } else {
        merged.push({
          ...finding,
          reviewedBy: [result.name],
          originalIds: [finding.id],
        });
      }
    }
  }

  return merged;
}

// ─── Top 5 ──────────────────────────────────────────────────────

export function topFindings(findings: MergedOpportunity[], notes: LoupeSession['notes']): MergedOpportunity[] {
  const scored = findings.map(f => {
    let score = severityWeight(f.severity) * f.confidence;

    // Bonus for repeated evidence (multiple events referenced)
    if (f.evidence?.events && f.evidence.events.length > 3) score *= 1.2;

    // Bonus for narration match
    const transcriptNotes = notes.filter(n => n.type === 'transcript');
    const hasNarration = transcriptNotes.some(n =>
      Math.abs(n.timestamp - f.timestamp) < 10000
    );
    if (hasNarration) score *= 1.3;

    // Bonus for multiple reviewers
    if (f.reviewedBy.length > 1) score *= 1.1;

    return { finding: f, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(s => s.finding);
}

// ─── Narrated Evidence Builder ───────────────────────────────────
//
// For each narration chunk we assemble the ACTUAL UI state at that timestamp —
// computed styles from the nearest DOM snapshot, the nearest screenshot ref, and
// nearby events — so reviewers can state measured facts instead of paraphrasing
// the transcript. (Capture note: the recorder snapshots only interactive elements
// and stores backgroundColor/color/font*/borderRadius/width/height — not `border`
// or `box-shadow`; we surface whatever is present.)

const EVIDENCE_WINDOW = 5000;
// Two reserved buckets so layout regions are GUARANTEED into the block and never
// crowded out by interactive elements. Regions rarely match narration tokens
// (Tailwind apps use utility classes, so "rail"/"sections" match no selector),
// yet they carry the background/border/shadow that explains visual hierarchy.
const MAX_ELEMENTS_PER_CHUNK = 10;
const REGION_BUDGET = 4; // top-N largest region/structural elements, always included

// Requested props (camelCase key → kebab label). Rendered only when present.
const SURFACED_STYLES: Array<[string, string]> = [
  ['backgroundColor', 'background-color'],
  ['color', 'color'],
  ['fontSize', 'font-size'],
  ['fontFamily', 'font-family'],
  ['border', 'border'],
  ['boxShadow', 'box-shadow'],
  ['borderRadius', 'border-radius'],
  ['width', 'width'],
  ['height', 'height'],
];

type DomSnapshot = Extract<LoupeSession['events'][number], { type: 'dom_snapshot' }>;

function nearestDomSnapshot(session: LoupeSession, ts: number): DomSnapshot | null {
  const snaps = session.events.filter((e): e is DomSnapshot => e.type === 'dom_snapshot');
  if (snaps.length === 0) return null;
  const atOrBefore = snaps.filter(s => s.timestamp <= ts).sort((a, b) => b.timestamp - a.timestamp);
  if (atOrBefore[0]) return atOrBefore[0];
  // Otherwise the closest one after (better than nothing).
  return snaps.sort((a, b) => Math.abs(a.timestamp - ts) - Math.abs(b.timestamp - ts))[0];
}

function nearestScreenshot(session: LoupeSession, ts: number): { index: number; timestamp: number } | null {
  if (session.screenshots.length === 0) return null;
  let best = 0;
  for (let i = 1; i < session.screenshots.length; i++) {
    if (Math.abs(session.screenshots[i].timestamp - ts) < Math.abs(session.screenshots[best].timestamp - ts)) best = i;
  }
  return { index: best, timestamp: session.screenshots[best].timestamp };
}

function tokenize(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 2));
}

// A selector is a layout/structural region if it leads with a structural tag or
// its classes hint at a region. Mirrors the recorder's region capture set.
const REGION_TAGS = new Set(['header', 'nav', 'aside', 'main', 'footer', 'section']);
const REGION_CLASS_HINTS = /rail|sidebar|panel|content|centerpiece|container|header|drawer|column/;

function isRegionSelector(sel: string): boolean {
  const tag = sel.split(/[.#[ :>]/)[0].toLowerCase();
  if (REGION_TAGS.has(tag)) return true;
  return REGION_CLASS_HINTS.test(sel.toLowerCase());
}

function elementArea(styles: Record<string, string> | undefined): number {
  const w = parseFloat(styles?.width ?? '');
  const h = parseFloat(styles?.height ?? '');
  return (Number.isFinite(w) ? w : 0) * (Number.isFinite(h) ? h : 0);
}

/**
 * Fill the interactive bucket: elements the user clicked near this moment, then
 * narration-token matches, then snapshot order — capped at `budget`.
 */
function pickInteractive(
  candidates: string[],
  narrationText: string,
  clickedSelectors: Set<string>,
  budget: number
): string[] {
  if (budget <= 0) return [];
  const narr = tokenize(narrationText);

  const scored = candidates.map(sel => {
    let score = 0;
    if (clickedSelectors.has(sel)) score += 5;
    for (const t of sel.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      if (narr.has(t)) score += 2;
    }
    return { sel, score };
  });

  const ranked = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).map(s => s.sel);
  const result = [...ranked];
  for (const sel of candidates) {
    if (result.length >= budget) break;
    if (!result.includes(sel)) result.push(sel);
  }
  return result.slice(0, budget);
}

function colorToHex(v: string): string {
  const m = /^rgba?\(([^)]+)\)$/.exec(v.trim());
  if (!m) return v;
  const parts = m[1].split(',').map(s => s.trim());
  const [r, g, b] = parts.map(Number);
  const a = parts.length > 3 ? Number(parts[3]) : 1;
  if (a === 0) return 'transparent';
  const hex = '#' + [r, g, b].map(n => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0')).join('');
  return a < 1 ? `${hex} (α${a})` : hex;
}

function formatStyleValue(prop: string, value: string): string {
  if (prop === 'backgroundColor' || prop === 'color') return colorToHex(value);
  if (prop === 'fontFamily') return value.split(',')[0].replace(/["']/g, '').trim();
  const px = /^([\d.]+)px$/.exec(value);
  if (px) return `${Math.round(parseFloat(px[1]))}px`;
  return value;
}

function formatNearbyEvent(e: LoupeSession['events'][number]): string {
  const ts = (e.timestamp / 1000).toFixed(1);
  switch (e.type) {
    case 'click': return `[${ts}s] click "${(e.textContent || '').slice(0, 40)}" → ${e.selector}`;
    case 'scroll': return `[${ts}s] scroll y=${e.scrollY}`;
    case 'network': return `[${ts}s] network ${e.url.slice(0, 50)} (${e.duration}ms)`;
    case 'console_error': return `[${ts}s] console error: ${e.message.slice(0, 80)}`;
    default: return '';
  }
}

/** Assemble the per-chunk evidence block for a single narration note. */
export function buildChunkEvidence(session: LoupeSession, note: LoupeSession['notes'][number]): string {
  const ts = note.timestamp;
  const secs = (ts / 1000).toFixed(1);
  const lines: string[] = [];
  lines.push(`[${secs}s] USER SAID: "${note.text}"`);

  const snap = nearestDomSnapshot(session, ts);
  if (!snap) {
    lines.push(`  UI EVIDENCE: (no DOM snapshot captured near this moment)`);
    return lines.join('\n');
  }

  const clicked = new Set(
    session.events
      .filter((e): e is Extract<LoupeSession['events'][number], { type: 'click' }> =>
        e.type === 'click' && Math.abs(e.timestamp - ts) < EVIDENCE_WINDOW)
      .map(e => e.selector)
  );

  lines.push(`  UI EVIDENCE at ${secs}s (nearest DOM snapshot @ ${(snap.timestamp / 1000).toFixed(1)}s):`);

  const cs = snap.computedStyles || {};
  const allSelectors = Object.keys(cs);

  // Bucket 1 — layout regions, ALWAYS included, largest bounding-box first.
  // These carry the background/border/shadow evidence for visual hierarchy.
  const regions = allSelectors
    .filter(isRegionSelector)
    .sort((a, b) => elementArea(cs[b]) - elementArea(cs[a]))
    .slice(0, REGION_BUDGET);

  // Bucket 2 — interactive elements fill the remaining budget.
  const regionSet = new Set(regions);
  const interactive = pickInteractive(
    allSelectors.filter(s => !regionSet.has(s)),
    note.text,
    clicked,
    MAX_ELEMENTS_PER_CHUNK - regions.length
  );

  const selectors = [...regions, ...interactive];
  const pad = Math.min(38, selectors.reduce((m, s) => Math.max(m, s.length), 0));
  for (const sel of selectors) {
    const st = cs[sel] || {};
    const styleStr = SURFACED_STYLES
      .filter(([k]) => st[k])
      .map(([k, label]) => `${label}: ${formatStyleValue(k, st[k])}`)
      .join('  ');
    lines.push(`  ${sel.padEnd(pad)}  ${styleStr}`);
  }
  if (selectors.length === 0) {
    lines.push(`  (no elements captured in this snapshot)`);
  }

  const shot = nearestScreenshot(session, ts);
  if (shot) lines.push(`  Screenshot: #${shot.index} (${(shot.timestamp / 1000).toFixed(1)}s)`);

  // Network events are noise here — they crowd out click textContent that
  // carries actual content signals (filenames, labels, button text).
  const nearby = session.events
    .filter(e => e.type !== 'dom_snapshot' && e.type !== 'network' && Math.abs(e.timestamp - ts) < EVIDENCE_WINDOW)
    .slice(0, 6)
    .map(formatNearbyEvent)
    .filter(Boolean);
  if (nearby.length > 0) lines.push(`  Nearby events: ${nearby.join(' | ')}`);

  return lines.join('\n');
}

/** All narration chunks, each paired with its assembled UI evidence. */
export function buildNarratedEvidence(session: LoupeSession): string {
  const transcript = session.notes.filter(n => n.type === 'transcript');
  return transcript.map(n => buildChunkEvidence(session, n)).join('\n\n');
}

// ─── Session Context Builder ─────────────────────────────────────

export function buildSessionContext(
  session: LoupeSession,
  existingFindings: Opportunity[],
  hasVision = false,
  understanding?: SessionUnderstanding | null,
): string {
  const startMs = new Date(session.startedAt).getTime();
  const endMs = new Date(session.endedAt).getTime();
  const durationS = Math.round((endMs - startMs) / 1000);

  const lines: string[] = [];
  lines.push(`## Session Data`);
  lines.push(`Project: ${session.project} | Flow: ${session.flow}`);
  lines.push(`Duration: ${durationS}s | Events: ${session.events.length} | Screenshots: ${session.screenshots.length}`);
  lines.push('');

  // Product frame first (gated by confidence), so each reviewer identifies issues
  // with the product's purpose and hierarchy already in mind — the way frontier
  // models infer product context before naming problems. Derived from the
  // transcript before any findings exist; never invent selectors/CSS from it.
  const ctx = productContextBlock(understanding);
  if (ctx) { lines.push(ctx.trim()); lines.push(''); }

  if (session.urlTimeline.length > 0) {
    lines.push('### URL Timeline');
    for (const u of session.urlTimeline.slice(0, 10)) {
      lines.push(`[${(u.timestamp / 1000).toFixed(1)}s] ${u.url} (${u.navigationType})`);
    }
    lines.push('');
  }

  const transcript = session.notes.filter(n => n.type === 'transcript');
  if (transcript.length > 0) {
    lines.push('### Narrated Evidence');
    if (hasVision) {
      lines.push('The attached screenshots show the actual rendered content. Read the visible');
      lines.push('text — filenames, labels, repeated metadata, how items are named and grouped.');
      lines.push('Content and information-structure problems (redundant labels repeated on every');
      lines.push('row, near-duplicate or ambiguous names, missing grouping, no way to tell items');
      lines.push('apart) are first-class findings — surface them explicitly, not only CSS/layout');
      lines.push('issues. The measured computed styles below are grounding for styling findings,');
      lines.push('but they are NOT the only kind of finding you should produce.');
    } else {
      lines.push('Each narration chunk below is paired with the ACTUAL UI state captured at that');
      lines.push('moment — computed styles from the nearest DOM snapshot, the nearest screenshot,');
      lines.push('and nearby events. Cite these measured values, not just what the user said.');
    }
    lines.push('');
    lines.push(buildNarratedEvidence(session));
    lines.push('');
  }

  const manual = session.notes.filter(n => n.type === 'manual');
  if (manual.length > 0) {
    lines.push('### Manual Notes');
    for (const n of manual.slice(0, 10)) {
      lines.push(`[${(n.timestamp / 1000).toFixed(0)}s] "${n.text}"`);
    }
    lines.push('');
  }

  if (session.events.length > 0) {
    // Network events are excluded — they provide no content signal and eat
    // through the 50-event cap before meaningful clicks appear in the log.
    lines.push('### Event Log');
    const logEvents = session.events.filter(e => e.type !== 'network');
    for (const e of logEvents.slice(0, 50)) {
      const ts = (e.timestamp / 1000).toFixed(1);
      switch (e.type) {
        case 'click':
          lines.push(`[${ts}s] Click "${(e.textContent || '').slice(0, 40)}" → ${e.selector}`);
          break;
        case 'scroll':
          lines.push(`[${ts}s] Scroll y=${e.scrollY}`);
          break;
        case 'console_error':
          lines.push(`[${ts}s] Console error: ${e.message.slice(0, 100)}`);
          break;
        case 'dom_snapshot':
          lines.push(`[${ts}s] DOM snapshot at ${e.url}`);
          break;
      }
    }
    lines.push('');
  }

  if (existingFindings.length > 0) {
    lines.push('### Existing Deterministic Findings');
    for (const f of existingFindings) {
      lines.push(`[${f.severity}] ${f.title}: ${f.description.slice(0, 120)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Run All Reviewers ──────────────────────────────────────────

// Reviewers whose job requires seeing actual rendered content (layout, hierarchy,
// visual consistency) get the session screenshots. Text-only reviewers (a11y,
// engineering) work from computed styles and event logs — no images needed.
const VISION_CATEGORIES = new Set(['Visual Design', 'UX', 'Design System']);

function selectReviewImages(session: LoupeSession, maxCount = 3): string[] {
  // Reviewers run before any findings exist, so the priority "moments" are the
  // reviewer's narration range (earliest + latest). The shared keyframe selector
  // adds route-change and click-burst frames for diversity, and spreads across the
  // timeline when there is no narration — replacing the old earliest/latest-only
  // picker that could miss the frames where a visual problem is actually visible.
  const narrationTs = session.notes
    .filter(n => n.type === 'transcript')
    .map(n => n.timestamp)
    .sort((a, b) => a - b);
  const anchors = narrationTs.length > 0
    ? [narrationTs[0], narrationTs[narrationTs.length - 1]]
    : [];
  return selectKeyframes(session, anchors, maxCount);
}

export async function runPersonaReview(
  session: LoupeSession,
  existingFindings: Opportunity[],
  understanding?: SessionUnderstanding | null,
): Promise<ReviewOutput> {
  const results: ReviewerResult[] = [];
  const visionImages = selectReviewImages(session);
  const sessionCtx = buildSessionContext(session, existingFindings, visionImages.length > 0, understanding);

  console.log(`Running ${REVIEWERS.length} AI reviewers...`);

  const dropped: string[] = [];
  const reviewerResults = await Promise.all(REVIEWERS.map(async reviewer => ({
    reviewer,
    findings: await runReviewer(reviewer, sessionCtx, session, existingFindings, visionImages),
  })));

  for (const { reviewer, findings } of reviewerResults) {
    if (findings === null) {
      dropped.push(reviewer.name);
      console.error(`  ⚠ ${reviewer.name}: response could not be parsed after retry — dropped from the panel`);
      continue;
    }
    results.push({ name: reviewer.name, description: reviewer.description, findings });
    console.log(`  ${reviewer.name}: ${findings.length} findings`);
  }

  // Fail loudly: the user paid for a full panel — surface when it ran short.
  if (dropped.length > 0) {
    console.warn(`  ⚠ Reduced panel coverage: ${REVIEWERS.length - dropped.length}/${REVIEWERS.length} reviewers returned usable findings. Dropped: ${dropped.join(', ')}.`);
  }

  // Merge + dedupe
  const merged = mergeFindings(results);
  console.log(`  Merged: ${merged.length} unique findings (from ${results.reduce((s, r) => s + r.findings.length, 0)} raw)`);

  // Score
  const score = calculateScore(merged);

  // Top 5
  const top5 = topFindings(merged, session.notes);

  // Reviewed by
  const reviewedBy = results.filter(r => r.findings.length > 0).map(r => r.name);

  return { findings: merged, score, top5, reviewedBy, perReviewer: results };
}

// ─── AI Helpers ─────────────────────────────────────────────────

/**
 * Run one reviewer with a retry. Returns validated findings (possibly an empty
 * array — a valid "nothing found"), or null when the response can't be parsed
 * even after a stricter re-prompt (the caller drops it and warns).
 */
async function runReviewer(
  reviewer: (typeof REVIEWERS)[number],
  sessionCtx: string,
  session: LoupeSession,
  existingFindings: Opportunity[],
  visionImages: string[],
): Promise<Opportunity[] | null> {
  const reviewerInstructions = reviewer.buildPrompt(session, existingFindings);
  const useVision = VISION_CATEGORIES.has(reviewer.category) && visionImages.length > 0;
  if (useVision) console.log(`  ${reviewer.name}: vision-enabled (${visionImages.length} screenshot(s))`);
  const basePrompt = `${sessionCtx}\n---\n\n${reviewerInstructions}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\n---\nYour previous reply could not be parsed. Return ONLY a valid JSON array of finding objects — no prose, no markdown fences, no trailing commas, no comments. If you have no findings, return exactly [].`;
    let response: string;
    try {
      response = await callLLM('explain', prompt, {
        severity: 'Medium',
        maxTokens: useVision ? 4000 : 2500,
        stage: `persona-review:${reviewer.name}:attempt-${attempt}`,
        retryCount: attempt - 1,
        promptVersion: `persona-review-${reviewer.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-v1`,
        ...(useVision ? { images: visionImages } : {}),
      });
    } catch (err) {
      console.error(`  ${reviewer.name}: LLM call failed (attempt ${attempt}/2):`, err);
      continue;
    }
    const parsed = tryParseFindings(response, reviewer.name);
    if (parsed !== null) return parsed;
    if (attempt === 1) console.warn(`  ${reviewer.name}: unparseable response — retrying with stricter format instructions`);
  }
  return null;
}

/** Tolerant parse: strips fences, then tries the whole string, an embedded
 *  `[...]` array, and an embedded `{...}` object / {findings:[...]} envelope.
 *  Returns validated findings (empty array is valid) or null if nothing parses. */
function tryParseFindings(text: string, reviewerName: string): Opportunity[] | null {
  for (const candidate of extractJsonCandidates(text)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const arr = Array.isArray(value) ? value
      : Array.isArray((value as { findings?: unknown })?.findings) ? (value as { findings: unknown[] }).findings
      : (value && typeof value === 'object') ? [value]
      : null;
    if (!arr) continue;
    const result = parseOpportunities(arr, `${reviewerName} response`);
    if (result.ok && result.value) return result.value;
  }
  return null;
}

function extractJsonCandidates(text: string): string[] {
  const stripped = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const candidates = [stripped];
  const firstArr = stripped.indexOf('[');
  const lastArr = stripped.lastIndexOf(']');
  if (firstArr !== -1 && lastArr > firstArr) candidates.push(stripped.slice(firstArr, lastArr + 1));
  const firstObj = stripped.indexOf('{');
  const lastObj = stripped.lastIndexOf('}');
  if (firstObj !== -1 && lastObj > firstObj) candidates.push(stripped.slice(firstObj, lastObj + 1));
  return candidates;
}

// ─── Utilities ──────────────────────────────────────────────────

function severityRank(s: string): number {
  const ranks: Record<string, number> = { Critical: 4, High: 3, Medium: 2, Low: 1, Info: 0 };
  return ranks[s] || 0;
}

function severityWeight(s: string): number {
  const weights: Record<string, number> = { Critical: 20, High: 10, Medium: 5, Low: 2, Info: 0.5 };
  return weights[s] || 1;
}

function titleSimilarity(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().split(/\s+/));
  const bWords = new Set(b.toLowerCase().split(/\s+/));
  if (aWords.size === 0 || bWords.size === 0) return 0;
  const intersection = [...aWords].filter(w => bWords.has(w)).length;
  return intersection / Math.max(aWords.size, bWords.size);
}
