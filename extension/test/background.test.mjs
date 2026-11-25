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
import { json } from './helpers.mjs';

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
  const relays = [];
  const chrome = {
    runtime: { id: EXT_ID, onMessage: { addListener: (f) => listeners.push(f) }, sendMessage: async m => { relays.push(m); },
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
  return { send, local, MSG: ctx.PERSADO.MSG, KEYS: ctx.PERSADO.KEYS, tabMsgs, relays };
}

test('worker relays only to paired local gateway and never reads provider keys', async () => {
  const calls=[];
  const {send,local,MSG,KEYS}=boot(async(url,init)=>{calls.push({url,init});return json(200,{ok:true,result:{source:'live'},usage:{hasKey:true}});});
  assert.equal((await send({type:MSG.PERSADO_SCORE,text:'Hello'})).kind,'not_paired');
  local[KEYS.PROXY_TOKEN]='pairing-token';local[KEYS.API_KEY]='legacy-persado';local[KEYS.MC_API_KEY]='legacy-mailchimp';
  local[KEYS.PERSADO_SETTINGS]={brand:'Acme'};
  const r=await send({type:MSG.PERSADO_SCORE,text:'Hello',kind:'headline'});
  assert.equal(r.ok,true);assert.equal(calls.length,1);
  assert.ok(calls[0].url.endsWith('/v1/integrations'));
  assert.equal(calls[0].init.headers['X-Persado-Token'],'pairing-token');
  const payload=JSON.parse(calls[0].init.body);assert.equal(payload.settings.brand,'Acme');
  assert.ok(!calls[0].init.body.includes('legacy-'));
  await send({type:MSG.PERSADO_TEST});assert.equal(local[KEYS.API_KEY],undefined);
  await send({type:MSG.MC_TEST});assert.equal(local[KEYS.MC_API_KEY],undefined);
});

test('sender gating: page contexts have read-only Mailchimp status; paid calls and writes are panel-only', async()=>{
  const {send,local,MSG,KEYS}=boot(async()=>json(200,{ok:true}));local[KEYS.PROXY_TOKEN]='paired';
  const tab=url=>({id:EXT_ID,tab:{id:1,url},url});
  assert.equal((await send({type:MSG.MC_STATUS,webId:42},tab('https://us21.admin.mailchimp.com/campaigns/edit?id=42'))).ok,true);
  assert.equal((await send({type:MSG.MC_STATUS},tab('https://evil.test'))).ok,false);
  for(const type of [MSG.MC_SCORE,MSG.MC_OPTIMIZE,MSG.MC_APPLY,MSG.MC_REVERT,MSG.JOB_RETRY]){
    assert.equal((await send({type},tab('https://us21.admin.mailchimp.com/'))).ok,false);
  }
  assert.equal((await send({type:MSG.PERSADO_SCORE},{id:'another-extension'})).ok,false);
  assert.equal((await send({type:MSG.MC_STATUS},tab(`chrome-extension://${EXT_ID}/sidepanel.html`))).ok,true);
});

test('gateway failure produces actionable feedback without exposing pairing token', async()=>{
  const {send,local,MSG,KEYS}=boot(async()=>{throw Error('network');});
  local[KEYS.PROXY_TOKEN]='private-pairing-token';
  const r=await send({type:MSG.MC_STATUS});assert.equal(r.kind,'gateway_down');
  assert.ok(!JSON.stringify(r).includes('private-pairing-token'));
});

test('concurrent status requests coalesce; edit hints relay without reading content or spending credits', async()=>{
  let reads=0;
  const {send,local,MSG,KEYS,relays}=boot(async()=>{reads++;await new Promise(r=>setTimeout(r,15));return json(200,{ok:true,campaign:{id:'abc'}});});
  local[KEYS.PROXY_TOKEN]='paired';
  const requests=await Promise.all([send({type:MSG.MC_STATUS,webId:42}),send({type:MSG.MC_STATUS,webId:42})]);
  assert.ok(requests.every(r=>r.ok));assert.equal(reads,1);
  const url='https://us5.admin.mailchimp.com/campaigns/edit?id=42';
  const changed=await send({type:MSG.MC_CONTEXT_CHANGED},{id:EXT_ID,url,tab:{id:7,url}});
  assert.equal(changed.ok,true);assert.equal(reads,1,'edit hints must not make an API request themselves');
  assert.ok(relays.some(m=>m.type===MSG.MC_CONTEXT_CHANGED&&m.tabId===7));
  assert.equal((await send({type:MSG.MC_CONTEXT_CHANGED},{id:EXT_ID,url:'https://evil.test',tab:{id:8}})).ok,false);
});

test('job status reads are relayed and coalesced; a stalled gateway reports a timeout, not a lost run', async()=>{
  let reads=0;
  const {send,local,MSG,KEYS}=boot(async(url,init)=>{reads++;assert.equal(JSON.parse(init.body).type,'JOB_STATUS');assert.ok(init.signal);await new Promise(r=>setTimeout(r,10));return json(200,{ok:true,status:'running'});});
  local[KEYS.PROXY_TOKEN]='paired';
  const both=await Promise.all([send({type:MSG.JOB_STATUS,cacheId:'a'.repeat(64)}),send({type:MSG.JOB_STATUS,cacheId:'a'.repeat(64)})]);
  assert.ok(both.every(r=>r.status==='running'));assert.equal(reads,1);
  const stalled=boot(async()=>{throw Object.assign(new Error('aborted'),{name:'AbortError'});});
  stalled.local[stalled.KEYS.PROXY_TOKEN]='paired';
  const r=await stalled.send({type:stalled.MSG.PERSADO_OPTIMIZE,text:'Hi'});
  assert.equal(r.kind,'gateway_timeout');assert.match(r.error,/kept/);
});

test('removed prototype messages are not relayed', async()=>{
  const {send,local,KEYS}=boot(async()=>json(200,{ok:true}));local[KEYS.PROXY_TOKEN]='paired';
  for(const type of ['TRANSCRIBE_AUDIO','CAPTURE_PAGE_CONTEXT','MC_TEST_SEND','USAGE_RESET'])assert.equal(await send({type}),undefined);
});

// The user's guarantee: manual page selection may be more ambitious than the
// automatic rules, but it is not a policy override. These payloads are exactly
// what a manually selected cookie banner, language switcher or legal notice
// would send — including a stale/forged `eligibility` object claiming the copy is
// a primary CTA — and none of them may produce a gateway call.
test('manual selection cannot force cookie, language or legal copy into a billable request', async () => {
  let calls = 0;
  const { send, local, MSG, KEYS } = boot(async () => { calls++; return json(200, { ok: true, result: {} }); });
  local[KEYS.PROXY_TOKEN] = 'paired';

  const protectedCopy = [
    ['Accept all', 'consent'],
    ['Reject all', 'consent'],
    ['Manage cookie preferences', 'consent'],
    ['Cookie settings', 'consent'],
    ['English', 'language'],
    ['Español', 'language'],
    ['EN / ES', 'language'],
    ['Choose your language', 'language'],
    ['USD', 'language'],
    ['Terms of service', 'legal'],
    ['Privacy policy', 'legal'],
    ['Read our privacy policy', 'legal'],
    ['Subject to credit approval. Rates and terms vary by state.', 'legal'],
    ['This notice describes how medical information about you may be used and disclosed.', 'legal'],
    ['I agree to receive marketing emails', 'consent'],
  ];
  const forged = { category: 'primary_cta', autoEligible: true, hardExcluded: false, confidence: 1 };

  for (const [text, category] of protectedCopy) {
    for (const payload of [
      { manual: true, kind: 'cta' },
      { manual: true, kind: 'body' },
      { manual: true, kind: 'cta', eligibility: forged },   // decision laundered
      { manual: false, kind: 'cta' },
      { batch: true, kind: 'cta', eligibility: forged },    // batch laundered
    ]) {
      const r = await send({ type: MSG.PERSADO_SCORE, text, pageUrl: 'https://example.test/', ...payload });
      assert.equal(r.ok, false, `${text} was accepted as ${r.category}`);
      assert.equal(r.kind, 'ineligible', text);
      assert.equal(r.category, category, `${text} reported ${r.category}`);
      assert.equal(calls, 0, `${text} reached the gateway`);
    }
  }

  // The same manual path still works for genuine conversion copy...
  const good = await send({ type: MSG.PERSADO_SCORE, text: 'Apply now', kind: 'cta', manual: true,
    pageUrl: 'https://example.test/apply' });
  assert.equal(good.ok, true);
  // ...and for ambiguous copy the user deliberately chose.
  const ambiguous = await send({ type: MSG.PERSADO_SCORE, text: 'Learn more', kind: 'cta', manual: true,
    pageUrl: 'https://example.test/pricing' });
  assert.equal(ambiguous.ok, true);
  assert.equal(calls, 2);
});

test('an automatic batch cannot carry ambiguous or unclassified copy', async () => {
  let calls = 0;
  const { send, local, MSG, KEYS } = boot(async () => { calls++; return json(200, { ok: true, result: {} }); });
  local[KEYS.PROXY_TOKEN] = 'paired';
  const ambiguous = await send({ type: MSG.PERSADO_SCORE, text: 'Learn more', kind: 'cta', batch: true,
    eligibility: { category: 'unknown', autoEligible: false, hardExcluded: false } });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.kind, 'needs_selection');
  assert.equal(calls, 0);
  const cleared = await send({ type: MSG.PERSADO_SCORE, text: 'Start free trial', kind: 'cta', batch: true,
    eligibility: { category: 'primary_cta', autoEligible: true, hardExcluded: false } });
  assert.equal(cleared.ok, true);
  assert.equal(calls, 1);
});
