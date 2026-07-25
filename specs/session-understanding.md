# Product Spec: Session Understanding (reasoning-order fix)

**Status:** Accepted & implemented (2026-07-03) — Option B, schema as specified, gate 0.5.
Module `ai/session-understanding.ts`; derived in `analyze` before `generateTargets`
(debug `04b_session_understanding.json`), persisted on `OpportunitiesArtifactV2.sessionUnderstanding`
(shape-validated in `parseOpportunitiesArtifact`; malformed → dropped, not fatal), consumed by
target generation and seeded into `build-this` UX synthesis.

**Update (2026-07-03) — two frames.** Post-review code review found reviewers were still
generating findings with no product model. Added a second, earlier role:
- **preliminaryUnderstanding** — derived from the transcript+URL BEFORE persona review
  (empty findings, so no finding pollution; debug `01b_preliminary_understanding.json`),
  injected into the shared `buildSessionContext` so all reviewers see the product frame up
  front (gated by confidence). 
- **sessionUnderstanding** — unchanged role, but now derived from the NARRATED
  (judge-confirmed) findings only, not all findings, for target gen + synthesis + persistence.
**Owner:** Collin
**Depends on:** Narration judge, Target generator, UX Synthesis, Implementation Brief engine
**Supersedes constraint:** the earlier working rule "do not build ProductContext / SessionUnderstanding"

## Why this exists (and why we're revisiting a rule we set)

Earlier this sprint we explicitly ruled out a `SessionUnderstanding` / `ProductContext`
object to keep changes scoped. That rule was right for the four prompt-quality tweaks
it guarded. This spec asks to lift it **narrowly**, because the single largest remaining
quality gap versus frontier models is a *reasoning-order* problem that no per-finding
tweak can close.

**The gap, concretely.** The best product-level reasoning we produce lives in
`generateUXSynthesis` (`ai/ux-synthesis.ts`). Its own header comment states the problem:
it "runs at build-this time (after analyze), so it has access to all narrated findings
with their generated targets." But **targets are generated upstream in `analyze`**
(`generateTargets`, stage 2.6) — *before* any product-level understanding exists. So each
target is written by a model that has only its own finding's slice, never the sentence
"this is an AI Document Assistant; plans are inputs, documents are the output, and the
layout hierarchy is inverted." Frontier tools win here because they see the whole session
in one pass *before* committing to individual fixes.

Today's order:

```
analyze:    … → narration judge → generateTargets (per-finding, no product context) → artifact
build-this: … → generateUXSynthesis (product-level, sees everything) → brief → critic
```

The product understanding is computed one whole command too late to shape the targets.

## Goal

Let product-level understanding exist **before** target generation shapes it, without
rebuilding the pipeline, adding an issue graph, or touching capture. Minimal, persisted,
and consumed in exactly two places.

## Two options considered

### Option A — Reorder: run synthesis before target generation
Move `generateUXSynthesis` (or a trimmed variant) into `analyze`, ahead of
`generateTargets`, and pass its prose into the target prompt.

- \+ No new artifact/schema.
- − Synthesis currently *depends on* generated targets (it reads `m.narration` + targets as
  its richest signal). Reordering means synthesis runs on weaker input, degrading the
  very section it produces.
- − Couples two commands' timing; `build-this` still wants a synthesis section, so we'd
  either run it twice or thread state across commands.

### Option B — Persist a small structured `SessionUnderstanding` (recommended)
Add one cheap LLM call in `analyze`, immediately after the narration judge and **before**
`generateTargets`, that produces a *small* structured object. Persist it on the artifact.
Feed it into (1) target generation now, and (2) UX synthesis in `build-this` later (as a
seed, so synthesis gets sharper too).

- \+ Product understanding is available exactly when targets are written.
- \+ Persisted once, reused by both consumers; no cross-command timing coupling.
- \+ Structured + small → auditable in a debug artifact, cheap to send, hard to derail the
  brief (unlike free-form prose).
- − One new (small) type and one new LLM call in `analyze`.

**Recommendation: Option B.** It fixes the reasoning order at its true source (target
generation) and makes synthesis better rather than worse.

## Data contract (deliberately small)

```ts
export interface SessionUnderstanding {
  productType: string;        // "AI document assistant for construction bids"
  primaryUser: string;        // "a contractor preparing a proposal"
  primaryJob: string;         // the main job-to-be-done in one sentence
  keyObjects: string[];       // domain nouns: ["plans (inputs)", "documents (outputs)"]
  invertedOrMissing?: string; // optional: the one structural observation, if any
  topPriorities: string[];    // user-voiced priorities, verbatim-ish, ranked
  confidence: number;         // 0..1 — low confidence => consumers treat as a hint only
}
```

Rules:
- No selectors, CSS, file paths, or finding titles — this is product framing, not fixes.
- Derived only from the transcript + URL + finding titles already present. No new capture.
- `confidence < 0.5` → consumers may show it but must not let it override measured state.

## Pipeline placement

```
analyze:  … → narration judge
              → deriveSessionUnderstanding()   ← NEW, one cheap 'explain' call
              → generateTargets(… , understanding)   ← consumes it
              → artifact (persists understanding)
build-this: generateUXSynthesis(… , understanding)   ← seeds it (sharper synthesis)
```

- Produced with the cheap tier (`explain`) — it's summarization, not deep reasoning.
- Persisted on the analyze artifact (new optional field) and echoed to a debug artifact
  (proposed `04b_session_understanding.json`), so it's auditable next to the judge verdicts.
- Fully optional at every consumer: null/failed → today's behavior exactly (graceful
  degradation, consistent with ADR-010's gateway-unreachable path).

## Consumption

1. **Target generator** — inject a short `PRODUCT CONTEXT` block into the non-content and
   content batch prompts: productType, primaryJob, keyObjects, and the relevant
   topPriorities. This is what lets a target say "documents are the output; restore their
   visual primacy" instead of a generic visual fix.
2. **UX synthesis** — pass the same object as a seed so synthesis elaborates a shared,
   consistent product frame instead of re-deriving one from scratch.

## Non-goals (unchanged from the sprint constraints)

- No issue graph, no cross-finding dependency engine beyond the existing target hint.
- No redesign of the 5-reviewer architecture.
- No capture-side changes.
- Not a general "ProductContext" service — this is a per-session, per-run summary only.

## Risks & mitigations

- **Hallucinated product framing steering fixes.** Mitigate with the confidence gate and by
  forbidding selectors/CSS in the object; measured state always wins in targets.
- **Scope creep into the thing we said no to.** Mitigate by freezing the schema above — new
  fields require a new spec revision.
- **Extra cost/latency in analyze.** One cheap `explain` call on text we already hold;
  negligible next to review + judge + target calls.

## Test plan

- Unit: `deriveSessionUnderstanding` parses/validates the JSON; malformed → null.
- Unit: target prompt includes the PRODUCT CONTEXT block iff understanding is present and
  `confidence >= 0.5`.
- Golden: NNA session — understanding names the product as a document assistant and ranks
  "hide plans" / "documents front and center" as top priorities; targets reference the
  document-primacy frame.
- Regression: with understanding = null, targets and synthesis are byte-identical to today.

## Open questions for approval

1. Option B as recommended, or do you want A (pure reorder, no new artifact)?
2. Is the schema above the right minimal set, or do you want it even smaller
   (e.g. drop `invertedOrMissing` / `keyObjects`)?
3. Confidence gate threshold for letting it into target prompts — 0.5 proposed.
