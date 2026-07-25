# Architecture Decision Records

This file documents the key architectural decisions made in Loupe. Each ADR follows the format: Context → Decision → Consequences.

---

## ADR-001: Flat `.loupe` Session Format

**Context:** The session file needs to be the contract between extension → analyzer → report. Early prototypes used a nested metadata wrapper (`{ version, metadata: {...}, events: [...] }`), which added verbosity and made it harder to pipe between tools.

**Decision:** Use a flat, single-level JSON object. All 11 fields (`project`, `flow`, `startedAt`, `endedAt`, `urlTimeline`, `events`, `screenshots`, `viewport`, `browser`, `notes`, `audioData`) sit at the top level. No wrapper object. No version field on the session itself (the `.loupe` extension is the version marker).

**Consequences:**
+ Trivial to read, diff, and pipe between CLI tools
+ No path through nested objects for validation
+ Schema changes are easy to detect (field presence, not wrapper version)
− Must duplicate type defs in extension (`types.ts`) and agent (`cli.ts`) since they're separate npm workspaces

---

## ADR-002: Opportunities Replace Findings

**Context:** Early versions used the term "Findings" for analysis results. The tone felt negative — users interpreted it as a bug report. The naming also didn't distinguish between automated hits and AI-generated insights.

**Decision:** Rename "Findings" to "Opportunities" throughout the product. Also rename:
- `UXFinding` → `Opportunity` (TypeScript type)
- `FindingCategory` → `OpportunityCategory`
- `FindingSeverity` → `OpportunitySeverity`

**Consequences:**
+ Constructive tone — feels actionable rather than accusatory
+ Matches the product philosophy: every observation is an opportunity to improve
− Requires renaming across 15 source files (type definitions, imports, CLI flags, report sections)

---

## ADR-003: Deterministic Checks Before AI

**Context:** Early prototypes sent raw session data directly to an LLM for analysis. This was expensive, slow, and inconsistent — the same session could produce different results across runs. Many checks (console errors, touch target size, color drift) are purely mechanical and a human doesn't add value.

**Decision:** Run deterministic checks first, before any LLM call. These are:
- Console error detection (no LLM)
- Touch target size (< 44px → WCAG violation)
- URL navigation health (SPA dead clicks)
- Missing narration
- Design token drift (color, font, radius, spacing, shadow)

Only after these complete does the AI review run. The AI receives the deterministic findings as context — it doesn't have to rediscover them.

**Consequences:**
+ Fast — all deterministic checks complete in < 1s
+ Deterministic — same session → same results, every run
+ Cheap — no LLM tokens spent on mechanical tasks
+ Better AI output — the AI builds on hard evidence rather than guessing
− More code to maintain (two separate analysis pipelines)

---

## ADR-004: Shared Context Builder

**Context:** The three reasoning modes (Explain, Redesign, Build This) each need access to the same evidence: screenshots near the opportunity timestamp, DOM snapshots, event timeline, narration quotes, design system tokens, current URL, and selector. Early prototypes assembled this evidence independently for each mode, duplicating code and risking drift.

**Decision:** Create a `Shared Context Builder` that assembles evidence once. All three modes consume the same `ReasoningContext` object:

```
Opportunity
     │
     ▼
Shared Context Builder (buildContext(session, opportunity, tokenMap))
     │
     ├── Explain     ← receives ReasoningContext
     ├── Redesign    ← receives ReasoningContext
     └── Build This  ← receives ReasoningContext
```

**Consequences:**
+ No duplicate evidence assembly between modes
+ Consistent output — all modes use the same screenshot indices, timestamps, and DOM references
+ Easy to add new modes — just implement a function that takes `ReasoningContext`
− Slightly more upfront work when adding a new evidence source (must update the builder)

---

## ADR-005: Build This Implementation Packages

**Context:** `loupe build-this` needs to produce output that is directly usable by AI coding agents (Claude Code, Cursor, Codex). A single markdown prompt file is insufficient — agents need separate files for different purposes (brief, acceptance criteria, context, design tokens).

**Decision:** Generate a full directory tree:

