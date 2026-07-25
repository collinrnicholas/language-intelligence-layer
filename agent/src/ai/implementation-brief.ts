import { readFileSync, existsSync } from 'node:fs';
import type { Opportunity, LoupeSession } from '../cli.js';
import { designSystemPaths } from '../paths.js';
import { classifyAndMerge, measureSelectors, relevantRegions } from './narration.js';
import type { MergedFinding, MeasuredState, NarrationMatch } from './narration.js';
import type { RelationshipMap } from './finding-relationships.js';

// A BUILD finding after relationship shaping: a primary action (optionally carrying
// the folded-in "why" from principle findings), or a conditional consequence to
// verify after its primary.
interface BuildItem {
  finding: MergedFinding;
  kind: 'primary' | 'consequence';
  principleNotes: string[];        // folded principles' "why" lines (primary only)
  principleFindings: MergedFinding[]; // folded principles, for their verbatim quotes
  conditional?: { afterLabel: string; verify: string };
  dependsOnId?: string;            // internal: primary id a consequence attaches to
  verifyNote?: string;             // internal: consequence verify instruction
}

/** Turn the flat merged BUILD list into an ordered, structured list: each primary
 *  followed by its conditional consequences, with principle findings folded into
 *  their primary's framing. Falls back to a flat all-primary list when there are no
 *  relationships. Labels (B1, B2…) are assigned by final render position. Exported
 *  for tests. */
export function orderBuildItems(build: MergedFinding[], rel: RelationshipMap | null): BuildItem[] {
  const flat = (): BuildItem[] =>
    build.map(f => ({ finding: f, kind: 'primary' as const, principleNotes: [], principleFindings: [] }));
  if (!rel) return flat();

  const relOf = (f: MergedFinding) => rel.byId.get(f.representative.id);
  const roleOf = (f: MergedFinding) => relOf(f)?.role ?? 'primary';
  const primaryIds = new Set(build.filter(f => roleOf(f) === 'primary').map(f => f.representative.id));

  const items: BuildItem[] = [];
  const handled = new Set<string>(); // rendered items AND folded-in principles
  for (const p of build) {
    if (!primaryIds.has(p.representative.id)) continue; // primaries drive the order
    const pid = p.representative.id;
    const principles = build.filter(f => relOf(f)?.role === 'principle' && relOf(f)?.relatesTo === pid);
    items.push({
      finding: p,
      kind: 'primary',
      principleNotes: principles.map(x => relOf(x)?.note).filter((n): n is string => !!n),
      principleFindings: principles,
    });
    handled.add(pid);
    for (const pr of principles) handled.add(pr.representative.id); // folded, not dropped
    for (const c of build.filter(f => relOf(f)?.role === 'consequence' && relOf(f)?.relatesTo === pid)) {
      items.push({
        finding: c, kind: 'consequence', principleNotes: [], principleFindings: [],
        dependsOnId: pid, verifyNote: relOf(c)?.note,
      });
      handled.add(c.representative.id);
    }
  }
  // Defensive: any finding not placed as a primary, folded as a principle, or attached
  // as a consequence renders as its own primary — nothing is ever silently dropped.
  for (const f of build) {
    if (!handled.has(f.representative.id)) items.push({ finding: f, kind: 'primary', principleNotes: [], principleFindings: [] });
  }

  // Assign labels by final position, then resolve each consequence's "after Bx".
  const labelByPrimaryId = new Map<string, string>();
  items.forEach((it, i) => { if (it.kind === 'primary') labelByPrimaryId.set(it.finding.representative.id, `B${i + 1}`); });
  for (const it of items) {
    if (it.kind === 'consequence') {
      it.conditional = {
        afterLabel: labelByPrimaryId.get(it.dependsOnId ?? '') ?? 'the primary finding above',
        verify: it.verifyNote ?? '',
      };
    }
  }
  return items;
}

// ─── Goal Definitions ───────────────────────────────────────────

