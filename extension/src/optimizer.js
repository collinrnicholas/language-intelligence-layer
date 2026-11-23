// ─── Persado Autopilot — platform-neutral optimizer ──────────────────────────
//
//   adapter.read()  →  eligible copy           (platform adapter)
//   PERSADO_API.optimize()  →  ranked rewrites  (Persado service — one run)
//   PERSADO_GUARD.validateRewrite()  →  safe?   (content safeguards)
//   adapter.write() → adapter.verify()          (platform adapter)
//
// The whole draft goes to Persado as ONE optimize run: each eligible field is a
// touchpoint of the adapter's channel (Mailchimp → EMAIL_SUBJECT_BODY:
// subject_line, preheader, headline, subheadline, body, cta). Only those field
// strings are sent — never the full HTML, never recipient data.
//
// Persado returns alternatives ranked best-first. The first alternative whose
// touchpoints pass validation is used; per field, a rewrite that fails a
// safeguard keeps the original. If nothing passes, nothing is written.
// No suggestion needs individual approval — the explicit "Optimize draft" action
// is the approval — but every change is logged and revertible.

(function (root) {
  const API = root.PERSADO_API;
  const G = root.PERSADO_GUARD;

  /** Which alternative to use, and which of its fields are safe. */
  function chooseRewrites(fields, result) {
    const alts = (result.alternatives || []).filter(a => a && a.touchpoints && Object.keys(a.touchpoints).length);
    let best = null;
    for (const alt of alts) {
      const changes = fields.map(f => {
        const proposed = alt.touchpoints[f.touchpoint];
        if (proposed == null) return { ...f, proposed: null, ok: false, reasons: ['Persado returned no rewrite for this field'] };
        const v = G.validateRewrite(f.text, proposed, { maxLength: f.maxLength });
        return { ...f, proposed, ok: v.ok, reasons: v.reasons };
      });
      const n = changes.filter(c => c.ok).length;
      if (!best || n > best.accepted) best = { alt, changes, accepted: n };
      if (n === fields.length) break;   // ranked best-first: take the first fully-safe one
    }
    return best;
  }

  /**
   * Optimize one draft end to end.
   *   deps: { adapter, persadoKey, account:{accountName, industry}, fetchImpl,
   *           onStep(step, detail), usage(ev), log(entry), snapshot(draft) }
   * Returns a summary { status, changes[], skipped[], persado, verify }.
   */
  async function optimizeDraft(ref, deps) {
    const { adapter, onStep = () => {}, usage = async () => {}, log = async () => {}, snapshot = async () => {} } = deps;
    const base = { platform: adapter.id, campaignId: ref.id || null };

    onStep('read', 'Reading campaign');
    const draft = await adapter.read(ref.id);
    Object.assign(base, { campaignId: draft.ref.id, campaignWebId: draft.ref.webId, campaignTitle: draft.ref.title });
    if (!draft.fields.length) {
      const why = draft.skipped.map(s => `${s.field}: ${s.reason}`).join('; ') || 'no copy found';
      await log({ ...base, action: 'optimize', status: 'skipped', message: 'Nothing eligible to optimize — ' + why });
      return { status: 'nothing_eligible', changes: [], skipped: draft.skipped, draft: draft.ref };
    }

    // Protected tokens travel as alwaysUse so Persado keeps them (≤10 terms).
    const alwaysUse = [...new Set(draft.fields.flatMap(f => G.protectedTokens(f.text)))]
      .filter(t => t.length <= API.LIMITS.MAX_ALWAYS_USE_LENGTH).slice(0, API.LIMITS.MAX_ALWAYS_USE);
    const variant = Object.fromEntries(draft.fields.map(f => [f.touchpoint, f.text]));
    const characterLimits = Object.fromEntries(draft.fields.map(f => [f.touchpoint, f.maxLength]));

    onStep('optimize', 'Optimizing with Persado');
    let out;
    try {
      out = await API.optimize({
        key: deps.persadoKey, fetchImpl: deps.fetchImpl,
        channel: adapter.channel, accountName: deps.account.accountName, industry: deps.account.industry || undefined,
        variant, alwaysUse, characterLimits,
        context: draft.ref.title ? `Campaign: ${draft.ref.title}` : undefined,
        onProgress: (p) => onStep('optimize', p.phase === 'running' ? 'Optimizing with Persado — running' : 'Optimizing with Persado'),
      });
    } catch (e) {
      // Accepted-then-failed jobs carry a jobId; they may have been charged.
      await usage({ type: 'run', op: 'optimize', ok: false, error: { kind: e.kind, message: e.message }, charged: !!e.jobId, cost: API.COSTS.optimize, usageHeaders: e.usageHeaders });
      await log({ ...base, action: 'optimize', status: 'failed', error: { kind: e.kind, message: API.describeError(e) }, persado: { jobId: e.jobId, requestId: e.requestId, kind: 'optimize', channel: adapter.channel } });
      throw e;
    }
    const result = out.result;
    await usage({ type: 'run', op: 'optimize', ok: true, cost: API.COSTS.optimize, usageHeaders: out.usageHeaders });
    const persado = { jobId: result.jobId, requestId: result.requestId, kind: 'optimize', channel: adapter.channel,
      controlPerformance: result.control?.performance ?? null, notice: result.notice };

    const choice = chooseRewrites(draft.fields, result);
    if (!choice || !choice.accepted) {
      const msg = result.notice?.message || (result.alternatives.length ? 'No rewrite passed the safeguards.' : 'Persado returned no alternatives that beat the original.');
      await log({ ...base, action: 'optimize', status: 'no_change', source: result.source, persado, message: msg,
        changes: (choice?.changes || draft.fields).map(c => ({ field: c.field, touchpoint: c.touchpoint, original: c.text, optimized: c.proposed ?? null, applied: false, reasons: c.reasons || [] })) });
      return { status: 'no_change', message: msg, changes: choice?.changes || [], skipped: draft.skipped, persado, draft: draft.ref, result };
    }
    persado.chosenPerformance = choice.alt.performance;
    persado.chosenRank = choice.alt.rank;
    const accepted = choice.changes.filter(c => c.ok).map(c => ({ ...c, original: c.text, text: c.proposed }));

    onStep('write', `Updating ${adapter.label} draft`);
    await snapshot(draft, accepted);
    try {
      await adapter.write(draft, accepted);
    } catch (e) {
      await log({ ...base, action: 'write', status: 'failed', source: result.source, persado, error: { kind: e.kind, message: e.message },
        changes: accepted.map(c => ({ field: c.field, touchpoint: c.touchpoint, original: c.original, optimized: c.proposed, applied: false })) });
      throw e;
    }

    onStep('verify', 'Verifying saved draft');
    const verify = await adapter.verify(draft, accepted);
    const changes = choice.changes.map(c => ({ field: c.field, touchpoint: c.touchpoint, original: c.text, optimized: c.proposed,
      applied: c.ok, reasons: c.reasons, saved: verify.results.find(r => r.field === c.field)?.saved ?? false }));
    const status = !verify.ok ? 'unverified' : accepted.length === draft.fields.length ? 'ok' : 'partial';
    await log({ ...base, action: 'optimize', status, source: result.source, persado, changes,
      message: verify.ok ? `${accepted.length} of ${draft.fields.length} fields optimized and verified in ${adapter.label}.`
        : `Written, but ${verify.results.filter(r => !r.saved).map(r => r.field).join(', ')} did not read back as written.` });
    onStep('done', verify.ok ? 'Optimization complete' : 'Written — verification failed');
    return { status, changes, skipped: draft.skipped, persado, verify, draft: draft.ref,
      alternative: { rank: choice.alt.rank, performance: choice.alt.performance, performanceBand: choice.alt.performanceBand, compliance: choice.alt.compliance },
      control: result.control };
  }

  root.PERSADO_OPTIMIZER = Object.freeze({ optimizeDraft, chooseRewrites });
})(typeof self !== 'undefined' ? self : globalThis);
