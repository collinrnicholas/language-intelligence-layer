// Per-finding LLM target generation.
//
// Replaces the hardcoded, PM-Toolkit-shaped target templates (gray→surface
// tokens, right-rail→overflow-fix) with a target generated for THIS finding from
// its narration + measured styles + design tokens. Templates don't generalize: a
// flat plans-list gets a "rails/centerpiece" target, a dead button gets an
// "overflow" target. Semantic generation reads the reviewer's actual words and
// the real elements, and respects the finding's nature (functional vs visual).
//
// Runs in `analyze` (two gateway calls batched by category) and persists
// generatedTarget/Task/Acceptance on each finding; build-this renders them and
// only falls back to templates when generation is absent.
//
// Content findings run in a separate batch (with enumeration context) so their
// verbose Fable-style targets don't crowd out the shorter functional/visual
// targets when both share a single 4000-token output budget.

import type { LoupeSession, Opportunity } from '../cli.js';
import { callLLM } from '../llm/index.js';
import { measureSelectors, relevantRegions } from './narration.js';
import { productContextBlock, type SessionUnderstanding } from './session-understanding.js';
import { keyframesForFindings } from './keyframes.js';
import { contextPack } from './context-pack.js';

export interface GeneratedFix {
  kind: 'functional' | 'visual' | 'layout' | 'content';
  target: string;
  task: string;
  acceptance: string[];
}

function fmtStyles(s: Record<string, string>): string {
  const p: string[] = [];
  if (s.backgroundColor) p.push(`bg ${s.backgroundColor}`);
  if (s.border) p.push(`border ${s.border}`);
  if (s.boxShadow && s.boxShadow !== 'none') p.push(`shadow ${s.boxShadow.slice(0, 32)}`);
  if (s.overflowX || s.overflowY) p.push(`overflow ${s.overflowX || 'visible'}/${s.overflowY || 'visible'}`);
  if (s.width && s.height) p.push(`${s.width}×${s.height}`);
  if (s.fontSize) p.push(`font ${s.fontSize}`);
  if (s.color) p.push(`color ${s.color}`);
  return p.join(', ');
}

// A "does not work / nothing happens" signal in the reviewer's own words marks a
// FUNCTIONAL bug. We anchor this deterministically and constrain the model,
// because it otherwise flips run-to-run — biased by the element's visual styles
// into proposing a cosmetic fix for a broken behavior.
const FUNCTIONAL_RE = /\b(doesn.?t|does not|do not|don.?t|won.?t|can.?t|cannot|isn.?t|not|never)\s+(?:\w+\s+){0,3}(open|opens|work|working|respond|load|fire|trigger|navigate|submit|save|do|doing|function|render|appear)\w*|\bnothing (happens|opens)\b|\bno (action|response|effect)\b|\bdead (button|link|control)\b|\bbroken (button|link|nav)/i;

const UNMEASURED_FALLBACK = '(no computed styles captured for this element — inspect it directly)';

// Layout / hierarchy / space-allocation / visibility / navigation / workflow /
// interaction problems are architecture-dependent: the right fix emerges from how
// the code lays the region out and how much space siblings consume, NOT from a CSS
// property Loupe can guess from the rendered box. These are described as UX
// OUTCOMES and handed to the agent explore-first — never prescribed as CSS. We
// anchor them deterministically (like FUNCTIONAL_RE) because the model, seeing a
// measurable box, otherwise defaults to prescribing width/overflow/flex — solving
// the symptom, not the UX problem (e.g. "add overflow-x: auto" for a cut-off panel).
const LAYOUT_RE = /\b(layout|hierarch\w*|overflow\w*|off[- ]?screen|cut[- ]?off|clipped|cramped|crowd\w*|space|spacing\s+of\s+the\s+layout|real[- ]?estate|workspace|responsive|reflow|viewport|fit\s+on\s+screen|not\s+(?:fully\s+)?visible|partially\s+visible|prioriti\w*|front\s+and\s+center|primary\s+(?:area|content|workspace|focus)|takes?\s+up\s+too\s+much|too\s+much\s+(?:of\s+the\s+)?(?:screen|space)|hide\b|collaps\w*|position\w*|align\w*|arrange\w*|stack\w*|column\w*|grid\b|sidebar|panel\s+(?:width|size)|navigat\w*|workflow)/i;