export const GOALS: Record<string, { description: string; priorities: string[] }> = {
  'Minimal changes': {
    description: 'Smallest possible diff. Fix only what is broken or clearly causing friction. Zero refactoring.',
    priorities: ['Fix drift violations', 'Resolve console errors', 'Address Critical/High findings only', 'Preserve existing layout'],
  },
  'Modernize UI': {
    description: 'Bring visual design up to current standards. Fix the look and feel without restructuring flows.',
    priorities: ['Apply design tokens consistently', 'Improve visual hierarchy', 'Update typography to system fonts', 'Consistent spacing and radius'],
  },
  'Best-in-class UX': {
    description: 'No compromises. Restructure flows where needed. Polish every interaction.',
    priorities: ['Eliminate all user friction', 'Restructure confusing flows', 'Add micro-interactions and transitions', 'Perfect accessibility'],
  },
  'Improve conversions': {
    description: 'Optimize the funnel. Reduce drop-off at every step.',
    priorities: ['Simplify decision points', 'Reduce cognitive load', 'Strengthen CTAs', 'Remove unnecessary steps'],
  },
  'Enterprise polish': {
    description: 'Professional, trustworthy, consistent. Meet enterprise UX standards.',
    priorities: ['Consistent design patterns', 'Clear information hierarchy', 'Professional typography', 'Robust error handling'],
  },
  'Mobile-first': {
    description: 'Optimize for small screens. Everything should work on mobile.',
    priorities: ['Touch targets ≥ 44px', 'Responsive layout', 'No horizontal overflow', 'Thumb-friendly navigation'],
  },
  'Accessibility-first': {
    description: 'Meet WCAG 2.1 AA as the baseline. Inclusive design from the ground up.',
    priorities: ['Keyboard navigation', 'Screen reader labels', 'Color contrast ≥ 4.5:1', 'Focus indicators'],
  },
  'Match design system': {
    description: 'Bring everything into alignment with the design system. Zero drift.',
    priorities: ['Replace hardcoded tokens', 'Use system components', 'Consistent spacing scale', 'Token-only colors'],
  },
};

export type GoalName = keyof typeof GOALS;

export const TARGETS = ['Claude Code', 'Cursor', 'Codex', 'Gemini CLI', 'Generic Prompt', 'Markdown Spec'] as const;
export type TargetName = typeof TARGETS[number];

// ─── Brief Types ────────────────────────────────────────────────

export interface ImplementationBrief {
  title: string;
  goal: GoalName;
  target: TargetName;
  project: string;
  sessionUrl: string;
  goalContext?: string;      // LLM-synthesized plain-language opening (null → deterministic fallback)
  sections: BriefSection[];
  findings: Opportunity[];   // the BUILD (narrated) representatives — what the footer counts
  acceptanceCriteria: string[]; // consolidated per-finding acceptance for the BUILD set (same source as the brief's Acceptance blocks)
}

interface BriefSection {
  heading: string;
  content: string;
}

// ─── Brief Generator ────────────────────────────────────────────

