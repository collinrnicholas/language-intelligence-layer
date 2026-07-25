# Loupe Model Routing & Selection Report — July 3, 2026

Scope: every LLM call in `analyze` + `build-this`, measured on the NNA session
(gateway → OpenAI). Latency/token numbers are measured (cold-cache run,
`debug/00_timings.json` / `11_timings.json`); costs are computed from current
published rates. Quality classifications follow the pipeline's role in producing
the final Claude Code build prompt.

## 1. Current pipeline — measured

The gateway maps every call to exactly two chat models: **vision or
`premium` hint → gpt-4o, everything else → gpt-4o-mini** (plus whisper-1 for
transcription). Per-stage, cold cache:

| Stage | Model | Vision | In/Out tokens (est) | Latency | Est. cost | Quality class |
|---|---|---|---|---|---|---|
| transcript-stitch | gpt-4o-mini | — | 494 / 295 | 5.2s | $0.0003 | Low |
| session-understanding (pre-review) | gpt-4o-mini | — | 578 / 118 | 2.0s | $0.0002 | **Medium→Critical** (steers reviewers) |
| persona-review: PM | gpt-4o | 3 imgs | 4.9k / 762 | 8.0s | ~$0.020 | Medium |
| persona-review: Product Designer | gpt-4o | 3 imgs | 4.9k / 693 | 7.5s | ~$0.019 | Medium |
| persona-review: Design Systems | gpt-4o | 3 imgs | 4.8k / 805 | 8.4s | ~$0.020 | Medium |
| persona-review: Frontend Eng | gpt-4o-mini | — | 4.8k / 968 | 12.4s | $0.0013 | Medium |
| persona-review: Accessibility | gpt-4o-mini | — | 4.8k / 1.3k | 15.4s | $0.0015 | Medium |
| narration-judge (BUILD gate) | gpt-4o | — | 1.6k / 167 | 2.4s | $0.006 | **Critical** |
| session-understanding (post-judge) | gpt-4o-mini | — | 646 / 133 | 2.6s | $0.0002 | **Medium→Critical** (steers targets + synthesis) |
| content-enumeration | gpt-4o | 1 PNG | 826 / 211 | 3.7s | $0.004 | Medium-high (feeds content targets) |
| target-gen: content | gpt-4o | — | 3.7k / 485 | 4.4s | $0.014 | **Critical** |
| target-gen: visual/functional | gpt-4o | 3 imgs | 4.0k / 834 | 8.9s | ~$0.018 | **Critical** (screenshot-aware layout) |
| product-reasoning + UX synthesis | gpt-4o | — | 1.5k / 606 | 4.7s | $0.010 | **Critical** |
| finding-relationships | gpt-4o | — | 894 / 151 | 2.7s | $0.004 | **Critical** (BUILD structure) |
| prompt-critic | gpt-4o | — | 4.2k / 321 | 3.4s | $0.014 | **Critical** |

Full cold run ≈ **15 model calls, ~46s wall (parallelized), ~$0.16** including
image tokens. Cost is *not* the constraint — a full run costs less than a
coffee sip. Latency and final-prompt quality are the constraints, which biases
every decision toward quality.

**Dead code found:** `router.ts` computes a tier upgrade from severity/
confidence, but only `decision.model` is ever sent to the gateway — the tier is
never transmitted. Per the wire-or-delete convention this should either be
wired (send tier, let the gateway map it) or deleted. Currently severity has no
effect on routing at all.

## 2. Provider landscape (current published rates, per 1M tokens)

| Provider | Model | In / Out | Vision | Notes |
|---|---|---|---|---|
| OpenAI | gpt-4o (current) | $2.50 / $10 | ✓ | **Legacy — grandfathered pricing**; lineup has moved to 4.1/5-series |
| OpenAI | gpt-4.1 | $2.00 / $8 | ✓ | Newer, cheaper than 4o |
| OpenAI | gpt-4.1-mini | $0.40 / $1.60 | ✓ | Vision-capable small model |
| OpenAI | gpt-4o-mini (current) | $0.15 / $0.60 | ✓ | Cheapest thing in use today |
| Anthropic | Claude Sonnet 4.6 | $3 / $15 | ✓ | Best speed/intelligence balance in Claude line |
| Anthropic | Claude Opus 4.8 | $5 / $25 | ✓ high-res | 2576px long-edge vision — relevant for small-text reading |
| Anthropic | Claude Haiku 4.5 | $1 / $5 | ✓ | Fast; pricier than gpt-4o-mini |
| Anthropic | Claude Fable 5 | $10 / $50 | ✓ | Overkill for per-stage calls here |
| Google | Gemini 3.1 Pro | $2 / $12 | ✓ | Worth an eval pass on vision stages |
| Google | Gemini 3.5 Flash | $1.50 / $9 | ✓ | |
| DeepSeek | V4 Flash | $0.14 / $0.28 | text-focused | Only plausible for stitch/JSON repair — savings <1¢/run, not worth a provider integration |

