// ─── Opportunity synthesis (UX Review path) ──────────────────────
//
// One reasoning call replaces the 5-persona fanout for UX Review: a Claude
// reasoning model synthesizes opportunities from STRUCTURED vision
// observations + narrated evidence + deterministic findings. The persona
// fanout remains the Complete Audit path (routing-policy.ts).
//
// Fallback: if the primary reasoning provider fails, retry once on the GPT
// fallback; if both fail, the caller keeps deterministic findings — an AI
// stage failure never aborts a run and never discards deterministic evidence.

import type { LoupeSession, Opportunity } from '../../cli.js';
import { callLLM } from './call.js';
import { parseOpportunities } from '../../schema.js';
import { buildSessionContext } from '../../ai/review.js';
import type { SessionUnderstanding } from '../../ai/session-understanding.js';
import { observationsBlock, type UIObservation } from './vision-observe.js';
import { resolveModel, REASONING_FALLBACK_MODEL, type IntentName } from '../routing-policy.js';

/** Pure merge used by callers: AI synthesis failing (null) must always
 *  preserve the deterministic findings unchanged. */
export function mergeWithDeterministic(
  deterministic: Opportunity[],
  synthesized: Opportunity[] | null,
): Opportunity[] {
  if (!synthesized || synthesized.length === 0) return deterministic;
  return [...deterministic, ...synthesized];
}

function synthesisPrompt(sessionCtx: string, obsBlock: string): string {
  return [
    sessionCtx,
    obsBlock,
    '---',
    '',
    'You are the opportunity-synthesis pass of a UX review. Working from the narrated evidence,',
    'the measured UI state, and the structured vision observations above, surface the experience',
    'problems worth fixing. You cover every lens at once — information hierarchy, visual design,',
    'content clarity, interaction, accessibility, and engineering signals.',
    '',
    'Rules:',
    '- Every finding cites evidence: a narration quote, a measured style, an observation, or an event.',
    '- Content and information-structure problems are first-class findings, not just CSS issues.',
    '- Do NOT invent issues without evidence. Quality over quantity — 3–8 strong findings beat 15 weak ones.',
    '- Do NOT duplicate the deterministic findings listed above; they are already captured.',
    '',
    'Format your response as a JSON array of findings. Each finding:',
    '- id: unique string prefixed with "syn-"',
    '- category: "UX" | "Visual Design" | "Accessibility" | "Performance" | "Design System" | "Interaction" | "Content" | "Engineering"',
    '- severity: "Critical" | "High" | "Medium" | "Low" | "Info"',
    '- title: short, action-oriented headline',
    '- description: what you observed + impact (2-3 sentences, cite evidence)',
    '- page: URL where observed',
    '- timestamp: ms into session',
    '- selector: CSS selector when the finding is about a specific measured element; omit otherwise',
    '- whyItMatters: impact on the user',
    '- suggestedFix: actionable recommendation',
    '- confidence: 0-1',
    '- evidence: { screenshotIndex?, domSnapshotTimestamp?, events: number[], url?, selector? }',
    '',
    'Return ONLY the JSON array, no markdown.',
  ].filter(s => s !== '').join('\n');
}

function tryParse(raw: string): Opportunity[] | null {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const candidates = [cleaned];
  const first = cleaned.indexOf('[');
  const last = cleaned.lastIndexOf(']');
  if (first !== -1 && last > first) candidates.push(cleaned.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const arr = JSON.parse(c);
      if (!Array.isArray(arr)) continue;
      const result = parseOpportunities(arr, 'opportunity synthesis');
      if (result.ok && result.value) return result.value;
    } catch { /* next */ }
  }
  return null;
}

/**
 * Synthesize opportunities for the UX Review path. Returns null on total
 * failure — callers merge with deterministic findings via mergeWithDeterministic.
 */
export async function synthesizeOpportunities(
  session: LoupeSession,
  deterministic: Opportunity[],
  observations: UIObservation[],
  intent: IntentName,
  understanding?: SessionUnderstanding | null,
): Promise<Opportunity[] | null> {
  const sessionCtx = buildSessionContext(session, deterministic, false, understanding);
  const prompt = synthesisPrompt(sessionCtx, observationsBlock(observations));

  const primary = resolveModel(intent, 'reasoning');
  const models = [primary, REASONING_FALLBACK_MODEL].filter(
    (m, i, a): m is string => !!m && a.indexOf(m) === i,
  );

  for (const model of models) {
    try {
      const raw = await callLLM('build', prompt, {
        model,
        maxTokens: 4000,
        stage: 'synthesize-opportunities',
        promptVersion: 'synthesize-opportunities-v1',
      });
      const parsed = tryParse(raw);
      if (parsed) return parsed;
      console.log('[synthesize-opportunities] unparseable response — trying fallback provider');
    } catch (err) {
      console.log(`[synthesize-opportunities] provider failed (${err instanceof Error ? err.message.slice(0, 80) : 'error'}) — trying fallback`);
    }
  }
  return null;
}
