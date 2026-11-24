# Persado Assist — original brief-capture vision

**A front door for Motivation AI.** A marketer stands on the page they're worried about, talks for a minute, and Persado receives a structured, grounded brief — the page, the actual on-page copy, the audience, the objective, and the intent in their own words.

Status: working prototype. This document states a hypothesis and proposes a cheap way to test it. It is not a product commitment.

---

## The constraint we think is real

Every campaign Persado touches begins with a brief, and the brief arrives as an email thread, a deck, or a call. It is unstructured, usually incomplete, and it moves at the speed of people's calendars. Before Motivation AI can do anything, someone has to work out which asset is in question, what the current copy actually says, who the audience is, and what outcome the marketer wants — and that reconciliation happens over days, in clarification rounds.

Persado's models are fast. The path to feeding them is not. If that is true, then briefing is not a UX inconvenience, it is a throughput constraint on every account.

**This is a hypothesis, not a finding.** The first job is to verify it against how campaigns actually stall today. If the real delay is legal review or ESP integration, this project should stop.

## The thesis

Capture the brief where the work happens, in the medium people already think in.

Marketers do not struggle to describe what is wrong with a page — they struggle to write it down in a form a model can use. Narration removes the writing step. Being on the live page removes the ambiguity about which asset and which words are in question. What comes out the other side is not a transcript but a structured object.

The capture mechanism is disposable. The structured brief is the durable asset.

## What it produces

A brief record containing the page URL, the on-page element under discussion with its current copy and selector, the product line, the objective, the asset type the copy is for (web headline, web CTA, email subject, push, SMS, banner, or social), the narration verbatim, and a completeness assessment of whether the marketer covered the element, the audience, the objective, and the desired outcome.

Screen capture is optional and off by default. The load-bearing grounding is the extracted on-page copy, not pixels; capturing the screen is a switch, not a requirement — which matters because screen and microphone access inside a bank is the security review this project has to pass, and not sending images is the posture that passes it.

That last part matters: the tool does not just record input, it tells the marketer what their brief is missing while they can still fix it.

## Where Motivation AI fits

Persado Assist produces the brief. Motivation AI generates and scores against it.

Today the prototype hands the brief to a general-purpose model as a stand-in, so the flow can be demonstrated end to end. Every variant it returns is unscored and every compliance flag is illustrative. The integration point is deliberately visible in the UI rather than hidden — there is an empty slot on each variant labelled as not connected, because the point of the prototype is the seam, not the placeholder behind it.

## What we would test

One existing bank account, one campaign, four to six weeks. Measure time from marketer request to usable brief, the number of clarification rounds before generation, and time to first variant in market — each against that account's own recent baseline rather than an industry figure.

## What would prove this wrong

Briefing is not where campaigns actually stall. Marketers will not narrate — they self-edit, or they find speaking to a tool uncomfortable. Captured briefs are not measurably better inputs than written ones. Or the security posture required to run capture inside a bank costs more than the cycle time it saves.

Any one of these ends the project, and we should want to find out cheaply.

## Open questions

Whether capture belongs in a browser extension at all, given that screen and microphone access inside a bank is a serious security review — the concept does not depend on the extension shell. Whether this generalises to email, push, and SMS, where much of Persado's volume lives and where there is no page to stand on. And whether this is a product or a feature of the existing portal; the honest answer is that the durable asset is the brief schema and the intake pipeline, and the shell around it is negotiable.

---

*Prototype built on the author's prior project, which supplied the capture, vision, and gateway infrastructure. See `README.md` for provenance.*
