import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Isolated HOME — memory lives under ~/.loupe/projects/<p>/memory/.
const home = mkdtempSync(join(tmpdir(), 'loupe-memory-home-'));
process.env.HOME = home;

const PROJECT = 'MemTest';

function finding(over = {}) {
  return {
    id: over.id ?? 'f-1',
    category: 'UX',
    severity: 'High',
    title: 'Plans panel crowds out the document workspace',
    description: 'The plans panel takes most of the viewport.',
    page: 'https://app.example.com/project/42?token=SECRET#frag',
    timestamp: 1000,
    selector: '#plans-section',
    whyItMatters: 'Documents are the primary output.',
    suggestedFix: 'Allow hiding the plans panel.',
    confidence: 0.9,
    ...over,
  };
}

function session(over = {}) {
  return {
    project: PROJECT,
    flow: 'project page',
    startedAt: '2026-07-01T00:00:00Z',
    endedAt: '2026-07-01T00:02:00Z',
    urlTimeline: [{ url: 'https://app.example.com/project/42?token=SECRET', timestamp: 0, navigationType: 'initial' }],
    events: [],
    screenshots: [],
    viewport: { width: 1440, height: 900 },
    browser: { userAgent: 'test' },
    notes: [{ type: 'transcript', timestamp: 10, text: 'plans take too much of the screen' }],
    ...over,
  };
}

// Fake run dir so `mark` can resolve findings and `index` can rebuild.
// `raw: true` writes session.loupe as a bare LoupeSession (verbatim-copy shape)
// instead of the `{ session }` wrapper — analyze accepts both, so must rebuild.
function writeRun(runId, findings, { raw = false } = {}) {
  const dir = join(home, '.loupe', 'projects', PROJECT, 'runs', runId, 'analysis');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'opportunities.json'), JSON.stringify({
    version: 2, runId, sessionFile: 'session.loupe', reportFile: 'report.html',
    screenshots: [], opportunities: findings, generatedAt: new Date().toISOString(),
  }));
  writeFileSync(join(dir, 'session.loupe'), JSON.stringify(raw ? session() : { session: session() }));
}

// ─── Signature: deterministic recurrence ────────────────────────

test('signature is stable across runs and phrasing variants', async () => {
  const { findingSignature } = await import('../dist/memory/index.js');
  const a = findingSignature(finding({ id: 'a' }));
  const b = findingSignature(finding({ id: 'b', description: 'different words entirely' }));
  assert.equal(a, b, 'same element+category+page ⇒ same signature regardless of run/id');
  assert.ok(!a.includes('token=SECRET'), 'signatures never carry query strings');

  const otherElement = findingSignature(finding({ selector: '#sidebar' }));
  assert.notEqual(a, otherElement);
});

test('different issues on the same selector get different signatures', async () => {
  const { findingSignature } = await import('../dist/memory/index.js');
  const crowding = findingSignature(finding({ title: 'Plans panel crowds out the document workspace' }));
  const contrast = findingSignature(finding({ title: 'Plans panel text fails contrast requirements' }));
  assert.notEqual(crowding, contrast, 'same #plans-section, different problems ⇒ distinct patterns');
});

test('selector-less findings key on stemmed title words', async () => {
  const { findingSignature, signaturesLikelySame } = await import('../dist/memory/index.js');
  const a = findingSignature(finding({ selector: '', evidence: undefined, title: 'Plans panel crowding the documents' }));
  const b = findingSignature(finding({ selector: '', evidence: undefined, title: 'Plan panels crowd document' }));
  assert.equal(a, b, 'stemming makes grammatical variants agree');
  // A variant with one extra content word is a different exact key but must
  // still be recognized as likely-same by the loose matcher (log auditing).
  const c = findingSignature(finding({ selector: '', evidence: undefined, title: 'Plan panels crowd document area' }));
  assert.ok(signaturesLikelySame(a, c));
});

// ─── Lifecycle: record → mark → patterns ────────────────────────

test('analyze/mark lifecycle produces recurrence patterns and suppression', async () => {
  const mem = await import('../dist/memory/index.js');

  const f1 = finding({ id: 'r1-f1', narrated: true, narrationNote: 0 });
  const f2 = finding({ id: 'r2-f1' });
  writeRun('run-1', [f1]);
  writeRun('run-2', [f2]);

  mem.recordAnalyzeRun(session(), 'run-1', 'review', [f1], null);
  mem.recordAnalyzeRun(session(), 'run-2', 'review', [f2], null);

  const patterns = mem.derivePatterns(mem.loadOpportunityEvents(PROJECT));
  assert.equal(patterns.length, 1, 'same issue in two runs is ONE pattern');
  assert.equal(patterns[0].occurrences, 2);
  assert.equal(patterns[0].status, 'open');

  // Reject it with a reason → suppression + preference hint.
  const marked = mem.markOpportunity(PROJECT, 'run-2', 'r2-f1', 'rejected', 'Plans panel is contractual, do not hide it');
  assert.ok(marked);
  const digest = mem.generateDigest(PROJECT);
  assert.match(digest, /Prior rejections \(caution\)/);
  assert.match(digest, /\[once\]/, 'single rejection is labeled as a weak signal');
  assert.match(digest, /current narration always wins/i, 'rejections yield to current narration');
  assert.match(digest, /do not hide it/);

  const prefs = mem.loadPreferences(PROJECT);
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0].strength, 'hint', 'a single rejection seeds a hint, never a rule');
});

