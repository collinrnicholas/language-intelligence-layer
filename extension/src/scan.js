// ─── Language Intelligence Layer — Page scan ─────────────────────────────────
//
// Scans the page the user is already looking at and ranks its marketing copy by
// how badly it is likely to perform, so the panel can point at ONE element worth
// rewriting instead of asking the user to describe the page out loud.
//
// NO SCORING IS INVENTED. Every point deducted is tied to a named, checkable
// property of the copy or its box (a generic verb, no concrete outcome, a 26px
// tap target, 2.1:1 contrast). The panel shows those reasons verbatim. There is
// no "Motivation AI" score here and nothing in this file claims to be one.
//
// Loaded two ways:
//   • content script  executeScript({ files: ['src/messages.js', 'src/scan.js'] })
//   • side panel      <script src="src/scan.js"> — for scoreCopy() on variants
//
// Idempotent: re-injecting replaces the previous listener instead of stacking.

(function () {
  if (!self.PERSADO) return;   // messages.js must be injected first (content path)
  const { MSG } = self.PERSADO;
  const inPage = typeof chrome !== 'undefined' && !!chrome.runtime?.id && !chrome.tabs;

  // ── Copy heuristics ─────────────────────────────────────────────
  // Each rule returns points to DEDUCT (0 when it does not apply) plus the
  // sentence shown to the user. Weights are ordered by how reliably the pattern
  // predicts a weak CTA in practice, not by any model.

  const GENERIC_CTA = /^(learn more|learn more about.*|click here|here|read more|more info(rmation)?|see more|find out more|get started|get started today|submit|continue|next|go|shop now|buy now|sign up( now)?|register|download|view|discover more|explore|try it( free)?|start( now)?)[.!]?$/i;
  const ACTION_VERB = /^(open|start|get|claim|join|apply|book|schedule|talk|speak|call|reserve|unlock|save|earn|grow|build|create|launch|request|compare|check|see|try|grab|download|subscribe|upgrade|switch|transfer|send|add|choose|pick|find|calculate|estimate|protect|insure|invest|refinance|consolidate|activate|connect)/i;
  const FLUFF = /\b(solution|solutions|platform|leverage|synerg(y|ies)|innovative|seamless(ly)?|empower(s|ing)?|world[- ]class|cutting[- ]edge|state[- ]of[- ]the[- ]art|next[- ]generation|revolutionary|holistic|best[- ]in[- ]class|robust|scalable|ecosystem)\b/i;
  const HYPE = /\b(best|#1|number one|guaranteed|risk[- ]free|instantly|miracle|unbeatable|ultimate)\b/i;
  // "Today" is not an outcome — every page says today. Only a number, a price, or a
  // time-to-value phrase counts as concrete.
  const SPECIFIC = /(\d|%|\$|£|€|\b(free|no fee|no monthly fee|same[- ]day|minutes?|seconds?|hours?|days?|apr|apy|24\/7|in (a|one) (minute|hour|day|week))\b)/i;
  // Verbs that promise a feeling instead of an action. "Unlock your potential" is
  // the canonical case: it scans as a benefit but names nothing.
  const ABSTRACT_VERB = /^(unlock|discover|elevate|explore|experience|transform|redefine|revolutionize|supercharge|reimagine)\b/i;
  const COMPANY_FIRST = /^(we|our|us|the (company|bank|team))\b/i;
  // "Welcome to…" / "Introducing…" opens a page without making a promise. It is the
  // single most common weak hero line, so it is named rather than left to the
  // generic length/specificity rules.
  const EMPTY_OPENER = /^(welcome|hello|hi|introducing|meet|say hello)\b/i;
  const VAGUE_PRONOUN = /\b(it|this|that|these|those)\b/i;
  const PASSIVE = /\b(be able to|can be|could be|is designed to|was created to|has been)\b/i;

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  /** Relative luminance of a computed colour string (rgb/rgba). */
  function lum(color) {
    const m = String(color).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/i);
    if (!m) return null;
    const [r, g, b] = [1, 2, 3].map(i => {
      const c = Number(m[i]) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** Contrast ratio between an element's text and its nearest opaque background. */
  function contrastOf(el) {
    const fg = lum(getComputedStyle(el).color);
    let node = el, bg = null;
    while (node && node.nodeType === 1 && bg === null) {
      const s = getComputedStyle(node);
      const l = lum(s.backgroundColor);
      if (l !== null && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && !/rgba\([^)]*,\s*0\s*\)/.test(s.backgroundColor)) bg = l;
      node = node.parentElement;
    }
    if (fg === null || bg === null) return null;
    const [a, b] = fg > bg ? [fg, bg] : [bg, fg];
    return Math.round(((a + 0.05) / (b + 0.05)) * 10) / 10;
  }

  /**
   * The product's five bands. A number on its own invites the question this panel
   * kept getting — "why is everything in the 80s?" — so the band is always shown
   * with it, and ceilings (below) stop copy from reaching a band it has not earned.
   */
  const BANDS=[{min:90,key:'excellent',label:'Excellent'},{min:73,key:'strong',label:'Strong'},
               {min:60,key:'good',label:'Good'},{min:40,key:'fair',label:'Fair'},{min:0,key:'weak',label:'Weak'}];
  function bandFor(n){
    const hit=BANDS.find(b=>n>=b.min)||BANDS[BANDS.length-1];
    return {key:hit.key,label:hit.label};
  }

  /**
   * A deduction lowers the score; a ceiling scales how far that score can travel at
   * all. Without ceilings a line dodged every regex and scored 100 while still saying
   * nothing — proving the checklist, not the copy. Values are the share of the top
   * score the copy is eligible for.
   */
  const CEILINGS=[
    {label:'No concrete outcome',cap:74,why:'names no number, price, time, or named benefit'},
    {label:'Generic CTA verb',cap:49,why:'tells the reader what to click, not what they get'},
    {label:'Meaningless label',cap:30,why:'carries no outcome at all'},
    {label:'Abstract jargon',cap:59,why:'uses a category word where a benefit belongs'},
    {label:'Abstract verb',cap:59,why:'promises a feeling rather than an action'},
    {label:'Opens with a greeting',cap:59,why:'welcomes the reader instead of promising them something'},
    {label:'No action verb first',cap:74,why:'does not open with something the reader can do'},
    {label:'Passive construction',cap:79,why:'describes the thing, not what the reader gets'}
  ];

  /**
   * Score a piece of copy 0–100 (100 = nothing measurable working against it).
   * `kind` is 'cta' | 'headline' | 'body'. Returns every deduction that applied,
   * so the UI can say WHY rather than showing a bare number.
   */
  function scoreCopy(text, kind = 'headline', box = null) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    const issues = [];
    const deduct = (points, label, detail) => { if (points > 0) issues.push({ points, label, detail }); };
    if (!t) return { score: 0, raw: 0, band: bandFor(0), cappedBy: null, issues: [{ points: 100, label: 'No copy', detail: 'The element has no readable text.' }] };

    const words = t.split(/\s+/).filter(Boolean);
    const wordCount = words.length;

    if (kind === 'cta') {
      if (GENERIC_CTA.test(t)) deduct(24, 'Generic CTA verb', `"${t}" tells the reader what to click, not what they get.`);
      else if (!ACTION_VERB.test(words[0] || '')) deduct(9, 'No action verb first', 'The button text does not open with something the reader can do.');
      if (!SPECIFIC.test(t)) deduct(11, 'No concrete outcome', 'Nothing measurable or specific — no number, price, time, or named benefit.');
      if (wordCount > 6) deduct(7, 'Too long for a button', `${wordCount} words. Buttons read fastest at 2–5.`);
      if (wordCount === 1 && /^(go|next|ok|okay)$/i.test(t)) deduct(12, 'Meaningless label', 'A one-word label with no outcome.');
    } else if (kind === 'headline') {
      if (!SPECIFIC.test(t)) deduct(10, 'No concrete outcome', 'The headline names no number, price, time, or named benefit.');
      if (wordCount > 14) deduct(8, 'Too long to scan', `${wordCount} words. Headlines above ~12 words lose the reader.`);
      if (wordCount < 3) deduct(6, 'Too short to say anything', 'A 2-word headline carries no promise.');
    } else {
      if (wordCount > 32) deduct(6, 'Long paragraph', `${wordCount} words in one block.`);
    }

    if (ABSTRACT_VERB.test(t)) deduct(8, 'Abstract verb', `"${(t.match(ABSTRACT_VERB) || [''])[0]}" promises a feeling rather than an action.`);
    if (EMPTY_OPENER.test(t)) deduct(9, 'Opens with a greeting', 'Welcomes the reader instead of promising them something.');
    if (COMPANY_FIRST.test(t)) deduct(8, 'Leads with the company', 'Opens with "we/our" — the reader is looking for themselves, not you.');
    if (FLUFF.test(t)) deduct(12, 'Abstract jargon', `"${(t.match(FLUFF) || [''])[0]}" is a category word, not a benefit.`);
    if (HYPE.test(t)) deduct(6, 'Unsupported superlative', `"${(t.match(HYPE) || [''])[0]}" claims without proof.`);
    if (VAGUE_PRONOUN.test(t) && kind !== 'body') deduct(4, 'Vague referent', 'Uses "it/this/that" where the reader needs the noun.');
    if (PASSIVE.test(t)) deduct(5, 'Passive construction', 'Describes what something is designed to do instead of what the reader does.');
    if (/!/.test(t)) deduct(3, 'Exclamation mark', 'Reads as shouting in most B2B and financial copy.');
    if (t.length > 8 && t === t.toUpperCase() && /[A-Z]{4,}/.test(t)) deduct(5, 'All caps', 'All-caps copy is harder to read and reads as a warning.');

    if (box) {
      if (kind === 'cta' && box.height > 0 && box.height < 40) deduct(8, 'Small tap target', `${Math.round(box.height)}px tall. Below 44px is hard to hit on a phone.`);
      if (box.contrast !== null && box.contrast !== undefined) {
        if (box.contrast < 3) deduct(10, 'Low contrast', `${box.contrast}:1 against its background. WCAG AA needs 4.5:1 for body text, 3:1 for large.`);
        else if (box.contrast < 4.5 && box.fontSize < 24) deduct(4, 'Thin contrast', `${box.contrast}:1 — readable but weak for this size.`);
      }
      if (kind === 'cta' && box.fontSize && box.fontSize < 13) deduct(5, 'Tiny label', `${Math.round(box.fontSize)}px text.`);
    }

    const raw = clamp(Math.round(100 - issues.reduce((n, i) => n + i.points, 0)), 0, 100);
    let cap = 100, cappedBy = null;
    for (const c of CEILINGS) {
      if (issues.some(i => i.label === c.label) && c.cap < cap) { cap = c.cap; cappedBy = c; }
    }
    // The ceiling scales the checklist result rather than flat-capping it: a line that
    // has not earned a concrete outcome cannot be scored as though it had, but two such
    // lines still rank against each other instead of collapsing onto the same number.
    const score = Math.round(raw * (cap / 100));
    return { score, raw, band: bandFor(score), cappedBy,
             issues: issues.sort((a, b) => b.points - a.points) };
  }

  // ── DOM scan ────────────────────────────────────────────────────

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function selectorFor(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el, d = 0; n && n.nodeType === 1 && d < 4; n = n.parentElement, d++) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      let p = n.tagName.toLowerCase();
      const sibs = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : [];
      if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      parts.unshift(p);
    }
    return parts.join(' > ');
  }

  /** Visible, laid out, and carrying enough text to be judged. */
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 10) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity || 1) < 0.05) return false;
    return r.bottom > window.scrollY - 200 && r.top < window.scrollY + window.innerHeight * 8;
  }

  function textOf(el) {
    if (el.tagName === 'INPUT') return clean(el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder'));
    return clean(el.innerText || el.textContent);
  }

  function nearby(el) {
    const box = el.closest('section, article, header, main, form, li') || el.parentElement;
    if (!box) return '';
    const own = textOf(el);
    return clean(clean(box.innerText).replace(own, ' ')).slice(0, 260);
  }

  /** How much of the page's attention this slot commands, 0–100. */
  function prominence(el, rect, maxFont, docHeight) {
    const s = getComputedStyle(el);
    const fs = parseFloat(s.fontSize) || 12;
    const top = rect.top + window.scrollY;
    const aboveFold = top < window.innerHeight;
    const size = clamp((fs / maxFont) * 55, 0, 55);
    const fold = aboveFold ? 30 : clamp(30 - (top - window.innerHeight) / 120, 0, 30);
    const width = clamp((rect.width / window.innerWidth) * 15, 0, 15);
    const order = docHeight > 0 ? clamp(15 - (top / docHeight) * 15, 0, 15) : 15;
    // A 10px grey control does not command attention however wide it is. Without
    // this, a junk "submit" button outranked the hero and the ranking stopped
    // matching what a marketer sees on the page.
    const legible = clamp(fs / 14, 0.35, 1);
    return Math.round(clamp((size + fold + width + order) * legible, 0, 100));
  }

  function productLineFor() {
    const out = { value: '', source: '' };
    const ld = [...document.querySelectorAll('script[type="application/ld+json"]')];
    for (const s of ld) {
      try {
        const j = JSON.parse(s.textContent || '{}');
        const nodes = Array.isArray(j) ? j : (j['@graph'] || [j]);
        for (const n of nodes) {
          if (!n || typeof n !== 'object') continue;
          if (n['@type'] && /product|service|financialproduct|offer/i.test(JSON.stringify(n['@type']))) {
            const name = clean(n.name || n.headline || '');
            if (name) return { value: name.slice(0, 80), source: 'Product schema' };
          }
        }
      } catch {}
    }
    const og = clean(document.querySelector('meta[property="og:title"]')?.content || '');
    const h1 = clean(document.querySelector('h1')?.innerText || '');
    const title = clean(document.title || '');
    const brand = clean(document.querySelector('meta[property="og:site_name"]')?.content || '');
    // A product/offer name is usually the SHORT noun phrase in the h1 or title.
    if (h1 && h1.length <= 70) out.value = h1;
    else if (og) out.value = og.split(/[|—–:·]/)[0].trim();
    else if (title) out.value = title.split(/[|—–:·]/)[0].trim();
    if (brand && out.value && !out.value.toLowerCase().includes(brand.toLowerCase()) && brand.length <= 40) {
      // Keep the brand out of the product-line field unless it IS the product.
    }
    out.source = out.value ? (h1 && out.value === h1 ? 'page headline' : 'page title') : '';
    return out;
  }

  function scan() {
    const maxFont = Math.max(16, ...[...document.querySelectorAll('h1,h2,h3,button,a')]
      .slice(0, 400).map(el => parseFloat(getComputedStyle(el).fontSize) || 0));
    const docHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight);
    const found = [];
    const seen = new Set();

    const add = (el, kind) => {
      if (!el || el.nodeType !== 1 || !isVisible(el)) return;
      const text = textOf(el);
      if (!text || text.length < 2 || text.length > 220) return;
      const key = kind + ':' + text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const rect = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const box = {
        height: rect.height,
        fontSize: parseFloat(s.fontSize) || 12,
        contrast: contrastOf(el),
      };
      const { score, issues } = scoreCopy(text, kind, box);
      const prom = prominence(el, rect, maxFont, docHeight);
      found.push({
        id: found.length,
        kind,
        type: kind === 'cta' ? 'cta' : 'headline',
        tag: el.tagName.toLowerCase(),
        text,
        selector: selectorFor(el),
        context: nearby(el),
        score,
        prominence: prom,
        // Opportunity = valuable slot × weak copy. This is what ranks the list:
        // a slightly weak CTA above the fold beats a terrible line in the footer.
        opportunity: Math.round((prom / 100) * (100 - score)),
        aboveFold: rect.top + window.scrollY < window.innerHeight,
        top: Math.round(rect.top + window.scrollY),
        issues,
      });
    };

    [...document.querySelectorAll('h1')].forEach(el => add(el, 'headline'));
    [...document.querySelectorAll('h2, [role="heading"]')].slice(0, 8).forEach(el => add(el, 'headline'));
    [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')].forEach(el => add(el, 'cta'));
    [...document.querySelectorAll('a')].forEach(el => {
      const s = getComputedStyle(el);
      const looksButton = /btn|button|cta/i.test(el.className || '') || /rgb/.test(s.backgroundColor)
        && s.backgroundColor !== 'rgba(0, 0, 0, 0)' || el.getAttribute('role') === 'button';
      if (looksButton) add(el, 'cta');
    });

    const materials = found
      .sort((a, b) => b.opportunity - a.opportunity)
      .slice(0, 6)
      .map((m, i) => ({ ...m, id: i }));

    const product = productLineFor();
    const cta = [...document.querySelectorAll('button, [role="button"], a')]
      .map(el => textOf(el)).find(t => t && t.length <= 40 && ACTION_VERB.test(t)) || '';
    return {
      ok: true,
      url: location.href,
      title: clean(document.title),
      productLine: product.value,
      productSource: product.source,
      primaryCta: cta,
      materialCount: found.length,
      materials,
    };
  }

  // ── Pick mode ───────────────────────────────────────────────────
  // The user points at something the scan missed (or at a phrase inside a
  // paragraph). Everything here is pointer-events:none except a single listener,
  // so the page keeps behaving normally underneath.

  let picker = null;

  function endPick() {
    if (!picker) return;
    picker.box.remove();
    picker.hint.remove();
    document.removeEventListener('mousemove', picker.move, true);
    document.removeEventListener('click', picker.click, true);
    document.removeEventListener('keydown', picker.key, true);
    picker = null;
  }

  function describe(el, textOverride) {
    const text = clean(textOverride || textOf(el));
    const kind = /^(BUTTON|A|INPUT)$/i.test(el.tagName) ? 'cta' : (/^H[1-3]$/i.test(el.tagName) ? 'headline' : 'body');
    const rect = el.getBoundingClientRect();
    const { score, issues } = scoreCopy(text, kind, {
      height: rect.height,
      fontSize: parseFloat(getComputedStyle(el).fontSize) || 12,
      contrast: contrastOf(el),
    });
    return {
      id: 0, kind, type: kind, tag: el.tagName.toLowerCase(), text,
      selector: selectorFor(el), context: nearby(el), score, prominence: 100,
      opportunity: 100 - score, aboveFold: rect.top < window.innerHeight,
      top: Math.round(rect.top + window.scrollY), issues,
    };
  }

  function startPick() {
    if (picker) return { ok: true, already: true };
    // A live text selection is a precise instruction — honour it immediately.
    const sel = String(window.getSelection?.() || '').trim();
    if (sel.length >= 2) {
      const node = window.getSelection().anchorNode;
      const el = (node?.nodeType === 3 ? node.parentElement : node) || document.body;
      const picked = describe(el, sel);
      chrome.runtime.sendMessage({ type: MSG.SCAN_PICKED, material: picked }).catch(() => {});
      return { ok: true, selection: true };
    }

    const box = document.createElement('div');
    box.id = '__persado_pick';
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #DC2828;'
      + 'background:rgba(220,40,40,.08);border-radius:4px;transition:all .06s ease-out;display:none;';
    const hint = document.createElement('div');
    hint.textContent = 'Click the copy to optimize · Esc to cancel';
    hint.style.cssText = 'position:fixed;z-index:2147483647;left:50%;transform:translateX(-50%);bottom:24px;'
      + 'background:#1A1128;color:#fff;font:600 12px/1.4 Inter,sans-serif;padding:8px 14px;border-radius:999px;'
      + 'pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.25);';
    document.documentElement.append(box, hint);

    const move = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box || el === hint) return;
      const r = el.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
      box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    };
    const click = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;
      e.preventDefault(); e.stopPropagation();
      const picked = describe(el);
      endPick();
      chrome.runtime.sendMessage({ type: MSG.SCAN_PICKED, material: picked }).catch(() => {});
    };
    const key = (e) => {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      e.preventDefault(); e.stopPropagation();
      endPick();
      chrome.runtime.sendMessage({ type: MSG.SCAN_CANCELLED }).catch(() => {});
    };

    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
    picker = { box, hint, move, click, key };
    return { ok: true };
  }

  // ── Wiring ──────────────────────────────────────────────────────

  if (inPage && !self.__persadoScan) {
    const listener = (msg, _sender, sendResponse) => {
      if (msg.type === MSG.SCAN_PAGE) { try { sendResponse(scan()); } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); } return false; }
      if (msg.type === MSG.SCAN_CANCEL) { try { endPick(); sendResponse({ ok: true }); } catch (e) { sendResponse({ ok: false }); } return false; }
      if (msg.type === MSG.SCAN_PICK) { try { sendResponse(startPick()); } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); } return false; }
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    self.__persadoScan = { listener, endPick };
  }

  self.PERSADO_SCAN = {
    bandFor, scan, scoreCopy, startPick, endPick, selectorFor };
})();
