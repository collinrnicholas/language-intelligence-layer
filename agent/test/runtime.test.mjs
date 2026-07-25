import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Isolated HOME — runtime commands only ever look at ~/.loupe.
const home = mkdtempSync(join(tmpdir(), 'loupe-runtime-home-'));
process.env.HOME = home;
const RUNTIME = join(home, '.loupe');

function seedProject(name, { sessions = 0, runs = 0, withReport = false, withPackage = false, targets = 0, memory = false } = {}) {
  const p = join(RUNTIME, 'projects', name);
  for (let i = 0; i < sessions; i++) {
    mkdirSync(join(p, 'sessions'), { recursive: true });
    writeFileSync(join(p, 'sessions', `session-${i}.json`), '{}');
  }
  for (let i = 0; i < runs; i++) {
    const run = join(p, 'runs', `2026-0${i + 1}-01T00-00-00-000Z`, 'analysis');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'opportunities.json'), '{"version":2,"opportunities":[]}');
    writeFileSync(join(run, 'session.loupe'), '{}');
    if (withReport) writeFileSync(join(run, 'report.html'), '<html></html>');
    if (withPackage) {
      const impl = join(run, '..', 'implementation', 'implementation-123');
      mkdirSync(impl, { recursive: true });
      writeFileSync(join(impl, 'build-prompt.md'), '# brief');
    }
  }
  for (let i = 0; i < targets; i++) {
    const t = join(p, 'targets', `tgt-${i}`);
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, 'target.json'), '{}');
  }
  if (memory) {
    mkdirSync(join(p, 'memory'), { recursive: true });
    writeFileSync(join(p, 'memory', 'manifest.json'),
      JSON.stringify({ digestUpdatedAt: '2099-01-01T00:00:00Z' }));
  }
  return p;
}

// ─── Inventory + disk ───────────────────────────────────────────

test('inventory counts sessions/runs/reports/packages/targets', async () => {
  seedProject('InvA', { sessions: 2, runs: 3, withReport: true, withPackage: true, targets: 1, memory: true });
  const { inventoryProject, inventoryRuntime } = await import('../dist/runtime/inventory.js');
  const inv = inventoryProject('InvA');
  assert.equal(inv.sessions, 2);
  assert.equal(inv.runs, 3);
  assert.equal(inv.reports, 3);
  assert.equal(inv.packages, 3);
  assert.equal(inv.targets, 1);
  assert.equal(inv.hasMemory, true);

  const all = inventoryRuntime();
  assert.ok(all.runs >= 3);
  assert.ok(all.totalBytes > 0);
});

test('disk usage formatting', async () => {
  const { formatBytes } = await import('../dist/runtime/disk.js');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(5_300_000), '5.3 MB');
  assert.equal(formatBytes(4_100_000_000), '4.1 GB');
});

// ─── Doctor ─────────────────────────────────────────────────────

test('doctor derives warnings with recommendations', async () => {
  const { deriveWarnings } = await import('../dist/runtime/doctor.js');
  const { inventoryRuntime } = await import('../dist/runtime/inventory.js');
  const inv = inventoryRuntime();
  const warnings = deriveWarnings(
    inv,
    [{ rel: 'sessions/', abs: '/repo/sessions' }],  // repo artifact present
    false,                                          // gateway down
    12,                                             // stale packages
  );
  const messages = warnings.map(w => w.message).join('\n');
  assert.match(messages, /generated sessions\/ directory/);
  assert.match(messages, /12 package\(s\) older than 30 days/);
  assert.match(messages, /gateway unreachable/i);
  const recs = warnings.map(w => w.recommend).join('\n');
  assert.match(recs, /loupe runtime migrate --apply/);
});

