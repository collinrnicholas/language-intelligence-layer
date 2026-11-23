# Persado Autopilot — architecture

Persado Autopilot runs Persado inside the tools marketers already use. This repo's
Chrome extension is the first surface and the development environment for it. It
scores and optimizes copy on any web page, and it optimizes Mailchimp draft
campaigns in place.

Status: working prototype, version 0.9.1. Read "Verification status" before you rely
on any live behaviour.

---

## 1. Layers

```
 Extension UI ─────────────────────────────────────────────────────────────
   sidepanel.html/.js   usage bar · page scan · Persado result · Mailchimp drafts · Settings
   src/mc-overlay.js    status pill + activity view on *.admin.mailchimp.com
        │  chrome.runtime messages (MSG.* in src/messages.js). Copy in, results out, never a key
        ▼
 Service worker (src/background.js) ──────────────────────────── only reader of keys
   ├─ Persado service      src/persado-api.js   auth · score · optimize · job polling · errors
   ├─ Usage tracking       src/usage.js         per-key ledger, estimate vs. authoritative
   ├─ Activity tracking    src/activity.js      runs, writes, verifies, reverts (ring buffer)
   ├─ Content safeguards   src/guard.js         eligibility · protected tokens · HTML blocks
   ├─ Optimizer            src/optimizer.js     platform-neutral read → optimize → validate → write → verify
   └─ Platform adapters    src/adapters/mailchimp.js   (next: gohighlevel.js, textedly.js …)
        │ HTTPS, straight from the worker (manifest host_permissions)
        ▼
   api.persado.com/api          <dc>.api.mailchimp.com/3.0
```

Each layer owns one job:

| Layer | Owns | Never does |
|---|---|---|
| Platform adapter | Reading a draft from its platform, choosing eligible fields, writing results back, verifying them, restoring a snapshot, sending a platform-native test | Calling Persado, or deciding whether a rewrite is safe |
| Persado service | Building and validating requests, Bearer auth, retries, job polling, normalising results, typed errors | Knowing about any platform |
| Content safeguards | What may be sent, and whether a rewrite may be written | Network I/O |
| Activity tracking | An audit record of every run and write, with real ids | Storing credentials |
| Extension UI | Status, controls, results, credit consumption | Reading keys, calling Persado or Mailchimp |

To add a platform, write one file shaped like `adapters/mailchimp.js`. It exposes
`{ id, label, channel, read, write, verify, restore, sendTest }` and its `read()`
returns `{ ref, fields:[{field, touchpoint, text, maxLength, location}], skipped, fingerprint }`.
`optimizer.optimizeDraft()` stays as it is. An SMS tool such as Textedly would use
channel `SMS_EMS` with touchpoint `text`. A GoHighLevel e-mail would reuse
`EMAIL_SUBJECT_BODY`.

## 2. Persado API — what is used and where it comes from

