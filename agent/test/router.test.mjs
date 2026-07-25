import test from 'node:test';
import assert from 'node:assert/strict';

// Routing decisions carry the model on the wire — the tier field is derived
// from it. These tests pin the severity/confidence upgrade to the SENT model,
// so the "computed a tier and dropped it" regression can't come back.

const base = {
  requiresVision: false,
  requiresLongContext: false,
  requiresStructuredOutput: true,
  privacy: 'cloud-ok',
  budget: 'standard',
};

test('explain routes to standard by default', async () => {
  const { route } = await import('../dist/llm/router.js');
  const d = route({ ...base, task: 'explain', severity: 'Medium' });
  assert.equal(d.model, 'standard');
});

test('build always routes to premium', async () => {
  const { route } = await import('../dist/llm/router.js');
  const d = route({ ...base, task: 'build' });
  assert.equal(d.model, 'premium');
});

test('High/Critical severity upgrades the sent model to premium', async () => {
  const { route } = await import('../dist/llm/router.js');
  for (const severity of ['High', 'Critical']) {
    const d = route({ ...base, task: 'explain', severity });
    assert.equal(d.model, 'premium', `severity ${severity} must route premium`);
    assert.equal(d.tier, 'premium');
  }
});

test('low confidence upgrades the sent model to premium', async () => {
  const { route } = await import('../dist/llm/router.js');
  const d = route({ ...base, task: 'explain', severity: 'Low', confidence: 0.5 });
  assert.equal(d.model, 'premium');
});

test('large context upgrades the sent model to premium', async () => {
  const { route } = await import('../dist/llm/router.js');
  const d = route({ ...base, task: 'explain', contextSize: 'large' });
  assert.equal(d.model, 'premium');
});

test('vision upgrades the sent model to premium', async () => {
  const { route } = await import('../dist/llm/router.js');
  const d = route({ ...base, task: 'explain', requiresVision: true });
  assert.equal(d.model, 'premium');
});

test('session understanding routes through the premium tier', async () => {
  // The understanding call frames the product for target generation and UX
  // synthesis — quality-critical. Its exported options must produce a premium
  // routing decision; lowering its severity is a quality regression.
  const { route } = await import('../dist/llm/router.js');
  const { UNDERSTANDING_LLM_OPTIONS } = await import('../dist/ai/session-understanding.js');

  const d = route({
    ...base,
    task: 'explain',
    severity: UNDERSTANDING_LLM_OPTIONS.severity,
  });
  assert.equal(d.model, 'premium', 'session understanding must route to the premium model');
});