export function generateImplementationBrief(
  findings: Opportunity[],
  session: LoupeSession,
  goal: GoalName,
  target: TargetName,
  goalContext?: string | null,
  uxSynthesis?: string | null,
  relationships?: RelationshipMap | null,
): ImplementationBrief {
  const goalDef = GOALS[goal];
  const sessionUrl = session.urlTimeline[0]?.url || '';
  const tokenMap = loadTokenMap(session.project);

  // Split narrated (actionable) from merely detected, and merge same-issue findings.
  const { build, detected } = classifyAndMerge(findings, session);

  // Shape the flat BUILD list into primaries (with folded-in principle "why") and
  // conditional consequences. `items` is the rendered set; folded principles are not
  // peers, so they leave the findings count — but they are never dropped, their
  // rationale rides along in the primary's framing.
  const items = orderBuildItems(build, relationships ?? null);
  const shaped = items.length < build.length || items.some(it => it.kind === 'consequence');

  const brief: ImplementationBrief = {
    title: `Implementation Brief — ${session.project} / ${session.flow}`,
    goal,
    target,
    project: session.project,
    sessionUrl,
    goalContext: goalContext ?? undefined,
    sections: [],
    findings: items.map(it => it.finding.representative),
    // Same source as each finding's Acceptance block below, so acceptance-criteria.md
    // always matches the brief (never the stale, never-populated f.acceptanceCriteria).
    acceptanceCriteria: items.flatMap(it => buildAcceptance(it.finding)),
  };

  // ─── Section CONTENT (varies per session) ─────────────────────
  // Each section's body is computed here. A section whose content is `null` is
  // omitted from the brief (Design System without tokens, Also Detected without
  // detected findings) — but its POSITION in the template is fixed regardless.
  const durationS = ((new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 1000).toFixed(0);

  const goalContextContent = [
    (goalContext && goalContext.trim()) || fallbackGoalContext(goalDef, session, build),
    '',
    `**Session:** ${session.flow} · ${sessionUrl} · ${durationS}s · ${session.events.length} events · ${session.screenshots.length} screenshots · ${session.notes.length} narration notes`,
  ].join('\n');

  const constraintsContent = buildConstraints(goal);

  const primaryCount = items.filter(it => it.kind === 'primary').length;
  const conditionalCount = items.filter(it => it.kind === 'consequence').length;
  const buildScopeLine = conditionalCount > 0
    ? `**Build the ${primaryCount} primary finding${primaryCount === 1 ? '' : 's'} in the BUILD section below, in order.** ${conditionalCount} of the items ${conditionalCount === 1 ? 'is a' : 'are'} **conditional follow-up${conditionalCount === 1 ? '' : 's'}** — implement the primary first, then verify whether the follow-up is still needed before touching it. These all correlate to what the reviewer narrated, so they are confirmed.`
    : `**Build only the ${items.length} finding${items.length === 1 ? '' : 's'} in the BUILD section below.** These correlate to what the reviewer narrated out loud during the session, so they are confirmed and actionable.`;
  const howToWorkContent = [
    'This brief is a set of measured problems with recommended fixes. **Before implementing, locate the affected components in the code and confirm the fix maps to the actual source — flag if the code tells a different story.**',
    '',
    buildScopeLine,
    '',
    `The **Also Detected** section lists ${detected.length} automated finding${detected.length === 1 ? '' : 's'} (touch targets, network, WCAG, etc.) that the reviewer did **not** narrate. They are included for awareness only. **Do not implement them** unless the user explicitly asks — treat them as a backlog to raise, not a task list.`,
    '',
    '**Locating code:** findings reference *rendered* selectors and regions, not source paths. Search the codebase for the class names, selectors, and visible text quoted below. Do not assume or invent file paths.',
  ].join('\n');

  let designSystemContent: string | null = null;
  if (Object.keys(tokenMap).length > 0) {
    const tokenEntries = Object.entries(tokenMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `  ${name}: ${value};`);
    const relevant = extractRelevantTokens(build.flatMap(m => m.members), tokenMap);
    designSystemContent = [
      'Use these design tokens. Do not hardcode values.',
      '',
      '```css',
      ':root {',
      ...tokenEntries,
      '}',
      '```',
      ...(relevant.length ? ['', '**Key tokens for this brief:**', ...relevant.map(t => `- \`${t}\` — ${tokenMap[t]}`)] : []),
    ].join('\n');
  }

  const buildHeading = shaped
    ? `BUILD — Narrated Findings (${primaryCount} primary${conditionalCount ? ` + ${conditionalCount} conditional` : ''})`
    : `BUILD — Narrated Findings (${items.length})`;
  const buildContent = items.length === 0
    ? [
        'No findings correlated to narration in this session.',
        'Nothing to build. Review the Also Detected section and decide what to action manually.',
      ].join('\n')
    : (() => {
        // When relationships shaped the list, the structure is explicit per-finding
        // (folded rationale + conditional blocks), so the generic theme lead-in would
        // be redundant; keep it only for the flat case.
        const leadIn = shaped ? null : correlatedLeadIn(build);
        const intro = shaped
          ? 'Build these in order. The primary finding carries the reviewer’s own words, the measured current state, and a concrete direction; a conditional follow-up may resolve itself once the primary is done — verify before building it.'
          : 'Implement each of these. Every fix below carries the reviewer’s own words, the measured current state captured in the session, and a concrete target.';
        return [
          intro,
          ...(leadIn ? ['', leadIn] : []),
          '',
          items.map((it, i) => renderBuildFinding(it, i, session, tokenMap)).join('\n\n---\n\n'),
        ].join('\n');
      })();

  const alsoDetectedHeading = `Also Detected — Not Narrated (${detected.length}) · REVIEW ONLY`;
  const alsoDetectedContent = detected.length > 0
    ? [
        '⚠️ **Not part of the build.** These were surfaced by automated checks / AI review but the reviewer never mentioned them. Listed so nothing is silently dropped. Do not implement without explicit sign-off.',
        '',
        detected.map((m, i) => renderDetectedFinding(m, i, session)).join('\n\n'),
      ].join('\n')
    : null;

  const definitionOfDoneContent = [
    'Before considering this complete, confirm:',
    '',
    ...items.map(it => {
      const shot = screenshotLabel(it.finding);
      const suffix = shot ? ` (cross-check ${shot})` : '';
      return it.kind === 'consequence'
        ? `- [ ] ${it.finding.title} — verified after ${it.conditional?.afterLabel ?? 'the primary'}, and fixed only if it remained${suffix}`
        : `- [ ] ${it.finding.title} — resolved${suffix}`;
    }),
    '- [ ] Each fix was confirmed against the actual source before editing',
    '- [ ] No new console errors introduced',
    '- [ ] Colors/spacing use design tokens, not hardcoded values',
    '- [ ] Changes limited to the narrated findings above',
  ].join('\n');

  // ─── Section ORDER (a CONSTANT — never varies, never conditional) ──
  // This single sequence is the brief template. Every session, every site emits
  // sections in exactly this order; only the content above differs. Sections with
  // `null` content are skipped, but the relative order of whatever appears is
  // invariant. Locked by the "brief section order is constant" test.
  const template: Array<{ heading: string; content: string | null }> = [
    { heading: 'Goal & Context', content: goalContextContent },
    { heading: 'Constraints', content: constraintsContent },
    { heading: 'How to Work This Brief', content: howToWorkContent },
    { heading: 'Design System', content: designSystemContent },
    { heading: 'UX/Product Synthesis', content: uxSynthesis ?? null },
    { heading: buildHeading, content: buildContent },
    { heading: alsoDetectedHeading, content: alsoDetectedContent },
    { heading: 'Definition of Done', content: definitionOfDoneContent },
  ];
  for (const section of template) {
    if (section.content !== null) brief.sections.push({ heading: section.heading, content: section.content });
  }

  return brief;
}

/**
 * The canonical brief section order — the fixed template every brief follows.
 * Headings for BUILD / Also Detected carry a dynamic count suffix at render time;
 * these are the stable prefixes. Exported so the section-order test and any
 * consumer can assert against a single source of truth.
 */
export const BRIEF_SECTION_ORDER = [
  'Goal & Context',
  'Constraints',
  'How to Work This Brief',
  'Design System',
  'UX/Product Synthesis',
  'BUILD',
  'Also Detected',
  'Definition of Done',
] as const;

// ─── Envelope helpers ───────────────────────────────────────────

/** Deterministic Goal & Context when LLM synthesis is absent (non-primary
 *  callers, or a gateway failure). Plain, session-specific, no boilerplate. */
function fallbackGoalContext(
  goalDef: { description: string },
  session: LoupeSession,
  build: MergedFinding[]
): string {
  const themes = build.slice(0, 3).map(m => m.title).join('; ');
  const flow = session.flow || 'This flow';
  const project = session.project || 'the app';
  const n = build.length;
  return `${flow} in ${project} has ${n} confirmed issue${n === 1 ? '' : 's'} the reviewer flagged during the session${themes ? `: ${themes}` : ''}. Goal — ${goalDef.description.split('.')[0]}.`;
}

const LEADIN_STOP = new Set([
  // structural words
  'the', 'and', 'for', 'with', 'without', 'from', 'into', 'that', 'this', 'your',
  'their', 'are', 'not', 'has', 'have', 'does', 'below', 'above', 'button', 'buttons',
  // generic finding-prose words — present in most titles, so useless as a theme
  'lack', 'issue', 'issues', 'problem', 'problems', 'poor', 'missing', 'broken',
  'inconsistent', 'difficulty', 'insufficient', 'ambiguous', 'flat', 'unclear',
  'non', 'defect', 'error', 'errors', 'risk', 'bad', 'wrong', 'incorrect',
]);

/** When two or more BUILD findings share a salient title term, emit one lead-in
 *  so the agent treats them as a coherent change rather than isolated patches.
 *  Deterministic (title-token overlap) — the synthesized end state lives in
 *  Goal & Context; this just names the relationship. */
function correlatedLeadIn(build: MergedFinding[]): string | null {
  if (build.length < 2) return null;
  const tokensPer = build.map(m => new Set(
    m.title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter(t => t.length >= 4 && !LEADIN_STOP.has(t))
  ));
  const idxsByToken = new Map<string, number[]>();
  tokensPer.forEach((set, i) => set.forEach(t => {
    const arr = idxsByToken.get(t) || [];
    arr.push(i);
    idxsByToken.set(t, arr);
  }));
  let best: { token: string; idxs: number[] } | null = null;
  for (const [token, idxs] of idxsByToken) {
    if (idxs.length < 2) continue;
    // Prefer the theme shared by the most findings; on a tie, the longer (more
    // specific) token — "hierarchy" beats "plans".
    if (!best || idxs.length > best.idxs.length ||
        (idxs.length === best.idxs.length && token.length > best.token.length)) {
      best = { token, idxs };
    }
  }
  if (!best) return null;
  const labels = best.idxs.map(i => `B${i + 1}`).join(', ');
  return `> **Related:** ${labels} all concern **${best.token}** — treat them as one coherent change toward the shared outcome in Goal & Context, not isolated patches.`;
}

// ─── Per-finding renderers ──────────────────────────────────────

function renderBuildFinding(
  item: BuildItem,
  index: number,
  session: LoupeSession,
  tokenMap: Record<string, string>
): string {
  const m = item.finding;
  const isConditional = item.kind === 'consequence';
  const lines: string[] = [];
  const heading = isConditional
    ? `### B${index + 1}. [${m.severity}] ${m.title} — conditional (after ${item.conditional?.afterLabel ?? 'the primary'})`
    : `### B${index + 1}. [${m.severity}] ${m.title}`;
  lines.push(heading);
  lines.push(`**Confidence:** ${Math.round(m.confidence * 100)}%${m.mergedTitles.length ? ` · **Merged from ${m.members.length}:** ${m.mergedTitles.join('; ')}` : ''}`);
  lines.push('');

  // What the user said — verbatim narration, the ground truth.
  lines.push('**What the reviewer said:**');
  for (const nm of m.narration) {
    lines.push(`> “${nm.text}” — (${nm.startS.toFixed(0)}s–${nm.endS.toFixed(0)}s)`);
  }
  lines.push('');

  // Folded-in design principle: another narrated finding IS the reason to do this
  // one. Show its "why" and preserve the reviewer's own words for it — nothing dropped.
  if (item.principleNotes.length > 0) {
    lines.push('**Why this is the priority (the reviewer’s stated goal):**');
    for (const note of item.principleNotes) lines.push(note);
    const principleQuotes = item.principleFindings.flatMap(p => p.narration);
    for (const nm of principleQuotes) {
      lines.push(`> “${nm.text}” — (${nm.startS.toFixed(0)}s–${nm.endS.toFixed(0)}s)`);
    }
    lines.push('');
  }

  // Current measured state — real captured computed styles, or explicit absence.
  const measured = measureSelectors(m.selectors, session);
  lines.push('**Current measured state (from session capture):**');
  lines.push(renderMeasured(measured, session, m));
  lines.push('');

  // Screenshot reference — a session pointer, NOT a file path (the brief is used
  // in the target repo, where no screenshots/ dir exists).
  const shot = screenshotLabel(m);
  if (shot) {
    lines.push(`**Reference:** ${shot} (in the Loupe session, for context)`);
    lines.push('');
  }

  if (isConditional) {
    // A consequence: implementing the primary may resolve this. Verify first; only
    // fix if it remains. Do NOT prescribe a parallel fix up front.
    const after = item.conditional?.afterLabel ?? 'the primary finding';
    lines.push(`**Conditional — do this only after ${after}:**`);
    lines.push(item.conditional?.verify?.trim() || `After implementing ${after}, verify whether this issue still occurs; only apply a separate fix if it remains.`);
    lines.push('');
    lines.push(`**Task:** After ${after}, verify whether “${m.title}” persists; fix only if it does.`);
    lines.push('');
    lines.push('**Acceptance:**');
    lines.push(`- [ ] ${after} was implemented first, then this was re-checked`);
    for (const c of buildAcceptance(m)) lines.push(`- [ ] Only if the issue remained: ${c}`);
    return lines.join('\n');
  }

  // Concrete target + task. Framed as "recommended" — the confirm-against-source
  // gate in "How to Work This Brief" tells the agent to verify it fits the code.
  lines.push('**Recommended target:**');
  lines.push(buildTarget(m, tokenMap));
  lines.push('');
  lines.push(`**Task:** ${buildTask(m)}`);
  lines.push('');

  // Concrete acceptance checks.
  lines.push('**Acceptance:**');
  for (const c of buildAcceptance(m)) lines.push(`- [ ] ${c}`);

  return lines.join('\n');
}

function renderDetectedFinding(m: MergedFinding, index: number, session: LoupeSession): string {
  const o = m.representative;
  const lines: string[] = [];
  lines.push(`**D${index + 1}. [${m.severity}] ${m.title}** (${o.category}, ${Math.round(m.confidence * 100)}%)${m.members.length > 1 ? ` · merged ${m.members.length}` : ''}`);
  // The detector description already carries the raw measurements (px lists, ms lists).
  const desc = (o.description || '').trim();
  if (desc) lines.push(desc.length > 600 ? desc.slice(0, 600) + '…' : desc);
  const measured = measureSelectors(m.selectors, session);
  if (measured.found.length) {
    lines.push('Measured: ' + measured.found.map(f => `\`${f.selector}\` ${compactStyles(f.styles)}`).join(' · '));
  }
  return lines.join('\n');
}

function renderMeasured(measured: MeasuredState, session: LoupeSession, m: MergedFinding): string {
  const out: string[] = [];
  const shownKeys = new Set<string>();
  for (const f of measured.found) {
    shownKeys.add(f.selector);
    // Concept matches are approximate (abstract selector → captured region by
    // layout role), so tell the agent to confirm against the screenshot.
    const note =
      f.matchType === 'concept' ? `  _(matched \`${f.matchedFrom}\` by layout role — verify against the screenshot)_` :
      f.matchType === 'contains' && f.selector !== f.matchedFrom ? `  _(for \`${f.matchedFrom}\`)_` : '';
    out.push(`- \`${f.selector}\` — ${compactStyles(f.styles)}${note}`);
  }

  if (measured.missing.length) {
    // Couldn't pin these selectors to a key. Rather than "inspect directly",
    // offer the layout regions most relevant to THIS finding (the clipped rail
    // for a bug, the gray surfaces for a hierarchy finding) so the agent has real
    // background/border/overflow to work from — it picks by position/screenshot.
    const ctx = {
      selectors: m.selectors,
      narrationText: m.narration.map(n => n.text).join(' '),
      topicKey: m.key,
    };
    const regions = relevantRegions(session, ctx, 4).filter(r => !shownKeys.has(r.selector));
    if (regions.length) {
      out.push(`- Couldn't pin \`${measured.missing.join('`, `')}\` to one element. Most relevant layout regions captured (match by position/screenshot):`);
      for (const r of regions) out.push(`  - \`${r.selector}\` — ${compactStyles(r.styles)}`);
    } else {
      for (const sel of measured.missing) {
        out.push(`- \`${sel}\` — no computed styles captured for this element. Inspect it directly in the DOM.`);
      }
    }
  }

  if (out.length === 0) {
    out.push('- No selector recorded for this finding — locate the element from the narration and screenshot.');
  }
  return out.join('\n');
}

function compactStyles(s: Record<string, string>): string {
  const parts: string[] = [];
  // Region-signal group first: background / border / box-shadow / overflow are
  // the ground truth for "sections blend together" (shared bg, no separating
  // edge) and "rail shows clipped content" (overflow: hidden). `none`/transparent
  // are *meaningful* here, so they're shown; overflow: visible is the default,
  // so it's suppressed as noise.
  const bg = normColor(s.backgroundColor);
  if (bg) parts.push(`background: ${bg}`);
  const border = normBorder(s.border);
  if (border) parts.push(`border: ${border}`);
  const shadow = normShadow(s.boxShadow);
  if (shadow) parts.push(`box-shadow: ${shadow}`);
  const overflow = normOverflow(s.overflowX, s.overflowY);
  if (overflow) parts.push(`overflow: ${overflow}`);

  if (s.color) parts.push(`color: ${normColor(s.color) || s.color}`);
  if (s.width && s.height) parts.push(`size: ${trimPx(s.width)}×${trimPx(s.height)}px`);
  else if (s.height) parts.push(`height: ${trimPx(s.height)}px`);
  if (s.borderRadius && s.borderRadius !== '0px') parts.push(`radius: ${s.borderRadius}`);
  if (s.fontSize) parts.push(`font: ${s.fontSize}`);
  if (s.display) parts.push(`display: ${s.display}`);
  return parts.join(' · ') || '(no notable props)';
}

/** rgba(0,0,0,0) → transparent; otherwise the value verbatim. */
function normColor(v: string | undefined): string | null {
  if (!v) return null;
  const flat = v.replace(/\s+/g, '');
  if (flat === 'rgba(0,0,0,0)' || flat === 'transparent') return 'transparent';
  return v;
}

const BORDER_STYLE_KEYWORDS = new Set([
  'none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset',
]);

/**
 * Reduce a captured `border` value to a single clean edge, e.g.
 * `1px solid rgb(228, 227, 222)` or `none`.
 *
 * Handles both the clean shorthand and the legacy malformed capture, where
 * per-side longhands were concatenated when the four sides differ — e.g.
 * `1px 0px 0px  solid none none  rgb(…) rgb(…) rgb(…)`. We split the value into
 * width tokens, style keywords, and color tokens, then surface the first side
 * that actually has a visible edge (real style + non-zero width); if none does,
 * the border reads as `none` (which is meaningful signal downstream).
 */
function normBorder(v: string | undefined): string | null {
  if (!v) return null;
  const raw = v.trim();
  if (!raw || raw === 'none') return raw ? 'none' : null;

  // Pull color tokens out first (they contain spaces/commas); the rest is
  // width + style keywords.
  const colors = raw.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/g) || [];
  const tokens = raw.replace(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/g, ' ').split(/\s+/).filter(Boolean);
  const widths = tokens.filter(t => /^[\d.]+(px|em|rem|pt)?$|^0$|^thin$|^medium$|^thick$/.test(t));
  const styles = tokens.filter(t => BORDER_STYLE_KEYWORDS.has(t));

  // First side with a real (non-none) border style.
  const sideIdx = styles.findIndex(st => st !== 'none' && st !== 'hidden');
  if (sideIdx === -1) return 'none';
  const style = styles[sideIdx];
  const width = (widths[sideIdx] && parseFloat(widths[sideIdx]) > 0)
    ? widths[sideIdx]
    : widths.find(w => parseFloat(w) > 0);
  if (!width || parseFloat(width) === 0) return 'none';
  const color = colors[sideIdx] || colors[0];
  return [width, style, color].filter(Boolean).join(' ');
}

