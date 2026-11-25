// Local, authenticated integration service. Reuses the existing provider clients.
// Only environment credentials enter these clients; no credential is returned.
import vm from 'node:vm';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {createCampaignIntelligence,impact} from './campaign-intelligence.mjs';

const ctx = vm.createContext({ URL, URLSearchParams, AbortController, TextEncoder, crypto: globalThis.crypto,
  fetch, btoa, setTimeout, clearTimeout, console });
for (const file of ['guard.js', 'persado-api.js', 'usage.js', 'adapters/mailchimp.js']) {
  vm.runInContext(readFileSync(new URL('../extension/src/' + file, import.meta.url), 'utf8'), ctx);
}
const API = ctx.PERSADO_API, G = ctx.PERSADO_GUARD, MC = ctx.PERSADO_ADAPTERS.mailchimp, U = ctx.PERSADO_USAGE;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (kind, message) => { throw Object.assign(new Error(message), { kind }); };

export function createIntegrations({ env = process.env, fetchImpl = fetch,
  statePath = new URL('./.integration-state.json', import.meta.url),
  // How long one browser request may wait for a run before getting a job to poll.
  // Kept well under the ~30 s an MV3 service worker may wait on a fetch.
  responseBudgetMs = 8000, statusTimeoutMs = 10000, staleAfterMs = 15 * 60000 } = {}) {
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
  const reporting=createCampaignIntelligence({adapter});
  state.outcomes ||= [];
  function recordOutcome(entry){
    state.outcomes.push({id:randomUUID(),campaignId:entry.campaignId,field:entry.field,original:entry.original,optimized:null,
      persadoJobId:null,persadoVariantId:null,variantIndex:null,scoredAt:null,optimizedAt:null,appliedAt:null,undoneAt:null,
      experimentalAssignment:null,postSendMetrics:null,verifiedIncrementalOutcome:null,...entry});
    save();
  }
  const usage = () => ({ hasKey: !!pkey, ...U.summarize(state.usage), costs: API.COSTS, costSource: API.COST_SOURCE });
  const record = ev => { state.usage = U.record(state.usage, { at: Date.now(), ...ev }); save(); };
  const account = msg => ({ accountName: String(msg.settings?.brand || msg.brand || mcConnection?.accountName || '').trim(),
    industry: msg.settings?.industry || undefined });
  const runKey = (op, field, acct, scope) => hash([identity, op, scope, field.touchpoint, field.text, field.maxLength || null, acct]);

  // ── Paid runs: a recoverable job lifecycle ─────────────────────
  //
  // A Persado optimize can take minutes. The browser must never hold one long
  // request open (an MV3 service worker can be stopped while it waits), so a
  // paid call answers within `responseBudgetMs`: either the finished result, or
  // { status: 'running', cacheId } and the panel polls JOB_STATUS with short calls.
  //
  // Cache entry states (state.cache[key], persisted):
  //   { result }                      finished — reused, never re-bought
  //   { pending, jobId? }             submitted; jobId saved the moment Persado accepts
  //   { failed: { kind, message } }   explicitly rejected — safe to retry, nothing charged
  // A pending entry is NEVER resubmitted automatically. Without a job id (or when
  // Persado no longer knows the job) the outcome is "unknown": the user may retry,
  // but only with an explicit confirmation that a duplicate charge is possible.
  const RUNNING = Symbol('running');
  const statusInflight = new Map();
  const withinBudget = (task, ms) => Promise.race([task,
    new Promise(r => { const t = setTimeout(() => r(RUNNING), ms); t.unref?.(); })]);
  const runMeta = (op, field, acct, scope) => ({ op, scope, acct, field: field.field, touchpoint: field.touchpoint,
    original: field.text, maxLength: field.maxLength || null });
  function running(key) {
    const c = state.cache[key] || {};
    return { status: 'running', cacheId: key, jobId: c.jobId || null, startedAt: c.at || null, cached: false };
  }
  function adopt(key, result, { usageHeaders } = {}) {
    const prev = state.cache[key] || {};
    state.cache[key] = { result, cached: false, at: Date.now(), field: prev.field, original: prev.original,
      touchpoint: prev.touchpoint, maxLength: prev.maxLength || null, scope: prev.scope, op: prev.op, acct: prev.acct,
      ...(prev.campaignIds ? { campaignIds: prev.campaignIds } : {}) };
    record({ type: 'run', op: prev.op, ok: true, cost: API.COSTS[prev.op], usageHeaders });
    save();
    return { ...state.cache[key], status: 'done', cacheId: key };
  }

  async function paid(op, field, acct, scope, { onResult } = {}) {
    if (!pkey) fail('no_key', 'Set PERSADO_API_KEY in the gateway environment, then restart the gateway.');
    if (!acct.accountName) fail('invalid_request', 'Add your brand name in Settings.');
    const key = runKey(op, field, acct, scope);
    if (inflight.has(key)) return settle(inflight.get(key), key);
    const cached = state.cache[key];
    if (cached?.result) return { ...cached, status: 'done', cached: true, cacheId: key };
    // Never resubmit a run that may already be charged: report its status instead.
    if (cached?.pending) return jobStatus(key);
    // Quota is never inferred to be exhausted from our local estimate.
    if (usage().exhausted) fail('quota_exhausted', 'Persado reported insufficient credits. Raise the account quota before continuing.');
    const task = (async () => {
      state.cache[key] = { pending: true, at: Date.now(), ...runMeta(op, field, acct, scope),
        ...(cached?.campaignIds ? { campaignIds: cached.campaignIds } : {}) };
      save();
      const common = { key: pkey, ...acct, channel: scope === 'web' ? 'WEB_PAGE' : 'EMAIL_SUBJECT_BODY', fetchImpl, waitSeconds: 5,
        // Save the job id immediately. A crash or lost response cannot silently resubmit a paid run.
        onProgress: ev => { if (ev.jobId && state.cache[key]?.pending && state.cache[key].jobId !== ev.jobId) { state.cache[key].jobId = ev.jobId; save(); } } };
      try {
        const out = op === 'score'
          ? await API.score({ ...common, variants: [{ [field.touchpoint]: field.text }] })
          : await API.optimize({ ...common, variant: { [field.touchpoint]: field.text },
              alwaysUse: G.protectedTokens(field.text).filter(t => t.length <= API.LIMITS.MAX_ALWAYS_USE_LENGTH).slice(0, API.LIMITS.MAX_ALWAYS_USE),
              characterLimits: field.maxLength ? { [field.touchpoint]: field.maxLength } : undefined });
        const done = adopt(key, out.result, out);
        try { onResult?.(done); } catch {}
        return done;
      } catch (e) {
        // Explicit rejections are safe to retry. Transport errors and accepted jobs are not:
        // they stay pending (with the job id when we have one) for JOB_STATUS to resolve.
        const uncertain = !!state.cache[key]?.jobId || ['timeout', 'unreachable', 'server_error'].includes(e.kind);
        if (!uncertain) state.cache[key] = { failed: { kind: e.kind || 'error', message: API.describeError(e) }, at: Date.now(), ...runMeta(op, field, acct, scope) };
        record({ type: 'run', op, ok: false, charged: uncertain, cost: API.COSTS[op],
          error: { kind: e.kind, message: API.describeError(e) }, usageHeaders: e.usageHeaders });
        throw e;
      }
    })();
    inflight.set(key, task);
    task.then(() => inflight.delete(key), () => inflight.delete(key));
    return settle(task, key);
  }

  /** Wait briefly for a run; past the budget, hand the browser a job to poll. */
  async function settle(task, key) {
    let out;
    try { out = await withinBudget(task, responseBudgetMs); }
    catch (e) {
      // A run that failed in a way that may have charged stays pending: say so, never throw it away.
      if (state.cache[key]?.pending) return jobStatus(key);
      throw e;
    }
    return out === RUNNING ? running(key) : out;
  }

  /**
   * Short, free status check. Adopts a finished job by id (GET /v1/jobs/{id}),
   * which is how a run survives a gateway restart, a closed panel or a browser restart.
   */
  async function jobStatus(key) {
    const c = state.cache[key];
    if (!c) return { status: 'not_found', cacheId: key, retry: 'safe', message: 'No run is recorded for this copy. Check or optimize again.' };
    if (c.result) return { ...c, status: 'done', cached: true, cacheId: key };
    if (c.failed) return { status: 'failed', cacheId: key, retry: 'safe', error: c.failed.message, kind: c.failed.kind };
    if (inflight.has(key)) return running(key);
    if (!c.jobId) return { status: 'unknown', cacheId: key, retry: 'confirm', startedAt: c.at,
      message: 'Persado may have received this request, but no job id came back. Retrying could be charged again.' };
    if (statusInflight.has(key)) return statusInflight.get(key);
    const check = (async () => {
      try {
        const r = await API.request({ key: pkey, method: 'GET', path: '/v1/jobs/' + encodeURIComponent(c.jobId), fetchImpl, timeoutMs: statusTimeoutMs, sleepImpl: async () => {} });
        const job = r.body || {};
        if (job.status === 'completed' && job.result) return adopt(key, API.normalizeResult(job, { kind: c.op, requestId: r.requestId }), r);
        if (job.status === 'failed') {
          const message = API.describeError(new API.PersadoError(API.KIND.JOB_FAILED, job.error?.message || 'The run failed.'));
          state.cache[key] = { failed: { kind: 'job_failed', message }, at: Date.now(), field: c.field, original: c.original,
            touchpoint: c.touchpoint, maxLength: c.maxLength, scope: c.scope, op: c.op, acct: c.acct };
          save();
          return { status: 'failed', cacheId: key, retry: 'safe', error: message, kind: 'job_failed' };
        }
        return { ...running(key), stale: Date.now() - (c.at || 0) > staleAfterMs };
      } catch (e) {
        if (e.status === 404 || e.kind === 'not_found') return { status: 'unknown', cacheId: key, retry: 'confirm', jobId: c.jobId,
          message: 'Persado no longer has this job, so its result cannot be retrieved. Retrying could be charged again.' };
        // Could not ask right now: still pending, check again later.
        return { ...running(key), checkFailed: true, error: API.describeError(e) };
      }
    })();
    statusInflight.set(key, check);
    try { return await check; } finally { statusInflight.delete(key); }
  }

  /** User-initiated retry. Uncertain runs require explicit confirmation. */
  async function retryJob(msg) {
    const key = msg.cacheId, c = state.cache[key];
    if (!c) fail('not_found', 'Nothing to retry for this copy.');
    if (c.result) return { ...c, status: 'done', cached: true, cacheId: key };
    if (inflight.has(key)) return running(key);
    if (c.pending) {
      const st = await jobStatus(key);
      if (st.status !== 'unknown') return st;   // finished, failed, or still running: no resubmit
      if (msg.confirmUncertain !== true) fail('confirm_required', st.message);
    }
    if (!c.op || !c.acct) fail('not_found', 'This run is from an older gateway version. Check or optimize the copy again.');
    delete state.cache[key]; save();
    return paid(c.op, { field: c.field, touchpoint: c.touchpoint, text: c.original, maxLength: c.maxLength }, c.acct, c.scope);
  }

  async function campaign(msg) {
    const a = adapter();
    let id = msg.campaignId;
    if (msg.webId && !id) {
      const match = await a.findByWebId(msg.webId);
      if (!match || (id && id !== match.id)) fail('not_found', 'The URL does not match a draft in the connected account. Select a draft explicitly.');
      id = match.id;
    }
    if (!id) fail('selection_required', 'Open a campaign draft or select one explicitly.');
    const draft = await a.read(id);
    if (msg.webId && Number(draft.ref.webId) !== Number(msg.webId))
      fail('not_found', 'The URL does not match the selected draft. Refresh before continuing.');
    // All builder types may be read. Body apply is deliberately unavailable.
    const fields = draft.fields.filter(f => f.location === 'settings');
    for (const block of G.htmlBlocks(draft.html)) {
      const touchpoint = block.cta ? 'cta' : block.kind;
      if (['headline', 'subheadline', 'body', 'cta'].includes(touchpoint) && G.eligible(block.text, touchpoint).ok) {
        const templateLabels = ['explore templates', 'manage contacts', 'upload to brand kit'];
        let templateDefault = false;
        try { templateDefault = touchpoint === 'cta' && templateLabels.includes(block.text.toLowerCase())
          && /(^|\.)mailchimp\.com$/i.test(new URL(block.href).hostname); } catch {}
        fields.push({ field: 'body:' + block.id, touchpoint, text: block.text, location: 'html', templateDefault,
          maxLength: Math.max(60, Math.ceil(block.text.length * 1.5)), applyDisabledReason: 'Body Apply is unavailable to preserve Mailchimp HTML, links, merge tags, and disclosures.' });
      }
    }
    draft.fields = fields;
    return { a, draft, id };
  }

  function scoreForField(f,acct,id) {
    let score = state.cache[runKey('score', f, acct, 'mailchimp')];
    if (!score?.result) {
      // A previously applied alternative already has a real prediction.
      // Reuse it only for this campaign/account/touchpoint and exact text;
      // this is not a new Score request or an inferred revised score.
      for (const [cacheId,cached] of Object.entries(state.cache)) {
        if (cached.scope!=='mailchimp'||!cached.campaignIds?.includes(id)||cached.touchpoint!==f.touchpoint||cached.result?.kind!=='optimize') continue;
        if (cacheId!==runKey('optimize',{...f,text:cached.original},acct,'mailchimp')) continue;
        const variant=cached.original===f.text&&typeof cached.result.control?.performance==='number'?cached.result.control:cached.result.alternatives.find(v=>(v.touchpoints?.[f.touchpoint]||v.text)===f.text&&typeof v.performance==='number');
        if (variant) { score={result:{source:'live',kind:'optimize',jobId:cached.result.jobId,variants:[variant]}};break; }
      }
    }
    return score?.result||null;
  }

  async function enrichExistingJobs(id){
    const entries=Object.values(state.cache).filter(c=>c.scope==='mailchimp'&&c.campaignIds?.includes(id)&&c.result?.jobId&&c.result.schemaVersion!==2&&!c.enrichmentAttempted);
    let updated=false;
    await Promise.all(entries.map(async c=>{
      c.enrichmentAttempted=true;
      try{
        const r=await API.request({key:pkey,method:'GET',path:'/v1/jobs/'+encodeURIComponent(c.result.jobId),fetchImpl});
        if(r.body?.status==='completed'&&r.body.result){c.result=API.normalizeResult(r.body,{kind:c.result.kind});updated=true;}
      }catch{} // Expired/unavailable jobs keep their original known result.
    }));
    if(entries.length)save();return updated;
  }

  function view(draft, msg) {
    const acct = account(msg);
    return { id: draft.ref.id, webId: draft.ref.webId, title: draft.ref.title,
      subject: draft.settings.subject_line, previewText: draft.settings.preview_text,
      fingerprint: draft.fingerprint, contentType: draft.contentType,
      status:draft.campaignMetadata?.status||'save',reach:impact.reach(draft.campaignMetadata||{}),
      fields: draft.fields.map(f => {
        const score=scoreForField(f,acct,draft.ref.id);
        const key = runKey('optimize', f, acct, 'mailchimp'), scoreKey = runKey('score', f, acct, 'mailchimp');
        // An unfinished run shows on its field so a reopened panel can resume it.
        const job = [['optimize', key], ['score', scoreKey]].map(([op, k]) => {
          const c = state.cache[k];
          if (c?.pending) return { op, cacheId: k, status: inflight.has(k) ? 'running' : c.jobId ? 'running' : 'unknown', startedAt: c.at };
          if (c?.failed) return { op, cacheId: k, status: 'failed', error: c.failed.message };
          return null;
        }).find(Boolean) || null;
        return { ...f, score, job,
          optimization: state.cache[key]?.result ? { ...state.cache[key], cacheId: key } : null };
      }), canRevert: Object.values(state.undo).some(u => u.id === draft.ref.id && !u.reverted) };
  }

  async function locked(id, fn) {
    if (busy.has(id)) fail('busy', 'An update is already in progress for this draft.');
    busy.add(id);
    try { return await fn(); } finally { busy.delete(id); }
  }

  function undoView(id) {
    return Object.entries(state.undo).filter(([,u])=>u.id===id&&!u.reverted)
      .map(([undoId,u])=>({undoId,field:u.field,pending:u.pending}));
  }

  async function apply(msg, undo = false) {
    const id=msg.campaignId;
    if (!id) fail('selection_required', 'Select a draft first.');
    return locked(id, async () => {
      const a=adapter();
      let field,original,text,receipt,existing;
      if (undo) {
        receipt=state.undo[msg.undoId];
        if (!receipt||receipt.id!==id||receipt.reverted) fail('no_undo','No original value is available to undo.');
        field=receipt.field;original=receipt.text;text=receipt.original;
      } else {
        const c=state.cache[msg.cacheId];
        if (!c?.result||c.result.kind!=='optimize'||c.scope!=='mailchimp') fail('invalid_result','Optimize this field before applying it.');
        field=c.field;original=c.original;
        if (field!=='subject_line'&&field!=='preview_text') fail('body_read_only','Body Apply is disabled to preserve the email structure.');
        if (!c.campaignIds?.includes(id)) fail('wrong_campaign','This alternative was not reviewed for the selected campaign.');
        const alternative=c.result.alternatives[msg.alternativeIndex??0];
        text=alternative?.touchpoints?.[c.touchpoint]||alternative?.text;
        const check=G.validateRewrite(original,text,{maxLength:c.maxLength});
        if (!check.ok) fail('unsafe_rewrite',check.reasons.join('; '));
        existing=Object.entries(state.undo).find(([,u])=>u.id===id&&u.cacheId===msg.cacheId&&u.text===text&&!u.reverted);
      }
      const undoId=undo?msg.undoId:existing?.[0]||randomUUID();
      // Critical path: fresh settings GET → one-field PATCH → verification GET.
      // Neither campaign HTML nor the draft list is needed to save a setting.
      const verification=await a.updateSetting(id,field,original,text,{
        webId:msg.webId,
        allowAlreadySaved:!!existing,
        beforeWrite:()=>{
          if (!undo) { state.undo[undoId]={id,field,original,text,cacheId:msg.cacheId,at:Date.now(),pending:true};save(); }
        },
      });
      if (!verification.ok) fail('unverified','Mailchimp accepted the update, but read-back did not match. Refresh the draft before retrying. The original value is retained for undo.');
      if (undo) receipt.reverted=true;
      else state.undo[undoId].pending=false;
      if(undo){for(const o of state.outcomes)if(o.undoId===undoId&&!o.undoneAt)o.undoneAt=Date.now();}
      else if(!verification.duplicate){
        const cached=state.cache[msg.cacheId],variant=cached.result.alternatives[msg.alternativeIndex??0];
        recordOutcome({campaignId:id,field,original,optimized:text,persadoJobId:cached.result.jobId,
          variantIndex:variant.index??msg.alternativeIndex??0,originalScore:cached.result.control?.performance??null,
          scoredAt:state.cache[runKey('score',{field,touchpoint:cached.touchpoint,text:original,maxLength:cached.maxLength},account(msg),'mailchimp')]?.at??null,
          optimizedScore:variant.performance??null,optimizedAt:cached.at,appliedAt:Date.now(),undoId});
      }
      save();
      const c=verification.campaign;
      const prediction=scoreForField({field,text:c.settings?.[field]||'',touchpoint:field==='subject_line'?'subject_line':'preheader',maxLength:150},account(msg),id);
      // Return the independently verified settings now. Body synchronization is
      // a background UI read, never a prerequisite for reporting a saved subject.
      return {ok:true,verified:true,duplicate:!!verification.duplicate,undoId,undo:undoView(id),settingsOnly:true,predictions:{[field]:prediction},
        campaign:{id:c.id,webId:c.web_id,title:c.settings?.title||'',subject:c.settings?.subject_line||'',previewText:c.settings?.preview_text||''}};
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
        case 'MC_INSIGHTS': {
          if(!msg.campaignId)fail('selection_required','Select a campaign first.');
          const c=await adapter().getCampaign(msg.campaignId);
          if(msg.webId!=null&&Number(c.web_id)!==Number(msg.webId))fail('not_found','The URL does not match the selected campaign.');
          const languageUpdated=await enrichExistingJobs(c.id);
          const projection=Object.entries(state.cache).filter(([key,x])=>x.scope==='mailchimp'&&x.campaignIds?.includes(c.id)
              &&key===runKey('score',{text:x.original,touchpoint:x.touchpoint,maxLength:x.maxLength},account(msg),'mailchimp'))
            .flatMap(([,x])=>(x.result?.variants||[]).map(v=>({field:x.field,text:x.original,potential:v.potential})))
            .filter(x=>x.potential&&(x.field==='subject_line'?x.text===c.settings?.subject_line:x.field==='preview_text'&&x.text===c.settings?.preview_text))
            .map(({field,potential})=>({field,potential,calibrationAvailable:false}));
          try{return {ok:true,...await reporting.insights(c),languageUpdated,modelOutputs:projection};}
          catch(e){return {ok:true,status:c.status,reach:impact.reach(c),baseline:{available:false,clickRate:null,campaignCount:0,samples:[]},history:[],forecast:null,reportingUnavailable:true,languageUpdated,modelOutputs:projection};}
        }
        case 'MC_REPORT': {
          if(!msg.campaignId)fail('selection_required','Select a sent campaign first.');
          const report=await reporting.report(msg.campaignId);
          for(const o of state.outcomes)if(o.campaignId===msg.campaignId)o.postSendMetrics=report;
          save();return {ok:true,report};
        }
        case 'MC_STATUS': {
          if (!mkey) return { ok: true, connected: false, persadoKey: !!pkey, usage: usage() };
          if (!mcConnection) mcConnection = await adapter().test();
          const out = { ok: true, connected: true, accountName: mcConnection.accountName, dc: mcConnection.dc, persadoKey: !!pkey, usage: usage() };
          if (msg.webId || msg.campaignId) { const { draft } = await campaign(msg);
            // Adopt runs that finished while nobody was watching (free job GETs, never a resubmit).
            const acct = account(msg);
            await Promise.all(draft.fields.flatMap(f => ['score', 'optimize'].map(op => runKey(op, f, acct, 'mailchimp')))
              .filter(k => state.cache[k]?.pending && !inflight.has(k) && state.cache[k].jobId).map(k => jobStatus(k).catch(() => null)));
            out.campaign = view(draft, msg);
            out.undo = Object.entries(state.undo).filter(([, u]) => u.id === draft.ref.id && !u.reverted).map(([undoId, u]) => ({ undoId, field: u.field, pending: u.pending })); }
          return out;
        }
        case 'MC_SCORE': case 'MC_OPTIMIZE': {
          const { draft, id } = await campaign(msg);
          const field = draft.fields.find(f => f.field === msg.field);
          if (!field) fail('not_eligible', 'Choose an eligible copy block. Refresh if the draft changed.');
          if (msg.text !== field.text) fail('changed', 'The draft copy changed. Refresh before spending credits.');
          const acct = account(msg), op = msg.type === 'MC_SCORE' ? 'score' : 'optimize';
          const key = runKey(op, field, acct, 'mailchimp');
          // Tag the run with this campaign before it starts, so a result that lands
          // after the panel closed still shows on the right draft.
          if (state.cache[key]) { state.cache[key].campaignIds = [...new Set([...(state.cache[key].campaignIds || []), id])]; save(); }
          const outcome = done => recordOutcome({campaignId:id,field:field.field,original:field.text,persadoJobId:done.result.jobId,
            ...(op==='score'?{scoredAt:done.at,originalScore:done.result.variants[0]?.performance??null}:{optimizedAt:done.at,
              variants:done.result.alternatives.map(v=>({index:v.index,rank:v.rank,text:v.touchpoints?.[field.touchpoint]||v.text,score:v.performance}))})});
          const out = await paid(op, field, acct, 'mailchimp', { onResult: outcome });
          if (state.cache[key]) { state.cache[key].campaignIds = [...new Set([...(state.cache[key].campaignIds || []), id])]; save(); }
          return { ok: true, ...out, cacheId: key, usage: usage() };
        }
        case 'JOB_STATUS': {
          if (typeof msg.cacheId !== 'string' || !/^[0-9a-f]{64}$/.test(msg.cacheId)) fail('invalid_request', 'A job reference is required.');
          return { ok: true, ...(await jobStatus(msg.cacheId)), usage: usage() };
        }
        case 'JOB_RETRY': {
          if (typeof msg.cacheId !== 'string' || !/^[0-9a-f]{64}$/.test(msg.cacheId)) fail('invalid_request', 'A job reference is required.');
          return { ok: true, ...(await retryJob(msg)), usage: usage() };
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
