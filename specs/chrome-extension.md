# Product Spec: Chrome Extension

**Status:** v2.0-alpha (shipped)
**Owner:** Collin
**Depends on:** None (standalone recorder)

## Purpose

The Chrome extension is the capture layer of Loupe. It records product sessions and produces `.loupe` files that the CLI analyzes. It is **not** a review tool, a report viewer, or a build orchestrator.

## User Flow

1. User opens the popup (click Loupe icon in toolbar)
2. Permission state shows if mic not granted
3. Ready state: enter Project + Flow, review Agent Workspace config
4. Click Start Recording → content script injected into active tab
5. Recording state: visual health indicators (clicks, screenshots, DOM, audio)
6. User narrates their experience while interacting
7. Click Stop → session saved with stats
8. Saved state: shows stats, primary CTA is "Analyze Session →"
9. Export .loupe is tertiary (available but not promoted)

## States

### Permission State
- Trigger: First open, or mic not granted
- Content: Mic icon, "Microphone Access" title, body text
- Actions: Allow Mic Access (primary), Not now (secondary)
- Transition: → Ready

### Ready State
- Trigger: Mic granted, or "Not now" selected
- Content: "Ready to Record" pill, Project input, Flow input, Agent Workspace card
- Agent Workspace card shows: agent identity badge (color-coded), workspace path, output directory, "Change" link
- Actions: Start Recording (primary), Recent Sessions / Settings / Destination (tertiary links)
- Privacy footer always visible

### Recording State
- Trigger: Click Start Recording
- Content: Red status row (pulsing dot + "Recording" + timer + stop button), current URL, capture health grid (Clicks, Screenshots, Audio/Console/Network)
- Actions: Pause (toggles to Resume), Stop Recording (also accessible via red stop button)
- Live updates: capture health refreshes every 1.5s

### Saved State
- Trigger: Click Stop → recording processed
- Content: Green checkmark, "Session Saved", Project · Flow · Duration, stat grid (Clicks, Screenshots, DOM, Notes)
- Actions: Analyze Session → (primary, copies CLI command to clipboard), Export .loupe file (tertiary)
- Auto-download: .loupe file saved to ~/Downloads/loupe/

### Recovered State
- Trigger: Service worker restarts and finds an interrupted recording
- Content: Explanation that a session was interrupted, options to export or discard
- Actions: Export (primary), Discard (danger)

## Agent Workspace Config

The config overlay (bottom sheet) allows the user to configure per-project:

- **AI Agent:** Claude Code (default), Cursor, Codex, Gemini CLI, Local Folder, Clipboard
- **Workspace Root:** e.g. ~/Projects/PMToolkit
- **Output Directory:** auto-fills per agent (.ai/tasks, .cursor/tasks, etc.)
- **Post Build Action:** Open Folder, Copy Prompt, Run Command, Do Nothing

Config is persisted to `localStorage` and restored on popup open. Agent selection triggers auto-fill of output directory and post action.

## Design Constraints

- Width: 400px (hardcoded)
- Header: 56px, ink (#101317) background
- Body padding: 16px 20px
- Font: Space Grotesk (UI), Spline Sans Mono (data, timers, status)
- Buttons: 46px height, 14px radius
- Cards: 1px #ECEEF1 border, 14px radius
- Agent badges: color-coded per identity (violet for Claude, blue for Cursor, etc.)

## Non-Goals

- The popup will NOT display analysis results
- The popup will NOT run LLM calls
- The popup will NOT show charts or graphs
- The popup will NOT be a report viewer

## Future

- Manual note-taking during recording
- Tab audio capture (in addition to mic)
- Mouse movement heatmap
- Keyboard shortcut for Start/Stop
