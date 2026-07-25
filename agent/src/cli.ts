#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Canonical .loupe Session Types ──────────────────────────────
//
// Mirrors extension/src/types.ts — the contract between extension → analyzer → report.

export interface LoupeSession {
  project: string;
  flow: string;
  startedAt: string;
  endedAt: string;
  urlTimeline: UrlEntry[];
  events: SessionEvent[];
  screenshots: ScreenshotEntry[];
  viewport: ViewportInfo;
  browser: BrowserInfo;
  notes: NoteEntry[];
  audioData?: string;
  /** Optional target design captured in the extension ("Capture Target
   *  Screenshot") — the desired state. When present and no explicit
   *  --target-design/--target-id is given, build-this uses it. A bare string is
   *  the legacy shape (data URL only); the object adds provenance + dimensions. */
  targetDesign?: string | TargetDesignCapture;
}

export interface TargetDesignCapture {
  dataUrl: string;
  sourceKind?: 'chrome-tab' | 'desktop';
  capturedAtMs?: number;
  width?: number;
  height?: number;
}

export interface UrlEntry {
  url: string;
  timestamp: number;
  navigationType: 'pushstate' | 'popstate' | 'hashchange' | 'hard' | 'initial';
}

export type SessionEvent =
  | { type: 'click'; timestamp: number; selector: string; x: number; y: number; tagName: string; textContent: string; href?: string }
  | { type: 'scroll'; timestamp: number; scrollX: number; scrollY: number; maxScrollX: number; maxScrollY: number }
  | { type: 'dom_snapshot'; timestamp: number; url: string; html: string; computedStyles: Record<string, Record<string, string>> }
  | { type: 'console_error'; timestamp: number; message: string; source: string }
  | { type: 'network'; timestamp: number; url: string; duration: number; initiatorType: string };

export interface ScreenshotEntry {
  timestamp: number;
  dataUrl: string;
}

export interface ViewportInfo {
  width: number;
  height: number;
}

export interface BrowserInfo {
  userAgent: string;
}

export interface NoteEntry {
  type: 'transcript' | 'manual';
  timestamp: number;
  endTimestamp?: number;
  text: string;
  source?: string;
  confidence?: number;
}

// ─── Analysis Types ──────────────────────────────────────────────

export type OpportunityCategory =
  | 'UX'
  | 'Visual Design'
  | 'Accessibility'
  | 'Performance'
  | 'Design System'
  | 'Interaction'
  | 'Content'
  | 'Engineering';

export type OpportunitySeverity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Info';

export interface Evidence {
  screenshotIndex?: number;
  domSnapshotTimestamp?: number;
  events: number[];           // event indices in session.events[]
  url?: string;
  selector?: string;
}

export interface Opportunity {
  id: string;
  category: OpportunityCategory;
  severity: OpportunitySeverity;
  title: string;
  description: string;
  page: string;
  timestamp: number;
  selector: string;
  whyItMatters: string;
  suggestedFix: string;
  confidence: number;         // 0-1
  observed?: string;          // for drift findings — what was actually found
  expected?: string;          // for drift findings — what the design system specifies
  screenshotIndex?: number;   // index into session.screenshots[]
  evidence?: Evidence;
  implementationPrompt?: string;  // Claude Code / Codex ready prompt
  acceptanceCriteria?: string[];  // checklist items for verification
  designTokens?: string[];        // tokens referenced in the fix
  narrated?: boolean;             // judged (in analyze): did the reviewer narrate this concern?
  narrationNote?: number;         // index into session.notes of the supporting quote
  fixKind?: 'functional' | 'visual' | 'layout' | 'content';  // nature of the fix (generated)
  generatedTarget?: string;       // per-finding LLM target (replaces templates)
  generatedTask?: string;         // per-finding imperative task line (generated)
  generatedAcceptance?: string[]; // per-finding acceptance checks (generated)
}

// ─── CLI ───────────────────────────────────────────────────────

const program = new Command();

program
  .name('loupe')
  .description('UX session analyzer — inspect the details no one else catches')
  .version('2.0.0');

program
  .command('init <project-name>')
  .description('Create a new project workspace in ~/.loupe/')
  .action(async (name) => {
    const { initProject } = await import('./commands/init.js');
    await initProject(name);
  });

