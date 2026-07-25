# Loupe Runtime

**Repo = source, docs, tests, fixtures. `~/.loupe` = runtime state.** This doc
covers the runtime side: what lives where, and the lifecycle commands that
keep it inspectable and clean. Repo-side rules: `docs/REPO_HYGIENE.md`.

## Layout

```
~/.loupe/
  config/                 client.json, routing.json, routing-policy.json,
                          design-system.json, destinations.json
  gateway.env             provider keys (gateway-side only, ADR-010)
  projects/<project>/
    sessions/             captured session payloads (user data — never auto-deleted)
    runs/<runId>/
      analysis/           session.loupe, opportunities.json, report.html,
                          screenshots/, debug/
      implementation/     implementation-<ts>/ packages
    targets/<targetId>/   persisted target designs (target.json + source file)
    memory/               project memory (derived from runs/ — ADR-019)
  cache/                  llm/, transcribe/, png/ response caches
  logs/                   gateway logs
  migrated/<ts>/          artifacts parked by `loupe runtime migrate`
```

## Lifecycle commands

| Command | What it does |
|---|---|
| `loupe doctor` | One-command health report: version, runtime root, counts (projects/sessions/runs/reports/packages/targets), memory health, cache/log/disk sizes, gateway reachability, repo hygiene (when run inside the repo), warnings with recommended fixes. Exits 1 when warnings exist. |
| `loupe status` | Compact summary. All projects at a glance, or `--project <p>` for latest session/run/report/package/target, memory digest time, and per-category disk usage. |
| `loupe gc [--dry-run] [--project p] [--older-than 30d]` | Collects **provably safe** garbage only: stale cache entries and logs (default cutoff 30d), broken run dirs (no artifact AND no session — memory never indexed them), torn target dirs (no `target.json`), empty leftover scaffolding. |
| `loupe clean [--runs\|--packages\|--local-artifacts] [--older-than 7d] [--dry-run]` | Bulk removal of *valid* generated artifacts. Removing runs affects memory — see below. |
| `loupe runtime migrate [--apply]` | Moves generated artifact dirs (`sessions/`, `runs/`, `reports/`, `implementation-packages/`, `target-design/`, `screenshots/`, `debug/`, `traces/`) out of the repo root. Project-owned captures map to `~/.loupe/projects/<p>/`; unclassifiable dirs park under `~/.loupe/migrated/<ts>/` so nothing is lost. Dry-run by default. |

## Safety rules

Cleanup commands can never touch: source files (they don't know where the
repo is), `config/`, project `memory/`, captured `sessions/`, `gateway.env`,
valid runs (gc), valid targets (gc — the store may hold the only copy of a
design), benchmark/eval fixtures.

**Memory implication of deleting runs:** project memory is *derived from*
`runs/` (ADR-019). `loupe gc` therefore never deletes valid runs. `loupe clean
--runs` does — after it, run `loupe memory index <project>` to make memory
forget the removed runs (human `mark` events and fast-build records survive
re-indexing by design).

## Where generated artifacts should live

Every Loupe command writes to `~/.loupe` (or `~/Downloads/loupe/` for
extension exports, `~/Loupe/implementation-packages/` for the local
destination). If generated output ever appears in the repo, `npm run
repo:check` fails and names it; `loupe runtime migrate --apply` moves it out.
