# Product Spec: Redesign

**Status:** v2.0-alpha (shipped)
**Owner:** Collin
**Depends on:** Shared Context Builder, LLM Router

## Purpose

Redesign shows how a senior product designer would improve the experience. It is NOT implementation. It is product and UX thinking.

## Input

- `Opportunity` (same as Explain)
- `ReasoningContext` (same as Explain)
- Design system tokens

## Output

```typescript
interface RedesignOutput {
  goal: string;                        // What experience should improve
  currentExperience: string;           // Summary of current flow
  proposedExperience: {                // At least 4 of 8 dimensions
    layout: string;
    spacing: string;
    hierarchy: string;
    interaction: string;
    content: string;
    navigation: string;
    visualWeight: string;
    informationArchitecture: string;
  };
  userImpact: string;                  // Why this improves usability
  designSystemImpact: {                // Changes needed
    newComponents: string[];
    modifiedComponents: string[];
    tokenChanges: string[];
    spacingChanges: string[];
    interactionChanges: string[];
  };
  risks: string[];                     // Tradeoffs and constraints
}
```

## Quality Bar

- 4+ dimensions must be addressed concretely (no "improve the design")
- User impact must be stated in terms of user behavior, not UI changes
- Design system impact must reference real token names
- Risks must be honest — no forced tradeoffs

## AI Enrichment

Redesign uses premium multimodal reasoning (Claude Sonnet-class). It receives the full evidence context including screenshot references and design system tokens. The prompt instructs it to think like a senior Product Designer evaluating a walkthrough.

## Non-Goals

- Redesign does not generate code or CSS
- Redesign does not produce implementation estimates
- Redesign does not compare to competitors unless relevant
