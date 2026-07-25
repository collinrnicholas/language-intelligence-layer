# Loupe Architecture

> An AI Design Engineering Companion that records product sessions, identifies opportunities, and generates implementation-ready packages for AI coding agents.

## System Architecture (current, June 2026)

```
Browser Extension
      │
      ▼  .loupe file  ──────────────►  loupe validate
      │
      ▼  .loupe file
  loupe analyze
      │
      ├── deterministic checks  (no LLM)
      ├── design drift checks   (no LLM)
      ├── AI persona review     (5 reviewers, LLM)
      │
      ▼  opportunities.json + report.html
      │
  ┌────┴────────────────┐
  │                     │
  ▼                     ▼
loupe transcribe    loupe build-this
(audio→notes)       (opportunities→implementation brief)
                         │
                    Destination Router
                         │
                    ┌────┴────┬────┬────┬──────┐
                    │         │    │    │      │
                  Claude    Cursor  Codex Gemini Custom
                  Code                         Command
```

## Components

### 1. Chrome Extension (`extension/`)

Record. Not review.

| File | Role |
|---|---|
| `src/content.ts` | Injected into every page. Captures clicks, scrolls, DOM snapshots, console errors, network timing, SPA route changes. Starts mic via `getUserMedia`. |
| `src/background.ts` | Service worker. Manages recording state, receives events from content script, runs screenshot interval, persists sessions to `chrome.storage.local`, exports `.loupe` files. |
| `offscreen/offscreen.ts` | MV3 offscreen document for mic audio capture (separate DOM context). |
| `src/session-time.ts` | Clock for session-relative timestamps (all events use ms-since-recording-start). |
| `popup/popup.ts` + `popup/index.html` | 5-state popup: Permission, Ready, Recording, Saved, Recovered. Agent Workspace card with config overlay. |

**States:**
- **Permission** — Mic gate on first open.
- **Ready** — Project/Flow inputs, Agent Workspace card (agent identity, workspace path, output dir), Start Recording CTA.
- **Recording** — Red status row with timer, current URL card, capture health grid (clicks, snapshots, audio), Pause/Stop buttons.
- **Saved** — Green checkmark, session stats, Analyze Session CTA (primary), Export .loupe (tertiary).
- **Recovered** — Appears when a service worker restart finds an interrupted recording. Prompt to export or discard.

### 2. Session Schema (`LoupeSession`)

The canonical format — contract between extension → analyzer → report. Single flat JSON object.

```typescript
interface LoupeSession {
  project: string;
  flow: string;
  startedAt: string;          // ISO
  endedAt: string;            // ISO
  urlTimeline: UrlEntry[];    // URL history during recording
  events: SessionEvent[];     // clicks, scrolls, DOM snapshots, errors, network
  screenshots: ScreenshotEntry[]; // JPEG base64 data URLs
  viewport: ViewportInfo;     // single viewport snapshot
  browser: BrowserInfo;       // user agent
  notes: NoteEntry[];         // transcript segments + manual notes
  audioData?: string;         // base64 audio/webm
}
```

See `docs/ARTIFACT_FORMAT.md` for full schema.

### 3. CLI (`agent/`)

| Command | Description |
|---|---|
| `loupe init <project>` | Create project workspace in `~/.loupe/projects/` |
| `loupe validate <file>` | Schema validity, timestamp consistency, health score (0-100) |
| `loupe transcribe <file>` | Run OpenAI Whisper on embedded audio → `NoteEntry[]` |
| `loupe analyze <file>` | Full pipeline: deterministic → drift → AI review → report |
| `loupe build-this <file>` | Generate implementation package + route to destination |
| `loupe target <action>` | Manage Target Design artifacts (`add`, `list`, `show`) |
| `loupe destination <action>` | Manage agent workspace destinations |
| `loupe list` | List projects and sessions |
| `loupe open <project>` | Open latest report |

### 4. Analysis Pipeline