/** `none` is signal (no elevation between regions); long shadows are truncated. */
function normShadow(v: string | undefined): string | null {
  if (!v) return null;
  if (v === 'none') return 'none';
  return v.length > 48 ? v.slice(0, 45) + '…' : v;
}

/** Combine axes; suppress the `visible` default so only real clipping shows. */
function normOverflow(x: string | undefined, y: string | undefined): string | null {
  const nx = x && x !== 'visible' ? x : null;
  const ny = y && y !== 'visible' ? y : null;
  if (!nx && !ny) return null;
  if (nx && ny) return x === y ? x! : `x ${x} / y ${y}`;
  return nx ? `x ${nx}` : `y ${ny}`;
}

function trimPx(v: string): string {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n.toFixed(1).replace(/\.0$/, '') : v;
}

/** Path-free session pointer, e.g. "session screenshot #16" — never a local file
 *  path, since the brief is consumed in the target repo, not the Loupe package. */
function screenshotLabel(m: MergedFinding): string | null {
  if (m.screenshotIndexes.length === 0) return null;
  return `session screenshot #${m.screenshotIndexes[0]}`;
}

function tokenRef(map: Record<string, string>, name: string): string {
  const key = name.startsWith('--') ? name : `--${name}`;
  return map[key] ? `\`${key}\` (${map[key]})` : `\`${key}\``;
}

