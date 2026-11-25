// Provider fixtures exercise contracts only. Live verification is reported separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createIntegrations, handleIntegrationRequest } from '../../gateway/integrations.mjs';
import { json } from './helpers.mjs';

function setup(opts = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'persado-integrations-')), 'state.json');
  const c = { id: 'abc', web_id: 42, status: 'save', type: 'regular', content_type: 'multichannel',
    settings: { title: 'Spring campaign', subject_line: 'Spring favourites just arrived', preview_text: 'Find your new seasonal favourites', from_name: 'Acme', reply_to: 'hello@example.test' } };
  const calls = [];
  const html = '<h1>Spring favourites for your home</h1><p>Make room for new ideas and something beautiful this season.</p><a class="mcnButton" href="https://example.test">Shop now</a><p>*|UNSUB|* Privacy policy</p>';
  const f = async (url, init = {}) => {
    const u = new URL(url), body = init.body ? JSON.parse(init.body) : null, method = init.method || 'GET';
    calls.push({ url: u.href, body, method });
    if (u.hostname === 'api.persado.com') {
      if (opts.rejectKey) return json(401, { error: { message: 'invalid key' } });
      if (opts.exhausted) return json(429, { error: { code: 'quota_exhausted' } });
      if (opts.transport) throw new Error('socket lost');
      if (u.pathname.endsWith('/catalogue')) return json(200, { channels: [{ key: 'EMAIL_SUBJECT_BODY' }] });
      if(u.pathname.endsWith('/jobs/job_score'))return json(200,{id:'job_score',kind:'score',status:'completed',result:{variants:[{performance:63,performanceBand:'fair',performanceWhy:'Clarify the benefit.',potential:{clicks:{total:3.1}}}]}});
      if (opts.delay) await new Promise(r => setTimeout(r, 15));
      if (u.pathname.endsWith('/score')) return json(200, { id: 'job_score', kind: 'score', status: 'completed', result: {
        variants: [{ performance: 63, touchpoints: body.variants[0] }] } });
      if (u.pathname.endsWith('/optimize')) {
        const field = Object.keys(body.variant)[0];
        return json(200, { id: 'job_optimize', kind: 'optimize', status: 'completed', result: {
          control: { performance: 63 }, alternatives: [{ rank: 1, ...(opts.performance!=null?{performance:opts.performance,performanceBand:'strong',brandRationale:'More specific brand wording.'}:{}), touchpoints: { [field]: opts.unsafe ? 'Save 90% today' : 'Explore fresh spring favourites' } }] } });
      }
    }
    if (u.pathname.endsWith('/ping')) return json(200, { health_status: 'ok' });
    if (u.pathname === '/3.0/') return json(200, { account_name: 'Acme' });
    if (u.pathname === '/3.0/campaigns') return json(200, { campaigns: opts.ambiguous ? [c, { ...c, id: 'other' }] : [c], total_items: 1 });
    if (u.pathname.endsWith('/content')) return json(200, { html });
    if (u.pathname === '/3.0/campaigns/abc') {
      if (method === 'PATCH') {
        if (!opts.ignorePatch) Object.assign(c.settings, body.settings);
        if (opts.failPatch) return json(400, { title: 'Update rejected' });
      }
      return json(200, c);
    }
    return json(404, { title: 'Unexpected fixture route' });
  };
  const env = { PERSADO_API_KEY: 'fixture-persado', MAILCHIMP_API_KEY: 'fixture-mailchimp-us21', PERSADO_PROXY_TOKEN: 't'.repeat(64) };
  const service = createIntegrations({ env, fetchImpl: f, statePath: path });
  const settings = { brand: 'Acme', industry: 'RETAIL_ECOMMERCE' };
  const send = msg => service.dispatch({ settings, ...msg });
  const field = (type, name = 'subject_line') => ({ type, campaignId: 'abc', webId: 42, field: name, text: c.settings[name] });
  return { send, field, c, calls, env, service, path, f, settings };
}

async function optimize(s, name = 'subject_line') {
  if (name === 'subject_line') assert.equal((await s.send(s.field('MC_SCORE', name))).ok, true);
  const out = await s.send(s.field('MC_OPTIMIZE', name));
  assert.equal(out.ok, true, out.error);
  return out;
}

