# Loupe

> An AI Design Engineering Partner that observes how software is built, identifies opportunities for improvement, teaches the reasoning behind those opportunities, and generates implementation-ready work for AI coding agents.

Loupe is the fastest path from "this feels off" to "this is fixed."

## How It Works

```
Record → Analyze → Select → Explain → Redesign → Build → Route to Agent → Verify
```

1. **Record** — Chrome extension captures clicks, scrolls, DOM, screenshots, console errors, network timing, and narrated thoughts. Produces a `.loupe` file.
2. **Analyze** — CLI runs deterministic checks + design drift + 5 AI reviewer personas. Produces scores, opportunities, and a report.
3. **Build This** — Generate production-ready implementation packages for Claude Code, Cursor, or Codex.
4. **Route** — Packages arrive directly in your agent's workspace. Provider-specific wrapper files included.
5. **Verify (future)** — Re-record after implementation. Compare scores. Track improvement.

## AI Gateway (no provider keys for users)

Loupe is a SaaS product. **End users never configure OpenAI/Anthropic/Gemini API
keys.** The CLI and extension are clients of the **Loupe AI gateway**, which owns
all model-provider credentials. AI features (`analyze`, `transcribe`) call the
gateway; the gateway picks the model.

Client config lives in `~/.loupe/config/client.json`:

```json
{
  "apiUrl": "https://api.loupe.dev",
  "authToken": "<your Loupe token>",
  "mode": "cloud"
}
```

**Local development** runs the gateway service yourself and points the client at it:

```bash
npm run gateway                      # start it (provider key set gateway-side)
export LOUPE_API_URL=http://localhost:8787
export LOUPE_DEV_TOKEN=<dev token>   # optional
# The local gateway process is the ONLY place provider keys live.
```

If the gateway is unreachable, `analyze`/`transcribe` now say so explicitly and
skip the AI steps (rather than silently producing an empty brief):

```
Gateway not reachable at http://localhost:8787 — transcription + AI review skipped.
  Start it with:  npm run gateway   (ensure the gateway has its provider key configured)
```

`analyze` still produces deterministic findings when the gateway is down.

### Keep the local gateway always running (macOS)

So you never have to start it by hand, install it as a launchd agent — starts at
login, auto-restarts on crash:

```bash
./gateway/install-launchd.sh         # creates ~/.loupe/gateway.env on first run
# add your provider key to ~/.loupe/gateway.env (e.g. OPENAI_API_KEY=...), then:
./gateway/install-launchd.sh         # loads the agent
curl -s http://localhost:8787/health # {"ok":true,...}
```

The provider key lives only in `~/.loupe/gateway.env` (chmod 600, never committed,
never seen by the client) — not in the plist. To stop/disable:
`launchctl unload ~/Library/LaunchAgents/dev.loupe.gateway.plist`.

(Prefer pm2? `pm2 start gateway/server.mjs --name loupe-gateway && pm2 save && pm2 startup` works too — just export the provider key in pm2's environment.)

See `docs/AI_GATEWAY.md` for the full contract.

## Quick Start

```bash
# Build
cd loupe && npm run build

# Record a session (Chrome extension)
# Load unpacked: extension/dist/

# Analyze
loupe analyze ~/Downloads/loupe/session.loupe

# Build implementation package
loupe build-this ~/Downloads/loupe/session.loupe \
  --goal "Minimal changes" \
  --destination claude-code

# Configure destination once
loupe destination set --id myproject --project "PM Toolkit" \
  --type claude-code --workspace ~/Projects/PMToolkit
```

## Project Structure

```
loupe/
├── VISION.md              # What Loupe is becoming
├── PRINCIPLES.md          # Design north stars
├── extension/             # Chrome extension (recorder)
│   ├── src/              # content.ts, background.ts, types.ts
│   ├── popup/            # 5-state popup UI (TS + HTML)
│   └── offscreen/        # MV3 offscreen document for mic
├── agent/                # CLI + analysis engine
│   ├── src/
│   │   ├── commands/     # validate, analyze, build-this, destination
│   │   ├── checks/       # deterministic, drift
│   │   ├── ai/           # Persona reviewers
│   │   ├── llm/          # Loupe gateway client (router + gateway provider + client config)
│   │   ├── opportunities/ # Explain, Redesign, Build This
│   │   ├── destinations/  # Router + 7 providers
│   │   ├── target-design/ # Gap analysis engine
│   │   ├── reporters/    # HTML report generator
│   │   └── opportunities/ # Type defs + context builder
│   └── test/             # Hardening tests + fixtures
├── docs/                 # Architecture, ADRs, formats
├── specs/                # Product specs (PRDs)
│   ├── chrome-extension.md
│   ├── explain.md
│   ├── redesign.md
│   ├── build-this.md
│   ├── verify.md
│   ├── destination-router.md
│   ├── opportunity-lifecycle.md
│   └── loupe-studio.md
├── prompts/              # Versioned LLM prompts
│   ├── v1/              # Initial prompts
│   └── v2/              # Current prompts
├── benchmarks/           # Benchmark expectations
│   ├── pm-toolkit/      # 8 key opportunities expected
│   └── fithub/          # 5 key opportunities expected
├── research/             # Design pattern research
│   ├── claude-design.md
│   ├── linear-ui.md
│   ├── stripe-dashboard.md
│   ├── apple-hig.md
│   └── shadcn.md
├── evals/                # Evaluation scaffolding
│   ├── fixtures/        # Session files for benchmarking
│   ├── scorecards/       # Manual eval scorecards
│   ├── results/          # Eval results
│   └── prompts/          # Benchmark prompts
├── changelog/            # Version history
└── docs/                 # Architecture docs
```

## Current Status

**v2.0-alpha** — Extension recorder, analysis pipeline, Explain/Redesign/Build This, Destination Router, Target Design Mode, popup v3. All compiled and tested.

See `changelog/v2.0.0-alpha.md` for details.
See `docs/ROADMAP.md` for what's next.

## Contributing

See `CONTRIBUTING.md` — in particular the anti-sprawl rule: implementation
work produces source + tests only; generated output goes to `~/.loupe`, never
the repo. Verify with `npm run repo:check`; sweep local artifacts with
`loupe clean`. Boundaries: `docs/REPO_HYGIENE.md`.