program
  .command('validate <session-file>')
  .description('Validate a .loupe session file and report health score')
  .action(async (file) => {
    const { validateSession } = await import('./commands/validate.js');
    await validateSession(resolve(file));
  });

program
  .command('process <session-file>')
  .description('Read, redact, and validate a .loupe session file')
  .option('-p, --project <name>', 'Assign to a project')
  .action(async (file, opts) => {
    const { processSession } = await import('./pipeline/process.js');
    await processSession(resolve(file), opts.project);
  });

program
  .command('analyze <session-file>')
  .description('Analyze a session (defaults to the UX Review pipeline)')
  .option('-o, --output <dir>', 'Output directory for report')
  .option('--no-ai', 'Skip AI review (deterministic checks only)')
  .option('--intent <intent>', 'Pipeline intent: review (default) or audit', 'review')
  .action(async (file, opts) => {
    const { analyzeSession } = await import('./commands/analyze.js');
    await analyzeSession(resolve(file), opts);
  });

// ─── Intent commands ─────────────────────────────────────────────
// Users choose outcomes, not processing modes (docs/UX_STATES.md):
//   Build This      → `loupe build-this`  (fast implementation package, ~30–60s)
//   UX Review       → `loupe review`      (vision pass + reasoning synthesis, ~1–2 min)
//   Complete Audit  → `loupe audit`       (5-persona fanout + judge, 3–5+ min)
// Internal routing lives in llm/routing-policy.ts; model names never surface.

program
  .command('review <session-file>')
  .description('UX Review — find opportunities and understand what to improve (~1–2 min)')
  .option('-o, --output <dir>', 'Output directory for report')
  .option('--no-ai', 'Skip AI review (deterministic checks only)')
  .action(async (file, opts) => {
    const { analyzeSession } = await import('./commands/analyze.js');
    await analyzeSession(resolve(file), { ...opts, intent: 'review' });
  });

program
  .command('audit <session-file>')
  .description('Complete Audit — comprehensive product review before shipping (3–5+ min)')
  .option('-o, --output <dir>', 'Output directory for report')
  .option('--no-ai', 'Skip AI review (deterministic checks only)')
  .action(async (file, opts) => {
    const { analyzeSession } = await import('./commands/analyze.js');
    await analyzeSession(resolve(file), { ...opts, intent: 'audit' });
  });

program
  .command('design-system <action> <project>')
  .description("Manage a project's design system. Actions: init (write a template to fill in)")
  .action(async (action, project) => {
    const { designSystemCommand } = await import('./commands/design-system.js');
    await designSystemCommand(action, project);
  });

program
  .command('transcribe <session-file>')
  .description('Transcribe embedded audio and add timestamped notes')
  .action(async (file) => {
    const { transcribeSession } = await import('./commands/transcribe.js');
    await transcribeSession(resolve(file));
  });

program
  .command('destination <action>')
  .description('Manage Loupe destinations (list, show, set, test)')
  .option('--project <name>', 'Project to map')
  .option('--type <type>', 'Destination type: local, claude-code, cursor, codex, gemini, clipboard, custom-command')
  .option('--workspace <path>', 'Workspace root')
  .option('--output <dir>', 'Relative output directory')
  .option('--post-action <action>', 'Post action: none, open-folder, copy-prompt, run-command')
  .option('--command <cmd>', 'Custom command (for custom-command type)')
  .option('--id <id>', 'Destination ID')
  .option('--name <name>', 'Display name')
  .action(async (action, opts) => {
    const { destinationCommand } = await import('./commands/destination.js');
    await destinationCommand(action, opts);
  });