```
implementation/
  summary.md              ← Overview + quick start command
  build-prompt.md         ← Full implementation brief (11 sections)
  acceptance-criteria.md  ← Testable checklist
  findings.json           ← Machine-readable opportunities
  context.json            ← Session context (URLs, notes, events)
  screenshots/            ← Extracted JPEGs
  design-system.json      ← Project tokens (if available)
```

Each file serves a specific purpose for the AI agent. The `build-prompt.md` is the primary instruction file; the others provide supporting context.

**Consequences:**
+ Agents receive everything they need in one directory
+ Files can be referenced by path from the brief
+ Human-readable alongside machine-readable
− More files to generate (but generation is deterministic and fast)

---

## ADR-006: Destination Router

**Context:** `loupe build-this` generates implementation packages. Initially, these were always written to a local folder (`~/Loupe/implementation-packages/`). Users wanted packages delivered directly to their coding agent's workspace — Claude Code's `.ai/tasks/`, Cursor's `.cursor/tasks/`, etc.

**Decision:** Create a Destination Router that resolves a destination configuration and delegates to a provider:

```
Build This → Package Generated → Destination Router
                                   ↓
                              Provider (writes + formats)
                                   ↓
                              Post-action (open, copy, run)
```

7 providers implemented:
- `local` — writes to configured local folder
- `claude-code` — writes to `<workspace>/.ai/tasks/<slug>/` + CLAUDE.md wrapper
- `cursor` — writes to `<workspace>/.cursor/tasks/<slug>/` + cursor-prompt.md
- `codex` — writes to `<workspace>/.codex/tasks/<slug>/` + codex-task.md
- `gemini` — writes to `<workspace>/.gemini/tasks/<slug>/` + gemini-task.md
- `clipboard` — copies build-prompt.md to clipboard
- `custom-command` — runs user-defined command with template variables

Destination config stored in `~/.loupe/config/destinations.json`. Resolution order: explicit `--destination` flag → project mapping → global default → local fallback.

**Consequences:**
+ Users configure once per project
+ Packages arrive directly in the agent's workspace
+ Provider architecture makes adding new destinations trivial
− Config file must be managed (auto-created with defaults)

---

## ADR-007: Local-First Artifact Storage

**Context:** Session files, analysis results, and implementation packages all need to be stored somewhere. Early design considered cloud storage as the primary. Users pushed back — they want to own their data and work offline.

**Decision:** All artifacts are local-first:

```
~/.loupe/
  .env                        ← API keys (never synced)
  config/
    design-system.json        ← Design tokens
    destinations.json         ← Agent workspace configs
  projects/
    <name>/
      sessions/               ← .loupe files
      reports/                ← HTML reports
      config/                 ← Per-project token overrides
```

Cloud storage (SaaS mode) is additive — swap two env vars (`LOUPE_API_URL` + `LOUPE_API_KEY`) and all calls route through the gateway. But local mode is the default and always works.

**Consequences:**
+ Works offline
+ No data leaves the machine unless explicitly configured
+ Simple to back up (`cp -r ~/.loupe`)
− No built-in sharing or sync (future feature)

---

## ADR-008: Session-Relative Timestamps

**Context:** During recording, the content script uses `performance.now()` which returns milliseconds since page load, not recording start. Screenshots in the background script used `Date.now() - startTime`. These two clocks drifted — a 38-second session could have events at 190,000,000ms and screenshots at 38,000ms. This broke evidence matching (screenshots ±5s from an event timestamp was nonsensical).

**Decision:** All timestamps use the same clock: milliseconds since recording start. The content script stores `performance.now()` when recording begins, then subtracts it from every event timestamp. The background script uses the same `Date.now()` - `startTime` approach. Both produce the same range (0...38,000ms for a 38s session).

```typescript
// content.ts
const recordingStart = performance.now();
function sessionTs() { return Math.round(performance.now() - recordingStart); }

// background.ts
function sessionNowMsFrom(startMs: number) { return Math.round(Date.now() - startMs); }
```

**Consequences:**
+ All timestamps in the same range, every time
+ ±5s evidence windows work correctly
+ Screenshots, events, and notes can be cross-referenced by timestamp
− Requires coordination between content script and background (both must know when recording started)

