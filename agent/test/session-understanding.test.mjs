// #2 — SessionUnderstanding: the compact product frame derived in analyze before
// target generation. These lock the parser's validation and the confidence gate
// (0.5) that decides whether the frame is allowed to steer generation prompts.

import test from 'node:test';
import assert from 'node:assert/strict';

const { parseSessionUnderstanding, productContextBlock, UNDERSTANDING_CONFIDENCE_GATE } =
  await import('../dist/ai/session-understanding.js');

const GOOD = {
  productType: 'AI document assistant for construction bids',
  primaryUser: 'a contractor preparing a proposal',
  primaryJob: 'assemble a bid from uploaded plans',
  keyObjects: ['plans (inputs)', 'documents (outputs)'],
  invertedOrMissing: 'plans (inputs) dominate the layout over documents (outputs)',
  topPriorities: ['hide the plans', 'put documents front and center'],
  confidence: 0.8,
};

test('parses a well-formed understanding and clamps confidence', () => {
  const u = parseSessionUnderstanding(JSON.stringify({ ...GOOD, confidence: 1.4 }));
  assert.ok(u);
  assert.equal(u.productType, GOOD.productType);
  assert.equal(u.confidence, 1, 'confidence clamps to [0,1]');
  assert.deepEqual(u.topPriorities, GOOD.topPriorities);
});

test('accepts fenced JSON and omits an empty optional field', () => {
  const { invertedOrMissing, ...noInverted } = GOOD;
  const u = parseSessionUnderstanding('```json\n' + JSON.stringify(noInverted) + '\n```');
  assert.ok(u);
  assert.equal('invertedOrMissing' in u, false, 'optional field omitted when absent');
});

test('rejects malformed understanding (missing required fields)', () => {
  assert.equal(parseSessionUnderstanding(JSON.stringify({ productType: 'x' })), null);
  assert.equal(parseSessionUnderstanding('not json at all'), null);
  assert.equal(parseSessionUnderstanding(JSON.stringify({ ...GOOD, confidence: 'high' })), null);
});

test('productContextBlock emits the frame at or above the confidence gate', () => {
  const block = productContextBlock({ ...GOOD, confidence: UNDERSTANDING_CONFIDENCE_GATE });
  assert.match(block, /PRODUCT CONTEXT/);
  assert.match(block, /AI document assistant for construction bids/);
  assert.match(block, /user's top priorities: hide the plans; put documents front and center/);
});

test('productContextBlock is empty below the gate or when absent', () => {
  assert.equal(productContextBlock({ ...GOOD, confidence: 0.49 }), '', 'below gate → no steer');
  assert.equal(productContextBlock(null), '');
  assert.equal(productContextBlock(undefined), '');
});
