import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const home = mkdtempSync(join(tmpdir(), 'loupe-home-'));
process.env.HOME = home;

const { analyzeSession } = await import('../dist/commands/analyze.js');
const { buildThisCommand } = await import('../dist/commands/build-this.js');
const { validateSession } = await import('../dist/commands/validate.js');
const { codexProvider } = await import('../dist/destinations/providers/index.js');
const { generateImplementationPackage } = await import('../dist/ai/implementation-package.js');
const { parseSessionInput, parseOpportunitiesArtifact, quarantineOpportunities } = await import('../dist/schema.js');

test('analyze writes a v2 artifact (referenced session, no base64) and build-this consumes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-analyze-'));
  const sessionPath = join(dir, 'session.loupe');
  writeFileSync(sessionPath, JSON.stringify(sampleSession(), null, 2));

  const exportDir = join(dir, 'export');
  await analyzeSession(sessionPath, { ai: false, output: exportDir });

  // --output is a flat export of analysis/
  const opportunitiesPath = join(exportDir, 'opportunities.json');
  assert.equal(existsSync(join(exportDir, 'report.html')), true);
  assert.equal(existsSync(join(exportDir, 'session.loupe')), true);
  assert.equal(existsSync(opportunitiesPath), true);

  const raw = readFileSync(opportunitiesPath, 'utf-8');
  const artifact = JSON.parse(raw);
  assert.equal(artifact.version, 2);
  assert.equal(artifact.sessionFile, 'session.loupe');
  assert.equal('session' in artifact, false);            // session is referenced, not embedded
  assert.ok(Array.isArray(artifact.screenshots));
  assert.ok(artifact.opportunities.length > 0);
  // The big base64 payload must NOT leak into the artifact.
  assert.equal(raw.includes('data:image'), false);
  // The report must not inline base64 or phone home for fonts.
  const report = readFileSync(join(exportDir, 'report.html'), 'utf-8');
  assert.equal(report.includes('data:image'), false);
  assert.equal(report.includes('fonts.googleapis.com'), false);

  const configDir = join(home, '.loupe', 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'destinations.json'), JSON.stringify({
    defaultDestination: 'local',
    destinations: [{ id: 'local', name: 'Local', type: 'local', output: join(dir, 'routed'), postAction: 'none' }],
    projectMappings: {},
  }, null, 2));

  // build-this with no sibling artifact must resolve the latest canonical ~/.loupe run.
  await buildThisCommand(sessionPath, {
    goal: 'Minimal changes',
    target: 'Codex',
    opportunities: 'all',
    output: join(dir, 'packages'),
  });

  assert.ok(readdirSync(join(dir, 'packages')).length > 0);
  assert.ok(readdirSync(join(dir, 'routed')).length > 0);
});

test('parseOpportunitiesArtifact still accepts v1 (embedded session) for back-compat', () => {
  const v1 = {
    version: 1,
    generatedAt: new Date().toISOString(),
    reportPath: '/tmp/report.html',
    sourceSessionPath: '/tmp/session.loupe',
    session: sampleSession(),
    opportunities: [sampleOpportunity()],
  };
  const parsed = parseOpportunitiesArtifact(v1);
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
});

test('quarantineOpportunities keeps valid findings and drops malformed ones', () => {
  const { valid, dropped } = quarantineOpportunities([
    sampleOpportunity(),
    { id: 'broken', title: 'missing required fields' },
  ]);
  assert.equal(valid.length, 1);
  assert.equal(dropped, 1);
});

test('validate catches timestamps outside session duration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-validate-'));
  const badSession = sampleSession();
  badSession.events[0].timestamp = 99_000;
  const sessionPath = join(dir, 'bad.loupe');
  writeFileSync(sessionPath, JSON.stringify(badSession, null, 2));

  assert.throws(() => {
    execFileSync(process.execPath, ['dist/cli.js', 'validate', sessionPath], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, HOME: home },
      stdio: 'pipe',
    });
  });
});

