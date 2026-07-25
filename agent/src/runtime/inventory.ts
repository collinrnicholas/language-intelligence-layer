// ─── Runtime inventory ───────────────────────────────────────────
// Counts what exists under ~/.loupe without loading any payloads — statSync
// and directory listings only, so `doctor`/`status` stay instant even with
// gigabytes of runs.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getRuntimeRoot, projectSessionsDir, projectRunsDir, projectTargetsDir, projectMemoryDir } from './paths.js';
import { getDirectorySize } from './disk.js';
import type { ProjectInventory, RuntimeInventory } from './types.js';

function listDir(path: string): string[] {
  try {
    return readdirSync(path).filter(n => n !== '.DS_Store');
  } catch {
    return [];
  }
}

function mtimeIso(path: string): string | null {
  try { return new Date(statSync(path).mtimeMs).toISOString(); } catch { return null; }
}

function readJsonField(path: string, field: string): string | null {
  try {
    const v = (JSON.parse(readFileSyncUtf8(path)) as Record<string, unknown>)[field];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

import { readFileSync } from 'node:fs';
function readFileSyncUtf8(p: string): string { return readFileSync(p, 'utf-8'); }

/** Count implementation packages inside a project's runs. */
function countPackages(runsDir: string, runIds: string[]): number {
  let n = 0;
  for (const runId of runIds) {
    const implDir = join(runsDir, runId, 'implementation');
    n += listDir(implDir).filter(name => name.startsWith('implementation-')).length;
  }
  return n;
}

export function inventoryProject(projectDirName: string): ProjectInventory {
  const path = join(getRuntimeRoot(), 'projects', projectDirName);
  const runsDir = projectRunsDir(projectDirName);
  const runIds = listDir(runsDir);
  const reports = runIds.filter(id => existsSync(join(runsDir, id, 'analysis', 'report.html'))).length;
  const targets = listDir(projectTargetsDir(projectDirName))
    .filter(id => existsSync(join(projectTargetsDir(projectDirName), id, 'target.json'))).length;
  const memoryDir = projectMemoryDir(projectDirName);
  const manifestPath = join(memoryDir, 'manifest.json');

  const newestRun = runIds.sort().at(-1);

  return {
    project: projectDirName,
    path,
    sessions: listDir(projectSessionsDir(projectDirName)).length,
    runs: runIds.length,
    reports,
    packages: countPackages(runsDir, runIds),
    targets,
    hasMemory: existsSync(manifestPath),
    memoryDigestUpdatedAt: existsSync(manifestPath)
      ? readJsonField(manifestPath, 'digestUpdatedAt')
      : null,
    lastRunAt: newestRun ? mtimeIso(join(runsDir, newestRun)) : null,
    bytes: getDirectorySize(path),
  };
}

export function inventoryRuntime(): RuntimeInventory {
  const root = getRuntimeRoot();
  const projects = listDir(join(root, 'projects')).map(inventoryProject);

  const cacheBytes = getDirectorySize(join(root, 'cache'));
  const logsBytes = getDirectorySize(join(root, 'logs'));
  const configBytes = getDirectorySize(join(root, 'config'));
  const projectBytes = projects.reduce((s, p) => s + p.bytes, 0);

  return {
    root,
    projects,
    cacheBytes,
    logsBytes,
    configBytes,
    totalBytes: cacheBytes + logsBytes + configBytes + projectBytes,
    sessions: projects.reduce((s, p) => s + p.sessions, 0),
    runs: projects.reduce((s, p) => s + p.runs, 0),
    reports: projects.reduce((s, p) => s + p.reports, 0),
    packages: projects.reduce((s, p) => s + p.packages, 0),
    targets: projects.reduce((s, p) => s + p.targets, 0),
  };
}

// ─── Latest-artifact lookups (loupe status) ─────────────────────

export interface ProjectLatest {
  session: string | null;
  run: string | null;
  report: string | null;
  package: string | null;
  target: string | null;
}

export function projectLatest(projectDirName: string): ProjectLatest {
  const runsDir = projectRunsDir(projectDirName);
  const runIds = listDir(runsDir).sort();
  const latestRun = runIds.at(-1) ?? null;

  const latestReportRun = [...runIds].reverse()
    .find(id => existsSync(join(runsDir, id, 'analysis', 'report.html'))) ?? null;

  let latestPackage: string | null = null;
  for (const id of [...runIds].reverse()) {
    const pkgs = listDir(join(runsDir, id, 'implementation'))
      .filter(n => n.startsWith('implementation-')).sort();
    if (pkgs.length > 0) { latestPackage = join(runsDir, id, 'implementation', pkgs.at(-1)!); break; }
  }

  const sessions = listDir(projectSessionsDir(projectDirName)).sort();
  const targetsDir = projectTargetsDir(projectDirName);
  const targets = listDir(targetsDir)
    .filter(id => existsSync(join(targetsDir, id, 'target.json')))
    .map(id => ({ id, at: (() => { try { return statSync(join(targetsDir, id)).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => a.at - b.at);

  return {
    session: sessions.at(-1) ?? null,
    run: latestRun,
    report: latestReportRun ? join(runsDir, latestReportRun, 'analysis', 'report.html') : null,
    package: latestPackage,
    target: targets.at(-1)?.id ?? null,
  };
}
