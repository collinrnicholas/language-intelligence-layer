# Loupe Roadmap

**Current version:** v2.0-alpha (June 2026)

This roadmap separates shipped reality from future plans. Items under "Shipped" are working today. Items under "Next" are ordered by priority. Items under "Future" are validated but not scoped.

---

## Shipped (v2.0-alpha)

### Recording
- [x] Chrome extension (MV3) — content script, background service worker, offscreen doc
- [x] Click capture (selector, position, text content)
- [x] Scroll capture (throttled 300ms)
- [x] DOM snapshot capture (2s interval + on click, 10KB HTML + computed styles)
- [x] SPA route change detection (pushState, replaceState, popstate, hashchange)
- [x] Console error interception (patches `console.error`)
- [x] Network timing (Performance API, 5s interval)
- [x] Screenshots (JPEG, 60 quality, 2s interval)
- [x] Mic capture (getUserMedia → MediaRecorder → base64)
- [x] Session-relative timestamps (all events use same clock)
- [x] MV3 durability (chrome.storage.local, alarm heartbeat, restore on wake)
- [x] 5-state popup UI (Permission, Ready, Recording, Saved, Recovered)
- [x] Agent Workspace card (agent identity badges, workspace path, config overlay)

### CLI
- [x] `loupe init` — create project workspace
- [x] `loupe validate` — schema checks + health score (0-100)
- [x] `loupe transcribe` — OpenAI Whisper → timestamped notes
- [x] `loupe analyze` — full pipeline (deterministic → drift → AI → score → report)
- [x] `loupe build-this` — generate implementation package + route to destination
- [x] `loupe destination list/show/set/test` — manage agent workspace configs
- [x] `loupe list` — browse projects and sessions
- [x] `loupe open` — open latest report

### Analysis
- [x] Deterministic checks (console errors, touch targets, slow requests, SPA health, narration)
- [x] Design drift checks (color tokens, fonts, radii, spacing, shadows)
- [x] 5 AI reviewer personas (PM, Designer, Design Systems, Accessibility, Frontend)
- [x] Merge + dedupe across reviewers
- [x] Evidence model (screenshot refs, DOM snapshot refs, event refs, URL, selector)
- [x] Scoring engine (100 base, severity-weighted deductions, per-category)
- [x] Top 5 prioritization (severity × confidence × narration match × reviewer count)
- [x] Opportunity taxonomy (8 categories, 5 severity levels)
- [x] LLM router (task-based model selection, provider adapters, fallback chain)

### Build This
- [x] Explain mode (deterministic design principles + optional AI enrichment)
- [x] Redesign mode (8-dimension proposed experience)
- [x] Build This mode (implementation brief with 11 sections)
- [x] Shared Context Builder (evidence assembled once for all 3 modes)
- [x] Multi-opportunity merge (dedup by selector + category)
- [x] Implementation package (summary.md, build-prompt.md, acceptance-criteria.md, findings.json, context.json, screenshots/, design-system.json)
- [x] 7 destination providers (local, claude-code, cursor, codex, gemini, clipboard, custom-command)
- [x] Target Design v1.5 — persisted target artifacts, unified across both build paths (see below)

### Infrastructure
- [x] .loupe schema (flat, 11 top-level fields)
- [x] v2 artifact format (opportunities.json, referenced screenshots, no base64)
- [x] back-compat with v1 schema
- [x] .env support (`~/.loupe/.env` + project `.env`)
- [x] Design system JSON config
- [x] CI workflow (build + typecheck + test on ubuntu/node 20)
- [x] 8 hardening tests (quarantine, timestamp, path traversal, schema, golden fixture)
- [x] Architecture decisions (9 ADRs in ARCHITECTURE_DECISIONS.md)

---

## Next (P0 — Hardening)

### Required before v2.0-beta
- [ ] Fix `require()` in `llm/types.ts` — rewrite `loadDotEnv()` to use dynamic `import()` instead of synchronous `require()` in ESM context
- [ ] Rename `extension/package.json` name from `spotter-extension` → `loupe-extension`
- [ ] Remove empty monorepo workspaces (`analyzer/`, `app/`) from root `package.json`
- [ ] Add 3-5 edge-case fixture sessions (empty, 0 events, malformed audio, broken JSON)
- [ ] Add extension browser tests (Playwright extension test harness)
- [ ] Add `loupe explain` and `loupe redesign` CLI commands
- [ ] Publish evaluation rubric automated via `loupe eval`

---

## Shipped (July 2026) — Intent-based pipelines

