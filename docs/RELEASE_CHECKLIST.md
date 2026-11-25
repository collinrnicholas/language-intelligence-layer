# Persado Assist — release checklist

Run in order. Automated checks first, then the live checks they cannot cover. Record who ran each live check and when.

## Automated

- [ ] `npm test` — all suites pass (includes `gateway-security`, `jobs`, `panel-jobs`)
- [ ] `npm run smoke` — contract, prototype-residue and credential checks pass
- [ ] `npm run build` — `extension/dist/unpacked` and zip produced
- [ ] Version bumped in `extension/manifest.json` and `extension/package.json`, with a `CHANGELOG.md` entry
- [ ] `git log -p` secret scan: no provider keys or pairing tokens (placeholders only)

## Live — public website (no paid calls needed for 1–3)

1. [ ] Load unpacked. Open the panel on a public page; copy is detected and grouped, nothing is charged.
2. [ ] Pick on page selects arbitrary copy; Esc cancels.
3. [ ] Narrow side panel (~320 px): no horizontal scroll, buttons wrap, long copy truncates.
4. [ ] *(paid, authorized)* Check one line → state shown; check it again → "Saved result — no credits used".
5. [ ] *(paid, authorized)* Find a better version → "Optimization in progress"; close the panel; reopen → result or progress resumes.
6. [ ] Copy this version / Preview on page / Restore original work; reload restores the site.

## Live — Mailchimp (test account, test draft only; never send)

1. [ ] Open a regular draft → fields listed without spending credits.
2. [ ] *(paid, authorized)* Check and Find a better version on the subject line; leave and return mid-run.
3. [ ] Use this version → "Applied to campaign"; refresh Mailchimp → new subject persists.
4. [ ] **Editor conflict:** with the subject editor open and unsaved, Apply → panel warns first. Then save the editor and record whether Mailchimp restores the old subject, and whether the panel reports it.
5. [ ] Undo restores the original; after an outside edit, Undo refuses.
6. [ ] Body/button field shows "review only" before spending and offers Copy.

## Interruptions

- [ ] Stop the gateway during an optimize; restart it; status recovers by job id without a second charge (check the usage ledger).
- [ ] Restart Chrome during an optimize; reopen the panel on the same page; the run resumes.
