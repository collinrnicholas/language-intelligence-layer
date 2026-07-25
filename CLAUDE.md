# CLAUDE.md — operating manual for agents in this repo

Read this before touching anything. It exists because this codebase has a specific, repeating failure mode (see §5) and a set of invariants that look arbitrary until you break one.

---

## 1. What this is

**Persado Capture** — intake for Motivation AI. A marketer stands on the page they are worried about, narrates for a minute, and out comes a structured, grounded brief: the page, the on-page element and its current copy, the audience, the objective, and their intent verbatim. The Chrome extension (MV3) is the capture shell and is treated as disposable; **the brief is the durable artifact**. Variants are downstream and, in this prototype, come from a general-purpose model standing in for Motivation AI. See `VISION.md`.

Branch: `persado-demo`. Extension version lives in `extension/manifest.json`.

**This repo is a fork of Loupe, the author's prior project.** See [Provenance](README.md#provenance) in the README — the fork is stated openly, and that section is why Loupe naming legitimately persists in the excluded directories below. Do not "clean it up".

**The rebrand is already done, and deliberately partial. Do not extend it.** What was rebranded: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, this file, and the gateway's env vars (now `PERSADO_*` with `LOUPE_*` retained as a fallback). Loupe's own product docs moved to `docs/loupe/` with an inherited-document banner.

What was deliberately left alone, and why — **do not "finish the job" here**:

- `agent/`, `analyzer/`, `app/`, `benchmarks/`, `evals/`, `research/`, `specs/`, `prompts/`, `changelog/` — this is Loupe's code and Loupe's docs. Renaming it would be a huge diff over working code and would misrepresent whose code it is.
- **`~/.loupe`** — a real directory on this machine holding live project data. The CLI and its tests read it. Renaming the path breaks both.
- **The root `package.json` name is still `"loupe"`.** `agent/src/runtime/paths.ts` finds the repo root by matching `pkg.name === 'loupe'` exactly, so renaming it silently breaks `findRepoRoot()` and everything built on it. Fixing that would mean editing `agent/`, which is out of scope.
- **`/health` still reports `service: 'loupe-gateway'`.** That string is the provider identifier shared with `agent/src/llm/` (`ProviderName = 'loupe-gateway'`, asserted in `agent/test/gateway.test.mjs`). Renaming only the gateway's half would make the service disagree with its own client, and renaming both means editing `agent/`, which is out of scope.
- `gateway/install-launchd.sh` keeps the `dev.loupe.gateway` launchd label and its `~/.loupe` paths. The label identifies an agent that may already be installed on the user's machine; changing it orphans the old plist and can leave two gateways contending for port 8787.

Not everything in the tree is live. The shipping demo is `extension/` + `gateway/`. `extension/` contains zero Loupe references and must stay that way (`npm run smoke` does not check this; `grep -ril loupe extension/` does).

## 2. Read these first

| File | What it governs |
|---|---|
| `claude-design.md` | **Design source of truth.** Brand, color tokens, typography, components, icon states, voice. If a task conflicts with it, the doc wins. If it is missing, STOP — do not invent a design system. |
| `CONTRIBUTING.md` | File discipline. The anti-sprawl rule below is not optional. |
| `docs/REPO_HYGIENE.md` | Where generated output is allowed to live. |
| `docs/ARCHITECTURE.md` | Broader system map. |

**Anti-sprawl rule (from CONTRIBUTING.md):** do not create new docs, specs, research files, sample outputs, debug traces, or analysis runs unless explicitly asked. Normal work produces source changes, tests, and updates to *existing* docs.

## 3. Architecture — four contexts, and what each owns

Everything painful in this codebase comes from state being split across four JS contexts that cannot share memory. Know which one you are editing.

**`extension/sidepanel.js`** — the UI. Loaded as `type="module"`, so **a single top-level throw silently prevents every listener registered after it from binding.** The panel renders normally and buttons do nothing. This is the #1 way this extension "breaks."

**`extension/src/content.js`** — runs in the PAGE context. Owns `getUserMedia`, the `MediaRecorder`, the `SpeechRecognition` live transcript, and the `AnalyserNode` that produces waveform levels. The MediaStream cannot cross into the panel, which is why amplitude is reduced here and posted as throttled `AUDIO_LEVELS` messages.

**`extension/src/background.js`** — service worker. Owns `chrome.tabs.captureVisibleTab` screenshots (FLAG-GATED behind `CAPTURE_SCREENSHOTS` in `config.js`, **default OFF** — when off, capture never runs and no `frames` are written), the DOM element extraction (`extractPageElements`, which runs in BOTH modes and is the PRIMARY grounding path), the session context in `chrome.storage.session` (`persado:pageContext` → `{ frames: [{full, thumb}], elements }`), gateway relay, and the toolbar `chrome.action` icon/badge state.

**`gateway/server.mjs`** — the ONLY place model-provider API keys live. Endpoints: `POST /v1/ai/transcribe` (Whisper) and `POST /v1/ai/recommend` (variants). Model tiers resolve via `PERSADO_MODEL_PREMIUM` (default `gpt-4o`, vision-capable) and `PERSADO_MODEL_STANDARD` (default `gpt-4o-mini`); the legacy `LOUPE_*` names still work as a fallback. An attached image routes the call to the premium/vision tier. Must be running (`npm run gateway`) or transcription and generation fail — a down gateway is NOT a microphone bug, do not conflate them.

## 4. Hard invariants — do not violate these

