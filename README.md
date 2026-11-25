# Persado Assist

**Language intelligence, wherever you work.** A Chrome extension (Manifest V3) that checks and improves marketing copy with the Persado API, on any web page and in Mailchimp draft campaigns.

> **Status: developer preview.** Every Persado and Mailchimp call goes through a small gateway you run on your own machine (`gateway/`), which holds the provider keys. A hosted service is required before people outside the team can use it. See "Limits" below.

Architecture, API sources, security model and live-verification notes: **[docs/ASSIST.md](docs/ASSIST.md)**.

## What it does

Each piece of copy is in one of three states: **Looking good**, **Worth improving** or **Not checked**. Copy Persado could not judge is listed separately under **Needs review**.

**On any web page**

1. **Detect (free).** The side panel lists the page's headlines and calls to action. **Pick on page** chooses anything else.
2. **Check (1 credit).** Sends one line to Persado (`POST /v1/score`). A checked line is saved, so checking it again is free.
3. **Find a better version (5 credits).** Sends it to Persado (`POST /v1/optimize`). This can take a few minutes. You can close the panel; the result is picked up when you return.
4. **Use it.** The recommendation shows the new copy and a short reason when Persado gave one. **Copy this version** copies it to paste into your site's editor. **Preview on page** swaps it into this tab only; nothing is saved to the site.

**In Mailchimp**

1. Open a regular draft. The panel matches the URL to the campaign through the API and lists subject line, preview text and eligible body and button copy. Reading is free.
2. Check (1 credit) and Find a better version (5 credits), per field.
3. **Use this version** writes subject line or preview text only. The gateway checks the campaign is still a draft and the field is unchanged, PATCHes that one setting, and reads it back to verify. **Undo** restores it if nobody changed it since.
4. Body and button copy are **review only**: the panel says so before you spend credits and offers **Copy**. Nothing is ever sent to an audience.

## Running it (developers)

```bash
npm install
npm run build        # smoke checks, then writes extension/dist/unpacked (+ a zip if `zip` exists)
```

Start the gateway with credentials from your secret manager (placeholders in `.env.example`):

```sh
# required: PERSADO_API_KEY, PERSADO_PROXY_TOKEN (openssl rand -hex 32)
# for Mailchimp: MAILCHIMP_API_KEY (optional MAILCHIMP_SERVER_PREFIX)
npm run gateway      # http://127.0.0.1:8788
```

1. In `chrome://extensions`, enable Developer mode and **Load unpacked** → `extension/dist/unpacked`.
2. Open the side panel → Settings. Paste the **pairing token** (`PERSADO_PROXY_TOKEN`, not a provider key) → Pair gateway. Set Brand name. Test Mailchimp.
3. On a website: Check → Find a better version → Copy. In Mailchimp: open a draft → Check → Find a better version → Use this version → refresh Mailchimp to confirm.

The gateway only serves `GET /health` and the authenticated `POST /v1/integrations` (loopback Host, extension Origin, pairing token, JSON only).

## Checks

```bash
npm test               # gateway, jobs, security and extension suites (+ inherited agent suite)
npm run smoke          # static cross-context contract checks
npm run typecheck      # syntax-checks every extension script
npm run build          # smoke + package
```

Release steps, including the live checks static tests cannot cover: [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).

## Analytics

`extension/src/analytics.js` records a fixed set of adoption events (panel opened, return visit, content detected, check and optimization started/completed, recommendation applied, undo, API error, insufficient credits). Properties are allowlisted tokens. No copy, URLs, campaign ids, email addresses or keys are recorded. By default events stay in the browser profile (`ANALYTICS_ENDPOINT` is empty). Inspect them from the side panel console with `await PERSADO_ANALYTICS.dump()`.

## Limits

- Needs the local gateway. No hosted authentication yet.
- Credit balance is an estimate. Persado documents no balance endpoint, so the panel never shows an invented figure.
- Mailchimp body and button copy cannot be applied automatically.
- Whether Mailchimp's open editor can save stale text over an applied change has not been verified live. The panel warns before Apply when the campaign is open, and re-checks afterwards.
- Language scores are model predictions, not measured campaign outcomes.

## Repo layout

| Path | What it is |
|---|---|
| `extension/` | The Persado Assist extension: side panel, worker, page scanner, Mailchimp change observer, and the shared Persado/Mailchimp clients the gateway loads. |
| `gateway/` | Local development gateway. The only process that holds provider keys. |
| `scripts/` | Smoke checks, packaging, version and hygiene tooling. |
| `agent/`, `docs/loupe/`, `benchmarks/`, `evals/`, `research/`, `specs/`, `prompts/` | Inherited from the earlier Loupe project. Not part of the extension. |