---

## ADR-009: LLM Router Instead of Single Model

**Context:** Early versions hardcoded `callClaude()` or `callOpenAI()` depending on which API key was set. Different tasks have different model requirements — transcription needs Whisper, redesign benefits from premium reasoning, judging can use a fast model. "One best model" doesn't exist.

**Decision:** Create a task-based LLM router that selects provider and model based on task requirements:

```typescript
function route(request: TaskRequest): RoutingDecision {
  // SaaS mode → Loupe API gateway
  // Primary provider → check API key
  // Fallback → try next provider
  // Upgrade → higher tier if severity≥High or confidence<0.7
}
```

Routing table:

| Task | Primary | Fallback | Upgrade trigger |
|---|---|---|---|
| transcribe | OpenAI Whisper | — | long audio |
| explain | Claude Sonnet | GPT-4.1-mini | severity≥High or confidence<0.7 |
| redesign | Claude Sonnet | GPT-4o | severity≥High |
| build | Claude Sonnet | GPT-4o | large context |
| judge | GPT-4.1-mini | Gemini Flash | severity≥Critical |

**Consequences:**
+ Each task uses the most cost-effective model
+ New models can be added per task without changing product logic
+ SaaS mode (gateway) works by swapping one provider entry
− More complex than a single `fetch()` call
- Provider files must be maintained

**Superseded by ADR-010.** The client no longer selects providers, holds keys, or
calls model APIs directly. Per-task model *preferences* survive as hints, but the
routing/provider machinery moved behind the Loupe gateway.

---

## ADR-010: SaaS Gateway — the Client Never Holds Provider Keys

**Context:** Loupe is a SaaS product, not a bring-your-own-key developer tool. The
prior design (ADR-009) required end users to export `OPENAI_API_KEY` /
`ANTHROPIC_API_KEY` in their shell for `loupe analyze` and `loupe transcribe` to
work, and the CLI printed "Set OPENAI_API_KEY…" on failure. That leaks provider
identity, pushes credential management onto users, and is wrong for a managed
product. Loupe should own model credentials behind its own gateway.

**Decision:** The agent/CLI and extension are gateway clients only.

- A single `loupe-gateway` provider (`llm/providers/loupe-gateway.ts`) is the sole
  AI path; the router always returns it. Per-task model *preferences* remain as
  hints in the request, but the gateway picks the actual model.
- The direct provider adapters (`openai/anthropic/google/local.ts`) and
  `getApiKey()` were deleted from the client — provider credentials exist only
  inside the gateway process.
- Client config (`llm/client-config.ts`) resolves from `~/.loupe/config/client.json`
  (`{ apiUrl, authToken, mode }`), with env fallback **only** for `LOUPE_API_URL`
  and `LOUPE_DEV_TOKEN`. No user-facing provider keys, ever.
- Gateway requests carry: task type, prompt version, model preference, prompt +
  system prompt, and project/flow/screenshot/target-design metadata.
- Local dev points `LOUPE_API_URL` at a local gateway (e.g. `http://localhost:8787`)
  which loads provider keys internally.
- Unreachable gateway → `"Loupe AI gateway is unavailable. Check Loupe backend
  configuration."` — never mentions a model provider. `analyze` degrades to
  deterministic-only findings.
- The extension is recording-only and makes no AI calls; any future extension AI
  must use the same gateway, never a provider directly.

**Consequences:**
+ Users never configure or even see model-provider keys
+ Provider mix, pricing, and rate limits are controlled centrally in the gateway
+ One swap point for model strategy; the client is stable
+ Provider-agnostic errors and telemetry
− Requires a running gateway (cloud, or local for dev) — the client can't call a
  model on its own anymore
− Real provider integration now lives in a separate gateway service, out of this repo

---

## ADR-011: Design Drift Requires a Per-Project Design System (No Global Fallback)

**Status:** Accepted

**Context:**
`loadDesignSystem()` resolved the per-project `design-system.json` first, then fell
back to the global `~/.loupe/config/design-system.json`. In practice the only global
file that exists holds **Loupe's own brand tokens**, so any project without its own
config had its CSS graded against Loupe's palette — producing drift findings that
were wrong but presented with full confidence. The fallback was also silent: a
reader couldn't tell whether drift found nothing or was never run.