```
.loupe file
    │
    ▼
1. Deterministic checks       (no LLM)
   - Console errors, slow requests, small touch targets,
     SPA navigation health, missing narration
    │
    ▼
2. Design drift checks        (no LLM, requires design-system.json)
   - Non-token colors, font drift, off-scale radii,
     off-scale spacing, non-token shadows
    │
    ▼
3. AI persona review          (LLM, 5 reviewers)
   - Product Manager, Product Designer, Design Systems Lead,
     Accessibility Engineer, Frontend Engineer
   - Each receives same evidence, different lens
   - Results merged + deduped
    │
    ▼
4. Scoring                    (deterministic)
   - 100 base, severity-weighted deductions
   - Per-category scores (UX, Visual Design, Accessibility, ...)
   - Product Experience Score
    │
    ▼
5. Top 5 prioritization       (severity × confidence × narration match)
    │
    ▼
6. HTML report
   - Executive Summary, Score, Top 5, Narrated Findings,
     All Opportunities, Event Timeline, Build This cards
```

### 5. LLM Router (`agent/src/llm/`)

Task-based model selection. Not "one best model." Users choose **intents**
(Build This / UX Review / Complete Audit — see `docs/UX_STATES.md`); Loupe owns
routing internally and never exposes model names in user-facing output.

**Why vision and reasoning are separated:** GPT vision models are strongest at
reading screenshots — proportions, clipping, visible text, current-vs-target
comparison. Claude Sonnet is strongest at product reasoning and writing briefs
a coding agent can execute. So one structured vision pass
(`llm/tasks/vision-observe.ts` → `UIObservation[]` JSON) feeds text-only
reasoning calls — the reasoning model works from structured observations, not
raw images. This is also the latency win: images travel over the wire once.

Routing policy (`llm/routing-policy.ts`, overridable via
`~/.loupe/config/routing-policy.json`):

| Intent | Vision | Reasoning | Judge | Personas |
|---|---|---|---|---|
| Build This | GPT-4.1 | Claude Sonnet | GPT-4.1 (on by default; `judge: null` in policy to disable) | — |
| UX Review | GPT-4.1 | Claude Sonnet | off (no brief to judge) | — |
| Complete Audit | GPT-4.1 | Claude Sonnet | GPT-4.1 | Claude Sonnet |

**Why Complete Audit is the only fanout-heavy path:** the 5-persona review is
the highest-latency, highest-cost stage and exists to maximize recall for a
release gate. Build This and UX Review optimize turnaround: a single
reasoning synthesis over structured observations covers all lenses at once.
The pipeline map is code (`INTENT_PIPELINES`), and tests assert Build This and
UX Review never fan out.

Fallbacks: vision falls back to Claude vision, reasoning falls back to GPT;
both log internally only. Deterministic findings are never discarded because
an AI stage failed. Client↔gateway model mapping and per-stage debug overrides:
see `docs/MODEL_ROUTING_REPORT_2026-07-03.md`.

### 6. Destination Router (`agent/src/destinations/`)

Routes `Build This` packages to AI coding agent workspaces.

| Destination | Output path | Wrapper file |
|---|---|---|
| `local` | `~/Loupe/implementation-packages/<slug>/` | — |
| `claude-code` | `<workspace>/.ai/tasks/<slug>/` | `CLAUDE.md` |
| `cursor` | `<workspace>/.cursor/tasks/<slug>/` | `cursor-prompt.md` |
| `codex` | `<workspace>/.codex/tasks/<slug>/` | `codex-task.md` |
| `gemini` | `<workspace>/.gemini/tasks/<slug>/` | `gemini-task.md` |
| `clipboard` | Copies build-prompt.md to clipboard | — |
| `custom-command` | User-defined command with `{{packagePath}}` interpolation | — |

Config stored in `~/.loupe/config/destinations.json`. Project-level mappings supported.

### 7. Opportunity Reasoning Modes (`agent/src/opportunities/`)

Shared evidence → three modes.

```
Opportunity
     │
     ▼
Shared Context Builder (evidence assembled once)
     │
     ├── Explain     → teach why it matters + design principles
     ├── Redesign    → propose better experience (8 dimensions)
     └── Build This  → generate implementation brief
```

### 8. Implementation Package (`loupe build-this`)

```
implementation/
  summary.md              ← Overview + quick start
  build-prompt.md         ← Full implementation brief (11 sections; + Target Design section if a target was used)
  acceptance-criteria.md  ← Verification checklist (+ target-match criteria)
  findings.json           ← Machine-readable opportunities
  context.json            ← Session context (URLs, notes, events); references targetDesign.id if a target was used
  screenshots/            ← Extracted JPEGs
  design-system.json      ← Project tokens (if available)
  target-design/          ← Target Design artifact copy (if a target was used): target.json, source.<ext>, summary.md
```

