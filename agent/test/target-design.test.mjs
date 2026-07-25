import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Isolate ~/.loupe and force the gateway unreachable so no AI stage makes a real
// call — every AI step degrades gracefully, so builds still produce packages.
const home = mkdtempSync(join(tmpdir(), 'loupe-td-home-'));
process.env.HOME = home;
process.env.LOUPE_API_URL = 'http://127.0.0.1:1';
process.env.LOUPE_DEV_TOKEN = 'test-token';

const {
  createTargetArtifact, resolveTargetForBuild, listTargetArtifacts,
  copyTargetIntoPackage, targetContextFragment, findTargetById, loadTargetArtifact,
  sessionId, sourceFileName,
} = await import('../dist/target-design/artifact.js');
const { fastBuildThis } = await import('../dist/commands/build-fast.js');
const { buildThisCommand } = await import('../dist/commands/build-this.js');

// 1x1 PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function writeFixtures(dir) {
  const png = join(dir, 'target.png');
  const html = join(dir, 'target.html');
  const md = join(dir, 'target.md');
  writeFileSync(png, Buffer.from(PNG_B64, 'base64'));
  writeFileSync(html, '<html><body><h1>Dashboard</h1><button>Go</button></body></html>');
  writeFileSync(md, '# Target\n\n## Header\nBig title.\n\n## Actions\nA primary button.');
  return { png, html, md };
}

function sampleSession(project = 'TargetProj') {
  return {
    project,
    flow: 'Dashboard',
    startedAt: '2026-06-27T12:00:00.000Z',
    endedAt: '2026-06-27T12:00:45.000Z',
    urlTimeline: [{ url: 'https://example.test/dash', timestamp: 0, navigationType: 'initial' }],
    events: [
      { type: 'console_error', timestamp: 1000, message: 'Boom', source: 'x.js:1' },
      { type: 'dom_snapshot', timestamp: 2000, url: 'https://example.test/dash', html: '<button>Go</button>', computedStyles: { button: { height: '30px', padding: '4px', fontFamily: 'Inter' } } },
    ],
    screenshots: [{ timestamp: 1500, dataUrl: `data:image/png;base64,${PNG_B64}` }],
    viewport: { width: 1280, height: 720 },
    browser: { userAgent: 'node-test' },
    notes: [{ type: 'transcript', timestamp: 1200, text: 'This button feels small', source: 'audio' }],
  };
}

function sampleOpportunity() {
  return {
    id: 'btn-small', category: 'Accessibility', severity: 'High',
    title: 'Button is too small', description: 'Primary button below target size.',
    page: 'https://example.test/dash', timestamp: 2000, selector: 'button',
    whyItMatters: 'Hard to tap.', suggestedFix: 'Increase min-height.', confidence: 0.9,
    evidence: { events: [1], selector: 'button', url: 'https://example.test/dash', screenshotIndex: 0 },
  };
}

/** Return the newest implementation-* package dir under an output dir. */
function latestPackage(outputDir) {
  const dirs = readdirSync(outputDir).filter(d => d.startsWith('implementation-')).sort();
  return join(outputDir, dirs[dirs.length - 1]);
}

// ─── Artifact service ────────────────────────────────────────────

test('createTargetArtifact persists target.json + source + summary and is content-addressed (dedup)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-td-'));
  const { png } = writeFixtures(dir);

  const first = createTargetArtifact({ project: 'P1', sourcePath: png, name: 'Hero' });
  assert.ok(first.artifact.id.startsWith('t-'));
  assert.equal(first.artifact.sourceType, 'image');
  assert.equal(first.artifact.sourceFile, 'source.png'); // stored on the record, not scanned
  assert.equal(existsSync(join(first.dir, 'target.json')), true);
  assert.equal(existsSync(join(first.dir, 'summary.md')), true);
  assert.equal(existsSync(join(first.dir, 'source.png')), true);

  // Same file again → same id, same dir (no duplicate).
  const second = createTargetArtifact({ project: 'P1', sourcePath: png });
  assert.equal(second.artifact.id, first.artifact.id);
  assert.equal(second.dir, first.dir);
  assert.equal(listTargetArtifacts('P1').length, 1);
});

