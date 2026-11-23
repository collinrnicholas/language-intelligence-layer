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
- [ ] Gateway running (recorded briefs only): `OPENAI_API_KEY=… npm run gateway` → `127.0.0.1:8788/health` returns ok
- [ ] `npm run smoke` passes; `npm --workspace extension test` passes
- [ ] A Persado developer key is saved in Settings (live sections 8–11). For Mailchimp, a
      **test** account with at least one draft campaign — never a production audience

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
- [ ] "Writing variants" is a Persado optimize run (usage bar drops by 5 est.); the score
      and compliance steps tick only if Persado returned those fields

## 5 — Results and reset

- [ ] Variants render with copy, Persado score (when returned) and Persado's compliance
      result — no lift figure, no sample score anywhere
- [ ] **Export PDF** opens the print view with the brief and variants
- [ ] **New brief** returns to the start screen, toolbar badge clears to Ready
- [ ] Start a second recording immediately after — it must work (no stale recorder)

## 6 — Grounding actually happened (easy to fake, so check it)

- [ ] Panel console: `[persado] grounding →` names the page's ACTUAL current copy
- [ ] Service-worker Network: the `POST /v1/optimize` body's `variant` is that copy and
      `context` carries the narration — and no request goes to the gateway's
      `/v1/ai/recommend`
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

## 8 — Persado connection and usage (live)

- [ ] Settings → paste a wrong key → Save key: "Persado rejected the API key"; usage bar
      dot red. Paste the real key → "Connected to Persado … this check used no runs"
- [ ] Key field is empty after saving; the key never appears in the panel, the page, the
      service-worker console, or Settings
- [ ] Usage bar: `Persado API · Connected` and `N / 100 runs left · est.`; Settings shows
      Remaining (est.), Consumed, Requests, Score/Optimize runs, Last success
- [ ] Refresh usage → service-worker Network shows only `GET /v1/catalogue` (no paid run)

## 9 — Website scoring and optimization (live)

- [ ] Open a real marketing page → scan lists CTAs/headlines (local check, labelled)
- [ ] **Score** → "Scored by Persado", a real Persado score and compliance tag, the job id;
      usage −1
- [ ] **Optimize** → original with Persado's control score, rank-1 alternative with its
      score, "N more from Persado"; usage −5
- [ ] **Preview on page** swaps the text on the page (dashed red outline); **Restore
      original** puts it back; reload restores it too
- [ ] Remove the key → Score: plain "No Persado API key is saved" and Settings opens

## 10 — Mailchimp (live, TEST account)

- [ ] Settings → Mailchimp key → Save and test: "Connected to <account> (usNN)"
- [ ] Open `*.admin.mailchimp.com`: panel switches to **Mailchimp drafts**; the open
      campaign is marked "open in editor"
- [ ] Optimize draft: steps advance Reading → Optimizing → Updating → Verifying; result
      shows original → optimized per field and "verified in Mailchimp"; usage −5
- [ ] In Mailchimp, reload the campaign: subject line / preview text (and body, for a
      custom-HTML campaign) show the new copy; links, merge tags, footer unchanged
- [ ] A drag-and-drop campaign: body is listed as not sent ("builder … write-back is off")
- [ ] Optimize again with no edits → "already optimized" and no second Persado run
- [ ] **Send test** → test e-mail arrives at the Settings address; nothing else is sent
- [ ] **Revert to original** → reload in Mailchimp shows the original copy
- [ ] Disconnect → key removed; panel says "Connect your Mailchimp account"

## 11 — Mailchimp overlay

- [ ] On a campaign page, a small `[P] Persado · Connected / Campaign optimization
      available` pill sits bottom-left and covers none of Mailchimp's controls
- [ ] Click → card with Optimize draft, steps, result, Revert, collapsible Activity
      (job id, original vs optimized, errors). × hides it for the page
- [ ] Editing in Mailchimp during a run → the write is refused ("edited … nothing was
      written")
- [ ] Not a campaign page → no pill. Not connected → pill says what to set up

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
8 persado + usage    ✓
9 web score/optimize ✓
10 mailchimp         ✓
11 overlay           ✓
```

---

**This checklist must be run and its result reported before any extension UI task
is declared done.** `npm run smoke` is necessary but not sufficient — it cannot
see a mic prompt, a stale content script, or an off-screen button.
