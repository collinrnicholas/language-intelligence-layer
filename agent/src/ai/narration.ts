// Narration correlation, semantic dedupe, and captured-evidence extraction for
// the Build This generator.
//
// The analyzer flattens deterministic checks, drift checks, and AI persona
// findings into one array with no provenance tag (see commands/analyze.ts). The
// build brief must nonetheless separate what the user *narrated* (actionable,
// gets full fix instructions) from what was merely *detected* (touch targets,
// network latency, WCAG — listed for review only). We reconstruct that split
// here by correlating each finding against the session's transcript notes, then
// merge findings that describe the same underlying issue.

import type { Opportunity, LoupeSession, NoteEntry, SessionEvent } from '../cli.js';

// ─── Tokenization ───────────────────────────────────────────────

// Generic/context words that must never count as a narration match. Includes the
// scene-setting terms from the opening narration ("Toolkits Workspace, Create
// Project Workflow page") so a finding doesn't correlate just by naming the app.
const STOPWORDS = new Set([
  'the', 'and', 'are', 'was', 'for', 'you', 'your', 'this', 'that', 'those',
  'these', 'with', 'within', 'have', 'has', 'had', 'here', 'there', 'then',
  'they', 'them', 'their', 'its', 'our', 'okay', 'were', 'will', 'going',
  'first', 'next', 'thing', 'things', 'look', 'looking', 'notice', 'noticed',
  'review', 'reviewing', 'user', 'users', 'use', 'using', 'able', 'ability',
  'can', 'may', 'might', 'make', 'makes', 'made', 'lead', 'leads', 'leading',
  'very', 'more', 'most', 'some', 'such', 'which', 'where', 'when', 'what',
  'ui', 'ux', 'app', 'page', 'pages', 'site', 'view', 'screen', 'element',
  'elements', 'component', 'components', 'section', 'sections', 'area', 'areas',
  'workflow', 'project', 'projects', 'create', 'workspace', 'toolkit', 'toolkits',
  'session', 'flow', 'experience', 'interface', 'overall', 'across', 'between',
  'different', 'difference', 'differences', 'determine', 'impact', 'impacts',
  'affect', 'affects', 'affecting', 'issue', 'issues', 'problem', 'problems',
  'usability', 'friction', 'frustration', 'confusion', 'confusing', 'poor',
  'good', 'better', 'clear', 'clearly', 'unclear', 'find', 'found', 'focus',
  'navigate', 'navigation', 'help', 'helps', 'need', 'needs', 'should', 'could',
]);

// Strong layout-region nouns. A single shared region noun is enough to correlate
// a finding to narration — the user pointing at "the right rail" is a strong tie.
const REGION_WORDS = new Set([
  'header', 'rail', 'rails', 'centerpiece', 'sidebar', 'navbar', 'nav',
  'footer', 'panel', 'panels', 'toolbar', 'drawer', 'modal', 'dialog',
  'banner', 'hero', 'breadcrumb', 'menu',
]);

// Directional modifiers carry no topic on their own — "left"/"right" only
// locate a region, they don't say what's wrong with it. Treated as content-less
// so a note that merely shares "right rail" doesn't read as being *about* the
// finding. (Kept separate from REGION_WORDS so a lone "right" can't classify.)
const MODIFIER_WORDS = new Set([
  'left', 'right', 'top', 'bottom', 'center', 'side', 'upper', 'lower', 'middle',
]);

