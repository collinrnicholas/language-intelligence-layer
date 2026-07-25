# Session Memory Spike

Status: **approved · Phase 1+2 implemented (2026-07-04)** — see ADR-019 and
`agent/src/memory/`. Approval tweaks incorporated: accept/reject will
eventually flow from the Verify Loop (manual `mark` for now); evals stay
linked by runId, never merged; confidence levels are hint/pattern/rule with
promotion at 3+ signals; stale memories decay one level after 5 unreinforced
runs; `loupe memory digest <project>` prints the exact prompt payload.
V1 injection is deliberately limited to Build This + Redesign.

## Executive Summary

Loupe treats every session as the first session. The pipeline already produces
almost everything a memory system needs — canonical run artifacts
(`opportunities.json` v2 with `sessionUnderstanding`), per-finding lifecycle
fields (`narrated`, `fixKind`, `generatedTarget`), implementation packages,
eval scorecards — but nothing links them across runs, so nothing improves
between session N and session N+1.

Recommendation: a **local-first, file-based memory layer** under each project
(`~/.loupe/projects/<project>/memory/`) consisting of small JSON manifests and
append-only JSONL logs, distilled at write time into a compact
`memory-digest.md` that prompt stages inject the same way they already inject
`productContextBlock()`. No database, no embeddings, no cloud in v1. The whole
v1 is indexes + one lifecycle command (`loupe memory mark`) + one retrieval
block, and it makes analyze/build-this measurably better on the second session
of any project (recurring-issue awareness, rejected-suggestion suppression,
project preferences).

## Current State

What exists today, and what it already gives us for free:

| Artifact | Location | Memory-relevant content |
|---|---|---|
| Run artifacts | `~/.loupe/projects/<p>/runs/<runId>/analysis/opportunities.json` | Full `Opportunity[]` incl. `narrated`, `narrationNote`, `fixKind`, `generatedTarget/Task/Acceptance`; `sessionUnderstanding` (product frame); `runId` is a sortable ISO timestamp |
| Session payloads | `runs/<runId>/analysis/session.loupe` + `screenshots/` | The raw capture (multi-MB; NOT memory material — see Non-Goals) |
| Debug pipeline trace | `runs/<runId>/analysis/debug/00–06*` | Judge verdicts, per-reviewer findings, timings — useful for pattern mining, already persisted |
| Implementation packages | `runs/<runId>/implementation/implementation-*/` + destination copies | The brief actually handed to a coding agent; `context.json` carries goal/target |
| Session understanding | persisted on artifact (`specs/session-understanding.md`) | Product type, key objects, priorities — the seed for `PatternMemory` |
| Design system | `~/.loupe/projects/<p>/config/design-system.json` | Explicit token preferences (already a primitive `PreferenceMemory`) |
| Evals | `evals/results/schema.json` (v1 result shape), `evals/scorecards/`, `benchmarks/*/expected.md` | Human scores exist but live in the **repo**, keyed by fixture — not linked to project runs |
| Extension index | `chrome.storage loupe:sessionIndex` | Capture-side recency only; disjoint from CLI state |

Cross-run linkage today: `latestRunArtifact()` in
`agent/src/commands/build-this.ts` — "pick the newest run" is the entire
extent of Loupe's memory. Nothing records what the user did with a finding,
whether the build worked, or that plan-panel-crowding has now appeared in four
NNA sessions running.

## Goals

1. **Recurrence awareness** — analyze/review should know "this finding matched
   one seen in 3 prior runs" and say so (raises confidence, changes severity
   framing, dedupes noise).
2. **Outcome learning** — accepted / rejected / built / verified status per
   opportunity, so rejected categories stop being re-proposed and built ones
   become "verify it stayed fixed."
