import type { ReasoningContext } from './context.js';
import { renderEvidenceBlock } from './context.js';
import type { Opportunity } from '../cli.js';
import { callLLM } from '../llm/index.js';

/** Output of the Explain reasoning mode */
export interface ExplainOutput {
  problem: string;
  whyItMatters: string;
  principles: DesignPrincipleRef[];
  bestInClass: PatternRef[];
  evidence: string;
  confidenceExplanation: string;
}

interface DesignPrincipleRef {
  name: string;
  applies: string; // how it applies to this specific opportunity
}

interface PatternRef {
  product: string;
  pattern: string; // what they do well, not copy-paste
}

const DESIGN_PRINCIPLES = [
  'Visual Hierarchy',
  'Progressive Disclosure',
  "Hick's Law",
  "Fitts's Law",
  'Gestalt',
  'Cognitive Load',
  'Recognition over Recall',
  'Information Scent',
  'Accessibility',
  'Affordance',
  'Consistency',
  'Feedback',
];

const REFERENCE_PRODUCTS = [
  'Stripe', 'Linear', 'Notion', 'Vercel', 'Apple', 'GitHub',
];

/**
 * Generate an Explain output from the shared context.
 * This is NOT an AI call — it's a structured reasoning output
 * that uses the evidence and design principles to teach the user
 * *why* this is a problem.
 *
 * AI enrichment is optional: if an API key is available, the
 * principles and patterns are refined by an LLM call. Otherwise
 * a solid deterministic explanation is returned.
 */
export async function explain(
  ctx: ReasoningContext,
  options?: { apiKey?: string; isAnthropic?: boolean }
): Promise<ExplainOutput> {
  const { opportunity, evidence } = ctx;

  // Build the deterministic base
  const base: ExplainOutput = {
    problem: opportunity.description,
    whyItMatters: opportunity.whyItMatters || 'This affects the user experience.',
    principles: inferPrinciples(opportunity),
    bestInClass: inferPatterns(opportunity),
    evidence: renderEvidenceBlock(evidence),
    confidenceExplanation: buildConfidenceExplanation(opportunity),
  };

  // Optionally enrich with AI
  if (options?.apiKey) {
    try {
      const enriched = await enrichWithAI(ctx, base);
      return { ...base, ...enriched };
    } catch {
      // Fall through to deterministic output
    }
  }

  return base;
}

// ─── Deterministic Inference ────────────────────────────────────

function inferPrinciples(opp: Opportunity): DesignPrincipleRef[] {
  const refs: DesignPrincipleRef[] = [];
  const text = `${opp.title} ${opp.category} ${opp.description}`.toLowerCase();

  const mappings: Record<string, string> = {
    'visual hierarchy': 'hierarchy',
    'hierarchy': 'hierarchy',
    'spacing': 'hierarchy',
    'layout': 'hierarchy',
    'cluttered': 'hierarchy',
    'cognitive': 'cognitive load',
    'overwhelm': 'cognitive load',
    'too many': "Hick's Law",
    'options': "Hick's Law",
    'confusing': 'Affordance',
    'unclear': 'Affordance',
    'click': 'Affordance',
    'recognize': 'Recognition over Recall',
    'remember': 'Recognition over Recall',
    'label': 'Recognition over Recall',
    'icon': 'Recognition over Recall',
    'group': 'Gestalt',
    'proximity': 'Gestalt',
    'similar': 'Gestalt',
    'progress': 'Progressive Disclosure',
    'step': 'Progressive Disclosure',
    'wizard': 'Progressive Disclosure',
    'target': "Fitts's Law",
    'button size': "Fitts's Law",
    'small': "Fitts's Law",
    'contrast': 'Accessibility',
    'screen reader': 'Accessibility',
    'aria': 'Accessibility',
    'keyboard': 'Accessibility',
    'consistent': 'Consistency',
    'pattern': 'Consistency',
    'different': 'Consistency',
    'feedback': 'Feedback',
    'loading': 'Feedback',
    'error': 'Feedback',
  };

  for (const [keyword, principle] of Object.entries(mappings)) {
    if (text.includes(keyword) && !refs.find(r => r.name === principle)) {
      refs.push({
        name: principle,
        applies: `The ${keyword} issue relates to ${principle.toLowerCase()}.`,
      });
    }
  }

  return refs.slice(0, 3);
}

