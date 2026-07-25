# Changelog

Versions track `extension/manifest.json`, which is what users see (hover the
`[ Persado ]` lockup in the panel header). `scripts/check-version.mjs` blocks a
commit that changes `extension/` or `gateway/` without a bump and an entry here.

Bump with `npm run bump` (patch), `npm run bump:minor`, `npm run bump:major`.

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
