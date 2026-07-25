// Unified product reasoning — one call that produces BOTH the brief's opening
// "Goal & Context" paragraph and the deeper "UX/Product Synthesis" section.
//
// These were two separate LLM calls (goal-context-generator + ux-synthesis) that
// re-derived the same product understanding from the same inputs — duplicated work
// and a more layered prompt stack. They are now one call, seeded by the analyze-time
// SessionUnderstanding, emitting two delimited blocks. We keep them as delimited
// markdown (not JSON fields) so a large markdown synthesis isn't fragile-escaped
// inside JSON — see the prompt-critic-v2 lesson.
//
// Runs at build time (the goal is chosen in build-this, not analyze). Returns nulls
// on failure so the brief falls back to its deterministic Goal & Context line and
// simply omits the synthesis section.

import type { LoupeSession, Opportunity } from '../cli.js';
import { callLLM } from '../llm/index.js';
import { classifyAndMerge } from './narration.js';
import { contextPack } from './context-pack.js';
import { memoryPromptBlock } from '../memory/index.js';
import { GOALS, type GoalName } from './implementation-brief.js';
import { productContextBlock, type SessionUnderstanding } from './session-understanding.js';

export interface ProductReasoning {
  goalContext: string | null;  // the opening paragraph (null → brief uses deterministic fallback)
  synthesis: string | null;    // the six-subsection section (null → omitted, or synthesis disabled)
  raw: string;                 // raw model output, for the debug artifact
}

const GC_MARK = '===GOAL_CONTEXT===';
const SYN_MARK = '===SYNTHESIS===';

export async function generateProductReasoning(
  findings: Opportunity[],
  session: LoupeSession,
  goal: GoalName,
  includeSynthesis: boolean,
  understanding?: SessionUnderstanding | null,
): Promise<ProductReasoning> {
  const empty: ProductReasoning = { goalContext: null, synthesis: null, raw: '' };

  // Ground both outputs in the SAME narrated set the brief builds from.
  const { build } = classifyAndMerge(findings, session);
  if (build.length === 0) return empty;

  const goalDef = GOALS[goal];
  const url = session.urlTimeline[0]?.url || '';
  const durationS = (
    (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 1000
  ).toFixed(0);

  const transcriptText = contextPack(session).transcriptBlock || '(no transcript)';

  const findingLines = build.map((m, i) => {
    const quotes = m.narration.map(n => `"${n.text.trim()}"`).join(' | ');
    const target = m.representative.generatedTarget?.trim()
      || m.representative.suggestedFix?.trim()
      || '(no target generated)';
    return [
      `B${i + 1}. [${m.severity}] ${m.title} (${m.representative.category})`,
      quotes ? `   What the reviewer said: ${quotes}` : null,
      `   Generated target: ${target.slice(0, 400)}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const synthesisSpec = includeSynthesis
    ? [
        `Then output the marker line exactly: ${SYN_MARK}`,
        'After it, write the UX/Product synthesis as SIX labeled subsections, in order, using the bold',
        'labels exactly as shown. Each subsection must be specific to THIS session — no generic UX advice.',
        '',
        '**Product purpose:** One sentence. What is this product and its primary output? Name the specific',
        '  category (e.g. "AI document generator", "construction PM tool").',
        '**User\'s goal in this session:** One sentence. What was the reviewer trying to accomplish?',
        '**Root UX problem:** 2–3 sentences. The underlying architectural/design issue behind the symptoms —',
        '  the WHY, not a restatement of finding titles (information hierarchy, layout inversion, broken model).',
        '**How the findings connect:** 2–4 sentences. Independent problems, or one root cause in two places?',
        '  If fixing one finding resolves another, say so and name them by B-number.',
        '**Implementation strategy:** An ordered list of 3–5 steps. What to do first and why; make sequencing',
        '  explicit; end each step with the expected outcome.',
        '**Success criteria:** 2–4 observable product outcomes that define "done" (not "button works" but',
        '  "users can [goal] without [the friction]").',
      ].join('\n')
    : `Do NOT output the ${SYN_MARK} marker or any synthesis — only the Goal & Context paragraph.`;

  const prompt = [
    'You write the product-reasoning parts of an implementation brief handed to an AI coding agent.',
    'Produce two things from the session below, separated by exact marker lines.',
    productContextBlock(understanding),
    // Project memory (v1 injection point): recurring issues sharpen the "why
    // now" framing; preferences and rejections keep the brief on-policy.
    memoryPromptBlock(session.project, ['Preferences', 'Open recurring issues', 'Prior rejections (caution)']),
    '',
    `First output the marker line exactly: ${GC_MARK}`,
    'After it, write the opening "Goal & Context" paragraph: 2–4 sentences, plain language, the way you',
    'would explain the situation to a teammate. It must (a) say what the app/screen/flow is, (b) say what',
    'is actually wrong now — grounded in the SPECIFIC findings and the reviewer\'s words, naming real',
    'problems, and (c) state the outcome we are aiming for, consistent with the goal. No bullet points,',
    'no heading, no restating the goal label verbatim, no generic UX boilerplate.',
    '',
    synthesisSpec,
    '',
    'Hard rules for everything: every sentence must be specific to THIS session — a reader must not be',
    'able to lift it onto a different product. No generic UX boilerplate ("improve the user experience").',
    'Output ONLY the marker lines and their content — no preamble, no closing summary.',
    '',
    `PROJECT: ${session.project || '(unknown)'}`,
    `FLOW: ${session.flow || '(unknown)'}`,
    `URL: ${url || '(unknown)'}`,
    `DURATION: ${durationS}s`,
    `GOAL: ${goal} — ${goalDef.description}`,
    '',
    'FULL NARRATION TRANSCRIPT:',
    transcriptText,
    '',
    'NARRATED FINDINGS BEING BUILT:',
    findingLines,
  ].filter(s => s !== '').join('\n');

  let raw: string;
  try {
    raw = await callLLM('build', prompt, {
      severity: 'High',
      maxTokens: 1500,
      responseFormat: 'text',
      // Use ':' so the routing.json prefix matcher (which splits on ':') maps both
      // variants to the "product-reasoning" stage key. A '+' here silently missed it.
      stage: includeSynthesis ? 'product-reasoning:synthesis' : 'product-reasoning',
      promptVersion: 'product-reasoning-v1',
    });
  } catch {
    return empty;
  }

  return { ...parseProductReasoning(raw, includeSynthesis), raw };
}

export function parseProductReasoning(
  raw: string,
  includeSynthesis: boolean,
): Pick<ProductReasoning, 'goalContext' | 'synthesis'> {
  const text = raw.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '').trim();
  const gcIdx = text.indexOf(GC_MARK);
  const synIdx = text.indexOf(SYN_MARK);

  let goalContext: string | null = null;
  let synthesis: string | null = null;

  if (gcIdx !== -1) {
    const gcStart = gcIdx + GC_MARK.length;
    const gcEnd = synIdx !== -1 && synIdx > gcIdx ? synIdx : text.length;
    goalContext = text.slice(gcStart, gcEnd).trim() || null;
  } else if (synIdx === -1) {
    // No markers at all — treat the whole thing as the goal-context paragraph.
    goalContext = text || null;
  }

  if (includeSynthesis && synIdx !== -1) {
    synthesis = text.slice(synIdx + SYN_MARK.length).trim() || null;
  }

  return { goalContext, synthesis };
}
