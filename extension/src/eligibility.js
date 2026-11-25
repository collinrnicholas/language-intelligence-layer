// ─── Persado Assist — eligibility policy ─────────────────────────────────────
//
// One question, answered before money is spent: is this line marketing copy that
// Persado is allowed to work on?
//
// The panel used to answer a narrower version of it (page-noise.js: "is this
// cookie banner?") at detection time only. That is not enough: a pick, a stored
// material, a Check All batch and a retry all reach the same billable relay, and
// every one of them has to pass the same policy. So the policy lives here, is
// DOM-free, and is called from three places:
//
//   scan.js        — filtering what is detected, and what a manual pick may choose
//   sidepanel.js   — what Check All may queue (automatic) and what a click may run
//   background.js  — the relay to the gateway, before ANY billed request
//
// Hard exclusions are not a confidence judgement. A cookie button, a language
// switcher, a card field or a "Payment failed" state is never marketing copy, so
// it is excluded at every confidence and cannot be unlocked by a manual pick.
// Everything else must earn inclusion with affirmative evidence of marketing or
// conversion intent — a <button> and a verb are not evidence on their own.
//
// No DOM access, no network, no model call: testable in Node like page-noise.js.

(function (scope) {
  const t = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const lower = (s) => t(s).toLowerCase();
  const has = (re, s) => re.test(t(s));

  // ── Vocabulary ──────────────────────────────────────────────────
  const CATEGORY = Object.freeze({
    PRIMARY_CTA: 'primary_cta',
    SECONDARY_CTA: 'secondary_cta',
    MARKETING_HEADLINE: 'marketing_headline',
    VALUE_PROP: 'value_prop',
    FUNCTIONAL_CONTROL: 'functional_control',
    NAVIGATION: 'navigation',
    LANGUAGE: 'language',
    CONSENT: 'consent',
    AUTH: 'auth_control',
    ACCESSIBILITY: 'accessibility',
    LEGAL: 'legal',
    SECURITY_CHECK: 'security_check',
    SENSITIVE_FIELD: 'sensitive_field',
    SYSTEM_MESSAGE: 'system_message',
    UNKNOWN: 'unknown',
  });

  // Categories no billable request may ever carry, manual or not.
  const HARD_EXCLUDED = Object.freeze([
    CATEGORY.CONSENT, CATEGORY.LANGUAGE, CATEGORY.AUTH, CATEGORY.ACCESSIBILITY,
    CATEGORY.LEGAL, CATEGORY.SECURITY_CHECK, CATEGORY.SENSITIVE_FIELD, CATEGORY.SYSTEM_MESSAGE,
  ]);
  const HARD = new Set(HARD_EXCLUDED);

  // The only categories that can be eligible on their own. Functional controls,
  // navigation and unknown content are never queued automatically.
  const MARKETING = new Set([CATEGORY.PRIMARY_CTA, CATEGORY.SECONDARY_CTA,
    CATEGORY.MARKETING_HEADLINE, CATEGORY.VALUE_PROP]);

  const PAGE_TYPE = Object.freeze({
    MARKETING: 'marketing_landing', ECOMMERCE: 'ecommerce', CHECKOUT: 'checkout',
    LEAD: 'lead_generation', APPLICATION: 'application', FUNDRAISING: 'fundraising',
    AUTHENTICATED_APP: 'authenticated_app', CONTENT: 'content', UNKNOWN: 'unknown',
  });

  // Conversion intent per page type: what the page is asking the reader to do.
  const INTENT = {
    [PAGE_TYPE.MARKETING]: /^(get|start|try|book|schedule|request|talk|contact|claim|join|see|view|compare|download|subscribe|sign ?up|create|apply|accept (payments?|cards?)|check (your )?(rate|eligibility|options))\b/i,
    [PAGE_TYPE.ECOMMERCE]: /^(add to (cart|bag|basket)|buy|shop|order|checkout|get|subscribe|save|pre-?order)\b/i,
    [PAGE_TYPE.CHECKOUT]: /^(pay|place order|complete (order|purchase)|confirm (order|payment)|buy|checkout)\b/i,
    [PAGE_TYPE.LEAD]: /^(get|request|book|schedule|contact|talk|call|download|claim|start|try|apply)\b/i,
    [PAGE_TYPE.APPLICATION]: /^(apply|start (my |your )?application|begin|continue application|submit application|enroll|register|join)\b/i,
    [PAGE_TYPE.FUNDRAISING]: /^(donate|give|support|fund|sponsor|join|become)\b/i,
    [PAGE_TYPE.AUTHENTICATED_APP]: /^(upgrade|add|buy|subscribe|start|invite|connect|enable|install)\b/i,
    [PAGE_TYPE.CONTENT]: /^(subscribe|download|get|read|share|sign ?up)\b/i,
    [PAGE_TYPE.UNKNOWN]: /^(get|start|try|book|apply|buy|donate|subscribe|contact|request)\b/i,
  };

  // ── Rules ───────────────────────────────────────────────────────
  // Order matters: the first category that matches wins, and the hard ones are
  // tested before any marketing vocabulary gets a chance.

  const CONSENT_EXACT = /^(accept|allow|agree|reject|decline|deny|dismiss|got it|ok|okay)( all| everything| cookies| essential( cookies)?)?$/i;
  const CONSENT_STRONG = /^(manage|your|customi[sz]e) (cookie |privacy |consent )?(preferences|options|settings|choices)$/i;
  const CONSENT_BODY = /\b(we use cookies|this (site|website) uses cookies|by (continuing|using this site|clicking)|cookie (policy|settings|preferences|consent)|consent to (the use of )?cookies|gdpr|ccpa)\b/i;
  const CONSENT_WEAK = /\b(cookies?|consent)\b/i;
  // Agreement to marketing contact is a privacy preference however it is worded,
  // and it must be caught from text alone (a stored payload carries no hint).
  const CONSENT_AGREEMENT = /^(i|we) (agree|consent)\b|\b(agree|consent) to (receive|the (processing|use|collection))\b|\b(marketing|promotional) (emails?|messages|communications|texts?)\b/i;

  const LANGUAGE_EXACT = /^(english|espa[nñ]ol|spanish|fran[cç]ais|deutsch|italiano|portugu[eê]s|nederlands|日本語|中文|한국어|русский|العربية|t[uü]rk[cç]e|polski|svenska|dansk|norsk|suomi|[cč]e[cš]tina|magyar|ελληνικ[αά]|עברית|हिन्दी|ไทย|ti[eế]ng vi[eệ]t|bahasa indonesia|bahasa melayu)(\s*\(.*\))?$/i;
  const LANGUAGE_PAIR = /^([a-z]{2})(\s*[\/|·,;-]\s*[a-z]{2})+$/i;
  const LANGUAGE_META = /\b(change|select|choose|set) (the |your )?(language|locale|region|country)\b|^(language|locale|region|country)\b/i;
  const LOCALE_CURRENCY = /^(usd|eur|gbp|cad|aud|jpy|chf|inr|brl|mxn)(\s*[\(\[]?[$€£¥₹]?[\d.,]*\)?)?$/i;

  // Acquisition is marketing; authentication, recovery and account security are not.
  const AUTH_CONTROL = /^(log ?in|sign ?in|log ?out|sign ?out|my account|account( settings| security)?|profile|forgot (your )?password|reset (your )?password|change (your )?password|verify (your )?(email|identity|account|phone)|two[- ]factor|2fa|mfa|authenticator|passkey|security key|manage (devices|sessions|subscriptions)|delete (my )?account|edit profile)\b/i;
  const AUTH_IDENTITY = /\b(continue|sign in|log in) with (google|apple|microsoft|facebook|github|okta|sso|saml)\b|\b(single sign[- ]on|saml sso|identity provider)\b/i;
  const SECURITY_CHECK = /\b(captcha|re-?captcha|hcaptcha|i'?m not a robot|verify (that )?you are (a )?human|security check|press (and hold|& hold)|prove you'?re (a )?human|enter the (verification )?code)\b/i;

  const A11Y_CONTROL = /^(accessibility( statement| settings| options| features)?|skip to (main )?(content|navigation)|screen ?reader( mode)?|high contrast|reduce motion|text size|font size|enable (captions|subtitles))\b/i;

  const LEGAL_DOC = /^(terms( of (use|service|sale))?|terms (and|&) conditions|privacy( policy| notice| statement)?|cookie policy|refund policy|legal( notice| terms| information)?|disclaimer|disclosures?|imprint|licen[cs]es?|unsubscribe|do not sell( or share)?( my personal information)?)(\b|$)/i;
  const LEGAL_LINK = /\b(privacy (policy|notice|statement)|terms of (use|service|sale)|cookie policy|refund policy|do not sell|your privacy choices)\b/i;
  const LEGAL_CLAIM = /\b(equal housing( opportunity)?|member fdic|fdic insured|nmls( id)?|past performance|not (financial|investment|legal) advice|subject to credit approval|rates? (and|&) terms|risk disclosure|regulatory (disclosure|notice)|all rights reserved|©)\b/i;
  const LEGAL_BODY = /\b(these terms|governed by|by accepting|arbitration|class action waiver|unsubscribe here|manage (your )?(email )?preferences|this notice describes|protected health information|hipaa)\b/i;

  const SENSITIVE_FIELD = /\b(ssn|social security( number)?|card number|credit card( number)?|debit card( number)?|cvc|cvv|security code|routing number|account number|iban|date of birth|passport( number)?|driver'?s licen[cs]e|tax ?id|ein)\b/i;

  const SYSTEM_STATE = /^(error|warning|alert)\b/i;
  const SYSTEM_BODY = /\b(something went wrong|payment (failed|declined)|transaction (failed|declined)|card (was )?declined|session (expired|timed out)|unable to (process|complete)|service unavailable|access denied|permission denied|try again later|internal server error|page not found)\b/i;

  // Ordinary interface verbs. Never a marketing rewrite, whatever the button says.
  const FUNCTIONAL_EXACT = /^(menu|close|dismiss|search|filter|filters|sort|sort by|next|previous|prev|back|continue|skip|cancel|clear|clear all|reset|reset filters|apply filters?|view all|show more|see all|load more|more|less|expand|collapse|settings|preferences|help|support|chat|feedback|play|pause|mute|unmute|volume|fullscreen|zoom( in| out)?|list view|grid view|download|print|share|copy|bookmark|favorite|like|follow|enable notifications|allow notifications|refresh|reload|dismiss banner)$/i;

  // Workspace and product navigation, the shape of an authenticated app shell.
  const APP_NAV = /^(projects?|spaces?|new chat|chats?|explore|library|history|recent|starred|workspace|workspaces|dashboard|home|inbox|messages|notifications|activity|files?|folders?|docs?|documents?|tasks?|boards?|calendar|contacts|customers|reports?|analytics|integrations|settings|preferences|admin|members|team|people|billing|usage|help|feedback|search|back|forward|upgrade plan|manage plan)$/i;

  // Marketing / conversion vocabulary. Matched against the start of the label so
  // "Apply now" and "Start your application" both count, while "Apply filters" does not.
  const MARKETING_VERB = /^(apply|start|begin|get|buy|shop|order|add to (cart|bag|basket)|checkout|donate|give|support|book|schedule|reserve|request|contact|talk to|speak to|call|check (your |my )?(rate|eligibility|options|availability|price)|claim|join|enroll|register|sign ?up|create (an |your )?account|start (a |your )?(free )?trial|try|download (the|your)|get the|see (pricing|plans)|view (pricing|plans)|compare|calculate|save|earn|protect|insure|invest|refinance|consolidate|upgrade|unlock|accept (payments?|cards?|crypto|donations?)|subscribe|pre-?order|place order|complete (your )?order|pay)\b/i;

  const BENEFIT = /\b(free|save|savings|discount|offer|deal|guarantee|no fee|no fees|faster|cheaper|approved|qualified|funded|same[- ]day|minutes?|hours?|days?|weeks?|\d+%|\$|£|€|risk[- ]free|trial|bonus|cash ?back|low(er)? rate)\b/i;

  const CTA_TAGS = /^(button|a|input)$/i;
  const HEADING_TAGS = /^h[1-3]$/i;
  const NAV_TOKENS = /\b(nav|navbar|navigation|menu|menubar|breadcrumb|sidebar|side-bar|topbar|top-bar|toolbar|app-header|app-shell|site-header|site-footer|footer|mega-?menu)\b/i;
  const MARKETING_TOKENS = /\b(hero|masthead|cta|promo|offer|upsell|upgrade|pricing|plans?|product|signup|sign-up|lead|trial|subscribe|newsletter|donate|donation|checkout|banner-hero)\b/i;
  const CONSENT_TOKENS = /\b(cookie|consent|gdpr|ccpa|onetrust|cookiebot|osano|usercentrics|didomi|quantcast|truste|cc-window|cc-banner|cookie-notice)\b/i;
  const LANGUAGE_TOKENS = /\b(lang|locale|language|translate|translation|i18n|globe)\b/i;
  const LEGAL_TOKENS = /\b(legal|terms|privacy|disclosure|disclaimer|imprint|consent-?footer)\b/i;
  const AUTH_TOKENS = /\b(auth|login|log-in|signin|sign-in|account|mfa|otp|passkey|sso|security)\b/i;

  // ── Page context ────────────────────────────────────────────────

  /**
   * Broad page type from signals the DOM can see, never from a hostname list.
   * `signals` is produced by scan.js: path, title, ogType, h1, price, cart,
   * forms, nav labels, ariaCurrent, schema types.
   */
  function pageType(signals = {}) {
    const path = lower(signals.path || (() => { try { return new URL(signals.url || '').pathname; } catch { return ''; } })());
    const title = lower([signals.title, signals.h1].filter(Boolean).join(' '));
    const navLabels = (signals.navLabels || []).map(lower);
    const appish = navLabels.filter((l) => APP_NAV.test(l)).length;

    if (signals.checkout || /\/(checkout|payment|billing\/pay)\b/.test(path)) return PAGE_TYPE.CHECKOUT;
    if (/\/(apply|application|admissions?|enrol)\b/.test(path) || signals.applicationForm) return PAGE_TYPE.APPLICATION;
    if (/\/(donate|donation|give|fundraise)\b/.test(path) || signals.donation) return PAGE_TYPE.FUNDRAISING;
    if (signals.price || signals.cart || /^(product|offer)$/i.test(signals.ogType || '') ||
        (signals.schemaTypes || []).some((s) => /product|offer/i.test(s))) return PAGE_TYPE.ECOMMERCE;
    if (signals.leadForm) return PAGE_TYPE.LEAD;
    if (appish >= 3 && signals.ariaCurrent) return PAGE_TYPE.AUTHENTICATED_APP;
    if (/\/(blog|article|news|guides?|docs?|help)\b/.test(path) || signals.article) return PAGE_TYPE.CONTENT;
    if (signals.marketingHero || /landing|pricing|solutions|features/.test(path + ' ' + title)) return PAGE_TYPE.MARKETING;
    if (signals.form) return PAGE_TYPE.LEAD;
    return PAGE_TYPE.UNKNOWN;
  }

  // ── Classification ──────────────────────────────────────────────

  /**
   * Classify one candidate. `subject` fields (all optional except text):
   *   text, kind ('cta'|'headline'|'body'), tag, role, inputType, ariaLabel,
   *   hint (ancestor id/class/role fingerprint), landmarks{nav,header,footer,main,form,dialog},
   *   pageType, context, aboveFold, disabled
   * Returns { category, hardExcluded, autoEligible, manualEligible, confidence, reason }.
   */
  function classify(subject = {}) {
    const text = t(subject.text);
    const kind = subject.kind === 'cta' || subject.kind === 'headline' ? subject.kind : 'body';
    const tag = lower(subject.tag || '');
    const role = lower(subject.role || '');
    const hint = lower(subject.hint || '');
    const aria = lower(subject.ariaLabel || '');
    const name = lower([subject.name, subject.id, subject.className, aria].filter(Boolean).join(' '));
    const lm = subject.landmarks || {};
    const page = subject.pageType || PAGE_TYPE.UNKNOWN;
    const inChrome = !!(lm.nav || lm.footer || (lm.header && kind === 'cta'));

    const out = (category, reason, confidence = 1) => ({
      category,
      hardExcluded: HARD.has(category),
      autoEligible: false,
      manualEligible: !HARD.has(category),
      confidence,
      reason,
    });

    if (!text) return out(CATEGORY.UNKNOWN, 'no readable text', 0);

    // ── 1. Inputs that can only be personal data or secrets.
    const inputType = lower(subject.inputType);
    if (/^(password|hidden|tel|email)$/.test(inputType) && subject.sensitive) {
      // email/phone are normal lead fields; password and flagged sensitive inputs are not.
    }
    if (inputType === 'password' || subject.sensitiveField ||
        (tag === 'input' && /ssn|card|cvc|cvv|security|account|routing|passport|dob|birth/.test(name))) {
      return out(CATEGORY.SENSITIVE_FIELD, 'an input that collects personal or card data');
    }
    if (SENSITIVE_FIELD.test(text) && kind === 'cta') {
      return out(CATEGORY.SENSITIVE_FIELD, 'names a personal-information field');
    }

    // ── 2. Hard exclusions, text first.
    if (CONSENT_EXACT.test(text) || CONSENT_STRONG.test(text)) {
      return out(CATEGORY.CONSENT, 'a consent control, not marketing copy');
    }
    if (SECURITY_CHECK.test(text)) return out(CATEGORY.SECURITY_CHECK, 'a security verification step');
    if (A11Y_CONTROL.test(text)) return out(CATEGORY.ACCESSIBILITY, 'an accessibility control');
    if (AUTH_CONTROL.test(text) || AUTH_IDENTITY.test(text) ||
        (text.length <= 45 && /\b(log ?in|sign ?in|log ?out|sign ?out)\b/i.test(text))) {
      return out(CATEGORY.AUTH, 'an authentication or account-security control');
    }
    // "Read our privacy policy" is a legal link however it is phrased, so the
    // document names are matched anywhere in short control/body text.
    const legalLink = kind !== 'headline' && text.length <= 60 && LEGAL_LINK.test(text);
    if (LEGAL_DOC.test(text) || LEGAL_LINK.test(text) || LEGAL_CLAIM.test(text) || (kind !== 'headline' && LEGAL_BODY.test(text))) {
      return out(CATEGORY.LEGAL, 'legal, regulatory or compliance copy');
    }
    if (SYSTEM_STATE.test(text) || (kind !== 'headline' && SYSTEM_BODY.test(text))) {
      return out(CATEGORY.SYSTEM_MESSAGE, 'a system state, not a marketing message');
    }
    if (LANGUAGE_EXACT.test(text) || LANGUAGE_PAIR.test(text) || LOCALE_CURRENCY.test(text)) {
      return out(CATEGORY.LANGUAGE, 'a language or locale label');
    }
    if (LANGUAGE_META.test(text) && text.length <= 40) {
      return out(CATEGORY.LANGUAGE, 'a language or locale selector');
    }
    // A short label is only treated as copy when nothing about it is consent-like;
    // long body text inside a consent banner is caught by the container, below.
    if (kind !== 'headline' && CONSENT_AGREEMENT.test(text)) {
      return out(CATEGORY.CONSENT, 'a privacy-preference agreement, not marketing copy');
    }
    if (kind !== 'headline' && CONSENT_WEAK.test(text) && text.length <= 60) {
      return out(CATEGORY.CONSENT, 'consent wording');
    }

    // ── 3. Hard exclusions by container. Vendor banners and legal footers ship
    //      under fixed ids/classes, whatever the visible label says.
    if (CONSENT_TOKENS.test(hint) || CONSENT_TOKENS.test(name)) {
      return out(CATEGORY.CONSENT, 'inside a cookie or consent widget');
    }
    if (kind === 'cta' && LANGUAGE_TOKENS.test(hint)) return out(CATEGORY.LANGUAGE, 'inside a language switcher');
    if (kind === 'cta' && AUTH_TOKENS.test(hint) && (inChrome || lm.dialog)) {
      return out(CATEGORY.AUTH, 'inside an account or security control');
    }
    if (LEGAL_TOKENS.test(hint) && kind === 'cta') return out(CATEGORY.LEGAL, 'inside a legal or policy block');

    // ── 4. Functional interface, navigation and app chrome.
    if (kind === 'cta') {
      if (FUNCTIONAL_EXACT.test(text)) return out(CATEGORY.FUNCTIONAL_CONTROL, 'a routine interface control');
      const appNav = APP_NAV.test(text) && (page === PAGE_TYPE.AUTHENTICATED_APP || inChrome || lm.aside);
      if (appNav) return out(CATEGORY.NAVIGATION, 'navigation inside an application shell');
      if (inChrome && !MARKETING_TOKENS.test(hint) && !INTENT[page]?.test(text)) {
        return out(CATEGORY.NAVIGATION, 'site chrome, not a conversion action');
      }
    }
    if (kind === 'headline') {
      if (APP_NAV.test(text) || (NAV_TOKENS.test(hint) && !MARKETING_TOKENS.test(hint))) {
        return out(CATEGORY.NAVIGATION, 'a navigation or chrome label');
      }
    }
    if (kind === 'body') {
      // Body copy is judged by what surrounds it, never on its own.
      if (lm.nav || lm.footer) return out(CATEGORY.NAVIGATION, 'inside navigation or a footer');
      if (CONSENT_TOKENS.test(hint)) return out(CATEGORY.CONSENT, 'inside a consent widget');
    }

    // ── 5. Affirmative marketing evidence.
    const intent = INTENT[page] ? INTENT[page].test(text) : false;
    const verb = MARKETING_VERB.test(text);
    const benefit = BENEFIT.test(text);
    const marketingContainer = MARKETING_TOKENS.test(hint);
    const conversionContainer = !!(lm.form || lm.main) || marketingContainer;
    const buttonLike = kind === 'cta' && (CTA_TAGS.test(tag) || role === 'button' || lower(subject.type) === 'submit' || subject.buttonLike === true);
    const headingLike = kind === 'headline' && (HEADING_TAGS.test(tag) || role === 'heading');

    if (kind === 'cta') {
      let conf = 0;
      const why = [];
      if (buttonLike) { conf += 0.2; why.push('a control'); }
      if (verb) { conf += 0.25; why.push('a conversion verb'); }
      if (intent) { conf += 0.2; why.push(`what a ${page.replace(/_/g, ' ')} page asks for`); }
      if (benefit) { conf += 0.15; why.push('a stated benefit'); }
      if (conversionContainer) { conf += 0.1; why.push('inside the page’s content'); }
      if (subject.aboveFold) { conf += 0.05; }
      if (marketingContainer) { conf += 0.05; why.push('in a marketing section'); }
      if (lm.nav || lm.footer) { conf -= 0.3; }
      if (page === PAGE_TYPE.AUTHENTICATED_APP && !marketingContainer && !intent) { conf -= 0.25; }
      const confidence = Math.round(Math.max(0, Math.min(1, conf)) * 100) / 100;
      if (confidence >= 0.55 && (verb || intent)) {
        const primary = confidence >= 0.6 && (clickIntent(text, page) || lm.form || marketingContainer);
        const d = out(primary ? CATEGORY.PRIMARY_CTA : CATEGORY.SECONDARY_CTA, why.slice(0, 2).join(' · ') || 'conversion intent', confidence);
        d.autoEligible = true;
        return d;
      }
      if (confidence >= 0.35 || !buttonLike) return out(CATEGORY.UNKNOWN, 'possibly copy, but no conversion evidence', confidence);
      return out(CATEGORY.FUNCTIONAL_CONTROL, 'an interface control with no conversion intent', confidence);
    }

    if (kind === 'headline') {
      let conf = 0;
      const why = [];
      if (headingLike && lm.main) { conf += 0.3; why.push('a heading in the page content'); }
      else if (headingLike) { conf += 0.15; why.push('a heading'); }
      if (benefit) { conf += 0.2; why.push('a stated benefit'); }
      if (marketingContainer) { conf += 0.15; why.push('a marketing section'); }
      if (subject.aboveFold) { conf += 0.1; }
      if (intent || verb) { conf += 0.1; why.push('conversion language'); }
      if (lm.nav || lm.header || lm.footer) { conf -= 0.3; }
      const confidence = Math.round(Math.max(0, Math.min(1, conf)) * 100) / 100;
      if (confidence >= 0.55) {
        const d = out(CATEGORY.MARKETING_HEADLINE, why.slice(0, 2).join(' · ') || 'marketing headline', confidence);
        d.autoEligible = true;
        return d;
      }
      return out(CATEGORY.UNKNOWN, 'a heading without marketing evidence', confidence);
    }

    // Body copy: only value propositions with evidence around them.
    if (!lm.main && !marketingContainer) return out(CATEGORY.UNKNOWN, 'body text outside the marketing content', 0.2);
    let conf = 0.2;
    if (benefit) conf += 0.2;
    if (marketingContainer) conf += 0.2;
    if (conversionContainer) conf += 0.1;
    if (subject.nearConversion) conf += 0.15;
    const confidence = Math.round(Math.min(1, conf) * 100) / 100;
    if (confidence >= 0.6) {
      const d = out(CATEGORY.VALUE_PROP, 'supporting copy beside a conversion action', confidence);
      d.autoEligible = true;
      return d;
    }
    return out(CATEGORY.UNKNOWN, 'body text with no conversion context', confidence);
  }

  /** Does this label ask for the page's OWN conversion action? Not just any verb:
   *  on an application page "Book a tour" is a secondary action, "Apply now" is the
   *  page's purpose. Used both for ranking the primary CTA and for choosing it. */
  function clickIntent(text, page) {
    const intent = INTENT[page];
    return !!(intent && intent.test(text));
  }

  // ── Policy decisions ────────────────────────────────────────────

  /** Automatic inclusion (detection lists, Check All, ranking). */
  function autoEligible(subject) {
    const d = subject && subject.eligibility ? subject.eligibility : classify(subject);
    return !!d.autoEligible && MARKETING.has(d.category) && !d.hardExcluded;
  }

  /**
   * The billable gate. Called by background.js before relaying a Persado score or
   * optimize. `manual` marks a user's explicit click; it unlocks ambiguous copy
   * only, never a hard exclusion.
   */
  function gate(request = {}) {
    const text = t(request.text);
    const kind = request.kind === 'cta' || request.kind === 'headline' ? request.kind : 'body';
    const decision = request.eligibility && request.eligibility.category
      ? { ...request.eligibility }
      : classify({ text, kind });

    // The text itself is re-checked: stored materials, retries and old payloads
    // must not be able to carry excluded copy just because they were queued.
    const fresh = classify({ text, kind });
    if (fresh.hardExcluded) {
      return { ok: false, kind: 'ineligible', category: fresh.category,
        message: blockMessage(fresh.category), reason: fresh.reason, eligibility: fresh };
    }
    if (decision.hardExcluded) {
      return { ok: false, kind: 'ineligible', category: decision.category,
        message: blockMessage(decision.category), reason: decision.reason, eligibility: decision };
    }
    // An explicit selection may check anything the policy did not hard-exclude:
    // the user is allowed to be more ambitious than the automatic rules.
    if (request.manual && !request.batch) return { ok: true, category: decision.category, manual: true, eligibility: decision };
    // A batch is the only thing that spends credits without a click, so it is the
    // only thing that must prove automatic eligibility.
    if (request.batch && !(decision.autoEligible && MARKETING.has(decision.category))) {
      return { ok: false, kind: 'needs_selection', category: decision.category || CATEGORY.UNKNOWN,
        message: 'This copy was not classified as marketing content. Select it explicitly to check it.',
        reason: decision.reason || 'no affirmative marketing evidence', eligibility: decision };
    }
    return { ok: true, category: decision.category, eligibility: decision };
  }

  const LABEL = {
    [CATEGORY.CONSENT]: 'a cookie or consent control',
    [CATEGORY.LANGUAGE]: 'a language or locale selector',
    [CATEGORY.AUTH]: 'an authentication or account-security control',
    [CATEGORY.ACCESSIBILITY]: 'an accessibility control',
    [CATEGORY.LEGAL]: 'legal or regulatory copy',
    [CATEGORY.SECURITY_CHECK]: 'a security verification step',
    [CATEGORY.SENSITIVE_FIELD]: 'a personal-information field',
    [CATEGORY.SYSTEM_MESSAGE]: 'a system error or transactional state',
  };

  function blockMessage(category) {
    return `Persado Assist does not send ${LABEL[category] || 'this content'} for scoring.`;
  }

  /** Split a material list into what may be queued and what may not. */
  function partition(materials = []) {
    const eligible = [], excluded = [], uncertain = [];
    for (const m of materials) {
      const d = m && m.eligibility ? m.eligibility : classify(m || {});
      if (d.hardExcluded) excluded.push({ material: m, decision: d });
      else if (d.autoEligible) eligible.push(m);
      else uncertain.push({ material: m, decision: d });
    }
    return { eligible, uncertain, excluded };
  }

  /** Rules, exposed for docs and for the regression report. */
  const POLICY = Object.freeze({
    version: '2026-11-eligibility-1',
    hardExcluded: HARD_EXCLUDED,
    marketing: [...MARKETING],
    threshold: 0.55,
  });

  scope.PERSADO_ELIGIBILITY = Object.freeze({
    CATEGORY, HARD_EXCLUDED, MARKETING, PAGE_TYPE, POLICY, LABEL,
    pageType, classify, autoEligible, gate, partition, blockMessage, clickIntent,
  });
})(typeof self !== 'undefined' ? self : globalThis);