Every request shape, path, header and response field comes from Persado's own
published client, [`persado/martechapi-cli`](https://github.com/persado/martechapi-cli)
(`src/pkg/api/{client,endpoints,models,validate}.go`). Nothing in this list is
guessed.

| Call | Use |
|---|---|
| `GET /v1/catalogue` | Connection test. It validates the key and starts no run, so it costs nothing. |
| `POST /v1/score?wait=50` | Score on a page. Sends one variant of the selected line, channel `WEB_PAGE`. |
| `POST /v1/optimize?wait=50` | Optimize on a page (`WEB_PAGE`), and Mailchimp drafts (`EMAIL_SUBJECT_BODY`, one run per draft). |
| `GET /v1/jobs/{id}` | Polled every 2 s until the job is `completed` or `failed`. |

- **Auth:** `Authorization: Bearer <key>`.
- **Errors:** errors arrive as `{ error: { code, message, requestId, details, categories, retryAfterSeconds } }`.
  - `429 rate_limited` and `503` are retried up to 3 times, honouring `Retry-After`.
  - `429 quota_exhausted` is not retried.
  - `401`/`403` means the key is invalid.
  - `categories` means the API found personal data.
- **Displayed results:** `control`, `variants[]` and `alternatives[]` (ranked), each
  with `performance`, `performanceBand`, `brandAlignment`, `compliance {risk, state,
  summary, issues}` and `emotions`. Only fields that are present are shown. The job
  id and `X-Request-Id` are shown and logged.

### Usage and credits

- **Balance:** Persado's API documents **no balance or usage endpoint**. The developer
  portal (`api.persado.com/api/developers`) publishes `run-quota 100` and
  `optimize-cost 5`. It publishes no score cost.
- **Estimate:** the extension therefore keeps a local, per-key ledger:
  - optimize counts as 5 runs (portal value)
  - score counts as 1 run (an assumption, and labelled as one)
  - remaining = 100 − counted runs

  Every screen that shows it says it is an estimate.
- **Authoritative override:** a `429 quota_exhausted` from Persado sets remaining
  to 0, and that figure is shown as Persado's.
- **Server headers:** if Persado ever returns quota-like response headers, they are
  shown verbatim.
- **No paid polling:** Refresh uses the free catalogue call. Nothing polls in the
  background.
- **Not counted:** runs made outside this browser with the same key.

## 3. Mailchimp — what the API can and cannot automate

Endpoints used: `GET /ping`, `GET /`, `GET /campaigns?status=save`,
`GET /campaigns/{id}`, `GET|PUT /campaigns/{id}/content`, `PATCH /campaigns/{id}`,
`POST /campaigns/{id}/actions/test`. Auth is HTTP Basic, with the API key as the
password. The data centre comes from the key suffix (`-us21`) or from Settings.

- **No pre-send interception.** The Marketing API has no hook that fires before a
  campaign is sent or when a draft is saved. Zero-click optimization cannot be done
  by intercepting a send, so milestone 1 uses an explicit **Optimize draft** action.
  After that one click, everything runs without per-suggestion approval: read,
  optimize, validate, write back, verify.
- **Background optimization (not built).** A safe future design is a scheduled or
  on-open job that optimizes drafts once, marked by the snapshot fingerprint. It
  needs a server (an MV3 worker cannot run unattended), OAuth instead of a pasted
  key, and a rule for when a draft is "done enough" to optimize.
- **Drafts only.** Only `status: "save"` regular campaigns are read or written. This
  code never calls `/actions/send`, schedules anything, or touches audiences.
  **Send test** uses Mailchimp's own test send to the addresses in Settings.
- **Builder campaigns.** `PUT /content {html}` stores custom HTML. On a campaign
  built with the drag-and-drop or new builder, that can turn it into a
  code-your-own campaign. For those campaigns, body write-back is **off by default**:
  only the subject line and preview text change. Settings has an explicit opt-in.
- **Editor autosave.** The Mailchimp editor can save its in-memory copy over an API
  write. The overlay asks you to save before optimizing and to reload after. A
  fingerprint check aborts the write if the draft changed during the run.

### What is sent and written

- **Fields:** at most one value per Persado touchpoint: `subject_line`, `preheader`
  (preview text), `headline`, `subheadline`, `body`, `cta`. Each value is the plain
  text of one HTML block whose content is only text.
- **Never sent:** the full HTML, recipient data, footer, unsubscribe or legal copy, or
  anything locked.
- **Validation before writing:** each rewrite must keep every merge tag, template
  variable, URL and e-mail address exactly. It may not add a figure, add markup, or
  exceed a length limit. A field that fails keeps its original. If no field passes,
  nothing is written.
- **Write order:**
  1. Save a snapshot of the original.
  2. PATCH settings.
  3. PUT content. If the PUT fails, the settings PATCH is rolled back.
  4. Re-read the draft and confirm each change.
- **Revert:** restores the snapshot. An already-optimized, unchanged draft is not
  re-run, which would waste 5 runs, unless you choose "Run again anyway".
- **Locking copy:** authors can lock copy with `data-persado-lock`, with
  `<!-- persado:lock --> … <!-- /persado:lock -->`, or with footer regions
  (`mc:edit="footer"`, `templateFooter`, `.mcnFooter*`).

## 4. Credentials

- **Storage:** both keys are in `chrome.storage.local` in this browser profile only.
  They are not synced, not exported and not logged.
- **Who reads them:** only the service worker reads them, and only it calls Persado
  or Mailchimp, directly over HTTPS. The local gateway never sees either key.
  `npm run smoke` fails if a page context or the panel references a credential key
  or calls either API.
- **Overlay limits:** the Mailchimp overlay can only ask for status, optimize and
  revert, and only from `*.admin.mailchimp.com`. It runs in a closed shadow root.
- **Trade-off:** a key in browser storage can be read by anyone with access to this
  Chrome profile, or by a compromised extension build. That is acceptable for an
  internal prototype using test accounts. A public version should move both keys to
  a backend proxy and replace the Mailchimp key with OAuth. The adapter takes its
  credential as one constructor argument, so that change is local.

## 5. Experiment and feedback loop (metadata only)

The activity log records the following for every run, so future outcome tracking can
join platform results to Persado output:

- platform, campaign id and `web_id`, field
- original and optimized text
- Persado `jobId`, `X-Request-Id`, chosen rank and performance
- timestamp, status
- source (`live` or a labelled `demo` fixture)

No experiment ids are invented.

To close the loop for Mailchimp later:

1. After send, read `GET /reports/{campaign_id}` (opens, clicks) for campaigns in
   the log.
2. Join on campaign id.
3. Send outcomes to Persado if and when Persado publishes an endpoint for it. None
   exists in the published spec today.

A/B testing original against optimized would use Mailchimp's variate campaigns
(`variate_settings`, `variate_contents`). This adapter refuses variate campaigns
today.

## 6. Verification status

**Verified:**
- 31 unit and integration tests (`npm --workspace extension test`) against fakes with
  the documented Persado and Mailchimp shapes. One of them drives the real
  `background.js` in a simulated `chrome.*`.
- A browser run: the unpacked extension loaded in Chromium, with both APIs replaced
  by route mocks. It covered key rejection and acceptance, score, optimize,
  preview and restore on a page, Mailchimp connect, overlay optimize, write-back,
  verify, the duplicate guard, test send, revert, and usage counts.

**Not yet verified against the live services:**
- Neither the Persado production API nor a real Mailchimp account has been called.
  The development environment's network blocks both hosts.
- Treat these as unconfirmed until a live run:
  - field values Persado actually returns (for example compliance `risk`/`state`
    enums and `performanceBand` labels)
  - whether Mailchimp normalises HTML on PUT
  - the builder-campaign conversion behaviour

`docs/REGRESSION.md` §8–§11 is the live checklist.
