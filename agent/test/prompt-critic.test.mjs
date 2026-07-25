import test from 'node:test';
import assert from 'node:assert/strict';

const { parsePromptCriticResponse } = await import('../dist/ai/prompt-critic.js');

const scores = {
  productUnderstanding: 8,
  uxReasoning: 8,
  missingContext: 7,
  ambiguity: 8,
  specificity: 8,
  confidence: 8,
};

const BRIEF = `# Implementation Brief

> **Goal:** Best-in-class UX

## Goal & Context

Old vague goal prose.

## BUILD — Narrated Findings (1)

### B1. [High] Documents Not Fully Visible
**What the reviewer said:**
> "proposal bid is halfway off the screen."

**Current measured state:** overflowX: hidden

**Acceptance:** documents fully visible.

## Definition of Done

- [ ] Documents Not Fully Visible — resolved
`;

test('prompt critic applies a prose section rewrite in place', () => {
  const parsed = parsePromptCriticResponse(`\`\`\`json
{
  "overallScore": 8,
  "scores": ${JSON.stringify(scores)},
  "rationale": "Prose is vague.",
  "issues": ["Goal & Context is vague"],
  "sectionRewrites": [
    { "heading": "Goal & Context", "newBody": "Sharp, concrete goal prose." }
  ]
}
\`\`\``, BRIEF);

  assert.ok(parsed);
  assert.equal(parsed.overallScore, 8);
  assert.equal(parsed.applied, true);
  assert.match(parsed.reviewedBriefMarkdown, /Sharp, concrete goal prose\./);
  assert.doesNotMatch(parsed.reviewedBriefMarkdown, /Old vague goal prose\./);
  // Per-finding evidence and structure are untouched.
  assert.match(parsed.reviewedBriefMarkdown, /proposal bid is halfway off the screen/);
  assert.match(parsed.reviewedBriefMarkdown, /### B1\. \[High\] Documents Not Fully Visible/);
  assert.match(parsed.reviewedBriefMarkdown, /overflowX: hidden/);
});

test('prompt critic refuses to rewrite a protected BUILD section', () => {
  const parsed = parsePromptCriticResponse(JSON.stringify({
    overallScore: 8,
    scores,
    rationale: 'Trying to gut the findings.',
    issues: [],
    sectionRewrites: [
      { heading: 'BUILD — Narrated Findings (1)', newBody: '### B1. Accessibility gaps\nsomething invented' },
    ],
  }), BRIEF);

  assert.ok(parsed);
  assert.equal(parsed.applied, false);
  // Original finding content survives; the invented one never lands.
  assert.match(parsed.reviewedBriefMarkdown, /Documents Not Fully Visible/);
  assert.doesNotMatch(parsed.reviewedBriefMarkdown, /Accessibility gaps/);
  assert.ok(parsed.changesMade.some(c => c.startsWith('[critic-guard]')));
});

test('prompt critic leaves the brief untouched at or above the pass threshold', () => {
  const parsed = parsePromptCriticResponse(JSON.stringify({
    overallScore: 9,
    scores,
    rationale: 'Ships as-is.',
    issues: [],
    sectionRewrites: [
      { heading: 'Goal & Context', newBody: 'Should be ignored at score 9.' },
    ],
  }), BRIEF);

  assert.ok(parsed);
  assert.equal(parsed.applied, false);
  assert.equal(parsed.reviewedBriefMarkdown, BRIEF);
});

test('prompt critic parser rejects incomplete score objects', () => {
  const parsed = parsePromptCriticResponse(JSON.stringify({
    overallScore: 8,
    scores: { productUnderstanding: 8 },
    sectionRewrites: [],
  }), '# Original');

  assert.equal(parsed, null);
});
