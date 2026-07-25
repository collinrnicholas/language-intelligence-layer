# Contributing to Persado Capture

Conventions that keep this repo reviewable. They apply to humans and — with
extra emphasis — to AI coding agents (Claude Code, Codex, etc.) working here.

## File discipline (the anti-sprawl rule)

**Do not create new files unless the task requires it or explicitly requests
it.** Normal implementation work produces:

- source code changes
- tests
- updates to *existing* docs when user-facing behavior changes
- one CHANGELOG entry if appropriate

Do NOT create new docs, specs, research files, benchmark/eval files, target
artifacts, implementation packages, sample outputs, debug traces, screenshots,
or analysis runs unless explicitly asked. Investigation spikes may create
**one** `docs/*_SPIKE.md` — only when a spike was requested.

Generated output goes to `~/.loupe`, never the repo. Full boundary map:
`docs/REPO_HYGIENE.md`. (The runtime directory keeps its inherited name — see the
Provenance section of `README.md`.)

## For AI agents specifically

- Bias to editing existing files over creating new ones.
- A feature does not need a planning doc, a summary doc, AND a report doc —
  behavior changes go into the existing doc that covers that area.
- Running the inherited `loupe analyze` / `build-this` CLI during development
  writes to `~/.loupe` by design; never point `--output` into the repo.
- Before finishing: `npm run repo:check` must pass (the pre-existing
  `sessions/` sprawl at repo root is known; do not add to it).
- Repo conventions that remain in force: wire-or-delete (no dead code paths),
  spec-gate large refactors, capture significant decisions as ADRs in
  `docs/ARCHITECTURE_DECISIONS.md` — an ADR *entry*, not a new file.

## Checks before a PR

```
npm run smoke       # static contract checks for extension/ + gateway/
npm run typecheck
npm test            # agent workspace
npm run repo:check
```

PR checklist lives in `.github/pull_request_template.md`.
