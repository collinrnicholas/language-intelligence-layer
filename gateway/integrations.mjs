// Local, authenticated integration service. Reuses the existing provider clients.
// Only environment credentials enter these clients; no credential is returned.
import vm from 'node:vm';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const ctx = vm.createContext({ URL, URLSearchParams, AbortController, TextEncoder, crypto: globalThis.crypto,
  fetch, btoa, setTimeout, clearTimeout, console });
for (const file of ['guard.js', 'persado-api.js', 'usage.js', 'adapters/mailchimp.js']) {
  vm.runInContext(readFileSync(new URL('../extension/src/' + file, import.meta.url), 'utf8'), ctx);
}
const API = ctx.PERSADO_API, G = ctx.PERSADO_GUARD, MC = ctx.PERSADO_ADAPTERS.mailchimp, U = ctx.PERSADO_USAGE;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (kind, message) => { throw Object.assign(new Error(message), { kind }); };

export function createIntegrations({ env = process.env, fetchImpl = fetch,
  statePath = new URL('./.integration-state.json', import.meta.url) } = {}) {
  const pkey = env.PERSADO_API_KEY || '', mkey = env.MAILCHIMP_API_KEY || '';
  const identity = hash([pkey, mkey, env.MAILCHIMP_SERVER_PREFIX]);
  let state = { identity, cache: {}, undo: {}, usage: U.fresh(hash(pkey), API.RUN_QUOTA) };
  try { const saved = JSON.parse(readFileSync(statePath, 'utf8')); if (saved.identity === identity) state = saved; }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('Integration state is unreadable; recover it before making paid requests.'); }
  const save = () => {
    const path = statePath instanceof URL ? statePath.pathname : statePath;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path + '.tmp', JSON.stringify(state), { mode: 0o600 });
    renameSync(path + '.tmp', path);
  };
  const busy = new Set(), inflight = new Map();
  let mcConnection = null;
  const adapter = () => MC.create({ apiKey: mkey, serverPrefix: env.MAILCHIMP_SERVER_PREFIX, fetchImpl });
  const usage = () => ({ hasKey: !!pkey, ...U.summarize(state.usage), costs: API.COSTS, costSource: API.COST_SOURCE });
  const record = ev => { state.usage = U.record(state.usage, { at: Date.now(), ...ev }); save(); };
  const account = msg => ({ accountName: String(msg.settings?.brand || msg.brand || mcConnection?.accountName || '').trim(),
    industry: msg.settings?.industry || undefined });
  const runKey = (op, field, acct, scope) => hash([identity, op, scope, field.touchpoint, field.text, field.maxLength || null, acct]);

  async function paid(op, field, acct, scope) {
    if (!pkey) fail('no_key', 'Set PERSADO_API_KEY in the gateway environment, then restart the gateway.');
    if (!acct.accountName) fail('invalid_request', 'Add your brand name in Settings.');
    const key = runKey(op, field, acct, scope);
    if (inflight.has(key)) return inflight.get(key);
    const cached = state.cache[key];
    if (cached?.result) return { ...cached, cached: true };
    if (cached?.pending) fail('pending', 'This request may already have been charged. Check the Persado job before retrying; no duplicate was submitted.');
    // Quota is never inferred to be exhausted from our local estimate.
    if (usage().exhausted) fail('quota_exhausted', 'Persado reported insufficient credits. Raise the account quota before continuing.');
    const task = (async () => {
      state.cache[key] = { pending: true, at: Date.now() }; save();
      const common = { key: pkey, ...acct, channel: scope === 'web' ? 'WEB_PAGE' : 'EMAIL_SUBJECT_BODY', fetchImpl,
        // Save the job id immediately. A crash or lost response cannot silently resubmit a paid run.
        onProgress: ev => { if (ev.jobId) { state.cache[key].jobId = ev.jobId; save(); } } };
      try {
        const out = op === 'score'
          ? await API.score({ ...common, variants: [{ [field.touchpoint]: field.text }] })
          : await API.optimize({ ...common, variant: { [field.touchpoint]: field.text },
              alwaysUse: G.protectedTokens(field.text).filter(t => t.length <= API.LIMITS.MAX_ALWAYS_USE_LENGTH).slice(0, API.LIMITS.MAX_ALWAYS_USE),
              characterLimits: field.maxLength ? { [field.touchpoint]: field.maxLength } : undefined });
        state.cache[key] = { result: out.result, cached: false, at: Date.now(), field: field.field,
          original: field.text, touchpoint: field.touchpoint, maxLength: field.maxLength || null, scope };
        record({ type: 'run', op, ok: true, cost: API.COSTS[op], usageHeaders: out.usageHeaders });
        return { ...state.cache[key], cacheId: key };
      } catch (e) {
        // Explicit rejections are safe to retry. Transport errors and accepted jobs are not.
        const uncertain = !!state.cache[key]?.jobId || ['timeout', 'unreachable', 'server_error'].includes(e.kind);
        if (!uncertain) delete state.cache[key];
        record({ type: 'run', op, ok: false, charged: uncertain, cost: API.COSTS[op],
          error: { kind: e.kind, message: API.describeError(e) }, usageHeaders: e.usageHeaders });
        throw e;
      }
    })();
    inflight.set(key, task);
    try { return await task; } finally { inflight.delete(key); }
  }

  async function campaign(msg) {
    const a = adapter();
    let id = msg.campaignId;
    if (msg.webId) {
      const match = await a.findByWebId(msg.webId);
      if (!match || (id && id !== match.id)) fail('not_found', 'The URL does not match a draft in the connected account. Select a draft explicitly.');
      id = match.id;
    }
    if (!id) fail('selection_required', 'Open a campaign draft or select one explicitly.');
    const draft = await a.read(id);
    // All builder types may be read. Body apply is deliberately unavailable.
    const fields = draft.fields.filter(f => f.location === 'settings');
    for (const block of G.htmlBlocks(draft.html)) {
      const touchpoint = block.cta ? 'cta' : block.kind;
      if (['headline', 'subheadline', 'body', 'cta'].includes(touchpoint) && G.eligible(block.text, touchpoint).ok) {
        fields.push({ field: 'body:' + block.id, touchpoint, text: block.text, location: 'html',
          maxLength: Math.max(60, Math.ceil(block.text.length * 1.5)), applyDisabledReason: 'Body Apply is unavailable to preserve Mailchimp HTML, links, merge tags, and disclosures.' });
      }
    }
    draft.fields = fields;
    return { a, draft, id };
  }

  function view(draft, msg) {
    const acct = account(msg);
    return { id: draft.ref.id, webId: draft.ref.webId, title: draft.ref.title,
      subject: draft.settings.subject_line, previewText: draft.settings.preview_text,
      fingerprint: draft.fingerprint, contentType: draft.contentType,
      fields: draft.fields.map(f => {
        const score = state.cache[runKey('score', f, acct, 'mailchimp')];
        const key = runKey('optimize', f, acct, 'mailchimp');
        return { ...f, score: score?.result || null,
          optimization: state.cache[key]?.result ? { ...state.cache[key], cacheId: key } : null };
      }), canRevert: Object.values(state.undo).some(u => u.id === draft.ref.id && !u.reverted) };
  }

  async function locked(id, fn) {
    if (busy.has(id)) fail('busy', 'An update is already in progress for this draft.');
    busy.add(id);
    try { return await fn(); } finally { busy.delete(id); }
  }

  async function apply(msg, undo = false) {
    if (!msg.campaignId) fail('selection_required', 'Select a draft first.');
    return locked(msg.campaignId, async () => {
      const { a, draft, id } = await campaign(msg);
      let field, original, text, receipt;
      if (undo) {
        receipt = state.undo[msg.undoId];
        if (!receipt || receipt.id !== id || receipt.reverted) fail('no_undo', 'No original value is available to undo.');
        field = receipt.field; original = receipt.text; text = receipt.original;
      } else {
        const c = state.cache[msg.cacheId];
        if (!c?.result || c.result.kind !== 'optimize' || c.scope !== 'mailchimp') fail('invalid_result', 'Optimize this field before applying it.');
        field = c.field; original = c.original;
        if (field !== 'subject_line' && field !== 'preview_text') fail('body_read_only', 'Body Apply is disabled to preserve the email structure.');
        // Bind the result to this exact campaign, even when identical copy was cached elsewhere.
        if (!state.cache[msg.cacheId].campaignIds?.includes(id)) fail('wrong_campaign', 'This alternative was not reviewed for the selected campaign.');
        const alternative = c.result.alternatives[msg.alternativeIndex ?? 0];
        text = alternative?.touchpoints?.[c.touchpoint] || alternative?.text;
        const check = G.validateRewrite(original, text, { maxLength: c.maxLength });
        if (!check.ok) fail('unsafe_rewrite', check.reasons.join('; '));
        const existing = Object.entries(state.undo).find(([, u]) => u.id === id && u.cacheId === msg.cacheId && u.text === text && !u.reverted);
        if (existing && draft.settings[field] === text) return { ok: true, verified: true, duplicate: true, undoId: existing[0], campaign: view(draft, msg) };
      }
      if (draft.settings[field] !== original) fail('changed', 'This field changed in Mailchimp. Refresh and review the current copy before applying or undoing.');
      const undoId = undo ? msg.undoId : randomUUID();
      if (!undo) { state.undo[undoId] = { id, field, original, text, cacheId: msg.cacheId, at: Date.now(), pending: true }; save(); }
      const verification = await a.updateSetting(id, field, original, text);
      if (!verification.ok) fail('unverified', 'Mailchimp accepted the update, but read-back did not match. Refresh the draft before retrying. The original value is retained for undo.');
      if (undo) receipt.reverted = true;
      else state.undo[undoId].pending = false;
      save();
      const refreshed = await campaign(msg);
      return { ok: true, verified: true, undoId, campaign: view(refreshed.draft, msg) };
    });
  }

  async function dispatch(msg) {
    try {
      switch (msg.type) {
        case 'USAGE_GET': return usage();
        case 'USAGE_RESET': fail('unsupported', 'Usage is persisted by the gateway. Clearing it could hide paid requests.'); break;
        case 'PERSADO_TEST': {
          try {
            const r = await API.testConnection({ key: pkey, fetchImpl });
            record({ type: 'connection', ok: true, message: 'Connected', usageHeaders: r.usageHeaders });
            return { ...r, usage: usage() };
          } catch (e) { record({ type: 'connection', ok: false, kind: e.kind, message: API.describeError(e) }); throw e; }
        }
        case 'PERSADO_SCORE': case 'PERSADO_OPTIMIZE': {
          const op = msg.type === 'PERSADO_SCORE' ? 'score' : 'optimize';
          if (typeof msg.text !== 'string' || msg.text.length > 20000) fail('invalid_request', 'Choose a text block of at most 20,000 characters.');
          const out = await paid(op, { field: msg.kind, text: msg.text, touchpoint: ({ cta: 'cta', body: 'body', headline: 'headline' })[msg.kind] || 'headline' }, account(msg), 'web');
          return { ok: true, ...out, usage: usage() };
        }
        case 'MC_TEST': mcConnection = await adapter().test(); return { ...mcConnection, connected: true };
        case 'MC_DISCONNECT': mcConnection = null; return { ok: true };
        case 'MC_DRAFTS': return { ok: true, drafts: await adapter().listDrafts(100) };
        case 'MC_STATUS': {
          if (!mkey) return { ok: true, connected: false, persadoKey: !!pkey, usage: usage() };
          if (!mcConnection) mcConnection = await adapter().test();
          const out = { ok: true, connected: true, accountName: mcConnection.accountName, dc: mcConnection.dc, persadoKey: !!pkey, usage: usage() };
          if (msg.webId || msg.campaignId) { const { draft } = await campaign(msg); out.campaign = view(draft, msg);
            out.undo = Object.entries(state.undo).filter(([, u]) => u.id === draft.ref.id && !u.reverted).map(([undoId, u]) => ({ undoId, field: u.field, pending: u.pending })); }
          return out;
        }
        case 'MC_SCORE': case 'MC_OPTIMIZE': {
          const { draft, id } = await campaign(msg);
          const field = draft.fields.find(f => f.field === msg.field);
          if (!field) fail('not_eligible', 'Choose an eligible copy block. Refresh if the draft changed.');
          if (msg.text !== field.text) fail('changed', 'The draft copy changed. Refresh before spending credits.');
          const acct = account(msg), op = msg.type === 'MC_SCORE' ? 'score' : 'optimize';
          if (op === 'optimize' && field.field === 'subject_line' && !state.cache[runKey('score', field, acct, 'mailchimp')]?.result)
            fail('score_required', 'Score this subject line before optimizing it.');
          const out = await paid(op, field, acct, 'mailchimp');
          const key = runKey(op, field, acct, 'mailchimp');
          state.cache[key].campaignIds = [...new Set([...(state.cache[key].campaignIds || []), id])]; save();
          return { ok: true, ...out, cacheId: key, usage: usage() };
        }
        case 'MC_APPLY': return await apply(msg);
        case 'MC_REVERT': return await apply(msg, true);
        default: fail('unsupported', 'This operation is unavailable. Sending emails is outside this prototype.');
      }
    } catch (e) {
      let error = API.describeError(e);
      // Provider errors can echo submitted values; defensively redact configured credentials.
      for (const secret of [pkey, mkey]) if (secret) error = error.split(secret).join('[redacted]');
      return { ok: false, kind: e.kind || 'error', error, jobId: e.jobId || null, usage: usage() };
    }
  }
  return { dispatch };
}

