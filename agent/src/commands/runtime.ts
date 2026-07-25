// ─── Runtime lifecycle commands: doctor · status · gc · runtime migrate ──
// Thin printers over agent/src/runtime/* — all decisions live there.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildDoctorReport, renderDoctorReport } from '../runtime/doctor.js';
import { inventoryProject, inventoryRuntime, projectLatest } from '../runtime/inventory.js';
import { findGcCandidates, removeGcCandidates } from '../runtime/gc.js';
import { migrateGeneratedArtifacts, findGeneratedRepoArtifacts } from '../runtime/migrate.js';
import { findRepoRoot, getRuntimeRoot } from '../runtime/paths.js';
import { formatBytes, getDirectorySize } from '../runtime/disk.js';
import { parseOlderThan } from './clean.js';

const CLI_VERSION = '2.0.0';

// ─── loupe doctor ───────────────────────────────────────────────

export async function doctorCommand(): Promise<void> {
  const report = await buildDoctorReport(CLI_VERSION);
  console.log(renderDoctorReport(report));
  if (report.warnings.length > 0) process.exitCode = 1;
}

// ─── loupe status ───────────────────────────────────────────────

export async function statusCommand(opts: { project?: string }): Promise<void> {
  const root = getRuntimeRoot();
  const projectsDir = join(root, 'projects');
  const all = existsSync(projectsDir)
    ? readdirSync(projectsDir).filter(n => n !== '.DS_Store')
    : [];

  if (all.length === 0) {
    console.log('No Loupe projects yet. Record a session with the extension, then run `loupe review <file>`.');
    return;
  }

  // Infer: explicit flag, else the single project, else summarize all.
  const project = opts.project ?? (all.length === 1 ? all[0] : null);
  if (!project) {
    console.log(`Runtime: ${root} · ${all.length} projects\n`);
    for (const p of all) {
      const inv = inventoryProject(p);
      console.log(`${p.padEnd(20)} ${String(inv.sessions).padStart(3)} sessions · ${String(inv.runs).padStart(3)} runs · ${String(inv.packages).padStart(3)} packages · ${formatBytes(inv.bytes)}`);
    }
    console.log('\nUse `loupe status --project <name>` for detail.');
    return;
  }

  if (!all.includes(project)) {
    console.error(`Project not found in runtime: ${project}`);
    console.error(`Known projects: ${all.join(', ') || '(none)'}`);
    process.exitCode = 1;
    return;
  }

  const inv = inventoryProject(project);
  const latest = projectLatest(project);
  console.log(`Project: ${project}`);
  console.log(`Path:    ${inv.path}`);
  console.log('');
  console.log(`Latest session:  ${latest.session ?? '—'}`);
  console.log(`Latest run:      ${latest.run ?? '—'}`);
  console.log(`Latest report:   ${latest.report ?? '—'}`);
  console.log(`Latest package:  ${latest.package ?? '—'}`);
  console.log(`Latest target:   ${latest.target ?? '—'}`);
  console.log(`Memory digest:   ${inv.memoryDigestUpdatedAt ?? (inv.hasMemory ? 'never generated' : 'no memory — run `loupe memory index ' + project + '`')}`);
  console.log('');
  console.log('Disk usage:');
  for (const sub of ['sessions', 'runs', 'targets', 'memory'] as const) {
    console.log(`  ${sub.padEnd(9)} ${formatBytes(getDirectorySize(join(inv.path, sub)))}`);
  }
  console.log(`  total     ${formatBytes(inv.bytes)}`);
}

// ─── loupe gc ───────────────────────────────────────────────────

export async function gcCommand(opts: { dryRun?: boolean; project?: string; olderThan?: string }): Promise<void> {
  let olderThanMs: number | undefined;
  if (opts.olderThan) {
    const ms = parseOlderThan(opts.olderThan);
    if (ms === null) {
      console.error(`Invalid --older-than value: "${opts.olderThan}" (use e.g. 30d, 24h)`);
      process.exitCode = 1;
      return;
    }
    olderThanMs = ms;
  }

  const candidates = findGcCandidates({ project: opts.project, olderThanMs });
  if (candidates.length === 0) {
    console.log('Nothing to collect — no orphan or stale artifacts found.');
    return;
  }

  const total = candidates.reduce((s, c) => s + c.bytes, 0);
  console.log(`${opts.dryRun ? 'Would collect' : 'Collecting'} ${candidates.length} artifact(s) · ${formatBytes(total)}`);
  for (const c of candidates.sort((a, b) => a.label.localeCompare(b.label))) {
    console.log(`  ${opts.dryRun ? '·' : '✗'} [${c.reason}] ${c.label}  (${formatBytes(c.bytes)})`);
  }

  if (opts.dryRun) {
    console.log('\nDry run — nothing deleted.');
    return;
  }
  const { removed, failed } = removeGcCandidates(candidates);
  console.log(`\n✓ Collected ${removed} artifact(s)${failed ? ` · ${failed} failed` : ''}.`);
  console.log('  Sessions, memory, config, and valid runs/targets were not touched.');
  console.log('  Run cleanup (which affects memory) stays explicit: loupe clean --runs');
}

// ─── loupe runtime migrate ──────────────────────────────────────

export async function runtimeCommand(action: string, opts: { apply?: boolean; dryRun?: boolean }): Promise<void> {
  if (action !== 'migrate') {
    console.error(`Unknown runtime action: ${action} (available: migrate)`);
    process.exitCode = 1;
    return;
  }

  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error('Not inside a Loupe repo — nothing to migrate. Run from the repository root.');
    process.exitCode = 1;
    return;
  }

  const artifacts = findGeneratedRepoArtifacts(repoRoot);
  if (artifacts.length === 0) {
    console.log('✓ Repo is clean — no generated artifact directories at the repo root.');
    return;
  }

  // Dry-run is the default; --apply moves. (--dry-run accepted for symmetry.)
  const apply = !!opts.apply && !opts.dryRun;
  const { moved, emptied } = migrateGeneratedArtifacts(repoRoot, apply);

  console.log(`${apply ? 'Migrated' : 'Would migrate'} ${moved.length} path(s) out of the repo:`);
  for (const item of moved) {
    console.log(`  ${apply ? '✓' : '·'} ${item.source}`);
    console.log(`      → ${item.dest}${item.confident ? '' : '   (unclassified — parked under ~/.loupe/migrated/)'}`);
  }
  if (!apply) {
    console.log('\nDry run — nothing moved. Re-run with:  loupe runtime migrate --apply');
    return;
  }
  if (emptied.length > 0) console.log(`Removed emptied artifact roots: ${emptied.join(', ')}`);
  console.log('\n✓ Done. Verify with: npm run repo:check');
}
