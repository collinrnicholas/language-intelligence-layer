// Panel side of the recoverable job lifecycle (src/jobs.js) and the analytics
// adapter (src/analytics.js). Fake worker and storage; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
await load('messages.js', 'jobs.js', 'analytics.js');
const { create, phase, textHash } = globalThis.PERSADO_JOBS;
const A = globalThis.PERSADO_ANALYTICS_LIB;
const { MSG } = globalThis.PERSADO;

function store() {
  const d = {};
  return { d, async get(k) { return { [k]: structuredClone(d[k]) }; }, async set(o) { Object.assign(d, structuredClone(o)); } };
}

test('phase maps real job status to the five UI states, with no invented progress', () => {
  assert.equal(phase({ ok: true, status: 'done', result: {} }), 'done');
  assert.equal(phase({ ok: true, status: 'running' }), 'running');
  assert.equal(phase({ ok: true, status: 'running', stale: true }), 'stale');
  assert.equal(phase({ ok: true, status: 'running', checkFailed: true }), 'stale');
  assert.equal(phase({ ok: false, kind: 'gateway_down' }), 'stale');
  for (const status of ['unknown', 'failed', 'not_found']) assert.equal(phase({ ok: true, status }), 'unavailable');
});

test('a remembered job survives a panel reopen (new instance, same storage) and stores no copy', async () => {
  const s = store(), worker = async () => ({ ok: true, status: 'running' });
  const a = create({ worker, storage: s, key: 'jobs' });
  await a.remember({ cacheId: 'c1', op: 'optimize', surface: 'web', textHash: textHash('Start your trial') });
  assert.ok(!JSON.stringify(s.d).includes('Start your trial'));
  const reopened = create({ worker, storage: s, key: 'jobs' });
  const found = await reopened.find('web', '  Start   your trial ');
  assert.equal(found.length, 1);
  assert.equal(found[0].cacheId, 'c1');
  assert.equal((await reopened.find('mailchimp', 'Start your trial')).length, 0);
});

test('watch polls with short free status reads until done, then forgets the job', async () => {
  const s = store(), sent = [];
  let n = 0;
  const worker = async m => { sent.push(m.type); return ++n < 3 ? { ok: true, status: 'running' } : { ok: true, status: 'done', result: { kind: 'optimize' } }; };
  const j = create({ worker, storage: s, key: 'jobs', sleep: async () => {} });
  await j.remember({ cacheId: 'c2', op: 'optimize', surface: 'web', textHash: 'x' });
  const phases = [];
  const last = await j.watch('c2', { onUpdate: p => phases.push(p) });
  assert.deepEqual(phases, ['running', 'running', 'done']);
  assert.equal(last.status, 'done');
  assert.ok(sent.every(t => t === MSG.JOB_STATUS), 'never a paid message');
  assert.equal((await j.list()).length, 0);
});

test('watch gives up politely after the max window and leaves the job recorded', async () => {
  let t = 0;
  const j = create({ worker: async () => ({ ok: true, status: 'running' }), storage: store(), key: 'jobs',
    now: () => t, sleep: async ms => { t += ms; } });
  await j.remember({ cacheId: 'c3', op: 'optimize', surface: 'web', textHash: 'x', startedAt: 0 });
  const phases = [];
  await j.watch('c3', { onUpdate: p => phases.push(p), startedAt: 0 });
  assert.equal(phases.at(-1), 'stale');
  assert.equal((await j.list()).length, 1);
});

test('watch stops when aborted (panel closed) and an unavailable result is not retried automatically', async () => {
  const sent = [];
  const j = create({ worker: async m => { sent.push(m.type); return { ok: true, status: 'unknown', retry: 'confirm' }; }, storage: store(), key: 'jobs', sleep: async () => {} });
  const r = await j.watch('c4', {});
  assert.equal(r.status, 'unknown');
  assert.deepEqual(sent, [MSG.JOB_STATUS]);
  const signal = { aborted: true };
  assert.equal(await j.watch('c5', { signal }), null);
});

test('retry is explicit and carries the uncertainty acknowledgement', async () => {
  const sent = [];
  const j = create({ worker: async m => { sent.push(m); return { ok: true }; }, storage: store(), key: 'jobs' });
  await j.retry('c6', { confirmUncertain: true });
  assert.deepEqual(sent[0], { type: MSG.JOB_RETRY, cacheId: 'c6', confirmUncertain: true });
});

test('analytics: fixed events, allowlisted props, no free text, local by default', async () => {
  const s = store();
  const a = A.create({ storage: s, key: 'an', endpoint: '' });
  assert.equal(a.mode, 'local');
  await a.track('check_completed', { surface: 'web', touchpoint: 'headline', state: 'good', cached: false,
    text: 'Start your free trial', url: 'https://acme.test/x', email: 'a@b.test', campaignId: 'abc123', kind: 'Has Spaces!' });
  await a.track('made_up_event', { surface: 'web' });
  const ev = await a.dump();
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].props, { surface: 'web', touchpoint: 'headline', state: 'good', cached: false });
  assert.doesNotMatch(JSON.stringify(s.d), /trial|acme|a@b|abc123/);
});

test('analytics: a return visit is recorded on the first open of a later day', async () => {
  const s = store();
  let t = Date.parse('2026-11-20T10:00:00Z');
  const a = A.create({ storage: s, key: 'an', endpoint: '', now: () => t });
  await a.track('panel_opened');
  await a.track('panel_opened');
  t = Date.parse('2026-11-23T09:00:00Z');
  await a.track('panel_opened');
  const names = (await a.dump()).map(e => e.name);
  assert.deepEqual(names, ['panel_opened', 'panel_opened', 'panel_opened', 'return_visit']);
  assert.equal((await a.dump()).at(-1).props.days_since_last, 3);
});

test('analytics: nothing leaves the browser unless an HTTPS endpoint is configured', async () => {
  const posts = [];
  const local = A.create({ storage: store(), key: 'an', endpoint: '', fetchImpl: async (...x) => { posts.push(x); } });
  await local.track('panel_opened');
  assert.equal(posts.length, 0);
  const insecure = A.create({ storage: store(), key: 'an', endpoint: 'http://collector.test', fetchImpl: async (...x) => { posts.push(x); } });
  await insecure.track('panel_opened');
  assert.equal(posts.length, 0);
  assert.equal(A.ANALYTICS_ENDPOINT, '');
});