// Separate transport gate, also exercised by real HTTP tests.
export async function handleIntegrationRequest(req, res, service, env = process.env) {
  const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '')) return send(403, { ok: false, error: 'Loopback host required.' });
  if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress)) return send(403, { ok: false, error: 'Loopback connection required.' });
  const origin = req.headers.origin;
  const ids = String(env.PERSADO_EXTENSION_IDS || '').split(',').filter(Boolean);
  if (origin && (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || (ids.length && !ids.includes(origin.slice(19)))))
    return send(403, { ok: false, error: 'Origin rejected.' });
  const token = String(env.PERSADO_PROXY_TOKEN || ''), supplied = String(req.headers['x-persado-token'] || '');
  if (token.length < 32 || Buffer.byteLength(token) !== Buffer.byteLength(supplied) || !timingSafeEqual(Buffer.from(token), Buffer.from(supplied)))
    return send(401, { ok: false, error: 'Pair the extension with the gateway token in Settings. Provider keys belong in the gateway environment.' });
  if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) return send(415, { ok: false, error: 'JSON POST required.' });
  try {
    let bytes = 0, chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 100000) return send(413, { ok: false, error: 'Request too large.' }); chunks.push(chunk); }
    const msg = JSON.parse(Buffer.concat(chunks).toString());
    if (!msg || typeof msg.type !== 'string') return send(400, { ok: false, error: 'An operation is required.' });
    return send(200, await service.dispatch(msg));
  } catch { return send(400, { ok: false, error: 'Invalid integration request.' }); }
}
