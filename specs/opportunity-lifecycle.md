# Product Spec: Opportunity Lifecycle

**Status:** v2.0-alpha (shipped)
**Owner:** Collin
**Depends on:** All analysis modes

## Purpose

Documents the lifecycle of an Opportunity — from raw session data through identification, explanation, redesign, and implementation. This is the core data model that flows through every Loupe feature.

## Lifecycle

```
Session event data
    │
    ▼
Deterministic check    ← Console error, color drift, font drift, touch target, etc.
    │
    ▼
Opportunity born       ← { id, category, severity, title, description, observed, expected, evidence }
    │
    ├── Explain         ← Design principles + confidence + best-in-class patterns
    ├── Redesign        ← Proposed experience + impact + design system impact
    └── Build This      ← Implementation brief + acceptance criteria
    │
    ▼
Implementation package  ← summary.md, build-prompt.md, acceptance-criteria.md, etc.
    │
    ▼
Agent workspace         ← Claude Code / Cursor / Codex
    │
    ▼
Verify (future)         ← Re-record → compare score → follow-up
    │
    ▼
Resolved / Archived     ← Closure
```

## Opportunity Schema

```typescript
interface Opportunity {
  id: string;                          // auto-generated: "<check-type>-<index>"
  category: OpportunityCategory;       // UX, Visual Design, Accessibility, etc.
  severity: OpportunitySeverity;       // Critical, High, Medium, Low, Info
  title: string;                       // Short human-readable
  description: string;                 // What was observed
  page?: string;                       // URL where detected
  timestamp?: number;                  // Session-relative ms
  selector?: string;                   // CSS selector of affected element
  whyItMatters?: string;               // User-facing impact
  suggestedFix?: string;               // What to change
  confidence?: number;                 // 0-1
  observed?: string;                   // What the value was
  expected?: string;                   // What it should be
  screenshotIndex?: number;            // Reference into session screenshots array
  evidence?: Evidence;                 // Proof package
  implementationPrompt?: string;       // Claude Code / Codex ready prompt
  acceptanceCriteria?: string[];       // Verification checklist
  designTokens?: string[];             // Referenced tokens
  reviewedBy?: string[];              // Which AI personas flagged this
}
```

## Evidence Object

```typescript
interface Evidence {
  screenshotIndex: number;
  domSnapshotTimestamp: number;
  events: number[];            // Event indices in session
  url: string;
  selector: string;
}
```

Evidence is required for all non-AI opportunities. AI opportunities inherit evidence from their context window. Evidence is what makes opportunities actionable — without it, they're opinions.

## Categories

| Category | Examples |
|---|---|
| UX | Task friction, cognitive load, workflow clarity, decision points |
| Visual Design | Hierarchy, visual balance, spacing, typography, affordance |
| Accessibility | WCAG, contrast, labels, keyboard/touch targets |
| Performance | Console errors, network latency, bundle issues |
| Design System | Token drift, component inconsistency, pattern reuse |
| Interaction | Click targets, scroll behavior, animation, feedback |
| Content | Label clarity, error messages, empty states |
| Engineering | Maintainability, CSS implementation, state management |

## Severity

| Level | Points | Critera |
|---|---|---|
| Critical | -20 | Blocks core flow. Data loss. WCAG failure. Accessibility violation. |
| High | -10 | Major usability friction. Design inconsistency. Performance issue. |
| Medium | -5 | Minor friction. Token drift. Missed pattern. |
| Low | -2 | Cosmetic. Non-blocking. Preference. |
| Info | 0 | Observation. Suggestion. No action needed. |

## Scoring

Base: 100

After all deductions: `Math.max(0, 100 + totalDeductions)`

Category scores track deductions per category independently.

## Deduplication

When merging opportunities from multiple sources (e.g., 5 AI reviewers):
1. Same URL + same selector + similar title → merge
2. Same timestamp ±5s + same category → possible merge
3. Merged opportunities retain `reviewedBy` attribution from all sources
4. Confidence is averaged (weighted by reviewer count)
