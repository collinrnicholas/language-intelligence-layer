import { readFileSync, existsSync } from 'node:fs';
import { extname, basename, resolve } from 'node:path';
import type { LoupeSession } from '../cli.js';
import type { TargetComparison } from '../llm/tasks/vision-observe.js';

// ─── Types ──────────────────────────────────────────────────────

export type TargetFormat = 'png' | 'jpg' | 'webp' | 'html' | 'markdown' | 'unknown';

export interface TargetDesign {
  /** Path to the original target file */
  path: string;
  /** Detected format */
  format: TargetFormat;
  /** Basename for copying into package */
  basename: string;
  /** Text content (for HTML/markdown) or description (for image) */
  content: string;
  /** Type-specific metadata */
  meta: TargetMetadata;
}

export interface TargetMetadata {
  /** For images: dimensions if detectable */
  width?: number;
  height?: number;
  /** For HTML: stripped text, number of elements */
  elementCount?: number;
  /** For markdown: section count */
  sectionCount?: number;
}

export interface GapAnalysis {
  currentLayout: string;
  targetLayout: string;
  hierarchyDifferences: string[];
  spacingDifferences: string[];
  typographyDifferences: string[];
  colorDifferences: string[];
  componentDifferences: string[];
  interactionDifferences: string[];
}

export interface ImplementationGuidance {
  keep: string[];
  replace: string[];
  modifyComponents: string[];
  cssTokensToUpdate: string[];
  layoutStructure: string;
}

// ─── Target Loader ─────────────────────────────────────────────

export function detectTargetFormat(path: string): TargetFormat {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case '.png': return 'png';
    case '.jpg': case '.jpeg': return 'jpg';
    case '.webp': return 'webp';
    case '.html': case '.htm': return 'html';
    case '.md': case '.markdown': return 'markdown';
    default: return 'unknown';
  }
}

