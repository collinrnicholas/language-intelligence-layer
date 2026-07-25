# Loupe Artifact Format

This document defines the canonical artifact formats in Loupe: the `.loupe` session file, the `opportunities.json` analysis artifact, and the `target.json` Target Design artifact.

---

## Session File (`.loupe`)

The `.loupe` file is the raw output of a recording session. It is produced by the Chrome extension and consumed by `loupe validate`, `loupe transcribe`, `loupe analyze`, and `loupe build-this`.

### Format

```json
{
  "session": {
    "project": "PM Toolkit",
    "flow": "Dashboard Redesign",
    "startedAt": "2026-06-27T12:00:00.000Z",
    "endedAt": "2026-06-27T12:01:38.000Z",
    "urlTimeline": [
      { "url": "https://thepmtoolkit.app/dashboard", "timestamp": 0, "navigationType": "initial" },
      { "url": "https://thepmtoolkit.app/projects", "timestamp": 4200, "navigationType": "pushstate" }
    ],
    "events": [
      { "type": "click", "timestamp": 1500, "selector": "a.nav-link", "x": 120, "y": 45, "tagName": "a", "textContent": "Projects" },
      { "type": "scroll", "timestamp": 3200, "scrollX": 0, "scrollY": 450, "maxScrollX": 0, "maxScrollY": 2400 },
      { "type": "dom_snapshot", "timestamp": 2000, "url": "https://thepmtoolkit.app/dashboard", "html": "<div>...", "computedStyles": { "button.primary": { "color": "#12C97E", ... } } },
      { "type": "console_error", "timestamp": 3800, "message": "Uncaught TypeError: Cannot read properties of null", "source": "bundle.js:1423" },
      { "type": "network", "timestamp": 4100, "url": "https://api.thepmtoolkit.app/projects", "duration": 1200, "initiatorType": "fetch" }
    ],
    "screenshots": [
      { "timestamp": 0, "dataUrl": "data:image/jpeg;base64,/9j/..." },
      { "timestamp": 2000, "dataUrl": "data:image/jpeg;base64,/9j/..." }
    ],
    "viewport": { "width": 1512, "height": 861 },
    "browser": { "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    "notes": [
      { "type": "transcript", "timestamp": 1500, "endTimestamp": 3500, "text": "This dashboard feels cluttered, I can't find the new project button.", "source": "audio", "confidence": 0.94 }
    ],
    "audioData": "data:audio/webm;base64,GkX..."
  }
}
```

### Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `session.project` | string | yes | Project name (user-defined during recording) |
| `session.flow` | string | yes | Flow name (user-defined during recording) |
| `session.startedAt` | ISO 8601 | yes | Recording start time |
| `session.endedAt` | ISO 8601 | yes | Recording end time |
| `session.urlTimeline` | UrlEntry[] | yes | URL navigation history |
| `session.events` | SessionEvent[] | yes | User interaction events |
| `session.screenshots` | ScreenshotEntry[] | yes | Periodic screenshots |
| `session.viewport` | ViewportInfo | yes | Viewport dimensions at start |
| `session.browser` | BrowserInfo | yes | User agent string |
| `session.notes` | NoteEntry[] | yes | Narration transcripts + manual notes |
| `session.audioData` | string | no | Base64-encoded audio/webm blob |
| `session.targetDesign` | string \| object | no | Desired-state target from the extension's "Capture Target Screenshot". When present and no `--target-design`/`--target-id` is given, `build-this` builds against it automatically (Target Design Mode). A bare **string** is the legacy shape (data URL only). The current **object** shape adds provenance + dimensions: `{ dataUrl, sourceKind: "chrome-tab"｜"desktop", capturedAtMs, width, height }` (images are downscaled to a long edge ≤ 2560 at capture). Both shapes are accepted. |

### Event Types

All events share `type` and `timestamp` (session-relative ms). Additional fields per type:

**ClickEvent:**
```json
{ "type": "click", "timestamp": 1500, "selector": "a.nav-link", "x": 120, "y": 45, "tagName": "a", "textContent": "Projects", "href": "https://..." }
```

**ScrollEvent:**
```json
{ "type": "scroll", "timestamp": 3200, "scrollX": 0, "scrollY": 450, "maxScrollX": 0, "maxScrollY": 2400 }
```

**DomSnapshotEvent:**
```json
{ "type": "dom_snapshot", "timestamp": 2000, "url": "https://...", "html": "<div class=\"app\">...", "computedStyles": { "button.primary": { "color": "#12C97E", "fontSize": "14px" } } }
```

**ConsoleErrorEvent:**
```json
{ "type": "console_error", "timestamp": 3800, "message": "Uncaught TypeError: ...", "source": "bundle.js:1423" }
```

**NetworkEvent:**
```json
{ "type": "network", "timestamp": 4100, "url": "https://api...", "duration": 1200, "initiatorType": "fetch" }
```

### Note Types

**Transcript** (from `loupe transcribe`):
```json
{ "type": "transcript", "timestamp": 1500, "endTimestamp": 3500, "text": "This feels cluttered.", "source": "audio", "confidence": 0.94 }
```

**Manual** (future — from extension note-taking):
```json
{ "type": "manual", "timestamp": 5000, "text": "Check mobile layout here." }
```

### Timestamp Contract

- All event timestamps are session-relative milliseconds (0 = recording start).
- Screenshot timestamps use the same clock as events.
- Note timestamps use the same clock.
- This means ±5s evidence windows work correctly across all data types.
- `loupe validate` checks that max timestamp ≈ expected duration × 1000.

---

## Analysis Artifact (`opportunities.json`)

Produced by `loupe analyze`. Stored alongside the report HTML.

### Format (v2)