**Decision:**
- **Drift runs only when a per-project design system exists** at
  `~/.loupe/projects/<project>/config/design-system.json`. There is **no global
  fallback** for drift (`projectDesignSystemPath()` is the only baseline). The
  global file remains usable for implementation-package generation, not drift.
- **The skip is never silent.** When skipped, the CLI prints
  `Drift checks skipped — no design system configured for project '<project>'. Run
  'loupe design-system init <project>' to enable.`, and the report renders an
  explicit "Design-system drift was not evaluated" note instead of omitting the
  section. `runDriftChecks` returns `{ findings, skipped }` to carry this state.
- **`loupe design-system init <project>`** writes a hand-authored template
  (`color/font/radius/space/shadow`) into the project's config dir for the user to
  fill in; it refuses to overwrite an existing file.
- **Non-goal: no `extract`.** Loupe will not derive/infer expected tokens from the
  recorded session or page CSS — that compares the page against itself and yields
  meaningless drift. The token list must come from the user.
- The three deterministic checks (console errors, slow requests, touch targets) are
  unaffected — they depend on none of this.

**Consequences:**
+ A reader never sees drift computed against the wrong tokens, and never wonders
  why drift is missing
+ Drift is opt-in per project and explicitly calibrated by the user
+ One honest signal path; `{ findings, skipped }` makes the state testable
− Drift produces nothing until the user authors a real design system (intended)
− The global `design-system.json` is now only consumed by package generation

---

## ADR-012: Product Understanding as a Two-Frame Session Model

**Status:** Accepted (2026-07-03)

**Context:**
The pipeline's best product-level reasoning (UX synthesis) ran in `build-this`, one
command *after* `analyze` had already frozen every per-finding target. So targets were
written by models that saw only their own finding — never "this is a document assistant;
plans are inputs, documents are the output, the hierarchy is inverted." A follow-up review
also found the persona reviewers generate findings with *no* product model at all, and that
an early attempt derived the frame from **all** findings (letting detected/unconfirmed items
pollute the product picture). See `specs/session-understanding.md`.

**Decision:**
A compact, structured `SessionUnderstanding` (`ai/session-understanding.ts`) — productType,
primaryUser, primaryJob, keyObjects, optional invertedOrMissing, topPriorities, confidence —
derived from the transcript/URL/finding-titles. Deliberately small and product-framed: **no
selectors, CSS, or file paths.** It exists in **two roles**:
- **preliminaryUnderstanding** — derived from the transcript+URL (empty findings) **before**
  persona review and injected into the shared `buildSessionContext`, so every reviewer
  identifies issues with the product's purpose in mind. Debug `01b_preliminary_understanding.json`.
- **sessionUnderstanding** — derived after the narration judge from the **narrated
  (judge-confirmed) findings only**, used for target generation and seeded into product
  reasoning, and **persisted** on `OpportunitiesArtifactV2.sessionUnderstanding`. Debug
  `04b_session_understanding.json`.
- **Confidence gate 0.5:** `productContextBlock()` returns empty below the gate, so a
  low-confidence frame never steers prescriptive output. Null-safe at every consumer.
- Persisted frame is **shape-validated** in `parseOpportunitiesArtifact`; a malformed one is
  dropped (never fails the whole analyzed artifact).

**Consequences:**
+ Targets and findings are written with the product model already in view — the largest
  remaining gap vs. frontier tools
+ Two cheap `explain` calls, both pollution-free (preliminary = transcript-only; final = narrated-only)
+ The frame is auditable (two debug artifacts) and advisory (gated, never overrides measured state)
− Lifts the earlier "no SessionUnderstanding" constraint (done narrowly, schema frozen by spec)
− Adds one pipeline stage before review; reviewers now depend on a pre-review derivation

---

## ADR-013: Keyframe Selection + Vision Routing by Payload

**Status:** Accepted (2026-07-03)