test('built then re-observed becomes REGRESSED', async () => {
  const mem = await import('../dist/memory/index.js');
  const f3 = finding({ id: 'r3-f1' });
  writeRun('run-3', [f3]);
  mem.recordBuilt(PROJECT, 'run-2', [finding({ id: 'r2-f1' })]);
  mem.recordAnalyzeRun(session(), 'run-3', 'review', [f3], null);

  const patterns = mem.derivePatterns(mem.loadOpportunityEvents(PROJECT));
  assert.equal(patterns[0].status, 'regressed', 'observation after built re-opens as regression');
  const digest = mem.generateDigest(PROJECT);
  assert.match(digest, /REGRESSED after a fix/);
});

// ─── Confidence levels + decay ──────────────────────────────────

test('promotion: 1 signal = hint, 2 = pattern, 3+ = rule; explicit --rule is a rule', async () => {
  const { effectiveStrength } = await import('../dist/memory/index.js');
  const recent = ['r1', 'r2', 'r3'];
  const base = { id: 'p', statement: 's', source: 'rejection', strength: 'hint', lastSeenRunId: 'r3', at: '' };
  assert.equal(effectiveStrength({ ...base, evidence: ['a'] }, recent), 'hint');
  assert.equal(effectiveStrength({ ...base, evidence: ['a', 'b'] }, recent), 'pattern');
  assert.equal(effectiveStrength({ ...base, evidence: ['a', 'b', 'c'] }, recent), 'rule');
  assert.equal(effectiveStrength({ ...base, source: 'explicit', strength: 'rule', evidence: [] }, recent), 'rule');
});

test('stale preferences decay one level; stale hints drop out', async () => {
  const { effectiveStrength } = await import('../dist/memory/index.js');
  // 5+ recent runs, none of which reinforced the preference.
  const recent = ['r10', 'r11', 'r12', 'r13', 'r14'];
  const stale = { id: 'p', statement: 's', source: 'rejection', lastSeenRunId: 'r1', at: '' };
  assert.equal(effectiveStrength({ ...stale, strength: 'hint', evidence: ['a', 'b', 'c'] }, recent), 'pattern', 'rule decays to pattern');
  assert.equal(effectiveStrength({ ...stale, strength: 'hint', evidence: ['a'] }, recent), null, 'stale hint is dropped');
});

// ─── Digest: redaction, cap, injection ──────────────────────────

test('digest redacts secrets and never carries query strings', async () => {
  const { redact } = await import('../dist/memory/index.js');
  const dirty = 'key sk-abc12345678 and Bearer abcdefgh1234 mail a@b.co url https://x.y/p?tok=z';
  const clean = redact(dirty);
  assert.doesNotMatch(clean, /sk-abc/);
  assert.doesNotMatch(clean, /abcdefgh1234/);
  assert.doesNotMatch(clean, /a@b\.co/);
  assert.doesNotMatch(clean, /tok=z/);
});

test('memoryPromptBlock returns only requested sections, empty when no memory', async () => {
  const mem = await import('../dist/memory/index.js');
  mem.generateDigest(PROJECT);
  const block = mem.memoryPromptBlock(PROJECT, ['Prior rejections (caution)']);
  assert.match(block, /PROJECT MEMORY/);
  assert.match(block, /never cite it as something observed in THIS session/);
  assert.match(block, /Do NOT add BUILD changes solely\nfrom memory/, 'hard current-session-wins rule present');
  assert.match(block, /Prior rejections/);
  assert.doesNotMatch(block, /## Preferences/, 'unrequested sections stay out');

  assert.equal(mem.memoryPromptBlock('NoSuchProject', ['Preferences']), '');
});

// ─── Rebuild from runs (the delete guarantee) ───────────────────

test('memory index rebuilds from runs/ (both session.loupe shapes) and preserves surviving events', async () => {
  const mem = await import('../dist/memory/index.js');
  const before = mem.loadOpportunityEvents(PROJECT).filter(e => e.event === 'rejected').length;
  assert.ok(before > 0);

  // Historical runs copied verbatim store a RAW LoupeSession — must rebuild too.
  writeRun('run-4-raw', [finding({ id: 'r4-f1' })], { raw: true });
  // Fast-path builds have synthetic run ids with no run directory — must survive.
  mem.recordFastBuild(session(), [finding({ id: 'fast-f1' })]);

  const { runs } = mem.rebuildFromRuns(PROJECT);
  assert.equal(runs, 4, 'all fixture runs re-indexed, including the raw-shape session');
  const events = mem.loadOpportunityEvents(PROJECT);
  assert.ok(events.some(e => e.event === 'rejected'), 'human mark survives rebuild');
  assert.ok(events.some(e => e.runId === 'run-4-raw'), 'raw-shape run contributed events');
  assert.ok(
    events.some(e => e.event === 'built' && e.runId.startsWith('build-fast-')),
    'fast-path built events survive rebuild despite having no run directory',
  );

  const digest = mem.generateDigest(PROJECT);
  assert.match(digest, /4 analyzed session/);
});

// ─── Runtime validation ─────────────────────────────────────────

test('malformed-but-parseable JSONL lines are quarantined at load', async () => {
  const mem = await import('../dist/memory/index.js');
  const oppPath = join(home, '.loupe', 'projects', PROJECT, 'memory', 'opportunities.jsonl');
  const beforeCount = mem.loadOpportunityEvents(PROJECT).length;
  // Valid JSON, invalid shapes: wrong event, missing key, non-object.
  writeFileSync(oppPath,
    readFileSync(oppPath, 'utf-8') +
    JSON.stringify({ key: 'x', runId: 'r', findingId: 'f', event: 'exploded', title: 't', at: 'now' }) + '\n' +
    JSON.stringify({ event: 'observed' }) + '\n' +
    '42\n');
  assert.equal(mem.loadOpportunityEvents(PROJECT).length, beforeCount, 'invalid lines never reach derivePatterns');
});