```json
{
  "version": 2,
  "analyzedAt": "2026-06-27T12:05:00.000Z",
  "sessionFile": "relative/path/to/session.loupe",
  "screenshots": [
    "screenshots/000.jpg",
    "screenshots/001.jpg"
  ],
  "project": "PM Toolkit",
  "flow": "Dashboard Redesign",
  "score": {
    "overall": 72,
    "categories": [
      { "category": "UX", "score": 65, "deductions": -35, "findingCount": 7 },
      { "category": "Visual Design", "score": 80, "deductions": -20, "findingCount": 4 },
      { "category": "Accessibility", "score": 90, "deductions": -10, "findingCount": 2 },
      { "category": "Performance", "score": 85, "deductions": -15, "findingCount": 3 },
      { "category": "Design System", "score": 70, "deductions": -30, "findingCount": 6 },
      { "category": "Interaction", "score": 95, "deductions": -5, "findingCount": 1 },
      { "category": "Content", "score": 100, "deductions": 0, "findingCount": 0 },
      { "category": "Engineering", "score": 75, "deductions": -25, "findingCount": 5 }
    ],
    "totalFindings": 28
  },
  "reviewedBy": ["Product Manager", "Product Designer", "Design Systems Lead", "Accessibility Engineer", "Frontend Engineer"],
  "opportunities": [
    {
      "id": "drift-color-3",
      "category": "Design System",
      "severity": "Medium",
      "title": "button.primary uses non-token color",
      "description": "The color \"#13C47A\" on button.primary does not match any design system token.",
      "page": "https://thepmtoolkit.app/dashboard",
      "timestamp": 2200,
      "selector": "button.primary",
      "whyItMatters": "Non-token colors create inconsistencies...",
      "suggestedFix": "Replace with --green (#12C97E)",
      "confidence": 0.85,
      "observed": "#13C47A",
      "expected": "#12C97E (--green)",
      "screenshotIndex": 1,
      "evidence": {
        "screenshotIndex": 1,
        "domSnapshotTimestamp": 2000,
        "events": [12],
        "url": "https://thepmtoolkit.app/dashboard",
        "selector": "button.primary"
      }
    }
  ],
  "top5": [
    { ... },
    { ... }
  ]
}
```

### Format (v1 — legacy)

```json
{
  "version": 1,
  "session": { ... },        // full LoupeSession embedded
  "findings": [ ... ],
  "screenshots": [ ... ]    // base64 data URLs
}
```

Both formats are accepted by `loupe build-this`. v2 is the default output.

### Schema Evolution

| Version | Date | Changes |
|---|---|---|
| 1 | June 2026 | Initial format. Session embedded, screenshots as base64. |
| 2 | June 2026 | Session referenced by relative path. Screenshots as file paths. Added score, top5, reviewedBy. |

---

## Target Design Artifact (`target.json`)

The **desired state** a session is built toward. A first-class, persisted artifact (not a transient CLI argument — see `docs/TARGET_DESIGN_INVESTIGATION.md`). Produced by `loupe target add` or implicitly by `loupe build-this --target-design <file>`, and consumed by `loupe build-this --target-id <id>`.

### Storage layout

```
~/.loupe/projects/<project>/targets/<target-id>/
  target.json     ← the artifact record (below)
  source.<ext>    ← the original design file, copied in (source.png | source.html | source.md | …)
  summary.md      ← human-readable summary
```

The `<target-id>` is content-addressed: `t-` + the first 12 hex chars of the source's SHA-256. Adding the same file twice resolves to the same id (dedup).

### Format

```json
{
  "id": "t-43be52f97ed3",
  "project": "PM Toolkit",
  "name": "Dashboard Redesign Mockup",
  "sourceType": "image",
  "sourceFile": "source.png",
  "sourcePath": "/Users/you/Desktop/mockup.png",
  "createdAt": "2026-07-04T18:48:59.623Z",
  "linkedSessionIds": ["s-e9f5737ce514"],
  "notes": "Approved concept from design review",
  "hash": "43be52f97ed308911037af5b5cc41f02117f6e22cc86f42c9fcb3387af06de49"
}
```

### Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | `t-<sha256[:12]>` of the source content |
| `project` | string | yes | Owning project |
| `name` | string | yes | Display name (defaults to the source filename) |
| `sourceType` | `image` \| `html` \| `markdown` | yes | Derived from the source extension |
| `sourceFile` | string | yes | The `source.<ext>` filename inside the artifact dir (authoritative — the dir is never scanned) |
| `sourcePath` | string | yes | Original path supplied by the user (provenance). **Redacted to its basename in packaged copies** — see below |
| `createdAt` | ISO 8601 | yes | Creation time |
| `linkedSessionIds` | string[] | yes | Sessions built against this target (`s-<sha256[:12]>` of project+flow+startedAt) |
| `notes` | string | yes | Free-text notes (may be empty) |
| `hash` | string | yes | Full SHA-256 of the source content |

### In the implementation package

Every `build-this` package built against a target includes a copy of the artifact:

```
<package>/target-design/
  target.json     ← sourcePath REDACTED to basename (packages carry no local filesystem paths)
  source.<ext>
  summary.md      ← "Original file" line also redacted to basename
```

and `context.json` references it: `"targetDesign": { "id": "t-…", "name": "…", "sourceType": "…", "format": "…", "file": "target-design/source.<ext>", "record": "target-design/target.json" }`.

The canonical store under `~/.loupe/projects/<p>/targets/<id>/` retains the full absolute `sourcePath` for provenance; only the copies that ship inside a package are redacted (they are handed to coding agents).

### Cross-project reuse

`build-this --target-id <id>` resolves within the session's project by default. Because ids are content hashes, the same design added to two projects yields the same id in each; to build against a target owned by a *different* project, pass `--allow-cross-project-target` (a warning is printed).
