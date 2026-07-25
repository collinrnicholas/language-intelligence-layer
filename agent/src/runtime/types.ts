// ─── Runtime lifecycle types ─────────────────────────────────────
// Shared shapes for doctor / status / gc / migrate. The runtime layout these
// describe is docs/RUNTIME.md; the code source of truth for paths stays in
// agent/src/paths.ts (runtime/paths.ts delegates to it).

export interface ProjectInventory {
  project: string;              // directory name under ~/.loupe/projects
  path: string;
  sessions: number;             // captured session files
  runs: number;                 // analysis runs
  reports: number;              // runs containing analysis/report.html
  packages: number;             // implementation packages inside runs
  targets: number;              // persisted target-design artifacts
  hasMemory: boolean;
  memoryDigestUpdatedAt: string | null;
  lastRunAt: string | null;     // mtime-derived ISO of the newest run
  bytes: number;
}

export interface RuntimeInventory {
  root: string;
  projects: ProjectInventory[];
  cacheBytes: number;
  logsBytes: number;
  configBytes: number;
  totalBytes: number;
  sessions: number;
  runs: number;
  reports: number;
  packages: number;
  targets: number;
}

export interface DoctorWarning {
  message: string;
  /** The command that addresses it, shown under "Recommended". */
  recommend?: string;
}

export interface DoctorReport {
  version: string;
  runtimeRoot: string;
  repoRoot: string | null;
  inventory: RuntimeInventory;
  gateway: { reachable: boolean; url: string };
  repoArtifacts: RepoArtifact[];   // [] when clean or no repo detected
  warnings: DoctorWarning[];
}

export interface RepoArtifact {
  /** Path relative to the repo root, e.g. "sessions/". */
  rel: string;
  abs: string;
}

export interface MigrationItem {
  source: string;               // absolute path in the repo
  dest: string;                 // absolute path under ~/.loupe (or ~/Loupe)
  /** Confident items map to a real runtime location (e.g. a project's
   *  sessions dir); unconfident ones park under ~/.loupe/migrated/<ts>/. */
  confident: boolean;
}

export interface GcCandidate {
  path: string;
  label: string;
  reason:
    | 'stale-cache'
    | 'stale-log'
    | 'broken-run'
    | 'orphan-target'
    | 'empty-dir';
  bytes: number;
  mtime: number;
}
