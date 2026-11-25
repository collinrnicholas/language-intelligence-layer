// ─── Eligibility policy: measured, not asserted ──────────────────────────────
//
// Two things are tested here:
//   1. the policy's decisions on a hand-labelled fixture set (precision, recall,
//      primary-CTA accuracy, hard-exclusion false positives), and
//   2. the billable boundary: every labelled hard exclusion is pushed through the
//      same gate background.js uses, and none of them may pass — not even as a
//      manual selection.
//
// The fixtures are representative page shapes across ecommerce, checkout, SaaS,
// banking, healthcare, education, nonprofit, lead generation, content and an
// authenticated app shell. Passing them is evidence about these rules, not proof
// that no real page will ever be misread; the report prints what remains unknown.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
import { ROWS, HOLDOUT, PRIMARY_CTA_IDS, AMBIGUOUS } from './fixtures/eligibility-dataset.mjs';

await load('eligibility.js');
const E = globalThis.PERSADO_ELIGIBILITY;

const classifyRow = (r) => E.classify({ ...r, pageType: r.page?.pageType || 'unknown' });

function measure(rows) {
  let tp = 0, predicted = 0, labelledAuto = 0;
  const falsePositives = [], falseNegatives = [], hardLeaks = [], wrongCategory = [];
  for (const r of rows) {
    const d = classifyRow(r);
    if (r.expect.hard) {
      if (!d.hardExcluded) hardLeaks.push({ id: r.id, got: d.category });
      continue;
    }
    if (r.expect.auto) {
      labelledAuto++;
      if (d.autoEligible) tp++;
      else falseNegatives.push({ id: r.id, expected: r.expect.category, got: d.category, confidence: d.confidence });
    }
    if (d.autoEligible) {
      predicted++;
      if (!r.expect.auto) falsePositives.push({ id: r.id, got: d.category });
    }
    if (r.expect.category !== d.category) wrongCategory.push({ id: r.id, expected: r.expect.category, got: d.category });
  }
  return {
    rows: rows.length,
    labelledAuto,
    precision: predicted ? tp / predicted : 1,
    recall: labelledAuto ? tp / labelledAuto : 1,
    falsePositives, falseNegatives, hardLeaks, wrongCategory,
  };
}

const REPORT = { tuned: measure(ROWS), holdout: measure(HOLDOUT) };
const fmt = (m) => `P=${m.precision.toFixed(3)} R=${m.recall.toFixed(3)} ` +
  `(fp ${m.falsePositives.length}, fn ${m.falseNegatives.length}, hard leaked ${m.hardLeaks.length})`;

test('report: detection quality on the labelled set', () => {
  console.log('  tuned   rows ' + REPORT.tuned.rows + '  ' + fmt(REPORT.tuned));
  console.log('  holdout rows ' + REPORT.holdout.rows + '  ' + fmt(REPORT.holdout));
  if (REPORT.holdout.falseNegatives.length) {
    console.log('  holdout uncertain: ' + REPORT.holdout.falseNegatives.map(f => f.id).join(', '));
  }
});

test('no hard-excluded example is ever automatically included', () => {
  assert.deepEqual(REPORT.tuned.hardLeaks, []);
  assert.deepEqual(REPORT.holdout.hardLeaks, []);
});

test('eligible-content precision and recall hold on the labelled set', () => {
  assert.ok(REPORT.tuned.precision >= 0.95, `precision ${REPORT.tuned.precision}`);
  assert.ok(REPORT.tuned.recall >= 0.95, `recall ${REPORT.tuned.recall}`);
  // Held-out wording is reported, and must not regress into noise.
  assert.ok(REPORT.holdout.precision >= 0.95, `holdout precision ${REPORT.holdout.precision}`);
  assert.ok(REPORT.holdout.recall >= 0.8, `holdout recall ${REPORT.holdout.recall}`);
});

test('the page\'s primary conversion action is identified, not just any button', () => {
  let hit = 0;
  const misses = [];
  for (const id of PRIMARY_CTA_IDS) {
    const r = ROWS.find((x) => x.id === id);
    const d = classifyRow(r);
    if (d.category === 'primary_cta' && d.autoEligible) hit++;
    else misses.push({ id, got: d.category, confidence: d.confidence });
  }
  const accuracy = hit / PRIMARY_CTA_IDS.length;
  console.log(`  primary CTA accuracy ${(accuracy * 100).toFixed(1)}% (${hit}/${PRIMARY_CTA_IDS.length})`);
  assert.ok(accuracy >= 0.95, `accuracy ${accuracy}; misses ${JSON.stringify(misses)}`);
});

test('the named false positives are excluded at every confidence', () => {
  const cases = [
    ['English', 'language'], ['Español', 'language'], ['EN / ES', 'language'],
    ['Accept all', 'consent'], ['Manage preferences', 'consent'], ['Cookie settings', 'consent'],
    ['Projects', 'navigation'], ['Space', 'navigation'], ['New chat', 'navigation'], ['Explore', 'navigation'],
    ['Settings', 'functional_control'], ['Search', 'functional_control'],
    ['Log in', 'auth_control'], ['Verify your email', 'auth_control'],
    ['Accessibility statement', 'accessibility'], ['I\'m not a robot', 'security_check'],
    ['Terms of service', 'legal'], ['Payment failed', 'system_message'],
  ];
  for (const [text, expected] of cases) {
    const d = E.classify({ text, kind: 'cta', pageType: 'authenticated_app', landmarks: { nav: true } });
    assert.equal(d.category, expected, text);
    assert.equal(d.hardExcluded, expected === 'navigation' || expected === 'functional_control' ? false : true, text);
    assert.equal(d.autoEligible, false, text);
  }
});

