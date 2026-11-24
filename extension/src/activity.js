// ─── Persado Assist — activity log ────────────────────────────────────────
//
// Every Persado run and every platform write is recorded here: what was read,
// what Persado returned, what was written, and whether it verified. It is the
// audit trail the overlay's activity view and Settings read, and the metadata a
// future experiment loop needs to join platform results back to Persado runs.
//
// Fields are only ever filled from real identifiers: the platform's own ids
// (Mailchimp campaign id / web_id), Persado's job id and X-Request-Id. Nothing
// here invents an experiment id. `source` is 'live' for real Persado responses
// and 'demo' only for an explicitly labelled fixture.
//
// Bounded ring buffer in chrome.storage.local; credentials are never written.

(function (root) {
  const MAX_ENTRIES = 200;
  const MAX_TEXT = 4000;   // long body copy is truncated in the log, never in the write

  const clip = (s) => (s == null ? s : String(s).length > MAX_TEXT ? String(s).slice(0, MAX_TEXT) + '…' : String(s));

  function entry(e) {
    return {
      id: e.id || `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      at: e.at || Date.now(),
      platform: e.platform || 'web',                // 'web' | 'mailchimp' | future adapters
      action: e.action,                             // score | optimize | write | verify | revert | test_send | connect
      status: e.status,                             // ok | failed | skipped | no_change | partial
      source: e.source || 'live',
      campaignId: e.campaignId || null,
      campaignWebId: e.campaignWebId || null,
      campaignTitle: e.campaignTitle || null,
      pageUrl: e.pageUrl || null,
      changes: (e.changes || []).map(c => ({
        field: c.field, touchpoint: c.touchpoint || null,
        original: clip(c.original), optimized: clip(c.optimized),
        applied: c.applied !== false, reasons: c.reasons || [],
      })),
      persado: e.persado ? {
        jobId: e.persado.jobId || null, requestId: e.persado.requestId || null, kind: e.persado.kind || null,
        channel: e.persado.channel || null,
        controlPerformance: e.persado.controlPerformance ?? null,
        chosenPerformance: e.persado.chosenPerformance ?? null,
        chosenRank: e.persado.chosenRank ?? null,
        notice: e.persado.notice || null,
      } : null,
      message: clip(e.message || ''),
      error: e.error ? { kind: e.error.kind || null, message: clip(e.error.message || '') } : null,
    };
  }

  function makeLog({ storageKey, storage }) {
    let chain = Promise.resolve();
    const serial = (fn) => (chain = chain.then(fn, fn));
    async function all() { try { return (await storage.get(storageKey))[storageKey] || []; } catch { return []; } }
    return {
      add: (e) => serial(async () => {
        const list = await all();
        const x = entry(e);
        list.unshift(x);
        list.length = Math.min(list.length, MAX_ENTRIES);
        try { await storage.set({ [storageKey]: list }); } catch (err) { console.warn('[persado] activity save failed', err); }
        return x;
      }),
      list: (filter = {}) => serial(async () => (await all()).filter(x =>
        (!filter.platform || x.platform === filter.platform) &&
        (!filter.campaignId || x.campaignId === filter.campaignId)).slice(0, filter.limit || 50)),
      clear: () => serial(async () => { await storage.set({ [storageKey]: [] }); return []; }),
    };
  }

  root.PERSADO_ACTIVITY = Object.freeze({ entry, makeLog, MAX_ENTRIES });
})(typeof self !== 'undefined' ? self : globalThis);
