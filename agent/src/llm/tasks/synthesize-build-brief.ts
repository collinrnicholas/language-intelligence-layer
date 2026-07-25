// ─── Build-brief synthesis (Build This fast path) ────────────────
//
// The 30–60s path: when the user wants an implementation package NOW (they
// already know what to change, or brought a target design), Loupe skips the
// review pipeline entirely — deterministic checks + one vision pass + one
// reasoning call that writes the brief.
//
// The reasoning model works from STRUCTURED observations (vision-observe.ts),
// the transcript, deterministic findings, and design tokens — not raw images.
// With a target design, the observation pass's targetComparison drives the
// brief (Target Design Mode); without one, the brief is built from session
// evidence alone.
//
// The full-fidelity path (narration judge, per-finding targets, critic) still
// exists: run UX Review or Complete Audit first, then build-this picks up the
// analyzed artifact as before.

import type { LoupeSession, Opportunity } from '../../cli.js';
import { callLLM } from './call.js';
import { contextPack } from '../../ai/context-pack.js';
import { memoryPromptBlock } from '../../memory/index.js';
import { observationsBlock, type UIObservation } from './vision-observe.js';
import { resolveModel, REASONING_FALLBACK_MODEL } from '../routing-policy.js';

export interface BuildBriefInputs {
  session: LoupeSession;
  deterministic: Opportunity[];
  observations: UIObservation[];
  tokenLines: string;            // design tokens, "  name: value" per line
  hasTargetDesign: boolean;
  /** User-chosen goal (e.g. "Minimal changes", "Best-in-class UX") — shapes scope. */
  goal: string;
  goalDescription: string;
  /** The coding agent the brief is written for (e.g. "Claude Code"). */
  target: string;
}

function findingLines(findings: Opportunity[]): string {
  if (findings.length === 0) return '(none)';
  return findings
    .map(f => `- [${f.severity}] ${f.title}: ${(f.description || '').replace(/\s+/g, ' ').slice(0, 160)}`)
    .join('\n');
}

function briefPrompt(i: BuildBriefInputs): string {
  const transcript = contextPack(i.session).transcriptBlock || '(no narration)';
  return [
    `You write a concise implementation brief (markdown) from a narrated UI session, to be executed`,
    `by ${i.target} — an autonomous coding agent with access to the codebase. Your brief tells it`,
    'what to change, why, and how to verify. Be specific and evidence-grounded; never pad.',
    '',
    `GOAL: ${i.goal} — ${i.goalDescription}`,
    'The goal governs scope: "Minimal changes" means the smallest diff that resolves the narrated',
    'problems; more ambitious goals may restructure. Never exceed the goal\'s scope.',
    '',
    i.hasTargetDesign
      ? 'A TARGET DESIGN was provided. The targetComparison fields in the observations are the primary work list: bring the current UI to the target. Keep what matches, change what differs.'
      : 'No target design — derive the work list from the narration and observations.',
    '',
    'Structure (exact headings):',
    '# Implementation Brief — <project> / <flow>',
    '## Goal & Context — 2-3 sentences: what this product/screen is, what is wrong, the outcome wanted.',
    '## Changes — numbered findings, most important first. Each: **title**, the evidence (narration',
    'quote or observation), the desired outcome, and 2-3 acceptance criteria as checkboxes. For layout/',
    'hierarchy problems describe the UX OUTCOME and tell the agent to investigate the component —',
    'never prescribe CSS values you cannot verify. For content problems, instruct explore-first.',
    '## Constraints — surgical edits, existing conventions, no scope creep.',
    '## Locating Code — findings reference rendered UI, not source paths; search for the quoted text/selectors.',
    '',
    'Hard rules:',
    '- Quote the reviewer verbatim where narration exists.',
    '- Use design tokens BY NAME when prescribing local styling; never invent hex values.',
    '- 300-600 words total. The value is precision, not volume.',
    '',
    `PROJECT: ${i.session.project} · FLOW: ${i.session.flow}`,
    '',
    memoryPromptBlock(i.session.project, ['Preferences', 'Open recurring issues', 'Prior rejections (caution)']),
    '',
    'NARRATION TRANSCRIPT:',
    transcript,
    '',
    'DETERMINISTIC FINDINGS (already verified by tooling):',
    findingLines(i.deterministic),
    '',
    observationsBlock(i.observations) || '(vision pass unavailable — work from narration + findings)',
    '',
    'DESIGN TOKENS:',
    i.tokenLines || '  (none configured)',
    '',
    'Return ONLY the markdown brief.',
  ].join('\n');
}

/**
 * Produce the fast-path implementation brief. Returns null on total failure —
 * the caller falls back to a deterministic skeleton so the run still ships.
 */
export async function synthesizeBuildBrief(inputs: BuildBriefInputs): Promise<string | null> {
  const prompt = briefPrompt(inputs);
  const primary = resolveModel('buildThis', 'reasoning');
  const models = [primary, REASONING_FALLBACK_MODEL].filter(
    (m, idx, a): m is string => !!m && a.indexOf(m) === idx,
  );

  for (const model of models) {
    try {
      const raw = await callLLM('build', prompt, {
        model,
        maxTokens: 2500,
        responseFormat: 'text',
        stage: 'synthesize-build-brief',
        promptVersion: 'synthesize-build-brief-v1',
      });
      const brief = raw.replace(/^```(markdown)?\s*/i, '').replace(/```\s*$/, '').trim();
      if (brief.startsWith('#')) return brief;
      console.log('[synthesize-build-brief] malformed brief — trying fallback provider');
    } catch (err) {
      console.log(`[synthesize-build-brief] provider failed (${err instanceof Error ? err.message.slice(0, 80) : 'error'}) — trying fallback`);
    }
  }
  return null;
}
