// Keyframe selection replaces the old earliest/latest 2-frame picker. These lock
// the signals (narrated-issue timestamps, route changes, click bursts), the ≤3 cap,
// index-dedup, and temporal-diversity spread.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.HOME = mkdtempSync(join(tmpdir(), 'loupe-keyframe-'));
const { keyframesForFindings, selectKeyframes } = await import('../dist/ai/keyframes.js');

// Screenshots every 2s, tagged by index so we can assert which were chosen.
function shotsEvery2s(n) {
  return Array.from({ length: n }, (_, i) => ({ timestamp: i * 2000, dataUrl: `frame-${i}` }));
}

function session(over) {
  return {
    project: 'KF', flow: 'F', startedAt: '2026-06-27T12:00:00.000Z', endedAt: '2026-06-27T12:01:00.000Z',
    urlTimeline: [{ url: 'https://kf.test/', timestamp: 0, navigationType: 'initial' }],
    events: [], screenshots: shotsEvery2s(15), viewport: { width: 1280, height: 720 },
    browser: { userAgent: 'node' }, notes: [], ...over,
  };
}

function finding(over) {
  return { id: over.id, category: 'UX', severity: 'High', title: over.title ?? 't', description: 'd', whyItMatters: 'w', confidence: 0.9, ...over };
}

test('caps at 3 frames and dedupes/​spreads by time', () => {
  const s = session({
    notes: [
      { type: 'transcript', timestamp: 4000, endTimestamp: 5000, text: 'issue one', source: 'audio' },   // ~frame-2
      { type: 'transcript', timestamp: 4300, endTimestamp: 5000, text: 'still same area', source: 'audio' }, // near frame-2 → deduped
      { type: 'transcript', timestamp: 20000, endTimestamp: 21000, text: 'issue two', source: 'audio' },  // ~frame-10
    ],
    urlTimeline: [
      { url: 'https://kf.test/', timestamp: 0, navigationType: 'initial' },
      { url: 'https://kf.test/detail', timestamp: 12000, navigationType: 'pushstate' }, // ~frame-6
    ],
  });
  const batch = [
    finding({ id: 'a', narrationNote: 0 }),
    finding({ id: 'b', narrationNote: 1 }),
    finding({ id: 'c', narrationNote: 2 }),
  ];
  const frames = keyframesForFindings(s, batch, 3);
  assert.equal(frames.length, 3, 'must cap at 3');
  assert.equal(new Set(frames).size, 3, 'no duplicate frames');
  // Issue-one (frame-2), issue-two (frame-10), and the route change (frame-6).
  assert.ok(frames.includes('frame-2'), 'first issue frame chosen');
  assert.ok(frames.includes('frame-10'), 'second issue frame chosen');
  assert.ok(frames.includes('frame-6'), 'route-change frame chosen');
});

test('click bursts contribute the settled frame', () => {
  const s = session({
    events: [
      { type: 'click', timestamp: 6000, selector: 'a', x: 0, y: 0, tagName: 'BUTTON', textContent: '' },
      { type: 'click', timestamp: 6800, selector: 'b', x: 0, y: 0, tagName: 'BUTTON', textContent: '' }, // same burst
      { type: 'click', timestamp: 7100, selector: 'c', x: 0, y: 0, tagName: 'BUTTON', textContent: '' }, // burst end ~frame-4 (8000) nearest
    ],
    notes: [{ type: 'transcript', timestamp: 0, endTimestamp: 500, text: 'start', source: 'audio' }],
  });
  const frames = keyframesForFindings(s, [finding({ id: 'a', narrationNote: 0 })], 3);
  // frame-0 (issue at t=0) plus the burst settled frame (~t=7100 → frame-4 at 8000 is nearest? |8000-7100|=900 < |6000-7100|=1100 → frame-4)
  assert.ok(frames.includes('frame-0'));
  assert.ok(frames.includes('frame-4'), 'settled frame after the click burst');
});

test('sparse session still returns one relevant frame', () => {
  const s = session({ notes: [], events: [], urlTimeline: [{ url: 'https://kf.test/', timestamp: 0, navigationType: 'initial' }] });
  const frames = keyframesForFindings(s, [finding({ id: 'a', timestamp: 10000 })], 3);
  assert.equal(frames.length, 1, 'fallback yields exactly one frame');
  assert.equal(frames[0], 'frame-5', 'nearest to the finding timestamp (10000 → frame-5)');
});

test('no screenshots → no frames', () => {
  const frames = keyframesForFindings(session({ screenshots: [] }), [finding({ id: 'a' })], 3);
  assert.deepEqual(frames, []);
});

// Reviewer path: selectKeyframes takes narration-range anchors (no findings yet).
test('moments-based selection uses range anchors plus a diversity frame', () => {
  const s = session({
    urlTimeline: [
      { url: 'https://kf.test/', timestamp: 0, navigationType: 'initial' },
      { url: 'https://kf.test/x', timestamp: 14000, navigationType: 'pushstate' }, // ~frame-7
    ],
  });
  // Earliest + latest narration timestamps, as review.ts supplies them.
  const frames = selectKeyframes(s, [2000, 26000], 3); // ~frame-1 and ~frame-13
  assert.equal(frames.length, 3);
  assert.ok(frames.includes('frame-1'), 'earliest anchor');
  assert.ok(frames.includes('frame-13'), 'latest anchor');
  assert.ok(frames.includes('frame-7'), 'route-change diversity frame');
});

test('moments-based selection with no anchors spreads across the timeline', () => {
  const frames = selectKeyframes(session({ notes: [], events: [] }), [], 3);
  assert.equal(frames.length, 3, 'spread fallback fills up to maxCount');
  // 15 frames → floor(14*0.25)=3, floor(14*0.5)=7, floor(14*0.75)=10
  assert.deepEqual(frames, ['frame-3', 'frame-7', 'frame-10']);
});