/** Concrete, token-anchored target — the per-finding LLM target when available,
 *  else the (PM-Toolkit-shaped) topic templates as an offline fallback. */
function buildTarget(m: MergedFinding, map: Record<string, string>): string {
  if (m.representative.generatedTarget?.trim()) return m.representative.generatedTarget.trim();
  switch (m.key) {
    case 'visual-hierarchy':
      return [
        `Make the header, rails, and centerpiece read as distinct planes instead of one gray field. Concrete values:`,
        `- Centerpiece / main content on ${tokenRef(map, 'surface')}.`,
        `- Left and right rails on ${tokenRef(map, 'surfaceSunken')} so they recede from the content.`,
        `- Separate adjacent regions with a 1px ${tokenRef(map, 'border')} (or ${tokenRef(map, 'borderStrong')}) edge; give the header a bottom ${tokenRef(map, 'divider')}.`,
        `Do not introduce new gray values — use only the tokens above.`,
      ].join('\n');
    case 'ui-bug':
      // ui-bug now covers any concrete UI defect. Only clip/overflow bugs get the
      // overflow-specific guidance; other defects (e.g. a control that doesn't
      // respond) fall back to the reviewer's own intent.
      if (isClipBug(m)) {
        return [
          `A region renders partly cut off / clipped and looks broken. Make its content fully visible.`,
          `- Start from the measured state above: a region showing \`overflow: hidden\` is the prime suspect — its content is clipped rather than scrolled.`,
          `- Check that container (and its scroll parent) for a fixed width/height smaller than its content, the clipping \`overflow: hidden\`, or a transform/position offset pushing it past the viewport edge.`,
          `- If the content legitimately overflows, use \`overflow-y: auto\` so it scrolls rather than clips.`,
        ].join('\n');
      }
      return reviewerIntentTarget(m);
    case 'collapsible-rails':
      return [
        `The rails can collapse but expose no affordance. Add a visible, discoverable toggle.`,
        `- Add a chevron/caret control on each rail’s header, ≥24px icon inside a ≥44px hit area.`,
        `- Color it ${tokenRef(map, 'textBody')} at rest, ${tokenRef(map, 'textPrimary')} on hover; rotate to indicate state.`,
      ].join('\n');
    default:
      return reviewerIntentTarget(m);
  }
}

