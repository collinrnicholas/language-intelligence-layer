# Persado Autopilot

**Persado inside the tools marketers already use.** A Chrome extension (MV3) that
scores and optimizes copy with the real Persado API, on any web page and in
Mailchimp draft campaigns. You do not copy and paste, and you do not open a separate
app. Think of Grammarly, but for marketing performance. The extension is the first
surface and the development environment. The platform adapters and the Persado
service behind them are built to be reused.

Architecture, API sources, Mailchimp's limits, the security model and what has and
has not been verified live: **[docs/AUTOPILOT.md](docs/AUTOPILOT.md)**.
The original brief-capture thesis is in `VISION.md`.

## Provenance

This project grew out of [Loupe](docs/loupe/VISION.md), the author's own earlier
project, and reuses Loupe's capture and gateway infrastructure. The extension in
`extension/` is the new work. `agent/`, `analyzer/` and the surrounding research and
spec directories are Loupe code, kept under their original names. Loupe's product
docs live in `docs/loupe/`.

## What it does

**On any web page:**
1. **Scan.** The side panel reads the page's headlines and calls to action and ranks
   them with a local copy check, labelled as local.
2. **Score.** Sends the selected line to Persado (`POST /v1/score`, 1 run) and shows
   Persado's score, band, compliance and emotions.
3. **Optimize.** Sends it to Persado (`POST /v1/optimize`, 5 runs) and shows the
   original against Persado's ranked alternatives, with real scores.
4. **Preview on page.** Swaps the optimized line into the page in place, then
   restores it. Nothing is saved to the site.

**In Mailchimp:**
1. Open a regular campaign draft. The sidebar matches its URL to an API-verified campaign and displays actual subject, preview, and eligible body/CTA copy without spending credits.
2. See actual estimated campaign reach and, when comparable sent history exists, an email-volume-weighted click baseline. Optional details provide source campaigns and observed post-send reports.
3. Score individual fields explicitly (1 credit). Scored fields appear in lower-score-first review order with compact returned bands/scores; unscored copy is separate. Scoring and optimization are independent actions.
4. Optimize a selected field (5 credits), then compare original copy with up to three selectable real Persado alternatives. Scores are predictions, not measured conversion lift. No changes are saved automatically.
5. Apply an alternative to subject or preview. The gateway patches only the selected setting, checks draft status and verifies by re-reading. Undo restores that field if no later edit conflicts.
6. Explore impact with an explicitly labelled scenario calculator. User-selected assumptions are distinct from Persado model output and observed results. No score difference is converted to revenue.
7. Body Apply is disabled to preserve the email structure. No send action is available.

**Usage:** Mailchimp connection and usage diagnostics live in Settings. Account balance is unavailable; no assumed 100-credit balance is shown. Cached scoring of unchanged text avoids another paid request. Explanations use fields already returned by Persado, without an additional paid call. See [architecture and limits](docs/AUTOPILOT.md).

Recording a narrated brief still works. Narration is transcribed by the local
gateway (Whisper), and the variants now come from Persado's optimize run.

## Running it

From a fork, clone the repo and work on the feature branch:

```bash
git clone https://github.com/collinrnicholas/language-intelligence-layer.git
cd language-intelligence-layer
git checkout feature/persado-autopilot
npm install
```

Then build it:

```bash
npm run build        # verifies, then writes extension/dist/unpacked (+ a zip if `zip` exists)
```

Start the local gateway with provider credentials injected from your secret manager:

```sh
lokalite run --project language-intelligence-layer --keys MAILCHIMP_API_KEY,PERSADO_API_KEY,PERSADO_PROXY_TOKEN -- npm run gateway
```

Provider keys stay in the gateway environment. The placeholder-only `.env.example` documents the configuration. Stop/restart an older gateway on port 8788 yourself if needed.

1. In `chrome://extensions`, enable Developer mode and load `extension/dist/unpacked` or `extension/`.
2. Open Persado Settings, enter the local **gateway pairing token** (not a provider key), then Pair gateway. Set Brand name and test Mailchimp.
3. Hard-reload the Mailchimp page after an extension reload. Open a regular draft, then Score → Optimize → Apply.
4. Refresh Mailchimp to confirm persistence; use Undo in Persado to restore a previous value.

Complete setup, API limitations, security, and verification details: [docs/AUTOPILOT.md](docs/AUTOPILOT.md).

## Repo layout

| Path | What it is |
|---|---|
| `extension/` | **The Persado Autopilot extension**: the new work in this repo. `src/persado-api.js`, `src/adapters/`, `src/optimizer.js`, `src/guard.js`, `src/usage.js`, `src/activity.js`, `test/`. |
| `gateway/` | Local gateway for narration transcription (Whisper). Never sees the Persado or Mailchimp key. |
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
npm run typecheck      # syntax-checks every extension script
npm test               # inherited agent suite + extension tests (Persado, Mailchimp, safeguards, usage, worker)
npm run build          # smoke + package extension/dist/unpacked
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
