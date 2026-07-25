import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Isolated HOME — clean must only ever touch ~/.loupe + ~/Loupe artifacts.
const home = mkdtempSync(join(tmpdir(), 'loupe-clean-home-'));
process.env.HOME = home;

test('parseOlderThan handles d/h/m and rejects junk', async () => {
  const { parseOlderThan } = await import('../dist/commands/clean.js');
  assert.equal(parseOlderThan('7d'), 7 * 86_400_000);
  assert.equal(parseOlderThan('24h'), 24 * 3_600_000);
  assert.equal(parseOlderThan('90m'), 90 * 60_000);
  assert.equal(parseOlderThan('soon'), null);
  assert.equal(parseOlderThan('7w'), null);
});

test('clean removes runs/cache but never config, memory, or captures', async () => {
  const { cleanCommand } = await import('../dist/commands/clean.js');
  const p = join(home, '.loupe', 'projects', 'CleanTest');
  const runDir = join(p, 'runs', '2026-01-01T00-00-00-000Z');
  const memoryFile = join(p, 'memory', 'manifest.json');
  const captureFile = join(p, 'sessions', 'session-1.json');
  const configFile = join(home, '.loupe', 'config', 'client.json');
  const cacheFile = join(home, '.loupe', 'cache', 'llm', 'abc.json');
  for (const f of [join(runDir, 'analysis'), join(p, 'memory'), join(p, 'sessions'), join(home, '.loupe', 'config'), join(home, '.loupe', 'cache', 'llm')]) {
    mkdirSync(f, { recursive: true });
  }
  writeFileSync(join(runDir, 'analysis', 'report.html'), 'x');
  writeFileSync(memoryFile, '{}');
  writeFileSync(captureFile, '{}');
  writeFileSync(configFile, '{}');
  writeFileSync(cacheFile, '{}');

  await cleanCommand({}); // no scope = runs + packages + local artifacts

  assert.ok(!existsSync(runDir), 'run removed');
  assert.ok(!existsSync(join(home, '.loupe', 'cache', 'llm')), 'cache removed');
  assert.ok(existsSync(memoryFile), 'project memory untouched');
  assert.ok(existsSync(captureFile), 'captured sessions untouched');
  assert.ok(existsSync(configFile), 'config untouched');
});

test('clean --dry-run deletes nothing; --older-than filters', async () => {
  const { cleanCommand } = await import('../dist/commands/clean.js');
  const runDir = join(home, '.loupe', 'projects', 'CleanTest', 'runs', '2026-02-02T00-00-00-000Z');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'x.json'), '{}');

  await cleanCommand({ dryRun: true, runs: true });
  assert.ok(existsSync(runDir), 'dry run leaves artifacts in place');

  // Fresh dir is NOT older than 7d — must survive a filtered clean.
  await cleanCommand({ runs: true, olderThan: '7d' });
  assert.ok(existsSync(runDir), 'younger-than-cutoff artifacts survive');
});
