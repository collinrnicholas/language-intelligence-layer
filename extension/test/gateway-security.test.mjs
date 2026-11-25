// Security regressions for the local gateway and the shipped extension bundle.
// Audit finding #2: unauthenticated Loupe-era model routes could spend provider
// credits for any local caller. They must stay removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayServer } from '../../gateway/server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = 'x'.repeat(64);
const env = { PERSADO_PROXY_TOKEN: TOKEN };

async function boot(t, service = { dispatch: async () => ({ ok: true }) }) {
  const logs = [];
  const server = createGatewayServer({ service, env, log: l => logs.push(l) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, logs };
}

test('legacy model routes are gone, authenticated or not, and never reach a provider', async t => {
  let dispatched = 0;
  const { base } = await boot(t, { dispatch: async () => { dispatched++; return { ok: true }; } });
  const origFetch = globalThis.fetch;
  for (const path of ['/v1/ai/complete', '/v1/ai/recommend', '/v1/ai/transcribe']) {
    for (const headers of [
      { 'Content-Type': 'text/plain' },                                    // cross-site "simple" request
      { 'Content-Type': 'application/json', 'X-Persado-Token': TOKEN },   // even with a valid token
    ]) {
      const r = await origFetch(base + path, { method: 'POST', headers, body: JSON.stringify({ model: 'o1', messages: [{ role: 'user', content: 'hi' }] }) });
      assert.equal(r.status, 404, `${path} must not exist`);
    }
  }
  assert.equal(dispatched, 0);
});

test('health exposes no credential presence, model ids or provider names', async t => {
  const { base } = await boot(t);
  const body = await (await fetch(base + '/health')).json();
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'service', 'version']);
  assert.doesNotMatch(JSON.stringify(body), /openai|anthropic|gpt|claude|key/i);
});

test('integration endpoint refuses cross-site simple requests before parsing', async t => {
  let dispatched = 0;
  const { base } = await boot(t, { dispatch: async () => { dispatched++; return { ok: true }; } });
  // text/plain with a token is still refused: JSON only.
  const plain = await fetch(base + '/v1/integrations', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Persado-Token': TOKEN }, body: '{"type":"PERSADO_OPTIMIZE"}' });
  assert.equal(plain.status, 415);
  // No token: 401. Web origin: 403.
  assert.equal((await fetch(base + '/v1/integrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"USAGE_GET"}' })).status, 401);
  assert.equal((await fetch(base + '/v1/integrations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Persado-Token': TOKEN, Origin: 'https://evil.test' }, body: '{"type":"USAGE_GET"}' })).status, 403);
  // DNS-rebinding Host.
  const rebound = await new Promise((resolve, reject) => {
    const req = http.request(base + '/v1/integrations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Persado-Token': TOKEN, Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{"type":"USAGE_GET"}');
  });
  assert.equal(rebound, 403);
  assert.equal(dispatched, 0);
});

test('request log carries method, path and status only — no query strings or tokens', async t => {
  const { base, logs } = await boot(t);
  await fetch(base + '/health?token=' + TOKEN);
  await new Promise(r => setTimeout(r, 20));
  assert.ok(logs.length >= 1);
  for (const l of logs) assert.ok(!l.includes(TOKEN) && !l.includes('?'), l);
});

test('gateway source has no model-provider credentials or routes', () => {
  const src = readFileSync(join(ROOT, 'gateway/server.mjs'), 'utf8');
  assert.doesNotMatch(src, /OPENAI_API_KEY|ANTHROPIC_API_KEY|api\.openai\.com|api\.anthropic\.com/);
});

test('extension bundle contains no provider credentials or provider-key plumbing', () => {
  const files = [];
  const walk = d => { for (const n of readdirSync(d)) {
    if (['test', 'node_modules', 'dist'].includes(n)) continue;
    const p = join(d, n); statSync(p).isDirectory() ? walk(p) : /\.(js|html|json)$/.test(n) && files.push(p);
  } };
  walk(join(ROOT, 'extension'));
  assert.ok(files.length > 5);
  const SECRET = [/sk-[A-Za-z0-9_-]{20,}/, /\b[0-9a-f]{32}-us\d{1,2}\b/, /Bearer\s+[A-Za-z0-9._-]{20,}/];
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const re of SECRET) assert.doesNotMatch(s, re, `${f} matches ${re}`);
    // The browser never calls a provider directly; only the gateway does.
    if (!/persado-api\.js|adapters[\\/]mailchimp\.js|usage\.js|guard\.js/.test(f)) {
      assert.doesNotMatch(s, /Authorization['"]?\s*:/, `${f} sets an Authorization header`);
    }
  }
});
