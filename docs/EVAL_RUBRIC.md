# Loupe Evaluation Rubric

Scoring methodology for evaluating Loupe's output quality across four dimensions. Total possible: 100 points.

---

## Dimensions

### Explain (25 points)

Measures how well Loupe teaches the user *why* an opportunity exists.

| Criterion | Points | Pass Condition |
|---|---|---|
| Problem clarity | 5 | The problem is stated in 1-2 clear, concrete sentences. Not vague. |
| Why it matters | 5 | Explains user-facing impact (behavior, frustration, task failure), not just "this violates spec." |
| Design principles | 5 | 1-3 relevant principles are referenced and *applied* to this specific observation. Not generic definitions. |
| Best-in-class patterns | 5 | 1-2 products are named and their *pattern* is described (not copied). Matches the category. |
| Confidence | 5 | Confidence score is explained in terms of evidence mix (screenshots + DOM + transcript + events). |

**Scoring:**
- 5/5: Exceeds — teaches something new, references specific user behavior
- 3/5: Meets — clear explanation, principles apply, patterns are relevant
- 1/5: Below — description repeats the finding, principles are forced or absent
- 0/5: Missing — no explanation generated

### Redesign (25 points)

Measures the quality of proposed experience improvements.

| Criterion | Points | Pass Condition |
|---|---|---|
| Goal clarity | 4 | One clear sentence describing what experience should improve. |
| Proposed experience | 8 | At least 4 of 8 dimensions are addressed concretely (layout, spacing, hierarchy, interaction, content, navigation, visual weight, IA). No generic "improve the design." |
| User impact | 5 | Explains how the change improves usability in measurable terms. |
| Design system impact | 5 | Identifies new/modified components, token changes, spacing changes. |
| Risks | 3 | Acknowledges tradeoffs and constraints honestly. |

**Scoring:**
- 25: All criteria met with concrete, specific recommendations
- 15-20: Most criteria met, some dimensions are light
- 5-10: Generic recommendations, few specifics
- 0: No redesign generated

### Build This (25 points)

Measures the quality of implementation briefs for AI coding agents.

| Criterion | Points | Pass Condition |
|---|---|---|
| Executive summary | 3 | Clearly states what is changing and why. |
| Problem + evidence | 5 | References specific observed values, expected values, and evidence (screenshot refs, selectors, transcript). |
| Design token accuracy | 4 | Uses correct token names from the design system. No invented tokens. |
| File inference | 3 | Infers logical files/areas from URLs and selectors. Doesn't invent exact filenames unless certain. |
| Acceptance criteria | 5 | Criteria are testable and specific. Not "make it better." |
| Implementation order | 3 | Phases are correctly prioritized by severity. |
| Format | 2 | Output matches the expected structure. Usable by Claude Code, Cursor, or Codex without rewriting. |

**Scoring:**
- 25: Production-ready brief. An AI coding agent could implement without asking questions.
- 15-20: Most criteria met, some sections need fleshing out.
- 5-10: Brief exists but lacks specificity or has invented tokens/files.
- 0: No brief generated.

### Overall (25 points)

Measures the holistic quality of the Loupe review.

| Criterion | Points | Pass Condition |
|---|---|---|
| Opportunity count | 3 | 10-30 opportunities for a 30-60s session. Not too few (missed issues) or too many (noise). |
| Severity distribution | 4 | 0-2 Critical, 3-8 High, rest Medium/Low/Info. Realistic severity assessment. |
| False positive rate | 5 | < 20% of opportunities are not actionable or are incorrect. |
| Narration alignment | 4 | > 50% of high-severity opportunities are connected to narration transcripts. |
| Score accuracy | 5 | Score reflects the actual quality: a broken prototype scores < 60, a polished product scores > 85. |
| Reviewer coverage | 4 | At least 3 of 5 reviewer personas contributed findings. |

**Scoring:**
- 25: Review is accurate, actionable, and trustworthy
- 15-20: Minor issues with severity or false positives
- 5-10: Significant issues with accuracy or completeness
- 0: Review failed or returned nonsense

---

## Total Score (Additive)

| Score | Rating | Meaning |
|---|---|---|
| 90-100 | Excellent | Production quality. Briefs are implementable. |
| 70-89 | Good | Most issues found correctly. Minor misses. |
| 50-69 | Fair | Core pipeline works but quality needs improvement. |
| 25-49 | Poor | Significant issues in accuracy or completeness. |
| 0-24 | Failing | Review is not actionable. |

---

## Evaluating by Intent

Score each user intent against its own contract (`docs/UX_STATES.md`) — never
against another intent's depth, and never using internal mode language
(fast/full/deep) in scorecards:

- **Build This** — judged on brief precision and turnaround: correct changes
  identified from narration/target design, no invented CSS, ≤60 s. It is NOT
  penalized for finding fewer opportunities — breadth is not its job.
- **UX Review** — judged on opportunity quality per the Explain/Redesign
  dimensions above, at 1–2 min latency, without the persona fanout.
- **Complete Audit** — judged on recall and severity accuracy; the only intent
  where missing a real issue is a scoring failure.

## Automation Plan

The rubric is designed to be automatable as `loupe eval`:

1. **Explain evaluation** — compare opportunity description against the finding evidence. Check for principle references via keyword matching. Check best-in-class pattern naming.
2. **Redesign evaluation** — check that 4+ dimensions are non-generic (string length + keyword density). Check design system impact has real token names.
3. **Build This evaluation** — check acceptance criteria are testable (contain "should", "must", "verify"). Check token names exist in loaded design system. Check file inference is reasonable.
4. **Overall evaluation** — check counts, distribution, narration alignment (timestamp matches), false positives (sample-based).

Phase 1: Manual scoring using the scorecard template.
Phase 2: Semi-automated with `loupe eval --scorecard scorecard.md`.
Phase 3: Fully automated score output alongside each `loupe analyze` run.