test('doctor render includes counts and warning sections', async () => {
  const { renderDoctorReport } = await import('../dist/runtime/doctor.js');
  const { inventoryRuntime } = await import('../dist/runtime/inventory.js');
  const report = {
    version: '2.0.0',
    runtimeRoot: RUNTIME,
    repoRoot: null,
    inventory: inventoryRuntime(),
    gateway: { reachable: true, url: 'http://localhost:8787' },
    repoArtifacts: [],
    warnings: [{ message: 'Something is off', recommend: 'loupe gc' }],
  };
  const out = renderDoctorReport(report);
  assert.match(out, /Loupe Doctor/);
  assert.match(out, /Projects:/);
  assert.match(out, /Warnings:\n- Something is off/);
  assert.match(out, /Recommended:\n- loupe gc/);
});

// ─── Migrate ────────────────────────────────────────────────────

function seedFakeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'loupe-fake-repo-'));
  writeFileSync(join(repo, 'package.json'),
    JSON.stringify({ name: 'loupe', workspaces: ['agent'], private: true }));
  // Source & fixture dirs that must NEVER move.
  for (const d of ['agent/src', 'docs', 'benchmarks', 'evals/fixtures', 'specs']) {
    mkdirSync(join(repo, d), { recursive: true });
    writeFileSync(join(repo, d, 'keep.txt'), 'source');
  }
  // Generated sprawl: a project-owned capture + unowned reports.
  mkdirSync(join(repo, 'sessions', 'projects', 'FakeProj', 'sessions'), { recursive: true });
  writeFileSync(join(repo, 'sessions', 'projects', 'FakeProj', 'sessions', 's1.json'), '{}');
  mkdirSync(join(repo, 'sessions', 'reports'), { recursive: true });
  writeFileSync(join(repo, 'sessions', 'reports', 'old.html'), '<html>');
  mkdirSync(join(repo, 'debug'), { recursive: true });
  writeFileSync(join(repo, 'debug', 'trace.json'), '{}');
  return repo;
}

test('runtime migrate dry-run moves nothing', async () => {
  const { migrateGeneratedArtifacts } = await import('../dist/runtime/migrate.js');
  const repo = seedFakeRepo();
  const { moved } = migrateGeneratedArtifacts(repo, false);
  assert.ok(moved.length >= 3);
  assert.ok(existsSync(join(repo, 'sessions', 'projects', 'FakeProj', 'sessions', 's1.json')), 'dry run leaves files');
  assert.ok(existsSync(join(repo, 'debug', 'trace.json')));
});

test('runtime migrate --apply moves generated dirs out; source/docs/fixtures untouched', async () => {
  const { migrateGeneratedArtifacts, findGeneratedRepoArtifacts } = await import('../dist/runtime/migrate.js');
  const repo = seedFakeRepo();
  const result = migrateGeneratedArtifacts(repo, true);

  // Project-owned capture landed in the real runtime location.
  assert.ok(existsSync(join(RUNTIME, 'projects', 'FakeProj', 'sessions', 's1.json')),
    'project sessions map into ~/.loupe/projects/<p>/');
  // Unowned artifacts parked under migrated/.
  const confident = result.moved.filter(m => m.confident);
  const parked = result.moved.filter(m => !m.confident);
  assert.ok(confident.length >= 1 && parked.length >= 2);
  assert.ok(parked.every(m => m.dest.includes(`${join(RUNTIME, 'migrated')}`)), 'unowned artifacts parked');

  // Repo root is clean; source, docs, benchmarks, evals, specs untouched.
  assert.equal(findGeneratedRepoArtifacts(repo).length, 0);
  assert.ok(!existsSync(join(repo, 'sessions')));
  assert.ok(!existsSync(join(repo, 'debug')));
  for (const d of ['agent/src', 'docs', 'benchmarks', 'evals/fixtures', 'specs']) {
    assert.ok(existsSync(join(repo, d, 'keep.txt')), `${d} must never move`);
  }
});

// ─── GC ─────────────────────────────────────────────────────────