test('unsupported target formats are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-td-'));
  const bad = join(dir, 'notes.txt');
  writeFileSync(bad, 'plain text');
  assert.throws(() => createTargetArtifact({ project: 'P2', sourcePath: bad }), /Unsupported target format/);
});

test('--target-design path creates an artifact and links the session; --target-id reuses it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-td-'));
  const { png } = writeFixtures(dir);
  const session = sampleSession('ReuseProj');

  // First build resolves via a file path → creates the artifact + links the session.
  const r1 = resolveTargetForBuild({ project: session.project, session, targetDesignPath: png });
  assert.ok(r1);
  assert.equal(r1.artifact.linkedSessionIds.includes(sessionId(session)), true);
  const id = r1.artifact.id;

  // Second build resolves via id → same artifact, no new directory created.
  const r2 = resolveTargetForBuild({ project: session.project, session, targetId: id });
  assert.equal(r2.artifact.id, id);
  assert.equal(listTargetArtifacts('ReuseProj').length, 1);

  // Unknown id fails loudly.
  assert.throws(() => resolveTargetForBuild({ project: 'ReuseProj', session, targetId: 't-doesnotexist' }), /No target with id/);
});

test('findTargetById locates a target across projects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-td-'));
  const { md } = writeFixtures(dir);
  const { artifact } = createTargetArtifact({ project: 'FindProj', sourcePath: md });
  const found = findTargetById(artifact.id);
  assert.ok(found);
  assert.equal(found.artifact.project, 'FindProj');
});

test('copyTargetIntoPackage copies target.json + source + summary; markdown & html supported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-td-'));
  const { html, md } = writeFixtures(dir);
  const session = sampleSession('CopyProj');

  for (const [srcPath, ext, type] of [[md, 'source.md', 'markdown'], [html, 'source.html', 'html']]) {
    const resolved = resolveTargetForBuild({ project: session.project, session, targetDesignPath: srcPath });
    assert.equal(resolved.artifact.sourceType, type);
    const pkgDir = mkdtempSync(join(tmpdir(), 'loupe-pkg-'));
    copyTargetIntoPackage(pkgDir, resolved);
    const outDir = join(pkgDir, 'target-design');
    assert.equal(existsSync(join(outDir, 'target.json')), true, `${type}: target.json`);
    assert.equal(existsSync(join(outDir, 'summary.md')), true, `${type}: summary.md`);
    assert.equal(existsSync(join(outDir, ext)), true, `${type}: ${ext}`);
    const frag = targetContextFragment(resolved);
    assert.equal(frag.id, resolved.artifact.id);
    assert.equal(frag.file, `target-design/${ext}`);
  }
});

// ─── Fast path (no prior analysis) ───────────────────────────────

test('fast path: image target is copied, referenced by id, and drives the Target Design section', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-fast-'));
  const { png } = writeFixtures(dir);
  const session = sampleSession('FastImg');
  const sessionPath = join(dir, 'session.loupe');
  writeFileSync(sessionPath, JSON.stringify(session));
  const output = join(dir, 'out');

  await fastBuildThis(sessionPath, session, {
    goal: 'Minimal changes', target: 'Claude Code', output, targetDesign: png,
  });

  const pkg = latestPackage(output);
  assert.equal(existsSync(join(pkg, 'target-design', 'source.png')), true);
  assert.equal(existsSync(join(pkg, 'target-design', 'target.json')), true);
  const ctx = JSON.parse(readFileSync(join(pkg, 'context.json'), 'utf-8'));
  assert.ok(ctx.targetDesign && ctx.targetDesign.id.startsWith('t-'), 'context.json references targetDesign.id');
  assert.equal(ctx.targetDesign.sourceType, 'image');
  const brief = readFileSync(join(pkg, 'build-prompt.md'), 'utf-8');
  assert.match(brief, /## Target Design/);
  assert.match(brief, /### Current vs Target/);
});

test('fast path: markdown target is copied and included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-fast-'));
  const { md } = writeFixtures(dir);
  const session = sampleSession('FastMd');
  const sessionPath = join(dir, 'session.loupe');
  writeFileSync(sessionPath, JSON.stringify(session));
  const output = join(dir, 'out');

  await fastBuildThis(sessionPath, session, {
    goal: 'Minimal changes', target: 'Claude Code', output, targetDesign: md,
  });

  const pkg = latestPackage(output);
  assert.equal(existsSync(join(pkg, 'target-design', 'source.md')), true);
  const ctx = JSON.parse(readFileSync(join(pkg, 'context.json'), 'utf-8'));
  assert.equal(ctx.targetDesign.sourceType, 'markdown');
  assert.match(readFileSync(join(pkg, 'build-prompt.md'), 'utf-8'), /## Target Design/);
});

