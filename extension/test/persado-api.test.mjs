import test from 'node:test';
import assert from 'node:assert/strict';
import { load, fakeFetch, json, noSleep, optimizeJob } from './helpers.mjs';
await load('persado-api.js');
const API = globalThis.PERSADO_API;

test('score: Bearer auth, documented path, wait=50, normalises the job', async () => {
  const f = fakeFetch([{ method: 'POST', match: /\/api\/v1\/score\?wait=50$/, reply: () => json(200, {
    id: 'job_' + 'a'.repeat(32), kind: 'score', status: 'completed',
    result: { complete: true, channel: 'WEB_PAGE', variants: [{ index: 0, rank: 1, touchpoints: { cta: 'Open your account' }, text: 'Open your account', performance: 71, performanceBand: 'GOOD', compliance: { risk: 'LOW', state: 'CLEARED', summary: null, issues: [] } }], alternatives: [] },
  }, { 'X-Request-Id': 'req-1' }) }]);
  const { result } = await API.score({ key: 'k1', fetchImpl: f, channel: 'WEB_PAGE', accountName: 'Acme', variants: [{ cta: 'Open your account' }] });
  assert.equal(f.calls[0].headers.Authorization, 'Bearer k1');
  assert.deepEqual(f.calls[0].body, { channel: 'WEB_PAGE', account: { name: 'Acme' }, variants: [{ cta: 'Open your account' }] });
  assert.equal(result.variants[0].performance, 71);
  assert.equal(result.requestId, 'req-1');
  assert.equal(result.source, 'live');
});

test('optimize polls /v1/jobs/{id} until completed and ranks alternatives', async () => {
  let polls = 0;
  const id = 'job_' + 'b'.repeat(32);
  const f = fakeFetch([
    { method: 'POST', match: /\/v1\/optimize/, reply: () => json(202, { id, kind: 'optimize', status: 'running' }) },
    { method: 'GET', match: /\/v1\/jobs\//, reply: () => ++polls < 2 ? json(200, { id, status: 'running' })
      : json(200, optimizeJob(id, [{ rank: 2, touchpoints: { cta: 'B' }, performance: 70 }, { rank: 1, touchpoints: { cta: 'A' }, performance: 80 }], { touchpoints: { cta: 'Go' }, performance: 60 })) },
  ]);
  const { result } = await API.optimize({ key: 'k', fetchImpl: f, sleepImpl: noSleep, channel: 'WEB_PAGE', accountName: 'Acme', variant: { cta: 'Go now please' } });
  assert.equal(polls, 2);
  assert.deepEqual(result.alternatives.map(a => a.touchpoints.cta), ['A', 'B']);
  assert.equal(result.control.performance, 60);
});

test('validation mirrors the spec and blocks the request locally', async () => {
  const f = fakeFetch([]);
  await assert.rejects(API.optimize({ key: 'k', fetchImpl: f, channel: 'WEB_PAGE', accountName: '', variant: { subject_line: 'x' } }),
    e => e.kind === 'invalid_request' && /account.name/.test(e.message) && /subject_line/.test(e.message));
  assert.equal(f.calls.length, 0);
  assert.throws(() => API.buildScoreRequest({ channel: 'WEB_PAGE', accountName: 'A', variants: [{ cta: 'a' }, { cta: 'b' }, { cta: 'c' }, { cta: 'd' }, { cta: 'e' }] }), /1 to 4/);
});

test('errors: 401 invalid key, 429 quota_exhausted not retried, 429 rate_limited retried', async () => {
  const f401 = fakeFetch([{ match: /./, reply: () => json(401, { error: { code: 'unauthorized', message: 'bad key', requestId: 'r' } }) }]);
  await assert.rejects(API.testConnection({ key: 'x', fetchImpl: f401 }), e => e.kind === 'invalid_key' && e.requestId === 'r');

  const fq = fakeFetch([{ match: /./, reply: () => json(429, { error: { code: 'quota_exhausted', message: 'Run quota exhausted' } }) }]);
  await assert.rejects(API.score({ key: 'x', fetchImpl: fq, sleepImpl: noSleep, channel: 'WEB_PAGE', accountName: 'A', variants: [{ cta: 'Go' }] }), e => e.kind === 'quota_exhausted');
  assert.equal(fq.calls.length, 1);

  let n = 0;
  const fr = fakeFetch([{ match: /./, reply: () => ++n < 3 ? json(429, { error: { code: 'rate_limited', message: 'slow down', retryAfterSeconds: 1 } }) : json(200, { defaultChannel: 'EMAIL_SUBJECT', channels: [{ key: 'WEB_PAGE' }], limits: { maxWaitSeconds: 50 } }) }]);
  const slept = [];
  const r = await API.testConnection({ key: 'x', fetchImpl: fr, sleepImpl: async (ms) => slept.push(ms) });
  assert.equal(r.ok, true);
  assert.deepEqual(slept, [1000, 1000]);
});

test('a failed job surfaces its error and the job id', async () => {
  const id = 'job_' + 'c'.repeat(32);
  const f = fakeFetch([{ method: 'POST', match: /optimize/, reply: () => json(200, { id, status: 'failed', error: { code: 'pii', message: 'personal data', categories: ['EMAIL'] } }) }]);
  await assert.rejects(API.optimize({ key: 'k', fetchImpl: f, channel: 'WEB_PAGE', accountName: 'A', variant: { cta: 'Go' } }),
    e => e.kind === 'personal_data' && e.jobId === id);
});

test('network failure and missing key are typed', async () => {
  await assert.rejects(API.testConnection({ key: 'k', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), e => e.kind === 'unreachable');
  await assert.rejects(API.testConnection({ key: '', fetchImpl: fetch }), e => e.kind === 'no_key');
});

test('usage-like response headers are passed through verbatim, nothing else', async () => {
  const f = fakeFetch([{ match: /catalogue/, reply: () => json(200, {}, { 'X-Quota-Remaining': '42', 'X-Other': 'y' }) }]);
  const r = await API.testConnection({ key: 'k', fetchImpl: f });
  assert.deepEqual(r.usageHeaders, { 'x-quota-remaining': '42' });
});