function inferPatterns(opp: Opportunity): PatternRef[] {
  // Default to relevant products based on category
  const categoryPatterns: Record<string, PatternRef[]> = {
    'Design System': [
      { product: 'Linear', pattern: 'Linear maintains strict token discipline — every color, radius, and spacing value is a system variable, creating perfect visual consistency.' },
      { product: 'Vercel', pattern: "Vercel's design system uses a tight spacing scale and consistent border radii that create rhythm without variation." },
    ],
    'Visual Design': [
      { product: 'Stripe', pattern: 'Stripe uses clear visual hierarchy with weight, color, and spacing to guide attention through complex payment flows.' },
      { product: 'Apple', pattern: 'Apple uses generous whitespace and typographic hierarchy to create calm, focused interfaces.' },
    ],
    'Accessibility': [
      { product: 'GitHub', pattern: 'GitHub ensures all interactive elements are keyboard-accessible and properly labeled for screen readers.' },
      { product: 'Notion', pattern: 'Notion maintains high contrast ratios and clear focus indicators throughout its editor.' },
    ],
  };

  return categoryPatterns[opp.category] || [
    { product: 'Stripe', pattern: 'Stripe handles this interaction pattern with clear affordance and minimal cognitive load.' },
  ];
}

function buildConfidenceExplanation(opp: Opportunity): string {
  const pct = Math.round(opp.confidence * 100);
  const reasons: string[] = [];

  if (opp.evidence?.screenshotIndex !== undefined) reasons.push('screenshot evidence');
  if (opp.evidence?.domSnapshotTimestamp) reasons.push('DOM analysis');
  if (opp.evidence?.events?.length) reasons.push(`${opp.evidence.events.length} interaction events`);
  if (opp.observed) reasons.push('drift detection');

  if (reasons.length === 0) {
    return `Confidence is ${pct}% based on automated analysis.`;
  }

  return `Confidence is ${pct}% because the analysis combines ${reasons.join(', ')}.`;
}

// ─── AI Enrichment (optional) ───────────────────────────────────

async function enrichWithAI(
  ctx: ReasoningContext,
  base: ExplainOutput
): Promise<Partial<ExplainOutput>> {
  const prompt = `You are a design educator. Improve this explanation of a UX opportunity.

${renderEvidenceBlock(ctx.evidence)}

**Current explanation:**
Problem: ${base.problem}
Why it matters: ${base.whyItMatters}
Principles identified: ${base.principles.map(p => p.name).join(', ')}

**Design principles available:** ${DESIGN_PRINCIPLES.join(', ')}
**Reference products:** ${REFERENCE_PRODUCTS.join(', ')}

**Task:**
1. Refine the "why it matters" to be more concrete and user-centric (1-2 sentences).
2. Select the 1-3 most relevant design principles and explain HOW each applies to this specific observation (not generic definitions).
3. Name 1-2 products that handle this well and describe their pattern (not copy-paste, describe the pattern).

Respond with JSON:
{
  "whyItMatters": "...",
  "principles": [{"name": "...", "applies": "..."}],
  "bestInClass": [{"product": "...", "pattern": "..."}]
}`;

  const resp = await callLLM('explain', prompt, {
    severity: ctx.opportunity.severity,
    confidence: ctx.opportunity.confidence,
    stage: 'opportunity-explain',
    promptVersion: 'opportunity-explain-v1',
  });

  try {
    const json = JSON.parse(resp.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
    const result: Partial<ExplainOutput> = {};
    if (json.whyItMatters) result.whyItMatters = json.whyItMatters;
    if (json.principles?.length) result.principles = json.principles;
    if (json.bestInClass?.length) result.bestInClass = json.bestInClass;
    return result;
  } catch {
    return {};
  }
}
