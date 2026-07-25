# Benchmark: FitHub

**Product:** FitHub (fithub.app)
**Flow:** Log a workout and check progress dashboard
**Fixture:** `benchmarks/fithub/<date>.loupe`

## Expected Opportunity Count

| Category | Min | Expected | Max |
|---|---|---|---|
| Critical | 0 | 0 | 1 |
| High | 1 | 2 | 3 |
| Medium | 3 | 5 | 7 |
| Low | 3 | 4 | 6 |
| Info | 0 | 1 | 2 |
| **Total** | **8** | **12** | **18** |

## Expected Score

| Dimension | Score |
|---|---|
| Explain | /25 | ≥ 88% |
| Redesign | /25 | ≥ 82% |
| Build This | /25 | ≥ 85% |
| Overall | /25 | ≥ 82% |
| **Total** | **/100** | **≥ 84** |

## Key Opportunities to Find

1. **Chart tooltip contrast** — Accessibility, Low-Medium
2. **Workout date picker UX** — UX, Low
3. **Progress dashboard spacing** — Visual Design, Low
4. **Export button visibility** — UX, Medium

## False Positive Threshold

- < 15% non-actionable (simpler product, fewer edge cases)
