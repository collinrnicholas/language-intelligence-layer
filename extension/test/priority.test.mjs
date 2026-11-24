import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
await load('priority.js');
const { rank, pagePurpose } = globalThis.PERSADO_PRIORITY;

const page = {
  url: 'https://mendozaunited.example/apply',
  title: 'Apply to Mendoza United',
  primaryCta: 'Apply now',
};

const m = (kind, text, extra = {}) => ({ kind, text, aboveFold: true, prominence: 60, top: 300, ...extra });

test('the page’s primary action starts, not whatever was detected first', () => {
  const materials = [
    m('body', 'We are a club with a long history and many members.', { top: 2400, aboveFold: false }),
    m('headline', 'Join the club'),
    m('cta', 'Apply now'),
  ];
  const order = rank(materials, page);
  assert.equal(order[0].material.text, 'Apply now');
  assert.equal(order[0].startHere, true);
  assert.equal(order.filter(r => r.startHere).length, 1, 'exactly one start-here');
  assert.equal(order[1].material.text, 'Join the club', 'a headline outranks body copy');
});

test('position matters: the same CTA outranks itself when it is above the fold', () => {
  const above = rank([m('cta', 'Talk to sales', { aboveFold: true, top: 400 })], page)[0].score;
  const below = rank([m('cta', 'Talk to sales', { aboveFold: false, top: 5200 })], page)[0].score;
  assert.ok(above > below, `${above} should beat ${below}`);
});

test('a generic CTA loses to a specific one with the same placement', () => {
  const generic = rank([m('cta', 'Learn more')], page)[0].score;
  const specific = rank([m('cta', 'Apply now')], page)[0].score;
  assert.ok(specific > generic);
});

test('a CTA matching the page purpose is boosted', () => {
  const apply = rank([m('cta', 'Apply now')], page)[0];
  const unrelated = rank([m('cta', 'Read the blog')], { ...page, primaryCta: '' })[0];
  assert.ok(apply.score > unrelated.score);
});

test('page purpose is read from the URL and title, never invented', () => {
  assert.equal(pagePurpose({ url: 'https://x.test/apply' }), 'application');
  assert.equal(pagePurpose({ url: 'https://x.test/', title: 'Pricing — Acme' }), 'purchase');
  assert.equal(pagePurpose({ url: 'https://x.test/about', title: 'About us' }), '');
});

test('ranking is deterministic and stable on ties', () => {
  const materials = [m('cta', 'First'), m('cta', 'Second'), m('cta', 'Third')];
  const a = rank(materials, { ...page, primaryCta: '' }).map(r => r.index);
  const b = rank(materials, { ...page, primaryCta: '' }).map(r => r.index);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [0, 1, 2], 'ties keep the scan order');
});

test('an empty scan ranks to an empty list rather than throwing', () => {
  assert.deepEqual(rank([], page), []);
  assert.deepEqual(rank(undefined, undefined), []);
});