test('detects actual draft content without spending credits; builder blocks exclude legal copy', async () => {
  const s = setup();
  const r = await s.send({ type: 'MC_STATUS', webId: 42 });
  assert.equal(r.campaign.id, 'abc');
  assert.equal(r.campaign.subject, s.c.settings.subject_line);
  assert.equal(r.campaign.previewText, s.c.settings.preview_text);
  assert.equal(r.usage.requests, 0);
  assert.ok(r.campaign.fields.some(f => f.touchpoint === 'cta' && f.applyDisabledReason));
  assert.ok(!r.campaign.fields.some(f => f.text.includes('UNSUB')));
  assert.equal(s.calls.filter(c => c.url.includes('api.persado')).length, 0);
  assert.equal((await s.send({ type: 'MC_STATUS', webId: 99 })).kind, 'not_found');
  assert.equal((await s.send({ type: 'MC_STATUS', campaignId: 'wrong', webId: 42 })).kind, 'not_found');
});

test('campaign intelligence preserves unknown and zero reach, reports failures softly, and spends no Persado credits',async()=>{
 const s=setup();
 let r=await s.send({type:'MC_INSIGHTS',campaignId:'abc',webId:42});
 assert.equal(r.ok,true);assert.equal(r.reach.count,null);assert.equal(r.baseline.available,false);assert.equal(r.forecast,null);
 s.c.recipients={recipient_count:0};r=await s.send({type:'MC_INSIGHTS',campaignId:'abc',webId:42});assert.equal(r.reach.count,0);
 assert.equal((await s.send({type:'MC_INSIGHTS',campaignId:'abc',webId:99})).kind,'not_found');
 assert.equal(s.calls.filter(c=>c.url.includes('api.persado')).length,0);
 assert.ok(s.calls.every(c=>c.method==='GET'));assert.equal((await s.send({type:'USAGE_GET'})).requests,0);
});

test('private outcome records connect real jobs, copy, application and Undo without claiming attribution',async()=>{
 const s=setup({performance:80}),optimized=await optimize(s);
 const applied=await s.send({type:'MC_APPLY',campaignId:'abc',cacheId:optimized.cacheId});
 let outcomes=JSON.parse(readFileSync(s.path,'utf8')).outcomes;
 const a=outcomes.find(o=>o.undoId===applied.undoId);
 assert.equal(a.persadoJobId,'job_optimize');assert.equal(a.optimized,'Explore fresh spring favourites');assert.equal(a.optimizedScore,80);
 assert.ok(a.appliedAt&&a.optimizedAt);assert.equal(a.experimentalAssignment,null);assert.equal(a.verifiedIncrementalOutcome,null);
 await s.send({type:'MC_REVERT',campaignId:'abc',undoId:applied.undoId});
 outcomes=JSON.parse(readFileSync(s.path,'utf8')).outcomes;assert.ok(outcomes.find(o=>o.id===a.id).undoneAt);
 assert.ok(outcomes.some(o=>o.scoredAt));
});

test('older paid results recover richer fields with a read-only job GET, never a replacement paid request',async()=>{
 const s=setup();await s.send(s.field('MC_SCORE'));
 const saved=JSON.parse(readFileSync(s.path,'utf8'));
 for(const c of Object.values(saved.cache))delete c.result.schemaVersion;
 writeFileSync(s.path,JSON.stringify(saved));
 const next=createIntegrations({env:s.env,fetchImpl:s.f,statePath:s.path});
 const before=s.calls.length;
 const insights=await next.dispatch({type:'MC_INSIGHTS',campaignId:'abc',settings:s.settings});
 assert.equal(insights.languageUpdated,true);assert.equal(insights.modelOutputs[0].potential.clicks.total,3.1);
 assert.equal(insights.forecast,null);assert.ok(s.calls.slice(before).every(c=>c.method==='GET'));
 assert.equal((await next.dispatch({type:'USAGE_GET'})).requests,1);
 const view=await next.dispatch({type:'MC_STATUS',campaignId:'abc',settings:s.settings});
 assert.equal(view.campaign.fields[0].score.variants[0].performanceWhy,'Clarify the benefit.');
 const other=await next.dispatch({type:'MC_INSIGHTS',campaignId:'abc',settings:{brand:'Another brand'}});
 assert.deepEqual(other.modelOutputs,[]);
});

test('ambiguous identifiers never select a draft', async () => {
  const s = setup({ ambiguous: true });
  assert.equal((await s.send({ type: 'MC_STATUS', webId: 42 })).kind, 'ambiguous');
});