function isContentless(t: string): boolean {
  return REGION_WORDS.has(t) || MODIFIER_WORDS.has(t);
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

// Selectors carry region signal ('.right-rail' → right, rail). Split on class/id
// punctuation and kebab boundaries; keep region words even if <3 chars is n/a.
function selectorTokens(selector: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!selector) return out;
  for (const raw of selector.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function findingTokens(f: Opportunity): Set<string> {
  const toks = tokenize(`${f.title} ${f.description} ${f.whyItMatters || ''}`);
  for (const t of selectorTokens(f.selector)) toks.add(t);
  for (const t of selectorTokens(f.evidence?.selector)) toks.add(t);
  return toks;
}

// ─── Topic classification ───────────────────────────────────────
//
// Each finding — and each narration note — is reduced to a small set of concern
// "topics". Classification (narrated vs detected) then asks a *semantic*
// question: does this finding's topic match something the reviewer actually
// talked about? That is far more robust than raw word overlap, which on verbose
// LLM findings lets anything mentioning "gray/UI/center" staple itself to a quote.

// Topics that are, by nature, machine-detected. They never enter BUILD on keyword
// proximity to a quote. But some of them a human reviewer can plausibly *voice*
// ("this button is tiny", "this screen is really slow"), so an explicit judge
// verdict may still promote those into BUILD — see NARRATABLE_DETECTED.
const DETECTED_ONLY_TOPICS = new Set(['touch-targets', 'network', 'console-errors']);

// Of the machine-detected topics, the ones a reviewer can plausibly narrate out
// loud. A finding in one of these enters BUILD only when the LLM judge explicitly
// confirms the reviewer spoke about it (`f.narrated === true`) — keyword overlap
// is never enough. console-errors is absent on purpose: a user never narrates a
// console error, so it stays review-only no matter what.
const NARRATABLE_DETECTED = new Set(['touch-targets', 'network']);

// First matching topic (in this order) wins for a finding's canonical key.
const TOPIC_ORDER = [
  'touch-targets', 'network', 'console-errors', 'accessibility',
  'collapsible-rails', 'ui-bug', 'visual-hierarchy', 'design-system',
];

/** Every concern topic a piece of text mentions (a note can carry several). */
function topicsOf(text: string): Set<string> {
  const toks = tokenize(text);
  const raw = (text || '').toLowerCase();
  const has = (...w: string[]) => w.some(x => toks.has(x));
  const out = new Set<string>();
  if ((has('touch') && has('target', 'targets')) || /\b44\s?px\b|\bmin-height\b/.test(raw)) out.add('touch-targets');
  if (has('network', 'requests', 'request', 'latency', 'endpoint', 'loading', 'lag') || /\bapi\b/.test(raw)) out.add('network');
  if (has('console') && has('error', 'errors')) out.add('console-errors');
  if (has('keyboard', 'aria', 'wcag', 'tabindex', 'role', 'roles', 'label', 'labels', 'screenreader')) out.add('accessibility');
  if (has('collapse', 'collapsible', 'collapsed', 'collapsing')) out.add('collapsible-rails');
  // TEMPORARY vocab patch (2026-07-01) to unblock the Nicholas/NNA session — the
  // keyword classifier over-fit the PM Toolkit. Do NOT keep growing this; it's
  // superseded by the LLM-judge correlation gate. The two extra clauses below
  // (broken-interaction phrases, flat/clarity) exist only for that stopgap.
  if (has('bug', 'broken', 'defect', 'clipped', 'clip', 'partial', 'exposed', 'glitch', 'overflow', 'unresponsive', 'nonfunctional')
      || /\bcut off\b|\bcut-off\b|\bno[- ]?op\b|\bnon-functional\b|\bdoesn.?t\s+(?:\w+\s+){0,2}(open|work|respond|load|function)\b|\bnot\s+(?:\w+\s+){0,2}(open|work|respond|load|function)\w*/.test(raw)) out.add('ui-bug');
  if (has('gray', 'grey', 'hierarchy', 'contrast', 'distinguish', 'blend', 'blends', 'monochrome', 'muted', 'flat', 'flatness', 'clarity', 'depth')) out.add('visual-hierarchy');
  if (has('token', 'tokens', 'hardcoded', 'inconsistent', 'oneoff') || /\bone-off\b/.test(raw)) out.add('design-system');
  return out;
}

/** The single highest-precedence topic for a text, or null if none. */
function topicOf(text: string): string | null {
  const ts = topicsOf(text);
  for (const t of TOPIC_ORDER) if (ts.has(t)) return t;
  return null;
}

/**
 * A finding's canonical topic. Title-FIRST: the title is the finding's declared
 * identity; verbose LLM descriptions name-drop other concerns ("...against the
 * gray background...") and would mis-key. Fall back to the full text only when
 * the title carries no topic (e.g. a vaguely-labelled finding whose body reveals
 * it's really the clipped-rail bug), then to a title slug so unrelated findings
 * don't over-merge.
 */
function topicKey(f: Opportunity): string {
  // Content findings need explore-first targets (data model, not CSS) and must
  // not be merged with visual-hierarchy findings — they address different problems
  // with different fix approaches. Each distinct content title gets its own bucket;
  // same title from multiple reviewers still merges via the slug match.
  if (f.category === 'Content') {
    // Normalize before slugifying so near-synonym titles from different reviewer
    // personas collapse to the same bucket. Rules are deliberately narrow:
    //   - strip known filler prefixes that carry no semantic content
    //   - collapse the adjective form "hierarchical" to its noun "hierarchy"
    //   - strip the preposition phrase "in/of <noun> listings/section/display"
    //     that many reviewers append without adding distinction
    const normalized = f.title.toLowerCase()
      .replace(/^(lack of|absence of|insufficient)\s+/, '')
      .replace(/\bhierarchical structure\b/g, 'hierarchy')
      .replace(/\bhierarchical\b/g, 'hierarchy')
      .replace(/\s+/g, ' ').trim();
    return 'title:' + normalized.replace(/[^a-z0-9]+/g, '-');
  }
  const full = `${f.title} ${f.description} ${f.selector || ''} ${f.evidence?.selector || ''}`;
  // [TEMPORARY, 2026-07-01] A concrete defect signal in the body is decisive and
  // overrides a vague title label (e.g. a "view doesn't open" bug the AI titled
  // "Inconsistent Interaction with View Button", which title-first would mis-key
  // as design-system). Stopgap for the Nicholas session; the LLM judge subsumes it.
  if (topicsOf(full).has('ui-bug')) return 'ui-bug';
  return (
    topicOf(f.title) ||
    topicOf(full) ||
    'title:' + f.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  );
}

/** Whether a finding is deterministic-family (touch/network/console). */
export function isDeterministicFinding(f: Opportunity): boolean {
  return DETECTED_ONLY_TOPICS.has(topicKey(f));
}

/** Whether a finding is worth sending to the narration judge. Non-deterministic
 *  findings always are; deterministic ones only if a human could plausibly have
 *  narrated them (touch-targets / network) so the judge can promote them into
 *  BUILD. Machine-only signal (console-errors) is never judged. */
export function isJudgeableFinding(f: Opportunity): boolean {
  const key = topicKey(f);
  return !DETECTED_ONLY_TOPICS.has(key) || NARRATABLE_DETECTED.has(key);
}

/** Topics the reviewer actually narrated (union over transcript notes). */
function narratedTopics(session: LoupeSession): Set<string> {
  const out = new Set<string>();
  for (const note of session.notes) {
    if (note.type !== 'transcript') continue;
    for (const t of topicsOf(note.text)) out.add(t);
  }
  return out;
}

// Canonical titles for when the reviewer's own label misrepresents the finding
// (e.g. the clipped-rail bug titled "Unclear Decision Points in UI").
const CANONICAL_TITLES: Record<string, string> = {
  'ui-bug': 'UI defect — element not working as intended',
  'visual-hierarchy': 'Excessive gray — sections blend, weak hierarchy',
  'collapsible-rails': 'Collapsible rails give no visible affordance',
  'accessibility': 'Accessibility gaps',
  'design-system': 'Design-system drift (one-off implementations)',
  'network': 'Slow network requests',
  'touch-targets': 'Touch targets below 44px',
};

/** Keep the reviewer's title when it reflects the finding's topic; otherwise the
 *  label misrepresents the content, so use a canonical, accurate title. */
function displayTitle(key: string, repTitle: string): string {
  if (topicOf(repTitle) === key) return repTitle;
  return CANONICAL_TITLES[key] || repTitle;
}

// ─── Narration notes for a finding ──────────────────────────────

export interface NarrationMatch {
  text: string;
  startS: number;
  endS: number;
  shared: string[];
  regionOnly: boolean;
}

function isRegionOnly(shared: string[]): boolean {
  return shared.length > 0 && shared.every(isContentless);
}

function noteToMatch(note: NoteEntry, startMs: number, fToks: Set<string>): NarrationMatch {
  const shared = [...tokenize(note.text)].filter(t => fToks.has(t));
  // Note timestamps are ms-into-session (same clock as events).
  const startS = (note.timestamp - startMs > 1e6 ? note.timestamp - startMs : note.timestamp) / 1000;
  const endS = note.endTimestamp
    ? (note.endTimestamp - startMs > 1e6 ? note.endTimestamp - startMs : note.endTimestamp) / 1000
    : startS;
  return { text: note.text.trim(), startS, endS, shared, regionOnly: isRegionOnly(shared) };
}

/** The transcript notes a finding is *about*, for its displayed quote(s).
 *  Prefers the judge-supplied supporting note; falls back to topic-keyword match. */
function notesForFinding(f: Opportunity, key: string, session: LoupeSession): NarrationMatch[] {
  const startMs = new Date(session.startedAt).getTime();
  const fToks = findingTokens(f);
  const note = f.narrationNote;
  if (typeof note === 'number' && session.notes[note]?.type === 'transcript') {
    return [noteToMatch(session.notes[note], startMs, fToks)];
  }
  return session.notes
    .filter(n => n.type === 'transcript' && topicsOf(n.text).has(key))
    .map(n => noteToMatch(n, startMs, fToks))
    .sort((a, b) => a.startS - b.startS);
}

const SEVERITY_RANK: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 };

export interface MergedFinding {
  key: string;
  title: string;               // display title (canonical when the AI label misrepresents)
  representative: Opportunity;
  members: Opportunity[];
  mergedTitles: string[];      // titles of the other findings folded in
  selectors: string[];         // union of distinct selectors
  screenshotIndexes: number[]; // union of distinct screenshot indexes
  narration: NarrationMatch[]; // topic-matched transcript notes (empty => not narrated)
  severity: string;
  confidence: number;
}

function distinctSelectors(members: Opportunity[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    for (const sel of [m.selector, m.evidence?.selector]) {
      if (!sel) continue;
      for (const part of sel.split(',').map(s => s.trim()).filter(Boolean)) {
        if (!seen.has(part)) { seen.add(part); out.push(part); }
      }
    }
  }
  return out;
}

/** Highest-severity, then highest-confidence member — the group's spokesperson. */
function pickRepresentative(members: Opportunity[]): Opportunity {
  return [...members].sort((a, b) => {
    const s = (SEVERITY_RANK[a.severity] ?? 5) - (SEVERITY_RANK[b.severity] ?? 5);
    if (s !== 0) return s;
    return (b.confidence || 0) - (a.confidence || 0);
  })[0];
}

function mergeGroup(key: string, members: Opportunity[], session: LoupeSession): MergedFinding {
  return assembleMerged(key, members, pickRepresentative(members), session);
}

/** Build a MergedFinding from members with an explicit representative. Shared by
 *  mergeGroup (rep = highest severity) and collapseDuplicates (rep = richest fix). */
function assembleMerged(
  key: string,
  members: Opportunity[],
  representative: Opportunity,
  session: LoupeSession
): MergedFinding {
  const screenshotIndexes: number[] = [];
  for (const m of members) {
    for (const idx of [m.evidence?.screenshotIndex, m.screenshotIndex]) {
      if (typeof idx === 'number' && !screenshotIndexes.includes(idx)) screenshotIndexes.push(idx);
    }
  }
  screenshotIndexes.sort((a, b) => a - b);

  // The topic-matched transcript notes for this finding (deduped by text).
  const byText = new Map<string, NarrationMatch>();
  for (const m of members) {
    for (const nm of notesForFinding(m, key, session)) {
      if (!byText.has(nm.text)) byText.set(nm.text, nm);
    }
  }
  const narration = [...byText.values()].sort((a, b) => a.startS - b.startS);

  return {
    key,
    title: displayTitle(key, representative.title),
    representative,
    members,
    mergedTitles: members.filter(m => m !== representative).map(m => m.title),
    selectors: distinctSelectors(members),
    screenshotIndexes,
    narration,
    severity: representative.severity,
    confidence: Math.max(...members.map(m => m.confidence || 0)),
  };
}

export interface ClassifiedBrief {
  build: MergedFinding[];    // narrated → full fix instructions
  detected: MergedFinding[]; // not narrated → review only
}

/**
 * Classify each finding as narrated (build) or merely detected, then merge
 * same-issue findings within each bucket.
 *
 * A finding is narrated iff its (title-first) topic is one the reviewer actually
 * talked about — NOT if its verbose prose happens to share words with a quote.
 * Deterministic-family topics (touch/network/console) are hard-excluded: they
 * can never be narrated regardless of quote proximity.
 */
// Generic title words that never distinguish one concern from another — excluded
// when testing whether two same-narration findings are "about the same thing".
const DEDUP_GENERIC = new Set([
  'lack', 'issue', 'issues', 'problem', 'problems', 'poor', 'missing', 'flat',
  'within', 'their', 'structure', 'content', 'listing', 'listings', 'display',
  'section', 'sections', 'difficulty', 'inconsistent',
]);

// Bare tags that many unrelated elements share — too generic to prove two
// findings are about the same node.
const GENERIC_TAG_SELECTORS = new Set([
  'div', 'span', 'a', 'button', 'input', 'section', 'p', 'ul', 'ol', 'li',
  'img', 'svg', 'main', 'header', 'footer', 'nav', 'aside', 'label',
]);

/** A selector specific enough that two findings sharing it are plausibly the
 *  same element: has a class/id/attribute, or is a distinctive (non-generic) tag. */
function isSpecificSelector(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (!t) return false;
  if (/[.#[]/.test(t)) return true;
  return !GENERIC_TAG_SELECTORS.has(t);
}

function salientConcernTokens(title: string): Set<string> {
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter(t => t.length >= 4 && !DEDUP_GENERIC.has(t))
  );
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Two titles describe the same concern when normalized-equal, or when their
 *  salient token sets are identical (near-duplicate phrasings of one issue). */
function sameConcernTitle(a: string, b: string): boolean {
  if (normalizeTitle(a) === normalizeTitle(b)) return true;
  const ta = salientConcernTokens(a);
  const tb = salientConcernTokens(b);
  if (ta.size === 0 || tb.size !== ta.size) return false;
  for (const t of ta) if (!tb.has(t)) return false;
  return true;
}

/** Whether two findings' narration windows overlap or sit within `gapS` seconds
 *  of each other — i.e. the reviewer was talking about them in the same breath
 *  (consecutive transcript segments), a strong "same concern" corroborator when
 *  no shared selector is recorded. */
function narrationClose(a: MergedFinding, b: MergedFinding, gapS = 4): boolean {
  for (const na of a.narration) {
    for (const nb of b.narration) {
      if (na.startS <= nb.endS + gapS && nb.startS <= na.endS + gapS) return true;
    }
  }
  return false;
}

/**
 * Whether finding `m` describes the same narrated concern as an already-bucketed
 * finding `rep`. True when ANY of:
 *  1. same reviewer quote + a shared salient title term or shared specific element,
 *  2. effectively identical concern title + shared specific element OR adjacent
 *     narration (one issue narrated across consecutive quotes), or
 *  3. same specific element + adjacent narration (the reviewer discussed one node
 *     in a continuous span — one concern, even if the AI titled the parts
 *     differently). "Specific" excludes bare tags so unrelated findings on generic
 *     `div`/`button` never merge.
 */
function sameConcernAs(
  m: MergedFinding,
  rep: MergedFinding,
  quote: string | undefined,
  tokens: Set<string>,
): boolean {
  const rq = rep.narration[0]?.text?.trim().toLowerCase();
  const sameQuote = !!quote && !!rq && quote === rq;
  const sharedSelector = m.selectors.some(s => isSpecificSelector(s) && rep.selectors.includes(s));
  const sharedTitleTok = [...tokens].some(t => salientConcernTokens(rep.title).has(t));
  const sameConcern = sameConcernTitle(m.title, rep.title);
  const close = narrationClose(m, rep);
  return sameQuote
    || (sameConcern && (sharedSelector || close))
    || (sharedSelector && close);
}

/**
 * Collapse merged findings that describe the SAME narrated concern into one,
 * keeping the version with the richest fix content (an explore-first Content
 * target beats a generic visual one). Catches same-issue findings that landed in
 * different topic buckets (e.g. a Content finding vs a Design-System one, or one
 * concern the reviewer narrated across several consecutive sentences) which would
 * otherwise render as duplicate B-items.
 */
function collapseDuplicates(merged: MergedFinding[], session: LoupeSession): MergedFinding[] {
  const buckets: MergedFinding[][] = [];
  for (const m of merged) {
    const quote = m.narration[0]?.text?.trim().toLowerCase();
    const tokens = salientConcernTokens(m.title);
    let placed = false;
    // Compare against ANY member of a bucket, not just the first — a sparse
    // representative (e.g. a Content finding with no selector and weak narration)
    // must not block same-concern findings from joining its group.
    for (const b of buckets) {
      if (b.some(rep => sameConcernAs(m, rep, quote, tokens))) {
        b.push(m);
        placed = true;
        break;
      }
    }
    if (!placed) buckets.push([m]);
  }

  // Richest fix wins: an explore-first Content target outranks any generic one.
  const richness = (f: Opportunity): number =>
    (f.generatedTarget?.trim().length || 0) + (f.category === 'Content' ? 100_000 : 0);

  const collapsed = buckets.map(b => {
    if (b.length === 1) return b[0];
    const members = b.flatMap(x => x.members);
    const rep = [...members].sort((a, z) =>
      richness(z) - richness(a) ||
      (SEVERITY_RANK[a.severity] ?? 5) - (SEVERITY_RANK[z.severity] ?? 5) ||
      (z.confidence || 0) - (a.confidence || 0))[0];
    // Key from the winning finding so displayTitle/target fallback stay coherent.
    const winnerKey = b.find(x => x.members.includes(rep))?.key ?? b[0].key;
    return assembleMerged(winnerKey, members, rep, session);
  });

  return collapsed.sort((a, z) =>
    (SEVERITY_RANK[a.severity] ?? 5) - (SEVERITY_RANK[z.severity] ?? 5) ||
    (z.confidence - a.confidence));
}

export function classifyAndMerge(findings: Opportunity[], session: LoupeSession): ClassifiedBrief {
  const narratedT = narratedTopics(session);
  const narrated: Opportunity[] = [];
  const detected: Opportunity[] = [];
  for (const f of findings) {
    const key = topicKey(f);
    if (DETECTED_ONLY_TOPICS.has(key)) {
      // A deterministic finding enters BUILD only when it's both narratable and
      // the LLM judge explicitly confirmed the reviewer voiced it. Keyword overlap
      // and the topic fallback are deliberately NOT enough here — that guards
      // offline artifacts from promoting e.g. a network finding on the word "slow".
      const promotable = NARRATABLE_DETECTED.has(key) && f.narrated === true;
      (promotable ? narrated : detected).push(f);
      continue;
    }
    // Primary gate: the LLM judge's verdict (set in analyze). Fallback: the
    // keyword topic gate, for artifacts analyzed offline / before the judge ran.
    const isNarrated = typeof f.narrated === 'boolean' ? f.narrated : narratedT.has(key);
    (isNarrated ? narrated : detected).push(f);
  }

  const groupBy = (list: Opportunity[]): MergedFinding[] => {
    const groups = new Map<string, Opportunity[]>();
    for (const f of list) {
      const k = topicKey(f);
      const g = groups.get(k);
      if (g) g.push(f);
      else groups.set(k, [f]);
    }
    return [...groups.entries()]
      .map(([k, members]) => mergeGroup(k, members, session))
      .sort((a, b) =>
        (SEVERITY_RANK[a.severity] ?? 5) - (SEVERITY_RANK[b.severity] ?? 5) ||
        (b.confidence - a.confidence));
  };

  // Collapse same-narration same-concern duplicates in BUILD (keeps the richest
  // fix). Detected findings are review-only, so leave them as-is.
  return { build: collapseDuplicates(groupBy(narrated), session), detected: groupBy(detected) };
}

// ─── Captured computed-style evidence ───────────────────────────

const STYLE_PROPS = [
  'backgroundColor', 'border', 'boxShadow', 'overflowX', 'overflowY',
  'color', 'width', 'height', 'borderRadius',
  'fontSize', 'fontFamily', 'display', 'padding', 'margin',
] as const;

export type MatchType = 'exact' | 'contains' | 'concept';

export interface MeasuredStyle {
  selector: string;       // the captured selector key
  matchedFrom: string;    // the finding selector it satisfied
  matchType: MatchType;   // how it was resolved (concept = approximate, verify)
  styles: Record<string, string>;
}

export interface MeasuredState {
  found: MeasuredStyle[];
  missing: string[];      // finding selectors with no captured styles
}

function domSnapshots(session: LoupeSession): Extract<SessionEvent, { type: 'dom_snapshot' }>[] {
  return session.events.filter((e): e is Extract<SessionEvent, { type: 'dom_snapshot' }> => e.type === 'dom_snapshot');
}

/** Flatten all snapshots to key → latest captured styles (later snapshots win). */
function latestStyleByKey(session: LoupeSession): Record<string, Record<string, string>> {
  const map: Record<string, Record<string, string>> = {};
  for (const snap of domSnapshots(session)) {
    for (const [k, v] of Object.entries(snap.computedStyles || {})) map[k] = v;
  }
  return map;
}

function pickStyles(raw: Record<string, string>): Record<string, string> {
  const styles: Record<string, string> = {};
  for (const p of STYLE_PROPS) if (raw[p] !== undefined) styles[p] = raw[p];
  return styles;
}

// ─── Selector ↔ captured-key matching ───────────────────────────
//
// The analyzer names narrated findings with *abstract* region selectors
// (`.right-rail`, `.centerpiece`, `header`), but the capture keys are the real
// rendered selectors — in a Tailwind app, utility soup like `div.flex-1.min-w-0`
// with no class overlap. String matching alone never bridges the two. So we also
// match on layout-region *concept*: both sides are reduced to {header, nav,
// aside, main, footer} via semantic tag or region words (including CSS-var
// fragments like `--header-h`), and matched on shared concept.

const CONCEPT_WORDS: Record<string, string[]> = {
  header: ['header', 'topbar', 'masthead'],
  footer: ['footer'],
  nav: ['nav', 'navbar', 'navigation'],
  aside: ['aside', 'rail', 'sidebar', 'sidenav', 'drawer', 'panel', 'complementary'],
  main: ['main', 'content', 'centerpiece', 'center', 'canvas', 'stage', 'conversation', 'section'],
};

// Leading tags that are never layout regions — excluded from concept matching
// and from the region pool so a finding never binds to a button/link/icon.
const NON_REGION_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'label', 'option', 'img', 'svg', 'path', 'span']);

function leadingTag(key: string): string {
  const m = key.match(/^[a-z0-9-]+/i);
  return m ? m[0].toLowerCase() : '';
}

function conceptsOf(s: string): Set<string> {
  const low = s.toLowerCase();
  const out = new Set<string>();
  for (const [concept, words] of Object.entries(CONCEPT_WORDS)) {
    if (words.some(w => low.includes(w))) out.add(concept);
  }
  return out;
}

function shareConcept(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * Resolve each finding selector to captured computed styles. Tries, in order:
 * exact key, class-part containment, then layout-region concept (bridges
 * abstract selectors to Tailwind keys). `matchType` records which, so the brief
 * can flag concept matches as approximate.
 */
export function measureSelectors(selectors: string[], session: LoupeSession): MeasuredState {
  const styleByKey = latestStyleByKey(session);
  const keys = Object.keys(styleByKey);
  const found: MeasuredStyle[] = [];
  const missing: string[] = [];
  const usedKeys = new Set<string>();

  const pick = (pred: (k: string) => boolean) => keys.find(k => !usedKeys.has(k) && pred(k));

  for (const sel of selectors) {
    const target = sel.trim().replace(/^\./, '');
    let key = pick(k => k === sel || k === target);
    let matchType: MatchType = 'exact';

    if (!key) { key = pick(k => k.includes(target) || target.includes(k)); if (key) matchType = 'contains'; }

    if (!key) {
      const want = conceptsOf(sel);
      if (want.size) {
        key = pick(k => !NON_REGION_TAGS.has(leadingTag(k)) && shareConcept(conceptsOf(k), want));
        if (key) matchType = 'concept';
      }
    }

    if (key) {
      usedKeys.add(key);
      found.push({ selector: key, matchedFrom: sel, matchType, styles: pickStyles(styleByKey[key]) });
    } else {
      missing.push(sel);
    }
  }

  return { found, missing };
}

/**
 * The layout regions the capture actually recorded — semantic landmarks or any
 * large container (≥8% of viewport). Offered as ground truth the agent can pick
 * from when a finding's abstract selector can't be pinned to one key (e.g. a
 * pure-utility Tailwind rail div with no region hint at all).
 */
export function capturedRegionStyles(session: LoupeSession): MeasuredStyle[] {
  const styleByKey = latestStyleByKey(session);
  const vw = session.viewport?.width || 0;
  const vh = session.viewport?.height || 0;
  const vpArea = vw * vh;
  const rows = Object.entries(styleByKey)
    .filter(([key]) => !NON_REGION_TAGS.has(leadingTag(key)))
    .map(([key, raw]) => {
      const w = parseFloat(raw.width || '0');
      const h = parseFloat(raw.height || '0');
      const width = isFinite(w) ? w : 0;
      const height = isFinite(h) ? h : 0;
      const area = width * height;
      // Rank by on-screen (viewport-clamped) area: a tall scroll container
      // (e.g. an 800×6256 wrapper) shouldn't outrank the zones actually visible.
      const clampedArea = width * (vh > 0 ? Math.min(height, vh) : height);
      const semantic = ['header', 'nav', 'aside', 'main', 'footer', 'section'].includes(leadingTag(key));
      return { key, area, clampedArea, semantic, raw };
    })
    .filter(r => r.semantic || (vpArea > 0 && r.area >= vpArea * 0.08))
    .sort((a, b) => b.clampedArea - a.clampedArea)
    .slice(0, 8);

  return rows.map(r => ({ selector: r.key, matchedFrom: '(layout region)', matchType: 'concept' as MatchType, styles: pickStyles(r.raw) }));
}

// ─── Per-finding region relevance ───────────────────────────────

function isTransparentBg(bg?: string): boolean {
  if (!bg) return true;
  const f = bg.replace(/\s+/g, '');
  return f === 'transparent' || /rgba\(\d+,\d+,\d+,0(\.0+)?\)/.test(f);
}

// A muted achromatic surface (r≈g≈b, not pure white) — the "everything is gray,
// sections blend" complaint. rgb(247,248,248) qualifies; white/#fff does not.
function isGraySurface(bg?: string): boolean {
  if (!bg || isTransparentBg(bg)) return false;
  const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return false;
  const [r, g, b] = [+m[1], +m[2], +m[3]];
  return Math.max(r, g, b) - Math.min(r, g, b) <= 12 && Math.max(r, g, b) < 253;
}

function overflowClips(s: Record<string, string>): boolean {
  return s.overflowX === 'hidden' || s.overflowY === 'hidden' || s.overflowX === 'clip' || s.overflowY === 'clip';
}
function overflowScrolls(s: Record<string, string>): boolean {
  return ['auto', 'scroll'].includes(s.overflowX) || ['auto', 'scroll'].includes(s.overflowY);
}
function borderIsNone(border?: string): boolean {
  if (!border) return true;
  const m = border.trim().match(/^(\S+)\s+(\S+)/);
  return m ? (m[2] === 'none' || parseFloat(m[1]) === 0) : false;
}

/**
 * Rank the captured layout regions by relevance to a specific finding and return
 * the top few — so each finding leads with the zones that match its concern
 * (the `overflow: hidden` rail for a clip bug; the gray, border-less surfaces for
 * a "sections blend" finding) instead of a generic area-sorted dump. Falls back
 * to the on-screen-largest regions when nothing scores.
 */
export function relevantRegions(
  session: LoupeSession,
  ctx: { selectors: string[]; narrationText: string; topicKey: string },
  limit = 4
): MeasuredStyle[] {
  const pool = capturedRegionStyles(session); // already viewport-clamped ranked
  const wantConcepts = new Set<string>();
  for (const sel of ctx.selectors) for (const c of conceptsOf(sel)) wantConcepts.add(c);
  const narr = (ctx.narrationText || '').toLowerCase();

  const scored = pool.map((r, order) => {
    let score = 0;
    const kConcepts = conceptsOf(r.selector);
    if ([...kConcepts].some(c => wantConcepts.has(c))) score += 3;
    for (const c of kConcepts) {
      if (CONCEPT_WORDS[c]?.some(w => narr.includes(w))) { score += 2; break; }
    }
    if (ctx.topicKey === 'ui-bug') {
      if (overflowClips(r.styles)) score += 4;       // lead with the clipped region
      else if (overflowScrolls(r.styles)) score += 1;
    } else if (ctx.topicKey === 'visual-hierarchy') {
      if (!isTransparentBg(r.styles.backgroundColor)) score += 2;
      if (isGraySurface(r.styles.backgroundColor)) score += 2; // lead with gray zones
      if (borderIsNone(r.styles.border)) score += 1;           // no separating edge = blend
    }
    return { r, score, order };
  });

  const relevant = scored.filter(s => s.score > 0);
  const chosen = (relevant.length ? relevant : scored)
    .sort((a, b) => b.score - a.score || a.order - b.order) // ties → viewport-clamped rank
    .slice(0, limit);
  return chosen.map(s => s.r);
}