3. **Preference capture** — durable project facts the pipeline should honor
   (e.g. "never propose overflow-scroll fixes", "documents are the primary
   workspace", "uses Tailwind, selectors are utility soup").
4. **Score history** — link eval scores and prompt versions to runs, so
   quality regressions are attributable ("targets got worse after
   prompt-v2").
5. All of the above **without new latency**: memory injection must be a
   pre-built digest read from disk, never an LLM call in the hot path.

## Non-Goals

- **Not a second copy of session data.** Memory stores *references* (runId,
  finding id, screenshot index) and *distillations* (one-line issue
  signatures), never raw payloads. `session.loupe` stays the only base64 home
  (that rule already exists in `analyze.ts`).
- **Not remembered:** raw audio, raw DOM/`computedStyles`, screenshot bytes,
  URLs beyond origin+path, anything matching credential/PII patterns,
  ephemeral runtime data (timings, cache entries — those live in
  `~/.loupe/cache/` and `debug/`). Transcript *quotes* attached to accepted
  findings are the one narration artifact worth keeping (they're already in
  `opportunities.json`).
- **No SaaS features in v1.** No sync, no Supabase/Turso, no server-side
  memory. The gateway remains a stateless completion proxy (ADR-010).
- **No embeddings/vector search in v1.** At Loupe scale (dozens of sessions
  per project), lexical + structural matching wins on simplicity and
  debuggability; see Phase 5.

## Recommended V1

Smallest useful version — four files per project plus one CLI verb:

```
~/.loupe/projects/<project>/memory/
  manifest.json        # ProjectMemory: counters, prefs pointer, schema version
  sessions.jsonl       # SessionIndex: one line per analyzed run
  opportunities.jsonl  # OpportunityMemory: one line per finding per run (append-only lifecycle events)
  patterns.json        # PatternMemory + PreferenceMemory (small, curated, capped)
  memory-digest.md     # ≤1200-token distillation regenerated on every write — the ONLY thing prompts read
```

Write points (all additive, no pipeline reshaping):
- `analyzeSession()` end (where `opportunities.json` is written) appends the
  session line + one opportunity line per finding, updates recurrence links,
  regenerates the digest.
- `buildThisCommand()`/`fastBuildThis()` append `built` events for the findings
  included in a package.
- `loupe memory mark <finding-ref> accepted|rejected|verified [--why "…"]` is
  the human feedback verb — v1's only new interactive surface.
- `loupe eval` (when run) appends an `EvaluationResult` line keyed to a runId.

Recurrence detection v1 is deterministic, not ML: a finding's **signature** is
`category + normalized selector/page + stemmed title tokens` (reuse
`titleSimilarity()` logic from `agent/src/ai/review.ts` and the topic keys in
`ai/narration.ts` — both already solve near-dup matching within a run; memory
applies the same matcher across runs).

## Data Model

TypeScript shapes (v1; all files carry `schemaVersion` for migration):

```ts
// manifest.json
interface ProjectMemory {
  schemaVersion: 1;
  project: string;
  createdAt: string;
  sessionCount: number;
  lastRunId: string | null;
  digestUpdatedAt: string | null;
  // Rolling product frame: last high-confidence sessionUnderstanding + how
  // many runs agreed with it (stability signal).
  productFrame: { understanding: SessionUnderstanding; agreeingRuns: number } | null;
}

// sessions.jsonl — one line per analyzed run
interface SessionIndex {
  runId: string;               // ISO — sortable, joins to runs/<runId>/
  intent: 'review' | 'audit' | 'build-fast';
  flow: string;
  origin: string;              // URL origin+path only (privacy: no query/fragment)
  findingCounts: Record<OpportunitySeverity, number>;
  narratedCount: number;
  buildFindingIds: string[];   // what classifyAndMerge put in BUILD
  promptVersions: Record<string, string>; // stage → promptVersion (regression attribution)
}

// opportunities.jsonl — append-only event log; latest event per key wins
interface OpportunityMemory {
  key: string;                 // recurrence signature (see above), stable across runs
  runId: string;
  findingId: string;           // id inside that run's opportunities.json
  event: 'observed' | 'narrated' | 'built' | 'accepted' | 'rejected' | 'verified' | 'regressed';
  category: OpportunityCategory;
  severity: OpportunitySeverity;
  title: string;               // ≤120 chars
  quote?: string;              // reviewer's words, only when narrated
  fixKind?: 'functional' | 'visual' | 'layout' | 'content';
  why?: string;                // human note on accept/reject (from `memory mark`)
  at: string;
}

// evals.jsonl (repo evals/results stay canonical for benchmarks; this links them to runs)
interface EvaluationResult {
  runId: string;
  source: 'rubric' | 'benchmark' | 'manual';
  scores: { explain: number; redesign: number; buildThis: number; overall: number }; // /25 each, mirrors evals/results/schema.json
  total: number;               // /100
  notes?: string;
  at: string;
}

// patterns.json — small and CURATED, hard-capped (e.g. 20 patterns, 15 prefs)
interface PatternMemory {
  key: string;                 // same signature space as OpportunityMemory.key
  statement: string;           // "Plans panel crowds out the document workspace"
  occurrences: number;
  runIds: string[];            // last N, not all
  status: 'open' | 'fixed' | 'wontfix' | 'regressed';
}

interface PreferenceMemory {
  id: string;
  statement: string;           // "Prefer hiding secondary panels over adding overflow scrolling"
  source: 'rejection' | 'acceptance' | 'explicit';   // explicit = user typed it
  strength: 'hint' | 'rule';   // rules go into prompts as constraints; hints as context
  evidence: string[];          // finding keys / run ids that justify it
  at: string;
}
```

Deliberate omissions: no `RedesignMemory`/`ExplainMemory` tables — those
outputs are already persisted per-run; memory only needs their *outcomes*
(the `event` stream). No screenshot memory — `screenshotIndex` on the
referenced finding is enough to re-open evidence.

## Storage Strategy

**Local filesystem, JSON + JSONL. No SQLite in v1.**

- Scale check: a heavy project = ~50 runs × ~20 findings = ~1000 JSONL lines,
  <1 MB. Full scan is microseconds; SQLite adds a native dep and a schema
  migration story for zero query need. Revisit at ~10k lines (Phase 4 gate).
- JSONL append-only fits the lifecycle model (events, not mutations), is
  crash-safe (a torn last line is skippable — same quarantine philosophy as
  ADR-008), diffable, and greppable.
- Same durability model as everything else in `~/.loupe` (the extension's
  storage self-heal we shipped for `loupe:sessionIndex` shows why
  rebuild-ability matters: **memory must always be reconstructible from
  `runs/`** — `loupe memory index` is exactly that rebuild).
- Later: LiteFS/Turso or Supabase only if/when Loupe grows team-shared
  memory; the JSONL log is the natural sync/import unit. Embeddings live in a
  sidecar file (`patterns.vec`) if Phase 5 happens — never in the JSONL.

## Retrieval Strategy

One rule: **prompts read `memory-digest.md`, nothing else.** The digest is
regenerated deterministically (no LLM) on every write, capped at ~1200 tokens,
sectioned so stages can take slices:

```
## Product frame        (from manifest.productFrame — mirrors productContextBlock)
## Open recurring issues  (top patterns by occurrences, with status)
## Preferences            (rules first, then hints)
## Prior rejections       (last 10 rejected keys + why + signal strength — caution, current narration wins)
## Score trend            (last 5 eval totals + prompt versions)
```

Injection points (all are existing prompt-assembly sites; each takes only the
sections it needs, gated the same way `productContextBlock()` gates on
confidence):

| Stage | File / function | Sections | Effect |
|---|---|---|---|
| analyze/review synthesis | `buildSessionContext()` in `ai/review.ts` (feeds personas AND `synthesize-opportunities`) | recurring + rejected | reviewers flag recurrences; stop re-proposing rejected categories |
| narration judge | none | — | deliberately memory-free: the gate must reflect THIS session's narration only (guards against hallucinated continuity) |
| explain / redesign | `opportunities/explain.ts`, `opportunities/redesign.ts` | preferences + product frame | redesigns respect standing preferences |
| build-this (rich + fast) | `generateProductReasoning()`, `synthesizeBuildBrief()` | product frame + preferences + open patterns | briefs say "third occurrence — fix the root cause", honor rules |
| prompt critic | `critiqueImplementationBrief()` | preferences (rules only) | critic checks the brief against project rules |
| verify (future) | — | open patterns with status `fixed` | "did the fix stick" checklist |
| eval | `loupe eval` | score trend | delta reporting per prompt version |

Retrieval cost: one 1–2 KB file read; zero added LLM latency. Prompt-cache
note: the digest changes between runs, so it must be appended AFTER stable
prompt content (same byte-stability discipline as
`docs/PERF_REPORT_2026-07-03.md` — memory must not silently bust the response
cache mid-run; within a run the digest is read once and reused via
`context-pack.ts`-style memoization).

## CLI Surface

```
loupe memory index [project]      # (re)build memory/ from runs/ — also the migration path
loupe memory show [project]       # print digest + counters
loupe memory mark <runId>:<findingId> accepted|rejected|verified [--why "…"]
loupe memory prefer "<statement>" [--rule]   # explicit PreferenceMemory entry
loupe memory search <text>        # grep over opportunities.jsonl + patterns.json
loupe memory summarize [project]  # regenerate memory-digest.md (deterministic)
loupe memory export [--out dir]   # tar the memory/ dir (portable, reviewable)
loupe memory reset [--project p] [--keep-preferences]   # delete with confirmation
```

`mark` is the linchpin — without human accept/reject signal, Phases 2–4 have
nothing to learn from. The extension's Sessions/Exports views could later
surface accept/reject buttons that shell out to the same verb, but v1 is
CLI-only.

## Privacy and Retention

- **Stays local:** everything. `memory/` lives beside `runs/` under
  `~/.loupe/projects/`; nothing new leaves the machine.
- **Sent to the gateway:** only `memory-digest.md` content, embedded inside
  prompts — the same trust boundary as today's transcripts and computed
  styles (ADR-010: gateway holds keys, sees prompt text). The digest contains
  distilled statements and quotes the user already recorded; it must never
  contain raw DOM, tokens matching secret patterns (`sk-…`, `Bearer …`,
  emails), or full URLs — redaction runs at digest-generation time, and the
  digest is the single choke point.
- **Retention controls:** `manifest.json` gets `retentionDays` (default: keep
  forever, it's the user's disk); `loupe memory reset` and per-finding
  `mark … --forget` for deletion. Deleting a run directory then running
  `loupe memory index` drops every derived trace — reconstructibility doubles
  as the delete guarantee.
- **Audio:** never enters memory (it already never leaves `session.loupe`).

## Risks

| Risk | Mitigation |
|---|---|
| Stale memories (pattern says "open", user fixed it outside Loupe) | statuses decay: pattern not observed for N runs → auto-tag `stale`, drop from digest; `verified/regressed` events from re-recordings refresh |
| Overfitting to bad preferences (one grumpy rejection becomes a permanent rule) | preferences from inference are `hint` strength by default; only explicit `--rule` or 3+ consistent events promote to `rule`; digest labels provenance |
| Sensitive UI data in memory | distillation-only writes; regex redaction at the digest choke point; no DOM/styles/URLs-with-params stored |
| Prompt bloat | hard 1200-token digest cap, per-stage sections, rules-before-hints priority eviction |
| Slow retrieval | digest pre-built at write time; hot path is one file read |
| Hallucinated continuity ("as we fixed last week…" when we didn't) | memory never enters the narration judge or evidence blocks; digest statements carry occurrence counts + runIds so downstream text can cite, not invent; BUILD quotes still come only from this session's transcript |
| Memory becoming untrustworthy | `loupe memory index` full rebuild from `runs/` ground truth; JSONL is human-auditable; digest is deterministic so bugs are reproducible |

## Open Questions

1. Where do accept/reject signals come from *naturally*? `memory mark` is
   explicit; the higher-signal source is `verify` (re-record → did the finding
   disappear?) which doesn't exist yet (ROADMAP P1 "Verify Loop"). Phase 3
   should co-design with it.
2. Should `benchmarks/`/`evals/` (repo-side, fixture-keyed) merge into
   project memory, or stay separate with a linking `runId`? Spike assumes
   linking, not merging.
3. Cross-project memory (e.g. "this user always prefers minimal diffs") —
   deliberately out of scope; revisit only with explicit opt-in.
4. Does the extension need read access to memory (e.g. showing "3 open
   recurring issues" on the Capture tab)? Would require exporting the digest
   through a channel the extension can read; defer.

## Implementation Plan

- **Phase 1 — indexes & manifests** (small): `memory/` dir, `manifest.json`,
  `sessions.jsonl`, `loupe memory index|show|reset`, writes wired into
  `analyzeSession()`. Backfill = run `index` over existing `runs/`. No prompt
  changes yet. *Exit: `loupe memory show NNA` summarizes all historical runs.*
- **Phase 2 — opportunity lifecycle**: `opportunities.jsonl`, recurrence
  signatures, `memory mark`, `built` events from build-this, digest v1
  (recurring + rejected sections), inject into `buildSessionContext()` +
  `synthesizeBuildBrief()`. *Exit: a rejected finding category is visibly
  suppressed in the next run's output; a 3rd-occurrence finding is labeled
  recurring.*
- **Phase 3 — scoring history**: `evals.jsonl`, promptVersions on
  SessionIndex, score-trend digest section, `loupe eval` linkage. *Exit:
  score deltas attributable to prompt-version changes.*
- **Phase 4 — pattern retrieval & preferences**: `patterns.json`,
  `PreferenceMemory` promotion rules, `memory prefer`, critic rule-checking,
  decay/staleness. Gate: revisit JSONL-vs-SQLite here with real data volumes.
- **Phase 5 — embeddings/vector search** (only if lexical matching provably
  misses recurrences): sidecar vectors for pattern statements, still local
  (e.g. sqlite-vec or a flat file + cosine scan). Not before a measured need.

## Recommendation

Build Phase 1 + 2 as one spec-gated change (they're only useful together —
indexes without lifecycle teach nothing). Keep it file-based, digest-choked,
and reconstructible from `runs/`; wire injection into exactly two prompt sites
first (`buildSessionContext`, `synthesizeBuildBrief`) and measure on the NNA
golden criteria before touching more stages. Defer SQLite, embeddings, and
anything cloud until a measured limit is hit, not before. Write an ADR
("Session memory is a derived, local, file-based index over runs/") when this
spike is approved.
