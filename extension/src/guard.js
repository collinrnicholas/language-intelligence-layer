// ─── Persado Assist — content safeguards ──────────────────────────────────
//
// Platform-neutral rules that decide what may be rewritten and whether a rewrite
// is safe to write back. Nothing leaves the platform unless it passes
// `eligible()`, and nothing is written back unless it passes `validateRewrite()`.
//
//   Protected tokens  merge tags (*|FNAME|*), template variables ({{first_name}},
//                     {{contact.name}}), URLs, e-mail addresses. They are sent to
//                     Persado as `alwaysUse` terms and the rewrite must contain
//                     every one, the same number of times.
//   Immutable copy    unsubscribe/footer/legal text and anything the author marked
//                     locked is never sent and never touched.
//   Claims            a rewrite may not introduce a number, price or percentage
//                     that the original did not contain (a new APR or "50% off"
//                     is a compliance event, not a copy edit).
//
// HTML handling is a tolerant tokenizer, not a DOM: the service worker has no
// DOMParser, and an e-mail must round-trip byte-for-byte except for the text
// that changed. Only blocks whose inner content is PLAIN TEXT (no nested tags,
// only entities we can decode and re-encode) are eligible; everything else —
// markup, attributes, links, tracking, conditional comments — is left exactly
// as it was. Classic script; loaded by the service worker and node tests.

