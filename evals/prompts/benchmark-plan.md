# Benchmark Plan

Sessions to record and evaluate for establishing a baseline.

## Baseline Sessions

| # | Product | Flow | Duration | Goal | Key risks |
|---|---|---|---|---|---|
| 1 | **PM Toolkit** | Create a new project | 30-45s | Observe the project creation flow. Note cognitive load and decision points. | Complex multi-step form, several dropdowns, tags input. |
| 2 | **FitHub** | Log a workout | 30-45s | Log a workout and check the progress dashboard. | Data-heavy dashboard, charts, date pickers. |
| 3 | **Loupe** | Record → analyze → build-this | 60s | Full loop: record a Loupe session, analyze it, run build-this. | Recursive — Loupe evaluating itself. Interesting meta-test. |
| 4 | **Linear** | Create and assign an issue | 30s | Create a new issue, assign it, add a label. | Mature design system. Clean UI. Should score high. |

## Evaluation Runs

For each session:

1. Record → get `.loupe` file
2. `loupe analyze` → get `opportunities.json` + report.html
3. Score manually using `evals/scorecards/template.md`
4. Save scorecard to `evals/scorecards/<product>-<date>.md`
5. Save result JSON to `evals/results/<product>-<date>.json`
6. Copy fixture to `evals/fixtures/<product>-<date>.loupe`

## Baseline Target

| Product | Expected Total Score | Notes |
|---|---|---|
| PM Toolkit | 65-75 | Complex app, likely medium-high opportunity count |
| FitHub | 70-80 | Fewer features, more polished |
| Loupe | 60-70 | Self-review is the hardest test |
| Linear | 80-90 | Industry leader, should expose subtle issues only |

## Regression Testing

After any code change that affects analysis output:

1. Re-run `loupe analyze` on all baseline fixtures
2. Compare `opportunities.json` to previous run
3. Note any opportunities that appear or disappear
4. Flag false positive increases

## Automation Plan

Phase 1: Manual scoring using scorecard template
Phase 2: Semi-automated with `loupe eval --fixture fixture.loupe --scorecard-output results/`
Phase 3: CI-integrated: `loupe eval --fixture fixtures/*.loupe --compare baseline.json`