1. **`getUserMedia` stays in the page context (`content.js`).** Never move it to a popup, an offscreen document, or the side panel. Each of those was tried and each broke the permission prompt. Chrome suppresses or auto-dismisses the mic dialog outside the page.
2. **Nothing may open a tab or window, or cover the page.** The user is often recording their screen. A full-page permission tab was shipped once and was unusable. Screenshot capture must stay silent.
3. **The `/v1/ai/recommend` response contract is fixed:** `{ variants: [{ copy, rationale, compliance, complianceNote, predictedLift }] }`. The UI depends on it.
4. **No purple, no emoji, anywhere in the UI.** The purple/magenta gradient is deprecated; see `claude-design.md` §8. Check marks, dots, rings, and glyphs are CSS/SVG shapes.
5. **A progress step must never claim work that did not run.** Compliance and lift come back inside the single `/v1/ai/recommend` response — do not tick separate "compliance check" / "scoring" steps on a timer.
6. **Fail soft on grounding.** A failed screenshot or element extraction logs and is skipped; it must never block recording or generation.
7. **Single-file inline CSS in `sidepanel.html`.** No build step, no external UI libraries.

## 5. Known failure modes — these have already bitten, repeatedly

**Stale content script after an extension reload.** Tabs already open keep running the PREVIOUS build's `content.js`. `chrome.tabs.sendMessage` succeeds against that stale listener, so any re-injection fallback never fires and the panel drives outdated code. Always reload the extension **and hard-reload the page** before testing. Guard with a `CONTENT_VERSION` handshake — PING and compare versions before sending commands.

**Double injection.** Re-running `content.js` in the same isolated world re-declares top-level `let` bindings and throws `Identifier 'mediaRecorder' has already been declared`. Keep the script idempotent behind a `window.__persadoContent` namespace guard.

**Lying success.** `startRecording()` once returned `{ok:true}` after early-returning without starting anything, so the UI entered the recording state while nothing recorded. Never report success for a no-op; the panel should require explicit confirmation before changing state.

**Producer/consumer key drift.** `background.js` was changed to write `ctx.frames[]` while `sidepanel.js` still read `ctx.startShot || ctx.stopShot`. That silently evaluated to `null`, so **zero screenshots reached the model** while thumbnails still rendered in the UI. Nothing failed loudly. When you rename a key on one side of a context boundary, grep for every reader.

**Silent module death.** See §3. Wrap panel init in try/catch and surface a visible error banner — a broken panel must LOOK broken.

## 6. Workflow

**Commit checkpoints.** Commit after each verified-working step, not at the end. This repo has previously accumulated three full redesigns in one uncommitted blob with no known-good state to bisect or revert to. Before starting new work, verify `git status` is clean or commit what works.

**Run the smoke test.** `npm run smoke` (`scripts/smoke.mjs`) statically verifies the cross-file contracts — `$('id')` lookups against `sidepanel.html`, duplicate IDs, message types having handlers on both ends, storage keys agreeing between producer and consumer, manifest permissions covering the `chrome.*` APIs used, and banned tokens (`#5C2D91`, `#E8388C`, `--prp`, `--grad`). It requires no browser and exits non-zero on failure. A `pre-commit` hook is wired via `core.hooksPath=.githooks`.

**Extend the smoke test rather than working around it.** If you add a cross-context contract, add a check for it.

### Commands

```
npm run gateway     # start the local AI gateway on :8787 (required for transcribe/generate)
npm run smoke       # static contract checks — run before every commit
npm run repo:check  # repo hygiene
npm run typecheck   # types
npm test            # tests
```

## 7. Process safety — do not kill what you did not start

The local gateway is a long-running process holding REAL provider API keys, often started hours earlier by the human. It has already been killed once by an agent running `pkill -f "server.mjs"`, which matched far more than intended and broke the running demo.

- **Never use broad process-killing patterns.** No `pkill -f`, no `killall`, no `kill` by fuzzy name match.
- If a process genuinely must be stopped, identify it precisely first (`lsof -nP -iTCP:<port> -sTCP:LISTEN`), confirm the PID is one you started in this session, and stop that PID only.
- If it is not a process you started, do not stop it. Ask.
- The same restraint applies to `rm -rf`, `git clean`, `git checkout -- .`, `git reset --hard`, and branch deletion. Destructive commands need an exact target, never a glob over a shared tree.

## 8. Verification boundaries — what an agent genuinely cannot do here

`chrome://extensions` cannot be reached by any browser automation. Chrome blocks extensions and automated tooling from scripting `chrome://` pages by design. That means **loading an unpacked extension, reading the service-worker console, and confirming a fix in the running browser are human steps.** No tool works around this.

Consequences for how work is reported:

- Do not claim a fix is verified in-browser. State exactly what was verified statically (`npm run smoke`, code reading) and what still needs a human pass.
- Hand back a short, ordered checklist the human can run in a couple of minutes, with the precise click path and what a pass looks like at each step.
- Ask for the service-worker console output when a bug's root cause depends on it, rather than inferring and presenting the inference as fact.

## 9. Definition of done

A UI or extension task is not done until all of these hold:

- `npm run smoke` passes.
- The extension was reloaded, the test page hard-reloaded, and the change verified in a real browser — not merely reasoned about.
- The full path still works end to end: panel opens → start screen renders → objective chip selects → Record starts a real recording (mic prompt on first use) → timer and waveform respond to actual voice → screens-captured count increases → Pause/Resume → Stop & review → processing steps advance → variants render → Export → Start over.
- No regression in the microphone permission flow.
- Console is clean in all relevant contexts: side panel, page (content script), and service worker.
- Console errors, if any, are reported verbatim rather than summarised as "it works."

If something cannot be verified, say so plainly instead of declaring success.
