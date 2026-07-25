# Benchmark: PM Toolkit Dashboard

**Product:** PM Toolkit (thepmtoolkit.app)
**Flow:** Dashboard — create/edit/view projects
**Fixture:** `benchmarks/pm-toolkit/<date>.loupe`
**Expected scores:** Based on v2.0-alpha baseline

## Expected Opportunity Count

| Category | Min | Expected | Max |
|---|---|---|---|
| Critical | 1 | 2 | 3 |
| High | 4 | 5 | 7 |
| Medium | 6 | 8 | 10 |
| Low | 4 | 6 | 8 |
| Info | 0 | 1 | 2 |
| **Total** | **15** | **21** | **28** |

## Expected Score

| Dimension | Score |
|---|---|
| Explain | /25 | ≥ 90% |
| Redesign | /25 | ≥ 85% |
| Build This | /25 | ≥ 90% |
| Overall | /25 | ≥ 80% |
| **Total** | **/100** | **≥ 86** |

## Expected Model Score

| Model | Expected Score | Notes |
|---|---|---|
| Claude Opus | 90-95 | Best redesign quality, best brief structure |
| Claude Sonnet | 85-93 | Good balance, recommended default |
| GPT-4.1 | 80-88 | Good explain, weaker brief structure |
| GPT-4.1-mini (judge) | 75-82 | Fast but misses nuance |

## Key Opportunities to Find

These should be detected in every run:

1. **Non-token color on button.primary** — Design System, Medium
2. **Inconsistent heading hierarchy** — Visual Design, Low-Medium
3. **Console errors on project load** — Engineering, Medium-High
4. **Small touch targets on nav links** — Accessibility, Medium
5. **Slow API response on project fetch** — Performance, Low-Medium
6. **Overlapping page title and nav on narrow viewport** — UX, Low
7. **No focus indicator on dropdown items** — Accessibility, Medium
8. **Button text color on hover doesn't meet contrast** — Design System, Medium

## False Positive Threshold

- < 20% of opportunities should be non-actionable
- No hallucinated filenames in Build This
- No invented design tokens

## Quality Gates

- `loupe validate` must pass with health > 85 on the fixture
- `loupe analyze --no-ai` must find at least the deterministic opportunities
- `loupe build-this` must produce a valid package (all files present)
