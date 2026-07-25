import type { LoupeSession, Opportunity } from '../cli.js';

/**
 * Shared context assembled once and fed to all three reasoning modes
 * (Explain, Redesign, Build This). Keeps outputs consistent and eliminates
 * duplicate evidence assembly.
 */
export interface ReasoningContext {
  /** The session data */
  session: LoupeSession;
  /** The opportunity being reasoned about */
  opportunity: Opportunity;
  /** Formatted evidence block for AI prompts */
  evidence: EvidenceBlock;
  /** Design system token map */
  tokenMap: Record<string, string>;
}

export interface EvidenceBlock {
  /** Human-readable evidence summary */
  summary: string;
  /** Screenshot refs near the opportunity timestamp */
  screenshotIndices: number[];
  /** Closest DOM snapshot HTML (truncated) */
  domHtml: string;
  /** Transcript notes within ±10s */
  narrationQuotes: string[];
  /** Events within ±5s, formatted */
  nearbyEvents: string[];
  /** Current URL at time of opportunity */
  url: string;
  /** CSS selector for the element */
  selector: string;
}

/**
 * Build the shared context for an opportunity.
 * Call once, feed to all three modes.
 */
export function buildContext(
  session: LoupeSession,
  opportunity: Opportunity,
  tokenMap: Record<string, string>
): ReasoningContext {
  const timestamp = opportunity.timestamp || 0;
  const window = 5000;

  // Screenshot references
  const screenshotIndices = session.screenshots
    .map((s, i) => ({ ...s, i }))
    .filter(s => Math.abs(s.timestamp - timestamp) < window)
    .map(s => s.i);

  // Closest DOM snapshot before timestamp
  const domSnapshots = session.events
    .filter(e => e.type === 'dom_snapshot' && e.timestamp <= timestamp)
    .sort((a, b) => b.timestamp - a.timestamp);
  const closestDom = domSnapshots[0];
  const domHtml = closestDom && closestDom.type === 'dom_snapshot'
    ? closestDom.html?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800) || ''
    : '';

  // Narration within ±10s
  const narrationQuotes = session.notes
    .filter(n => Math.abs(n.timestamp - timestamp) < 10000)
    .map(n => `[${(n.timestamp / 1000).toFixed(0)}s] "${n.text}"`);

  // Nearby events
  const nearbyEvents = session.events
    .filter(e => Math.abs(e.timestamp - timestamp) < window)
    .slice(0, 10)
    .map(e => {
      switch (e.type) {
        case 'click':
          return `[${(e.timestamp / 1000).toFixed(0)}s] Clicked "${e.textContent?.slice(0, 40)}" on ${e.selector}`;
        case 'scroll':
          return `[${(e.timestamp / 1000).toFixed(0)}s] Scrolled to y=${e.scrollY}`;
        case 'network':
          return `[${(e.timestamp / 1000).toFixed(0)}s] Network: ${e.url?.slice(0, 50)} (${e.duration}ms)`;
        case 'console_error':
          return `[${(e.timestamp / 1000).toFixed(0)}s] Console: ${e.message?.slice(0, 80)}`;
        default:
          return '';
      }
    })
    .filter(Boolean);

  // Current URL
  const currentUrl = session.urlTimeline
    .filter(u => u.timestamp <= timestamp)
    .sort((a, b) => b.timestamp - a.timestamp)[0]?.url || '';

  const selector = opportunity.selector || opportunity.evidence?.selector || '';

  // Build summary
  const summary = [
    `**Opportunity:** ${opportunity.title}`,
    `**Severity:** ${opportunity.severity} | **Category:** ${opportunity.category} | **Confidence:** ${Math.round(opportunity.confidence * 100)}%`,
    `**Description:** ${opportunity.description}`,
    opportunity.observed ? `**Observed:** ${opportunity.observed}` : '',
    opportunity.expected ? `**Expected:** ${opportunity.expected}` : '',
    selector ? `**Selector:** \`${selector}\`` : '',
    currentUrl ? `**Page:** ${currentUrl}` : '',
  ].filter(Boolean).join('\n');

  const evidence: EvidenceBlock = {
    summary,
    screenshotIndices,
    domHtml,
    narrationQuotes,
    nearbyEvents,
    url: currentUrl,
    selector,
  };

  return { session, opportunity, evidence, tokenMap };
}

/**
 * Render the evidence block as a string for inclusion in AI prompts.
 */
export function renderEvidenceBlock(evidence: EvidenceBlock): string {
  const parts: string[] = [];

  parts.push(evidence.summary);

  if (evidence.screenshotIndices.length > 0) {
    parts.push(`\n**Screenshots:** ${evidence.screenshotIndices.map(i => `#${i}`).join(', ')} within ±5s`);
  }

  if (evidence.domHtml) {
    parts.push(`\n**DOM context:** ${evidence.domHtml}`);
  }

  if (evidence.narrationQuotes.length > 0) {
    parts.push(`\n**Narration:**\n${evidence.narrationQuotes.join('\n')}`);
  }

  if (evidence.nearbyEvents.length > 0) {
    parts.push(`\n**Nearby events:**\n${evidence.nearbyEvents.join('\n')}`);
  }

  return parts.join('\n');
}

/**
 * Render design system tokens for AI prompts.
 */
export function renderTokenContext(tokenMap: Record<string, string>): string {
  if (Object.keys(tokenMap).length === 0) return '';
  return Object.entries(tokenMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
}
