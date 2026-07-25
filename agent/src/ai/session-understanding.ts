// Session-level product understanding — the small structured frame that lets
// per-finding target generation reason about the PRODUCT, not just its own slice.
//
// Frontier tools win on product reasoning because they see the whole session in
// one pass BEFORE committing to individual fixes. Loupe used to compute its
// product-level view (UX synthesis) in `build-this`, one command too late — after
// `analyze` had already frozen every per-finding target. This module runs one
// cheap `explain` call in `analyze`, right after the narration judge and BEFORE
// `generateTargets`, and persists a compact object consumed by both target
// generation (now) and UX synthesis (later, as a seed).
//
// Deliberately small and product-framed: NO selectors, CSS, or file paths — this
// is "what is this product and what did the user ask for", not a list of fixes.
// See specs/session-understanding.md (Option B).

import type { LoupeSession, Opportunity } from '../cli.js';
import { callLLM } from '../llm/index.js';
import { contextPack } from './context-pack.js';

export interface SessionUnderstanding {
  productType: string;        // "AI document assistant for construction bids"
  primaryUser: string;        // "a contractor preparing a proposal"
  primaryJob: string;         // the main job-to-be-done, one sentence
  keyObjects: string[];       // domain nouns: ["plans (inputs)", "documents (outputs)"]
  invertedOrMissing?: string; // optional: the one structural observation, if any
  topPriorities: string[];    // user-voiced priorities, ranked
  confidence: number;         // 0..1 — below the gate, consumers treat it as a hint only
}

// Below this confidence, consumers may display the understanding but must not let
// it steer prescriptive output (target CSS/behavior). Approved gate: 0.5.
export const UNDERSTANDING_CONFIDENCE_GATE = 0.5;

// LLM options for the understanding call. severity 'High' routes it to the
// PREMIUM model: this stage is quality-critical — it frames the product for
// target generation and seeds UX synthesis, so a weak frame degrades every
// downstream artifact. Exported so tests can prove the premium routing holds
// (test/router.test.mjs) — do not quietly lower the severity.
export const UNDERSTANDING_LLM_OPTIONS = {
  severity: 'High',
  maxTokens: 700,
  stage: 'session-understanding',
  promptVersion: 'session-understanding-v2-premium',
} as const;

function transcriptText(session: LoupeSession): string {
  return contextPack(session).transcriptBlock;
}

/**
 * Derive a compact product understanding from the transcript, URL, and finding
 * titles. Returns null when there is no narration to reason from, or on any
 * failure — callers then behave exactly as before (graceful degradation).
 */
export async function deriveSessionUnderstanding(
  session: LoupeSession,
  findings: Opportunity[],
): Promise<SessionUnderstanding | null> {
  const transcript = transcriptText(session);
  if (!transcript) return null; // no voice → nothing to summarize

  const url = session.urlTimeline[0]?.url || '(unknown)';
  const titles = findings.map(f => `- ${f.title}`).join('\n') || '(none)';

  const prompt = [
    'You read a UX review session and produce a SMALL product understanding that a downstream',
    'agent will use to frame individual fixes. This is product framing, NOT a list of fixes.',
    '',
    'From the reviewer\'s narration, the URL, the project/flow names, and the finding titles,',
    'infer what the product is, who uses it, and what the reviewer was actually asking for.',
    '',
    'HARD RULES:',
    '- No selectors, CSS values, file paths, or finding titles in your output. Product language only.',
    '- Every field must be specific to THIS session — a reader must not be able to lift it onto a',
    '  different product.',
    '- keyObjects are the domain nouns and their role (e.g. "plans (inputs)", "documents (outputs)").',
    '- topPriorities are what the USER voiced, most important first — paraphrase their words.',
    '- invertedOrMissing: at most one sentence naming a structural problem (an inverted hierarchy,',
    '  a missing affordance) ONLY if the session clearly shows one; otherwise omit it.',
    '- confidence 0..1: how sure you are of this framing given how much the reviewer actually said.',
    '',
    'Return ONLY valid JSON with this exact shape:',
    '{',
    '  "productType": "…",',
    '  "primaryUser": "…",',
    '  "primaryJob": "…",',
    '  "keyObjects": ["…"],',
    '  "invertedOrMissing": "…",',
    '  "topPriorities": ["…"],',
    '  "confidence": 0.0',
    '}',
    '',
    `PROJECT: ${session.project || '(unknown)'}`,
    `FLOW: ${session.flow || '(unknown)'}`,
    `URL: ${url}`,
    '',
    'FINDING TITLES:',
    titles,
    '',
    'REVIEWER NARRATION (chronological):',
    transcript,
  ].join('\n');

  let raw: string;
  try {
    raw = await callLLM('explain', prompt, UNDERSTANDING_LLM_OPTIONS);
  } catch {
    return null;
  }
  return parseSessionUnderstanding(raw);
}

export function parseSessionUnderstanding(raw: string): SessionUnderstanding | null {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const candidates = [
    cleaned,
    cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1),
  ].filter(s => s.startsWith('{') && s.endsWith('}'));

  for (const candidate of candidates) {
    try {
      const d = JSON.parse(candidate) as Record<string, unknown>;
      const productType = str(d.productType);
      const primaryUser = str(d.primaryUser);
      const primaryJob = str(d.primaryJob);
      const keyObjects = strArray(d.keyObjects);
      const topPriorities = strArray(d.topPriorities);
      const confidence = num(d.confidence);
      if (!productType || !primaryUser || !primaryJob || confidence === null) continue;
      const invertedOrMissing = str(d.invertedOrMissing);
      return {
        productType,
        primaryUser,
        primaryJob,
        keyObjects,
        ...(invertedOrMissing ? { invertedOrMissing } : {}),
        topPriorities,
        confidence: Math.max(0, Math.min(1, confidence)),
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** A compact PRODUCT CONTEXT block for injection into a generation prompt, or ''
 *  when the understanding is absent or below the confidence gate. */
export function productContextBlock(u: SessionUnderstanding | null | undefined): string {
  if (!u || u.confidence < UNDERSTANDING_CONFIDENCE_GATE) return '';
  const lines = [
    '',
    'PRODUCT CONTEXT (use to frame each fix — this is what the product is FOR; do not let it',
    'override measured state, and never invent selectors/CSS from it):',
    `  product: ${u.productType}`,
    `  primary user: ${u.primaryUser}`,
    `  primary job: ${u.primaryJob}`,
  ];
  if (u.keyObjects.length) lines.push(`  key objects: ${u.keyObjects.join(', ')}`);
  if (u.invertedOrMissing) lines.push(`  structural note: ${u.invertedOrMissing}`);
  if (u.topPriorities.length) lines.push(`  user's top priorities: ${u.topPriorities.join('; ')}`);
  return lines.join('\n');
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim()) : [];
}
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