/** True when the defect is specifically a clipping/overflow bug (vs. any other
 *  UI defect like an unresponsive control). Drives clip-specific guidance. */
function isClipBug(m: MergedFinding): boolean {
  const text = m.members.map(x => `${x.title} ${x.description}`).join(' ').toLowerCase();
  return /\b(clip|clipped|clipping|overflow|cut ?off|cut-off|partial|partially|truncat)\w*/.test(text);
}

/** Anchor to the reviewer's own fix intent when there's no canned target. */
function reviewerIntentTarget(m: MergedFinding): string {
  return m.representative.suggestedFix?.trim()
    ? `Reviewer intent: ${m.representative.suggestedFix.trim()}\n(Translate to concrete values against the measured state and screenshot above.)`
    : `Resolve the issue described above using concrete values measured from the element and the design tokens.`;
}

function buildTask(m: MergedFinding): string {
  if (m.representative.generatedTask?.trim()) return m.representative.generatedTask.trim();
  switch (m.key) {
    case 'visual-hierarchy': return 'Differentiate the header, rails, and centerpiece so each region reads as a separate surface.';
    case 'ui-bug': return isClipBug(m) ? 'Fix the clipped/cut-off region so its content is fully visible.' : m.title + '.';
    case 'collapsible-rails': return 'Add a visible collapse/expand affordance to each rail.';
    default: return m.title + '.';
  }
}