## 3. Recommendation table

Route names: `standard` = cheap tier, `premium` = strong tier (gateway maps to
concrete models; now configurable via `LOUPE_MODEL_PREMIUM` / `LOUPE_MODEL_STANDARD`
/ `LOUPE_MODEL_ALLOWED` env on the gateway and `~/.loupe/config/routing.json`
per-stage on the client).

| Stage | Current model | Current route | Recommended model | Recommended route | Why | Quality risk | Latency/cost impact |
|---|---|---|---|---|---|---|---|
| transcript-stitch | gpt-4o-mini | standard | keep (option: gpt-4.1-mini) | standard | Mechanical merge; quality verified holding; output is quote-critical but constrained to reordering input words | None | none |
| session-understanding ×2 | gpt-4o-mini | standard | **gpt-4o / Sonnet 4.6** | **premium** | This is product framing that steers target generation and synthesis — it is product/UX reasoning misfiled on the cheap tier. 700-token call: upgrade costs ~$0.005 and ~1s | None (upgrade) | +~1s, +$0.005 |
| persona reviewers (vision ×3) | gpt-4o | premium | keep; A/B Sonnet 4.6 | premium | Finding recall lost here is unrecoverable downstream (judge only confirms what reviewers found) | Low if A/B'd | ~equal |
| persona reviewers (text ×2) | gpt-4o-mini | standard | keep | standard | Already the floor; deterministic checks + judge gate their output. Downgrading further (nano/V4-Flash) risks recall for <1¢ | — | — |
| narration-judge | gpt-4o | premium | keep premium; candidate Sonnet 4.6 | premium | Decides what enters BUILD — hard quality gate, do not downgrade | — | — |
| content-enumeration | gpt-4o | premium (vision) | keep; **test Opus 4.8** | premium | Failure mode is misreading small filenames. Opus 4.8's high-res vision (2576px, 1:1 pixel coords) directly targets this; ~$0.03/call at Opus rates | None (upgrade) | +$0.02, similar latency |
| target-gen (content + visual/functional) | gpt-4o | premium | keep; **A/B Sonnet 4.6** | premium | Screenshot-aware layout targets are a protected quality gate. The A/B hypothesis: targets are *executed by Claude Code*, and Claude-authored instructions may transfer better | Low if A/B'd | +20% in / +50% out cost (~$0.01/run) |
| product-reasoning + UX synthesis | gpt-4o | premium | **Sonnet 4.6** | premium | Strongest swap candidate: the synthesis is prose written *for Claude Code to act on*. A Claude model writing for a Claude executor shares style, structure, and instruction conventions | Low; A/B first | ~equal latency, +$0.005 |
| finding-relationships | gpt-4o | premium | keep | premium | Decides BUILD structure (principle/consequence folding); tiny call, nothing to save | — | — |
| prompt-critic | gpt-4o | premium | **Sonnet 4.6** (Opus 4.8 behind flag) | premium | **Highest-leverage swap.** The critic's literal job is "will Claude Code execute this correctly?" — a Claude model is the closest proxy for the reader. Opus 4.8 is notably strong at review/critique tasks | Low; improves alignment with executor | +$0.01 (Sonnet) / +$0.03 (Opus) |
| transcription | whisper-1 | — | keep | — | Works; cached by audio hash now | — | — |

