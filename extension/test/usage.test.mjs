import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryStorage } from './helpers.mjs';
await load('usage.js');
const U = globalThis.PERSADO_USAGE;

test('local ledger counts runs and is labelled an estimate', async () => {
  const st = U.makeStore({ storageKey: 'u', quota: 100, storage: memoryStorage() });
  const fp = await U.fingerprint('key-1');
  await st.record(fp, { type: 'run', op: 'score', ok: true, cost: 1 });
  const s = await st.record(fp, { type: 'run', op: 'optimize', ok: true, cost: 5 });
  assert.equal(s.used, 6); assert.equal(s.remaining, 94); assert.equal(s.estimate, true);
  assert.equal(s.requests, 2); assert.equal(s.scoreRuns, 1); assert.equal(s.optimizeRuns, 1);
  assert.ok(s.lastSuccessAt);
});

test('quota_exhausted from Persado is authoritative: remaining 0, not an estimate', async () => {
  const st = U.makeStore({ storageKey: 'u', quota: 100, storage: memoryStorage() });
  const s = await st.record('fp', { type: 'run', op: 'optimize', ok: false, error: { kind: 'quota_exhausted', message: 'x' } });
  assert.equal(s.remaining, 0); assert.equal(s.estimate, false); assert.equal(s.exhausted, true); assert.equal(s.used, 0);
});

test('failed runs are only charged when the job was accepted', async () => {
  const st = U.makeStore({ storageKey: 'u', quota: 100, storage: memoryStorage() });
  await st.record('fp', { type: 'run', op: 'optimize', ok: false, error: { kind: 'unreachable' }, charged: false, cost: 5 });
  const s = await st.record('fp', { type: 'run', op: 'optimize', ok: false, error: { kind: 'job_failed' }, charged: true, cost: 5 });
  assert.equal(s.used, 5); assert.equal(s.failedRequests, 2);
});

test('a different key starts a fresh ledger; the key itself is never stored', async () => {
  const mem = memoryStorage();
  const st = U.makeStore({ storageKey: 'u', quota: 100, storage: mem });
  await st.record(await U.fingerprint('key-A'), { type: 'run', op: 'score', ok: true, cost: 1 });
  const s = await st.get(await U.fingerprint('key-B'));
  assert.equal(s.used, 0);
  assert.ok(!JSON.stringify(mem.data).includes('key-A'));
});

test('concurrent records do not lose increments', async () => {
  const st = U.makeStore({ storageKey: 'u', quota: 100, storage: memoryStorage() });
  await Promise.all(Array.from({ length: 10 }, () => st.record('fp', { type: 'run', op: 'score', ok: true, cost: 1 })));
  assert.equal((await st.get('fp')).used, 10);
});
