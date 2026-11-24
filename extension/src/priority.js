// ─── Persado Assist — where to start ─────────────────────────────────────────
//
// A deterministic, inspectable ranking. Nothing here predicts revenue: it answers
// one narrow question — which detected line deserves a marketer's first look?
// That is a question about the page, not about the copy's score, so the signals
// are the ones the scan can actually see (kind, position, prominence) plus the
// few things a page states about itself (its primary action, what it is for).
//
// Ranked before any Persado run, so the recommendation costs nothing. After a
// score exists the panel still puts the same item first: the lowest score is not
// automatically the highest-value rewrite, and a footer link with terrible copy
// is still a footer link.
//
// No DOM access — testable in Node, same contract as page-noise.js.

(function (scope) {
  // A call to action is the thing people click; a headline is the thing they read
  // to decide. Body copy matters, but it is rarely where a rewrite pays first.
  const KIND = { cta: 46, headline: 34, body: 18 };

  // Verbs that promise nothing. A generic CTA is the classic first fix, but it is
  // also the least differentiated, so it gets a nudge rather than the top slot.
  const GENERIC = /^(learn more|click here|read more|more info(rmation)?|see more|get started|submit|continue|next|go|shop now|buy now|sign up|register|download|view|discover more|explore)[.!]?$/i;

  // A number or a time-to-value phrase is a promise you can check.
  const SPECIFIC = /\d|%|\$|£|€|\b(free|instant(ly)?|minutes?|days?|today)\b/i;

  // What the page is for, in the page's own words.
  const PURPOSE = [
    [/apply|application|admission/i, 'application'],
    [/sign ?up|register|create (an )?account|join/i, 'signup'],
    [/pricing|plans?|checkout|buy now|add to cart|order/i, 'purchase'],
    [/donate|donation|give now|support us/i, 'donation'],
    [/book (a )?(call|demo)|contact|consult|talk to/i, 'contact'],
  ];

  /** The page's purpose, read from its URL and title — never guessed from layout. */
  function pagePurpose(page) {
    const hay = [page && page.url, page && page.title].filter(Boolean).join(' ');
    for (const [re, name] of PURPOSE) if (re.test(hay)) return name;
    return '';
  }

  function scoreOf(material, page, purpose) {
    const m = material || {};
    const kind = KIND[m.kind] ? m.kind : 'body';
    let score = KIND[kind];
    const reasons = [kind === 'cta' ? 'the main action' : kind === 'headline' ? 'a headline' : 'body copy'];

    const text = typeof m.text === 'string' ? m.text.trim() : '';
    const primary = page && typeof page.primaryCta === 'string' ? page.primaryCta.trim().toLowerCase() : '';
    if (primary && text.toLowerCase() === primary) {
      score += 12;
      reasons.push('the page’s primary action');
    }
    if (m.aboveFold) {
      score += 10;
      reasons.push('above the fold');
    } else {
      score -= 8;
    }
    if (typeof m.prominence === 'number') score += Math.round((Math.min(100, Math.max(0, m.prominence)) / 100) * 8);
    if (text && SPECIFIC.test(text)) score += 4;
    if (kind === 'cta' && GENERIC.test(text)) score -= 8;
    if (kind === 'headline' && text.length > 90) score -= 4;

    // The action that matches what the page is for outranks a generic one.
    if (purpose && kind === 'cta' && text && PURPOSE.some(([re]) => re.test(text))) {
      score += 10;
      reasons.push(`the ${purpose} action`);
    }
    if (purpose && kind === 'headline' && m.aboveFold) score += 4;
    if (typeof m.top === 'number' && m.top < 700) score += 3;

    return { score: Math.round(score), reason: reasons.slice(0, 2).join(' · ') };
  }

  /**
   * Rank materials for review order.
   * Returns [{ index, material, score, rank, startHere, reason }] highest first.
   * Ties keep the scan's own order (stable), so two identical rows never shuffle.
   */
  function rank(materials, page) {
    const purpose = pagePurpose(page || {});
    return (materials || [])
      .map((material, index) => ({ index, material, ...scoreOf(material, page, purpose) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((row, i) => ({ ...row, rank: i + 1, startHere: i === 0 }));
  }

  scope.PERSADO_PRIORITY = { rank, pagePurpose };
})(typeof self !== 'undefined' ? self : globalThis);
