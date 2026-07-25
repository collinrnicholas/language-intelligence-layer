import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Opportunity } from '../cli.js';

const LOUPE_HOME = join(homedir(), '.loupe');

interface DesignSystem {
  color?: Record<string, string>;
  font?: { ui?: string; mono?: string };
  radius?: Record<string, number>;
  space?: number[];
}

/**
 * Generate an implementation prompt from a UX finding.
 * Output is formatted for Claude Code, Codex, Cursor, or any AI coding agent.
 */
export function generateImplementationPrompt(
  finding: Opportunity,
  projectName: string,
  sessionUrl?: string
): string {
  const severity = finding.severity;
  const tokenList = finding.designTokens?.length
    ? finding.designTokens.map(t => `- \`${t}\``).join('\n')
    : '';

  const criteria = finding.acceptanceCriteria?.length
    ? finding.acceptanceCriteria.map(c => `- [ ] ${c}`).join('\n')
    : `- [ ] Fix "${finding.title}" on ${finding.selector || 'the affected element'}`;

  const evidence = finding.evidence
    ? [
        finding.evidence.selector ? `- **Element:** \`${finding.evidence.selector}\`` : '',
        finding.evidence.url ? `- **Page:** ${finding.evidence.url}` : '',
        finding.evidence.screenshotIndex !== undefined ? `- **Screenshot:** #${finding.evidence.screenshotIndex} (see report)` : '',
      ].filter(Boolean).join('\n')
    : '';

  const observed = finding.observed
    ? `\n## Observed\n${finding.observed}`
    : '';

  const expected = finding.expected
    ? `\n## Expected\n${finding.expected}`
    : '';

  return `## Task: ${finding.title}
**Severity:** ${severity}
**Category:** ${finding.category}
**Confidence:** ${Math.round(finding.confidence * 100)}%
**Project:** ${projectName}${sessionUrl ? `\n**URL:** ${sessionUrl}` : ''}

### Problem
${finding.description}

### Why it matters
${finding.whyItMatters}
${observed}${expected}

${evidence ? `### Evidence\n${evidence}\n` : ''}
### What to build
${finding.suggestedFix || 'Fix the issue described above.'}

${tokenList ? `### Design tokens\n${tokenList}\n` : ''}
### Acceptance criteria
${criteria}

---
<!-- loupe:${finding.id} | severity=${severity} | category=${finding.category} -->
`;
}

/**
 * Generate implementation prompts for all findings in priority order.
 * Includes a session-level header with context for the AI coding agent.
 */
export function generateBuildPrompts(
  findings: Opportunity[],
  projectName: string,
  sessionUrl?: string
): string {
  const critical = findings.filter(f => f.severity === 'Critical');
  const high = findings.filter(f => f.severity === 'High');
  const medium = findings.filter(f => f.severity === 'Medium');
  const rest = findings.filter(f => f.severity === 'Low' || f.severity === 'Info');

  const parts: string[] = [];

  // Header
  parts.push(`# Loupe Implementation Prompts — ${projectName}
  
> Generated from a Loupe UX review session. These are production-ready implementation prompts for AI coding agents (Claude Code, Codex, Cursor).
> ${findings.length} findings · ${critical.length} Critical · ${high.length} High · ${medium.length} Medium

## Priority order
Fix issues in this order. Each task is self-contained and can be implemented independently.

---

`);

  // Priority: Critical → High → Medium → Low/Info
  const prioritized = [...critical, ...high, ...medium, ...rest];

  // Deduplicate by selector (don't generate duplicate prompts for same element)
  const seen = new Set<string>();
  let count = 0;
  
  for (const f of prioritized) {
    const dedupKey = f.selector || f.title;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // Check if this finding already has an implementation prompt
    if (f.implementationPrompt) {
      parts.push(f.implementationPrompt);
    } else {
      // Try loading design system for token enrichment
      const tokens = f.designTokens?.length ? f.designTokens : extractTokensFromFinding(f);
      const enriched = { ...f, designTokens: tokens };
      parts.push(generateImplementationPrompt(enriched, projectName, sessionUrl));
    }
    count++;
  }

  return parts.join('\n');
}

/**
 * Attempt to extract relevant design tokens from the finding context.
 */
function extractTokensFromFinding(f: Opportunity): string[] {
  const tokens: string[] = [];

  // From suggestedFix or expected values, look for --token references
  const text = `${f.suggestedFix || ''} ${f.expected || ''} ${f.description || ''}`;
  const tokenMatches = text.match(/--[\w-]+/g);
  if (tokenMatches) {
    tokens.push(...new Set(tokenMatches));
  }

  // From evidence selector, try to infer component tokens
  if (f.selector) {
    if (f.selector.includes('button')) {
      tokens.push('--green', '--on-green', '--green-press', '--r-card');
    }
    if (f.selector.includes('input')) {
      tokens.push('--border', '--r-control', '--text-primary');
    }
    if (f.selector.includes('card')) {
      tokens.push('--surface', '--border', '--r-card', '--shadow-popup');
    }
  }

  return [...new Set(tokens)];
}

/**
 * Load design system tokens for a project. Returns the raw token values
 * for inclusion in implementation prompts.
 */
export function loadTokenMap(projectName: string): Record<string, string> {
  const paths = [
    join(LOUPE_HOME, 'projects', projectName, 'config', 'design-system.json'),
    join(LOUPE_HOME, 'config', 'design-system.json'),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const ds: DesignSystem = JSON.parse(readFileSync(p, 'utf-8'));
        const map: Record<string, string> = {};
        if (ds.color) {
          for (const [key, val] of Object.entries(ds.color)) {
            map[`--${key}`] = val;
          }
        }
        return map;
      } catch { /* continue */ }
    }
  }
  return {};
}

/**
 * Generate a token reference block for inclusion at the top of implementation prompts.
 */
export function generateTokenReference(projectName: string): string {
  const tokens = loadTokenMap(projectName);
  if (Object.keys(tokens).length === 0) return '';

  const entries = Object.entries(tokens)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');

  return `## Design token reference (${projectName})

\`\`\`css
:root {
${entries}
}
\`\`\`

`;
}
