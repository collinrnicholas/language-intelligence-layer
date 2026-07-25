// ─── Loupe Filesystem Layout ─────────────────────────────────────
//
// Single source of truth for where Loupe reads and writes. Centralizing this
// here removes the LOUPE_HOME / design-system / project-dir duplication that was
// spread across commands, and guarantees every project-derived path is sanitized
// (no traversal via a malicious `project` name).

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync } from 'node:fs';

export const LOUPE_HOME = join(homedir(), '.loupe');

/**
 * Sanitize a project name into a safe single path segment.
 * Collapses anything outside [A-Za-z0-9_-] to "_", trims leading/trailing "_",
 * and never returns an empty string — so it can never traverse or escape.
 */
export function safeProjectDir(project: string): string {
  return project.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'project';
}

/** `~/.loupe/projects/<safeProject>` */
export function projectRoot(project: string): string {
  return join(LOUPE_HOME, 'projects', safeProjectDir(project));
}

/** A sortable run id derived from a timestamp, e.g. 2026-06-27T12-00-00-000Z */
export function makeRunId(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** `~/.loupe/projects/<safeProject>/runs/<runId>` */
export function runDir(project: string, runId: string): string {
  return join(projectRoot(project), 'runs', runId);
}

/** `~/.loupe/projects/<safeProject>/targets` — home of persisted TargetDesign artifacts. */
export function targetsRoot(project: string): string {
  return join(projectRoot(project), 'targets');
}

/** `~/.loupe/projects/<safeProject>/targets/<targetId>` — a single target artifact dir. */
export function targetDir(project: string, targetId: string): string {
  return join(targetsRoot(project), safeProjectDir(targetId));
}

/** Enumerate every `~/.loupe/projects/*` directory (safe project dir names). */
export function allProjectDirs(): string[] {
  const root = join(LOUPE_HOME, 'projects');
  try {
    return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return [];
  }
}

/**
 * Design-system lookup order: project-specific first, then the global default.
 * Both paths are project-sanitized.
 *
 * NOTE: this global fallback is for *implementation-package* generation only.
 * Design-drift checks must NOT use it — see `projectDesignSystemPath`.
 */
export function designSystemPaths(project: string): string[] {
  return [
    projectDesignSystemPath(project),
    join(LOUPE_HOME, 'config', 'design-system.json'),
  ];
}

/**
 * The per-project design system path — the ONLY baseline drift is allowed to use.
 * Drift never falls back to the global file: grading an arbitrary project's CSS
 * against another project's (or Loupe's own) tokens produces confident-but-wrong
 * findings, so absent this file drift is skipped entirely.
 */
export function projectDesignSystemPath(project: string): string {
  return join(projectRoot(project), 'config', 'design-system.json');
}