test('one session builds against two different targets → two packages, each referencing its target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-two-'));
  const { png, md } = writeFixtures(dir);
  const session = sampleSession('TwoTargets');
  const sessionPath = join(dir, 'session.loupe');
  writeFileSync(sessionPath, JSON.stringify(session));

  const outA = join(dir, 'outA');
  const outB = join(dir, 'outB');
  await fastBuildThis(sessionPath, session, { goal: 'Minimal changes', target: 'Claude Code', output: outA, targetDesign: png });
  await fastBuildThis(sessionPath, session, { goal: 'Minimal changes', target: 'Claude Code', output: outB, targetDesign: md });

  const idA = JSON.parse(readFileSync(join(latestPackage(outA), 'context.json'), 'utf-8')).targetDesign.id;
  const idB = JSON.parse(readFileSync(join(latestPackage(outB), 'context.json'), 'utf-8')).targetDesign.id;
  assert.notEqual(idA, idB);

  // Both targets persist under the one project and both link the same session.
  const targets = listTargetArtifacts('TwoTargets');
  assert.equal(targets.length, 2);
  const sid = sessionId(session);
  assert.ok(targets.every(t => t.linkedSessionIds.includes(sid)));
  // Listing is newest-first (the markdown target was added after the image).
  assert.equal(targets[0].sourceType, 'markdown');
});

// ─── Rich path (analyzed artifact) ───────────────────────────────

test('rich path and fast path both include target metadata (parity)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-rich-'));
  const { png } = writeFixtures(dir);
  const session = sampleSession('RichParity');
  const sessionPath = join(dir, 'session.loupe');
  writeFileSync(sessionPath, JSON.stringify(session));

  // A sibling v1 opportunities.json makes build-this take the rich path.
  writeFileSync(join(dir, 'opportunities.json'), JSON.stringify({
    version: 1,
    generatedAt: '2026-06-27T12:05:00.000Z',
    reportPath: join(dir, 'report.html'),
    sourceSessionPath: sessionPath,
    session,
    opportunities: [sampleOpportunity()],
  }));

  const output = join(dir, 'out-rich');
  await buildThisCommand(sessionPath, {
    goal: 'Minimal changes', target: 'Codex', opportunities: 'all', output, targetDesign: png,
  });

  const richPkg = latestPackage(output);
  const richCtx = JSON.parse(readFileSync(join(richPkg, 'context.json'), 'utf-8'));
  assert.ok(richCtx.targetDesign && richCtx.targetDesign.id.startsWith('t-'), 'rich path references targetDesign.id');
  assert.equal(existsSync(join(richPkg, 'target-design', 'target.json')), true);
  assert.equal(existsSync(join(richPkg, 'target-design', 'source.png')), true);
  assert.match(readFileSync(join(richPkg, 'build-prompt.md'), 'utf-8'), /## Target Design/);

  // Now the fast path for the same target — should reference the SAME artifact id.
  const fastOut = join(dir, 'out-fast');
  await fastBuildThis(sessionPath, session, { goal: 'Minimal changes', target: 'Claude Code', output: fastOut, targetDesign: png });
  const fastCtx = JSON.parse(readFileSync(join(latestPackage(fastOut), 'context.json'), 'utf-8'));
  assert.equal(fastCtx.targetDesign.id, richCtx.targetDesign.id, 'both paths resolve to the same content-addressed target');
});

