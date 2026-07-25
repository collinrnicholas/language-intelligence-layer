// Duplicate BUILD findings keep reappearing when one concern is split across
// topic buckets / categories (a Content finding vs a UX one), or narrated across
// consecutive sentences. These lock the collapse behavior: same-concern findings
// merge into one; genuinely distinct findings on the same element do NOT.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.HOME = mkdtempSync(join(tmpdir(), 'loupe-dedup-'));
const { classifyAndMerge } = await import('../dist/ai/narration.js');

// Session-relative note timestamps (ms). noteToMatch derives seconds from these.
function sessionWithNotes(notes) {
  return {
    project: 'DedupApp',
    flow: 'Plans',
    startedAt: '2026-06-27T12:00:00.000Z',
    endedAt: '2026-06-27T12:01:30.000Z',
    urlTimeline: [{ url: 'https://dedup.test/', timestamp: 0, navigationType: 'initial' }],
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
    severity: over.severity ?? 'High',
    title: over.title,
    description: over.description ?? 'desc',
    whyItMatters: 'matters',
    confidence: 0.9,
    narrated: true,
    ...over,
  };
}

test('one concern split across categories + consecutive narration collapses to a single BUILD finding', () => {
  // Reproduces the NNA "Lack of Option to Hide Plans" case: four findings about
  // hiding #plans-section, narrated across adjacent segments, split UX/Content/DS.
  const session = sessionWithNotes([
    { type: 'transcript', timestamp: 24000, endTimestamp: 27000, text: 'these take up too much of the screen', source: 'audio' }, // 0
    { type: 'transcript', timestamp: 27000, endTimestamp: 31000, text: 'there is no way to hide it', source: 'audio' },           // 1
    { type: 'transcript', timestamp: 51000, endTimestamp: 54000, text: 'the doc panel is overlapping', source: 'audio' },         // 2
  ]);

  const findings = [
    finding({ id: 'f1', category: 'UX', title: 'Plans section takes up too much screen space', selector: '#plans-section', narrationNote: 0 }),
    finding({ id: 'f2', category: 'UX', title: 'Lack of Option to Hide Plans', selector: '#plans-section', narrationNote: 1 }),
    finding({ id: 'f3', category: 'Content', title: 'Lack of Option to Hide Plans', narrationNote: 0, generatedTarget: 'Explore the data model and propose 2-3 ranked approaches to hide plans.' }), // no selector — the sparse rep
    finding({ id: 'f4', category: 'Performance', title: 'Documents Overlapping and Not Fully Visible', selector: '#doc-panel', narrationNote: 2 }),
  ];

  const { build } = classifyAndMerge(findings, session);
  const titles = build.map(m => m.title);
  assert.equal(build.length, 2, `expected 2 BUILD findings, got ${build.length}: [${titles.join(' | ')}]`);

  const hide = build.find(m => m.title === 'Lack of Option to Hide Plans');
  assert.ok(hide, `merged "hide plans" finding missing; got [${titles.join(' | ')}]`);
  assert.equal(hide.members.length, 3, 'all three hide-plans findings should merge');
  // Richest fix wins — the Content explore-first target is kept.
  assert.equal(hide.representative.category, 'Content', 'the explore-first Content version should be the representative');

  assert.ok(build.some(m => m.title === 'Documents Overlapping and Not Fully Visible'), 'the distinct doc-panel finding must survive separately');
});

test('distinct findings on the same element with far-apart narration do NOT merge', () => {
  // Same #plans-section, but different concerns and non-adjacent narration —
  // shared selector alone must not collapse them.
  const session = sessionWithNotes([
    { type: 'transcript', timestamp: 10000, endTimestamp: 12000, text: 'the buttons look misaligned here', source: 'audio' }, // 0
    { type: 'transcript', timestamp: 45000, endTimestamp: 47000, text: 'the text contrast is too low', source: 'audio' },     // 1
  ]);

  const findings = [
    finding({ id: 'g1', category: 'Visual Design', title: 'Buttons misaligned', selector: '#plans-section', narrationNote: 0 }),
    finding({ id: 'g2', category: 'Accessibility', title: 'Insufficient color contrast', selector: '#plans-section', narrationNote: 1 }),
  ];

  const { build } = classifyAndMerge(findings, session);
  assert.equal(build.length, 2, `distinct concerns on one element must stay separate, got ${build.length}`);
});