test('manual score and optimize are separate, concurrent duplicate scoring coalesces and survives restart', async () => {
  const s = setup({ delay: true });
  const direct = await s.send(s.field('MC_OPTIMIZE'));
  assert.equal(direct.ok, true, 'optimization is available without paying for scoring first');
  assert.equal(s.calls.filter(c => c.url.includes('/v1/score')).length, 0);
  const scores = await Promise.all([s.send(s.field('MC_SCORE')), s.send(s.field('MC_SCORE'))]);
  assert.ok(scores.every(r => r.ok));assert.equal(scores[0].result.variants[0].performance, 63);
  assert.equal(s.calls.filter(c => c.url.includes('/v1/score')).length, 1);
  const restarted = createIntegrations({ env: s.env, fetchImpl: s.f, statePath: s.path });
  const cached = await restarted.dispatch({ ...s.field('MC_SCORE'), settings: s.settings });
  assert.equal(cached.cached, true);
  assert.equal(s.calls.filter(c => c.url.includes('/v1/score')).length, 1);
  const out = await optimize(s);
  assert.equal(out.result.alternatives[0].performance, null, 'never invent a revised score');
  assert.equal(s.calls.filter(c => c.method === 'PATCH').length, 0, 'Optimize is preview only');
  assert.equal((await s.send({ type: 'USAGE_GET' })).used, 6);
  assert.equal(statSync(s.path).mode & 0o777, 0o600);
  assert.ok(!readFileSync(s.path, 'utf8').includes(s.env.PERSADO_API_KEY));
});

test('apply writes only the chosen setting, reads it back, deduplicates, and undo preserves unrelated edits', async () => {
  const s = setup(), before = { ...s.c.settings };
  const out = await optimize(s);
  const msg = { type: 'MC_APPLY', campaignId: 'abc', webId: 42, cacheId: out.cacheId };
  const beforeApply=s.calls.length;
  const applied = await s.send(msg);
  assert.equal(applied.verified, true, applied.error);
  assert.deepEqual(s.calls.slice(beforeApply).map(c=>c.method),['GET','PATCH','GET'],'save path keeps fresh draft check and independent verification, without extra reads');
  assert.ok(!s.calls.slice(beforeApply).some(c=>c.url.includes('/content')||c.url.includes('/campaigns?')));
  assert.equal(s.c.settings.subject_line, 'Explore fresh spring favourites');
  assert.deepEqual(s.calls.find(c => c.method === 'PATCH').body, { settings: { subject_line: 'Explore fresh spring favourites' } });
  assert.equal(s.c.settings.preview_text, before.preview_text);
  assert.equal((await s.send(msg)).duplicate, true);
  assert.equal(s.calls.filter(c => c.method === 'PATCH').length, 1);
  s.c.settings.preview_text = 'A manual change elsewhere';
  const undo = await s.send({ type: 'MC_REVERT', campaignId: 'abc', undoId: applied.undoId });
  assert.equal(undo.verified, true, undo.error);
  assert.equal(s.c.settings.subject_line, before.subject_line);
  assert.equal(s.c.settings.preview_text, 'A manual change elsewhere');
});

test('fast Apply still rejects a mismatched URL before any write',async()=>{
 const s=setup(),out=await optimize(s);const before=s.calls.length;
 const r=await s.send({type:'MC_APPLY',campaignId:'abc',webId:99,cacheId:out.cacheId});
 assert.equal(r.kind,'not_found');assert.deepEqual(s.calls.slice(before).map(c=>c.method),['GET']);
});

test('preview text can be optimized and independently applied', async () => {
  const s = setup(), subject = s.c.settings.subject_line;
  const out = await optimize(s, 'preview_text');
  const r = await s.send({ type: 'MC_APPLY', campaignId: 'abc', cacheId: out.cacheId });
  assert.equal(r.verified, true); assert.equal(s.c.settings.subject_line, subject);
  assert.equal(s.c.settings.preview_text, 'Explore fresh spring favourites');
});

test('changed, sent, and unsafe drafts are not overwritten; undo refuses a later edit', async () => {
  for (const mode of ['changed', 'sent', 'unsafe']) {
    const s = setup({ unsafe: mode === 'unsafe' }), out = await optimize(s);
    if (mode === 'changed') s.c.settings.subject_line = 'Manual edit';
    if (mode === 'sent') s.c.status = 'sent';
    const r = await s.send({ type: 'MC_APPLY', campaignId: 'abc', cacheId: out.cacheId });
    assert.equal(r.ok, false);assert.equal(s.calls.filter(c => c.method === 'PATCH').length, 0);
  }
  const s = setup(), out = await optimize(s);
  const applied = await s.send({ type: 'MC_APPLY', campaignId: 'abc', cacheId: out.cacheId });
  s.c.settings.subject_line = 'A later manual subject';
  assert.equal((await s.send({ type: 'MC_REVERT', campaignId: 'abc', undoId: applied.undoId })).kind, 'changed');
  assert.equal(s.c.settings.subject_line, 'A later manual subject');
});