function buildAcceptance(m: MergedFinding): string[] {
  // Generated criteria are already concrete and finding-specific — use as-is,
  // with no screenshot-path anchor appended.
  const gen = m.representative.generatedAcceptance;
  if (gen && gen.length) return gen;
  switch (m.key) {
    case 'visual-hierarchy':
      return [
        'Header, rails, and centerpiece are visually distinguishable at a glance',
        'Region backgrounds/borders use design tokens only (no new gray hex values)',
      ];
    case 'ui-bug':
      return isClipBug(m)
        ? ['Affected region’s content is fully visible with no clipped or cut-off edge']
        : [`${m.title} resolved — the element behaves as the reviewer expected`];
    case 'collapsible-rails':
      return [
        'Each rail shows a visible collapse/expand control',
        'Control hit area is ≥44px and keyboard operable',
        'Collapsed/expanded state is visually indicated',
      ];
    default:
      return [`${m.title} resolved`];
  }
}

// ─── Render Brief to Markdown ───────────────────────────────────

export function renderBriefToMarkdown(brief: ImplementationBrief): string {
  const lines: string[] = [];
  const { goal } = brief;
  const goalDef = GOALS[goal];

  lines.push(`# ${brief.title}`);
  lines.push('');
  lines.push(`> **Goal:** ${goal} — ${goalDef.description.split('.')[0]}.`);
  lines.push(`> **Project:** ${brief.project}`);
  lines.push(`> **Findings to build:** ${brief.findings.length} (narrated only — see BUILD section)`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const section of brief.sections) {
    lines.push(`## ${section.heading}`);
    lines.push('');
    lines.push(section.content);
    lines.push('');
  }

  lines.push('---');
  lines.push(`*Generated by Loupe — ${new Date().toISOString()}*`);
  lines.push(`*Goal: ${goal} | ${brief.findings.length} narrated finding(s) to build*`);

  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────

export function loadTokenMap(project: string): Record<string, string> {
  for (const p of designSystemPaths(project)) {
    if (existsSync(p)) {
      try {
        const ds = JSON.parse(readFileSync(p, 'utf-8'));
        const map: Record<string, string> = {};
        if (ds.color) {
          for (const [key, val] of Object.entries(ds.color as Record<string, string>)) {
            map[`--${key}`] = val;
          }
        }
        return map;
      } catch { /* continue */ }
    }
  }
  return {};
}

function extractRelevantTokens(
  findings: Opportunity[],
  tokenMap: Record<string, string>
): string[] {
  const tokens = new Set<string>();
  for (const f of findings) {
    if (f.designTokens) f.designTokens.forEach(t => tokens.add(t));
    // Extract from suggestedFix
    const text = `${f.suggestedFix || ''} ${f.expected || ''} ${f.description || ''}`;
    const matches = text.match(/--[\w-]+/g);
    if (matches) matches.forEach(m => tokens.add(m));
  }
  // Only return tokens that exist in the map
  return [...tokens].filter(t => tokenMap[t]);
}

function buildConstraints(goal: string): string {
  const lines: string[] = [];

  // Baseline — always applied (one format, not gated on a target selection).
  lines.push('- Do not modify files outside the scope of these findings.');
  lines.push('- Preserve existing functionality. Make surgical edits.');
  lines.push('- Use existing project conventions and patterns.');
  lines.push('- Add comments explaining non-obvious changes.');

  if (goal === 'Minimal changes') {
    lines.push('- Only fix what is listed. No refactoring or "improvements" beyond scope.');
    lines.push('- Preserve all existing class names and DOM structure where possible.');
  }

  if (goal === 'Accessibility-first') {
    lines.push('- All interactive elements must be keyboard accessible.');
    lines.push('- Add aria-labels and roles where missing.');
    lines.push('- Ensure color contrast meets WCAG 2.1 AA minimum (4.5:1 for text).');
  }

  if (goal === 'Match design system') {
    lines.push('- Every color must reference a design token. Zero hex values.');
    lines.push('- Every spacing value must be from the design system scale.');
    lines.push('- Use `var(--token)` syntax, not hardcoded values.');
  }

  if (goal === 'Mobile-first') {
    lines.push('- All interactive elements must have touch targets ≥ 44px.');
    lines.push('- No horizontal overflow at 320px viewport width.');
    lines.push('- Test layout at 320px, 375px, and 768px breakpoints.');
  }

  // Escape valve — a sanctioned path to raise scope rather than silently expand
  // it or skip the real fix (mirrors the frontier "flag it and ask first" rule).
  lines.push('- If the right fix needs a change outside these findings’ scope, flag it and ask before making it — don’t silently expand scope or skip the fix.');

  return lines.join('\n');
}
