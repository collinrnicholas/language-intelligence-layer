import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
await load('guard.js');
const G = globalThis.PERSADO_GUARD;

test('protected tokens must survive a rewrite, exactly', () => {
  assert.equal(G.validateRewrite('Hi *|FNAME|*, your deal', 'Hey *|FNAME|*, a fresh deal').ok, true);
  assert.match(G.validateRewrite('Hi *|FNAME|*, your deal', 'Hey there, a fresh deal').reasons.join(), /FNAME/);
  assert.match(G.validateRewrite('See https://a.co/x now', 'See https://b.co/x now').reasons.join(), /a\.co/);
  assert.match(G.validateRewrite('Hi {{first_name}}', 'Hi {{last_name}}').reasons.join(), /first_name/);
});

test('a rewrite may not introduce a new figure or markup', () => {
  assert.match(G.validateRewrite('Save on your order', 'Save 50% on your order').reasons.join(), /50%/);
  assert.equal(G.validateRewrite('Save 20% on your order', 'Take 20% off your order').ok, true);
  assert.match(G.validateRewrite('Shop now', '<b>Shop</b> now').reasons.join(), /markup/);
  assert.match(G.validateRewrite('Shop the spring sale', 'Shop the spring sale').reasons.join(), /identical/);
  assert.match(G.validateRewrite('Shop now', 'Shop the whole spring sale today', { maxLength: 10 }).reasons.join(), /longer/);
});

test('legal, unsubscribe and footer copy is never eligible', () => {
  for (const t of ['Unsubscribe from this list', '*|UNSUB|*', '© 2026 Acme. All rights reserved.', 'Member FDIC. Equal Housing Lender.', 'You are receiving this email because you opted in'])
    assert.equal(G.eligible(t, 'body').ok, false, t);
  assert.equal(G.eligible('Your spring offers are here', 'headline').ok, true);
  assert.equal(G.eligible('*|FNAME|*', 'subject_line').ok, false);
});

test('htmlBlocks finds plain-text blocks and skips head, comments, locked and footer regions', () => {
  const html = `<html><head><title>T</title><style>h1{}</style></head><body>
<h1>Spring offers are here</h1><p>Hello <b>there</b> friend of ours</p>
<p>Plain body copy that is long enough to matter here.</p>
<!-- persado:lock --><p>Locked approved claim copy text</p><!-- /persado:lock -->
<div data-persado-lock><h2>Approved headline do not touch</h2></div>
<td id="templateFooter"><p>Our mailing address is here</p></td>
<a class="mcnButton" href="https://x.co">Shop now</a></body></html>`;
  const b = G.htmlBlocks(html);
  assert.deepEqual(b.map(x => x.text), ['Spring offers are here', 'Plain body copy that is long enough to matter here.', 'Shop now']);
  for (const x of b) assert.equal(html.slice(x.start, x.end), x.raw);
  assert.equal(b[2].cta, true);
  assert.equal(b[2].href, 'https://x.co');
});

test('replaceBlocks changes only the text and re-encodes it', () => {
  const html = '<p>\n  Old &amp; tired copy here\n</p><a href="https://x.co?a=1&amp;b=2">Go</a>';
  const [b] = G.htmlBlocks(html);
  assert.equal(b.text, 'Old & tired copy here');
  const out = G.replaceBlocks(html, [{ ...b, text: 'New & <fresh> copy' }]);
  assert.equal(out, '<p>\n  New &amp; &lt;fresh&gt; copy\n</p><a href="https://x.co?a=1&amp;b=2">Go</a>');
  assert.throws(() => G.replaceBlocks(html.replace('Old', 'Odd'), [{ ...b, text: 'x' }]), /changed/);
});

test('blocks with entities we cannot round-trip are skipped, not mangled', () => {
  assert.equal(G.htmlBlocks('<p>Weird &zwnj; entity in this paragraph text</p>').length, 0);
});
