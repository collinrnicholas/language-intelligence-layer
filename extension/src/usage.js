// ─── Persado Autopilot — Persado usage ledger ────────────────────────────────
//
// What this extension has spent against the saved Persado key, persisted in
// chrome.storage.local so it survives restarts.
//
// HONESTY RULES (claude-design.md §7, and the brief):
//   • Persado's API documents NO balance or usage endpoint. Every "remaining"
//     figure here is a LOCAL ESTIMATE — runs this browser started, priced with the
//     developer portal's published costs — and is labelled `estimate: true`.
//   • Two things are authoritative and override the estimate:
//       - a 429 quota_exhausted from Persado  → balance is 0, per Persado
//       - quota/usage headers, if Persado ever sends any → shown verbatim
//   • The ledger is per key: saving a different key starts a fresh ledger. Only a
//     short SHA-256 fingerprint of the key is kept to detect that — never the key.
//   • Nothing here polls. Refresh re-reads storage and runs the free catalogue
//     call; it never spends a run.
//
// Pure functions (record/summarize) are separated from storage so node tests
// can drive them without chrome.*.

(function (root) {
  function fresh(fingerprint, quota, now = Date.now()) {
    return {
      v: 1, fingerprint: fingerprint || null, since: now, quota,
      requests: 0, scoreRuns: 0, optimizeRuns: 0, failedRequests: 0,
      estCreditsUsed: 0, lastSuccessAt: null, lastRequestAt: null,
      lastError: null, exhaustedAt: null, serverReported: null,
      connection: null,
    };
  }

  /**
   * Apply one event. kinds:
   *   { type: 'run', op: 'score'|'optimize', ok: true, cost, at, usageHeaders }
   *   { type: 'run', op, ok: false, error: {kind, message}, charged: bool, at }
   *   { type: 'connection', ok, message, at, usageHeaders }
   */
  function record(state, ev) {
    const s = { ...state };
    const at = ev.at || Date.now();
    if (ev.usageHeaders && Object.keys(ev.usageHeaders).length) s.serverReported = { at, headers: ev.usageHeaders };
    if (ev.type === 'connection') {
      s.connection = { ok: !!ev.ok, message: ev.message || '', at, kind: ev.kind || null };
      if (ev.ok) s.lastSuccessAt = at;
      if (ev.kind === 'quota_exhausted') s.exhaustedAt = at;
      return s;
    }
    if (ev.type !== 'run') return s;
    s.requests += 1;
    s.lastRequestAt = at;
    if (ev.ok) {
      if (ev.op === 'score') s.scoreRuns += 1;
      if (ev.op === 'optimize') s.optimizeRuns += 1;
      s.estCreditsUsed += ev.cost || 0;
      s.lastSuccessAt = at;
      s.connection = { ok: true, message: 'Last request succeeded', at, kind: null };
      // A success after an exhaustion means the quota was raised.
      if (s.exhaustedAt && s.exhaustedAt < at) s.exhaustedAt = null;
    } else {
      s.failedRequests += 1;
      s.lastError = { kind: ev.error?.kind || null, message: ev.error?.message || '', at };
      // A job that was accepted and then failed may still have been charged; the
      // spec does not say. Count it only when the caller says it was accepted.
      if (ev.charged) s.estCreditsUsed += ev.cost || 0;
      if (ev.error?.kind === 'quota_exhausted') s.exhaustedAt = at;
      if (ev.error?.kind === 'invalid_key') s.connection = { ok: false, message: 'Persado rejected the API key', at, kind: 'invalid_key' };
    }
    return s;
  }

  function summarize(s) {
    if (!s) return null;
    const exhausted = !!s.exhaustedAt;
    const remainingEst = Math.max(0, s.quota - s.estCreditsUsed);
    return {
      quota: s.quota,
      used: s.estCreditsUsed,
      remaining: exhausted ? 0 : remainingEst,
      // The figure is authoritative ONLY when Persado itself said it is exhausted.
      estimate: !exhausted,
      exhausted,
      exhaustedAt: s.exhaustedAt,
      requests: s.requests,
      scoreRuns: s.scoreRuns,
      optimizeRuns: s.optimizeRuns,
      failedRequests: s.failedRequests,
      lastSuccessAt: s.lastSuccessAt,
      lastRequestAt: s.lastRequestAt,
      lastError: s.lastError,
      since: s.since,
      serverReported: s.serverReported,
      connection: s.connection,
      fraction: s.quota ? Math.min(1, (exhausted ? s.quota : s.estCreditsUsed) / s.quota) : 0,
    };
  }

  /** First 12 hex of SHA-256(key). Identifies a key change without storing it. */
  async function fingerprint(key) {
    if (!key) return null;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return [...new Uint8Array(buf)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ── chrome.storage glue (service worker only) ───────────────────
  function makeStore({ storageKey, quota, storage }) {
    let chain = Promise.resolve();
    // Serialise read-modify-write so concurrent runs cannot lose an increment.
    const serial = (fn) => (chain = chain.then(fn, fn));
    async function load() {
      try { return (await storage.get(storageKey))[storageKey] || null; } catch { return null; }
    }
    async function save(s) { try { await storage.set({ [storageKey]: s }); } catch (e) { console.warn('[persado] usage save failed', e); } }
    async function forKey(fp) {
      const s = await load();
      if (s && s.fingerprint === fp) return s;
      const n = fresh(fp, quota);
      await save(n);
      return n;
    }
    return {
      get: (fp) => serial(async () => summarize(await forKey(fp))),
      record: (fp, ev) => serial(async () => { const s = record(await forKey(fp), ev); await save(s); return summarize(s); }),
      reset: (fp) => serial(async () => { const n = fresh(fp, quota); await save(n); return summarize(n); }),
    };
  }

  root.PERSADO_USAGE = Object.freeze({ fresh, record, summarize, fingerprint, makeStore });
})(typeof self !== 'undefined' ? self : globalThis);
