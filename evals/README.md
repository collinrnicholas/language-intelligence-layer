# Loupe Evaluation Scaffolding

This directory contains the evaluation framework for measuring Loupe's output quality.

## Structure

```
evals/
  fixtures/       ← .loupe session files for benchmarking
  scorecards/     ← Manual evaluation scorecards
  results/        ← Eval run results
  prompts/        ← Eval prompts for A/B testing
  README.md       ← This file
```

## How to Run an Evaluation

1. Record a session and save the `.loupe` file to `fixtures/`
2. Run `loupe analyze` on the fixture
3. Score the output using the rubric in `docs/EVAL_RUBRIC.md`
4. Save the scorecard to `scorecards/`
5. Move any generated artifacts to `results/`

## Future: `loupe eval`

The evaluation rubric is designed to be automatable. Future `loupe eval` command will:

1. Load a fixture session
2. Run the full analysis pipeline
3. Score each dimension automatically
4. Compare against previous runs
5. Output a structured scorecard JSON