### 9. Target Design (`agent/src/target-design/`)

Target Design is the **desired state** and a first-class, persisted artifact (see
`docs/TARGET_DESIGN_INVESTIGATION.md`). One shared service handles it for both
Build This paths — the fast path and the rich path differ only in brief *depth*,
never in target *capability*.

```
Extension "Capture Target Screenshot"            →  session.targetDesign (data URL, in the .loupe)
loupe target add <session|project> <file>        →  ~/.loupe/projects/<p>/targets/<id>/
loupe build-this <session>                           (auto-uses session.targetDesign if present)
loupe build-this <session> --target-design <file>    (creates/reuses an artifact from a file)
loupe build-this <session> --target-id <id>          (reuses a persisted artifact)
```

The extension is the no-CLI path. While recording:
- **Chrome tab** target → open Loupe over that tab, click **Capture Target
  Screenshot** (`chrome.tabs.captureVisibleTab`).
- **Another app** (Figma desktop, Safari, any window/screen) → click **Capture
  from another app / screen…**. That runs `chrome.desktopCapture` (source
  picker) → the offscreen document grabs one `getUserMedia` frame → JPEG. The
  offscreen doc **auto-crops uniform borders** (letterboxing / solid desktop
  background) to reduce noise before storing.

After either capture the popup shows a **preview thumbnail** (a quick confirm) —
recapture if it looks noisy. The buttons double as "recapture" (latest wins).

Either way the shot is embedded in the `.loupe` as `session.targetDesign`, so
`build-this` picks it up with no file and no flag. Precedence: `--target-id` >
`--target-design` > embedded `session.targetDesign`. The desktop picker can
close the popup when the OS takes focus; the background stores the shot anyway
and the popup reflects it on reopen.

| File | Role |
|---|---|
| `target-design/artifact.ts` | Persist/load/list/resolve artifacts; content-addressed ids; session linking; package copy |
| `target-design/index.ts` | Deterministic gap analysis + unified Target Design brief section |
| `llm/tasks/vision-observe.ts` | Current-vs-target vision comparison (image targets) + `aggregateTargetComparison` |

- **Image** targets (`PNG/JPG/WebP`) → current-vs-target vision comparison on both paths.
- **HTML/Markdown** targets → included as target context + deterministic gap, copied into the package on both paths.
- Identity is `t-<sha256[:12]>` of the source, so the same file dedups; one session may build against many targets.

## Key Design Decisions

1. **Flat session format.** `LoupeSession` is a single JSON object, no nested metadata wrappers. Every field is top-level. This makes it trivial to read, diff, and pipe between tools.

2. **Deterministic before AI.** Touch targets, contrast, token drift, console errors — these never hit an LLM. AI is reserved for reasoning tasks where human-like judgment adds value.

3. **Shared evidence.** Explain, Redesign, and Build This consume the same `ReasoningContext` object built once. No duplicate evidence assembly, no drift between modes.

4. **Local-first.** Everything runs on your machine. .loupe files, .env, configurations, destination mappings. SaaS mode is additive — swap two env vars to route through Loupe's API gateway.

5. **Opportunities, not findings.** The noun choice is deliberate — framing as "opportunities" rather than "findings" keeps the tone constructive and action-oriented.

## Storage Layout

```
~/.loupe/
  .env                        ← API keys
  config/
    design-system.json        ← Default design tokens
    destinations.json         ← Destination configurations
  projects/
    <name>/
      sessions/
      reports/
      config/
        design-system.json    ← Per-project token overrides
```

`~/Downloads/loupe/` — auto-downloaded `.loupe` files from the extension.

## Testing

- **Agent tests:** `agent/test/hardening.test.mjs` — 8 tests covering analyze→v2 artifact, build-this consumption, v1 back-compat, quarantine, validate timestamps, path traversal, unique directories, schema rejection, golden fixture.
- **CI:** `.github/workflows/ci.yml` — ubuntu, node 20, `npm ci` → typecheck → build → test.
- **Both workspaces** have `tsc --noEmit` typecheck scripts.
- **No extension browser tests** — known gap. See `docs/ROADMAP.md`.
