# Repo Hygiene — Artifact Boundaries

One rule: **the repo holds source and intent; `~/.loupe` holds everything
Loupe generates.** `npm run repo:check` enforces it; `loupe clean` sweeps the
generated side.

## What belongs where

| Location | Contents |
|---|---|
| **Repo** | Source (`agent/`, `extension/`, `gateway/`, `analyzer/`, `app/`), tests, prompts, docs that describe behavior, benchmarks/eval *definitions*, CI/scripts |
| **`~/.loupe`** | ALL generated runtime output: `projects/<p>/runs/` (analysis runs, reports, screenshots, debug traces), `projects/<p>/memory/`, `projects/<p>/sessions/` (captures), target-design artifact stores, `cache/`, `logs/`, `config/`, `gateway.env` |
| **`~/Downloads/loupe/`** | `.loupe` exports from the extension — the extension→CLI handoff, local testing only |
| **`~/Loupe/implementation-packages/`** | Locally-routed implementation packages (destination output) |
| **`docs/`** | Behavior documentation and ADRs. Updated when behavior changes — not a scratchpad. Investigation spikes: at most one `docs/*_SPIKE.md`, and only when explicitly requested |
| **`evals/` + `benchmarks/`** | Rubrics, fixtures, expected outputs, and result *schemas*. Committed fixtures live ONLY under `benchmarks/`, `evals/fixtures/`, or `agent/test/` |

## When new files are allowed

Default for implementation work: **source changes, tests, updates to existing
docs when behavior changes, one CHANGELOG entry if appropriate. Nothing else.**

Create a new file only when:
- the task explicitly requests it (a named doc, a new command, a new module), or
- it's a new source/test module that the change genuinely requires.

Never create (unless explicitly requested): new docs/specs/research files,
benchmark/eval files, target artifacts, generated implementation packages,
sample output directories, debug traces, screenshots, analysis runs.

## Enforcement

- **`npm run repo:check`** — fails when artifact files (`report.html`,
  `opportunities.json`, `*.loupe`, memory files) or artifact directories
  (`runs/`, `screenshots/`, `debug/`, `implementation-*`, `sessions/`,
  `memory/`, `target-design-artifacts/`, tracked `dist/`) appear in repo paths
  outside the approved fixture locations. Uses `git ls-files` when available,
  filesystem scan otherwise.
- **`.gitignore`** — blankets the same patterns so they can't be committed by
  accident.
- **PR template** — `.github/pull_request_template.md` checklist includes
  `repo:check`.

## Cleaning generated artifacts

```
loupe doctor                      # health report + recommended actions
loupe status [--project p]        # compact runtime summary
loupe gc [--dry-run]              # orphans/stale only (always memory-safe)
loupe clean --dry-run             # see what would go
loupe clean                       # runs + packages + caches/logs
loupe clean --runs --older-than 7d
loupe clean --packages
loupe clean --local-artifacts     # caches + logs only
loupe runtime migrate --apply     # move repo-root artifact dirs into ~/.loupe
```

Full runtime layout and safety rules: `docs/RUNTIME.md`.

`loupe clean` only ever deletes generated output under `~/.loupe` and
`~/Loupe/implementation-packages`. It never touches source files, `config/`,
project `memory/`, captured `sessions/`, or `gateway.env`. After cleaning
runs, `loupe memory index <project>` re-derives memory if you want it to
forget the removed runs.
