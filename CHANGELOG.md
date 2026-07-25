# Changelog

Versions track `extension/manifest.json`, which is what users see (hover the
`[ Persado ]` lockup in the panel header). `scripts/check-version.mjs` blocks a
commit that changes `extension/` or `gateway/` without a bump and an entry here.

Bump with `npm run bump` (patch), `npm run bump:minor`, `npm run bump:major`.

---

## 0.6.10

Fix: recording screen could render blank while the header still said RECORDING.

Root cause — the active panel (`sh`), the header chip (`st`), and the
`.rec-live.on` toggle were set by ~10 independent call sites that could disagree.
`endRecordingUi()` in particular cleared `.on` while touching neither panel nor
header, so any call while the record panel was showing left a live RECORDING
header over an empty body.

- **`setUiState(state)` is now the single source of truth** for the active panel,
  header chip and `.on`/`#recRetry` toggle. States: ready, starting, recording,
  paused, micError, working, workingError, brief, results. `sh()` and `st()` are
  now private primitives only it may call; every former call site routes through
  it, so there are zero direct `sh(pnl…)` calls left.
- `endRecordingUi(next)` no longer clears `.on` by hand — it tears down the timer,
  wave and analyser, then transitions via `setUiState`, so it cannot leave the
  panel blank.
- `assertUiCoherent()` logs loudly (dev-time) if RECORDING shows without a mounted
  live recorder, if `.on` is set off the record panel, or if the record panel is
  ever blank.

Verified in a harness: recording → stale TRANSCRIPT_READY and recording →
TRANSCRIPT_ERROR both resolve coherently with no blank transient and no
incoherence logged; the former start-time desync (record panel + "Ready" header +
`.on`) is replaced by the coherent `starting` state.

---

## 0.6.9

Renamed "Persado Demo" to **Persado Capture**. The name refers to the project and
its artifact — the structured brief — not to the extension shell, which `VISION.md`
treats as disposable.

- `manifest.json`: name, toolbar tooltip, and a description that leads with
  capturing a structured brief rather than promising copy variants. The variants
  are downstream and, in this prototype, come from a stand-in model.
- Side panel title, file headers across `extension/src/`, `gateway/server.mjs`
  (including its startup log line), `scripts/smoke.mjs` and
  `scripts/check-version.mjs`.
- PDF export now reads "Persado Capture Brief" rather than "Persado Marketing
  Brief".
- `CLAUDE.md` §1 reframed around the brief as the durable artifact; `README.md`
  leads with the VISION.md one-liner and links it; `CONTRIBUTING.md` retitled.
- The user-visible lockup stays `[ Persado ]` per claude-design.md — the product
  name lives in the manifest, tooltip and document title, not as a new wordmark.
- `CONTENT_VERSION` 2 → 3. The `content.js` change was comment-only, but the
  version guard exists so nobody has to adjudicate that; bumping just re-injects.
- Deliberately unchanged: the `dev.loupe.gateway` launchd label, the `~/.loupe`
  paths, the root `package.json` name, and everything under `agent/` and the other
  inherited trees (CLAUDE.md §1).

---

## 0.6.8

Friction removed from the start, and the integration shown as plumbing.

- **One-click record.** Product line and objective now default to Retail Banking /
  Cross-sell and collapse into a "Context" disclosure that states the current
  selection, so the record button is the immediate action. Asking for two form
  fields before listening contradicted the reduce-friction argument the demo makes.
  Narration still overrides the selection.
- **Send to Persado Motivation AI** on the Brief view: shows a success state and
  the exact payload a real integration would receive, labelled "Not connected in
  this prototype". It never claims to have sent anything.

---

## 0.6.7

Demo-day reliability, and a completion line.

- **Demo mode** (`DEMO_MODE` in `extension/src/config.js`, **off by default**).
  When on, only the two network calls — transcribe and recommend — return canned
  responses after a realistic delay (2.2s / 3.2s). The microphone, waveform,
  screenshots, element extraction and coverage check all still run for real, so
  the part of the demo worth watching is not faked; a dead gateway or a hotel
  network just cannot end the presentation. A dashed amber "Demo mode" chip sits
  in the header whenever it is on.