program
  .command('build-this <session-file>')
  .description('Generate an implementation package for AI coding agents')
  .option('--goal <name>', 'Goal: Minimal changes, Modernize UI, Best-in-class UX, etc.')
  .option('--target <name>', 'Target: Claude Code, Cursor, Codex, Gemini CLI, etc.')
  .option('--opportunities <ids>', 'Opportunity IDs to include: "all" or "1,2,5"', 'all')
  .option('--output <dir>', 'Output directory for the implementation package')
  .option('--destination <id>', 'Destination to route package to (local, claude-code, cursor, etc.)')
  .option('--target-design <path>', 'Target design file (PNG, JPG, WebP, HTML, MD) — creates/reuses a persisted target artifact')
  .option('--target-id <id>', 'Reuse a persisted target design artifact by id (see `loupe target list`)')
  .option('--allow-cross-project-target', 'Allow --target-id to resolve a target from another project')
  .option('--no-synthesis', 'Skip the UX/Product Synthesis section (faster, omits product-level analysis)')
  .option('--deep', 'Fast path: observe up to 10 keyframes instead of 5')
  .option('--run', 'Execute post-action command if configured')
  .action(async (file, opts) => {
    const { buildThisCommand } = await import('./commands/build-this.js');
    // Commander camelCases --allow-cross-project-target → allowCrossProjectTarget.
    await buildThisCommand(resolve(file), { ...opts, allowCrossProject: opts.allowCrossProjectTarget });
  });

program
  .command('memory <action> [args...]')
  .description('Project memory: index | show | digest <project> | mark <run:id> <status> <project> | prefer <project> "…" | reset')
  .option('--why <reason>', 'Why (for mark rejected/accepted — recorded as a preference hint)')
  .option('--rule', 'Record an explicit preference as a rule (hard constraint)')
  .option('--keep-preferences', 'On reset, keep recorded preferences')
  .action(async (action, args, opts) => {
    const { memoryCommand } = await import('./commands/memory.js');
    await memoryCommand(action, args ?? [], opts);
  });

program
  .command('target <action> [args...]')
  .description('Manage target designs (desired state): add | list | show')
  .option('--project <name>', 'Project (required for `list`)')
  .option('--name <name>', 'Display name for the target (for `add`)')
  .option('--notes <text>', 'Notes to attach to the target (for `add`)')
  .action(async (action, args, opts) => {
    const { targetCommand } = await import('./commands/target.js');
    await targetCommand(action, args ?? [], opts);
  });

program
  .command('doctor')
  .description('Health check for the local Loupe runtime (~/.loupe) — exits 1 with warnings')
  .action(async () => {
    const { doctorCommand } = await import('./commands/runtime.js');
    await doctorCommand();
  });

program
  .command('status')
  .description('Compact project/runtime summary')
  .option('--project <name>', 'Project to summarize (inferred when only one exists)')
  .action(async (opts) => {
    const { statusCommand } = await import('./commands/runtime.js');
    await statusCommand(opts);
  });

program
  .command('gc')
  .description('Collect orphan/stale generated artifacts (never sessions, memory, config, or valid runs)')
  .option('--dry-run', 'List candidates without deleting')
  .option('--project <name>', 'Limit to one project')
  .option('--older-than <age>', 'Staleness cutoff for cache/logs (default 30d)')
  .action(async (opts) => {
    const { gcCommand } = await import('./commands/runtime.js');
    await gcCommand(opts);
  });

program
  .command('runtime <action>')
  .description('Runtime maintenance: migrate (move generated artifacts out of the repo; dry-run by default)')
  .option('--apply', 'Actually move files (default is dry-run)')
  .option('--dry-run', 'Preview without moving (the default)')
  .action(async (action, opts) => {
    const { runtimeCommand } = await import('./commands/runtime.js');
    await runtimeCommand(action, opts);
  });

program
  .command('clean')
  .description('Remove generated artifacts from ~/.loupe (never source, config, memory, or captures)')
  .option('--dry-run', 'List what would be removed without deleting')
  .option('--local-artifacts', 'Clean caches and logs only')
  .option('--packages', 'Clean routed implementation packages only')
  .option('--runs', 'Clean analysis runs only')
  .option('--older-than <age>', 'Only remove artifacts older than e.g. 7d, 24h, 90m')
  .action(async (opts) => {
    const { cleanCommand } = await import('./commands/clean.js');
    await cleanCommand(opts);
  });

program
  .command('list')
  .description('List recorded sessions and projects')
  .action(async () => {
    const { listSessions } = await import('./commands/list.js');
    await listSessions();
  });

program
  .command('open <project-or-file>')
  .description('Open the latest report for a project')
  .action(async (ref) => {
    const { openReport } = await import('./commands/open.js');
    await openReport(ref);
  });

program.parse(process.argv);

// ─── Help on no args ───────────────────────────────────────────

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
