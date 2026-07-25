// The collapsed Goal-Context + UX-Synthesis output is delimited (not JSON) so a
// large markdown synthesis isn't fragile-escaped. These lock the delimiter parsing.

import test from 'node:test';
import assert from 'node:assert/strict';

const { parseProductReasoning } = await import('../dist/ai/product-reasoning.js');

test('splits goal context and synthesis on their markers', () => {
  const raw = [
    '===GOAL_CONTEXT===',
    'This is the NNA document assistant; plans crowd out the documents users actually need.',
    '===SYNTHESIS===',
    '**Product purpose:** An AI document assistant.',
    '**Root UX problem:** Inverted hierarchy.',
  ].join('\n');
  const { goalContext, synthesis } = parseProductReasoning(raw, true);
  assert.match(goalContext, /NNA document assistant/);
  assert.doesNotMatch(goalContext, /Product purpose/, 'goal context stops at the synthesis marker');
  assert.match(synthesis, /Product purpose:/);
});

test('omits synthesis when synthesis is disabled even if a marker leaks in', () => {
  const raw = '===GOAL_CONTEXT===\nJust the paragraph.\n===SYNTHESIS===\nshould be ignored';
  const { goalContext, synthesis } = parseProductReasoning(raw, false);
  assert.equal(goalContext, 'Just the paragraph.');
  assert.equal(synthesis, null);
});

test('marker-less output is treated as the goal-context paragraph', () => {
  const { goalContext, synthesis } = parseProductReasoning('A bare paragraph with no markers.', true);
  assert.equal(goalContext, 'A bare paragraph with no markers.');
  assert.equal(synthesis, null);
});

test('strips code fences before parsing', () => {
  const raw = '```\n===GOAL_CONTEXT===\nFenced paragraph.\n```';
  const { goalContext } = parseProductReasoning(raw, true);
  assert.equal(goalContext, 'Fenced paragraph.');
});
