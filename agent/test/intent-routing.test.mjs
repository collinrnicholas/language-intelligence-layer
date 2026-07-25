import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Isolate HOME so a developer's real routing-policy.json can't skew results.
const home = mkdtempSync(join(tmpdir(), 'loupe-intent-home-'));
process.env.HOME = home;

// ─── Intent pipelines: who fans out, who doesn't ────────────────

test('Build This never runs persona reviewers', async () => {
  const { intentRuns, pipelineForIntent } = await import('../dist/llm/routing-policy.js');
  assert.equal(intentRuns('buildThis', 'persona-review'), false);
  assert.ok(pipelineForIntent('buildThis').includes('vision-observe'));
  assert.ok(pipelineForIntent('buildThis').includes('synthesize-build-brief'));
});

test('UX Review does not run persona reviewers by default', async () => {
  const { intentRuns } = await import('../dist/llm/routing-policy.js');
  assert.equal(intentRuns('uxReview', 'persona-review'), false);
  assert.equal(intentRuns('uxReview', 'synthesize-opportunities'), true);
});

test('Complete Audit is the only persona-fanout path', async () => {
  const { intentRuns, INTENT_PIPELINES } = await import('../dist/llm/routing-policy.js');
  assert.equal(intentRuns('completeAudit', 'persona-review'), true);
  const fanoutIntents = Object.entries(INTENT_PIPELINES)
    .filter(([, stages]) => stages.includes('persona-review'))
    .map(([name]) => name);
  assert.deepEqual(fanoutIntents, ['completeAudit']);
});

// ─── Router / policy model selection ────────────────────────────

test('router chooses GPT vision for vision tasks', async () => {
  const { resolveModel } = await import('../dist/llm/routing-policy.js');
  for (const intent of ['buildThis', 'uxReview', 'completeAudit']) {
    const model = resolveModel(intent, 'vision');
    assert.match(model, /^gpt-/, `${intent} vision should route to a GPT vision model`);
  }
});

test('router chooses Claude Sonnet for Build This synthesis', async () => {
  const { resolveModel } = await import('../dist/llm/routing-policy.js');
  assert.equal(resolveModel('buildThis', 'reasoning'), 'claude-sonnet-4-6');
});

test('the build-prompt quality gate (judge) is on by default for Build This and Complete Audit', async () => {
  const { resolveModel } = await import('../dist/llm/routing-policy.js');
  // Anything that ships a build prompt keeps a critic pass by default.
  assert.notEqual(resolveModel('buildThis', 'judge'), null);
  assert.notEqual(resolveModel('completeAudit', 'judge'), null);
  // UX Review produces opportunities, not a brief — nothing to judge.
  assert.equal(resolveModel('uxReview', 'judge'), null);
});

test('routing-policy.json overrides deep-merge over defaults (explicit null disables)', async () => {
  const { loadRoutingPolicy, resolveModel, resetRoutingPolicyCache } =
    await import('../dist/llm/routing-policy.js');
  loadRoutingPolicy(); // prime, then invalidate
  mkdirSync(join(home, '.loupe', 'config'), { recursive: true });
  writeFileSync(
    join(home, '.loupe', 'config', 'routing-policy.json'),
    JSON.stringify({ buildThis: { judge: null } }),
  );
  resetRoutingPolicyCache();
  assert.equal(resolveModel('buildThis', 'judge'), null);        // explicitly disabled
  assert.equal(resolveModel('buildThis', 'reasoning'), 'claude-sonnet-4-6'); // untouched
  // Clean up for other tests in this process.
  writeFileSync(join(home, '.loupe', 'config', 'routing-policy.json'), '{}');
  resetRoutingPolicyCache();
});

// ─── Vision output schema ────────────────────────────────────────

const VALID_OBSERVATION = {
  screenshotId: 'shot-0',
  layout: { density: 'high', primaryAction: { text: 'Start Recording' } },
  hierarchy: { primaryFocus: 'plans panel', competingElements: ['sidebar'], clarityScore: 4 },
  visualDesign: { spacingIssues: ['cards touch viewport edge'] },
  targetComparison: {
    targetProvided: true,
    majorDifferences: ['target hides the plans panel'],
    elementsToKeep: ['document list'],
    elementsToChange: ['plans panel'],
    missingFromCurrent: ['collapse control'],
    presentButShouldBeRemoved: [],
  },
  risks: ['plans data may be lazily loaded'],
  confidence: 0.85,
};

test('vision output schema validates well-formed observations', async () => {
  const { parseUIObservations } = await import('../dist/llm/tasks/vision-observe.js');
  const parsed = parseUIObservations(JSON.stringify([VALID_OBSERVATION]));
  assert.ok(parsed);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].screenshotId, 'shot-0');
  assert.equal(parsed[0].targetComparison.targetProvided, true);
});

test('vision output schema rejects malformed observations', async () => {
  const { parseUIObservations } = await import('../dist/llm/tasks/vision-observe.js');
  assert.equal(parseUIObservations('not json at all'), null);
  assert.equal(parseUIObservations(JSON.stringify([{ screenshotId: 'x' }])), null); // missing sections
  assert.equal(
    parseUIObservations(JSON.stringify([{ ...VALID_OBSERVATION, confidence: 3 }])),
    null,
    'confidence outside 0..1 must not validate',
  );
  // Fenced output still parses (models occasionally fence despite instructions).
  const fenced = '```json\n' + JSON.stringify([VALID_OBSERVATION]) + '\n```';
  assert.ok(parseUIObservations(fenced));
});

// ─── Fallback semantics ──────────────────────────────────────────

test('failed synthesis preserves deterministic findings', async () => {
  const { mergeWithDeterministic } = await import('../dist/llm/tasks/synthesize-opportunities.js');
  const det = [{ id: 'det-1', title: 'Console error' }, { id: 'det-2', title: 'Slow request' }];
  assert.deepEqual(mergeWithDeterministic(det, null), det);
  assert.deepEqual(mergeWithDeterministic(det, []), det);
  const merged = mergeWithDeterministic(det, [{ id: 'syn-1', title: 'Hierarchy inverted' }]);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.slice(0, 2), det, 'deterministic findings stay first and unchanged');
});

// ─── Cache stability ─────────────────────────────────────────────

test('vision prompt is deterministic, so cached observations are reused on rerun', async () => {
  // The response cache keys on prompt bytes + image hashes; a byte-stable
  // prompt for identical inputs is what makes the second Build This run hit.
  const { buildVisionPrompt } = await import('../dist/llm/tasks/vision-observe.js');
  const a = buildVisionPrompt(3, true, '- "plans take too much of the screen"');
  const b = buildVisionPrompt(3, true, '- "plans take too much of the screen"');
  assert.equal(a, b);
  assert.notEqual(a, buildVisionPrompt(3, false, '- "plans take too much of the screen"'),
    'target-design presence must change the prompt (and therefore the cache key)');
});