### Unsafe downgrades (do not do)
- Narration judge → any cheap model. It gates BUILD; a false negative silently drops a narrated finding.
- Target generation → non-vision or cheap model. Layout targets need the screenshots; content targets need instruction-following precision (the mini-tier already failed at this historically — that's why the content batch routes to `build`).
- Prompt critic, UX synthesis, finding-relationships → cheap tier. These author/gate the final artifact.
- Vision reviewers → text-only. Content/hierarchy findings come from reading the screenshots.

### Safe cheap-tier usage (already correct)
- Transcript stitching, JSON-repair retries, text-only reviewers, session-context assembly (deterministic, no LLM at all).
- The functional-only target batch already drops images and can ride the standard tier — implemented.

### Where a stronger model is worth paying for
1. Prompt critic → Sonnet 4.6 (executor-aligned judgment).
2. UX synthesis → Sonnet 4.6 (executor-aligned prose).
3. Session understanding → premium tier (mis-tiered today).
4. Content enumeration → Opus 4.8 high-res when Content findings are present (small-text OCR).

Total cost of adopting all four: **≈ +$0.05/run**. Immaterial.

### Cheapest useful move inside the current provider
`gpt-4o` is legacy; `gpt-4.1` is newer, cheaper ($2/$8 vs $2.50/$10), and
vision-capable. Setting `LOUPE_MODEL_PREMIUM=gpt-4.1` is a one-env-var A/B that
likely improves quality *and* cost simultaneously. Run the benchmark below
before committing.

## 4. Should model choice depend on finding type?

Largely already implemented — keep, don't expand:

| Finding type | Routing today | Verdict |
|---|---|---|
| Layout / hierarchy / workflow / navigation | Vision premium targets, explore-first prompts, LAYOUT_RE deterministic anchor | Correct — keep premium+vision |
| Functional bug | Premium text, images dropped (symptom-and-diagnose rule) | Correct — cheapest safe form already |
| Accessibility | Deterministic checks + text-standard reviewer | Correct — most a11y findings are computed, not reasoned |
| Content clarity | Vision premium enumeration + `build`-task premium targets | Correct; the one upgrade worth testing is Opus 4.8 for enumeration |
| Design-system consistency | Deterministic drift checks + vision reviewer | Correct |
| Deterministic technical (console errors, slow requests) | No LLM at all | Correct |

Adding more per-finding-type model branching beyond this would multiply cache
keys and test surface for no measured gain.

## 5. Benchmark plan (NNA session)

Configs:
- **A (baseline):** current routing (gpt-4o / gpt-4o-mini).
- **B (OpenAI refresh):** `LOUPE_MODEL_PREMIUM=gpt-4.1`, `LOUPE_MODEL_STANDARD=gpt-4.1-mini`.
- **C (executor-aligned):** B + routing.json: `prompt-critic`, `product-reasoning+synthesis`, `session-understanding` → `claude-sonnet-4-6`; `content-enumeration` → `claude-opus-4-8`. (Requires the gateway Anthropic branch — see §6.)

Procedure per config (3 runs each, temperature nondeterminism):
```
export LOUPE_DISABLE_LLM_CACHE=1        # no cross-config contamination
loupe analyze <NNA session>             # capture debug/00_timings.json
loupe build-this <artifact> --goal "Minimal changes" --target "Claude Code"
```

Scoring — each final build-prompt.md is scored 1–10 on:
1. product understanding, 2. visual specificity, 3. UX reasoning,
4. implementation clarity, 5. avoidance of blind CSS prescriptions,
6. likelihood Claude Code produces the right UI.

Judges: (a) pairwise LLM judge (Claude Opus 4.8, blind, order-randomized,
both directions to cancel position bias), (b) one human pass. Hard gates —
fail any and the config is rejected regardless of scores:
- complete stitched quotes present
- 2–3 BUILD findings, correct ones (hide-plans primary, visibility conditional)
- UX/Product Synthesis present, all six subsections
- zero prescribed CSS in layout findings
- documents-prioritized-over-plans framing intact

Results land in `evals/results/` (existing schema) with the timing artifacts.
Decision rule: adopt a config only if hard gates pass 3/3 runs AND the 6-axis
mean is ≥ baseline. Speed/cost never overrides a quality regression — the final
artifact is the product.

**Golden-session regression check (recommended follow-up):** a small script
that runs the NNA session (cache on — deterministic and free once warmed) and
asserts the hard gates above against `build-prompt.md`. Run in CI on prompt or
routing changes.

## 6. Implementation status

Shipped in this pass (smallest changes first):
1. **Gateway env flags** — `LOUPE_MODEL_PREMIUM`, `LOUPE_MODEL_STANDARD`,
   `LOUPE_MODEL_ALLOWED` (allowlist for explicit per-stage model ids from the
   client). Restart the gateway to apply.
2. **Client per-stage routing** — `~/.loupe/config/routing.json`
   (`stages` map: stage label or prefix → model preference). Malformed/absent
   config is ignored; un-allowlisted ids fall back to tier mapping, so a stale
   entry can't break runs. Overridden model is part of the cache key.
3. **Cost logging** — every `[LLM:timing]` line and timings artifact now carries
   `cost≈$…` (rates configurable in routing.json; image tokens excluded, so
   vision costs are underestimates). Run summary prints total est. cost.

Not implemented (next steps, in order):
- **Gateway Anthropic branch** — route `claude-*` model ids to the Anthropic
  Messages API (`ANTHROPIC_API_KEY`, gateway-side only, consistent with
  ADR-010). Needed before config C can run. Small, isolated change to
  `handleComplete`.
- Wire-or-delete the unused tier upgrade logic in `router.ts`.
- Golden-session CI check (§5).
- Gemini/DeepSeek: not recommended now — Gemini only as a vision-stage eval
  candidate if Claude A/Bs disappoint; DeepSeek's savings (<1¢/run) don't
  justify a third provider surface.

## 7. Bottom line

- Routing *shape* is already right: cheap where mechanical, premium where the
  artifact is authored or gated. No unsafe downgrades exist today.
- The two real errors are **session understanding on the cheap tier** (mis-tiered
  product reasoning) and **gpt-4o being a legacy model** — both one-flag fixes.
- The highest-upside change is **executor alignment**: let Claude models write
  and judge the prose that Claude Code will execute (critic first, synthesis
  second). Cost impact ≈ +$0.05/run; latency ≈ neutral; must pass the §5
  benchmark before adoption.
