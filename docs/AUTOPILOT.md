# Persado Autopilot — native Mailchimp integration

Version 0.10.1. The existing extension remains the UI; no standalone editor is added.

## Architecture

`sidepanel.html` / `sidepanel.js` → runtime messages → `src/background.js` → authenticated loopback `POST /v1/integrations` → `gateway/integrations.mjs`.

The gateway reuses `extension/src/persado-api.js`, `guard.js`, `usage.js`, and `adapters/mailchimp.js` in an isolated Node VM. The worker no longer loads provider clients or reads provider keys. The legacy optimizer remains covered by regression tests but is not invoked by the current UI or proxy. The Mailchimp content script is a quiet change observer; paid actions and writes are restricted to extension pages.

Public website scanning, scoring, optimization, preview, recording, and transcription keep their existing UI. Website scoring and optimization also use the authenticated gateway. No live-mode fixture responses exist in this route.

## Setup and loading

Inject secrets from Keydeck, scoped to this project (do not print values or export them into source):

```sh
cd /Users/test/dev/Persado
lokalite run --project language-intelligence-layer --keys MAILCHIMP_API_KEY,PERSADO_API_KEY,PERSADO_PROXY_TOKEN -- npm run gateway
```

`PERSADO_PROXY_TOKEN` must be a random value of at least 32 characters. It grants access to local paid operations, so treat it as a local capability. `MAILCHIMP_SERVER_PREFIX` optionally overrides the key suffix. `.env.example` documents placeholder names; a local `.env` is also supported and ignored. No shared provider key is embedded in the extension. Preserve the existing OPENAI_API_KEY environment when restarting if narrated-brief transcription is needed. The integration-only verification process did not test audio transcription.

1. If an older gateway already owns port 8788, stop/restart that exact gateway yourself before starting the updated one. Do not terminate unrelated processes.
2. Run `npm run build` or `npm --workspace extension run build`.
3. In Chrome, open `chrome://extensions`, enable Developer mode, and load `/Users/test/dev/Persado/extension/dist/unpacked` (or reload the existing unpacked extension).
4. Open the Persado side panel → Settings. Enter only the local gateway pairing token, then **Pair gateway**. Set your brand and industry. Use **Test Mailchimp connection**.
5. Hard-reload the Mailchimp page after reloading the extension; existing content scripts otherwise remain stale.
6. Open a regular draft URL such as `https://us5.admin.mailchimp.com/campaigns/show/?id=<web_id>`. The subject, preview and eligible body blocks should appear automatically.
7. Choose Score (configured estimate: 1 credit) or Optimize (5 credits) independently. Compare current and alternative copy. Apply saves only that selected field and reads it back. Refresh Mailchimp to observe persistence. Undo restores the previous field if no later edit conflicts.

Successful connection tests remove the corresponding legacy provider key from browser storage. Until tested, any old stored key remains a local security risk. Provider credentials should be rotated if they were ever exposed; removing a key from HEAD does not remove it from history.

## API contracts and limits