test('rich path can reuse a persisted target by id (--target-id)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-richid-'));
  const { md } = writeFixtures(dir);
  const session = sampleSession('RichById');
  const sessionPath = join(dir, 'session.loupe');
  writeFileSync(sessionPath, JSON.stringify(session));
  writeFileSync(join(dir, 'opportunities.json'), JSON.stringify({
    version: 1, generatedAt: '2026-06-27T12:05:00.000Z',
    reportPath: join(dir, 'report.html'), sourceSessionPath: sessionPath,
    session, opportunities: [sampleOpportunity()],
  }));

  // Pre-create the target, then build against it by id.
  const { artifact } = createTargetArtifact({ project: 'RichById', sourcePath: md, name: 'Spec' });
  const output = join(dir, 'out');
  await buildThisCommand(sessionPath, {
    goal: 'Minimal changes', target: 'Codex', opportunities: 'all', output, targetId: artifact.id,
  });

  const ctx = JSON.parse(readFileSync(join(latestPackage(output), 'context.json'), 'utf-8'));
  assert.equal(ctx.targetDesign.id, artifact.id);
  assert.equal(ctx.targetDesign.name, 'Spec');
});

// ─── Embedded target (extension "Capture Target Screenshot") ─────

test('a target embedded in the session (data URL) is used with no flags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-embed-'));
  const session = sampleSession('EmbedProj');
  session.targetDesign = `data:image/png;base64,${PNG_B64}`; // as the extension would embed it
  const sessionPath = join(dir, 'session.loupe');
  writeFileSync(sessionPath, JSON.stringify(session));
  const output = join(dir, 'out');

  // No --target-design / --target-id: the embedded target drives Target Design Mode.
  await fastBuildThis(sessionPath, session, { goal: 'Minimal changes', target: 'Claude Code', output });

  const pkg = latestPackage(output);
  assert.equal(existsSync(join(pkg, 'target-design', 'source.png')), true);
  const ctx = JSON.parse(readFileSync(join(pkg, 'context.json'), 'utf-8'));
  assert.ok(ctx.targetDesign && ctx.targetDesign.id.startsWith('t-'), 'embedded target referenced in context.json');
  assert.equal(ctx.targetDesign.sourceType, 'image');
  assert.match(readFileSync(join(pkg, 'build-prompt.md'), 'utf-8'), /## Target Design/);
  // The persisted artifact records it was captured, not filed.
  const store = JSON.parse(readFileSync(join(process.env.HOME, '.loupe', 'projects', 'EmbedProj', 'targets', ctx.targetDesign.id, 'target.json'), 'utf-8'));
  assert.equal(store.sourcePath, 'extension-capture');
});

test('an object-shaped embedded target carries provenance into the artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-embedmeta-'));
  const session = sampleSession('EmbedMeta');
  session.targetDesign = {
    dataUrl: `data:image/jpeg;base64,${PNG_B64}`,
    sourceKind: 'desktop',
    capturedAtMs: 1751200000000,
    width: 1440,
    height: 900,
  };
  const sessionPath = join(dir, 'session.loupe');
  writeFileSync(sessionPath, JSON.stringify(session));
  const output = join(dir, 'out');

  await fastBuildThis(sessionPath, session, { goal: 'Minimal changes', target: 'Claude Code', output });

  const ctx = JSON.parse(readFileSync(join(latestPackage(output), 'context.json'), 'utf-8'));
  assert.equal(ctx.targetDesign.name, 'Captured target (app/screen)');
  const store = JSON.parse(readFileSync(join(process.env.HOME, '.loupe', 'projects', 'EmbedMeta', 'targets', ctx.targetDesign.id, 'target.json'), 'utf-8'));
  assert.match(store.notes, /Captured from app\/screen 1440×900/);
});