test('workspace destinations reject path traversal outside workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-dest-'));
  const workspace = join(dir, 'workspace');
  const pkgDir = join(dir, 'pkg');
  mkdirSync(workspace);
  mkdirSync(pkgDir);
  writeFileSync(join(pkgDir, 'build-prompt.md'), 'test');

  const result = await codexProvider.route({
    packageDir: pkgDir,
    files: ['build-prompt.md'],
    screenshotCount: 0,
    project: 'TestProject',
    flow: 'Flow',
  }, {
    id: 'codex',
    name: 'Codex',
    type: 'codex',
    workspace,
    output: '../escape',
    postAction: 'none',
  });

  assert.equal(result.success, false);
  assert.match(result.message, /escapes workspace/);
});

test('implementation packages are unique and do not reuse stale output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-package-'));
  const session = sampleSession();
  const findings = [sampleOpportunity()];

  const first = generateImplementationPackage({
    findings,
    session,
    goal: 'Minimal changes',
    target: 'Codex',
    outputDir: dir,
  });
  writeFileSync(join(first, 'stale.txt'), 'old');

  const second = generateImplementationPackage({
    findings,
    session,
    goal: 'Minimal changes',
    target: 'Codex',
    outputDir: dir,
  });

  assert.notEqual(first, second);
  assert.equal(existsSync(join(second, 'stale.txt')), false);
});

test('malformed sessions are rejected by runtime schema', () => {
  const parsed = parseSessionInput({ project: 'missing fields' });
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.length > 0);
});

test('golden: PM Toolkit session produces the expected deterministic findings end-to-end', async () => {
  const fixture = join(import.meta.dirname, 'fixtures', 'pm-toolkit-dashboard.loupe');
  const dir = mkdtempSync(join(tmpdir(), 'loupe-golden-'));
  const sessionPath = join(dir, 'pm-toolkit-dashboard.loupe');
  writeFileSync(sessionPath, readFileSync(fixture, 'utf-8'));

  const exportDir = join(dir, 'export');
  await analyzeSession(sessionPath, { ai: false, output: exportDir });

  const artifact = JSON.parse(readFileSync(join(exportDir, 'opportunities.json'), 'utf-8'));
  assert.equal(artifact.version, 2);

  const ids = artifact.opportunities.map(o => o.id);
  // Deterministic checks that this session is designed to trip:
  assert.ok(ids.includes('console-errors'), 'expected a console-errors finding');
  assert.ok(ids.includes('slow-requests'), 'expected a slow-requests finding');
  assert.ok(ids.includes('touch-targets'), 'expected a touch-targets finding (36px/28px buttons)');

  // Every finding must validate against the opportunity schema.
  const { dropped } = quarantineOpportunities(artifact.opportunities);
  assert.equal(dropped, 0);

  // Screenshots were extracted to files and referenced (not embedded).
  assert.ok(existsSync(join(exportDir, 'screenshots')));
  assert.equal(readFileSync(join(exportDir, 'opportunities.json'), 'utf-8').includes('data:image'), false);
});

function sampleSession() {
  const startedAt = '2026-06-27T12:00:00.000Z';
  const endedAt = '2026-06-27T12:00:45.000Z';
  return {
    project: 'TestProject',
    flow: 'Checkout',
    startedAt,
    endedAt,
    urlTimeline: [{ url: 'https://example.test/checkout', timestamp: 0, navigationType: 'initial' }],
    events: [
      { type: 'console_error', timestamp: 1000, message: 'Boom', source: 'test.js:1' },
      {
        type: 'dom_snapshot',
        timestamp: 2000,
        url: 'https://example.test/checkout',
        html: '<button>Buy</button>',
        computedStyles: { button: { height: '32px', color: 'rgb(1, 2, 3)' } },
      },
    ],
    screenshots: [
      { timestamp: 1500, dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==' },
    ],
    viewport: { width: 1280, height: 720 },
    browser: { userAgent: 'node-test' },
    notes: [{ type: 'transcript', timestamp: 1200, text: 'This button feels small', source: 'audio' }],
  };
}

function sampleOpportunity() {
  return {
    id: 'test-opportunity',
    category: 'Accessibility',
    severity: 'High',
    title: 'Button is too small',
    description: 'Primary checkout button is below target size.',
    page: 'https://example.test/checkout',
    timestamp: 2000,
    selector: 'button',
    whyItMatters: 'Small controls are hard to tap.',
    suggestedFix: 'Increase min-height to 44px.',
    confidence: 0.95,
    evidence: { events: [1], selector: 'button', url: 'https://example.test/checkout', screenshotIndex: 0 },
  };
}
