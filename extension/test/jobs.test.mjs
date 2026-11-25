// Audit findings #3/#4: paid runs are a recoverable job lifecycle.
// Fixture provider only; no live Persado calls.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntegrations } from '../../gateway/integrations.mjs';
import { json } from './helpers.mjs';

const env = { PERSADO_API_KEY: 'fixture-persado', MAILCHIMP_API_KEY: '', PERSADO_PROXY_TOKEN: 't'.repeat(64) };
const settings = { brand: 'Acme' };
const web = (type, text = 'Start your free trial today') => ({ type, kind: 'headline', text, settings });
const done = id => ({ id, kind: 'optimize', status: 'completed', result: {
  control: { performance: 50 }, alternatives: [{ rank: 1, performance: 70, touchpoints: { headline: 'Begin your free trial today' } }] } });

/**
 * A controllable Persado. `jobs` maps id → status; POST /v1/optimize answers
 * per `mode`: 'running' (accepted, still working), 'transport' (no answer),
 * 'reject' (explicit 400), 'hold' (never answers until released).
 */
const all = [];
// Let background polls (2 s cadence) finish so the process exits.
after(() => { for (const p of all) { p.release(); for (const k of p.jobs.keys()) p.jobs.set(k, 'completed'); } });

function provider(mode = 'running') {
  const calls = [], jobs = new Map();
  let release;
  const held = new Promise(r => { release = r; });
  const f = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    calls.push({ path: u.pathname, method, wait: u.searchParams.get('wait') });
    if (u.pathname.endsWith('/v1/optimize') && method === 'POST') {
      if (mode === 'transport') throw new Error('socket lost');
      if (mode === 'reject') return json(400, { error: { code: 'invalid_request', message: 'bad input' } });
      if (mode === 'hold') { await held; return json(200, done('job_held')); }
      jobs.set('job_1', 'running');
      return json(200, { id: 'job_1', kind: 'optimize', status: 'running' });
    }
    const m = u.pathname.match(/\/v1\/jobs\/(.+)$/);
    if (m) {
      const st = jobs.get(m[1]);
      if (!st) return json(404, { error: { code: 'not_found', message: 'no such job' } });
      if (st === 'completed') return json(200, done(m[1]));
      if (st === 'failed') return json(200, { id: m[1], status: 'failed', error: { message: 'model error' } });
      return json(200, { id: m[1], kind: 'optimize', status: st });
    }
    return json(404, {});
  };
  const p = { f, calls, jobs, release, posts: () => calls.filter(c => c.method === 'POST').length };
  all.push(p);
  return p;
}

function svc(p, statePath, opts = {}) {
  return createIntegrations({ env, fetchImpl: p.f, statePath, responseBudgetMs: 30, statusTimeoutMs: 200, ...opts });
}
const tmp = () => join(mkdtempSync(join(tmpdir(), 'persado-jobs-')), 'state.json');
const tick = ms => new Promise(r => setTimeout(r, ms));

test('a long optimize returns a pollable job within the response budget, not a held request', async () => {
  const p = provider('hold'), s = svc(p, tmp());
  const t0 = Date.now();
  const out = await s.dispatch(web('PERSADO_OPTIMIZE'));
  assert.ok(Date.now() - t0 < 1000, 'answered quickly');
  assert.equal(out.ok, true);
  assert.equal(out.status, 'running');
  assert.match(out.cacheId, /^[0-9a-f]{64}$/);
  p.release();
  await tick(20);
  const st = await s.dispatch({ type: 'JOB_STATUS', cacheId: out.cacheId });
  assert.equal(st.status, 'done');
  assert.equal(st.result.alternatives[0].touchpoints.headline, 'Begin your free trial today');
  assert.equal(p.posts(), 1);
});

test('duplicate clicks while running and after completion never submit a second paid run', async () => {
  const p = provider('hold'), s = svc(p, tmp());
  const [a, b] = await Promise.all([s.dispatch(web('PERSADO_OPTIMIZE')), s.dispatch(web('PERSADO_OPTIMIZE'))]);
  assert.equal(a.cacheId, b.cacheId);
  assert.equal((await s.dispatch(web('PERSADO_OPTIMIZE'))).status, 'running');
  p.release(); await tick(20);
  const again = await s.dispatch(web('PERSADO_OPTIMIZE'));
  assert.equal(again.status, 'done');
  assert.equal(again.cached, true);
  assert.equal(p.posts(), 1);
});

