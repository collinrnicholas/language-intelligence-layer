// ─── Runtime path helpers ────────────────────────────────────────
// Thin delegating layer over agent/src/paths.ts — the single source of truth
// for the ~/.loupe layout. This module only ADDS runtime-lifecycle lookups
// (repo detection, category paths); it never redefines the layout.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { LOUPE_HOME, projectRoot, targetsRoot } from '../paths.js';

export function getRuntimeRoot(): string {
  return LOUPE_HOME;
}

export function getProjectRuntimePath(project: string): string {
  return projectRoot(project);
}

export function projectSessionsDir(project: string): string {
  return join(projectRoot(project), 'sessions');
}

export function projectRunsDir(project: string): string {
  return join(projectRoot(project), 'runs');
}

export function projectTargetsDir(project: string): string {
  return targetsRoot(project);
}

export function projectMemoryDir(project: string): string {
  return join(projectRoot(project), 'memory');
}

/**
 * Find the Loupe repo root by walking up from `startDir` looking for the
 * workspace package.json (name "loupe" with workspaces). Returns null when
 * not inside the repo — doctor/status work fine from anywhere.
 */
export function findRepoRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; workspaces?: unknown };
        if (pkg.name === 'loupe' && Array.isArray(pkg.workspaces)) return dir;
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