function functionalHint(f: Opportunity, session: LoupeSession): boolean {
  const quote = typeof f.narrationNote === 'number' ? session.notes[f.narrationNote]?.text || '' : '';
  return FUNCTIONAL_RE.test(`${quote} ${f.title} ${f.description || ''}`);
}

/** Whether a finding is a layout/hierarchy/space/visibility/navigation concern —
 *  handled explore-first (UX outcome), never prescribed as CSS. Exported for tests. */
export function layoutHint(f: Opportunity, session: LoupeSession): boolean {
  const quote = typeof f.narrationNote === 'number' ? session.notes[f.narrationNote]?.text || '' : '';
  return LAYOUT_RE.test(`${quote} ${f.title} ${f.description || ''}`);
}

/** Compact measured-style context for a finding's elements (or nearest regions). */
function measuredContext(f: Opportunity, session: LoupeSession): string {
  const sels = [f.selector, f.evidence?.selector]
    .filter((s): s is string => !!s)
    .flatMap(s => s.split(',').map(x => x.trim()))
    .filter(Boolean);
  const rows = [...measureSelectors(sels, session).found];
  if (rows.length === 0) {
    rows.push(...relevantRegions(session, { selectors: sels, narrationText: '', topicKey: '' }, 3));
  }
  return rows.map(r => `${r.selector} — ${fmtStyles(r.styles)}`).join('; ')
    || '(no computed styles captured for this element — inspect it directly)';
}

/**
 * Internal: run one LLM call over a subset of findings. Numbers findings
 * 1..N within the batch and maps results back to finding IDs.
 * enumSection is the pre-built content-enumeration block (empty string for
 * non-content batches).
 * transcriptContext is the full session transcript, included so the model can
 * resolve fragment quotes back to their full sentences and understand product context.
 * images (optional) are narration-anchored screenshots for visual layout specifics.
 */
