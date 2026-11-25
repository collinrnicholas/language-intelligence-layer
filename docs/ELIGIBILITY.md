# Detection eligibility

`src/eligibility.js` is the single policy that decides whether a piece of page
text may enter the Persado workflow. It is loaded by the scanner (browser page
context), by the side panel, and by the service worker, and it runs before every
billable request — not only when the page is scanned.

## Decisions

| Category | Auto-included | Billable |
| --- | --- | --- |
| `primary_cta`, `secondary_cta`, `marketing_headline`, `value_prop` | yes, with sufficient evidence | yes |
| `navigation`, `functional_control`, `unknown` | no | only after an explicit click |
| `consent`, `language`, `auth_control`, `accessibility`, `legal`, `security_check`, `sensitive_field`, `system_message` | never | never, manual selection included |

A hard exclusion is dropped during detection, so it is not listed, ranked,
highlighted or queued. If a hard exclusion is ever presented anyway (stale
material, retry, a different UI), the worker refuses it at the request boundary;
the panel only reflects that refusal.

## Evidence, not vocabulary

Classification combines:

* **semantic role** — `button`, link, `label`, heading level, submit inputs;
* **DOM structure** — whether the element is inside `nav`, `dialog`, `footer`,
  `form`, `main`; whether it is in an app shell or a marketing hero;
* **page purpose** — `pageType()` derives the page type from paths, headings,
  form shape, price/cart signals, schema.org types and `aria-current`, never from
  a hostname allow/deny list;
* **surrounding copy** — container class/id/aria hints, nearby benefit or price
  statements, proximity to a form;
* **text** — conversion verbs and benefit words, used last and never alone.

A `<button>` with an action verb scores low on its own; it needs page context or
container evidence to become a primary CTA. Conversely, text alone cannot
rescue a protected control: cookie, consent, locale, auth, accessibility, legal,
CAPTCHA and payment/personal-data labels are excluded before scoring.

Ambiguity is a valid outcome. Content the policy cannot clear is excluded from
Check All and remains selectable by hand (the panel marks it), because the user
may know something the rules do not.

## Enforcement points

1. `scan.js` — hard exclusions are not collected; materials carry their decision.
2. `priority.js` — ambiguous material is penalised and can never be the
   "suggested starting point".
3. `sidepanel.js` — Check All queues only `autoEligible` material and sends
   `batch: true`; an individual click sends `manual: true`.
4. `background.js` — `gate()` runs before the gateway call. Batches must prove
   automatic eligibility; manual requests may check anything not hard-excluded;
   every request, batch or manual, is refused if the text or its decision is a
   hard exclusion. Mailchimp requests keep their own campaign flow.

## Measurement

`test/fixtures/eligibility-dataset.mjs` holds hand-labelled rows across
ecommerce, checkout, SaaS, banking, healthcare, education, nonprofit, lead
generation, content and an authenticated app shell, plus a held-out set written
after tuning. `test/eligibility.test.mjs` prints precision, recall, primary-CTA
accuracy and hard-exclusion leaks, and fails if any hard exclusion reaches the
gate.

Known limits: the fixtures are representative shapes, not captured pages, so a
passing suite is not proof of zero real-world false positives. Recall is
weakest on paraphrased conversion CTAs ("Chat with sales", "Find a doctor") and
on editorial headlines, which the policy deliberately leaves ambiguous. SPA
navigation that renders no landmark elements and consent tooling inside a
cross-origin iframe remain outside what page-local heuristics can see.
