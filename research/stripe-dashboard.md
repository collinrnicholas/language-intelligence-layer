# Research: Stripe Dashboard

**Source:** dashboard.stripe.com
**Extracted:** June 2026

## Notable Patterns

### 1. Data-Dense but Navigable
- High information density in tables and lists
- Consistent column widths, alignment, and typography
- Row hover states provide clarity without animation

### 2. System Status Indicator
- Green dot + "All systems normal" in header
- Communicates trust without asking

### 3. Search-Over-Navigation
- Search is primary navigation, not secondary
- Command palette (Cmd+K) is universal

### 4. Progressive Detail
- List view shows summary
- Click reveals detail panel (slides in from right)
- Never destroys the list context

### 5. Empty States
- Every empty state has: illustration, title, body text, CTA
- No bare "No results" messages

## Why This Matters for Loupe

Stripe sets the standard for "enterprise polish without clutter." Empty states are a particular gap in most products that Loupe should flag.
