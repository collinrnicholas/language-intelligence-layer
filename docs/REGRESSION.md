# Extension regression checklist

Run this end to end after **any** change under `extension/`, and paste the result
(one line per step) into the task report. `npm run smoke` catches contract drift
statically; this catches everything it cannot see.

Three regressions have shipped from skipping it: a silent no-op record button, a
vision path that quietly sent no image, and an action row pushed off-screen.

## 0 — Reload BOTH (do not skip)

- [ ] `chrome://extensions` → **Reload** the extension
- [ ] **Hard-reload the test page** (⇧⌘R) — an already-open tab keeps running the
      PREVIOUS build's content script. This is the known failure mode; the
      PING/version handshake now detects it, but test the real path anyway.
- [ ] Gateway running: `OPENAI_API_KEY=… node gateway/server.mjs` → `/health` returns ok
- [ ] `npm run smoke` passes

## 1 — Panel and start screen (1a)

- [ ] Toolbar shows the bracketed `[P]`, legible at 16px, no badge (Ready)
- [ ] Panel opens; **no red error banner**
- [ ] Header: white, `[ Persado ]` lockup left, green `READY` right
- [ ] `CAPTURING` chip shows the real host + first path segment, red square present
- [ ] Product line select works; five objective chips, **Cross-sell** selected in red
- [ ] Selecting another chip moves the red outline (only one selected)
- [ ] Record button is ink-filled with a red dot, pinned to the bottom; privacy note
      and the `40%` stat below it

## 2 — Recording (1b)

- [ ] Click **Record marketing brief** → mic prompt appears (first use on that origin)
- [ ] Grant it: header chip turns red `RECORDING`, toolbar badge red
- [ ] Timer counts up from `00:00` in tabular mono
- [ ] **Speak** — the waveform bars react; **go silent** — they fall to a thin
      baseline, never a flat dead line
- [ ] Live transcript accumulates with a blinking red caret
- [ ] Scroll the transcript up mid-speech: it stops auto-scrolling. Scroll back to
      the bottom: it resumes
- [ ] `SCREENS CAPTURED` starts at 1 and **increases** (~every 25s); newest
      thumbnail carries the red border
- [ ] Nothing covers the page; no new tab or window opened at any point

## 3 — Pause / Resume

- [ ] **Pause**: timer halts, waveform freezes and dims, chip reads amber `PAUSED`,
      status line reads "Paused — nothing is being recorded."
- [ ] Screen count does **not** grow while paused
- [ ] **Resume**: same session continues — timer picks up (does not reset to 00:00),
      transcript and thumbnails intact
- [ ] Speak after resuming and confirm the transcript keeps growing from where it was

## 4 — Processing (1c)

- [ ] **Stop & review** → processing screen appears immediately, step 1 Active
- [ ] Subtitle shows the **real** duration and screen count from the session
- [ ] Steps tick in order; **steps 4 and 5 stay Pending until variants arrive**
- [ ] Progress bar never reaches 100% before the response
- [ ] Step 3 label names the objective chip you selected
- [ ] Compliance step cites Reg DD for retail/business/wealth, Reg Z for cards/mortgage
- [ ] `YOUR BRIEF` card shows a real summary · page · product line
- [ ] Toolbar badge amber during, green with the variant count after

## 5 — Results and reset

- [ ] Variants render with copy, rationale, compliance badge and lift estimate
- [ ] **Export PDF** opens the print view with the brief and variants
- [ ] **New brief** returns to the start screen, toolbar badge clears to Ready
- [ ] Start a second recording immediately after — it must work (no stale recorder)

## 6 — Grounding actually happened (easy to fake, so check it)

- [ ] Panel console: `[persado] grounding →` shows `framesCaptured` > 0 and
      `imagesSent` > 0
- [ ] Gateway log: `recommend → gpt-4o (vision, N images)` — **not** `text-only`
- [ ] `element` in the request is the page's ACTUAL current copy
- [ ] Variants read as rewrites of that real copy, not invented marketing lines

## 7 — Failure paths

- [ ] Deny the mic → retry state with a specific message, **not** a fake recording session
- [ ] Reload the extension, do NOT reload the page, click Record → works, or shows a
      clear retry state. Never a silent no-op
- [ ] Click Record twice quickly → no duplicate recorder, no
      "Identifier 'mediaRecorder' has already been declared" in the page console
- [ ] Stop the gateway, then Stop & review → the failed step shows a reason with
      **Try again** / **Start over**; downstream steps stay Pending
- [ ] Open the panel on a `chrome://` page → toolbar icon dims, tooltip reads
      "not available on this page"
- [ ] Page console is clean of uncaught errors; panel console likewise

## Result template

```
0 reload both        ✓
1 start screen       ✓
2 recording          ✓
3 pause/resume       ✓
4 processing         ✓
5 results/reset      ✓
6 grounding          ✓  frames=4 imagesSent=4 model=gpt-4o(vision)
7 failure paths      ✓
```

---

**This checklist must be run and its result reported before any extension UI task
is declared done.** `npm run smoke` is necessary but not sufficient — it cannot
see a mic prompt, a stale content script, or an off-screen button.
