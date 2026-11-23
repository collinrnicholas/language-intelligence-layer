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
1. Connect a test account (API key and server prefix) in Settings.
2. On `*.admin.mailchimp.com` the panel lists your draft campaigns, and a small
   overlay appears on the campaign editor.
3. **Optimize draft** runs everything after that one click:
   1. Reads the subject line, preview text and eligible body copy.
   2. Sends them to Persado as one `EMAIL_SUBJECT_BODY` optimize run.
   3. Rejects any rewrite that breaks a merge tag, link or footer, or adds a figure.
   4. Writes the safe rewrites back to the draft.
   5. Re-reads the draft to verify.
4. **Revert** restores the original. **Send test** uses Mailchimp's own test send.
   Nothing is ever sent to an audience.

**Usage** is always visible:
- A one-line bar under the header shows the connection and runs left.
- Settings shows the full ledger.
- Persado's API has no balance endpoint, so remaining is a labelled local estimate
  (portal quota 100, optimize 5, score 1). The exception is when Persado reports
  `quota_exhausted`; that is shown as authoritative.

Recording a narrated brief still works. Narration is transcribed by the local
gateway (Whisper), and the variants now come from Persado's optimize run.

## Running it

```bash
npm install
npm run build        # verifies, then writes extension/dist/unpacked (+ a zip if `zip` exists)
```

1. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and
   select `extension/`, or the `extension/dist/unpacked` folder from the build.
2. Click the toolbar icon to open the side panel, then **Settings**:
   - **Persado API.** Paste the key from
     [Persado Developers](https://api.persado.com/api/developers), then **Save key**.
     Saving tests the connection with the free catalogue call. Set **Brand name**:
     Persado requires an account name on every run. Without it, a page's domain is
     used.
   - **Mailchimp** (optional). Paste an API key (Mailchimp: Profile, Extras, API
     keys). The server prefix is read from the key's `-usNN` suffix. Add a test
     e-mail address, then **Save and test**.
3. Open any page and press **Score** or **Optimize**. Or open a Mailchimp draft and
   press **Optimize draft**.

Keys stay in this Chrome profile and are read only by the extension's service
worker. See docs/AUTOPILOT.md §4.

### Gateway (only for recorded briefs)

The local gateway now does one job: transcribing narration.

```bash
OPENAI_API_KEY=sk-... npm run gateway     # listens on 127.0.0.1:8788
curl -s http://127.0.0.1:8788/health
```

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | Whisper transcription of recorded briefs. |
| `ANTHROPIC_API_KEY` | — | Optional, for `claude-*` models (gateway `/v1/ai/complete`, used by the inherited Loupe agent). |
| `PERSADO_GATEWAY_PORT` | `8787` (`npm run gateway` sets `8788`) | Gateway port. The extension calls 8788. |
| `PERSADO_GATEWAY_HOST` | `127.0.0.1` | Gateway bind address. |
| `PERSADO_GATEWAY_FFMPEG` | off | Set `1` to normalise audio to wav before Whisper. |

The equivalent `LOUPE_*` names are still read as a fallback. See the header of
`gateway/server.mjs`.

### Keep the gateway running at login (macOS)

```bash
# add your provider key to ~/.loupe/gateway.env, then:
./gateway/install-launchd.sh
```

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