test('body results cannot be applied, and sending is unavailable', async () => {
  const s = setup();
  const st = await s.send({ type: 'MC_STATUS', webId: 42 });
  const f = st.campaign.fields.find(f => f.location === 'html');
  const out = await s.send({ type: 'MC_OPTIMIZE', campaignId: 'abc', field: f.field, text: f.text });
  assert.equal(out.ok, true);
  assert.equal((await s.send({ type: 'MC_APPLY', campaignId: 'abc', cacheId: out.cacheId })).kind, 'body_read_only');
  assert.equal((await s.send({ type: 'MC_TEST_SEND', campaignId: 'abc' })).kind, 'unsupported');
  assert.ok(!s.calls.some(c => c.method === 'PUT' || c.url.includes('/actions/')));
});

test('verification failure retains undo receipt and does not claim success', async () => {
  const s = setup({ ignorePatch: true }), out = await optimize(s);
  const r = await s.send({ type: 'MC_APPLY', campaignId: 'abc', cacheId: out.cacheId });
  assert.equal(r.kind, 'unverified');
  const st = await s.send({ type: 'MC_STATUS', webId: 42 });
  assert.equal(st.undo.length, 1);
});

test('invalid keys and insufficient credits are actionable; uncertain paid requests are not resubmitted', async () => {
  const invalid = setup({ rejectKey: true });
  assert.equal((await invalid.send(invalid.field('MC_SCORE'))).kind, 'invalid_key');
  const quota = setup({ exhausted: true });
  assert.equal((await quota.send(quota.field('MC_SCORE'))).kind, 'quota_exhausted');
  assert.equal((await quota.send(quota.field('MC_SCORE'))).kind, 'quota_exhausted');
  assert.equal(quota.calls.filter(c => c.url.includes('/v1/score')).length, 1);
  const uncertain = setup({ transport: true });
  await uncertain.send(uncertain.field('MC_SCORE'));
  const again = await uncertain.send(uncertain.field('MC_SCORE'));
  assert.equal(again.status, 'unknown');
  assert.equal(again.retry, 'confirm');
  assert.equal(uncertain.calls.filter(c => c.url.includes('/v1/score')).length, 1);
});

test('website score and optimize still use real provider client schemas and cache unchanged copy', async () => {
  const s = setup();
  const msg = { type: 'PERSADO_SCORE', kind: 'headline', text: 'Find something you love' };
  const r = await s.send(msg);assert.equal(r.result.variants[0].performance, 63);
  await s.send(msg);
  assert.equal(s.calls.filter(c => c.url.includes('/v1/score')).length, 1);
  const out = await s.send({ ...msg, type: 'PERSADO_OPTIMIZE' });
  assert.equal(out.result.alternatives[0].touchpoints.headline, 'Explore fresh spring favourites');
  assert.equal(s.calls.find(c => c.url.includes('/v1/optimize')).body.channel, 'WEB_PAGE');
});

test('HTTP gateway rejects unpaired requests, web origins and rebinding hosts', async t => {
  const s = setup();
  const server = http.createServer((req, res) => handleIntegrationRequest(req, res, s.service, s.env));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/v1/integrations`;
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Persado-Token': s.env.PERSADO_PROXY_TOKEN }, body: JSON.stringify({ type: 'USAGE_GET' }) };
  assert.equal((await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await fetch(url, { ...init, headers: { ...init.headers, Origin: 'https://evil.test' } })).status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { ...init.headers, Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(init.body);
  });
  assert.equal(rebound, 403);
  const r = await fetch(url, init);assert.equal(r.status, 200);
  assert.ok(!(await r.text()).includes(s.env.PERSADO_API_KEY));
});

test('applied optimization predictions keep their provenance without another score charge or account leakage',async()=>{
 const s=setup({performance:84});
 const out=await s.send(s.field('MC_OPTIMIZE'));
 const applied=await s.send({type:'MC_APPLY',campaignId:'abc',webId:42,cacheId:out.cacheId});
 assert.equal(applied.predictions.subject_line.variants[0].performance,84);
 assert.equal(applied.predictions.subject_line.kind,'optimize');
 const st=await s.send({type:'MC_STATUS',campaignId:'abc'});
 const field=st.campaign.fields.find(f=>f.field==='subject_line');
 assert.equal(field.score.variants[0].performance,84);assert.equal(st.usage.scoreRuns,0);
 assert.equal(st.usage.optimizeRuns,1);assert.equal(st.usage.used,5);
 const other=await s.send({type:'MC_STATUS',campaignId:'abc',settings:{brand:'Different account name'}});
 assert.equal(other.campaign.fields.find(f=>f.field==='subject_line').score,null);
 const before=s.calls.length;
 const undo=await s.send({type:'MC_REVERT',campaignId:'abc',undoId:applied.undoId});
 assert.equal(undo.predictions.subject_line.variants[0].performance,63);
 assert.deepEqual(s.calls.slice(before).map(c=>c.method),['GET','PATCH','GET']);
});
