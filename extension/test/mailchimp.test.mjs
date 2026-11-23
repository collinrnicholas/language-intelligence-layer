import test from 'node:test';
import assert from 'node:assert/strict';
import { load, fakeFetch, json, noSleep, memoryStorage, optimizeJob } from './helpers.mjs';
await load('guard.js', 'persado-api.js', 'activity.js', 'usage.js', 'adapters/mailchimp.js', 'optimizer.js');
const MC = globalThis.PERSADO_ADAPTERS.mailchimp;
const OPT = globalThis.PERSADO_OPTIMIZER;

const HTML = `<!DOCTYPE html><html><head><title>Spring</title></head><body><table><tr><td>
<h1>Our spring collection has landed</h1>
<p>Hi *|FNAME|*, we picked new arrivals we think you will love this season.</p>
<a class="mcnButton" href="https://shop.example.com/spring?utm=x">Shop now</a>
</td></tr><tr><td id="templateFooter"><p>You are receiving this because you opted in. *|UNSUB|*</p></td></tr></table></body></html>`;

/** Stateful fake of the documented Mailchimp endpoints. */
function fakeMailchimp(init = {}) {
  const c = { id: 'abc123', web_id: 9876, type: 'regular', status: 'save', content_type: init.content_type || 'html',
    settings: { title: 'Spring launch', subject_line: 'Our spring collection is here', preview_text: 'See what is new this season for you', from_name: 'Acme', reply_to: 'hi@acme.test' } };
  let html = init.html || HTML;
  const routes = [
    { method: 'GET', match: /\/3\.0\/ping$/, reply: () => json(200, { health_status: "Everything's Chimpy!" }) },
    { method: 'GET', match: /\/3\.0\/\?fields=/, reply: () => json(200, { account_name: 'Acme Test', account_id: 'acc1' }) },
    { method: 'GET', match: /\/campaigns\?status=save/, reply: () => json(200, { campaigns: [{ id: c.id, web_id: c.web_id, type: c.type, status: c.status, content_type: c.content_type, create_time: 't', settings: c.settings }], total_items: 1 }) },
    { method: 'GET', match: /\/campaigns\/abc123\/content/, reply: () => json(200, { html, plain_text: '' }) },
    { method: 'GET', match: /\/campaigns\/abc123\?/, reply: () => json(200, c) },
    { method: 'PATCH', match: /\/campaigns\/abc123$/, reply: (r) => { Object.assign(c.settings, r.body.settings); return json(200, c); } },
    { method: 'PUT', match: /\/campaigns\/abc123\/content$/, reply: (r) => { if (init.failPut) return json(400, { title: 'Bad', detail: 'content rejected' }); html = r.body.html; return json(200, { html }); } },
    { method: 'POST', match: /\/actions\/test$/, reply: () => new Response(null, { status: 204 }) },
  ];
  const f = fakeFetch(routes);
  f.state = { campaign: c, get html() { return html; } };
  return f;
}

test('server prefix comes from the key suffix or an explicit override', () => {
  assert.equal(MC.serverPrefixFor('abcdef-us21'), 'us21');
  assert.equal(MC.serverPrefixFor('abcdef', 'US6'), 'us6');
  assert.throws(() => MC.serverPrefixFor('abcdef'), /server prefix/);
  assert.equal(MC.webIdFromUrl('https://us21.admin.mailchimp.com/campaigns/edit?id=9876'), 9876);
  assert.equal(MC.webIdFromUrl('https://evil.example/campaigns/edit?id=1'), null);
});

test('connect: Basic auth to the right data centre, never a different host', async () => {
  const f = fakeMailchimp();
  const a = MC.create({ apiKey: 'k-us21', fetchImpl: f });
  const r = await a.test();
  assert.equal(r.accountName, 'Acme Test');
  assert.ok(f.calls.every(c => c.url.startsWith('https://us21.api.mailchimp.com/3.0')));
  assert.equal(f.calls[0].headers.Authorization, 'Basic ' + btoa('persado:k-us21'));
});

test('read: subject, preview and one block per touchpoint; footer skipped', async () => {
  const a = MC.create({ apiKey: 'k-us21', fetchImpl: fakeMailchimp() });
  const d = await a.read('abc123');
  assert.deepEqual(d.fields.map(f => f.touchpoint), ['subject_line', 'preheader', 'headline', 'body', 'cta']);
  assert.ok(!d.fields.some(f => /UNSUB|receiving/.test(f.text)));
});

test('builder campaigns: body write-back is off unless enabled', async () => {
  const a = MC.create({ apiKey: 'k-us21', fetchImpl: fakeMailchimp({ content_type: 'template' }) });
  const d = await a.read('abc123');
  assert.deepEqual(d.fields.map(f => f.field), ['subject_line', 'preview_text']);
  assert.match(d.skipped.find(s => s.field === 'body').reason, /builder/);
});

function persado(alternatives) {
  const id = 'job_' + 'd'.repeat(32);
  return fakeFetch([{ method: 'POST', match: /api\.persado\.com\/api\/v1\/optimize/, reply: (r) => { persado.lastBody = r.body; return json(200, optimizeJob(id, alternatives, { touchpoints: r.body.variant, performance: 61 })); } }]);
}

