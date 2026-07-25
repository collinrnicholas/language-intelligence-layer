// ─── loupe gc — orphan/stale artifact collection ─────────────────
//
// Collects only provably-safe generated artifacts:
//   - stale cache entries        (~/.loupe/cache/**, older than cutoff)
//   - stale logs                 (~/.loupe/logs/*, older than cutoff)
//   - broken run directories     (no opportunities.json AND no session.loupe —
//                                 aborted before anything durable was written;
//                                 memory never indexed them, so removal is
//                                 memory-neutral by construction)
//   - orphan target artifacts    (no target.json manifest — a torn write)
//   - empty project subdirs      (left behind by previous cleanups)
//
// NEVER touched: captured sessions, memory/, config/, valid runs (memory
// derives from them — that cleanup belongs to `loupe clean --runs`, which
// warns), valid target artifacts (they may be the only copy of a user's
// design), fixtures, or anything outside ~/.loupe.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getRuntimeRoot, projectRunsDir, projectTargetsDir } from './paths.js';
import { getDirectorySize } from './disk.js';
import type { GcCandidate } from './types.js';

const DEFAULT_STALE_MS = 30 * 86_400_000; // 30d default for cache/log staleness

function listDir(path: string): string[] {
  try { return readdirSync(path).filter(n => n !== '.DS_Store'); } catch { return []; }
}

function safeStat(path: string) {
  try { return statSync(path); } catch { return null; }
}

export interface GcOptions {
  project?: string;
  /** Cutoff in ms for cache/log staleness. Default 30 days. */
  olderThanMs?: number;
}

export function findGcCandidates(opts: GcOptions = {}): GcCandidate[] {
  const root = getRuntimeRoot();
  const staleMs = opts.olderThanMs ?? DEFAULT_STALE_MS;
  const cutoff = Date.now() - staleMs;
  const out: GcCandidate[] = [];

  // Stale cache entries (files, per cache family).
  for (const family of listDir(join(root, 'cache'))) {
    const familyDir = join(root, 'cache', family);
    for (const name of listDir(familyDir)) {
      const full = join(familyDir, name);
      const st = safeStat(full);
      if (st && !st.isDirectory() && st.mtimeMs < cutoff) {
        out.push({ path: full, label: `cache/${family}/${name}`, reason: 'stale-cache', bytes: st.size, mtime: st.mtimeMs });
      }
    }
  }

  // Stale logs.
  const logsDir = join(root, 'logs');
  for (const name of listDir(logsDir)) {
    const full = join(logsDir, name);
    const st = safeStat(full);
    if (st && !st.isDirectory() && st.mtimeMs < cutoff) {
      out.push({ path: full, label: `logs/${name}`, reason: 'stale-log', bytes: st.size, mtime: st.mtimeMs });
    }
  }

  // Per-project: broken runs, orphan targets, empty dirs.
  const projects = opts.project
    ? [opts.project]
    : listDir(join(root, 'projects'));
  for (const project of projects) {
    const runsDir = projectRunsDir(project);
    for (const runId of listDir(runsDir)) {
      const runPath = join(runsDir, runId);
      const st = safeStat(runPath);
      if (!st?.isDirectory()) continue;
      const hasArtifact = existsSync(join(runPath, 'analysis', 'opportunities.json'));
      const hasSession = existsSync(join(runPath, 'analysis', 'session.loupe'));
      if (!hasArtifact && !hasSession) {
        out.push({
          path: runPath,
          label: `${project}/runs/${runId}`,
          reason: 'broken-run',
          bytes: getDirectorySize(runPath),
          mtime: st.mtimeMs,
        });
      }
    }

    const targetsDir = projectTargetsDir(project);
    for (const targetId of listDir(targetsDir)) {
      const tDir = join(targetsDir, targetId);
      const st = safeStat(tDir);
      if (!st?.isDirectory()) continue;
      // A target without its manifest is a torn write — unusable by
      // `loupe target`/build-this. Targets WITH manifests are never GC'd:
      // the store may hold the only copy of the user's design.
      if (!existsSync(join(tDir, 'target.json'))) {
        out.push({
          path: tDir,
          label: `${project}/targets/${targetId}`,
          reason: 'orphan-target',
          bytes: getDirectorySize(tDir),
          mtime: st.mtimeMs,
        });
      }
    }

    // Empty leftover category dirs (never memory/, config/, sessions/).
    for (const sub of ['runs', 'targets', 'reports', 'packages']) {
      const dir = join(root, 'projects', project, sub);
      const st = safeStat(dir);
      if (st?.isDirectory() && listDir(dir).length === 0) {
        out.push({ path: dir, label: `${project}/${sub}/ (empty)`, reason: 'empty-dir', bytes: 0, mtime: st.mtimeMs });
      }
    }
  }

  return out;
}

export function removeGcCandidates(candidates: GcCandidate[]): { removed: number; failed: number } {
  let removed = 0;
  let failed = 0;
  for (const c of candidates) {
    try {
      rmSync(c.path, { recursive: true, force: true });
      removed++;
    } catch {
      failed++;
    }
  }
  return { removed, failed };
}
