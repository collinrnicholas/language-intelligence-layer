# Product Spec: Verify

**Status:** Future (Phase 4)
**Owner:** Collin
**Depends on:** Analyze pipeline, Build This, Scoring engine

## Purpose

After an AI coding agent implements changes, Verify re-records the new build and compares it against the previous version. It measures improvement, scores the new build, and generates a follow-up prompt for remaining issues.

## Input

- Previous `.loupe` session + `opportunities.json` (baseline)
- New `.loupe` session (after implementation)
- Optional: Target design artifact (from Build This)

## Output

### Verification Report

```typescript
interface VerificationReport {
  previousScore: number;
  currentScore: number;
  delta: number;
  resolvedOpportunities: string[];  // IDs of fixed issues
  newOpportunities: string[];       // Issues introduced or missed
  improvedCategories: string[];     // Categories that improved
  declinedCategories: string[];     // Categories that regressed
  remainingIssues: string[];        // High-severity still present
  estimatedScoreAfterNext: number;  // If remaining issues are fixed
  followUpPrompt: string;          // Next implementation brief
}
```

### Flow

1. User clicks "Review New Build" in the Saved state
2. Loupe opens the deployed app in a new tab
3. User re-records a walkthrough of the same flow
4. `loupe analyze` runs on the new session
5. Scores are compared — delta is calculated
6. Report highlights: what improved, what didn't, what regressed
7. Follow-up prompt is generated for remaining issues
8. Loop continues until target score is met

## UX

The button appears in the Saved state after the first Build This package has been generated:

```
✓ Score improved 72 → 91 (+19)

Resolved:
  • button.primary uses non-token color
  • Small touch targets on nav links
  • Inconsistent heading hierarchy

Remaining:
  • Missing focus indicators (High)

Estimated score after next fix: 96

[ Generate Next Prompt → ]
```

## Non-Goals

- Verify does not auto-run — user must explicitly trigger
- Verify does not deploy — it records against whatever is live
- Verify does not block — it reports and suggests, never prevents
