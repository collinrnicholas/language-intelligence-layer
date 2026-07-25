// #2 — reviewers receive the pre-review product frame (gated by confidence) so
// they identify issues with the product's purpose in mind. Locks the injection
// into the shared session-context builder that every reviewer consumes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.HOME = mkdtempSync(join(tmpdir(), 'loupe-revctx-'));
const { buildSessionContext } = await import('../dist/ai/review.js');

const session = {
  project: 'NNA', flow: 'Project', startedAt: '2026-06-27T12:00:00.000Z', endedAt: '2026-06-27T12:00:30.000Z',
  urlTimeline: [{ url: 'https://nna.test/', timestamp: 0, navigationType: 'initial' }],
  events: [], screenshots: [], viewport: { width: 1280, height: 720 }, browser: { userAgent: 'node' },
  notes: [{ type: 'transcript', timestamp: 1000, endTimestamp: 2000, text: 'the plans crowd out the documents', source: 'audio' }],
};

const frame = {
  productType: 'AI document assistant for construction bids',
  primaryUser: 'a contractor', primaryJob: 'assemble a bid',
  keyObjects: ['plans (inputs)', 'documents (outputs)'], topPriorities: ['hide plans'], confidence: 0.8,
};

test('the product frame is injected when confidence clears the gate', () => {
  const ctx = buildSessionContext(session, [], false, frame);
  assert.match(ctx, /PRODUCT CONTEXT/);
  assert.match(ctx, /AI document assistant for construction bids/);
  // Frame appears before the narrated evidence, i.e. reviewers see it up front.
  assert.ok(ctx.indexOf('PRODUCT CONTEXT') < ctx.indexOf('Narrated Evidence'), 'frame precedes evidence');
});

test('no frame is injected below the confidence gate or when absent', () => {
  assert.doesNotMatch(buildSessionContext(session, [], false, { ...frame, confidence: 0.4 }), /PRODUCT CONTEXT/);
  assert.doesNotMatch(buildSessionContext(session, [], false, null), /PRODUCT CONTEXT/);
  assert.doesNotMatch(buildSessionContext(session, [], false), /PRODUCT CONTEXT/);
});
