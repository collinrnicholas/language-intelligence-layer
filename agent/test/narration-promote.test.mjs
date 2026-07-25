// #4 — deterministic-family findings (touch targets, slow requests) may enter
// BUILD, but ONLY when the LLM judge explicitly confirms the reviewer narrated
// them (`narrated === true`). Machine-only signal (console errors) never enters
// BUILD, and keyword/topic fallback is never enough to promote a deterministic one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.HOME = mkdtempSync(join(tmpdir(), 'loupe-promote-'));
const { classifyAndMerge, isJudgeableFinding } = await import('../dist/ai/narration.js');

function sessionWithNotes(notes) {
  return {
    project: 'PromoteApp',
    flow: 'Dash',
    startedAt: '2026-06-27T12:00:00.000Z',
    endedAt: '2026-06-27T12:01:30.000Z',
    urlTimeline: [{ url: 'https://promote.test/', timestamp: 0, navigationType: 'initial' }],
    events: [],
    screenshots: [],
    viewport: { width: 1280, height: 720 },
    browser: { userAgent: 'node-test' },
    notes,
  };
}

function finding(over) {
  return {
    id: over.id,
    category: over.category ?? 'UX',
    severity: over.severity ?? 'Medium',
    title: over.title,
    description: over.description ?? 'desc',
    whyItMatters: 'matters',
    confidence: 0.9,
    ...over,
  };
}

test('a judge-confirmed touch-target finding is promoted into BUILD', () => {
  const session = sessionWithNotes([
    { type: 'transcript', timestamp: 10000, endTimestamp: 13000, text: 'this button is way too tiny to tap', source: 'audio' },
  ]);
  const findings = [
    finding({ id: 'touch-targets', title: 'Touch targets below 44px', narrated: true, narrationNote: 0 }),
  ];
  const { build, detected } = classifyAndMerge(findings, session);
  assert.equal(build.length, 1, 'the narrated touch-target finding should build');
  assert.equal(detected.length, 0);
});

test('a touch-target finding the judge did NOT confirm stays review-only', () => {
  const session = sessionWithNotes([
    { type: 'transcript', timestamp: 10000, endTimestamp: 13000, text: 'the layout looks clean', source: 'audio' },
  ]);
  const findings = [
    finding({ id: 'touch-targets', title: 'Touch targets below 44px', narrated: false }),
  ];
  const { build, detected } = classifyAndMerge(findings, session);
  assert.equal(build.length, 0, 'unconfirmed deterministic findings must not build');
  assert.equal(detected.length, 1);
});

test('keyword overlap alone never promotes a deterministic finding (no judge verdict)', () => {
  // "slow" appears in the transcript, but with no explicit narrated=true the
  // network finding must stay detected — offline artifacts are protected.
  const session = sessionWithNotes([
    { type: 'transcript', timestamp: 5000, endTimestamp: 8000, text: 'this page feels slow to load', source: 'audio' },
  ]);
  const findings = [
    finding({ id: 'slow-requests', title: 'Slow network requests', description: 'requests exceed latency budget' }),
  ];
  const { build, detected } = classifyAndMerge(findings, session);
  assert.equal(build.length, 0, 'topic/keyword fallback must not promote deterministic findings');
  assert.equal(detected.length, 1);
});

test('console errors are never promotable, even when marked narrated', () => {
  const session = sessionWithNotes([
    { type: 'transcript', timestamp: 5000, endTimestamp: 8000, text: 'I saw a console error pop up', source: 'audio' },
  ]);
  const consoleFinding = finding({ id: 'console-errors', title: 'Console errors on load', narrated: true });
  assert.equal(isJudgeableFinding(consoleFinding), false, 'console errors should never be judged');

  const { build, detected } = classifyAndMerge([consoleFinding], session);
  assert.equal(build.length, 0, 'console errors stay review-only regardless of narrated flag');
  assert.equal(detected.length, 1);
});
