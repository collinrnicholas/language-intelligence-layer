// Page chrome that looks like a call to action.
//
// A DOM query for buttons returns the cookie banner, the language switcher, the
// currency picker and the chat bubble alongside the real CTA. They are buttons,
// but they are not marketing copy: nobody rewrites "Cookie settings" for a
// conversion lift, and scoring them puts invented work at the top of the list.
//
// Pure predicates so this can be unit-tested without a DOM. scan.js does the
// ancestor walking and hands the text plus a container hint in here.

(function (scope) {
  const t = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  // Whole-string rules. Anchored so "Accept payments online" (a real fintech CTA)
  // survives while "Accept all" does not.
  const TEXT_RULES = [
    // Consent furniture
    /^(accept|allow|agree|reject|decline|deny|dismiss|got it|ok|okay)( all)?$/i,
    /^manage (preferences|options|cookies|settings|consent)$/i,
    /^(close|dismiss|no thanks)$/i,
    /\b(cookies?|consent|gdpr|ccpa)\b/i,
    /\b(privacy (policy|notice|settings|preferences|choices)|terms (of use|of service|and conditions|& conditions)|legal notice|imprint|accessibility statement|do not sell|your privacy choices)\b/i,
    // Language switchers
    /^(english|espa[nñ]ol|spanish|fran[cç]ais|deutsch|italiano|portugu[eê]s|nederlands|[nñ]ihongo|日本語|中文|한국어|русский|العربية|t[uü]rk[cç]e|polski|svenska|dansk|norsk|suomi|[cč]e[cš]tina|magyar|rom[aâ]n[aă]|ελληνικ[αά]|עברית|हिन्दी|ไทย|ti[eế]ng vi[eệ]t|bahasa indonesia|bahasa melayu)(\s*\(.*\))?$/i,
    /^([a-z]{2})(\s*[\/|·,;-]\s*[a-z]{2})+$/i,
    // Ad slots. "Sponsored Results" is a label the page owner does not write.
    /^(sponsored( results| links| content| stories)?|advertisement|ad|ads)$/i,
    // Site utilities that sit next to real CTAs
    /^(skip to (main )?content|back to top|back to search|main menu|open menu|close menu|menu|search|search this site|log ?in|sign ?in|my account|view cart|cart|checkout|currency|region|country|language|change language|select language|choose (your )?(region|country|language)|english \(us\))\b/i,
    /^(share( this| on .+)?|tweet|pin it|copy link|print|email this|copy)$/i,
    /^(powered by|built with|made with|hosted by)\b/i,
    /^(usd|eur|gbp|cad|aud|jpy)(\s*[\(\[]?[\$\€\£]?[\d.,]*\)?)?$/i,
  ];

  // Container fingerprints. The hint is the concatenated id/class/role/aria-label
  // of the element and its ancestors, lowercased. Vendor names are in here because
  // cookie and chat widgets ship under fixed ids whatever the site does.
  const CONTAINER_TOKENS = [
    'cookie', 'consent', 'gdpr', 'ccpa', 'onetrust', 'cookiebot', 'osano',
    'usercentrics', 'didomi', 'quantcast', 'truste', 'cc-window', 'cc-banner',
    'cookie-notice', 'intercom', 'drift-widget', 'crisp-client', 'zendesk',
    'chat-widget', 'chatbot', 'lang-switch', 'langswitch', 'language-select',
    'language-switcher', 'locale-select', 'locale-switch', 'translation-banner',
    'skip-link', 'screen-reader', 'sr-only',
    'sponsored', 'adsbygoogle', 'ad-slot', 'adunit', 'ad-unit', 'google-ads',
    'outbrain', 'taboola',
  ];

  function isNoiseText(text) {
    const s = t(text);
    if (!s) return true;
    return TEXT_RULES.some((re) => re.test(s));
  }

  function isNoiseContainer(hint) {
    const h = t(hint).toLowerCase();
    if (!h) return false;
    return CONTAINER_TOKENS.some((token) => h.includes(token));
  }

  // kind 'cta' gets the text rules; a headline only loses its place when it sits
  // inside a cookie banner or a widget, because "Privacy, without the fine print"
  // is a legitimate headline on a privacy product.
  // Ad labels are never copy, whatever the element is: a headline that says
  // "Sponsored Results" is a slot marker, not a promise to the reader.
  const ALWAYS_NOISE = /^(sponsored( results| links| content| stories)?|advertisement|ad|ads)$/i;

  function isNoise({ text, hint, control, kind } = {}) {
    if (control) return true;
    if (isNoiseContainer(hint)) return true;
    if (ALWAYS_NOISE.test(t(text))) return true;
    if (kind === 'cta') return isNoiseText(text);
    return false;
  }

  scope.PERSADO_NOISE = { isNoise, isNoiseText, isNoiseContainer, CONTAINER_TOKENS };
})(typeof self !== 'undefined' ? self : globalThis);
