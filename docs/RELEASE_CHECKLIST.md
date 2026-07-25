# Loupe v2 Alpha Release Checklist

Checklist for cutting a v2.0-alpha release. Run through in order.

---

## Pre-Release

### Code Health
- [ ] `npm run build` passes (root workspace builds both agent and extension)
- [ ] `npm test` passes (all 8 hardening tests)
- [ ] `npm run typecheck` passes in both workspaces
- [ ] No `require()` calls in ESM modules (`llm/types.ts` loadDotEnv)
- [ ] No empty monorepo workspace references in root `package.json`

### Extension
- [ ] Loaded unpacked in Chrome
- [ ] Recording starts and stops cleanly
- [ ] .loupe file downloads to `~/Downloads/loupe/`
- [ ] Session summary displays after stop (Clicks, Screenshots, DOM, Notes)
- [ ] Agent Workspace card shows correct agent identity
- [ ] Config overlay opens, saves, and persists across popup reopen
- [ ] Permission state shown when mic not granted
- [ ] Recording state shows live capture health updates
- [ ] Timer runs correctly during recording
- [ ] Pause/Resume works

### CLI
- [ ] `loupe validate` passes on a real .loupe file
- [ ] `loupe transcribe` works (requires OPENAI_API_KEY)
- [ ] `loupe analyze` runs end-to-end (deterministic + drift + AI)
- [ ] `loupe analyze --no-ai` runs deterministic only (no API key needed)
- [ ] `loupe build-this` produces a valid implementation package
- [ ] `loupe build-this --destination local` routes to configured folder
- [ ] `loupe destination list` shows all 6 default destinations
- [ ] `loupe destination set --id test --type claude-code --workspace ~/Projects/Test --output .ai/tasks` creates and persists config
- [ ] `loupe destination test --id local` passes dry-run

### Artifacts
- [ ] .loupe file is valid JSON
- [ ] .loupe file passes `loupe validate` with health > 80
- [ ] opportunities.json is valid v2 format (relative screenshot paths, no base64)
- [ ] Report HTML opens in browser without errors
- [ ] Implementation package has all expected files

### API Keys
- [ ] Works with `ANTHROPIC_API_KEY` only (no OPENAI_KEY)
- [ ] Works with `OPENAI_API_KEY` only (no ANTHROPIC_KEY)
- [ ] Works with `~/.loupe/.env` file
- [ ] Clear error when no keys set

---

## Release

- [ ] Version bumped in `agent/package.json` and `extension/package.json`
- [ ] `CHANGELOG.md` updated
- [ ] Tagged: `git tag v2.0.0-alpha`
- [ ] Pushed with tags
- [ ] CI green on the tagged commit

---

## Post-Release

- [ ] Extension repacked for Chrome Web Store (`npm run build && zip -r loupe.zip dist/`)
- [ ] Release notes drafted
- [ ] Demo recorded (record → analyze → build-this → destination loop)
