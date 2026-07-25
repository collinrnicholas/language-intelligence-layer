# Model-routing benchmark (NNA session)

Answers: *does each pipeline stage have the right model for prompt quality?*

## ⚠️ Environment blocker (read first)

The local gateway at `http://localhost:8787` is an **OpenAI-only proxy that ignores
the `model` field**. Proof:

```
model=totally-fake-model-xyz-999  → {"content":"Ok!"}     # garbage id succeeds
model=claude-sonnet-4-6 "Anthropic or OpenAI?" → "OpenAI."  # not actually Sonnet
```

So routing configs **B–E collapse to the same OpenAI backend as A** here — a
cross-family benchmark is **not runnable** until the gateway can serve the named
models. To enable it, point `LOUPE_API_URL` at a gateway that:
- has an Anthropic key (for `claude-sonnet-4-6`) and OpenAI access to `gpt-5.5` / `gpt-4.1`, and
- allowlists those ids via `LOUPE_MODEL_ALLOWED` (otherwise it falls back to its tier map).

Only the **standard (gpt-4o-mini) ↔ premium (gpt-4o)** axis is real in this environment.

## Files

- `configs/A-baseline.json` … `E-hybrid.json` — the five configs from the request.
- `configs/optimal.json` — the recommended per-stage assignment (see the analysis).
- `check-gates.mjs` — scores a `build-prompt.md` against the hard gates. Runnable now.
- `run-bench.sh` — swaps each config into `~/.loupe/config/routing.json`, re-runs
  analyze + build-this, saves the prompt, and scores the gates.

## Run

```bash
export LOUPE_NNA_SESSION=~/.loupe/projects/NNA/runs/<run>/analysis/session.loupe
export LOUPE_API_URL=http://<gateway-with-real-models>
npm run build && bash bench/run-bench.sh
```

## Judging

Gates are heuristic markers of "would Claude Code build the right UI": complete
quotes, correct BUILD findings, no blind CSS, documents prioritized, synthesis
aligned with BUILD, directly usable, explore-first. A FAIL means read the section.
Final judgment is still a human diff of `out/*/build-prompt.md`, not prose polish.