**Context:**
Vision reviewers and target generation both picked screenshots by earliest/latest narration
timestamp (max two frames) — often not the frames where a problem is actually visible.
Separately, `requiresVision` was a **dead field**: set only for `redesign` and never read by
the router, so image-backed `explain`/`build` calls (narration-anchored targets) still hinted
a text-only `standard` model.

**Decision:**
- **Shared keyframe selector** (`ai/keyframes.ts`): `selectKeyframes(session, priorityTs[],
  max)` picks ≤N distinct, well-spread frames from caller "moments" (narration/issue
  timestamps), route changes, and click bursts (the settled frame), deduped by index and by a
  temporal-diversity gap; falls back to timeline-spread when a session is sparse.
  `keyframesForFindings()` wraps it for target batches. Reviewers use it via `selectReviewImages`
  with the narration range as priority moments. **Budget: 3 frames** (chosen over 5 for cost).
- **Vision routing wired to the payload:** `requiresVision` is now true whenever `images` are
  present; the router treats it as an upgrade signal **and** hints the premium (vision-capable)
  model. The gateway still owns the concrete model choice (ADR-010) — the client just stops
  sending an incoherent `standard`+images hint.

**Consequences:**
+ Both reviewers and target generation see the frames that actually show the problem
+ Image-backed calls deterministically route to a vision model; the dead field is now live
+ One keyframe implementation, unit-tested, shared by both stages
− 3 frames per vision call instead of 2 (a modest, bounded cost increase)

---

## ADR-014: Prompt Critic v2 — Surgical Section Rewrites

**Status:** Accepted (2026-07-03)

**Context:**
The v1 critic returned a full rewritten brief as one markdown-in-JSON blob. It scored briefs
correctly but, when rewriting, dropped whole sections (Design System, Constraints, Also
Detected), stripped per-finding measurements/acceptance, and once hallucinated a finding
("Accessibility gaps") that did not exist. A structural guard caught the worst cases but the
contract itself was fragile.

**Decision:**
The critic (`prompt-critic-v2`) returns `{overallScore, scores, rationale, issues,
sectionRewrites[]}` — **targeted rewrites keyed by `## ` heading**, applied surgically to the
original brief. Sections containing `### B<n>.` BUILD findings are **protected**: the critic
may never rewrite them, so the reviewer's quotes, measured CSS, and acceptance criteria are
preserved **by construction**, not by a post-hoc guard. Unknown/protected headings are refused
(`[critic-guard]`). Below the pass threshold (9), only weak prose sections change; at/above,
the brief ships unchanged. Output is much smaller (only changed prose, not the whole brief).

