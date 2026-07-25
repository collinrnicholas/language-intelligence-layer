// ─── loupe doctor — runtime health report ────────────────────────
// Pure derivation (buildDoctorReport / deriveWarnings) separated from
// printing so tests exercise the logic without a filesystem of gigabytes.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inventoryRuntime } from './inventory.js';
import { findGeneratedRepoArtifacts } from './migrate.js';
import { findRepoRoot, getRuntimeRoot, projectRunsDir } from './paths.js';
import { formatBytes } from './disk.js';
import { pingGateway } from '../llm/index.js';
import type { DoctorReport, DoctorWarning, RuntimeInventory, RepoArtifact } from './types.js';

const PACKAGE_STALE_MS = 30 * 86_400_000;
const CACHE_WARN_BYTES = 1e9;   // 1 GB
const LOGS_WARN_BYTES = 100e6;  // 100 MB

/** Count packages older than the cutoff across all projects (mtime-based). */
export function countStalePackages(inv: RuntimeInventory, now = Date.now()): number {
  let stale = 0;
  for (const p of inv.projects) {
    const runsDir = projectRunsDir(p.project);
    let runIds: string[] = [];
    try { runIds = readdirSync(runsDir); } catch { continue; }
    for (const runId of runIds) {
      const implDir = join(runsDir, runId, 'implementation');
      let pkgs: string[] = [];
      try { pkgs = readdirSync(implDir).filter(n => n.startsWith('implementation-')); } catch { continue; }
      for (const pkg of pkgs) {
        try {
          if (now - statSync(join(implDir, pkg)).mtimeMs > PACKAGE_STALE_MS) stale++;
        } catch { /* skip */ }
      }
    }
  }
  return stale;
}

/** Warnings + recommendations from an inventory snapshot. Pure — testable. */
export function deriveWarnings(
  inv: RuntimeInventory,
  repoArtifacts: RepoArtifact[],
  gatewayReachable: boolean,
  stalePackages: number,
): DoctorWarning[] {
  const warnings: DoctorWarning[] = [];

  for (const a of repoArtifacts) {
    warnings.push({
      message: `Repo contains generated ${a.rel} directory`,
      recommend: 'loupe runtime migrate --apply',
    });
  }

  if (stalePackages > 0) {
    warnings.push({
      message: `${stalePackages} package(s) older than 30 days`,
      recommend: 'loupe clean --runs --older-than 30d',
    });
  }

  for (const p of inv.projects) {
    if (!p.hasMemory && p.runs > 0) {
      warnings.push({
        message: `No project memory for ${p.project} (${p.runs} runs unindexed)`,
        recommend: `loupe memory index ${p.project}`,
      });
    } else if (p.hasMemory && p.memoryDigestUpdatedAt && p.lastRunAt &&
               p.memoryDigestUpdatedAt < p.lastRunAt) {
      warnings.push({
        message: `Memory digest stale for ${p.project} (runs newer than digest)`,
        recommend: `loupe memory index ${p.project}`,
      });
    }
  }

  if (inv.cacheBytes > CACHE_WARN_BYTES) {
    warnings.push({
      message: `Cache is ${formatBytes(inv.cacheBytes)}`,
      recommend: 'loupe gc',
    });
  }
  if (inv.logsBytes > LOGS_WARN_BYTES) {
    warnings.push({
      message: `Logs are ${formatBytes(inv.logsBytes)}`,
      recommend: 'loupe gc',
    });
  }
  if (!gatewayReachable) {
    warnings.push({
      message: 'AI gateway unreachable — analysis will run deterministic-only',
      recommend: 'npm run gateway  (with provider key configured)',
    });
  }
  return warnings;
}

export async function buildDoctorReport(version: string, cwd = process.cwd()): Promise<DoctorReport> {
  const inventory = inventoryRuntime();
  const repoRoot = findRepoRoot(cwd);
  const repoArtifacts = repoRoot ? findGeneratedRepoArtifacts(repoRoot) : [];
  const gateway = await pingGateway();
  const stalePackages = countStalePackages(inventory);

  return {
    version,
    runtimeRoot: getRuntimeRoot(),
    repoRoot,
    inventory,
    gateway,
    repoArtifacts,
    warnings: deriveWarnings(inventory, repoArtifacts, gateway.reachable, stalePackages),
  };
}

export function renderDoctorReport(r: DoctorReport): string {
  const inv = r.inventory;
  const memoryHealthy = inv.projects.every(p => !p.hasMemory || !p.lastRunAt ||
    (p.memoryDigestUpdatedAt !== null && p.memoryDigestUpdatedAt >= p.lastRunAt));
  const lines = [
    'Loupe Doctor',
    '',
    `Version:    ${r.version}`,
    ...(r.repoRoot ? [`Repo:       ${r.repoRoot}`] : []),
    `Runtime:    ${r.runtimeRoot}`,
    `Projects:   ${inv.projects.length}`,
    `Sessions:   ${inv.sessions}`,
    `Runs:       ${inv.runs}`,
    `Reports:    ${inv.reports}`,
    `Packages:   ${inv.packages}`,
    `Targets:    ${inv.targets}`,
    `Memory:     ${memoryHealthy ? 'Healthy' : 'Stale — see warnings'}`,
    `Cache:      ${formatBytes(inv.cacheBytes)}`,
    `Logs:       ${formatBytes(inv.logsBytes)}`,
    `Disk Usage: ${formatBytes(inv.totalBytes)}`,
    `Gateway:    ${r.gateway.reachable ? `reachable (${r.gateway.url})` : `unreachable (${r.gateway.url})`}`,
    ...(r.repoRoot ? [`Repo hygiene: ${r.repoArtifacts.length === 0 ? 'clean' : `${r.repoArtifacts.length} artifact dir(s) in repo`}`] : []),
  ];

  if (r.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const w of r.warnings) lines.push(`- ${w.message}`);
    const recs = [...new Set(r.warnings.map(w => w.recommend).filter((x): x is string => !!x))];
    if (recs.length > 0) {
      lines.push('', 'Recommended:');
      for (const rec of recs) lines.push(`- ${rec}`);
    }
  } else {
    lines.push('', 'No warnings — runtime is healthy.');
  }
  return lines.join('\n');
}
