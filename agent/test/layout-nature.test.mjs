// Layout/hierarchy/visibility findings must be handled explore-first (UX outcome),
// never prescribed as CSS — the B2 regression. Locks the deterministic classifier
// that anchors the LAYOUT nature so a measurable box doesn't slide back into a
// "just add overflow-x: auto" prescription.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.HOME = mkdtempSync(join(tmpdir(), 'loupe-layout-'));
const { layoutHint } = await import('../dist/ai/target-generator.js');

const session = {
  project: 'NNA', flow: 'F', startedAt: '2026-06-27T12:00:00.000Z', endedAt: '2026-06-27T12:00:30.000Z',
  urlTimeline: [{ url: 'https://nna.test/', timestamp: 0, navigationType: 'initial' }],
  events: [], screenshots: [], viewport: { width: 1280, height: 720 }, browser: { userAgent: 'node' },
  notes: [{ type: 'transcript', timestamp: 1000, endTimestamp: 2000, text: 'proposal bid is halfway going off the screen and isn\'t fully visible', source: 'audio' }],
};

function finding(over) {
  return { id: over.id, category: over.category ?? 'UX', severity: 'Medium', title: over.title, description: over.description ?? '', whyItMatters: 'w', confidence: 0.9, ...over };
}

test('the B2-style "documents not fully visible" finding is LAYOUT', () => {
  const f = finding({ id: 'pm-002', title: 'Document Visibility Issues', description: 'proposal bid is cut off, content goes off screen', narrationNote: 0 });
  assert.equal(layoutHint(f, session), true);
});

test('hierarchy / space / prioritization findings are LAYOUT', () => {
  const cases = [
    'Documents Not Prioritized',
    'Plans take up too much of the screen',
    'Lack of Option to Hide Architectural Plans',
    'Information hierarchy is inverted',
    'Sidebar panel width crowds the workspace',
    'Content is cramped and cut off',
  ];
  for (const title of cases) {
    assert.equal(layoutHint(finding({ id: title, title }), session), true, `expected LAYOUT: ${title}`);
  }
});

test('pure local-styling findings are NOT LAYOUT (stay prescriptive visual)', () => {
  const negatives = [
    finding({ id: 'c1', title: 'Insufficient color contrast for text', description: 'text color fails 4.5:1 against its background' }),
    finding({ id: 'c2', title: 'Button border radius inconsistent', description: 'radius differs between primary and secondary buttons' }),
    finding({ id: 'c3', title: 'Heading font weight too light', description: 'headings use 400 where 600 is expected' }),
  ];
  for (const f of negatives) {
    assert.equal(layoutHint(f, { ...session, notes: [] }), false, `expected NOT layout: ${f.title}`);
  }
});
