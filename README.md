# Language Intelligence Layer

**A front door for Motivation AI.** A marketer stands on the page they're worried
about, talks for a minute, and Persado receives a structured, grounded brief — the
page, the actual on-page copy, the audience, the objective, and the intent in their
own words.

The capture shell is a Chrome extension (MV3) and is disposable. The structured
brief is the durable asset; variants are downstream. `VISION.md` states the
hypothesis, what would prove it wrong, and how to test it cheaply.

## Provenance

This project is built on [Loupe](docs/loupe/VISION.md), the author's own prior
project, and reuses Loupe's capture, vision and gateway infrastructure. The
Language Intelligence Layer extension in `extension/` is the new work; `agent/`, `analyzer/` and
the surrounding research and spec directories are inherited Loupe code, kept
under their original names. Loupe's product docs live in `docs/loupe/`.

## How it works

1. **Record** — the side panel captures your narration. `getUserMedia` runs in
   the page context so the microphone prompt behaves normally.
2. **Ground** — while you talk, the extension silently screenshots the visible
   tab (at the start, then every ~25s) and extracts the page's actual copy:
   headline, primary CTA, promo and trust lines, each with a CSS selector and
   nearby context. Nothing opens a tab or covers the page.
3. **Transcribe** — the audio goes to the local gateway, which calls Whisper.
4. **Generate** — narration, extracted copy and screenshots go to
   `/v1/ai/recommend`. Because images are attached the call routes to a
   vision-capable model, so variants rewrite the copy that is actually on the
   page instead of inventing new page elements.
5. **Review** — each variant carries a rationale, a compliance badge (UDAAP plus
   Reg DD or Reg Z depending on the product line) and an illustrative lift
   estimate. The brief exports as a PDF.

## Running it

The gateway holds the provider API keys. The extension never sees them.

```bash
# 1. Start the gateway — required; transcription and generation both need it
OPENAI_API_KEY=sk-... npm run gateway
curl -s http://127.0.0.1:8788/health

# 2. Load the extension
#    chrome://extensions → Developer mode → Load unpacked → select extension/
```

Click the toolbar icon to open the side panel. The toolbar badge tracks state:
red recording, amber working, green with the variant count when done.

If the gateway is not running the panel says so in plain language and retains
your recording, so a failed transcription never costs you the narration.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | Required. Whisper + generation. |
| `ANTHROPIC_API_KEY` | — | Optional, for `claude-*` models. |
| `PERSADO_MODEL_PREMIUM` | `gpt-4o` | Vision tier — used whenever screenshots are attached. |
| `PERSADO_MODEL_STANDARD` | `gpt-4o-mini` | Text-only tier. |
| `PERSADO_MODEL_ALLOWED` | — | Comma-separated model ids a client may request explicitly. |
| `PERSADO_GATEWAY_PORT` | `8787` | Gateway port. |
| `PERSADO_GATEWAY_HOST` | `127.0.0.1` | Gateway bind address. |
| `PERSADO_GATEWAY_FFMPEG` | off | Set `1` to normalise audio to wav before Whisper. |

The equivalent `LOUPE_*` names are still read as a fallback, so an existing shell
profile keeps working. See the header of `gateway/server.mjs`.

### Keep the gateway running at login (macOS)

```bash
# add your provider key to ~/.loupe/gateway.env, then:
./gateway/install-launchd.sh
```

## Repo layout

| Path | What it is |
|---|---|
| `extension/` | **The Language Intelligence Layer extension** — the new work in this repo. |
| `gateway/` | Local AI gateway; the only place provider keys live. |
| `scripts/` | `smoke.mjs` static contract checks, version and hygiene tooling. |
| `docs/` | `REGRESSION.md` is the manual test checklist; `docs/loupe/` holds inherited Loupe docs. |
| `agent/`, `analyzer/`, `app/` | Inherited Loupe code — capture, vision and analysis pipeline. |
| `benchmarks/`, `evals/`, `research/`, `specs/`, `prompts/`, `changelog/` | Inherited Loupe surface area. |

Only `extension/` and `gateway/` are live for this demo.

## Checks

```bash
npm run smoke          # static cross-context contract checks — before every commit
npm run version:check  # shipped changes need a version bump + changelog entry
npm run repo:check     # repo hygiene
npm run typecheck
npm test
```

Before declaring extension work done, walk `docs/REGRESSION.md`. It covers what
static checks cannot see: the mic prompt, stale content scripts after a reload,
and the waveform responding to real audio.

## Contributing

`VISION.md` for what this is and what would disprove it. `CONTRIBUTING.md` for
file discipline — in particular the anti-sprawl rule:
implementation work produces source and tests, and generated output goes to
`~/.loupe`, never the repo. `CLAUDE.md` is the operating manual agents read
first; `claude-design.md` is the design source of truth.
