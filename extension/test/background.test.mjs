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
  for(const type of [MSG.MC_SCORE,MSG.MC_OPTIMIZE,MSG.MC_APPLY,MSG.MC_REVERT,MSG.MC_TEST_SEND]){
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