test('conversion copy survives the same rules', () => {
  const cases = [
    ['Apply now', 'marketing_landing', 'primary_cta'],
    ['Add to cart', 'ecommerce', 'primary_cta'],
    ['Donate $50', 'fundraising', 'primary_cta'],
    ['Book a demo', 'marketing_landing', 'primary_cta'],
    ['Accept payments online', 'marketing_landing', 'primary_cta'],
    ['Start your application', 'application', 'primary_cta'],
  ];
  for (const [text, pageType, expected] of cases) {
    const d = E.classify({ text, kind: 'cta', pageType, tag: 'button', landmarks: { main: true }, aboveFold: true });
    assert.equal(d.category, expected, text);
    assert.equal(d.autoEligible, true, text);
  }
});

test('page type is read from structure, not from a hostname list', () => {
  assert.equal(E.pageType({ path: '/checkout/payment' }), 'checkout');
  assert.equal(E.pageType({ path: '/apply', applicationForm: true }), 'application');
  assert.equal(E.pageType({ price: true, cart: true }), 'ecommerce');
  assert.equal(E.pageType({ donation: true }), 'fundraising');
  assert.equal(E.pageType({ leadForm: true }), 'lead_generation');
  assert.equal(E.pageType({ ariaCurrent: true, navLabels: ['Projects', 'New chat', 'Explore', 'Settings'] }), 'authenticated_app');
  assert.equal(E.pageType({ marketingHero: true }), 'marketing_landing');
  assert.equal(E.pageType({ article: true }), 'content');
});

test('the billable gate refuses every hard exclusion, manual or not', () => {
  for (const r of [...ROWS, ...HOLDOUT].filter((x) => x.expect.hard)) {
    const text = r.text, kind = r.kind || 'cta';
    for (const manual of [false, true]) {
      const v = E.gate({ text, kind, manual, eligibility: classifyRow(r) });
      assert.equal(v.ok, false, `${r.id} manual=${manual} reached a billable call as ${v.category}`);
      assert.notEqual(v.kind, 'ok');
    }
  }
});

test('automatic runs may only carry auto-eligible copy', () => {
  const ambiguous = [...ROWS, ...HOLDOUT].filter((r) => !r.expect.hard && !r.expect.auto);
  for (const r of ambiguous) {
    const decision = classifyRow(r);
    const auto = E.gate({ text: r.text, kind: r.kind || 'cta', batch: true, eligibility: decision });
    assert.equal(auto.ok, false, `${r.id} was queued automatically`);
    // The same copy can still be checked deliberately, if the policy does not exclude it.
    const manual = E.gate({ text: r.text, kind: r.kind || 'cta', manual: true, eligibility: decision });
    assert.equal(manual.ok, true, `${r.id} could not be selected manually`);
  }
  console.log(`  ambiguous rows stay selectable, never automatic: ${AMBIGUOUS.length}`);
});

test('eligible copy passes the gate with its category intact', () => {
  const r = ROWS.find((x) => x.id === 'ec-add-to-cart');
  const v = E.gate({ text: r.text, kind: 'cta', batch: true, eligibility: classifyRow(r) });
  assert.equal(v.ok, true);
  assert.equal(v.category, 'primary_cta');
});

test('partition separates queueable, ambiguous and excluded material', () => {
  const materials = [
    { text: 'Apply now', kind: 'cta', eligibility: E.classify({ text: 'Apply now', kind: 'cta', pageType: 'application', tag: 'button', landmarks: { main: true } }) },
    { text: 'Learn more', kind: 'cta', eligibility: E.classify({ text: 'Learn more', kind: 'cta', pageType: 'marketing_landing', tag: 'a', landmarks: { main: true } }) },
    { text: 'Accept all', kind: 'cta', eligibility: E.classify({ text: 'Accept all', kind: 'cta', hint: 'cookie-banner' }) },
  ];
  const { eligible, uncertain, excluded } = E.partition(materials);
  assert.equal(eligible.length, 1);
  assert.equal(uncertain.length, 1);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].decision.category, 'consent');
});

test('a forged or stale decision cannot launder protected copy into a manual run', () => {
  const forged = { category: 'primary_cta', autoEligible: true, hardExcluded: false, confidence: 1, reason: 'hero cta' };
  for (const [text, category] of [
    ['Accept all', 'consent'],
    ['English', 'language'],
    ['Español', 'language'],
    ['Terms of service', 'legal'],
    ['Read our privacy policy', 'legal'],
  ]) {
    for (const payload of [
      { text, kind: 'cta', manual: true, eligibility: forged },
      { text, kind: 'body', manual: true, eligibility: forged },
      { text, kind: 'cta', batch: true, eligibility: forged },
    ]) {
      const v = E.gate(payload);
      assert.equal(v.ok, false, text);
      assert.equal(v.category, category, text);
      assert.match(v.message, /does not send/, text);
    }
  }
});
