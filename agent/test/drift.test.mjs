import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated HOME so the real ~/.loupe (which may hold a global design system)
// can't leak into these assertions. node --test runs each file in its own process.
const HOME = mkdtempSync(join(tmpdir(), 'loupe-drift-home-'));
process.env.HOME = HOME;

const { runDriftChecks } = await import('../dist/checks/drift.js');
const { designSystemCommand } = await import('../dist/commands/design-system.js');

function writeDesignSystem(scope, project) {
  const dir = scope === 'project'
    ? join(HOME, '.loupe', 'projects', project, 'config')
    : join(HOME, '.loupe', 'config');
  mkdirSync(dir, { recursive: true });
  // One token color; the session's red is off-token → guaranteed drift.
  writeFileSync(join(dir, 'design-system.json'), JSON.stringify({ color: { brand: '#123456' } }));
}

// A session whose DOM uses a color absent from any small token set.
function sessionFor(project) {
  return {
    project,
    flow: 'main',
    startedAt: '2026-06-27T00:00:00.000Z',
    endedAt: '2026-06-27T00:00:30.000Z',
    events: [
      {
        type: 'dom_snapshot',
        timestamp: 1000,
        computedStyles: { '.cta': { color: 'rgb(255, 0, 0)', backgroundColor: 'rgb(255, 0, 0)' } },
      },
    ],
    screenshots: [],
    notes: [],
  };
}

test('drift is SKIPPED (visibly) when no design system exists at all', () => {
  const r = runDriftChecks(sessionFor('NoConfigProj'));
  assert.equal(r.skipped, true);
  assert.equal(r.findings.length, 0);
});

test('drift does NOT fall back to a global design system', () => {
  writeDesignSystem('global', 'GlobalOnlyProj'); // only a global config exists
  const r = runDriftChecks(sessionFor('GlobalOnlyProj'));
  assert.equal(r.skipped, true, 'global config must never be an implicit drift baseline');
  assert.equal(r.findings.length, 0);
});

test('a per-project design system enables drift', () => {
  writeDesignSystem('project', 'ProjConfigProj');
  const r = runDriftChecks(sessionFor('ProjConfigProj'));
  assert.equal(r.skipped, false);
  assert.ok(r.findings.length > 0, 'off-token color should produce drift findings');
});

test('`design-system init` writes a project template that enables drift', async () => {
  const project = 'InitProj';
  await designSystemCommand('init', project);
  assert.ok(existsSync(join(HOME, '.loupe', 'projects', project, 'config', 'design-system.json')));
  const r = runDriftChecks(sessionFor(project));
  assert.equal(r.skipped, false, 'after init, drift must run');
  assert.ok(r.findings.length > 0);
});