(function (root) {
  // ── Protected tokens ───────────────────────────────────────────
  const TOKEN_RES = [
    /\*\|[^|*\n]{1,80}\|\*/g,                 // Mailchimp merge tags  *|FNAME|*  *|UNSUB|*
    /\{\{\s*[^{}\n]{1,80}?\s*\}\}/g,          // {{first_name}} / {{contact.first_name}}
    /\{%[^%\n]{1,120}%\}/g,                   // template tags {% if %}
    /https?:\/\/[^\s<>"')]+/gi,               // URLs
    /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,          // e-mail addresses
  ];

  function protectedTokens(text) {
    const out = [];
    const s = String(text || '');
    for (const re of TOKEN_RES) for (const m of s.matchAll(re)) out.push(m[0]);
    return out;
  }
  function countMap(arr) { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; }

  // ── Immutable copy ─────────────────────────────────────────────
  const IMMUTABLE_TEXT = /(\*\|(UNSUB|UPDATE_PROFILE|LIST:ADDRESS|LIST:ADDRESSLINE|LIST:DESCRIPTION|LIST:COMPANY|ABOUT_LIST|REWARDS|HTML:LIST_ADDRESS_HTML|ARCHIVE|FORWARD|EMAIL)\|\*|unsubscribe|opt[ -]?out|manage (your )?(preferences|subscription)|update (your )?preferences|privacy policy|terms (and|&) conditions|terms of (use|service)|all rights reserved|©|\(c\) ?\d{4}|copyright|member fdic|equal housing|nmls|not fdic insured|apr\b.*\b(variable|subject to)|this (e-?mail|message) was sent|you are receiving this|you('re| are) receiving|our mailing address|view (this e-?mail )?in (your )?browser|disclosure|disclaimer)/i;

  function isImmutable(text) { return IMMUTABLE_TEXT.test(String(text || '')); }

  const MIN_WORDS = { subject_line: 1, preheader: 2, headline: 2, subheadline: 2, body: 6, cta: 1 };

  /** May this text be sent to Persado for this touchpoint? */
  function eligible(text, touchpoint) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, reason: 'empty' };
    if (isImmutable(t)) return { ok: false, reason: 'legal, footer or unsubscribe copy is never changed' };
    const words = t.split(/\s+/).filter(w => /[A-Za-z]/.test(w)).length;
    if (words < (MIN_WORDS[touchpoint] || 1)) return { ok: false, reason: 'too short to optimize' };
    const stripped = t.replace(/\*\|[^|]+\|\*|\{\{[^}]+\}\}|https?:\/\/\S+/g, '').trim();
    if (!/[A-Za-z]{2}/.test(stripped)) return { ok: false, reason: 'no copy outside merge tags and links' };
    return { ok: true };
  }

  // ── Rewrite validation ─────────────────────────────────────────
  const NUMBER_RE = /[$€£]?\d[\d,]*(\.\d+)?\s*%?/g;
  function numbers(s) {
    return String(s || '').replace(/\*\|[^|]+\|\*|\{\{[^}]+\}\}|https?:\/\/\S+/g, '')
      .match(NUMBER_RE)?.map(n => n.replace(/[\s,]/g, '')) || [];
  }

  /**
   * Is `rewritten` safe to write in place of `original`?
   * Returns { ok, reasons[] } — any reason means DO NOT WRITE.
   */
  function validateRewrite(original, rewritten, { maxLength = null } = {}) {
    const reasons = [];
    const o = String(original ?? ''), r = String(rewritten ?? '');
    if (!r.trim()) reasons.push('the rewrite is empty');
    if (maxLength && [...r].length > maxLength) reasons.push(`the rewrite is longer than ${maxLength} characters`);
    if (/[<>]/.test(r) && !/[<>]/.test(o)) reasons.push('the rewrite contains markup');
    const want = countMap(protectedTokens(o)), got = countMap(protectedTokens(r));
    for (const [tok, n] of want) if ((got.get(tok) || 0) !== n) reasons.push(`the protected token ${tok} was not preserved`);
    for (const [tok] of got) if (!want.has(tok)) reasons.push(`the rewrite added ${tok}, which was not in the original`);
    const before = new Set(numbers(o));
    const added = numbers(r).filter(n => !before.has(n));
    if (added.length) reasons.push(`the rewrite introduces a figure not in the original (${[...new Set(added)].join(', ')})`);
    if (isImmutable(r) && !isImmutable(o)) reasons.push('the rewrite reads as legal or footer copy');
    if (r.trim() === o.trim()) reasons.push('the rewrite is identical to the original');
    return { ok: reasons.length === 0, reasons };
  }

  // ── HTML entities ──────────────────────────────────────────────
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
    rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…', copy: '©',
    reg: '®', trade: '™', middot: '·', bull: '•', eacute: 'é' };

  /** Decode; returns null if an entity we cannot round-trip is present. */
  function decodeEntities(s) {
    let unknown = false;
    const out = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : (unknown = true, m);
      }
      const v = NAMED[e.toLowerCase()];
      if (v === undefined) unknown = true;
      return v ?? m;
    });
    return unknown ? null : out;
  }
  function encodeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
  }

  // ── HTML block extraction ──────────────────────────────────────
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const RAW = new Set(['script', 'style', 'title', 'textarea']);
  const BLOCK_KIND = { h1: 'headline', h2: 'headline', h3: 'subheadline', h4: 'subheadline', p: 'body', a: 'link', td: 'cell', div: 'cell', li: 'body', span: 'cell' };
  const LOCK_ATTR = /\bdata-persado-lock\b|\bmc:edit\s*=\s*["']?(footer|footer_\w*|unsub\w*)|\bclass\s*=\s*["'][^"']*\b(footer|mcnFooter\w*|persado-lock)\b|\bid\s*=\s*["'][^"']*\b(footer\w*|templateFooter)\b/i;
  const CTA_ATTR = /\b(btn|button|cta|mcnButton|mceButton)\b/i;

  /**
   * Find rewritable text blocks. Each block is an element whose ENTIRE inner
   * content is plain text, outside <head>, raw-text elements, comments and any
   * locked/footer region. Returns
   *   [{ id, tag, kind, start, end, raw, text, cta, href }]
   * where html.slice(start, end) === raw (the inner content).
   */
  function htmlBlocks(html) {
    const blocks = [];
    const stack = [];            // { tag, locked, start(innerStart), attrs, hasChild }
    let lockDepth = 0;           // >0 while inside a locked/footer element
    let commentLock = 0;         // <!-- persado:lock --> … <!-- /persado:lock -->
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/?([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    let m;
    let inHead = false;
    while ((m = re.exec(html))) {
      const full = m[0];
      if (full.startsWith('<!--')) {
        if (/persado:lock\b/i.test(full) && !/\/persado:lock/i.test(full)) commentLock++;
        else if (/\/persado:lock/i.test(full)) commentLock = Math.max(0, commentLock - 1);
        if (stack.length) stack[stack.length - 1].hasChild = true;
        continue;
      }
      if (!m[1]) continue;
      const tag = m[1].toLowerCase();
      const attrs = m[2] || '';
      const closing = full[1] === '/';
      if (tag === 'head') { inHead = !closing; continue; }
      if (!closing && RAW.has(tag)) {
        const endRe = new RegExp(`</${tag}\\s*>`, 'ig');
        endRe.lastIndex = re.lastIndex;
        const e = endRe.exec(html);
        re.lastIndex = e ? endRe.lastIndex : html.length;
        if (stack.length) stack[stack.length - 1].hasChild = true;
        continue;
      }
      if (!closing) {
        if (stack.length) stack[stack.length - 1].hasChild = true;
        if (VOID.has(tag) || /\/\s*$/.test(attrs)) continue;
        const locked = LOCK_ATTR.test(attrs);
        if (locked) lockDepth++;
        stack.push({ tag, locked, start: re.lastIndex, attrs, hasChild: false });
        continue;
      }
      // closing tag: pop to the matching open tag (tolerant of unclosed children)
      let i = stack.length - 1;
      while (i >= 0 && stack[i].tag !== tag) i--;
      if (i < 0) continue;
      for (let j = stack.length - 1; j > i; j--) { if (stack[j].locked) lockDepth--; }
      const open = stack[i];
      stack.length = i;
      if (open.locked) lockDepth--;
      if (stack.length) stack[stack.length - 1].hasChild = true;
      if (inHead || lockDepth > 0 || commentLock > 0 || open.hasChild) continue;
      const kind = BLOCK_KIND[tag];
      if (!kind) continue;
      const start = open.start, end = m.index;
      const raw = html.slice(start, end);
      if (!raw.trim()) continue;
      const decoded = decodeEntities(raw);
      if (decoded == null) continue;
      const text = decoded.replace(/[\t\r\n ]+/g, ' ').trim();
      if (!text) continue;
      // Whitespace-only differences (indentation inside the tag) are preserved on
      // write by keeping the leading/trailing whitespace of `raw`.
      const href = tag === 'a' ? ((/\bhref\s*=\s*["']([^"']*)["']/i.exec(open.attrs) || [])[1] || '') : '';
      const ancestorCta = stack.some(s => CTA_ATTR.test(s.attrs));
      blocks.push({ id: `b${blocks.length}`, tag, kind, start, end, raw, text,
        // A link is a CTA when it is styled as a button, or stands alone (its
        // parent is not running text) and is short. "here" inside a sentence is not.
        cta: tag === 'a' && (CTA_ATTR.test(open.attrs) || ancestorCta
          || (text.split(/\s+/).length <= 6 && !['p', 'li', 'span', 'h1', 'h2', 'h3', 'h4'].includes(stack[stack.length - 1]?.tag))),
        href });
    }
    return blocks;
  }

  /**
   * Replace block inner text. `changes` is [{ start, end, raw, text }] where
   * `raw` must still match html.slice(start,end) — if the document moved under
   * us, nothing is written. Leading/trailing whitespace of the original inner
   * content is kept so indentation and line breaks survive.
   */
  function replaceBlocks(html, changes) {
    const sorted = [...changes].sort((a, b) => b.start - a.start);
    let out = html;
    for (const c of sorted) {
      if (out.slice(c.start, c.end) !== c.raw) throw new Error('The e-mail changed while it was being optimized; nothing was written.');
      const lead = /^\s*/.exec(c.raw)[0], trail = /\s*$/.exec(c.raw)[0];
      out = out.slice(0, c.start) + lead + encodeText(c.text) + trail + out.slice(c.end);
    }
    return out;
  }

  /** Short stable hash (FNV-1a) for duplicate-write detection; not security. */
  function hash(s) {
    let h = 0x811c9dc5;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0') + ':' + str.length;
  }

  root.PERSADO_GUARD = Object.freeze({
    protectedTokens, isImmutable, eligible, validateRewrite, numbers,
    decodeEntities, encodeText, htmlBlocks, replaceBlocks, hash,
  });
})(typeof self !== 'undefined' ? self : globalThis);
