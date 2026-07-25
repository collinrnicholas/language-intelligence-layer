// ─── Recurrence signature ────────────────────────────────────────
//
// Deterministic cross-run identity for a finding: two findings about the same
// problem in different runs must produce the same signature, and unrelated
// findings must not collide. Reuses the same intuition as the within-run
// near-dup matcher (`titleSimilarity` in ai/review.ts): category + where +
// what-words. No ML, no embeddings — auditable by eye in opportunities.jsonl.

import type { Opportunity } from '../cli.js';

// Words that carry no identity ("the button doesn't work properly" → button+work).
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'be', 'been', 'to', 'of', 'in', 'on',
  'for', 'and', 'or', 'not', 'no', 'with', 'without', 'has', 'have', 'this',
  'that', 'it', 'its', 'too', 'very', 'more', 'less', 'should', 'must', 'can',
  'cannot', 'do', 'does', 'doesnt', 'dont', 'when', 'while', 'lack', 'lacks',
  'missing', 'issue', 'issues', 'problem', 'problems', 'improve', 'improved',
]);

/** Crude stemmer — enough to make "plans panel crowding"/"plan panel crowded" agree. */
function stem(w: string): string {
  return w
    .replace(/(ing|ed|es|s)$/,'')
    .replace(/(tion|sion)$/, 't');
}

function titleTokens(title: string): string[] {
  return [...new Set(
    (title.toLowerCase().match(/[a-z0-9]+/g) || [])
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
      .map(stem)
      .filter(w => w.length > 2),
  )].sort().slice(0, 6);
}

/** Normalize a selector to its identity-bearing head (strip nth-child noise). */
function selectorKey(selector: string | undefined): string {
  if (!selector) return '';
  return selector
    .split(',')[0]
    .replace(/:nth-[a-z-]+\(\d+\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 60);
}

/** Origin+pathname of the page, never query/fragment. */
function pageKey(page: string | undefined): string {
  if (!page) return '';
  try {
    const u = new URL(page);
    return (u.origin + u.pathname).toLowerCase();
  } catch {
    return page.split('?')[0].toLowerCase().slice(0, 80);
  }
}

/**
 * Stable recurrence key: `category|page|selector[~titlewords]` or
 * `category|page|titlewords`. The selector anchors identity when present, but
 * carries a small title-token component too — otherwise two DIFFERENT issues
 * on the same element (e.g. contrast vs. dead click on `#sidebar`) would
 * collapse into one memory pattern. Top-2 stemmed tokens: stable across
 * phrasing variants, distinct across genuinely different problems.
 */
export function findingSignature(f: Opportunity): string {
  const sel = selectorKey(f.selector || f.evidence?.selector);
  const words = titleTokens(f.title);
  const what = sel ? `${sel}~${words.slice(0, 2).join('+')}` : words.join('+');
  return `${f.category.toLowerCase().replace(/\s+/g, '-')}|${pageKey(f.page)}|${what}`;
}

/** Loose match for humans reading logs: same category + overlapping title words. */
export function signaturesLikelySame(a: string, b: string): boolean {
  if (a === b) return true;
  const [catA, , whatA] = a.split('|');
  const [catB, , whatB] = b.split('|');
  if (catA !== catB) return false;
  const wa = new Set(whatA.split('+'));
  const wb = new Set(whatB.split('+'));
  if (wa.size === 0 || wb.size === 0) return false;
  const overlap = [...wa].filter(w => wb.has(w)).length;
  return overlap / Math.max(wa.size, wb.size) >= 0.5;
}
