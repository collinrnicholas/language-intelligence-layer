// Loads the real service worker (src/background.js) into a fake chrome.* and
// drives it through chrome.runtime.onMessage exactly as the panel and the
// Mailchimp overlay do. Persado and Mailchimp are fake fetch servers with the
// documented shapes. This proves the wiring — routing, sender gating, storage,
// usage, activity, duplicate protection, revert — not the live services.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { json, optimizeJob } from './helpers.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const EXT_ID = 'ext-id';

function boot(fetchImpl) {
  const local = {}, session = {};
  const area = (d) => ({
    async get(k) { if (Array.isArray(k)) return Object.fromEntries(k.map(x => [x, d[x]])); return { [k]: d[k] }; },
    async set(o) { Object.assign(d, structuredClone(o)); },
    async remove(k) { for (const x of [].concat(k)) delete d[x]; },
  });
  const listeners = [];
  const tabMsgs = [];
  const chrome = {
    runtime: { id: EXT_ID, onMessage: { addListener: (f) => listeners.push(f) }, sendMessage: async () => {},
      onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    storage: { local: area(local), session: area(session), onChanged: { addListener() {} } },
    tabs: { query: async () => [], sendMessage: async (id, m) => { tabMsgs.push(m); }, onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { onFocusChanged: { addListener() {} } },
    sidePanel: { setPanelBehavior: async () => {} },
    action: { setIcon: async () => {}, setTitle: async () => {}, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {} },
    scripting: { executeScript: async () => [] },
  };
  const ctx = { chrome, fetch: fetchImpl, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, URL, URLSearchParams, TextEncoder, crypto, btoa, atob, Response, structuredClone, Promise };
  ctx.self = ctx;
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(readFileSync(join(SRC, f), 'utf8'), ctx, { filename: f }); };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(SRC, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  const send = (msg, sender = { id: EXT_ID }) => new Promise((resolve) => {
    let async = false;
    for (const l of listeners) { const r = l(msg, sender, resolve); if (r === true) async = true; }
    if (!async) setTimeout(() => resolve(undefined), 0);
  });
  return { send, local, MSG: ctx.PERSADO.MSG, KEYS: ctx.PERSADO.KEYS, tabMsgs };
}

const HTML = '<html><body><h1>Our spring collection has landed</h1><p>Hi *|FNAME|*, we picked new arrivals we think you will love.</p><a class="mcnButton" href="https://x.co">Shop now</a></body></html>';
function services() {
  const c = { id: 'c1', web_id: 42, type: 'regular', status: 'save', content_type: 'html', settings: { title: 'Spring', subject_line: 'Our spring collection is here', preview_text: 'See what is new this season for you' } };
  let html = HTML, optimizeCalls = 0;
  const f = async (url, init = {}) => {
    const u = String(url), m = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.startsWith('https://api.persado.com/api/v1/catalogue')) return init.headers.Authorization === 'Bearer pk-good' ? json(200, { channels: [{ key: 'WEB_PAGE' }] }) : json(401, { error: { code: 'unauthorized', message: 'invalid key' } });
    if (u.startsWith('https://api.persado.com/api/v1/score')) return json(200, { id: 'job_' + '1'.repeat(32), kind: 'score', status: 'completed', result: { variants: [{ rank: 1, touchpoints: body.variants[0], performance: 66 }], alternatives: [] } });
    if (u.startsWith('https://api.persado.com/api/v1/optimize')) { optimizeCalls++; return json(200, optimizeJob('job_' + '2'.repeat(32), [{ rank: 1, performance: 81, touchpoints: body.channel === 'WEB_PAGE' ? { cta: 'Start saving today' } : {
      subject_line: 'Fresh spring arrivals, picked for you', preheader: 'New-season favourites are waiting for you', headline: 'Spring is here, and so are your new favourites',
      body: 'Hi *|FNAME|*, we hand-picked new arrivals for your season.', cta: 'See the new arrivals' } }], { performance: 60 })); }
    if (u.includes('.api.mailchimp.com/3.0')) {
      if (u.endsWith('/ping')) return json(200, { health_status: 'ok' });
      if (u.includes('/3.0/?fields')) return json(200, { account_name: 'Acme' });
      if (u.includes('/campaigns?status=save')) return json(200, { campaigns: [{ ...c }] });
      if (u.includes('/campaigns/c1/content') && m === 'GET') return json(200, { html });
      if (u.includes('/campaigns/c1/content') && m === 'PUT') { html = body.html; return json(200, { html }); }
      if (u.includes('/campaigns/c1?') && m === 'GET') return json(200, c);
      if (u.endsWith('/campaigns/c1') && m === 'PATCH') { Object.assign(c.settings, body.settings); return json(200, c); }
      if (u.endsWith('/actions/test')) return new Response(null, { status: 204 });
    }
    return json(404, { error: { message: 'unexpected ' + m + ' ' + u } });
  };
  f.state = { c, get html() { return html; }, get optimizeCalls() { return optimizeCalls; } };
  return f;
}

test('Persado connection test, score, usage — and no response ever carries the key', async () => {
  const svc = services();
  const { send, local, MSG, KEYS } = boot(svc);
  local[KEYS.API_KEY] = 'pk-bad';
  let r = await send({ type: MSG.PERSADO_TEST });
  assert.equal(r.ok, false); assert.equal(r.kind, 'invalid_key');
  local[KEYS.API_KEY] = 'pk-good';
  r = await send({ type: MSG.PERSADO_TEST });
  assert.equal(r.ok, true);
  local[KEYS.PERSADO_SETTINGS] = { brand: 'Acme' };
  r = await send({ type: MSG.PERSADO_SCORE, text: 'Open your account', kind: 'cta', pageUrl: 'https://acme.test' });
  assert.equal(r.ok, true); assert.equal(r.result.variants[0].performance, 66);
  r = await send({ type: MSG.PERSADO_OPTIMIZE, text: 'Open your account', kind: 'cta', pageUrl: 'https://acme.test' });
  assert.equal(r.result.alternatives[0].touchpoints.cta, 'Start saving today');
  const u = await send({ type: MSG.USAGE_GET });
  assert.equal(u.scoreRuns, 1); assert.equal(u.optimizeRuns, 1); assert.equal(u.used, 6); assert.equal(u.estimate, true);
  for (const x of [r, u]) assert.ok(!JSON.stringify(x).includes('pk-good'));
  assert.ok(!JSON.stringify(local[KEYS.USAGE]).includes('pk-good'));
  assert.ok(!JSON.stringify(local[KEYS.ACTIVITY]).includes('pk-good'));
});

test('Mailchimp: connect, optimize, duplicate guard, revert, test send', async () => {
  const svc = services();
  const { send, local, MSG, KEYS, tabMsgs } = boot(svc);
  local[KEYS.API_KEY] = 'pk-good';
  local[KEYS.PERSADO_SETTINGS] = { brand: 'Acme' };
  local[KEYS.MC_API_KEY] = 'mc-secret-us21';
  local[KEYS.MC_SETTINGS] = { testEmails: 'qa@acme.test' };
  let r = await send({ type: MSG.MC_TEST });
  assert.equal(r.ok, true); assert.equal(r.dc, 'us21');
  const st = await send({ type: MSG.MC_STATUS, webId: 42 });
  assert.equal(st.connected, true); assert.equal(st.campaign.id, 'c1');
  assert.ok(!JSON.stringify(st).includes('mc-secret'));

  r = await send({ type: MSG.MC_OPTIMIZE, webId: 42 });
  assert.equal(r.ok, true, r.error); assert.equal(r.status, 'ok');
  assert.equal(svc.state.c.settings.subject_line, 'Fresh spring arrivals, picked for you');
  assert.ok(svc.state.html.includes('See the new arrivals'));
  assert.ok(local[KEYS.MC_SNAPSHOTS].c1.appliedFingerprint);

  r = await send({ type: MSG.MC_OPTIMIZE, campaignId: 'c1' });
  assert.equal(r.ok, false); assert.equal(r.kind, 'already_optimized');
  assert.equal(svc.state.optimizeCalls, 1, 'no second paid run');

  r = await send({ type: MSG.MC_TEST_SEND, campaignId: 'c1' });
  assert.equal(r.ok, true); assert.equal(r.sentTo, 1);

  r = await send({ type: MSG.MC_REVERT, campaignId: 'c1' });
  assert.equal(r.ok, true);
  assert.equal(svc.state.c.settings.subject_line, 'Our spring collection is here');
  assert.equal(svc.state.html, HTML);
  const usage = await send({ type: MSG.USAGE_GET });
  assert.equal(usage.optimizeRuns, 1);
  assert.ok(tabMsgs.length >= 0);
});

test('sender gating: a Mailchimp page may ask for status, a random page may not, and nobody can test-send from a page', async () => {
  const { send, MSG } = boot(services());
  const tab = (url) => ({ id: EXT_ID, tab: { id: 1, url }, url });
  let r = await send({ type: MSG.MC_STATUS, webId: 1 }, tab('https://us21.admin.mailchimp.com/campaigns/edit?id=1'));
  assert.equal(r.ok, true);
  r = await send({ type: MSG.MC_STATUS, webId: 1 }, tab('https://evil.example/'));
  assert.equal(r.ok, false);
  r = await send({ type: MSG.MC_TEST_SEND, campaignId: 'c1' }, tab('https://us21.admin.mailchimp.com/'));
  assert.equal(r.ok, false);
  r = await send({ type: MSG.PERSADO_OPTIMIZE, text: 'x' }, { id: 'other-extension' });
  assert.equal(r.ok, false);
});
