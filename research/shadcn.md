# Research: shadcn/ui Design Patterns

**Source:** ui.shadcn.com
**Extracted:** June 2026

## Notable Patterns

### 1. Copy-Paste Components
- Components aren't packaged as a library — they're code you own
- Full control over every aspect
- No abstraction layer between you and the DOM

### 2. Design Token First
- Every visual property is a CSS variable
- `--primary`, `--radius`, `--font-sans`
- Themes are just variable overrides

### 3. Radix Primitive Architecture
- Accessibility primitives (Radix) + visual layer (tailwind) = component
- Behavior and appearance are separated

### 4. Consistent API Surface
- Every component has the same prop pattern
- Predictable without documentation

## Why This Matters for Loupe

shadcn represents "token-first, copy-paste" component architecture. This is what Loupe's design system drift detection should expect: CSS variables for everything, no hardcoded values. It's also the pattern that Build This implementation briefs should reference for component structure.