async function runTargetBatch(
  session: LoupeSession,
  batch: Opportunity[],
  tokenLines: string,
  enumSection: string,
  transcriptContext: string,
  images: string[] = [],
  productContext = '',
): Promise<Map<string, GeneratedFix>> {
  const out = new Map<string, GeneratedFix>();
  if (batch.length === 0) return out;

  const hasContent = batch.some(f => f.category === 'Content');

  const blocks = batch.map((f, i) => {
    const quote = typeof f.narrationNote === 'number' ? session.notes[f.narrationNote]?.text?.trim() : undefined;
    const nature = functionalHint(f, session)
      ? 'FUNCTIONAL — the reviewer said it does not work. Describe the observed symptom and tell the agent to locate the code and diagnose the cause; do NOT prescribe a selector, handler, or CSS fix.'
      : layoutHint(f, session)
      ? 'LAYOUT — a space/hierarchy/visibility/navigation problem. Describe the desired UX OUTCOME and hand it to the agent explore-first. Do NOT prescribe CSS (no width/overflow/flex/position guesses). If another finding in this batch would restructure this area, name it and say to do it first, then re-check.'
      : '(decide: functional | visual | layout | content from the reviewer\'s words — prefer LAYOUT for anything about space, hierarchy, visibility, or arrangement; reserve VISUAL for local styling like color/contrast/spacing on a specific element)';
    const styles = measuredContext(f, session);
    const canMeasure = styles !== UNMEASURED_FALLBACK;
    const isContent = f.category === 'Content';
    const contentNature = isContent
      ? 'CONTENT — explore-first required. See CONTENT ENUMERATION above. Do NOT prescribe a specific implementation.'
      : nature;
    return [
      `[${i + 1}]`,
      `  title: ${f.title}`,
      `  category: ${f.category}`,
      `  reviewer said: ${quote ? `"${quote}"` : '(no direct quote)'}`,
      `  finding description: ${(f.description || '').replace(/\s+/g, ' ').slice(0, 300)}`,
      `  NATURE: ${contentNature}`,
      `  measured styles: ${styles}`,
      canMeasure ? null : `  canMeasure: false`,
      isContent ? null : `  reviewer's rough idea: ${(f.suggestedFix || '').replace(/\s+/g, ' ').slice(0, 160) || '(none)'}`,
    ].filter((l): l is string => l !== null).join('\n');
  }).join('\n\n');

  const contentKindBlock = hasContent ? [
    '- content: information structure, naming, and content layout. You have the full enumeration of visible',
    '  items in the "content enumeration" block above. Your target MUST:',
    '  (a) State the specific problem with quoted examples from the enumeration (exact filenames, repeated',
    '      labels, near-duplicate groups).',
    '  (b) Instruct the agent to explore the data model BEFORE writing code: "Find the component that renders',
    '      this list and the schema for items — what metadata is already stored? Report back and propose 2–3',
    '      ranked approaches before implementing."',
    '  (c) List the key ideas to consider (from the enumeration: grouping dimensions, noise to remove, metadata',
    '      to surface, rename/thumbnail options). These are ideas, not prescriptions.',
    '  (d) Add a constraint: "Do not change upload flow or backend storage without confirming first."',
    '  (e) Add a stopping point: "Do not implement until an approach is chosen."',
    '  NEVER prescribe a specific selector, CSS value, or code change for content findings.',
    '  NEVER produce a one-sentence target for a content finding — the minimum is problem + explore + ideas.',
  ].join('\n') : '';

  const targetLengthNote = hasContent
    ? 'Keep functional/visual targets 2–5 lines. Content AND layout targets are longer by design — they\nmust include the problem/desired outcome, an explore instruction, ranked ideas, and a stopping point.'
    : 'Keep functional/visual targets 2–5 lines. Layout targets are longer by design — they must include\nthe desired UX outcome, the component to investigate, any dependency on another finding, 2–3 ranked\napproaches, overflow-only-as-fallback, and a stopping point. Be specific — use the reviewer\'s exact\nwords and the measured values.';

  const contentExampleBlock = hasContent ? [
    '- content (problem + explore-first + ideas + stopping point):',
    '  {"n":1,"kind":"content","target":"Every row shows the same \\"Architectural plans · PDF\\" subtitle —',
    '  identical on all 9 rows, adds no value. Filenames fall into two near-duplicate groups:\\n',
    '  - Address series: Addition#4 / Additionfinal / Additionprelim#2 / Additionprelim#4 (same address,',
    '  different revision suffix)\\n- Sheet series: A001 / A001 (1) / A002 / A003 (sheet numbering)\\n\\n',
    '  Before writing code: find the component that renders this list and the data model for uploaded files',
    '  (what metadata is stored — upload date, file size, page count, category?). Report back and propose',
    '  2–3 ranked approaches.\\n\\nIdeas to consider: group by revision status or drawing type inferred from',
    '  filename; replace the identical subtitle with useful metadata (date, size); add a short user-editable',
    '  label field. Filename-based grouping must degrade gracefully (non-matching files go in \\"Other\\").\\n\\n',
    '  Do not change upload flow or backend storage without confirming first.',
    '  Do not implement until an approach is chosen.",',
    '  "task":"Explore the data model and propose a grouping/differentiation approach for the plan list.",',
    '  "acceptance":["A user can tell items apart at a glance","Identical-on-every-row metadata is removed or',
    '  replaced","Near-duplicate filename groups are visually distinguished"]}',
  ].join('\n') : '';

  const transcriptSection = transcriptContext
    ? `\nFULL SESSION TRANSCRIPT (chronological — use this when a finding quote is a fragment or lacks\nproduct context; the full sentence and surrounding narration are here):\n${transcriptContext}\n`
    : '';

  const screenshotSection = images.length > 0
    ? [
        '',
        `SCREENSHOTS — ${images.length} session keyframe(s) attached (issue moments, screen changes).`,
        'Use these to describe visible layout details with specificity:',
        '  - What element occupies what proportion of the workspace (e.g. "the PDF plan viewer',
        '    occupies roughly 60% of the viewport height")',
        '  - What controls are visible or absent (collapse button, close icon, toggle)',
        '  - What is clipped, overflowing, or cut off at the viewport edge',
        'Avoid vague phrases like "the element is large." Say what you actually see.',
      ].join('\n')
    : '';

  const crossFindingSection = batch.length > 1
    ? [
        '',
        'CROSS-FINDING DEPENDENCIES:',
        'These findings may share a root cause or have an implementation ordering dependency.',
        'If fixing one finding would likely also resolve or substantially reduce the severity of',
        'another finding in this batch, state that in the dependent finding\'s target text — e.g.:',
        '  "Implement [other finding title] first. Once that is done, verify whether this issue',
        '   resolves naturally before making additional changes here."',
        'Only include this language when the dependency is plausible (same layout region,',
        'overlapping root cause). Do not force it on unrelated findings.',
      ].join('\n')
    : '';

  const prompt = [
    'You write the concrete FIX TARGET for UI findings a reviewer narrated aloud. For each finding,',
    'use the reviewer\'s own words, the measured computed styles of the real elements, and the design',
    'tokens to produce a target specific to THAT problem. No generic advice, no templates.',
    productContext,
    '',
    'Loupe observes only the RENDERED DOM and computed styles — it does NOT see the source code.',
    'That determines how prescriptive the target may be, by kind:',
    '',
    '- functional: something does not work (a control fires no action, a view/route does not open, a',
    '  dead button, broken navigation). You can see the SYMPTOM but NOT the cause — the real cause lives',
    '  in code you cannot see (a missing handler, an unwired action, a failing fetch, a routing bug, bad',
    '  state — any of these). So DESCRIBE THE OBSERVED SYMPTOM (what the reviewer did and what failed to',
    '  happen) and INSTRUCT THE AGENT TO LOCATE THE RESPONSIBLE CODE AND DIAGNOSE THE ROOT CAUSE, then',
    '  fix it. Do NOT prescribe a specific selector, handler, function, or code change, and do NOT',
    '  propose CSS — you would only be guessing. When a finding is marked NATURE: FUNCTIONAL below, you',
    '  MUST write a symptom-and-diagnose target, never a prescribed fix.',
    '- layout: how space is allocated, what is primary vs secondary, whether content fits, is',
    '  cut off, or is crowded out — plus navigation, workflow, and interaction structure. The right',
    '  fix depends on the codebase\'s layout architecture (flex/grid parents, container sizing, which',
    '  sibling consumes the space), which Loupe CANNOT see. So do NOT prescribe CSS (never guess',
    '  width/overflow/flex/position/grid values). Instead: (a) state the desired UX OUTCOME in the',
    '  product\'s terms (e.g. "generated documents are the primary workspace and fully visible"),',
    '  grounded in the reviewer\'s words and the measured evidence; (b) name the affected component and',
    '  tell the agent to investigate WHY the area is constrained (what allocates the space, what the',
    '  parent layout is); (c) if another finding in this batch would expand or restructure this area',
    '  (e.g. hiding a sibling panel), name it explicitly and say to implement it first, then re-check',
    '  whether this resolves before changing anything else; (d) explore responsive/layout approaches',
    '  and propose 2–3 ranked options; (e) treat overflow/scrolling as a LAST-RESORT fallback, never',
    '  the primary recommendation — scrolling hides the symptom instead of fixing the hierarchy.',
    '  Do not implement until an approach is chosen.',
    '- visual: LOCAL styling on a specific measured element — color, contrast, background, border,',
    '  radius, shadow, font size/weight, or the spacing of one element. Loupe CAN measure these, so be',
    '  PRESCRIPTIVE: concrete CSS on the actual element, using the design tokens BY NAME. Never invent',
    '  hex values. This kind is ONLY for local look-and-feel — anything about how much space a region',
    '  gets, what is primary, or whether content fits is LAYOUT, not visual.',
    '  Exception — if canMeasure is false: the element was not captured in the DOM snapshot, so you',
    '  cannot verify any selector or CSS value. Describe the problem clearly, then write an explore-first',
    '  target: locate the rendering code, inspect its structure, propose 2-3 approaches, implement the',
    '  best. Never prescribe a selector or CSS value you have not measured.',
    contentKindBlock,
    '',
    targetLengthNote,
    '',
    'acceptance: 2–3 concrete, verifiable outcomes SPECIFIC to this fix and phrased as observable',
    'behavior/state — never generic filler, never a screenshot reference. For functional, state the',
    'behavior that must now work (this is safe — it\'s the observed symptom resolved, not a prescribed',
    'cause). For visual, state the observable visual result. For layout, state the UX outcome (what is',
    'now primary / fully visible / no longer crowded), not a CSS property.',
    '',
    'DESIGN TOKENS:',
    tokenLines,
    screenshotSection,
    transcriptSection,
    crossFindingSection,
    enumSection,
    'FINDINGS:',
    blocks,
    '',
    'Respond with ONLY a JSON array, exactly one object per finding, in order. Example shapes (do NOT',
    'copy this text — write real content for each finding):',
    '- functional (symptom + diagnose, NO selector/fix prescribed):',
    '  {"n":1,"kind":"functional","target":"Symptom: clicking \\"View\\" on a plan does nothing — the plan',
    '  viewer never opens. Locate the code that handles the plan \\"View\\" action and diagnose why it does',
    '  not open the viewer (handler not firing, action unwired, data/route failing, etc.), then fix the',
    '  root cause.","task":"Diagnose and fix why View does not open the plan.",',
    '  "acceptance":["Clicking View opens the plan viewer","The selected plan renders"]}',
    '- visual (LOCAL styling only, prescriptive, token-anchored):',
    '  {"n":2,"kind":"visual","target":"#sidebar text uses color #1a1a1a on a #1c2b5e background — fails',
    '  contrast. Set the sidebar text to var(--textOnInk) so it meets 4.5:1.","task":"Fix sidebar text',
    '  contrast.","acceptance":["Sidebar text meets 4.5:1 contrast","Text uses a design token, not a hex"]}',
    '- layout (outcome-first, explore, NO prescribed CSS, overflow only as fallback):',
    '  {"n":3,"kind":"layout","target":"The document panel (#doc-panel, measured 580px wide with overflow',
    '  hidden) is crowded so the proposal bid is cut off — yet the generated documents are this product\'s',
    '  primary output. Desired outcome: after the plans panel is hidden (see the hide-plans finding), the',
    '  documents become the primary workspace and are fully visible. Investigate what allocates width to',
    '  #doc-panel versus the plans and sidebar regions (the flex/grid parent, any fixed widths). Implement',
    '  the hide-plans finding FIRST, then re-check whether the documents expand to fit. If not, explore',
    '  responsive layout approaches that let the document workspace grow into the reclaimed space, and',
    '  propose 2-3 ranked options. Only if none work, consider overflow handling as a fallback. Do not',
    '  implement until an approach is chosen.","task":"Make the generated documents the primary,',
    '  fully-visible workspace.","acceptance":["Documents are the primary workspace and fully visible',
    '  without horizontal scrolling","The proposal bid is no longer cut off","Hiding plans expands the',
    '  document area"]}',
    contentExampleBlock,
    'target may contain \\n for line breaks. kind is functional|visual|layout|content.',
  ].filter(s => s !== '').join('\n');

  // Content findings need instruction-following precision (enumerate specific filenames,
  // follow the 5-part structure). Use the 'build' task type to route to gpt-4o
  // (model: 'premium') instead of gpt-4o-mini, which ignores the enumeration context.
  // Non-content batches use 'explain' by default; the gateway routes to gpt-4o
  // automatically when images are present.
  const task = hasContent ? 'build' : 'explain';
  let raw: string;
  try {
    raw = await callLLM(task, prompt, {
      severity: 'Medium',
      maxTokens: 4000,
      stage: hasContent ? 'target-generation:content' : 'target-generation:visual-functional',
      promptVersion: 'target-generation-v1',
      ...(images.length > 0 ? { images } : {}),
    });
  } catch {
    return out;
  }

  try {
    const json = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return out;
    for (const item of arr) {
      const idx = Number(item?.n) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue;
      const target = typeof item?.target === 'string' ? item.target.trim() : '';
      if (!target) continue;
      const kind = ['functional', 'visual', 'layout', 'content'].includes(item?.kind) ? item.kind : 'visual';
      const task = typeof item?.task === 'string' ? item.task.trim() : '';
      const acceptance = Array.isArray(item?.acceptance)
        ? item.acceptance.filter((a: unknown): a is string => typeof a === 'string' && a.trim().length > 0).map((a: string) => a.trim())
        : [];
      out.set(batch[idx].id, { kind, target, task, acceptance });
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * Generate a concrete, finding-specific target for each narrated finding.
 * Returns a map keyed by finding id. Empty map on any failure — the caller
 * leaves findings untagged and build-this falls back to templates.
 *
 * Content findings run in a separate batch (with enumeration context, verbose
 * Fable-style targets) from functional/visual findings (shorter prescriptive
 * targets). Running them together caused content verbosity to exhaust the
 * output budget before non-content findings were reached.
 *
 * contentEnumeration: raw output of the content-pattern enumeration call.
 */
export async function generateTargets(
  session: LoupeSession,
  narrated: Opportunity[],
  tokenMap: Record<string, string>,
  contentEnumeration?: string | null,
  understanding?: SessionUnderstanding | null,
): Promise<Map<string, GeneratedFix>> {
  const out = new Map<string, GeneratedFix>();
  if (narrated.length === 0) return out;

  // Product-level frame (gated by confidence) so each target reasons about what
  // the product is FOR, not just its own finding. Empty when absent/low-confidence.
  const productContext = productContextBlock(understanding);

  const tokenLines = Object.entries(tokenMap).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none configured)';

  const contentFindings = narrated.filter(f => f.category === 'Content');
  const nonContentFindings = narrated.filter(f => f.category !== 'Content');

  // Full session transcript — gives the model context to resolve fragment quotes
  // and understand product intent (e.g. "the screen and isn't fully visible" is a
  // cut-off sentence whose full meaning is only clear from adjacent notes).
  const transcriptContext = contextPack(session).transcriptBlock;

  // Enumeration context feeds only the content batch — it's screenshot-derived
  // and only relevant for Content-category targets.
  const enumSection = contentEnumeration && contentFindings.length > 0
    ? `\nCONTENT ENUMERATION (full visible list + patterns from screenshot — use for all Content findings):\n${contentEnumeration}\n`
    : '';

  // For non-content findings, attach up to 3 session keyframes (issue-anchored,
  // route changes, click bursts) so the model can describe visible layout
  // specifics (proportions, absent controls, clipped elements) rather than
  // relying on CSS measurements alone.
  //
  // Exception: a batch where EVERY finding is functional ("does not work") gets
  // no images — functional targets are symptom-and-diagnose by rule, screenshots
  // add nothing, and dropping them turns a premium vision call into a standard
  // text call. Any layout/visual/undecided finding keeps the screenshots.
  const allFunctional = nonContentFindings.length > 0 &&
    nonContentFindings.every(f => functionalHint(f, session) && !layoutHint(f, session));
  const nonContentImages = allFunctional ? [] : keyframesForFindings(session, nonContentFindings, 3);

  const [contentResults, nonContentResults] = await Promise.all([
    runTargetBatch(session, contentFindings, tokenLines, enumSection, transcriptContext, [], productContext),
    runTargetBatch(session, nonContentFindings, tokenLines, '', transcriptContext, nonContentImages, productContext),
  ]);

  for (const [id, fix] of contentResults) out.set(id, fix);
  for (const [id, fix] of nonContentResults) out.set(id, fix);

  return out;
}