export function loadTargetDesign(targetPath: string): TargetDesign {
  const absPath = resolve(targetPath);
  if (!existsSync(absPath)) {
    throw new Error(`Target design not found at: ${absPath}`);
  }

  const format = detectTargetFormat(absPath);
  const name = basename(absPath);
  const stats = { fileSize: readFileSync(absPath).length };

  const base: TargetDesign = {
    path: absPath,
    format,
    basename: name,
    content: '',
    meta: {},
  };

  if (format === 'html') {
    const raw = readFileSync(absPath, 'utf-8');
    const stripped = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    base.content = stripped;
    const elementCount = (raw.match(/<([a-z][a-z0-9]*)\b/gi) || []).length;
    base.meta = { elementCount };
  } else if (format === 'markdown') {
    const raw = readFileSync(absPath, 'utf-8');
    base.content = raw;
    const sectionCount = (raw.match(/^##/gm) || []).length;
    base.meta = { sectionCount };
  } else {
    // Image formats — store the path, content is a description
    base.content = `Visual reference: ${name} (${(stats.fileSize / 1024).toFixed(1)}KB, ${format.toUpperCase()})`;
    base.meta = {};
  }

  return base;
}

// ─── Gap Analysis (deterministic) ──────────────────────────────

export function runGapAnalysis(
  session: LoupeSession,
  target: TargetDesign,
  existingOpportunities: any[]
): GapAnalysis {
  // Current layout from session screenshots and DOM snapshots
  const domSnapshots = session.events.filter(e => e.type === 'dom_snapshot');
  const currentHtml = domSnapshots
    .map(d => d.type === 'dom_snapshot' ? d.html?.slice(0, 500) : '')
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000);

  const currentSnapshot = domSnapshots[0]?.type === 'dom_snapshot'
    ? domSnapshots[0].html?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
    : 'No DOM snapshot available';

  // Build analysis based on available evidence
  const gap: GapAnalysis = {
    currentLayout: currentSnapshot || 'No DOM snapshot available — use screenshots as visual reference.',
    targetLayout: target.format === 'html'
      ? `HTML target with ${target.meta.elementCount || 'unknown'} elements`
      : target.format === 'markdown'
        ? `Markdown spec with ${target.meta.sectionCount || 'unknown'} sections`
        : 'Visual reference image — see target-design/ directory',
    hierarchyDifferences: extractHierarchyDiff(currentHtml, target),
    spacingDifferences: extractSpacingDiffs(session),
    typographyDifferences: extractTypographyDiffs(session),
    colorDifferences: extractColorDiffs(session, existingOpportunities),
    componentDifferences: extractComponentDiffs(session),
    interactionDifferences: extractInteractionDiffs(session),
  };

  return gap;
}

function extractHierarchyDiff(currentHtml: string, target: TargetDesign): string[] {
  const diffs: string[] = [];
  if (target.format === 'html') {
    const currentHeadings = (currentHtml.match(/<h[1-6]/gi) || []).length;
    const targetStr = readFileSync(target.path, 'utf-8');
    const targetHeadings = (targetStr.match(/<h[1-6]/gi) || []).length;
    if (currentHeadings !== targetHeadings) {
      diffs.push(`Current has ${currentHeadings} headings vs target's ${targetHeadings}`);
    }
  }
  diffs.push('Review visual hierarchy — compare screenshots in screenshots/ vs target-design/');
  return diffs;
}

function extractSpacingDiffs(session: LoupeSession): string[] {
  const diffs: string[] = [];
  // Sample spacing from computed styles
  const spacings = new Set<number>();
  for (const e of session.events) {
    if (e.type === 'dom_snapshot' && e.computedStyles) {
      for (const css of Object.values(e.computedStyles)) {
        for (const key of ['padding', 'margin', 'gap']) {
          const val = css[key];
          if (val) {
            const px = parseFloat(val);
            if (!isNaN(px) && px > 0) spacings.add(px);
          }
        }
      }
    }
  }
  if (spacings.size > 0) {
    diffs.push(`Current spacing values detected: ${[...spacings].sort((a,b) => a-b).join(', ')}px`);
  }
  diffs.push('Compare against target design layout for spacing alignment.');
  return diffs;
}

function extractTypographyDiffs(session: LoupeSession): string[] {
  const diffs: string[] = [];
  const fonts = new Set<string>();
  for (const e of session.events) {
    if (e.type === 'dom_snapshot' && e.computedStyles) {
      for (const css of Object.values(e.computedStyles)) {
        if (css['fontFamily']) fonts.add(css['fontFamily']);
      }
    }
  }
  if (fonts.size > 0) {
    diffs.push(`Current fonts: ${[...fonts].join(', ')}`);
  }
  return diffs;
}

function extractColorDiffs(session: LoupeSession, opportunities: any[]): string[] {
  const diffs: string[] = [];
  const colorOpps = opportunities.filter(o => o.category === 'Design System' && o.observed);
  if (colorOpps.length > 0) {
    diffs.push(`${colorOpps.length} design system color violations detected in current UI`);
    colorOpps.slice(0, 3).forEach(o => {
      diffs.push(`  ${o.selector || 'element'}: observed ${o.observed}, expected ${o.expected || 'token'}`);
    });
  }
  return diffs;
}

function extractComponentDiffs(session: LoupeSession): string[] {
  const diffs: string[] = [];
  const selectors = new Set<string>();
  for (const e of session.events) {
    if (e.type === 'dom_snapshot' && e.computedStyles) {
      for (const sel of Object.keys(e.computedStyles)) {
        selectors.add(sel);
      }
    }
  }
  if (selectors.size > 0) {
    diffs.push(`${selectors.size} distinct CSS selectors in current UI`);
  }
  return diffs;
}

function extractInteractionDiffs(session: LoupeSession): string[] {
  const diffs: string[] = [];
  const clicks = session.events.filter(e => e.type === 'click').length;
  const scrolls = session.events.filter(e => e.type === 'scroll').length;
  diffs.push(`Recording captured ${clicks} clicks and ${scrolls} scroll events`);
  if (clicks > 0) {
    diffs.push('Interaction patterns can be inferred from event timeline');
  }
  return diffs;
}

// ─── Implementation Guidance Generator ─────────────────────────

export function generateImplementationGuidance(
  session: LoupeSession,
  target: TargetDesign,
  gap: GapAnalysis,
  /** The project's own design-token names, so guidance never prescribes tokens
   *  from another project (e.g. Loupe's `--ink`/`--green`). When empty, guidance
   *  points at "the project's existing tokens" instead of naming any. */
  tokenNames: string[] = []
): ImplementationGuidance {
  const buttonSelectors = new Set<string>();
  const inputSelectors = new Set<string>();
  const layoutSelectors = new Set<string>();

  for (const e of session.events) {
    if (e.type === 'dom_snapshot' && e.computedStyles) {
      for (const sel of Object.keys(e.computedStyles)) {
        if (sel.includes('button') || sel.includes('btn')) buttonSelectors.add(sel);
        else if (sel.includes('input') || sel.includes('form') || sel.includes('select')) inputSelectors.add(sel);
        else layoutSelectors.add(sel);
      }
    }
  }

  const colorTokens = tokenNames.filter(t => /color|ink|green|surface|text|bg|border|accent|brand/i.test(t)).slice(0, 6);
  const radiusTokens = tokenNames.filter(t => /radius|-r-|rounded/i.test(t)).slice(0, 4);
  const namedOrGeneric = (named: string[], kind: string) =>
    named.length ? `Use the project's ${kind} tokens (${named.join(', ')})` : `Use the project's existing ${kind} tokens`;

  return {
    keep: [
      'Navigation structure (unless target specifies changes)',
      'Functional logic — recording, event capture',
      'Existing accessibility attributes',
    ],
    replace: [
      `Layout structure to match target ${target.format === 'html' ? 'HTML' : 'design'}`,
      "Color values — use the project's design-system tokens where available",
      target.format === 'html' ? 'Component markup structure' : 'Visual styling to match target image',
    ],
    modifyComponents: [
      ...[...buttonSelectors].slice(0, 3).map(s => `Update ${s} styling`),
      ...[...inputSelectors].slice(0, 3).map(s => `Update ${s} styling`),
    ],
    cssTokensToUpdate: [
      `${namedOrGeneric(colorTokens, 'color')} for color alignment — do not hardcode hex values`,
      `${namedOrGeneric(radiusTokens, 'radius')} for corner-radius alignment`,
      'Spacing — align to the target using the project spacing scale',
      'Typography — match the target using the project font-family/size tokens',
    ],
    layoutStructure: gap.currentLayout
      ? `Current DOM structure: ${gap.currentLayout.slice(0, 200)}. Rebuild to match target ${target.format}.`
      : `Rebuild layout to match target design in target-design/${target.basename}`,
  };
}

// ─── Acceptance Criteria Generator ─────────────────────────────

/**
 * Acceptance criteria for a target build. Kept evidence-qualified: image targets
 * carry no extracted spacing/typography, so those checks are phrased as visual
 * matches ("verify against the target") rather than asserting a measured match
 * the deterministic pass never actually established.
 */
export function generateTargetAcceptanceCriteria(
  gap: GapAnalysis
): string[] {
  const hasSpacingSignal = gap.spacingDifferences.some(d => /\d/.test(d));
  const hasTypographySignal = gap.typographyDifferences.length > 0;
  return [
    'Current UI visually matches the target design (compare against target-design/)',
    'Layout structure and component hierarchy align with the target (headings, groupings, CTAs)',
    hasSpacingSignal
      ? 'Spacing matches the target, using the project spacing scale (no off-scale one-offs)'
      : 'Spacing visually matches the target, using the project spacing scale',
    hasTypographySignal
      ? 'Typography matches the target (font-family, sizes, weights) per the extracted current styles'
      : 'Typography visually matches the target (font-family, sizes, weights)',
    "Color values use the project's design-system tokens, with no hardcoded values",
    'Existing recording functionality remains unchanged',
    'No hardcoded one-off styles unless explicitly justified',
  ];
}

// ─── Brief Section Generator ───────────────────────────────────

export interface TargetSectionOptions {
  /** The persisted artifact's display name and id, when built via the artifact store. */
  name?: string;
  id?: string;
  /** Source filename inside the package's target-design/ dir (e.g. `source.png`). */
  sourceFile?: string;
  /** Vision current-vs-target delta (images). When absent, the deterministic gap is used. */
  comparison?: TargetComparison | null;
}

export function generateTargetDesignSection(
  target: TargetDesign,
  gap: GapAnalysis,
  guidance: ImplementationGuidance,
  criteria: string[],
  opts: TargetSectionOptions = {}
): string {
  const lines: string[] = [];
  const sourceFile = opts.sourceFile ?? target.basename;

  lines.push('## Target Design');
  lines.push('');
  lines.push('This target is the **desired state**. Bring the current UI to it.');
  lines.push('');
  if (opts.name) lines.push(`**Name:** ${opts.name}`);
  if (opts.id) lines.push(`**Target ID:** \`${opts.id}\``);
  lines.push(`**Format:** ${target.format.toUpperCase()}`);
  lines.push(`**File:** \`target-design/${sourceFile}\` · **Record:** \`target-design/target.json\``);
  lines.push('');
  if (target.format === 'html') {
    lines.push('**HTML target.** The target is a structured HTML mockup. Use it as a direct structural reference for rebuilding the UI.');
  } else if (target.format === 'markdown') {
    lines.push('**Markdown spec.** The target is a design specification document. Translate each section into concrete UI implementation.');
  } else {
    lines.push('**Image target.** Use the image in `target-design/` as a visual reference. Translate the design into implementation — do not describe the image, implement from it.');
  }
  lines.push('');

  // Current vs Target — prefer the vision delta (images); fall back to the
  // deterministic gap analysis (html/markdown, or when vision was unavailable).
  lines.push('### Current vs Target');
  lines.push('');
  if (opts.comparison && opts.comparison.targetProvided) {
    const c = opts.comparison;
    const block = (title: string, items: string[]) => {
      if (!items.length) return;
      lines.push(`**${title}:**`);
      items.forEach(i => lines.push(`- ${i}`));
      lines.push('');
    };
    block('Major differences (vision)', c.majorDifferences);
    block('Keep (already matches target)', c.elementsToKeep);
    block('Change (differs from target)', c.elementsToChange);
    block('Add (present in target, missing from current)', c.missingFromCurrent);
    block('Remove (present in current, not in target)', c.presentButShouldBeRemoved);
    if (!c.majorDifferences.length && !c.elementsToChange.length) {
      lines.push('_Vision reported no material differences from the target._');
      lines.push('');
    }
  } else {
    lines.push(`**Current layout:** ${gap.currentLayout.slice(0, 300)}`);
    lines.push(`**Target layout:** ${gap.targetLayout}`);
    lines.push('');
  }

  lines.push('**Session signal (deterministic, from the recording):**');
  lines.push('');
  if (gap.hierarchyDifferences.length > 0) {
    lines.push('**Hierarchy differences:**');
    gap.hierarchyDifferences.forEach(d => lines.push(`- ${d}`));
    lines.push('');
  }
  if (gap.spacingDifferences.length > 0) {
    lines.push('**Spacing differences:**');
    gap.spacingDifferences.forEach(d => lines.push(`- ${d}`));
    lines.push('');
  }
  if (gap.typographyDifferences.length > 0) {
    lines.push('**Typography differences:**');
    gap.typographyDifferences.forEach(d => lines.push(`- ${d}`));
    lines.push('');
  }
  if (gap.colorDifferences.length > 0) {
    lines.push('**Color differences:**');
    gap.colorDifferences.forEach(d => lines.push(`- ${d}`));
    lines.push('');
  }
  if (gap.componentDifferences.length > 0) {
    lines.push('**Component differences:**');
    gap.componentDifferences.forEach(d => lines.push(`- ${d}`));
    lines.push('');
  }
  if (gap.interactionDifferences.length > 0) {
    lines.push('**Interaction differences:**');
    gap.interactionDifferences.forEach(d => lines.push(`- ${d}`));
    lines.push('');
  }

  lines.push('### Implementation Implications');
  lines.push('');

  if (guidance.keep.length > 0) {
    lines.push('**Keep:**');
    guidance.keep.forEach(k => lines.push(`- ${k}`));
    lines.push('');
  }
  if (guidance.replace.length > 0) {
    lines.push('**Replace:**');
    guidance.replace.forEach(r => lines.push(`- ${r}`));
    lines.push('');
  }
  if (guidance.modifyComponents.length > 0) {
    lines.push('**Modify components:**');
    guidance.modifyComponents.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }
  if (guidance.cssTokensToUpdate.length > 0) {
    lines.push('**CSS/tokens to update:**');
    guidance.cssTokensToUpdate.forEach(t => lines.push(`- ${t}`));
    lines.push('');
  }
  if (guidance.layoutStructure) {
    lines.push('**Layout structure:**');
    lines.push(guidance.layoutStructure);
    lines.push('');
  }

  lines.push('### Acceptance Criteria');
  criteria.forEach(c => lines.push(`- [ ] ${c}`));

  return lines.join('\n');
}
