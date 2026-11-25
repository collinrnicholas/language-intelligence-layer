import test from 'node:test';
import assert from 'node:assert/strict';
import { load, fakeFetch, json } from './helpers.mjs';
await load('guard.js', 'persado-api.js', 'usage.js', 'adapters/mailchimp.js');
const MC = globalThis.PERSADO_ADAPTERS.mailchimp;

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

test('restore puts the original back; sending is not part of the adapter', async () => {
  const mc = fakeMailchimp();
  const a = MC.create({ apiKey: 'k-us21', fetchImpl: mc });
  const orig = mc.state.html;
  await a.restore({ id: 'abc123', settings: { subject_line: 'Back', preview_text: 'Before preview text' }, html: orig, bodyWritten: true });
  assert.equal(mc.state.campaign.settings.subject_line, 'Back');
  assert.equal(a.sendTest, undefined);
});
