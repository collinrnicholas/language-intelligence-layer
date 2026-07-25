# Product Spec: Build This

**Status:** v2.0-alpha (shipped)
**Owner:** Collin
**Depends on:** Implementation Brief engine, Destination Router, Target Design (optional)

## Purpose

Build This generates production-ready implementation packages that AI coding agents (Claude Code, Cursor, Codex, etc.) can execute without rewriting or adding context.

## Input

- One or more `Opportunity` objects (user-selected)
- `LoupeSession` (for evidence and context)
- Goal (e.g. "Minimal changes", "Match target design", "Best-in-class UX")
- Target AI agent (e.g. "Claude Code", "Cursor", "Codex")
- Optional: Target design artifact (PNG, JPG, WebP, HTML, Markdown spec)

## Output

### Implementation Package (filesystem directory)

```
implementation/
  summary.md              ← Overview + quick start command
  build-prompt.md         ← Full implementation brief (11 sections)
  acceptance-criteria.md  ← Testable checklist
  findings.json           ← Machine-readable opportunities
  context.json            ← Session context + target design metadata
  screenshots/            ← Extracted JPEGs from session
  design-system.json      ← Project tokens (if available)
  target-design/          ← Optional: target design artifact
```

### implementation-brief.md (11 sections)

1. **Executive Summary** — What is changing and why
2. **Current State** — Existing implementation summary
3. **Problems** — Referenced opportunities with evidence
4. **Desired Outcome** — Target experience
5. **Design System Constraints** — Colors, spacing, typography, radius, components
6. **Files Likely Affected** — Logical areas inferred from URLs and selectors
7. **Components** — Existing, new, modified
8. **Interaction Changes** — Behavior changes
9. **Visual Changes** — Spacing, layout, hierarchy, alignment, typography, color, motion
10. **Accessibility Requirements**
11. **Acceptance Criteria**

### Optional: Target Design Section (when --target-design is provided)

- Gap analysis (6 dimensions: layout, hierarchy, spacing, typography, color, components, interaction)
- Implementation guidance (keep, replace, modify components, CSS/tokens to update, layout structure)
- Acceptance criteria specific to the target match
- Target artifact copied to `target-design/` in the package

## Multi-Opportunity Workflow

When multiple opportunities are selected:
1. Merge overlapping recommendations (same selector + category → dedup)
2. Remove duplicates
3. Generate one coherent implementation plan
4. Acceptance criteria are merged and deduplicated

## Destination Routing

After package generation, the Destination Router resolves the target and:
1. Packages are written to the configured workspace directory
2. Provider-specific wrapper files are generated (CLAUDE.md, cursor-prompt.md, codex-task.md, etc.)
3. Post-action is executed (open folder, copy prompt, run command)

## Design

- Provider-agnostic core with adapter layer for each AI coding agent
- Acceptance criteria must be testable and specific (not "make it better")
- Token names must be verified against loaded design system
- File inference describes logical areas, not invented filenames
