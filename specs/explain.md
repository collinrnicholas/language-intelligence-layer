# Product Spec: Explain

**Status:** v2.0-alpha (shipped)
**Owner:** Collin
**Depends on:** Shared Context Builder, LLM Router

## Purpose

Explain teaches the user why an opportunity matters. It is not a repeat of the finding description. It is genuine design education.

## Input

- `Opportunity` (category, severity, title, description, observed, expected, evidence)
- `ReasoningContext` (screenshots ±5s, DOM snapshot, narration quotes ±10s, events, URL, selector, design system tokens)
- Existing deterministic findings (for confidence explanation)

## Output

```typescript
interface ExplainOutput {
  problem: string;           // 1-2 clear sentences
  whyItMatters: string;      // User-facing impact
  designPrinciples: string[]; // 1-3 relevant principles, each with application
  bestInClassPatterns: string[]; // 1-2 product patterns described
  evidence: Evidence;        // Same as context evidence
  confidence: number;        // 0-1
  confidenceExplanation: string; // Why confidence is what it is
}
```

## Deterministic Inference

These are done without any LLM call:

- **Problem:** Constructed from opportunity title + description + evidence
- **Why it matters:** Mapped from category (Accessibility → WCAG, Design System → consistency, Performance → user frustration)
- **Design principles:** Keyword-matched from opportunity category and description (Visual Hierarchy, Hick's Law, Fitts's Law, Gestalt, Cognitive Load, Information Scent, Progressive Disclosure, Recognition over Recall, Accessibility)
- **Best-in-class patterns:** Category-based product mapping (UX → Linear/Stripe, Visual → Apple/Notion, Design System → Vercel/Radix, Accessibility → gov.uk)
- **Confidence:** Derived from evidence mix (screenshot + DOM + transcript + events → higher confidence)

## AI Enrichment

When an API key is available, the deterministic output is sent to the LLM with a prompt to:

- Refine the problem statement with session-specific language
- Deepen the "why it matters" with specific user behavior from the recording
- Select the most relevant design principles and explain their application
- Describe the specific pattern from best-in-class products (not just name-drop)
- Explain confidence in terms of the specific evidence available

## Quality Bar

- The user should learn something they didn't know
- Design principles must be applied to this specific observation, not defined generically
- Best-in-class patterns must describe the *pattern*, not copy the product
- Confidence must be explainable in 1-2 sentences

## Non-Goals

- Explain does not propose solutions (that's Redesign)
- Explain does not generate code (that's Build This)
- Explain does not repeat the finding description
