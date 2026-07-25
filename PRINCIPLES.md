# Loupe Principles

These are the north stars. Every feature, every decision, every line of code should ladder up to these.

---

## 1. Local First

Everything runs on your machine. Your session data, your API keys, your design system, your destinations. Cloud (SaaS mode) is optional and additive — never required.

Sessions never leave your machine unless you explicitly configure a cloud gateway. No telemetry. No tracking. No "we'll store this in the cloud for you."

## 2. Evidence Before Opinion

Every claim Loupe makes must be backed by evidence from the session. Screenshot references. DOM selectors. Event timestamps. Narration quotes. Confidence scores.

If Loupe says "this button has a non-token color," it shows you the color, the expected token, and the exact element. The user should never have to hunt for proof.

## 3. Deterministic Before AI

If a check can be done with math, do it with math. Touch target sizes, console errors, token drift, spacing consistency — these are mechanical. Never waste an LLM call on them.

AI is reserved for tasks that genuinely benefit from human-like judgment: explaining why something matters, designing a better experience, generating an implementation plan. Everything else is deterministic.

## 4. Explain Before Build

Before generating code, teach why the change matters. The Explain mode is not a warm-up for Build This — it's a first-class output. Users should understand the reasoning before they see the implementation.

This builds product sense over time. Regular users of Loupe should develop a better instinct for UX design because Loupe teaches them, not just by generating fixes.

## 5. Design Systems over One-Off CSS

Every implementation brief should reference the design system. Color tokens. Spacing scales. Typography. Radius. Shadows. If the target has a design system, Loupe should find it and use it.

One-off styles should be flagged, not generated. If a fix requires a non-token value, it must be explicitly justified in the acceptance criteria.

## 6. Implementation over Suggestions

Loupe does not suggest. It generates. The output of Build This is a production-ready implementation brief that an AI coding agent can execute. Not a wish. Not a recommendation. A brief.

If an output isn't implementable, it isn't done.

## 7. Measure Everything

Every analysis produces a score. Every build has acceptance criteria. Every benchmark tracks progress over time. If it can't be measured, it shouldn't ship.

Scores are derived, not invented. No AI-generated scores. They come from severity-weighted deductions applied to real findings.

## 8. No Hallucinated Context

If Loupe doesn't know the file structure of your project, it won't invent filenames. It will describe logical areas (Dashboard, Sidebar, Button) instead of making up paths.

If it can't determine the exact component structure, it will describe the visual changes needed. Honest uncertainty is better than confident hallucination.

## 9. Premium UX

The popup should feel like Raycast, Linear, or Cursor. Fast. Minimal. Intentional. Not like a Chrome extension from 2015.

Every state communicates clearly: what's happening, what's next, and how the user takes action. No generic forms. No oversized empty space. No confusing terminology.

## 10. AI Should Teach, Not Just Generate

The Explain mode is not a sales pitch for Build This. It's genuine education. The user should walk away understanding why something is a problem and how to think about similar problems in the future.

This is what makes Loupe a design partner rather than a code generator. A partner teaches. A generator produces.
