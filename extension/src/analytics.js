// ─── Persado Assist — adoption analytics (privacy-conscious adapter) ─────────
//
// A fixed set of events with allowlisted, non-identifying properties. No copy
// text, no URLs, no campaign ids, no email addresses, no keys: a property that
// is not on the allowlist is dropped, and string values must be short
// lower-case tokens, so free text cannot slip through.
//
// Modes
//   local (default)  Events stay in this browser profile, in a 500-event ring
//                    buffer under KEYS.ANALYTICS. Nothing is sent anywhere.
//                    Inspect from the side panel console:
//                      await PERSADO_ANALYTICS.dump()
//   remote           Only when ANALYTICS_ENDPOINT below is set to an HTTPS URL
//                    you control (and added to manifest host_permissions).
//                    Events are POSTed in small batches; failures are dropped.
//
// Classic script: loaded by the side panel and by node tests.

(function (root) {
  // Empty = local mode. Set only when a first-party collection endpoint exists.
  const ANALYTICS_ENDPOINT = '';

  const EVENTS = Object.freeze({
    PANEL_OPENED: 'panel_opened',
    RETURN_VISIT: 'return_visit',            // first open on a new calendar day after a previous one
    CONTENT_DETECTED: 'content_detected',
    CHECK_STARTED: 'check_started',
    CHECK_COMPLETED: 'check_completed',
    OPTIMIZE_STARTED: 'optimize_started',
    OPTIMIZE_COMPLETED: 'optimize_completed',
    RECOMMENDATION_APPLIED: 'recommendation_applied',
    UNDO_USED: 'undo_used',
    API_ERROR: 'api_error',
    CREDITS_INSUFFICIENT: 'credits_insufficient',
  });
  const NAMES = new Set(Object.values(EVENTS));

  // Property allowlist: name → validator. Anything else is dropped.
  const token = v => typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v);
  const count = v => Number.isInteger(v) && v >= 0 && v <= 100000;
  const PROPS = {
    surface: v => v === 'web' || v === 'mailchimp',
    touchpoint: token,          // headline, cta, body, subject_line, preview_text…
    op: v => v === 'score' || v === 'optimize',
    state: token,               // good, opportunity, recommended, unavailable…
    phase: token,               // running, stale, unavailable…
    cached: v => typeof v === 'boolean',
    resumed: v => typeof v === 'boolean',
    count,
    duration_ms: count,
    days_since_last: count,
    kind: token,                // error kind, e.g. gateway_down
  };
  function sanitize(props) {
    const out = {};
    for (const [k, v] of Object.entries(props || {})) if (PROPS[k]?.(v)) out[k] = v;
    return out;
  }

  const MAX_EVENTS = 500;
  const day = t => new Date(t).toISOString().slice(0, 10);

  function create({ storage, key, now = () => Date.now(), endpoint = ANALYTICS_ENDPOINT, fetchImpl = (...a) => fetch(...a),
    random = () => (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)) }) {
    let chain = Promise.resolve();
    const session = random();
    async function read() {
      try { return (await storage.get(key))[key] || null; } catch { return null; }
    }
    function track(name, props) {
      if (!NAMES.has(name)) return Promise.resolve(false);
      const ev = { name, props: sanitize(props), at: now(), session };
      // Serialise writes so concurrent events cannot overwrite each other.
      chain = chain.then(async () => {
        const st = (await read()) || { install: random(), events: [], lastOpenDay: null };
        const extra = [];
        if (name === EVENTS.PANEL_OPENED) {
          const today = day(ev.at);
          if (st.lastOpenDay && st.lastOpenDay !== today) {
            const days = Math.round((Date.parse(today) - Date.parse(st.lastOpenDay)) / 86400000);
            extra.push({ name: EVENTS.RETURN_VISIT, props: sanitize({ days_since_last: days }), at: ev.at, session });
          }
          st.lastOpenDay = today;
        }
        st.events = [...st.events, ev, ...extra].slice(-MAX_EVENTS);
        try { await storage.set({ [key]: st }); } catch {}
        if (endpoint && /^https:\/\//.test(endpoint)) {
          fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ install: st.install, events: [ev, ...extra] }) }).catch(() => {});
        }
        return true;
      }).catch(() => false);
      return chain;
    }
    async function dump() { return (await read())?.events || []; }
    return { track, dump, mode: endpoint ? 'remote' : 'local' };
  }

  root.PERSADO_ANALYTICS_LIB = Object.freeze({ create, sanitize, EVENTS, ANALYTICS_ENDPOINT });
  // In the side panel, a ready instance on chrome.storage.local.
  if (root.chrome?.storage?.local && root.PERSADO?.KEYS) {
    root.PERSADO_ANALYTICS = create({ storage: root.chrome.storage.local, key: root.PERSADO.KEYS.ANALYTICS });
  }
})(typeof self !== 'undefined' ? self : globalThis);