test('gc finds broken runs, orphan targets, stale cache — and lists only (dry-run semantics)', async () => {
  const { findGcCandidates } = await import('../dist/runtime/gc.js');
  // Broken run: directory with no artifact and no session.
  const broken = join(RUNTIME, 'projects', 'GcProj', 'runs', '2026-01-01T00-00-00-000Z');
  mkdirSync(broken, { recursive: true });
  // Orphan target: no target.json.
  const orphan = join(RUNTIME, 'projects', 'GcProj', 'targets', 'torn');
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, 'image.png'), 'x');
  // Stale + fresh cache entries.
  const cacheDir = join(RUNTIME, 'cache', 'llm');
  mkdirSync(cacheDir, { recursive: true });
  const staleFile = join(cacheDir, 'stale.json');
  writeFileSync(staleFile, '{}');
  const old = new Date(Date.now() - 60 * 86_400_000);
  utimesSync(staleFile, old, old);
  writeFileSync(join(cacheDir, 'fresh.json'), '{}');

  const candidates = findGcCandidates({});
  const labels = candidates.map(c => `${c.reason}:${c.label}`).join('\n');
  assert.match(labels, /broken-run:GcProj\/runs/);
  assert.match(labels, /orphan-target:GcProj\/targets\/torn/);
  assert.match(labels, /stale-cache:cache\/llm\/stale\.json/);
  assert.doesNotMatch(labels, /fresh\.json/);
  // findGcCandidates alone deletes nothing.
  assert.ok(existsSync(broken) && existsSync(orphan) && existsSync(staleFile));
});

test('gc never deletes config, memory, sessions, or valid runs/targets', async () => {
  const { findGcCandidates, removeGcCandidates } = await import('../dist/runtime/gc.js');
  const configFile = join(RUNTIME, 'config', 'client.json');
  mkdirSync(join(RUNTIME, 'config'), { recursive: true });
  writeFileSync(configFile, '{}');
  seedProject('GcSafe', { sessions: 1, runs: 1, targets: 1, memory: true });

  const candidates = findGcCandidates({});
  const paths = candidates.map(c => c.path).join('\n');
  assert.doesNotMatch(paths, /GcSafe/, 'valid project artifacts are never candidates');
  assert.doesNotMatch(paths, /config/);

  removeGcCandidates(candidates);
  assert.ok(existsSync(configFile));
  assert.ok(existsSync(join(RUNTIME, 'projects', 'GcSafe', 'memory', 'manifest.json')));
  assert.ok(existsSync(join(RUNTIME, 'projects', 'GcSafe', 'sessions', 'session-0.json')));
  assert.ok(existsSync(join(RUNTIME, 'projects', 'GcSafe', 'targets', 'tgt-0', 'target.json')));
});

// ─── repo-check suggestion + status robustness ──────────────────

test('repo:check suggests runtime migrate for repo-root sessions/', async () => {
  const { execFileSync } = await import('node:child_process');
  const repo = seedFakeRepo();
  // Run the real checker against the fake repo — it derives the repo root
  // from its own location (scripts/..), so it must live under repo/scripts/.
  const script = join(process.cwd(), '..', 'scripts', 'repo-check.mjs');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  const target = join(repo, 'scripts', 'repo-check.mjs');
  const { copyFileSync } = await import('node:fs');
  copyFileSync(script, target);
  let output = '';
  try {
    execFileSync(process.execPath, [target], { cwd: repo, encoding: 'utf8' });
    assert.fail('checker should exit 1 with sprawl present');
  } catch (e) {
    output = String(e.stdout || '') + String(e.stderr || '');
  }
  assert.match(output, /sessions\//);
  assert.match(output, /loupe runtime migrate --apply/);
});

test('status handles a missing project gracefully', async () => {
  const { statusCommand } = await import('../dist/commands/runtime.js');
  const prevExit = process.exitCode;
  await statusCommand({ project: 'NoSuchProject' });
  assert.equal(process.exitCode, 1);
  process.exitCode = prevExit ?? 0;
});