test('a gateway restart mid-run adopts the result by job id with free GETs only', async () => {
  const p = provider('running'), path = tmp();
  const first = svc(p, path, { responseBudgetMs: 5 });
  const out = await first.dispatch(web('PERSADO_OPTIMIZE'));
  assert.equal(out.status, 'running');
  await tick(30);                                     // job id persisted on accept
  const restarted = svc(p, path);                     // fresh process, same state file
  const still = await restarted.dispatch({ type: 'JOB_STATUS', cacheId: out.cacheId });
  assert.equal(still.status, 'running');
  p.jobs.set('job_1', 'completed');
  const st = await restarted.dispatch({ type: 'JOB_STATUS', cacheId: out.cacheId });
  assert.equal(st.status, 'done');
  // Starting the same copy again reuses the adopted result.
  assert.equal((await restarted.dispatch(web('PERSADO_OPTIMIZE'))).cached, true);
  assert.equal(p.posts(), 1);
});

test('after restart, re-clicking a pending run reports status instead of resubmitting', async () => {
  const p = provider('running'), path = tmp();
  await svc(p, path, { responseBudgetMs: 5 }).dispatch(web('PERSADO_OPTIMIZE'));
  await tick(30);
  const restarted = svc(p, path);
  const out = await restarted.dispatch(web('PERSADO_OPTIMIZE'));
  assert.equal(out.status, 'running');
  assert.equal(p.posts(), 1);
});

test('a lost submission is "unknown": retry needs explicit confirmation, then submits exactly once', async () => {
  const p = provider('transport'), s = svc(p, tmp());
  const out = await s.dispatch(web('PERSADO_OPTIMIZE'));
  assert.equal(out.status, 'unknown');
  assert.equal(out.retry, 'confirm');
  const refused = await s.dispatch({ type: 'JOB_RETRY', cacheId: out.cacheId });
  assert.equal(refused.ok, false);
  assert.equal(refused.kind, 'confirm_required');
  assert.equal(p.posts(), 1);
  const r = await s.dispatch({ type: 'JOB_RETRY', cacheId: out.cacheId, confirmUncertain: true });
  assert.equal(r.status, 'unknown');                  // the fixture still drops it
  assert.equal(p.posts(), 2);
});

test('an expired job (404) is unknown, a failed job is safely retryable, an explicit rejection is retryable', async () => {
  const p = provider('running'), path = tmp();
  const out = await svc(p, path, { responseBudgetMs: 5 }).dispatch(web('PERSADO_OPTIMIZE'));
  await tick(30);
  const s = svc(p, path);
  p.jobs.delete('job_1');
  const gone = await s.dispatch({ type: 'JOB_STATUS', cacheId: out.cacheId });
  assert.equal(gone.status, 'unknown');
  assert.match(gone.message, /no longer has this job/);
  p.jobs.set('job_1', 'failed');
  const failed = await s.dispatch({ type: 'JOB_STATUS', cacheId: out.cacheId });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.retry, 'safe');

  const r = provider('reject'), rs = svc(r, tmp());
  const rejected = await rs.dispatch(web('PERSADO_OPTIMIZE'));
  assert.equal(rejected.ok, false);
  const st = await rs.dispatch({ type: 'JOB_STATUS', cacheId: rejected.cacheId || '0'.repeat(64) });
  assert.ok(['failed', 'not_found'].includes(st.status));
});

test('a status check that cannot reach Persado keeps the run pending and says to check again', async () => {
  const p = provider('running'), path = tmp();
  const out = await svc(p, path, { responseBudgetMs: 5 }).dispatch(web('PERSADO_OPTIMIZE'));
  await tick(30);
  const offline = createIntegrations({ env, statePath: path, statusTimeoutMs: 50, fetchImpl: async () => { throw new Error('offline'); } });
  const st = await offline.dispatch({ type: 'JOB_STATUS', cacheId: out.cacheId });
  assert.equal(st.status, 'running');
  assert.equal(st.checkFailed, true);
});