**Consequences:**
+ The critic cannot drop sections, drop/add findings, or touch evidence — structurally impossible
+ Lower output-token cost; a failed parse degrades to "keep original"
+ Live NNA run: scored 8.0, rewrote exactly one prose section, everything else byte-preserved
− The critic can no longer restructure a genuinely mis-shaped brief (acceptable — that's rare and risky)

---

## ADR-015: Narrated Deterministic Findings May Enter BUILD

**Status:** Accepted (2026-07-03)

**Context:**
Deterministic-family findings (touch targets, slow requests, console errors) were hard-excluded
from BUILD regardless of what the reviewer said. But a user naturally saying "this button is
tiny" should yield a buildable touch-target fix, not a review-only backlog item.

**Decision:**
- `NARRATABLE_DETECTED = {touch-targets, network}` — findings a human can plausibly voice — may
  enter BUILD, but **only** when the LLM judge explicitly confirms narration (`narrated === true`).
  Keyword/topic overlap is deliberately **not** enough (protects offline/pre-judge artifacts).
- `console-errors` is never promotable (a user never narrates a console error).
- `isJudgeableFinding()` sends narratable-deterministic findings to the judge; `isDeterministicFinding()`
  is retained for the family test.

**Consequences:**
+ A voiced "this tap target is too small" becomes an actionable BUILD fix
+ The judge, not keywords, is the sole promotion gate — conservative by default
+ NNA run confirms it: touch-targets was [Critical] but unnarrated, so it stayed in "Also Detected"
− A finding can now be deterministic-family *and* narrated; the classifier must reason about both

---

## ADR-016: Unified Product-Reasoning Call

**Status:** Accepted (2026-07-03)

**Context:**
The brief's "Goal & Context" paragraph and its "UX/Product Synthesis" section were two separate
LLM calls (`goal-context-generator` + `ux-synthesis`) that re-derived the same product
understanding from the same inputs — duplicated work and a more layered prompt stack.

**Decision:**
One call (`ai/product-reasoning.ts`, `generateProductReasoning`) produces both, seeded by the
persisted `SessionUnderstanding`, emitting **two delimited markdown blocks**
(`===GOAL_CONTEXT===` / `===SYNTHESIS===`) rather than markdown-escaped-inside-JSON (the
prompt-critic-v2 lesson). `--no-synthesis` omits the synthesis block. On failure the brief falls
back to its deterministic Goal & Context line and omits synthesis. The two old modules were
deleted (wire-or-delete). Also: `callLLM` gained a `responseFormat` override so markdown-prose
producers request `text` instead of being forced into JSON; the critic is skipped entirely when a
brief has no BUILD findings.

**Consequences:**
+ One call instead of two; a single, consistent product frame across both sections
+ Delimited output is robust — no fragile JSON-escaping of a large markdown synthesis
+ NNA run confirms both blocks generated cleanly in one pass
− Goal & Context and synthesis now share one failure mode (both absent if the call fails)

---

## ADR-017: Layout Findings Are Explore-First, Not Prescriptive CSS

**Status:** Accepted (2026-07-03)

**Context:**
Target generation classified every measurable finding as `visual` and prescribed concrete CSS.
That is right for local styling, but wrong for layout/hierarchy/visibility problems: a document
panel that cut off content got the target `#doc-panel { width: auto; overflow-x: auto; }` —
source-blind, symptom-only, and directly contradicting the UX synthesis above it (which said
documents are the primary output and fixing the hide-plans finding should reclaim their space).
Layout fixes depend on the codebase's layout architecture (which flex/grid parent, which sibling
consumes the space) that Loupe cannot see from the rendered box.

**Decision:**
Split the generated `visual` nature into two kinds:
- **layout** — space allocation, hierarchy, visibility/fit, navigation, workflow, interaction.
  Anchored deterministically by `LAYOUT_RE`/`layoutHint` (mirroring `FUNCTIONAL_RE`). Handled
  **explore-first**: state the desired UX OUTCOME in the product's terms, cite measured evidence,
  name the component and tell the agent to investigate *why* the area is constrained, name any
  sibling finding that would restructure it and say to do that first and re-check, propose 2–3
  ranked approaches, and treat **overflow/scrolling as a last-resort fallback — never the primary
  recommendation.** Never prescribe width/overflow/flex/position/grid values.
- **visual** — LOCAL styling only (color, contrast, border, radius, shadow, font, one element's
  spacing). Still prescriptive with design tokens by name.
- Acceptance for layout states the UX outcome (what is now primary / fully visible / uncrowded),
  not a CSS property. `fixKind` gained `'layout'`; downstream rendering uses the target string, so
  nothing else changed.

**Consequences:**
+ The whole BUILD section now shares one philosophy — describe the outcome, let the fix emerge from
  the codebase — instead of mixing explore-first and guessed CSS
+ Targets stop contradicting the UX synthesis; cross-finding dependencies (hide plans → documents
  expand) are surfaced in the target text
+ Live NNA re-run: the document-visibility finding flipped from "add overflow-x: auto" to an
  explore-first target that explicitly rules out horizontal scrolling and prefers responsive layout
− A deterministic keyword anchor can mis-flag; kept narrow, and the model still decides within the
  explore-first frame. Local styling stays prescriptive so contrast/token fixes remain concrete

---

## ADR-018: BUILD Findings Are Structured by Relationship, Not Listed Flat

**Status:** Accepted (2026-07-03)

**Context:**
The persona reviewers surface findings independently, so the merged BUILD set is a flat list of
peers. But narrated findings are often not peers: "documents should be prioritized" is the *reason*
to "hide the plans" (one change with a purpose, not two builds), and "the proposal is clipped" may
simply disappear once plans are hidden and the document panel can expand. Listing all three as
parallel tasks makes the agent build three things — and B-items contradicted the UX synthesis
directly above them, which already reasoned that resolving one resolves another.