Users choose outcomes, not modes (see `docs/UX_STATES.md`):
- ⚡ **Build This** (`loupe build-this`) — fast path: deterministic checks →
  vision observation pass (≤5 keyframes, `--deep` for 10) → Claude Sonnet
  brief synthesis. No persona fanout. Target 30–60 s.
- 👁 **UX Review** (`loupe review`) — vision pass + single reasoning synthesis
  into opportunities. No persona fanout. Target 1–2 min.
- 🔍 **Complete Audit** (`loupe audit`) — the only fanout-heavy path:
  5-persona review + judge. Target 3–5+ min.

Internal task-based routing (GPT vision / Claude Sonnet reasoning, structured
`UIObservation` handoff, provider fallbacks) is in `agent/src/llm/routing-policy.ts`
and documented in ARCHITECTURE.md §5. Extension popup exposes the three intents
as action cards after capture.

---

## Shipped (July 2026) — Target Design v1.5

Target Design is now a **first-class, persisted artifact** (the desired state),
not a transient CLI argument. Motivated by `docs/TARGET_DESIGN_INVESTIGATION.md`.

- [x] Persisted artifacts under `~/.loupe/projects/<p>/targets/<id>/` (`target.json`, `source.<ext>`, `summary.md`), content-addressed for dedup
- [x] One shared loader/service (`target-design/artifact.ts`) used by both Build This paths — divergence eliminated
- [x] Image targets vision-compared (current vs target) on **both** fast and rich paths
- [x] HTML/Markdown targets consistently included + copied into the package on both paths
- [x] `loupe target add|list|show`; `loupe build-this --target-id <id>` to reuse; `--target-design <file>` still works (creates/reuses an artifact)
- [x] Packages always ship `target-design/`; `context.json` references `targetDesign.id`; unified Target Design brief section
- [x] Multi-target: one session → many targets; each package records which target it built against
- [x] 10 target-design tests (`agent/test/target-design.test.mjs`)

Deferred to the Long-term Project graph: persisted CurrentState, Figma/Claude-Design
URL ingest, PDF/clipboard sources, target comparison/switch UI.

---

## Shipped (July 2026) — Project Memory v1

Local-first session memory (ADR-019, `docs/SESSION_MEMORY_SPIKE.md`):
`~/.loupe/projects/<p>/memory/` — JSONL indexes derived from `runs/`,
deterministic recurrence signatures, accept/reject/verify lifecycle via
`loupe memory mark`, hint/pattern/rule preferences with stale decay, and a
redacted `memory-digest.md` injected into Build This + Redesign prompts only.
Inspect with `loupe memory digest <project>`. Verify-Loop integration and
wider injection are future phases.

---

## Next (P1 — Product Loop)

### v2.0-beta
- [ ] AI Redesign — generate proposed screens/flow before generating code (Phase 3)
- [ ] Verify Loop — re-record after implementation → compare score → generate follow-up prompt (Phase 4)
- [ ] Continuous improvement — automated scoring delta tracking (Phase 5)
- [ ] Report UI buttons: 👁 Explain · 🎨 Redesign · ⚡ Build This
- [ ] `loupe build-this` interactive finding selection with checkboxes

---

## Next (P2 — Evaluation Quality)

### v2.1
- [ ] Benchmark Loupe against PM Toolkit, FitHub, Loupe itself, one public SaaS
- [ ] Automated eval scoring (`loupe eval`)
- [ ] Eval results dashboard (markdown + JSON output)
- [ ] Prompt versioning and A/B comparison
- [ ] False positive rate tracking

---

## Future

### Studio (v3)
- [ ] Web dashboard (Supabase-backed)
- [ ] Session browser
- [ ] Team sharing
- [ ] SaaS API gateway
- [ ] Linear, GitHub, Notion integrations
- [ ] GitHub PR comment posting
- [ ] CI integration (`loupe ci --url $PREVIEW_URL`)

### Extension
- [ ] Tab audio capture (in addition to mic)
- [ ] Mouse movement heatmap
- [ ] Manual note-taking during recording

### Analysis
- [ ] Multi-language support
- [ ] Custom reviewer personas
- [ ] Design system drift auto-repair (generate token-fixing PR)
- [ ] Accessibility auto-fix suggestions

---

## Non-Goals

- The popup will NOT become a report viewer.
- The extension will NOT run LLM calls.
- The analyzer will NOT run in the browser.
- Loupe will NOT store sessions in the cloud unless explicitly configured (SaaS mode).
