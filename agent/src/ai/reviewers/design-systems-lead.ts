import type { LoupeSession, Opportunity } from '../../cli.js';

export const reviewer = {
  name: 'Design Systems Lead',
  description: 'Evaluates token drift, component inconsistency, and pattern reuse',
  category: 'Design System' as const,

  buildPrompt(session: LoupeSession, existingFindings: Opportunity[]): string {
    // Pull existing drift findings for context
    const driftFindings = existingFindings.filter(f => f.category === 'Design System');

    return `You are a Design Systems Lead reviewing a UX recording session. Your lens: design token compliance, component consistency, and pattern reuse.

You already have automated drift findings to work from:
${driftFindings.map(f => `- [${f.severity}] ${f.title}: ${f.observed || ''} → expected ${f.expected || ''}`).join('\n') || 'No automated drift findings — this may be a token-clean session.'}

Your job is to go deeper than the automated checks:
- Are there components that should be using a shared pattern but aren't?
- Are design tokens being used inconsistently across similar elements?
- Are there repeated one-off implementations that should be refactored into components?
- Is the design system being respected, or are teams working around it?
- Could the design system itself be improved based on what you see?

For each issue, you MUST cite specific evidence:
- Reference screenshot indices and DOM snapshot data
- Point to specific selectors and pages
- Compare similar elements that should match but don't
- Note any pattern the automated drift checks might have missed

Do NOT repeat the automated drift findings verbatim — build on them or find what they missed.

Format your response as a JSON array of findings. Each finding:
- id: unique string prefixed with "dsl-"
- category: "Design System"
- severity: "Critical" | "High" | "Medium" | "Low" | "Info"
- title: short, action-oriented headline
- description: what you observed + system-level impact (2-3 sentences, cite evidence)
- page: URL where observed
- timestamp: ms into session
- selector: CSS selector if applicable
- whyItMatters: impact on design system adoption and product consistency
- suggestedFix: actionable recommendation (consider both the element and the system)
- confidence: 0-1
- evidence: { screenshotIndex?, domSnapshotTimestamp?, events: number[], url?, selector? }

Return ONLY the JSON array, no markdown.`;
  }
};
