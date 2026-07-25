// Finding relationships turn a flat BUILD list into: a primary action, the design
// principle folded into it (the "why"), and conditional consequences sequenced after
// their primary. These lock the parser's safety rules and the assembly ordering.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.HOME = mkdtempSync(join(tmpdir(), 'loupe-rel-'));
const { parseFindingRelationships } = await import('../dist/ai/finding-relationships.js');
const { orderBuildItems } = await import('../dist/ai/implementation-brief.js');

const IDS = ['hide-plans', 'prioritize-docs', 'clipping'];

function raw(relations) {
  return JSON.stringify({ relations });
}

// ─── parser safety ──────────────────────────────────────────────

test('parses principle + consequence against a primary', () => {
  const map = parseFindingRelationships(raw([
    { id: 'hide-plans', role: 'primary' },
    { id: 'prioritize-docs', role: 'principle', relatesTo: 'hide-plans', note: 'Documents are the primary output.' },
    { id: 'clipping', role: 'consequence', relatesTo: 'hide-plans', note: 'After hiding plans, verify the clipping.' },
  ]), IDS);
  assert.ok(map);
  assert.equal(map.byId.get('prioritize-docs').role, 'principle');
  assert.equal(map.byId.get('clipping').role, 'consequence');
  assert.equal(map.byId.get('clipping').relatesTo, 'hide-plans');
});

test('demotes a relation that points at a non-primary (no chains)', () => {
  const map = parseFindingRelationships(raw([
    { id: 'hide-plans', role: 'primary' },
    { id: 'prioritize-docs', role: 'principle', relatesTo: 'hide-plans' },
    { id: 'clipping', role: 'consequence', relatesTo: 'prioritize-docs' }, // points at a principle → demote
  ]), IDS);
  assert.ok(map);
  assert.equal(map.byId.get('clipping').role, 'primary', 'chained relation demoted to primary');
});

test('breaks a mutual-principle cycle deterministically (first wins), never both folded', () => {
  // Contradictory: each claims to be the other's principle. Demotion promotes the
  // first to primary and folds the second — one related change, nothing dropped.
  const map = parseFindingRelationships(raw([
    { id: 'hide-plans', role: 'principle', relatesTo: 'prioritize-docs' },
    { id: 'prioritize-docs', role: 'principle', relatesTo: 'hide-plans' },
  ]), ['hide-plans', 'prioritize-docs']);
  assert.ok(map);
  const roles = [...map.byId.values()].map(r => r.role);
  assert.equal(roles.filter(r => r === 'primary').length, 1, 'exactly one primary survives');
  assert.equal(roles.filter(r => r === 'principle').length, 1);
});

test('returns null when no relationship was found (all primary)', () => {
  const map = parseFindingRelationships(raw([
    { id: 'hide-plans', role: 'primary' },
    { id: 'prioritize-docs', role: 'primary' },
  ]), ['hide-plans', 'prioritize-docs']);
  assert.equal(map, null);
});

test('ignores unknown ids and defaults unmentioned findings to primary', () => {
  const map = parseFindingRelationships(raw([
    { id: 'ghost', role: 'primary' },
    { id: 'prioritize-docs', role: 'principle', relatesTo: 'hide-plans', note: 'why' },
  ]), IDS);
  assert.ok(map);
  assert.equal(map.byId.has('ghost'), false);
  assert.equal(map.byId.get('hide-plans').role, 'primary'); // unmentioned → primary
});

// ─── assembly ordering ──────────────────────────────────────────

function mf(id, title) {
  return {
    representative: { id, title }, title, members: [{ id }], mergedTitles: [],
    narration: [], selectors: [], screenshotIndexes: [], severity: 'High', confidence: 0.9, key: id,
  };
}

test('folds the principle into its primary and sequences the consequence', () => {
  const build = [mf('hide-plans', 'Hide plans'), mf('prioritize-docs', 'Prioritize documents'), mf('clipping', 'Proposal clipped')];
  const rel = parseFindingRelationships(raw([
    { id: 'hide-plans', role: 'primary' },
    { id: 'prioritize-docs', role: 'principle', relatesTo: 'hide-plans', note: 'Documents are the primary output.' },
    { id: 'clipping', role: 'consequence', relatesTo: 'hide-plans', note: 'Verify clipping after hiding plans.' },
  ]), IDS);

  const items = orderBuildItems(build, rel);
  assert.equal(items.length, 2, 'principle folded out, primary + consequence remain');
  assert.equal(items[0].finding.representative.id, 'hide-plans');
  assert.equal(items[0].kind, 'primary');
  assert.deepEqual(items[0].principleNotes, ['Documents are the primary output.']);
  assert.equal(items[1].finding.representative.id, 'clipping');
  assert.equal(items[1].kind, 'consequence');
  assert.equal(items[1].conditional.afterLabel, 'B1', 'consequence points at the primary label');
});

test('no relationships → flat all-primary list', () => {
  const build = [mf('a', 'A'), mf('b', 'B')];
  const items = orderBuildItems(build, null);
  assert.equal(items.length, 2);
  assert.ok(items.every(it => it.kind === 'primary'));
});
