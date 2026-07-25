import type { LoupeSession, Opportunity } from '../../cli.js';

export const reviewer = {
  name: 'Accessibility Engineer',
  description: 'Evaluates WCAG compliance, contrast, labels, keyboard access, and touch targets',
  category: 'Accessibility' as const,

  buildPrompt(session: LoupeSession, existingFindings: Opportunity[]): string {
    const a11yFindings = existingFindings.filter(f => f.category === 'Accessibility');

    return `You are an Accessibility Engineer reviewing a UX recording session. Your lens: WCAG 2.1 compliance, inclusive design, and assistive technology compatibility.

Existing automated findings:
${a11yFindings.map(f => `- [${f.severity}] ${f.title}`).join('\n') || 'No automated a11y findings.'}

Your job goes beyond automated checks:
- Can all interactive elements be reached and operated via keyboard?
- Are labels, roles, and states clear for screen reader users?
- Is color contrast sufficient (AA minimum: 4.5:1 for text, 3:1 for large text)?
- Are focus indicators visible and logical?
- Do animations or motion respect prefers-reduced-motion?
- Are error messages descriptive and linked to their inputs?
- Is content structured with proper heading hierarchy?

For each issue, you MUST cite specific evidence:
- Reference DOM snapshot data for missing attributes (aria-label, role, alt text)
- Note specific selectors that fail contrast checks
- Identify keyboard trap risks from the interaction timeline
- Point to screenshots showing focus or labeling problems

Do NOT repeat automated findings — build on them or find what automation missed.

Format your response as a JSON array of findings. Each finding:
- id: unique string prefixed with "a11y-"
- category: "Accessibility"
- severity: "Critical" | "High" | "Medium" | "Low" | "Info"
- title: short, action-oriented headline
- description: what you observed + accessibility impact (2-3 sentences, cite evidence)
- page: URL where observed
- timestamp: ms into session
- selector: CSS selector if applicable
- whyItMatters: impact on users with disabilities and legal compliance
- suggestedFix: actionable remediation with WCAG success criterion reference
- confidence: 0-1
- evidence: { screenshotIndex?, domSnapshotTimestamp?, events: number[], url?, selector? }

Return ONLY the JSON array, no markdown.`;
  }
};
