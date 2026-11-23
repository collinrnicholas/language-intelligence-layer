import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
await load('url-display.js');
const { displayUrl } = globalThis.PERSADO_URL;

test('the Mailchimp ad URL collapses to one readable line', () => {
  const u = 'https://mailchimp.com/landers/omnichannel-marketing-platform/?igaag=172682213492&igaat=&igacm=216951490833&igacr=8087807432&igakw=mailchimp&igamt=g&ds_c=DEPT_8AU_GOOGLE_SEARCH_USA_EN_BRAND_ACQUIRE_EXACT_CORE_USA&ds_kids=22855110336&gclsrc=aw.ds&gad_source=1&gad_campaignid=216951490833&gbraid=0AAADnlFp38RQ&gclid=CjwKCAiA5Y_Y0BhAcEiwAGDlZzGSVvZFY4vFFrWvQ3';
  const out = displayUrl(u);
  assert.equal(out, 'mailchimp.com/landers/omnichannel-marketing-platform');
  assert.ok(out.length < 60);
});

test('tracking parameters are dropped, real ones survive', () => {
  assert.equal(displayUrl('https://www.acme.com/pricing?utm_source=x&plan=pro'),
    'acme.com/pricing?plan=pro');
  assert.equal(displayUrl('https://acme.com/p?fbclid=abc&ref=nav'), 'acme.com/p');
  // Two parameters is the cap; a third is not worth the width.
  assert.equal(displayUrl('https://acme.com/s?a=1&b=2&c=3'), 'acme.com/s?a=1&b=2');
});

test('scheme, www and a bare root path are dropped', () => {
  assert.equal(displayUrl('https://www.acme.co.uk/'), 'acme.co.uk');
  assert.equal(displayUrl('http://acme.com/a/b/'), 'acme.com/a/b');
});

test('long paths get an ellipsis instead of wrapping', () => {
  const long = displayUrl('https://acme.com/' + 'segment/'.repeat(20));
  assert.ok(long.length <= 64);
  assert.ok(long.endsWith('…'));
});

test('non-web pages keep something sensible', () => {
  assert.equal(displayUrl('about:blank'), 'about:blank');
  assert.equal(displayUrl('chrome-extension://abc/sidepanel.html'), 'chrome-extension://abc/sidepanel.html');
  assert.equal(displayUrl(''), '');
});