Verified against [Persado's official client](https://github.com/persado/martechapi-cli/tree/develop/src/pkg/api): Bearer authentication, `POST /v1/score?wait=50`, `POST /v1/optimize?wait=50`, `GET /v1/jobs/{id}`, and free `GET /v1/catalogue`. Requests use `account.name`, channel `EMAIL_SUBJECT_BODY` or `WEB_PAGE`, and documented touchpoint keys. `performance` is displayed only when returned. An absent revised score stays absent; scores are not measured financial ROI.

Verified against Mailchimp's official [campaign schema](https://mailchimp.com/developer/marketing/api/campaigns/list/), [settings PATCH](https://mailchimp.com/developer/marketing/api/campaigns/update/), and [content GET](https://mailchimp.com/developer/marketing/api/campaigns/get-content/). URL `id` is a web application `web_id`, not the API campaign ID. Matching paginates drafts, rejects ambiguous results and checks the ID pair before operations. Missing/unsupported routes require explicit selection; no newest-draft fallback exists.

Only regular campaigns with `status: save` may be read for optimization or updated. Scheduled, sending, sent, variate and automation campaigns are refused. The service patches **only** `settings.subject_line` or **only** `settings.preview_text`; unrelated settings are not resubmitted. Status and the expected field are re-read immediately before PATCH, then the saved value is read back. Mailchimp does not provide an atomic compare-and-swap contract here: a concurrent editor autosave or status transition between the preflight and PATCH remains a race. Refresh the Mailchimp editor after Apply to prevent its stale in-memory text from overwriting the API result.

Body copy is extracted conservatively as plain-text blocks. Nested markup, locked/footer/legal regions and undecodable entities are excluded. Eligible CTA labels are recognized by the existing parser. Body scoring and optimization are available, but **Body Apply is always disabled**, including custom HTML campaigns. No content PUT or email-send operation is reachable through the proxy. The existing adapter's legacy body/test-send methods are retained only for compatibility and regression tests.

## Credits, caching and undo

No documented Persado account-balance endpoint was found. The UI shows **balance unavailable**, plus gateway-tracked usage and response usage headers when available. Costs are configured estimates: Score 1, Optimize 5. The portal's 100-run allowance is internal ledger metadata, never presented as a verified current balance. A real `quota_exhausted` response blocks further paid requests.

The gateway stores result cache, accepted-job markers, credit ledger and field undo receipts in ignored `gateway/.integration-state.json`, written atomically with mode 0600. This file contains campaign copy and must stay private. Cache keys include provider/account identity, request brand/industry, channel, operation, touchpoint, text and limits. Unchanged scoring is cached across panel closes, worker eviction and gateway restarts. Concurrent identical requests share one job. Failed/uncertain accepted requests retain a marker rather than silently spending credits again; investigate the stored job ID with Persado before manually recovering state. Do not delete the ledger to retry uncertain jobs.

Optimize never writes. Apply uses the chosen server-cached alternative and validates merge tags, links, numbers, markup and length again. Results must have been reviewed for the target campaign. A single gateway process serializes campaign writes; duplicate Apply returns the existing verified receipt. Undo changes only the affected field and refuses to overwrite a later edit. Undo receipts are saved before PATCH, including when save verification fails. Run only one gateway process for a given state file.

Automatic scoring/optimization is off. The explicit paid-operation boundary is the place for future opt-in budgets; no unattended credit consumption occurs now. Public OAuth should replace the environment key through the adapter credential boundary; the local proxy is an internal proof of concept, not a multi-tenant service.

## Security

The integration route requires a pairing token, a loopback peer and Host, JSON POST, and rejects ordinary web origins. Optional `PERSADO_EXTENSION_IDS` restricts browser extension origins. No permissive CORS headers are added. There is no arbitrary URL/method forwarding or provider-key response. Provider errors redact configured keys; campaign content and keys are not logged. Existing transcription/model routes retain their prior behavior; this authentication boundary covers the integration route.

`.env*` and runtime state are ignored; `.env.example` contains placeholders only. The public Git history was scanned for common provider-key patterns (112 commits) with no matches. That pattern scan is not proof that every possible secret format is absent.

## Verification status

Verified on November 24, 2026:

- `npm run smoke`, `npm run lint` (typecheck), `npm run build`, `npm run repo:check`, `npm run version:check`, and `git diff --check` passed. `npm test`: 118 agent tests plus 55 extension tests passed. A broken local TypeScript executable link was repaired with `npm rebuild typescript`; no application source workaround was added.
- Real Mailchimp `/ping`, account metadata, draft list, draft settings and content reads succeeded using Keydeck credentials. The draft API ID `6e04c9077b` matched URL web_id `4750548`.
- Real Persado catalogue, subject scoring (78), optimization (five alternatives; top score 84), cached duplicate Score, subject Apply, independent read-back, and Undo succeeded. The original subject was restored and verified. Score and Optimize used an estimated six credits total; duplicate scoring submitted no additional paid job.
- Preview text: real scoring (51), optimization (five alternatives), Apply, independent read-back, and Undo succeeded. Subject remained unchanged by preview Apply. The original preview was restored and verified. Estimated six further credits.
- Deliberately invalid credentials were rejected by both live APIs and surfaced as `invalid_key`.
- Headless Chromium loaded the real unpacked extension. Using an isolated gateway on port 8789, it displayed real Mailchimp data and cached live Persado results, applied a subject alternative through panel controls, and undid it through the visible Saved changes controls. Mailchimp URL navigation, unknown-draft selection, returning to the known draft, public-site content-script scanning, 390px and landscape layouts passed with no panel page errors. The test Mailchimp page supplied only the editor URL identity; the signed-in Mailchimp application was not exercised. No browser fixture replaced a live provider response. The temporary test gateway was stopped afterward; the existing gateway on 8788 was left running.
- Exact current Persado key, Mailchimp key and pairing-token comparisons found no matches in 219 nonignored source files, the extension ZIP, or Git patch history. A separate scan of 112 commits found no common provider-key patterns. Local `.env` and gateway state files are ignored and mode 0600.

Still unverified: microphone permission/recording/transcription; live body-block scoring and optimization; and live insufficient-credit behavior (quota errors are covered by automated fixtures). Public website provider request/response handling is tested with fixtures; public website scanning is checked in Chromium. Body Apply and all sending remain intentionally unavailable.

Before testing in the user's Chrome, reload/load the final 0.10.1 extension, hard-reload Mailchimp, pair the local gateway and run the checklist above. Restart the existing gateway yourself if it predates the final files; only one gateway should use the state file at a time.

## Sidebar UX verification — 0.10.1

The native Chrome side-panel bar supplies the single Persado Autopilot brand title. Its content header has a small Mailchimp connection indicator and settings gear. API diagnostics and estimated usage appear in Settings. No current account balance is inferred.

A compact campaign name and eligible count precede Subject line (open, Start here), Preview text, Email body and Button language. The latter sections collapse by default. Expanded rows reveal explicit Score (1 credit estimate) and Optimize (5 credit estimate) actions. Scoring is not a prerequisite for optimization. The first real alternative is shown in context; further alternatives use an additional disclosure. Template CTA classification is conservative: known Mailchimp template labels and a Mailchimp-hosted destination must both match. Custom buttons remain first.

The observer sends no content and performs no API calls. Input/change/save/navigation hints are debounced; the panel makes read-only status calls after edits and a five-second settle check. A visible-panel fifteen-second fallback catches saved changes in iframes and other sessions. Concurrent status reads coalesce. Verified campaign IDs bypass repeated draft-list searches. Unchanged response data does not recreate content rows; expansion, scroll and action focus are retained when data changes. Unsaved Mailchimp edits cannot appear through the API until Mailchimp persists them. No automatic paid action is enabled.

Verified in the user's actual signed-in Chrome and Mailchimp, November 24, 2026:

- Reloaded the installed extension to 0.10.1 and hard-reloaded Mailchimp. The native docked sidebar displayed the correct draft, six eligible elements, subject-first actions, compact sections, connection indicator and settings gear without duplicate branding or a persistent usage/footer panel. Score/Optimize labels and Apply were fully readable at the current narrow docked-panel width.
- Ran Optimize directly on the unscored subject through the actual sidebar. Persado returned four alternatives, the first with a real score of 87. Scoring remained at zero runs.
- Applied that alternative through the refined Apply control. Mailchimp saved it and read-back verification succeeded. The contextual Undo appeared; Undo restored the original subject and then disappeared. No email was sent.
- Temporarily edited and saved preview text in Mailchimp. The sidebar updated automatically without clicking Refresh. Restored and saved the original preview, which also appeared automatically.
- Expanded Button language and confirmed its three default CTAs were nested under Template buttons. Left Preview text, Email body and Button language collapsed afterward.
- Navigated from the open draft to the Mailchimp campaign list: stale draft actions cleared and explicit draft selection appeared. Returning to the draft automatically re-identified it with its persisted original subject and preview.
- Opened the settings gear and confirmed connection/usage diagnostics lived there. The ledger showed exactly one optimization, zero scoring runs and one paid request (five estimated credits). All detection, refresh, navigation, Apply and Undo checks introduced no additional Persado requests.
- With user approval, restarted only launchd service dev.persado.gateway to activate the tested gateway changes. Existing pairing and provider credentials remained in place.

Automated validation: 118 agent tests and 55 extension tests, lint/typecheck, smoke, build and repository hygiene passed. Tests cover Optimize without scoring, concurrent status-read coalescing, trusted read-only change hints and rejection of untrusted senders, alongside existing billing/cache, draft-only Apply, read-back and Undo safeguards.

Limitations retained: body Apply is unavailable; the API reads saved content only; the fallback may take up to roughly fifteen seconds plus API latency. Template recognition is a narrow heuristic, not proof of authorship. No ROI ranking, account balance, automatic scoring or sending is invented. Microphone behavior and live quota-exhaustion handling were not retested for this UX change.
