import type { ReasoningContext } from './context.js';
import { renderEvidenceBlock } from './context.js';
import { callLLM } from '../llm/index.js';
import { memoryPromptBlock } from '../memory/index.js';

export interface RedesignOutput {
  goal: string;
  currentExperience: string;
  proposedExperience: ProposedExperience;
  userImpact: string;
  designSystemImpact: DesignSystemImpact;
  risks: string[];
}

export interface ProposedExperience {
  layout: string;
  spacing: string;
  hierarchy: string;
  interaction: string;
  content: string;
  navigation: string;
  visualWeight: string;
  informationArchitecture: string;
}

export interface DesignSystemImpact {
  newComponents: string[];
  modifiedComponents: string[];
  tokenChanges: string[];
  spacingChanges: string[];
  interactionChanges: string[];
}

/**
 * Generate a Redesign proposal from shared context.
 * Shows what a senior product designer would improve — NOT implementation.
 */
export async function redesign(
  ctx: ReasoningContext,
  options?: { apiKey?: string; isAnthropic?: boolean }
): Promise<RedesignOutput> {
  const { opportunity, evidence } = ctx;

  // Deterministic base (from opportunity data)
  const base: RedesignOutput = {
    goal: `Improve: ${opportunity.title}`,
    currentExperience: `The current experience shows ${opportunity.description.slice(0, 200)}`,
    proposedExperience: {
      layout: 'Review layout for improved visual flow.',
      spacing: 'Apply consistent spacing from design system.',
      hierarchy: 'Strengthen visual hierarchy for primary actions.',
      interaction: 'Clarify affordance and interaction states.',
      content: 'Ensure content supports the user task.',
      navigation: 'Verify navigation supports the expected flow.',
      visualWeight: 'Balance visual weight to guide attention.',
      informationArchitecture: 'Structure information for user mental models.',
    },
    userImpact: opportunity.whyItMatters || 'Improved clarity and reduced friction.',
    designSystemImpact: {
      newComponents: [],
      modifiedComponents: [],
      tokenChanges: [],
      spacingChanges: [],
      interactionChanges: [],
    },
    risks: ['May require design review before implementation.'],
  };

  // AI enrichment
  if (options?.apiKey) {
    try {
      const enriched = await enrichRedesignWithAI(ctx, base);
      if (enriched.proposedExperience) base.proposedExperience = { ...base.proposedExperience, ...enriched.proposedExperience };
      if (enriched.userImpact) base.userImpact = enriched.userImpact;
      if (enriched.designSystemImpact) base.designSystemImpact = enriched.designSystemImpact;
    } catch {
      // Fall through to base
    }
  }

  return base;
}

async function enrichRedesignWithAI(
  ctx: ReasoningContext,
  base: RedesignOutput
): Promise<Partial<RedesignOutput>> {
  // Project memory (v1 injection point — approved for Build This + Redesign):
  // the product frame keeps redesigns on-product; preferences constrain them.
  const memoryBlock = memoryPromptBlock(ctx.session.project, ['Product frame', 'Preferences']);

  const prompt = `You are a senior Product Designer. Propose an improved experience for this UX opportunity.

${renderEvidenceBlock(ctx.evidence)}
${memoryBlock ? `\n${memoryBlock}\n` : ''}
**Current finding:**
Title: ${ctx.opportunity.title}
Category: ${ctx.opportunity.category}
Severity: ${ctx.opportunity.severity}
Description: ${ctx.opportunity.description}
Suggested fix: ${ctx.opportunity.suggestedFix || 'Not provided'}

**Task:** Propose how a senior product designer would improve this experience.

Respond with JSON:
{
  "proposedExperience": {
    "layout": "...",
    "spacing": "...",
    "hierarchy": "...",
    "interaction": "...",
    "content": "...",
    "navigation": "...",
    "visualWeight": "...",
    "informationArchitecture": "..."
  },
  "userImpact": "How this change improves user experience (2-3 sentences)",
  "designSystemImpact": {
    "newComponents": [...],
    "modifiedComponents": [...],
    "tokenChanges": [...],
    "spacingChanges": [...],
    "interactionChanges": [...]
  }
}

Keep it concrete and specific to this finding.`;

  const resp = await callLLM('redesign', prompt, {
    severity: ctx.opportunity.severity,
    confidence: ctx.opportunity.confidence,
    stage: 'opportunity-redesign',
    promptVersion: 'opportunity-redesign-v1',
  });

  try {
    return JSON.parse(resp.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
  } catch {
    return {};
  }
}