- **Completion line** on the results screen: "Brief captured in {M:SS} · 1 click ·
  0 email threads", using the real recording duration. No invented benchmark
  figures — the click and thread counts are structural facts about the flow.

---

## 0.6.6

The captured brief becomes a first-class screen, with a coverage check.

- **Brief view** (`#panelBrief`) is the screen the flow lands on after generation:
  page URL, the extracted element (type, selector, current copy), product line,
  objective, count of other extracted elements, the narration verbatim, screenshot
  thumbnails, and capture duration. Every field is read from the payload the
  gateway actually received, so the screen cannot disagree with what was sent.
- **Copy brief as JSON** copies that payload. Images are summarised (length +
  prefix) since base64 is not readable, everything else is byte-identical.
- **Brief coverage** — a four-item check for the element, audience, objective and
  desired outcome. Deterministic keyword/heuristic pass over the transcript,
  matched against the extracted element text; no LLM call, no new endpoint, no
  second provider. Returns null when the narration is too short to judge, and the
  component hides itself rather than showing four unearned ticks
  (claude-design.md §7). Never blocks generation.
- Missing items carry a one-tap **Add**: type the missing piece (appended to the
  narration and re-evaluated against the real text) or re-record into the same
  brief.
- Results remain reachable via **See variants**, and gain a **Brief** button back,
  so neither screen is a dead end.

---

## 0.6.5

Variant cards: the fake score becomes the integration argument, and the grounding
becomes visible.

- `predictedLift` is no longer displayed as a number. Each card carries an
  explicitly empty slot — "Motivation AI score — not connected" — styled muted
  with a dashed border. The gateway still returns the field; the response contract
  is unchanged. Presenting a general-purpose model's guess as a score was the
  weakest claim in the demo; as an empty seam it is the strongest.
- Cards now read **current → proposed**: the extracted on-page copy appears above
  the rewrite, struck through, so the grounding is visible rather than asserted.
  Omitted entirely when no element was extracted.
- Compliance badges drop their emoji for "Compliance: clear" / "Compliance: <note>"
  per claude-design.md §6.
- The variant card header loses the last purple gradient on this screen.
- The exact payload POSTed to /v1/ai/recommend is retained in `briefPayload`, so
  what is shown is what was sent.

---

## 0.6.4

Demo build for the CPO/CEO presentation. The audience is Persado, so the UI stops
selling Persado to a bank.

