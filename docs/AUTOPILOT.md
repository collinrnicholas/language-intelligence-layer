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

For a fresh installation, load the current extension build, hard-reload Mailchimp, pair the local gateway and run the checklist above. Restart the exact existing gateway if it predates the final files; only one gateway should use the state file at a time.

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

## Actionable scoring and Apply verification — 0.10.3

The official [Persado client manual](https://github.com/persado/martechapi-cli/blob/develop/USER_MANUAL.md#4-score-variants) describes performance on a 0–100 scale and brand fit out of five. Its [response schema](https://github.com/persado/martechapi-cli/blob/develop/src/pkg/api/models.go) includes `performanceBand`, `brandRationale`, `brandAlignment`, emotions, descriptors and compliance. No validated numerical band thresholds were found. The sidebar displays a returned band verbatim apart from capitalization, and never derives one from the score. A numeric-only response gets a neutral score and an explicit explanation-unavailable message.

Brand rationale is labelled **Persado brand feedback**, not presented as a causal explanation of the performance number. Detected characteristics and compliance feedback also come from actual response fields. Recommendations point to that feedback, editing or optimization. No separate explanation model, additional explanation charge, model confidence, conversion forecast or ROI claim is introduced.

Scored rows display score/status and their primary action while collapsed. Lower returned performance numbers appear first as an editorial review order, not a financial priority or a cross-job Persado ranking. The fixed Start here label disappears once scores exist. Not yet evaluated content is grouped separately. Expanded rows show original language, real feedback and explicit paid actions. Optimization compares the original with up to three alternatives, labelling actual API scores as predictions. An applied alternative retains its genuine cached prediction only when account, campaign, touchpoint and exact text match; no extra scoring job is submitted.

Apply and Undo now use three sequential Mailchimp requests: fresh campaign/settings GET, one-field PATCH and independent verification GET. The previous path made seven requests before returning the save result. Draft, URL/campaign identity, stale-copy, rewrite, serialization and undo-journaling safeguards remain. The sidebar renders verified settings immediately and synchronizes HTML/cache metadata afterward. Saving feedback begins immediately, but saved confirmation waits for read-back; network persistence cannot be guaranteed instantaneous.

Verified November 24, 2026 in the actual signed-in Chrome side panel against campaign web_id `4750548`:

- Reloaded the extension to 0.10.3. Inspected genuine cached live Persado results: preview 51/Fair with brand fit 3/5 and its returned rationale; subject 87/Excellent with brand fit 3/5. The preview appeared first with Review next, the subject retained a collapsed Optimize action, and four unevaluated body/button elements were grouped separately. No Start here remained.
- Inspected original subject 78/Strong against optimized subject 87, with two further alternatives behind one disclosure (three total). The comparison uses actual API predictions.
- Used native Undo and Apply controls. Undo restored the original subject, then Apply restored the user's previously selected optimized subject. Both returned verified success and the contextual Undo appeared. Preview remained unchanged. No email was sent and no new Persado paid request was needed for these checks or explanations.
- The sidebar fit the actual docked width with readable actions, neutral meter, progressive disclosure and source-labelled brand feedback. Content scripts were unchanged in this patch; their detection/navigation path was hard-reloaded and verified in the preceding native UX checks.

Automated validation: 118 agent tests plus 63 extension tests passed. New coverage checks neutral numeric-only results, genuine band/rationale/tag provenance, unscored separation, actual optimization predictions, three-request Apply, mismatched campaign identity, cross-account cache isolation and existing stale-write/Undo protections. Smoke, typecheck, build, version and repository checks passed.

Limits remain: body Apply is disabled; Mailchimp's already-open editor form can retain stale text until a refresh; scores and brand feedback do not prove conversion lift. This patch reused real responses rather than buying additional scores solely for UI testing. Microphone/transcription and live quota exhaustion were not retested.

## Campaign impact intelligence — 0.11.0

This version supersedes the verbose score presentation described above. A row shows **Preview text — Fair · 51/100** using the returned band, with no local threshold, meter, duplicate score, brand rating or emotional tag. Lower scores appear first; the lowest is expanded on initial load and other scored rows collapse. All unscored fields remain accessible in one disclosure. An expanded row has one primary action: Score (1 credit), Optimize (5 credits), or Apply for a comparison. Unscored rows retain a secondary Optimize directly action. Comparisons select from at most three cached alternatives and share one Apply control. A short excerpt from actual `performanceWhy` is labelled Persado feedback; a short imperative from `brandRationale` is separately labelled Persado brand guidance. Long text is omitted rather than paraphrased into an invented model explanation.

### Mailchimp observations and baseline

The existing campaign GET now reads `recipients.recipient_count`, status, tracking and send metadata. Draft reach is explicitly estimated; `emails_sent` is finalized volume only for sent campaigns. Missing reach remains unavailable, and zero remains zero. Entire audience size is never substituted.

Read-only reporting uses [GET /reports](https://mailchimp.com/developer/marketing/api/reports/list/), [GET /reports/{campaign_id}](https://mailchimp.com/developer/marketing/api/reports/get/) and a bounded list of 30 sent regular campaigns for the same audience. Up to ten missing individual reports may be fetched. Five-minute in-memory caches coalesce concurrent reads; refreshes never start a Persado job. The 180-day baseline requires matching audience and segment, click tracking, positive sent volume, valid reported click rates and a matching folder when configured. Folder/segment metadata is not proof of campaign purpose. Rates are weighted by emails sent, not averaged equally. Details list the source, sample size, total sent and constituent campaigns. Missing/failed/incomparable history stays unavailable.

Reports expose sanitized aggregate sends, reported click rate, unique clicks/clickers, and tracked ecommerce orders/revenue/currency when present. Orders are not assumed to be unique conversions; no click-to-conversion rate is derived from them. The UI labels reports as observed and says incremental impact is not established. No report exists yet in the connected account, so populated post-send and baseline views have automated coverage, not live-account examples.

### Persado prediction findings and remaining gap

On November 24, read-only GETs of the four existing real Persado jobs revealed fields omitted by the older official CLI model and our parser: `performanceWhy`, `potential`, `conversionUplift` and `performanceDeltaPoints`. Normalization now preserves these fields. Existing cached jobs recover them with GET `/v1/jobs/{id}` once, without a replacement Score/Optimize request; expired or unavailable jobs retain the older known result. No paid uplift/performance endpoint is called automatically.

The current [developer playground](https://api.persado.com/api/developers) renders `potential` as optimization potential, with current/projected score, industry benchmark and click/conversion categories (`vsIndustryToday`, `vsIndustryProjected`, `total`). The real preview score of 51 returned projected score 70, click potential total 8.2%, and conversion potential total 10.6%. These are actual provider outputs, not a conversion of score points. Optional **Persado model output** details show the category totals as optimization potential relative to current language, explicitly distinguishing them from a chosen rewrite and noting missing calibration/confidence. They are hidden in the default view and never drive our campaign-impact calculator automatically.

Optimized alternatives also returned `conversionUplift` (for example 7.8) and `performanceDeltaPoints` (9). The playground labels conversion uplift against industry; this is insufficient to treat it as incremental clicks versus this campaign's original. It is retained but not multiplied by campaign reach. The [official CLI manual](https://github.com/persado/martechapi-cli/blob/develop/USER_MANUAL.md#8-project-uplift) documents separate `/v1/uplift` and `/v1/performance` endpoints. The current playground labels uplift as one unit per call and performance as one unit per variant; neither was invoked. Its Score action now confirms one unit, replacing the earlier score-cost assumption in our source.

No response examined supplied a confidence interval, per-campaign calibration evidence, experiment assignment, stable content/variant ID or a model version for these impact fields. Persado's [published evaluation](https://www.persado.com/model-evaluation) concerns ranking accuracy, correlation and stability; those are not a calibration curve for the returned uplift percentages. The default UI therefore says forecast unavailable rather than presenting a validated campaign forecast.

For the Persado API team, the remaining requirements are precise:

- A versioned contract defining `conversionUplift` and `potential.*.total`: original versus industry baseline, relative versus percentage-point units, response denominator, forecast horizon and whether it describes a specific returned rewrite or a hypothetical optimized message.
- Audience/channel/industry applicability and out-of-domain rules, calibration evidence for magnitude predictions, model/version IDs, and uncertainty intervals with documented coverage. Ranking accuracy alone does not supply these.
- A calibrated click uplift for the exact original/selected-variant pair, with compatible baseline semantics, before multiplying our Mailchimp baseline by that uplift. Conversion/revenue predictions additionally require a compatible conversion denominator and order-value/currency inputs.
- Stable content/variant/experiment identifiers and a documented outcome-ingestion/controlled-assignment contract before attributing incremental results. No experiment is created or sent by this extension.

### Scenarios and measurement model

`src/campaign-impact.js` is a pure reusable calculation module, shared with the gateway. Rates are fractions internally. It calculates additional clicks as recipients × baseline click rate × relative uplift; optional conversions use an explicitly entered **click-to-conversion** rate, and optional revenue uses order value and currency. Relative lift and percentage-point change are separate output fields. Missing values, negative/nonfinite inputs, impossible projected rates and overflow are rejected; valid zero values are retained. Results carry `source: user_scenario` and no invented uncertainty.

The calculator is hidden behind Potential impact → Illustrative scenario. Relative lift starts blank, historical baseline starts blank when unavailable, and calculations run only on an explicit submit. Inputs are editable user assumptions; no number is called a Persado prediction. Scenario inputs/results remain local to the panel and are not sent to either provider.

Private `state.outcomes` records in ignored, mode-0600 gateway state connect campaign/field, original/optimized copy, real Persado job and variant index, score/optimization/application/Undo timestamps and post-send metrics. `experimentalAssignment` and `verifiedIncrementalOutcome` remain null without evidence. No retrospective causal result is inferred from campaign averages or before/after reports.

### Verification

- Native Chrome: loaded 0.11.0 and hard-reloaded signed-in Mailchimp. Correct campaign, estimated reach **1**, six eligible elements, preview 51/Fair first, subject 87/Excellent collapsed, one unscored section and forecast-unavailable state were visible at the actual narrow panel width. No historical reports exist in the live account; no baseline or tracked revenue was fabricated.
- Read existing real Score/Optimize jobs, recovered richer fields, and displayed the real preview feedback excerpt. Expanded body and all three template buttons; Score and Optimize directly remained independently available.
- Entered test scenario assumptions in Chrome: 10,000 recipients, 2% click rate, 10% relative lift, 5% click-to-conversion, order value USD 100. Result: 20 incremental clicks, one potential conversion, USD 100 potential revenue, and 0.2 percentage-point change, labelled illustrative. These are test assumptions, not this campaign's reach or a provider forecast.
- Native Undo restored the original subject; the comparison offered exactly three alternatives. Selecting the second updated its actual text/84 score. Selecting the first and Apply restored the user's chosen 87-score subject with verified success and contextual Undo. Preview remained unchanged. No email or experiment was sent.
- 118 agent tests and 80 extension tests passed, plus build, lint/typecheck, smoke, version, repository hygiene and diff checks. Tests cover weighting/comparability, missing/zero/invalid inputs, reporting caches/errors, genuine prediction provenance, free job enrichment, private outcome links and existing write/Undo safeguards. The persisted ledger remained three scores plus one optimization, eight credits, four paid requests throughout this work.

Remaining limits: no live sent history, ecommerce report, controlled experiment or campaign-calibrated forecast was available to verify in this account. Body Apply remains disabled. The Mailchimp editor can retain stale text until refreshed after API write-back. Microphone/transcription and live quota exhaustion were not retested.

Chrome's retained extension-error history contained `ReferenceError: scanUrlEl is not defined` (the symbol is absent from current source) and `Uncaught Error: Extension context invalidated.` These entries predated this extension reload; the new Mailchimp flow did not reproduce the fatal failure. Native browser control later lost the Chrome window connection after the final main-view/model-output verification, so no claim of a completely clean browser console is made.

## Final result hierarchy and interactions — 0.11.1

After optimization the Mailchimp row leads with recommended copy, actual score change, Apply, other scored options, and Compare original. It uses the control and alternatives from the same optimization job/channel; a separate prior Score job is not substituted as the comparison baseline. Explicitly differing scoring contexts and missing scores do not produce a delta. Comparable returned alternatives are sorted by actual score before the three-option cap. Original server indices are retained for Apply and the selected index is stored per campaign/field/cache result. “Top recommendation” means the highest comparable returned score, not a mathematical optimum or a conversion winner. Public website optimization also uses the same ranking and relative-score presentation; its preview/copy functionality remains.

The primary opportunity opens first. Other scored rows collapse without repeated large Optimize buttons; template defaults remain subordinate to marketer copy. Zero/one-recipient reach, unavailable baseline/forecast information and older Undo receipts move into Campaign details. A verified application keeps its original-to-selected score change, with one contextual confirmation and Undo. Later field changes invalidate that UI confirmation. Older receipts remain accessible in details, with the existing gateway stale-edit guard. Undo no longer opens the subject section when another field was edited.

Presentation uses CSS tokens for 150ms feedback, 200ms disclosure/result transitions and 240ms layout changes, with one shared easing. `src/interactions.js` uses native Web Animations for interruptible disclosure height, restrained opacity/translation reveals and keyed priority movement. Keyed updates retain controls and selection/focus rather than replacing every row. No animation is awaited by a provider operation. Numeric scores never count through fabricated intermediate values. Skeletons exist only while initial campaign detection is outstanding; scoring, optimization and saving indicators follow actual request promises. Success feedback runs only after verified read-back. Global focus-visible/hover/press/disabled states and runtime reduced-motion changes are supported; missing animation support falls back to the final state. No animation dependency was added.

Verified November 24, 2026:

- Native signed-in Chrome: real existing preview optimization selected score 69 over 67 and 65, showing **51 → 69 · +18 score points**. Selecting 67 showed +16 and survived rapid collapse/reopen. Apply independently verified the 69-score copy before showing one confirmation and Undo; Undo restored the starting preview and returned focus to its summary without opening the subject. The user's chosen subject remained unchanged. Final default view showed the recommendation and Apply without unavailable metrics, trivial reach or persistent success text.
- An isolated unpacked-extension Chromium profile with controlled API fixtures exercised genuine pending score/optimization requests, keyed row movement, top-score default/server-index mapping, manual selection, duplicate Apply protection, verified-only success, Undo cleanup, provider-error recovery, keyboard focus, runtime reduced motion and 300px overflow. These loading/error checks are fixture-based; native Apply/Undo used real Mailchimp. No extra paid Score/Optimize job was submitted solely for motion verification.
- Existing tests plus new comparison/motion cases: 118 agent and 87 extension tests passed. Native animation fallback, rapid reversal and preference-change cancellation have unit coverage. Build, lint/typecheck, smoke, version, repository and diff checks passed. No gateway, credential, API or billing implementation changed.

Limits retained: body Apply is unavailable; persisted Mailchimp copy may require an editor refresh; no score change proves conversion lift. Native Chrome retained the same older error-history entries described above, without a new reproduced fatal failure. Recording/microphone and live quota exhaustion were not retested for this presentation-only change.