**Decision:**
A build-time pass (`ai/finding-relationships.ts`, `analyzeFindingRelationships`) classifies each
narrated BUILD finding's role, and `orderBuildItems` reshapes the list before rendering:
- **primary** — a standalone action to build.
- **principle** — the design principle / stated goal *behind* a primary. Folded into that primary's
  framing under "**Why this is the priority**", with the reviewer's own words for it preserved. It
  leaves the peer list and the findings count, but is never dropped.
- **consequence** — a symptom another finding likely resolves. Rendered as a **conditional
  follow-up** after its primary: "after B1, verify whether this still occurs; fix only if it
  remains", with acceptance criteria gated on "only if the issue remained".
- Labels (B1, B2…) are assigned by final render position; the How-to-Work scope line and BUILD
  heading report "N primary + M conditional".
- **Safety:** parser is conservative (default primary; relatesTo must point at a primary — no
  chains/cycles; mutual references broken deterministically). Nothing is ever silently dropped —
  principles ride along as rationale, consequences stay as conditional items in Definition of Done.
  Null-safe: on any failure or a fully-independent set, the brief renders flat, exactly as before.

**Consequences:**
+ The BUILD section stops contradicting the synthesis — it expresses one coherent change with a
  purpose and a verify-first tail, instead of parallel patches
+ The agent builds the primary, then checks whether the follow-up is even needed — fewer speculative
  edits, correct sequencing
+ Live NNA run: three flat findings became one primary (hide plans, with "prioritize documents"
  folded in as the why) plus one conditional (verify the clipping after B1) — exactly the target shape
− One more build-time premium call; a mis-classification could fold a finding that deserved peer
  status (mitigated by conservative defaults, folded content staying visible, and null-safe fallback)

## ADR-019: Session Memory Is a Derived, Local, File-Based Index Over runs/

**Status:** Accepted (2026-07-04) — spike: docs/SESSION_MEMORY_SPIKE.md

**Context:**
Every session was analyzed as if it were the project's first. Run artifacts already contain
findings, narration verdicts, and product understanding, but nothing linked them across runs —
no recurrence awareness, no accept/reject learning, no durable preferences.

**Decision:**
Project memory lives in `~/.loupe/projects/<p>/memory/` as JSON manifests + append-only JSONL
event logs (`agent/src/memory/`), and is ALWAYS reconstructible from `runs/` ground truth
(`loupe memory index`) — reconstructibility doubles as the delete guarantee. Recurrence is
deterministic (`findingSignature`: category + origin/path + selector-or-stemmed-title), not ML.
Prompts never read memory files directly: a deterministically generated, redacted, ~1200-token
`memory-digest.md` is the single choke point (`memoryPromptBlock`), injected in v1 into exactly
two surfaces — Build This (product-reasoning + fast-path brief) and Redesign. The narration judge
stays memory-free by design (guards against hallucinated continuity). Preferences carry
confidence levels — hint / pattern / rule — where only explicit `--rule` or 3+ repeated signals
reach rule strength, and anything unreinforced for 5 runs decays one level at digest time.
Evals stay linked by runId, never merged. Human feedback enters via `loupe memory mark
<run>:<finding> accepted|rejected|verified [--why]`; the Verify Loop (ROADMAP P1) is the intended
future source of these events. No SQLite, no embeddings, no cloud until a measured limit is hit.

**Consequences:**
+ Second-session-onward briefs know recurring issues, standing preferences, and rejected paths
+ Live NNA rebuild: 47 runs indexed; digest surfaced "touch targets below minimum — 32 runs,
  never narrated" unprompted — exactly the recurrence signal the spike wanted
+ Auditable: JSONL is greppable; `loupe memory digest <p>` shows the exact prompt payload
− Memory changes the digest between runs, so memory-injected stages miss the response cache
  across runs (correct behavior: context changed)
− Manual `mark` is the only human signal until the Verify Loop lands