async function run(mc, pf, extra = {}) {
  const usage = memoryStorage(), act = memoryStorage();
  const ledger = globalThis.PERSADO_USAGE.makeStore({ storageKey: 'u', quota: 100, storage: usage });
  const log = globalThis.PERSADO_ACTIVITY.makeLog({ storageKey: 'a', storage: act });
  const adapter = MC.create({ apiKey: 'k-us21', fetchImpl: mc, ...extra });
  const both = async (url, init) => (String(url).includes('persado.com') ? pf : mc)(url, init);
  const snaps = [];
  const out = await OPT.optimizeDraft({ id: 'abc123' }, { adapter, persadoKey: 'pk', account: { accountName: 'Acme' }, fetchImpl: both,
    usage: (ev) => ledger.record('fp', ev), log: (e) => log.add(e), snapshot: (d) => snaps.push(d) });
  return { out, ledger: await ledger.get('fp'), activity: await log.list(), snaps };
}

test('end to end: one Persado run, safe rewrites written back and verified', async () => {
  const mc = fakeMailchimp();
  const pf = persado([{ rank: 1, performance: 84, touchpoints: {
    subject_line: 'Fresh spring arrivals, picked for you', preheader: 'New-season favourites are waiting for you',
    headline: 'Spring is here, and so are your new favourites', body: 'Hi *|FNAME|*, we hand-picked new arrivals for your season ahead.',
    cta: 'See the new arrivals' } }]);
  const { out, ledger, activity, snaps } = await run(mc, pf);
  assert.equal(out.status, 'ok');
  assert.equal(pf.calls.length, 1);
  // Only the field strings went to Persado — never the HTML document.
  const sent = JSON.stringify(pf.calls[0].body);
  assert.ok(!sent.includes('<html') && !sent.includes('UNSUB'));
  assert.deepEqual(pf.calls[0].body.alwaysUse, ['*|FNAME|*']);
  assert.equal(mc.state.campaign.settings.subject_line, 'Fresh spring arrivals, picked for you');
  assert.ok(mc.state.html.includes('<h1>Spring is here, and so are your new favourites</h1>'));
  assert.ok(mc.state.html.includes('href="https://shop.example.com/spring?utm=x">See the new arrivals</a>'));
  assert.ok(mc.state.html.includes('*|UNSUB|*'));
  assert.equal(out.verify.ok, true);
  assert.equal(ledger.optimizeRuns, 1); assert.equal(ledger.used, 5);
  assert.equal(activity[0].persado.jobId, 'job_' + 'd'.repeat(32));
  assert.equal(activity[0].persado.chosenPerformance, 84);
  assert.equal(snaps.length, 1);
  assert.ok(!mc.calls.some(c => /\/actions\/send/.test(c.url)), 'never sends');
});

test('a rewrite that drops a merge tag or adds a figure is not written; the rest is', async () => {
  const mc = fakeMailchimp();
  const pf = persado([{ rank: 1, performance: 80, touchpoints: {
    subject_line: 'Save 40% on spring arrivals', preheader: 'New-season favourites are waiting for you',
    headline: 'Spring is here, and so are your new favourites', body: 'Hello friend, new arrivals await.', cta: 'See the new arrivals' } }]);
  const { out } = await run(mc, pf);
  assert.equal(out.status, 'partial');
  assert.equal(mc.state.campaign.settings.subject_line, 'Our spring collection is here');
  assert.ok(mc.state.html.includes('Hi *|FNAME|*, we picked new arrivals'));
  const why = out.changes.filter(c => !c.applied).flatMap(c => c.reasons).join(' ');
  assert.match(why, /40%/); assert.match(why, /FNAME/);
});

test('nothing safe → nothing written', async () => {
  const mc = fakeMailchimp();
  const pf = persado([]);
  const { out } = await run(mc, pf);
  assert.equal(out.status, 'no_change');
  assert.ok(!mc.calls.some(c => c.method === 'PATCH' || c.method === 'PUT'));
});

test('a failed body write rolls the subject line back', async () => {
  const mc = fakeMailchimp({ failPut: true });
  const pf = persado([{ rank: 1, performance: 84, touchpoints: { subject_line: 'Fresh spring arrivals, picked for you', preheader: 'New-season favourites are waiting for you', headline: 'Spring is here, and so are your new favourites', body: 'Hi *|FNAME|*, we hand-picked new arrivals for your season ahead.', cta: 'See the new arrivals' } }]);
  await assert.rejects(run(mc, pf), /content rejected/);
  assert.equal(mc.state.campaign.settings.subject_line, 'Our spring collection is here');
});

test('non-drafts are refused before Persado is called', async () => {
  const mc = fakeMailchimp(); mc.state.campaign.status = 'schedule';
  const pf = persado([]);
  await assert.rejects(run(mc, pf), /not a draft/);
  assert.equal(pf.calls.length, 0);
});

test('restore puts the original back; test send uses /actions/test only', async () => {
  const mc = fakeMailchimp();
  const a = MC.create({ apiKey: 'k-us21', fetchImpl: mc });
  const orig = mc.state.html;
  await a.restore({ id: 'abc123', settings: { subject_line: 'Back', preview_text: 'Before preview text' }, html: orig, bodyWritten: true });
  assert.equal(mc.state.campaign.settings.subject_line, 'Back');
  const r = await a.sendTest('abc123', ['me@acme.test']);
  assert.deepEqual(r.sentTo, ['me@acme.test']);
  await assert.rejects(a.sendTest('abc123', []), /test e-mail/);
});
