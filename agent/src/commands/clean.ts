// ─── `loupe clean` — sweep generated artifacts, never source ────
//
// Cleans ONLY generated output under ~/.loupe and the local implementation-
// package destination (~/Loupe/implementation-packages). It never touches:
//   - the repo / any source files (it doesn't even know where the repo is)
//   - ~/.loupe/config/            (user configuration)
//   - ~/.loupe/projects/*/memory/ (learned project memory)
//   - ~/.loupe/projects/*/sessions/ (captured session data — user recordings)
//   - ~/.loupe/gateway.env
//
// Scopes: --runs (analysis runs), --packages (implementation packages),
// --local-artifacts (cache + logs). No scope = all three. --older-than 7d
// filters by mtime; --dry-run lists without deleting.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LOUPE_HOME } from '../paths.js';

export interface CleanOptions {
  dryRun?: boolean;
  localArtifacts?: boolean;
  packages?: boolean;
  runs?: boolean;
  olderThan?: string;
}

/** Parse "7d" / "24h" / "90m" into milliseconds. Exported for tests. */
export function parseOlderThan(spec: string): number | null {
  const m = /^(\d+)\s*([dhm])$/i.exec(spec.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return n * (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000);
}

interface Candidate {
  path: string;
  label: string;
  mtime: number;
  bytes: number;
}

function dirSize(path: string): number {
  let total = 0;
  try {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      const st = statSync(full);
      total += st.isDirectory() ? dirSize(full) : st.size;
    }
  } catch { /* partial size is fine for reporting */ }
  return total;
}

function collectDirs(parent: string, label: string): Candidate[] {
  if (!existsSync(parent)) return [];
  const out: Candidate[] = [];
  for (const name of readdirSync(parent)) {
    const full = join(parent, name);
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      out.push({ path: full, label: `${label}/${name}`, mtime: st.mtimeMs, bytes: dirSize(full) });
    } catch { /* skip unreadable */ }
  }
  return out;
}

function fmtBytes(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.ceil(n / 1024)} KB`;
}

export async function cleanCommand(opts: CleanOptions): Promise<void> {
  const scopes = {
    runs: !!opts.runs,
    packages: !!opts.packages,
    local: !!opts.localArtifacts,
  };
  // No explicit scope = clean everything cleanable.
  if (!scopes.runs && !scopes.packages && !scopes.local) {
    scopes.runs = scopes.packages = scopes.local = true;
  }

  let cutoff = 0; // mtime must be OLDER than this to qualify; 0 = everything
  if (opts.olderThan) {
    const ms = parseOlderThan(opts.olderThan);
    if (ms === null) {
      console.error(`Invalid --older-than value: "${opts.olderThan}" (use e.g. 7d, 24h, 90m)`);
      process.exitCode = 1;
      return;
    }
    cutoff = Date.now() - ms;
  }

  const candidates: Candidate[] = [];
  const projectsDir = join(LOUPE_HOME, 'projects');

  if (scopes.runs && existsSync(projectsDir)) {
    for (const project of readdirSync(projectsDir)) {
      candidates.push(...collectDirs(join(projectsDir, project, 'runs'), `${project}/runs`));
    }
  }

  if (scopes.packages) {
    // Implementation dirs beside runs (runs/<id>/implementation is inside the
    // run — covered by --runs; this covers the local destination).
    candidates.push(...collectDirs(join(homedir(), 'Loupe', 'implementation-packages'), 'implementation-packages'));
  }

  if (scopes.local) {
    candidates.push(...collectDirs(join(LOUPE_HOME, 'cache'), 'cache'));
    candidates.push(...collectDirs(join(LOUPE_HOME, 'logs'), 'logs'));
  }

  const selected = candidates.filter(c => cutoff === 0 || c.mtime < cutoff);
  if (selected.length === 0) {
    console.log('Nothing to clean' + (opts.olderThan ? ` older than ${opts.olderThan}` : '') + '.');
    return;
  }

  const total = selected.reduce((s, c) => s + c.bytes, 0);
  console.log(`${opts.dryRun ? 'Would remove' : 'Removing'} ${selected.length} artifact dir(s) · ${fmtBytes(total)}` +
    (opts.olderThan ? ` · older than ${opts.olderThan}` : ''));
  for (const c of selected.sort((a, b) => a.label.localeCompare(b.label))) {
    console.log(`  ${opts.dryRun ? '·' : '✗'} ${c.label}  (${fmtBytes(c.bytes)})`);
    if (!opts.dryRun) {
      try { rmSync(c.path, { recursive: true, force: true }); } catch (e) {
        console.error(`    failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  if (opts.dryRun) {
    console.log('\nDry run — nothing deleted. Re-run without --dry-run to remove.');
  } else {
    console.log(`\n✓ Cleaned ${fmtBytes(total)}. Config, project memory, and captured sessions were not touched.`);
    if (scopes.runs) console.log('  Note: project memory derives from runs — run `loupe memory index <project>` if you want memory to forget the removed runs.');
  }
}
