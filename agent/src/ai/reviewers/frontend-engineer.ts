import type { LoupeSession, Opportunity } from '../../cli.js';

export const reviewer = {
  name: 'Frontend Engineer',
  description: 'Evaluates maintainability, console errors, network performance, and CSS implementation',
  category: 'Engineering' as const,

  buildPrompt(session: LoupeSession, existingFindings: Opportunity[]): string {
    const perfFindings = existingFindings.filter(f => f.category === 'Performance');
    const engFindings = existingFindings.filter(f => f.category === 'Engineering');

    return `You are a Frontend Engineer reviewing a UX recording session. Your lens: implementation quality, maintainability, performance, and CSS architecture.

Existing automated findings:
${[...perfFindings, ...engFindings].map(f => `- [${f.severity}] ${f.title}`).join('\n') || 'No automated engineering findings.'}

Your job goes beyond what automation catches:
- Are console errors indicating real bugs or data issues?
- Is the CSS implementation clean — or are there signs of specificity wars, important abuse, or dead code?
- Are network requests properly cached, batched, or paginated?
- Is the DOM structure semantic and reasonable, or bloated?
- Are there performance cliffs (layout thrashing, large repaints, unoptimized images)?
- Could the implementation be simplified or made more maintainable?

For each issue, you MUST cite specific evidence:
- Reference console error messages and their sources
- Point to specific network requests with timing data
- Note DOM patterns that suggest implementation problems
- Quote user narration about performance complaints

Do NOT repeat automated findings — build on them or find what they missed.

Format your response as a JSON array of findings. Each finding:
- id: unique string prefixed with "fe-"
- category: "Engineering" or "Performance"
- severity: "Critical" | "High" | "Medium" | "Low" | "Info"
- title: short, action-oriented headline
- description: what you observed + technical impact (2-3 sentences, cite evidence)
- page: URL where observed
- timestamp: ms into session
- selector: CSS selector if applicable
- whyItMatters: impact on maintainability, performance, or team velocity
- suggestedFix: actionable implementation recommendation
- confidence: 0-1
- evidence: { screenshotIndex?, domSnapshotTimestamp?, events: number[], url?, selector? }

Return ONLY the JSON array, no markdown.`;
  }
};
