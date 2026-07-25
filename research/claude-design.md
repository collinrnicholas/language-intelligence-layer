# Research: Claude Design Patterns

**Source:** claude.ai (designed by Anthropic)
**Extracted:** June 2026

## Notable Patterns

### 1. Minimal Left Rail
- Thin (56px) vertical left rail with icon-only navigation
- No text labels visible until hover
- Communicates depth via subtle color changes

### 2. Content-First Layout
- Conversations take full remaining width
- No sidebars or secondary panels competing for attention
- User focus is always on what they're doing

### 3. Inline vs Modal
- Prefers inline over modal for most interactions
- Settings, model selection, and file upload are inline panels
- Avoids modal overlays that break context

### 4. Typographic Hierarchy
- Large display text for titles (27px, 700 weight)
- Very small secondary info (11px monospace)
- Clear separation between user and assistant messages

### 5. Color System
- Almost monochrome — gray-based with one accent (orange)
- Color used sparingly: only for the Claude logo and activity indicator
- Low visual noise, high information density

## Why This Matters for Loupe

Claude.ai demonstrates "content-first minimalism" — the UI steps out of the way of the task. For Loupe benchmarks, this is the reference for reducing visual noise and focusing on primary content.
