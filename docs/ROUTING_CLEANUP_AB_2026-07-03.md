# Model Routing Cleanup + gpt-4o vs gpt-4.1 A/B — July 3, 2026

Follow-up to `MODEL_ROUTING_REPORT_2026-07-03.md`. All changes shipped, typecheck
clean across workspaces, 67/67 tests pass (7 new router tests).

## Changes shipped

1. **SessionUnderstanding → premium.** `deriveSessionUnderstanding` now calls with
   exported `UNDERSTANDING_LLM_OPTIONS` (`severity: 'High'`, prompt version bumped
   to `session-understanding-v2-premium` so stale standard-tier cache entries
   can't serve). `test/router.test.mjs` proves the options produce a premium
   routing decision.
2. **Router dead logic resolved: WIRED, not deleted.** The severity/confidence/
   context-size upgrade now folds into `decision.model` — the only signal that
   reaches the gateway. Verdict on usefulness: yes — it is the declarative
   quality lever used by session understanding and by `opportunity-explain`
   (per-finding severity/confidence, the original intent). Tests pin every
   upgrade path (High/Critical severity, confidence < 0.7, large context, vision).
3. **Cache invalidation on gateway model swaps.** `/health` now advertises the
   concrete tier→model mapping; the client fetches it once per process and folds
   it into every cache key. Without this, changing `LOUPE_MODEL_PREMIUM` would
   silently serve the old model's cached responses.
4. **Gateway error bodies surfaced.** Client errors now include the gateway's
   upstream error detail (e.g. "OpenAI error 429: …") instead of a bare status —
   this is how the recurring fast-502 failures become diagnosable.
5. **No Anthropic support added** (per instruction). The executor-alignment A/B
   (Sonnet 4.6 on critic/synthesis) remains a documented future experiment in
   `MODEL_ROUTING_REPORT_2026-07-03.md` §5–6. The Anthropic key in
   `~/.loupe/gateway.env` is unused by the gateway code.

## Before/after route table

| Stage | Before (model sent) | After (model sent) | Change |
|---|---|---|---|
| transcript-stitch | standard | standard | — |
| **session-understanding ×2** | **standard** | **premium** | upgraded (quality-critical) |
| persona-review vision ×3 | premium | premium | — |
| persona-review text ×2 | standard | standard | — |
| narration-judge | premium | premium | — |
| content-enumeration | premium (vision) | premium (vision) | — |
| target-generation ×2 | premium | premium | — |
| product-reasoning+synthesis | premium | premium | — |
| finding-relationships | premium | premium | — |
| prompt-critic | premium | premium | now also upgraded by contextSize=large wiring (was premium via task anyway) |
| opportunity-explain | standard always | premium when finding is High/Critical or confidence < 0.7 | severity wiring now live |

SessionUnderstanding upgrade cost: +~$0.007/run (two ~700-token calls at
premium rates), latency ~neutral (measured 1.4–2.6s at both tiers). The
premium calls returned richer output (out≈204–221 tokens vs 118–133 on mini).

## A/B: gpt-4o (A) vs gpt-4.1 (B) as premium — NNA session

One cold run each (cache disabled), same session, same code. Both configs
include the SessionUnderstanding upgrade, so the premium model is the only
variable.

| Metric | A: gpt-4o | B: gpt-4.1 |
|---|---|---|
| analyze wall time | 26.7s | **53.7s (2× slower)** |
| analyze model time | 62.2s | 94.4s |
| build-this wall | 6.7s | 7.8s |
| est. cost (at true rates) | ~$0.10 | ~$0.13 |
| reviewer output volume | ~700–800 tok each | **1.2k–2k tok each** |
| judged → narrated | 13 → 5 | **23 → 11** |
| BUILD findings | **2 (correct: hide-plans primary + visibility conditional)** | **1 (visibility issue folded away — no verifiable entry)** |

### Hard gates

| Gate | A: gpt-4o | B: gpt-4.1 |
|---|---|---|
| Complete stitched quotes | ✅ | ✅ |
| Correct BUILD set (2–3, right findings) | ✅ 1 primary + 1 conditional | ❌ 1 primary only; proposal-bid visibility lost its own acceptance criteria |
| No blind CSS in layout findings | ✅ | ✅ |
| UX/Product Synthesis intact (6 subsections) | ✅ | ✅ |
| Documents prioritized over plans | ✅ | ✅ |

### Verdict: **keep gpt-4o as the default premium model.**

gpt-4.1 is not a drop-in replacement: the pipeline's prompts are tuned to
gpt-4o's behavior. Concretely, gpt-4.1 (a) writes ~2× longer reviewer outputs,
(b) is far more permissive as the narration judge (11/23 narrated vs 5/13 —
the BUILD gate loosens), and (c) the downstream merge/relationship stages
collapsed the narrated set into a single BUILD finding, dropping the
document-visibility issue as an independently verifiable item. It was also 2×
slower end-to-end at slightly higher cost. One run each (temperature
nondeterminism applies), but the deviation is large and in the wrong direction
on a hard gate — adoption would require re-tuning the judge and merge prompts
first, which is prompt-quality work, not routing work.

The env flag stays: re-testing later is
`LOUPE_MODEL_PREMIUM=gpt-4.1 node gateway/server.mjs` — nothing else changes,
and the cache self-invalidates via the /health model map.

### Also observed

- The intermittent fast-502s (the failure that originally shipped findings
  without targets) reproduced in config A on `target-generation:visual-functional`
  and `prompt-critic`, then succeeded on manual re-run — consistent with
  provider-side rate limiting after the parallel reviewer burst. Both attempts
  fell inside the 500ms/1000ms backoff window. With error bodies now surfaced,
  the next occurrence will name the upstream cause; if it recurs, lengthen
  `RETRY_BACKOFF_MS` (e.g. 2s) rather than adding attempts.
- Cost estimates price the `premium` label at gpt-4o rates. When overriding
  `LOUPE_MODEL_PREMIUM`, set matching rates in `~/.loupe/config/routing.json`
  (`rates` map) if cost accuracy matters.
