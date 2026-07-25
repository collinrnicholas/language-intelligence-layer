// LLM-judged narration correlation.
//
// Replaces the keyword-based narrated-vs-detected gate with a semantic judgment:
// given the reviewer's spoken transcript and the candidate findings, the model
// decides which findings the reviewer *actually raised out loud*. This runs in
// `analyze` (one gateway call) and tags each finding; the keyword topic gate
// (narration.ts) remains only as an offline / gateway-down fallback.
//
// Scope: this decides the GATE only. Deterministic-family findings are excluded
// by the caller before we ever ask, and topic-based dedupe is unchanged.

import type { LoupeSession, Opportunity } from '../cli.js';
import { callLLM } from '../llm/index.js';
import { contextPack } from './context-pack.js';

export interface NarrationVerdict {
  narrated: boolean;
  /** Index into session.notes of the supporting quote (or null). */
  note: number | null;
}

/**
 * Ask the gateway which candidate findings the reviewer narrated. Returns a map
 * keyed by finding id. On any failure (gateway down, malformed output) returns
 * an empty map — the caller then falls back to the keyword gate.
 */
export async function judgeNarration(
  session: LoupeSession,
  candidates: Opportunity[]
): Promise<Map<string, NarrationVerdict>> {
  const out = new Map<string, NarrationVerdict>();

  // Transcript notes, tracking their original index in session.notes so the
  // model's chosen line maps back to a real note (for the displayed quote).
  const transcript = contextPack(session).indexedTranscript
    .map(x => ({ n: x.note, i: x.index }));
  if (transcript.length === 0 || candidates.length === 0) return out;

  const transcriptBlock = transcript.map((x, k) => `[${k}] ${x.n.text.trim()}`).join('\n');
  const findingsBlock = candidates
    .map((f, i) => `${i + 1}. ${f.title} — ${(f.description || '').replace(/\s+/g, ' ').slice(0, 200)}`)
    .join('\n');

  const prompt = [
    'You decide which UI findings the reviewer ACTUALLY raised out loud while narrating a screen recording.',
    '',
    "TRANSCRIPT (the reviewer's spoken narration; each line prefixed with its index):",
    transcriptBlock,
    '',
    'CANDIDATE FINDINGS:',
    findingsBlock,
    '',
    'For EACH finding decide: did the reviewer describe the problem this finding represents —',
    'either directly ("the names are confusing") or by describing the user experience it causes',
    '("I can\'t tell what each plan is", "hard to navigate", "everything looks the same")?',
    '',
    'Key rules:',
    '- ONE narration complaint can and should promote MULTIPLE findings when they are all',
    '  contributing causes of the same problem the reviewer described. Do not force a one-to-one',
    '  match. "I can\'t tell what each plan is / no hierarchy" maps to BOTH a visual-hierarchy',
    '  finding AND a content/naming finding — both explain why the user cannot distinguish items.',
    '- Content and naming problems (ambiguous names, repeated labels on every row, near-duplicate',
    '  filenames, missing grouping) are valid root causes of complaints about hierarchy, confusion,',
    '  and navigation difficulty. Mark them narrated when the reviewer\'s words describe the',
    '  experience those problems cause, even if the reviewer didn\'t name the root cause explicitly.',
    '- If the reviewer never described anything related to a finding — not the experience, not the',
    '  symptom, not the outcome — narrated=false.',
    '- A reviewer saying they LIKE something is not a finding to build.',
    '- Match on meaning, not shared words.',
    '',
    'Respond with ONLY a JSON array, exactly one object per finding, in order:',
    '[{"n":1,"narrated":true,"note":3},{"n":2,"narrated":false,"note":null}]',
    'n = finding number; narrated = boolean; note = index of the most relevant transcript line',
    'when narrated (else null).',
  ].join('\n');

  let raw: string;
  try {
    raw = await callLLM('build', prompt, {
      severity: 'Medium',
      stage: 'narration-judge',
      promptVersion: 'narration-judge-v1',
    });
  } catch {
    return out;
  }

  try {
    const json = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return out;
    for (const item of arr) {
      const idx = Number(item?.n) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) continue;
      const narrated = item?.narrated === true;
      let note: number | null = null;
      if (narrated && Number.isInteger(item?.note)) {
        const k = Number(item.note);
        if (k >= 0 && k < transcript.length) note = transcript[k].i; // map to session.notes index
      }
      out.set(candidates[idx].id, { narrated, note });
    }
  } catch {
    return out;
  }
  return out;
}