test('job references are validated', async () => {
  const s = svc(provider(), tmp());
  assert.equal((await s.dispatch({ type: 'JOB_STATUS', cacheId: '../etc' })).kind, 'invalid_request');
  assert.equal((await s.dispatch({ type: 'JOB_RETRY' })).kind, 'invalid_request');
});

test('Mailchimp: an optimize that outlives the request shows as a job on its field, then as a result on the same draft', async () => {
  const c = { id: 'abc', web_id: 42, status: 'save', type: 'regular', content_type: 'multichannel',
    settings: { title: 'T', subject_line: 'Spring favourites just arrived', preview_text: 'Find your new seasonal favourites', from_name: 'A', reply_to: 'a@example.test' } };
  let state = 'running', posts = 0;
  const f = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    if (u.hostname === 'api.persado.com') {
      if (u.pathname.endsWith('/v1/optimize')) { posts++; return json(200, { id: 'job_mc', kind: 'optimize', status: 'running' }); }
      if (u.pathname.endsWith('/v1/jobs/job_mc')) return state === 'running' ? json(200, { id: 'job_mc', status: 'running' })
        : json(200, { id: 'job_mc', kind: 'optimize', status: 'completed', result: { control: { performance: 50 }, alternatives: [{ rank: 1, performance: 70, touchpoints: { subject_line: 'Fresh spring favourites are here' } }] } });
    }
    if (u.pathname.endsWith('/ping')) return json(200, {});
    if (u.pathname === '/3.0/') return json(200, { account_name: 'Acme' });
    if (u.pathname === '/3.0/campaigns') return json(200, { campaigns: [c], total_items: 1 });
    if (u.pathname.endsWith('/content')) return json(200, { html: '<p>Hello</p>' });
    if (u.pathname === '/3.0/campaigns/abc') { if (method === 'PATCH') Object.assign(c.settings, JSON.parse(init.body).settings); return json(200, c); }
    return json(404, {});
  };
  const menv = { ...env, MAILCHIMP_API_KEY: 'fixture-us21' }, path = tmp();
  const s = createIntegrations({ env: menv, fetchImpl: f, statePath: path, responseBudgetMs: 5 });
  const out = await s.dispatch({ type: 'MC_OPTIMIZE', campaignId: 'abc', webId: 42, field: 'subject_line', text: c.settings.subject_line, settings });
  assert.equal(out.status, 'running');
  let st = await s.dispatch({ type: 'MC_STATUS', campaignId: 'abc', webId: 42, settings });
  let subject = st.campaign.fields.find(x => x.field === 'subject_line');
  assert.equal(subject.job.status, 'running');
  assert.equal(subject.optimization, null);
  // Gateway restart, then the job finishes: the next status read adopts it.
  await tick(30);
  state = 'completed';
  const restarted = createIntegrations({ env: menv, fetchImpl: f, statePath: path });
  st = await restarted.dispatch({ type: 'MC_STATUS', campaignId: 'abc', webId: 42, settings });
  subject = st.campaign.fields.find(x => x.field === 'subject_line');
  assert.equal(subject.job, null);
  assert.equal(subject.optimization.result.alternatives[0].touchpoints.subject_line, 'Fresh spring favourites are here');
  // Applying it spends nothing more.
  const applied = await restarted.dispatch({ type: 'MC_APPLY', campaignId: 'abc', webId: 42, cacheId: subject.optimization.cacheId, alternativeIndex: 0, settings });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(c.settings.subject_line, 'Fresh spring favourites are here');
  assert.equal(posts, 1);
});

test('the gateway asks Persado for the job id within 5 s, shrinking the uncertain-charge window', async () => {
  const p = provider('running'), s = svc(p, tmp());
  await s.dispatch(web('PERSADO_OPTIMIZE'));
  assert.equal(p.calls.find(c => c.method === 'POST').wait, '5');
});