- Removed the start-screen footer stat ("40% average engagement lift — Persado
  Motivation AI outperforms human copy 96% of the time") and its CSS.
- The scoring step is now "Scoring — Motivation AI (not connected)" and renders
  SKIPPED unconditionally. Nothing scored the variants, so the step can never
  report Done.
- Removed the remaining emoji from the UI: the Export PDF button and the results
  "Predicted Lift" header pill.

---

## 0.6.3

Gateway environment variables rebranded to `PERSADO_*`, with the inherited
`LOUPE_*` names retained as a fallback.

- `PERSADO_MODEL_PREMIUM`, `PERSADO_MODEL_STANDARD`, `PERSADO_MODEL_ALLOWED`,
  `PERSADO_GATEWAY_PORT`, `PERSADO_GATEWAY_HOST`, `PERSADO_GATEWAY_FFMPEG` are the
  primary names. Each falls back to its `LOUPE_*` counterpart, so an existing
  shell profile or `~/.loupe/gateway.env` keeps working untouched.
- Precedence lives in one helper rather than being repeated per variable:
  `PERSADO_*` → `LOUPE_*` → default.
- Default port (8787) and host (127.0.0.1) unchanged.
- `gateway/server.mjs` header retitled and documents both name sets, marking
  `LOUPE_*` deprecated-but-supported.
- `gateway/install-launchd.sh` prose rebranded and its generated env template now
  lists the `PERSADO_*` names. The `dev.loupe.gateway` launchd label and the
  `~/.loupe` paths are deliberately unchanged — the label identifies an agent that
  may already be installed, and changing it would orphan the old plist and risk
  two gateways contending for 8787.

---

## 0.6.2

A failed transcription no longer costs the user their recording, and a stopped
gateway now says so in plain language.

### The recording is never lost

- The recorded audio is retained in `chrome.storage.session` the moment it arrives
  and BEFORE transcription is attempted, so it survives the failure, a panel
  close, and service-worker eviction. It never touches disk — the start screen
  promises audio stays on the device until results are reviewed.
- Exactly one pending recording is kept. It is cleared on successful
  transcription and on **Start over**, and never automatically otherwise.
- **Try again** re-runs only transcription against the retained audio
  (`RETRY_TRANSCRIBE`). It does not re-record and does not discard.
- Reopening the panel with an unsent brief offers "You have an unsent brief from
  {time}" with Try again / Save audio / Discard. Discarding is explicit.
- **Save audio** downloads the raw `.webm` so a narration is never trapped, and is
  offered automatically when a recording is too large to retain rather than
  silently dropping it.

### Failures explain themselves

- `GET /health` preflight (2s) before transcription, so a stopped service is
  reported as stopped rather than as a transport error mid-upload.
- Typed failures replace raw strings. `gateway_unreachable` →
  "Can't reach the Persado service on this machine (URL). Start it with
  `npm run gateway`, then Try again." `gateway_timeout` → "The service didn't
  respond in time." `gateway_error` → the gateway's own message (quota, API key).
  A raw `TypeError: Failed to fetch` can no longer reach a user.
- AbortController timeouts on both gateway calls (2s health, 60s
  transcribe/recommend), so a hung service surfaces a message instead of spinning.
- Optional "service offline" hint on the start screen, so the user finds out
  before narrating for a minute.

### Smoke test

- Fails if the gateway base URL appears anywhere under `extension/` other than
  `src/config.js`, if it targets `localhost` instead of `127.0.0.1`, or if the
  local `host_permissions` entries are missing.
- Fails on endpoint drift: every path in `ENDPOINTS` must have a matching route in
  `gateway/server.mjs`, and vice versa — the same guard as the storage-key check.

---

## 0.6.1

Gateway connectivity: one URL, explicit bind, and visible requests.

- `extension/src/config.js` is now the ONLY place the gateway URL is written. It
  was hardcoded in three files (`sidepanel.js`, `background.js`, and the dead
  popup), which is how a host or port change becomes an unexplainable
  "Failed to fetch".
- The extension targets `http://127.0.0.1:8787` rather than `localhost`, and the
  gateway binds `127.0.0.1` explicitly (`PERSADO_GATEWAY_HOST`, formerly
  `LOUPE_GATEWAY_HOST`, overrides). Previously
  `server.listen(PORT)` bound every interface while the client used `localhost`,
  so an IPv6/IPv4 mismatch would look identical to the service being down.
- `host_permissions` lists `http://127.0.0.1:8787/*` and `http://localhost:8787/*`
  explicitly instead of relying on the broad `<all_urls>` pattern.
- The worker logs the resolved gateway URL once at startup.
- The gateway logs every request as `METHOD path → status duration`, so "did the
  request arrive" is answerable at a glance.
- Deleted `extension/popup/` — dead code with no `default_popup` in the manifest
  and no handler anywhere for its `START_RECORDING_ONCE` / `STOP_AND_TRANSCRIBE`
  messages. Its stale prefix is removed from `scripts/repo-check.mjs`.

---

## 0.6.0

Brand realignment, three screens rebuilt, page grounding, and the record-button fix.
This release covers work that was mistakenly committed while the manifest still
read 0.5.0 — the version gate added here exists so that cannot recur.

### Brand and icon

- `claude-design.md` added as the design source of truth.
- Toolbar mark replaced: uppercase `P` in ink `#1A1128` enclosed in true red
  brackets `#DC2828`, authored as `extension/public/icon.svg` and generated at
  16/32/48/128/512 plus a dimmed set by `scripts/make-icons.mjs`. Laid out on a
  16-unit integer grid so every export is pixel-crisp at real toolbar size.
- Toolbar state system: Ready / Recording (red) / Working (amber) / Results (green
  with variant count) / Disabled (dimmed icon on unsupported pages). The mark
  never changes colour; state lives in the badge. Recording uses a steady red dot
  rather than a pulse — an MV3 worker is evicted mid-recording and would freeze
  the animation on an arbitrary frame.
- Purple → magenta gradient retired from the header and all rebuilt screens.

### Start screen (1a)

- White header with the bracketed lockup and a green `READY` chip; version strip
  and `DEMO` tag removed.
- "Record your brief" heading, read-only `CAPTURING` chip showing host + first
  path segment, full-width product line.
- Objective is now a single-select chip group — Cross-sell (default), Acquisition,
  Engagement, Conversion, Retention. `Conversion` added, `Trust & Compliance`
  removed; the gateway's objective labels track it.
- Ink-filled record button pinned to the bottom by flex layout, privacy note, and
  the approved footer stat.

### Recording screen (1b)

- 40px tabular-mono timer, live waveform driven by real microphone amplitude, grey
  listening line, flexing live transcript with a red caret and scroll-aware
  auto-follow, captured-screens strip, and a pinned Pause / Stop & review row.
- Waveform architecture: `content.js` owns the stream, reduces each analyser frame
  to 20 band magnitudes and posts `AUDIO_LEVELS` at ~16/sec (measured 15/sec from
  a 60fps loop); the panel keeps a 40-column ring buffer and eases between frames.
- Pause/resume built end to end — same `MediaRecorder`, so audio, transcript and
  captured screens all carry over.
- Screenshot cadence: start frame, then every ~25s while recording, suspended
  while paused, capped at 6 frames with the start frame never evicted.

### Processing screen (1c)

- Five-step checklist driven by real events, replacing a spinner and three
  hardcoded strings on a timer. Compliance and scoring are fields of the single
  `/v1/ai/recommend` response, so they stay Pending until it parses and are marked
  Skipped if the fields are absent. Progress never reaches 100% before the response.
- Dynamic subtitle with the real recording duration and screen count; pinned
  "Your brief" card summarising narration · page · product line.
- Failed stages render a reason with Try again / Start over, plus a 90s timeout.
- Cited regulations now derive from the product line (Reg DD for deposit lines,
  Reg Z for credit) in both the UI label and the gateway prompt.

### Page grounding

- Screenshots and extracted on-page copy are captured silently and sent with the
  brief, so variants rewrite the page's actual copy instead of inventing it.
- Gateway `/v1/ai/recommend` accepts `images[]` (chronological frames, capped at
  4) alongside the legacy single `screenshot`, and routes any image to the
  vision-capable premium tier.

### Record-button fix

- `beginRecording()` discarded the `sendMessage` response. `chrome.tabs.sendMessage`
  *resolves* with `{ok:false}` when `getUserMedia` fails, so the panel entered a
  full recording UI over a dead recorder. It now requires `ok:true` **and** an
  explicit `RECORDING_STARTED` confirmation within 3s.
- `startRecording()` no longer reports `{ok:true}` when a recorder already exists.
- `content.js` is a single IIFE with all state on one object — re-injection can no
  longer throw `Identifier 'mediaRecorder' has already been declared`. It removes
  a previous build's listener and tears down its recorder.
- PING/version handshake: the panel refuses to drive a content script whose
  `CONTENT_VERSION` does not match, and injects a fresh copy instead.
- `resetAll()` stops a live page recorder instead of abandoning it.

### Guardrails

- `extension/src/messages.js` — single source of truth for message types, storage
  keys and page-context field names, shared by all three contexts.
- `extension/src/boot.js` — installs error handlers and a red fatal banner before
  the module loads, so a top-level throw looks broken instead of leaving silently
  dead buttons.
- `npm run smoke` — static checks on ids, message contracts, context fields,
  storage keys, permissions, assets, injection safety and the content-script
  version stamp. Verified against 13 seeded regressions.
- `npm run version:check` — blocks shipped changes with no version bump.
- `.githooks/pre-commit` runs both. Enable with
  `git config core.hooksPath .githooks`.
- `docs/REGRESSION.md` — manual end-to-end checklist, required before any UI task
  is declared done.

---

## 0.5.0 and earlier

See `git log`. Prior versions predate this changelog.
