// ─── loupe runtime migrate ───────────────────────────────────────
// Moves generated artifact directories OUT of the repo root and into the
// runtime tree. Dry-run by default; --apply moves. Never touches source,
// docs, tests, benchmarks, eval fixtures, or specs — only the fixed artifact
// directory names below, and only at the repo ROOT.

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getRuntimeRoot } from './paths.js';
import { safeProjectDir, makeRunId } from '../paths.js';
import type { MigrationItem, RepoArtifact } from './types.js';

// Generated artifact dir names eligible for migration when found at repo root.
const ARTIFACT_DIR_NAMES = [
  'sessions', 'runs', 'reports', 'implementation-packages',
  'target-design', 'screenshots', 'debug', 'traces',
];

// Belt-and-braces: these must never be treated as artifacts even if a future
// edit breaks the name list above.
const PROTECTED_NAMES = new Set([
  'agent', 'extension', 'analyzer', 'app', 'gateway', 'scripts', 'prompts',
  'docs', 'specs', 'research', 'changelog', 'benchmarks', 'evals',
  'node_modules', '.github', '.git',
]);

/** Artifact directories present at the repo root (relative + absolute). */
export function findGeneratedRepoArtifacts(repoRoot: string): RepoArtifact[] {
  const out: RepoArtifact[] = [];
  for (const name of ARTIFACT_DIR_NAMES) {
    if (PROTECTED_NAMES.has(name)) continue;
    const abs = join(repoRoot, name);
    try {
      if (statSync(abs).isDirectory()) out.push({ rel: `${name}/`, abs });
    } catch { /* not present */ }
  }
  return out;
}

/**
 * Plan the migration. Confident mappings go to their real runtime location;
 * everything else parks under ~/.loupe/migrated/<runId>/ so nothing is lost
 * and the repo still comes out clean.
 */
export function planMigration(repoRoot: string): MigrationItem[] {
  const runtime = getRuntimeRoot();
  const parkRoot = join(runtime, 'migrated', makeRunId());
  const items: MigrationItem[] = [];

  for (const artifact of findGeneratedRepoArtifacts(repoRoot)) {
    const name = artifact.rel.replace(/\/$/, '');

    if (name === 'sessions') {
      // Confident: sessions/projects/<P>/** maps onto real project dirs.
      const projectsDir = join(artifact.abs, 'projects');
      if (existsSync(projectsDir)) {
        for (const project of readdirSync(projectsDir)) {
          if (project === '.DS_Store') continue;
          items.push({
            source: join(projectsDir, project),
            dest: join(runtime, 'projects', safeProjectDir(project)),
            confident: true,
          });
        }
      }
      // The rest of sessions/ (reports/, screenshots/, config/, …) has no
      // project owner — park it.
      for (const entry of readdirSync(artifact.abs)) {
        if (entry === 'projects' || entry === '.DS_Store') continue;
        items.push({
          source: join(artifact.abs, entry),
          dest: join(parkRoot, 'sessions', entry),
          confident: false,
        });
      }
    } else {
      // No way to know which project these belong to — park them whole.
      items.push({
        source: artifact.abs,
        dest: join(parkRoot, name),
        confident: false,
      });
    }
  }
  return items;
}

/** Merge-move: rename when the destination is free, recursive merge otherwise. */
function moveMerge(source: string, dest: string): void {
  if (!existsSync(dest)) {
    mkdirSync(join(dest, '..'), { recursive: true });
    try {
      renameSync(source, dest);
      return;
    } catch { /* cross-device or exists-race — fall through to copy */ }
  }
  const st = statSync(source);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(source)) {
      moveMerge(join(source, entry), join(dest, entry));
    }
    rmSync(source, { recursive: true, force: true });
  } else {
    if (!existsSync(dest)) cpSync(source, dest);
    rmSync(source, { force: true });
  }
}

export interface MigrationResult {
  moved: MigrationItem[];
  emptied: string[];  // artifact roots removed after their contents moved
}

/**
 * Execute (or preview) the migration. With apply=false nothing on disk
 * changes — the plan is returned for display.
 */
export function migrateGeneratedArtifacts(repoRoot: string, apply: boolean): MigrationResult {
  const plan = planMigration(repoRoot);
  if (!apply) return { moved: plan, emptied: [] };

  for (const item of plan) {
    moveMerge(item.source, item.dest);
  }

  // Remove now-empty artifact roots (e.g. sessions/ after its children moved).
  // "Empty" is recursive: leftover scaffolding like sessions/projects/ with
  // nothing but .DS_Store inside counts as empty.
  const emptied: string[] = [];
  for (const artifact of findGeneratedRepoArtifacts(repoRoot)) {
    if (isEffectivelyEmpty(artifact.abs)) {
      rmSync(artifact.abs, { recursive: true, force: true });
      emptied.push(artifact.rel);
    }
  }
  return { moved: plan, emptied };
}

/** True when a directory contains nothing but .DS_Store and empty scaffolding. */
function isEffectivelyEmpty(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (name === '.DS_Store') continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isDirectory()) return false;
      if (!isEffectivelyEmpty(full)) return false;
    } catch {
      return false;
    }
  }
  return true;
}
