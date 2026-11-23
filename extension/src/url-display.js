// How the panel names the page it is looking at.
//
// Two things made the header unusable: campaign parameters (one Mailchimp landing
// page arrived with fifteen lines of gclid/iga/ds_ noise) and, before that, the rule
// "show the whole address". Neither tells the reader anything — two visitors from
// different ads are on the same page, and 15 lines of tracking is not an address.
//
// So: host and path, plus up to two query parameters that actually change what you
// see. Anything longer is cut with an ellipsis; the full URL stays in the tooltip.

(function (scope) {
  const TRACKING_PARAM = /^(utm_|ga_|gclid$|gclsrc$|dclid$|gbraid$|wbraid$|fbclid$|msclkid$|mc_cid$|mc_eid$|igshid$|ds_|iga[a-z]*$|gad_|s_kwcid$|ef_id$|twclid$|li_fat_id$|_hs|vero_id$|ref$|ref_$|source$|campaign|adgroup|adid$|keyword$|matchtype$|device$|crid$|fb_action_ids$|_ga$|yclid$|ttclid$)/i;

  const LIMIT = 64;

  function displayUrl(u) {
    if (!u) return '';
    const bare = String(u).replace(/^[a-z]+:\/\//i, '');
    let url;
    try {
      url = new URL(u);
    } catch {
      return bare.replace(/^www\./i, '').replace(/\/$/, '');
    }
    if (!/^https?:$/.test(url.protocol)) return bare;   // about:blank, file:, chrome-extension:
    const host = url.host.replace(/^www\./i, '');
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    const kept = [...url.searchParams].filter(([k, v]) => !TRACKING_PARAM.test(k) && v.length <= 24);
    let out = host + path;
    if (kept.length) out += '?' + kept.slice(0, 2).map(([k, v]) => (v ? `${k}=${v}` : k)).join('&');
    return out.length > LIMIT ? out.slice(0, LIMIT - 1) + '…' : out;
  }

  scope.PERSADO_URL = { displayUrl, TRACKING_PARAM, LIMIT };
})(typeof self !== 'undefined' ? self : globalThis);
