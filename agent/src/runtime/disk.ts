// ─── Disk accounting helpers ─────────────────────────────────────

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Recursive size of a directory (0 for missing paths; unreadable entries skipped). */
export function getDirectorySize(path: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    // Not a directory (or unreadable) — try as a file.
    try { return statSync(path).size; } catch { return 0; }
  }
  for (const name of entries) {
    const full = join(path, name);
    try {
      const st = statSync(full);
      total += st.isDirectory() ? getDirectorySize(full) : st.size;
    } catch { /* skip unreadable */ }
  }
  return total;
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
