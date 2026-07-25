// Finding relationships — the layer that turns a flat BUILD list into a structured
// one: a primary action, the design principle behind it (folded in as the "why"),
// and conditional follow-ups (symptoms that implementing the primary may resolve).
//
// The persona reviewers surface findings independently, so the merged BUILD set is
// flat: "hide plans", "prioritize documents", "proposal clipped" read as three peer
// tasks. But "prioritize documents" is the *reason* to hide plans (one change, not
// two), and the clipping may simply disappear once plans are hidden and the document
// panel can expand. This one build-time call classifies each narrated finding's
// role so the brief can express principle-vs-action and causal sequencing instead of
// a parallel list. Null-safe: on any failure the brief renders flat, exactly as before.

import type { LoupeSession } from '../cli.js';
import { callLLM } from '../llm/index.js';
import type { MergedFinding } from './narration.js';

export type FindingRole = 'primary' | 'principle' | 'consequence';

export interface FindingRelation {
  id: string;            // representative.id of the finding
  role: FindingRole;
  relatesTo?: string;    // for principle/consequence: the PRIMARY finding's id
  note?: string;         // principle → the "why" to fold in; consequence → verify-first instruction
}

export interface RelationshipMap {
  byId: Map<string, FindingRelation>;
}

export async function analyzeFindingRelationships(
  build: MergedFinding[],
  session: LoupeSession,
): Promise<RelationshipMap | null> {
  if (build.length < 2) return null; // nothing to relate

  const findingLines = build.map(m => {
    const quotes = m.narration.map(n => `"${n.text.trim()}"`).join(' | ');
    const target = m.representative.generatedTarget?.trim()
      || m.representative.suggestedFix?.trim()
      || '(no target generated)';
    return [
      `- id: ${m.representative.id}`,
      `  title: ${m.title}`,
      quotes ? `  reviewer said: ${quotes}` : null,
      `  target: ${target.replace(/\s+/g, ' ').slice(0, 300)}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const prompt = [
    'You organize a flat list of narrated UI findings into a build STRUCTURE for a coding agent.',
    'Each finding was narrated by the reviewer, so all are real. Your job is to classify how they',
    'relate, so the agent builds one coherent change with a purpose — not a pile of parallel patches.',
    '',
    'Assign every finding exactly one role:',
    '- "primary": a standalone action the agent should build.',
    '- "principle": this finding is the DESIGN PRINCIPLE / stated goal / justification BEHIND another',
    '  finding — it is the *reason* to do that action, not a separate thing to build. Example: "documents',
    '  should be prioritized" is the reason to "hide the plans"; they are one change. Set relatesTo to the',
    '  primary finding it justifies, and note = one sentence capturing the "why" to fold into that',
    '  finding\'s framing.',
    '- "consequence": this finding is a SYMPTOM that implementing another finding will LIKELY resolve on',
    '  its own. Example: a panel is clipped only because a sibling panel consumes the space — hide the',
    '  sibling and the clipping may disappear. Set relatesTo to the primary finding that likely resolves',
    '  it, and note = a verify-first instruction ("After implementing <that finding>, verify whether',
    '  <this symptom> still occurs; only apply a separate fix if it remains.").',
    '',
    'Rules:',
    '- Be conservative. Only use "principle" or "consequence" when the relationship is clearly supported',
    '  by the narration and targets. When in doubt, mark it "primary".',
    '- relatesTo MUST reference the id of a finding you marked "primary" (no chains, no cycles).',
    '- At least one finding must be "primary".',
    '- Do not invent findings or ids. Use the ids exactly as given.',
    '',
    'Return ONLY valid JSON: { "relations": [ { "id": "...", "role": "primary|principle|consequence",',
    '"relatesTo": "<primary id or omit>", "note": "<why or verify instruction, or omit>" } ] }',
    '',
    'FINDINGS:',
    findingLines,
  ].join('\n');

  let raw: string;
  try {
    raw = await callLLM('build', prompt, {
      severity: 'High',
      maxTokens: 1200,
      stage: 'finding-relationships',
      promptVersion: 'finding-relationships-v1',
    });
  } catch {
    return null;
  }
  return parseFindingRelationships(raw, build.map(m => m.representative.id));
}

export function parseFindingRelationships(raw: string, validIds: string[]): RelationshipMap | null {
  const data = extractJson(raw);
  const relations = data && Array.isArray(data.relations) ? data.relations : null;
  if (!relations) return null;

  const idSet = new Set(validIds);
  const parsed = new Map<string, FindingRelation>();
  for (const r of relations) {
    if (!r || typeof r !== 'object') continue;
    const id = typeof r.id === 'string' ? r.id : '';
    if (!idSet.has(id) || parsed.has(id)) continue;
    const role: FindingRole = r.role === 'principle' || r.role === 'consequence' ? r.role : 'primary';
    const relatesTo = typeof r.relatesTo === 'string' ? r.relatesTo : undefined;
    const note = typeof r.note === 'string' ? r.note.trim() : undefined;
    parsed.set(id, { id, role, relatesTo, note });
  }

  // Everything unmentioned defaults to primary.
  for (const id of validIds) if (!parsed.has(id)) parsed.set(id, { id, role: 'primary' });

  // First pass: who is a genuine primary (role primary, or a bad relatesTo).
  const isPrimary = (rel: FindingRelation): boolean =>
    rel.role === 'primary' || !rel.relatesTo || !idSet.has(rel.relatesTo) || rel.relatesTo === rel.id;
  const primaryIds = new Set([...parsed.values()].filter(isPrimary).map(r => r.id));

  // Demote any principle/consequence whose target isn't itself a primary — no chains.
  for (const rel of parsed.values()) {
    if (rel.role === 'primary') continue;
    if (!rel.relatesTo || !primaryIds.has(rel.relatesTo)) {
      parsed.set(rel.id, { id: rel.id, role: 'primary' });
      primaryIds.add(rel.id);
    }
  }

  // Safety: if nothing is primary (all folded away), the structure is untrustworthy —
  // fall back to a flat list rather than hide every action.
  if (![...parsed.values()].some(r => r.role === 'primary')) return null;

  // Only meaningful if it actually found a relationship.
  if (![...parsed.values()].some(r => r.role !== 'primary')) return null;

  return { byId: parsed };
}

interface RelationsJson { relations?: unknown }

function extractJson(raw: string): RelationsJson | null {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const candidates = [
    cleaned,
    cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1),
  ].filter(s => s.startsWith('{') && s.endsWith('}'));
  for (const c of candidates) {
    try { return JSON.parse(c) as RelationsJson; } catch { /* next */ }
  }
  return null;
}