test('an explicit --target-design overrides an embedded session target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-embed2-'));
  const { md } = writeFixtures(dir);
  const session = sampleSession('EmbedOverride');
  session.targetDesign = `data:image/png;base64,${PNG_B64}`;
  const resolved = resolveTargetForBuild({
    project: session.project, session,
    targetDesignPath: md,                       // explicit file wins
    embeddedTargetDataUrl: session.targetDesign,
  });
  assert.equal(resolved.artifact.sourceType, 'markdown');
});

// ─── Guardrails from review ──────────────────────────────────────

test('--target-id is scoped to the session project; cross-project needs explicit opt-in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-xproj-'));
  // Unique markdown content → unique id that cannot collide with other tests' targets.
  const md = join(dir, 'unique-target.md');
  writeFileSync(md, '# Unique cross-project target\n\nContent specific to this test only.');
  const { artifact } = createTargetArtifact({ project: 'ProjA', sourcePath: md, name: 'A-only' });
  const sessionB = sampleSession('ProjB');

  // Default: refused, with a hint naming the owning project.
  assert.throws(
    () => resolveTargetForBuild({ project: 'ProjB', session: sessionB, targetId: artifact.id }),
    /belongs to project "ProjA"/,
  );
  // Opt-in: resolves the cross-project target.
  const r = resolveTargetForBuild({ project: 'ProjB', session: sessionB, targetId: artifact.id, allowCrossProject: true });
  assert.equal(r.artifact.id, artifact.id);
  assert.equal(r.artifact.project, 'ProjA');
});

test('packaged target.json/summary.md redact the absolute source path; the store keeps it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-redact-'));
  const { png } = writeFixtures(dir);
  const session = sampleSession('RedactProj');
  const sessionPath = join(dir, 'session.loupe');
  writeFileSync(sessionPath, JSON.stringify(session));
  const output = join(dir, 'out');

  await fastBuildThis(sessionPath, session, { goal: 'Minimal changes', target: 'Claude Code', output, targetDesign: png });

  const pkg = latestPackage(output);
  const pkgJson = JSON.parse(readFileSync(join(pkg, 'target-design', 'target.json'), 'utf-8'));
  assert.equal(pkgJson.sourcePath, 'target.png', 'packaged sourcePath is basename only');
  assert.equal(pkgJson.sourcePath.includes('/'), false);
  const pkgSummary = readFileSync(join(pkg, 'target-design', 'summary.md'), 'utf-8');
  assert.equal(pkgSummary.includes(dir), false, 'summary.md must not leak the absolute temp dir');

  // The canonical store keeps the full provenance path.
  const storePath = join(process.env.HOME, '.loupe', 'projects', 'RedactProj', 'targets', pkgJson.id, 'target.json');
  const storeJson = JSON.parse(readFileSync(storePath, 'utf-8'));
  assert.equal(storeJson.sourcePath.includes(dir), true, 'store retains the absolute source path');
});

test('a target-design package routes successfully to an isolated local destination', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loupe-route-'));
  const { png } = writeFixtures(dir);
  const routed = join(dir, 'routed');
  const cfgDir = join(process.env.HOME, '.loupe', 'config');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'destinations.json'), JSON.stringify({
    defaultDestination: 'local',
    destinations: [{ id: 'local', name: 'Local', type: 'local', output: routed, postAction: 'none' }],
    projectMappings: {},
  }));

  const session = sampleSession('RouteProj');
  const sessionPath = join(dir, 'session.loupe');
  writeFileSync(sessionPath, JSON.stringify(session));

  await fastBuildThis(sessionPath, session, {
    goal: 'Minimal changes', target: 'Claude Code', output: join(dir, 'out'), destination: 'local', targetDesign: png,
  });

  const routedPkgs = readdirSync(routed);
  assert.equal(routedPkgs.length, 1, 'exactly one package routed');
  const routedPkg = join(routed, routedPkgs[0]);
  assert.equal(existsSync(join(routedPkg, 'target-design', 'target.json')), true, 'routed package carries the target artifact');
  assert.equal(existsSync(join(routedPkg, 'target-design', 'source.png')), true);
  assert.equal(existsSync(join(routedPkg, 'build-prompt.md')), true);
});
