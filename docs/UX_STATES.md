# Loupe UX States & User Intents

Loupe is outcome-driven: users choose **what they want to accomplish**, never a
processing mode or a model. Internal pipelines and routing live in
`agent/src/llm/routing-policy.ts`; this doc is the user-facing contract.

## The three intents

| Intent | Command | What the user gets | Target latency |
|---|---|---|---|
| ⚡ **Build This** | `loupe build-this <session>` | An implementation package (`build-prompt.md`) for their AI coding agent. | 30–60 s |
| 👁 **UX Review** | `loupe review <session>` | Opportunities with evidence — what to improve and why, with Explain / Redesign / Build This per opportunity. | 1–2 min |
| 🔍 **Complete Audit** | `loupe audit <session>` | Comprehensive pre-ship review: 5-persona fanout, judge pass, merged audit. | 3–5+ min |

- **Build This** is for users who already know what they want changed (or have
  a target design — then it runs Target Design Mode via current-vs-target
  vision comparison). Works directly on a fresh `.loupe` session with no prior
  analysis; if a review/audit artifact exists, it uses that richer evidence.
- **UX Review** is for "tell me what's wrong and why." One vision pass + one
  reasoning synthesis — no persona fanout.
- **Complete Audit** is the release gate — the only path that fans out to the
  five persona reviewers and runs the judge.

`loupe analyze` remains as the neutral entry point (`--intent review|audit`,
default `review`). Never expose `--fast` / `--full` / `--deep`-style mode
language in UI or docs — internal flags exist for debugging only.

## Chrome extension popup states

Views: **Capture** (default) · **Sessions** · **Exports** · **Settings**.

Capture panel states:

1. **Mic intro** (first run only) — explains narration; per-site permission is
   requested at record time.
2. **Ready** — Project, Flow/Page, Start Recording. No mode choices, no agent
   configuration: Loupe's responsibility ends at writing `build-prompt.md`.
3. **Recording** — timer, live capture health, pause/stop, stuck-capture warning.
4. **Session Captured** — the intent moment. Three action cards:
   - ⚡ Build This (primary, "Fastest") — copies `loupe build-this <file>`
   - 👁 UX Review ("For exploration") — copies `loupe review <file>`
   - 🔍 Complete Audit ("Deep") — copies `loupe audit <file>`
   Plus small text actions: Export .loupe · Record another. Export is never
   the primary action.
5. **Recovered** — an interrupted recording; resume / export / discard
   (discard is always an explicit user choice).

The popup copies commands rather than running pipelines: the extension records
and hands off; the CLI analyzes and writes the build prompt; the user's agent
or automation picks it up. Loupe never manages, names, or executes the
downstream coding agent.

## Language rules

Use: Build This, UX Review, Complete Audit, Build Prompt, Prompt Output,
Recent Sessions, Exports, Build Prompt Destination.

Avoid in anything user-facing: fast/full/deep path, quick mode, model names,
Agent Workspace, AI Agent, Workspace Root, persona-reviewer internals.
