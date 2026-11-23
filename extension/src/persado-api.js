// ─── Persado Autopilot — Persado Martech API service ─────────────────────────
//
// The ONLY code that talks to Persado. Every request shape, path, header and
// response field below is taken from Persado's own published client,
// github.com/persado/martechapi-cli (src/pkg/api/{client,endpoints,models,
// validate}.go). Nothing here is guessed; where the spec is silent (credit cost
// of a score run, usage endpoints) the code says so and does not invent one.
//
//   Base URL      https://api.persado.com/api
//   Auth          Authorization: Bearer <key>
//   POST /v1/score?wait=N      → Job   (1–4 variants)
//   POST /v1/optimize?wait=N   → Job   (one variant → ranked alternatives)
//   GET  /v1/jobs/{id}         → Job   (poll until completed | failed)
//   GET  /v1/catalogue         → channels, touchpoints, industries, limits
//   Errors        { error: { code, message, requestId, details[], categories[],
//                   retryAfterSeconds } }; 429 rate_limited and 503 are retried,
//                   429 quota_exhausted is not.
//
// Classic script (no import/export) so the service worker can importScripts it
// and node tests can load it. It runs ONLY in the service worker: the key is
// passed in per call and is never stored, logged or returned from here.

(function (root) {
  const BASE_URL = 'https://api.persado.com/api';

  // ── Run accounting ─────────────────────────────────────────────
  // The developer portal (api.persado.com/api/developers) publishes
  //   meta-devkey-run-quota     100
  //   meta-devkey-optimize-cost 5
  // It publishes no score cost, so a score run is counted as 1 — an ASSUMPTION,
  // labelled as such in the UI. Neither value is an account balance: the API has
  // no documented balance endpoint, so any remaining figure is a local estimate.
  const RUN_QUOTA = 100;
  const COSTS = Object.freeze({ score: 1, optimize: 5 });
  const COST_SOURCE = Object.freeze({
    quota: 'Persado developer portal (run quota)',
    optimize: 'Persado developer portal (optimize cost)',
    score: 'assumed — the portal publishes no score cost',
  });

  // ── Spec constants (validate.go) ───────────────────────────────
  const CHANNEL_TOUCHPOINTS = Object.freeze({
    EMAIL_SUBJECT: ['text'],
    EMAIL_SUBJECT_BODY: ['subject_line', 'preheader', 'headline', 'subheadline', 'body', 'cta'],
    SMS_EMS: ['text'],
    PUSH_NOTIFICATION: ['headline', 'body'],
    IN_APP_BODY: ['header', 'subheadline', 'body', 'cta'],
    WEB_PAGE: ['preheadline', 'headline', 'subheadline', 'body', 'cta'],
    WEB_BANNER: ['preheadline', 'headline', 'subheadline', 'body', 'cta'],
    ADWORD: ['headline', 'description'],
    FACEBOOK_AD: ['text', 'headline', 'link_description'],
    LINKEDIN_AD: ['text', 'headline', 'link_description'],
    DIRECT_MAIL: ['envelope_front', 'envelope_back', 'letter_preheadline', 'letter_headline',
      'letter_subheadline', 'letter_body', 'letter_cta', 'letter_closing'],
  });
  const INDUSTRIES = Object.freeze(['AUTOMOTIVE', 'B2B_SERVICES', 'CHARITIES_GOOD_WILL',
    'CONSUMER_GOODS_SERVICES', 'DATING', 'EDUCATION', 'ENERGY', 'FASHION_APPAREL',
    'FINANCIAL_SERVICES', 'GAMING_GAMBLING', 'HEALTHCARE', 'INSURANCE', 'INTERNET_CABLE',
    'MEDIA_ENTERTAINMENT', 'OTHER', 'RETAIL_ECOMMERCE', 'TECHNOLOGY_APPS_SOFTWARE',
    'TELECOMMUNICATIONS', 'TRAVEL_HOTELS']);
  const LIMITS = Object.freeze({
    MAX_SCORE_VARIANTS: 4, MAX_TOUCHPOINT_LENGTH: 65536, MAX_CONTEXT_LENGTH: 30000,
    MAX_ALWAYS_USE: 10, MAX_ALWAYS_USE_LENGTH: 100, MAX_WAIT_SECONDS: 50,
  });
  const MAX_RETRIES = 3;
  const MAX_RETRY_DELAY_MS = 30000;
  const POLL_MS = 2000;
  const REQUEST_TIMEOUT_MS = 75000;     // a wait=50 request is held open ~50 s
  const JOB_TIMEOUT_MS = 10 * 60000;    // optimize "typically a few minutes"

  // Typed failure kinds — the UI maps these to plain language.
  const KIND = Object.freeze({
    NO_KEY: 'no_key', INVALID_KEY: 'invalid_key', QUOTA: 'quota_exhausted',
    RATE_LIMITED: 'rate_limited', UNAVAILABLE: 'unavailable', UNREACHABLE: 'unreachable',
    TIMEOUT: 'timeout', INVALID_REQUEST: 'invalid_request', PERSONAL_DATA: 'personal_data',
    JOB_FAILED: 'job_failed', SERVER: 'server_error',
  });

  class PersadoError extends Error {
    constructor(kind, message, extra = {}) {
      super(message);
      this.name = 'PersadoError';
      this.kind = kind;
      Object.assign(this, extra);
    }
    toJSON() {
      return { kind: this.kind, message: this.message, status: this.status || null,
        code: this.code || null, requestId: this.requestId || null,
        details: this.details || [], retryAfter: this.retryAfter || null };
    }
  }

  // ── Validation (mirrors validate.go) ───────────────────────────
  const len = (s) => [...String(s ?? '').trim()].length;

  function checkAccount(a, errs) {
    if (!a || len(a.name) < 1) errs.push({ field: 'account.name', reason: 'is required (your brand name)' });
    else if (len(a.name) > 256) errs.push({ field: 'account.name', reason: 'must be at most 256 characters' });
    if (a?.industry && !INDUSTRIES.includes(a.industry)) errs.push({ field: 'account.industry', reason: `"${a.industry}" is not a Persado industry` });
    if (a?.country && !/^[A-Z]{2}$/.test(a.country)) errs.push({ field: 'account.country', reason: 'must be two capital letters' });
    if (a?.language && !/^[a-z]{2,3}$/.test(a.language)) errs.push({ field: 'account.language', reason: 'must be a lower-case language code' });
  }

  function checkTouchpoints(field, channel, t, errs) {
    const keys = Object.keys(t || {});
    if (!keys.length) { errs.push({ field, reason: 'needs at least one touchpoint' }); return; }
    const ch = channel || 'EMAIL_SUBJECT';
    const allowed = CHANNEL_TOUCHPOINTS[ch];
    const anyKey = keys.length === 1 && (ch === 'EMAIL_SUBJECT' || ch === 'SMS_EMS');
    for (const k of keys.sort()) {
      if (allowed && !anyKey && !allowed.includes(k.trim().toLowerCase())) {
        errs.push({ field: `${field}.${k}`, reason: `is not a touchpoint of ${ch}; use ${allowed.join(', ')}` });
      }
      const n = [...String(t[k] ?? '')].length;
      if (n < 1 || n > LIMITS.MAX_TOUCHPOINT_LENGTH) errs.push({ field: `${field}.${k}`, reason: `must be 1 to ${LIMITS.MAX_TOUCHPOINT_LENGTH} characters` });
    }
  }

  function validateScore(req) {
    const errs = [];
    if (req.channel && !CHANNEL_TOUCHPOINTS[req.channel]) errs.push({ field: 'channel', reason: `"${req.channel}" is not a Persado channel` });
    checkAccount(req.account, errs);
    const n = (req.variants || []).length;
    if (n < 1 || n > LIMITS.MAX_SCORE_VARIANTS) errs.push({ field: 'variants', reason: `must hold 1 to ${LIMITS.MAX_SCORE_VARIANTS} variants (got ${n})` });
    (req.variants || []).forEach((v, i) => checkTouchpoints(`variants[${i}]`, req.channel, v, errs));
    return errs;
  }

  function validateOptimize(req) {
    const errs = [];
    if (req.channel && !CHANNEL_TOUCHPOINTS[req.channel]) errs.push({ field: 'channel', reason: `"${req.channel}" is not a Persado channel` });
    checkAccount(req.account, errs);
    checkTouchpoints('variant', req.channel, req.variant, errs);
    if (len(req.context) > LIMITS.MAX_CONTEXT_LENGTH) errs.push({ field: 'context', reason: `must be at most ${LIMITS.MAX_CONTEXT_LENGTH} characters` });
    const au = req.alwaysUse || [];
    if (au.length > LIMITS.MAX_ALWAYS_USE) errs.push({ field: 'alwaysUse', reason: `must hold at most ${LIMITS.MAX_ALWAYS_USE} terms` });
    au.forEach((t, i) => { const n = len(t); if (n < 1 || n > LIMITS.MAX_ALWAYS_USE_LENGTH) errs.push({ field: `alwaysUse[${i}]`, reason: `must be 1 to ${LIMITS.MAX_ALWAYS_USE_LENGTH} characters` }); });
    for (const [k, v] of Object.entries(req.characterLimits || {})) {
      if (!(v >= 1 && v <= LIMITS.MAX_TOUCHPOINT_LENGTH)) errs.push({ field: `characterLimits.${k}`, reason: `must be 1 to ${LIMITS.MAX_TOUCHPOINT_LENGTH}` });
    }
    return errs;
  }

  function invalid(errs) {
    return new PersadoError(KIND.INVALID_REQUEST,
      'The request is not valid: ' + errs.map(e => `${e.field} ${e.reason}`).join('; '), { details: errs });
  }

  // ── Request builders ───────────────────────────────────────────
  function account(o) {
    const a = { name: String(o.accountName || '').trim() };
    if (o.industry) a.industry = o.industry;
    if (o.language) a.language = o.language;
    if (o.country) a.country = o.country;
    return a;
  }
  function buildScoreRequest(o) {
    const req = { channel: o.channel, account: account(o), variants: o.variants };
    const errs = validateScore(req);
    if (errs.length) throw invalid(errs);
    return req;
  }
  function buildOptimizeRequest(o) {
    const req = { channel: o.channel, account: account(o), variant: o.variant };
    if (o.context) req.context = String(o.context).slice(0, LIMITS.MAX_CONTEXT_LENGTH);
    if (o.alwaysUse?.length) req.alwaysUse = o.alwaysUse.slice(0, LIMITS.MAX_ALWAYS_USE);
    if (o.characterLimits && Object.keys(o.characterLimits).length) req.characterLimits = o.characterLimits;
    const errs = validateOptimize(req);
    if (errs.length) throw invalid(errs);
    return req;
  }

  // ── Transport ──────────────────────────────────────────────────
  function classify(status, code, categories) {
    if (status === 401 || status === 403) return KIND.INVALID_KEY;
    if (status === 429 && code === 'quota_exhausted') return KIND.QUOTA;
    if (status === 429) return KIND.RATE_LIMITED;
    if (status === 503) return KIND.UNAVAILABLE;
    if (categories?.length) return KIND.PERSONAL_DATA;
    if (status >= 400 && status < 500) return KIND.INVALID_REQUEST;
    return KIND.SERVER;
  }

  async function readError(resp) {
    let body = null, text = '';
    try { text = await resp.text(); body = JSON.parse(text); } catch {}
    const e = (body && body.error) || {};
    const message = e.message || text.trim().slice(0, 300) || `HTTP ${resp.status}`;
    return new PersadoError(classify(resp.status, e.code, e.categories), message, {
      status: resp.status, code: e.code || null,
      requestId: e.requestId || resp.headers.get('X-Request-Id') || null,
      details: e.details || [], categories: e.categories || [],
      retryAfter: Number(resp.headers.get('Retry-After')) || e.retryAfterSeconds || null,
    });
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Headers that look like quota/usage reporting. The spec documents none, so we
  // do not depend on any — but if the server sends some, the UI shows them
  // verbatim as "reported by Persado" rather than inventing a balance.
  const USAGE_HEADER = /(quota|credit|usage|ratelimit|rate-limit|remaining)/i;
  function usageHeaders(resp) {
    const out = {};
    try { resp.headers.forEach((v, k) => { if (USAGE_HEADER.test(k)) out[k.toLowerCase()] = v; }); } catch {}
    return out;
  }

  /**
   * One API call with the CLI's retry policy: 429 rate_limited and 503 are resent
   * up to 3 times, honouring Retry-After (capped at 30 s), else 1/2/4 s.
   * Returns { status, body, requestId, usageHeaders }.
   */
  async function request(opts) {
    const { key, method = 'GET', path, query, body, fetchImpl = fetch,
      timeoutMs = REQUEST_TIMEOUT_MS, baseUrl = BASE_URL, noAuth = false, sleepImpl = sleep } = opts;
    if (!noAuth && !key) throw new PersadoError(KIND.NO_KEY, 'No Persado API key is saved. Add one in Settings.');
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const url = baseUrl.replace(/\/+$/, '') + path + qs;
    for (let attempt = 0; ; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let resp;
      try {
        const headers = { Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (!noAuth) headers.Authorization = 'Bearer ' + key;
        resp = await fetchImpl(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ac.signal });
      } catch (e) {
        if (e?.name === 'AbortError') throw new PersadoError(KIND.TIMEOUT, `Persado did not answer within ${Math.round(timeoutMs / 1000)} s.`);
        throw new PersadoError(KIND.UNREACHABLE, 'Cannot reach api.persado.com. Check the network connection.');
      } finally { clearTimeout(timer); }
      if (resp.ok) {
        let json = null;
        try { json = await resp.json(); } catch { throw new PersadoError(KIND.SERVER, `Persado returned an unreadable response to ${path}.`, { status: resp.status }); }
        return { status: resp.status, body: json, requestId: resp.headers.get('X-Request-Id') || null, usageHeaders: usageHeaders(resp) };
      }
      const err = await readError(resp);
      err.usageHeaders = usageHeaders(resp);
      const retryable = err.kind === KIND.RATE_LIMITED || err.kind === KIND.UNAVAILABLE;
      if (!retryable || attempt >= MAX_RETRIES) throw err;
      const delay = Math.min(err.retryAfter ? err.retryAfter * 1000 : (1 << attempt) * 1000, MAX_RETRY_DELAY_MS);
      await sleepImpl(delay);
    }
  }

  /**
   * Start a score/optimize job and wait for it: POST with wait=50, then poll
   * GET /v1/jobs/{id} every 2 s until completed or failed. onProgress receives
   * { phase: 'submitted'|'running'|'done', jobId }.
   */
  async function runJob(opts) {
    const { kind, body, onProgress = () => {}, jobTimeoutMs = JOB_TIMEOUT_MS, sleepImpl = sleep, now = Date.now } = opts;
    const started = now();
    const first = await request({ ...opts, method: 'POST', path: '/v1/' + kind, query: { wait: String(LIMITS.MAX_WAIT_SECONDS) }, body });
    let job = first.body;
    const requestId = first.requestId;
    let lastHeaders = first.usageHeaders;
    if (!job || !job.id) throw new PersadoError(KIND.SERVER, `Persado accepted the ${kind} request but returned no job id.`, { requestId });
    onProgress({ phase: 'submitted', jobId: job.id });
    while (job.status !== 'completed' && job.status !== 'failed') {
      if (now() - started > jobTimeoutMs) {
        throw new PersadoError(KIND.TIMEOUT, `The ${kind} job ${job.id} is still running after ${Math.round(jobTimeoutMs / 60000)} min.`, { jobId: job.id, requestId });
      }
      onProgress({ phase: 'running', jobId: job.id });
      await sleepImpl(POLL_MS);
      const r = await request({ ...opts, method: 'GET', path: '/v1/jobs/' + encodeURIComponent(job.id), body: undefined, query: undefined });
      job = r.body;
      if (Object.keys(r.usageHeaders || {}).length) lastHeaders = r.usageHeaders;
    }
    onProgress({ phase: 'done', jobId: job.id });
    if (job.status === 'failed') {
      const je = job.error || {};
      throw new PersadoError(je.categories?.length ? KIND.PERSONAL_DATA : KIND.JOB_FAILED,
        je.message || `The ${kind} job failed.`, { code: je.code || null, jobId: job.id, requestId, categories: je.categories || [] });
    }
    return { job, requestId, usageHeaders: lastHeaders };
  }

  // ── Response normalisation (models.go Result/Variant) ───────────
  function normVariant(v) {
    if (!v) return null;
    return {
      index: v.index ?? null,
      rank: v.rank ?? null,
      text: v.text || '',
      touchpoints: v.touchpoints || {},
      performance: typeof v.performance === 'number' ? v.performance : null,
      performanceBand: v.performanceBand ?? null,
      brandAlignment: typeof v.brandAlignment === 'number' ? v.brandAlignment : null,
      brandRationale: v.brandRationale ?? null,
      compliance: v.compliance ? {
        risk: v.compliance.risk || null, state: v.compliance.state || null,
        summary: v.compliance.summary ?? null,
        issues: (v.compliance.issues || []).map(i => ({ risk: i.risk ?? null, description: i.description ?? null, regulation: i.regulation ?? null })),
      } : null,
      emotions: v.emotions || [],
      descriptors: v.descriptors || [],
    };
  }

  function normalizeResult(job, meta = {}) {
    const r = job.result || {};
    const alternatives = (r.alternatives || []).map(normVariant)
      .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
    return {
      source: 'live',
      jobId: job.id,
      kind: job.kind || meta.kind || null,
      requestId: meta.requestId || null,
      complete: !!r.complete,
      channel: r.channel || null,
      complianceApplicable: !!r.complianceApplicable,
      variants: (r.variants || []).map(normVariant),
      control: normVariant(r.control),
      alternatives,
      notice: r.notice ? { code: r.notice.code, message: r.notice.message } : null,
    };
  }

  // ── Public operations ──────────────────────────────────────────
  async function score(o) {
    const body = buildScoreRequest(o);
    const { job, requestId, usageHeaders } = await runJob({ ...o, kind: 'score', body });
    return { result: normalizeResult(job, { kind: 'score', requestId }), usageHeaders };
  }

  async function optimize(o) {
    const body = buildOptimizeRequest(o);
    const { job, requestId, usageHeaders } = await runJob({ ...o, kind: 'optimize', body });
    return { result: normalizeResult(job, { kind: 'optimize', requestId }), usageHeaders };
  }

  /** Validates the key with a call that starts no run: GET /v1/catalogue. */
  async function testConnection(o) {
    const r = await request({ ...o, method: 'GET', path: '/v1/catalogue', timeoutMs: 15000 });
    const c = r.body || {};
    return {
      ok: true,
      channels: (c.channels || []).map(x => x.key),
      limits: c.limits || null,
      defaultChannel: c.defaultChannel || null,
      requestId: r.requestId,
      usageHeaders: r.usageHeaders,
    };
  }

  /** Plain-language message for a failure kind. */
  function describeError(e) {
    const k = e?.kind;
    if (k === KIND.NO_KEY) return 'No Persado API key is saved. Add one in Settings.';
    if (k === KIND.INVALID_KEY) return 'Persado rejected the API key. Check it in Settings.';
    if (k === KIND.QUOTA) return 'Persado reports this key has used its run quota. No further runs will succeed until it is raised.';
    if (k === KIND.RATE_LIMITED) return 'Persado is rate-limiting this key. Wait a moment and try again.';
    if (k === KIND.UNAVAILABLE) return 'Persado is temporarily unavailable. Try again shortly.';
    if (k === KIND.UNREACHABLE) return 'Cannot reach Persado. Check the network connection.';
    if (k === KIND.TIMEOUT) return e.message || 'Persado did not answer in time.';
    if (k === KIND.PERSONAL_DATA) return 'Persado refused the copy because it contains personal data' + (e.categories?.length ? ` (${e.categories.join(', ')})` : '') + '.';
    if (k === KIND.INVALID_REQUEST) return 'Persado could not accept the request: ' + (e.message || 'invalid input') + '.';
    if (k === KIND.JOB_FAILED) return 'The Persado run failed: ' + (e.message || 'no reason given') + '.';
    return e?.message || 'Persado returned an unexpected error.';
  }

  root.PERSADO_API = Object.freeze({
    BASE_URL, RUN_QUOTA, COSTS, COST_SOURCE, CHANNEL_TOUCHPOINTS, INDUSTRIES, LIMITS, KIND,
    PersadoError, buildScoreRequest, buildOptimizeRequest, validateScore, validateOptimize,
    request, runJob, normalizeResult, score, optimize, testConnection, describeError,
  });
})(typeof self !== 'undefined' ? self : globalThis);
