// ─── Persisted TargetDesign artifact ─────────────────────────────
//
// Target Design represents the DESIRED STATE and is a first-class artifact, not
// a transient CLI argument (see docs/TARGET_DESIGN_INVESTIGATION.md, "Decision
// Outcome"). A target lives under the project so it can be attached after
// recording, reused across sessions, listed, and switched between:
//
//   ~/.loupe/projects/<project>/targets/<target-id>/
//     target.json     ← the artifact record (id, project, name, sourceType, …)
//     source.<ext>    ← the original design file, copied in
//     summary.md      ← human-readable summary
//
// Identity is content-addressed: the id derives from the source hash, so the
// same file added twice resolves to the SAME artifact (dedup) and tests get
// stable ids with no time dependence. Both Build This paths resolve a target
// through this module, guaranteeing consistent handling.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, extname, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { LoupeSession } from '../cli.js';
import { targetsRoot, targetDir, allProjectDirs, safeProjectDir } from '../paths.js';
import { detectTargetFormat, loadTargetDesign, type TargetDesign, type TargetFormat } from './index.js';

export type TargetSourceType = 'image' | 'html' | 'markdown';

export interface TargetArtifact {
  id: string;
  project: string;
  name: string;
  sourceType: TargetSourceType;
  sourceFile: string;          // `source.<ext>` inside the artifact dir (authoritative — no dir scan)
  sourcePath: string;          // original path the user supplied (provenance, may contain local paths)
  createdAt: string;           // ISO
  linkedSessionIds: string[];  // sessions this target has been built against
  notes: string;
  hash: string;                // sha256 of source content (hex)
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

// ─── Identity helpers ────────────────────────────────────────────

/** Stable content-addressed id for a source buffer: `t-<first 12 hex of sha256>`. */
export function targetIdForContent(buf: Buffer): string {
  return 't-' + createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

/** A stable id for a session (no explicit id field exists on `.loupe`). Derived
 *  from the fields that identify a recording; used for `linkedSessionIds`. */
export function sessionId(session: LoupeSession): string {
  return 's-' + createHash('sha256')
    .update(`${session.project}\n${session.flow}\n${session.startedAt}`)
    .digest('hex').slice(0, 12);
}

export function sourceTypeForFormat(format: TargetFormat): TargetSourceType {
  if (format === 'html') return 'html';
  if (format === 'markdown') return 'markdown';
  return 'image'; // png | jpg | webp
}

/** The `source.<ext>` file inside an artifact dir (fallback scan for legacy
 *  artifacts written before `sourceFile` was stored on the record). */
export function sourceFileName(dir: string): string | null {
  try {
    return readdirSync(dir).find(f => f.startsWith('source.')) ?? null;
  } catch {
    return null;
  }
}

/** The stored source filename, preferring the record; scans only for legacy artifacts. */
export function sourceFileFor(artifact: TargetArtifact, dir: string): string {
  return artifact.sourceFile || sourceFileName(dir) || `source.${artifact.sourceType === 'image' ? 'png' : artifact.sourceType === 'html' ? 'html' : 'md'}`;
}

// ─── Create / dedup ──────────────────────────────────────────────

export interface CreateTargetOptions {
  project: string;
  sourcePath: string;
  name?: string;
  notes?: string;
  linkedSessionIds?: string[];
}

/**
 * Create (or reuse) a persisted target artifact from a file. Content-addressed:
 * if a target with the same source hash already exists in the project, it is
 * reused and the supplied `linkedSessionIds` are merged in — the same design is
 * never stored twice. Throws on a missing file or an unsupported format.
 */
export function createTargetArtifact(opts: CreateTargetOptions): { artifact: TargetArtifact; dir: string } {
  const abs = resolve(opts.sourcePath);
  if (!existsSync(abs)) throw new Error(`Target design not found at: ${abs}`);

  const buf = readFileSync(abs);
  const format = detectTargetFormat(abs);
  if (format === 'unknown') {
    throw new Error(`Unsupported target format: ${basename(abs)} (accepted: PNG, JPG, WebP, HTML, Markdown)`);
  }
  const ext = extname(abs).toLowerCase().replace(/^\./, '') || format;
  return persistTarget({
    project: opts.project,
    buf,
    ext,
    format,
    name: opts.name?.trim() || basename(abs, extname(abs)),
    notes: opts.notes,
    sourcePath: abs,
    linkedSessionIds: opts.linkedSessionIds,
  });
}

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,([a-z0-9+/=\s]+)$/i;

/**
 * Create (or reuse) a target artifact from an image DATA URL — the path used by
 * the extension's "Capture Target Screenshot", where the desired state is
 * embedded in the `.loupe` session rather than living as a file on disk. Same
 * content-addressed dedup as the file path. Throws on a non-image data URL.
 */
export function createTargetArtifactFromDataUrl(
  project: string,
  dataUrl: string,
  opts: { name?: string; notes?: string; linkedSessionIds?: string[] } = {},
): { artifact: TargetArtifact; dir: string } {
  const m = DATA_URL_RE.exec(dataUrl.trim());
  if (!m) throw new Error('Captured target is not a supported image data URL (png/jpg/webp).');
  const mime = m[1].toLowerCase();
  const ext = mime === 'png' ? 'png' : mime === 'webp' ? 'webp' : 'jpg';
  const format: TargetFormat = ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : 'jpg';
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  return persistTarget({
    project,
    buf,
    ext,
    format,
    name: opts.name?.trim() || 'Captured target',
    notes: opts.notes,
    sourcePath: 'extension-capture', // no local path — captured live in the browser
    linkedSessionIds: opts.linkedSessionIds,
  });
}

/** Shared persistence core: content-address, dedup, and write the artifact files. */
function persistTarget(params: {
  project: string; buf: Buffer; ext: string; format: TargetFormat;
  name: string; notes?: string; sourcePath: string; linkedSessionIds?: string[];
}): { artifact: TargetArtifact; dir: string } {
  const id = targetIdForContent(params.buf);
  const dir = targetDir(params.project, id);
  const hash = createHash('sha256').update(params.buf).digest('hex');

  // Reuse if it already exists — merge session links, keep original metadata.
  const existing = loadTargetArtifact(params.project, id);
  if (existing) {
    const merged = Array.from(new Set([...existing.artifact.linkedSessionIds, ...(params.linkedSessionIds ?? [])]));
    if (merged.length !== existing.artifact.linkedSessionIds.length) {
      existing.artifact.linkedSessionIds = merged;
      writeArtifactFiles(existing.dir, existing.artifact);
    }
    return existing;
  }

  const artifact: TargetArtifact = {
    id,
    project: params.project,
    name: params.name,
    sourceType: sourceTypeForFormat(params.format),
    sourceFile: `source.${params.ext}`,
    sourcePath: params.sourcePath,
    createdAt: new Date().toISOString(),
    linkedSessionIds: Array.from(new Set(params.linkedSessionIds ?? [])),
    notes: params.notes?.trim() ?? '',
    hash,
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, artifact.sourceFile), params.buf);
  writeArtifactFiles(dir, artifact);
  return { artifact, dir };
}

/** (Re)write target.json + summary.md for an artifact. source.<ext> is written once at create. */
function writeArtifactFiles(dir: string, artifact: TargetArtifact): void {
  writeFileSync(join(dir, 'target.json'), JSON.stringify(artifact, null, 2));
  writeFileSync(join(dir, 'summary.md'), renderSummary(artifact));
}

/**
 * Render summary.md. `redact` drops the absolute `sourcePath` (used for the copy
 * that ships inside an implementation package, which is handed to a coding agent —
 * we don't leak local usernames/folder names). The canonical store keeps it.
 */
function renderSummary(a: TargetArtifact, redact = false): string {
  return [
    `# Target Design — ${a.name}`,
    '',
    `- **ID:** ${a.id}`,
    `- **Project:** ${a.project}`,
    `- **Source type:** ${a.sourceType}`,
    `- **Source file:** ${a.sourceFile}`,
    `- **Original file:** ${redact ? basename(a.sourcePath) : a.sourcePath}`,
    `- **Created:** ${a.createdAt}`,
    `- **Content hash:** ${a.hash}`,
    `- **Linked sessions:** ${a.linkedSessionIds.length ? a.linkedSessionIds.join(', ') : '(none yet)'}`,
    '',
    '## Notes',
    a.notes || '_None._',
    '',
    'This target represents the desired state. It is copied into every implementation',
    'package generated against it, under `target-design/`.',
  ].join('\n');
}

/** A package-safe copy of the artifact record: the absolute source path is
 *  reduced to its basename so packages carry no local filesystem paths. */
function redactedArtifact(a: TargetArtifact): TargetArtifact {
  return { ...a, sourcePath: basename(a.sourcePath) };
}

// ─── Load / list / link ──────────────────────────────────────────

export function loadTargetArtifact(project: string, id: string): { artifact: TargetArtifact; dir: string } | null {
  const dir = targetDir(project, id);
  const jsonPath = join(dir, 'target.json');
  if (!existsSync(jsonPath)) return null;
  try {
    const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    if (!isTargetArtifact(data)) return null;
    // Legacy artifacts predate the stored sourceFile — backfill once from disk.
    if (!data.sourceFile) data.sourceFile = sourceFileName(dir) ?? '';
    return { artifact: data, dir };
  } catch {
    return null;
  }
}

/** Find a target by id across all projects (for `loupe target show <id>`). */
export function findTargetById(id: string): { artifact: TargetArtifact; dir: string } | null {
  const safe = safeProjectDir(id);
  for (const projDir of allProjectDirs()) {
    const dir = join(targetsRoot(projDir), safe);
    const jsonPath = join(dir, 'target.json');
    if (!existsSync(jsonPath)) continue;
    try {
      const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      if (isTargetArtifact(data)) return { artifact: data, dir };
    } catch { /* skip */ }
  }
  return null;
}

export function listTargetArtifacts(project: string): TargetArtifact[] {
  const root = targetsRoot(project);
  if (!existsSync(root)) return [];
  const out: TargetArtifact[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const loaded = loadTargetArtifact(project, entry.name);
    if (loaded) out.push(loaded.artifact);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
}

/**
 * Record that a session was built against a target and return the updated
 * artifact (the single source of truth — callers must use the returned object
 * rather than mutating a separately loaded copy, which would drift from disk).
 */
export function linkSessionToTarget(project: string, id: string, sid: string): TargetArtifact | null {
  const loaded = loadTargetArtifact(project, id);
  if (!loaded) return null;
  if (!loaded.artifact.linkedSessionIds.includes(sid)) {
    loaded.artifact.linkedSessionIds.push(sid);
    writeArtifactFiles(loaded.dir, loaded.artifact);
  }
  return loaded.artifact;
}

// ─── Resolution for Build This ───────────────────────────────────

/** A target loaded and ready for a build: the record, its on-disk dir, the
 *  design content, and (for images) a data URL for vision comparison. */
export interface ResolvedTarget {
  artifact: TargetArtifact;
  dir: string;
  format: TargetFormat;
  design: TargetDesign;
  imageDataUrl: string | null;
}

export interface ResolveTargetOptions {
  project: string;
  session: LoupeSession;
  /** `--target-id <id>` — reuse a persisted artifact. */
  targetId?: string;
  /** `--target-design <file>` — create-or-reuse an artifact from a file. */
  targetDesignPath?: string;
  /** Target design captured in the extension and embedded in the session
   *  (`session.targetDesign`, an image data URL). Lowest precedence — an explicit
   *  --target-id or --target-design overrides it. */
  embeddedTargetDataUrl?: string;
  /** Display name / notes for an embedded target (provenance from the capture). */
  embeddedTargetName?: string;
  embeddedTargetNotes?: string;
  /** Allow `--target-id` to resolve a target that belongs to another project.
   *  Off by default: a content-hash id could otherwise silently attach a target
   *  from an unrelated project. Set by `--allow-cross-project-target`. */
  allowCrossProject?: boolean;
}

/**
 * Resolve a target for a build from either `--target-id <id>` or
 * `--target-design <file>`. Both funnel through the persisted artifact store, so
 * the two Build This paths handle targets identically. Returns null when neither
 * option was supplied. Throws (loudly) on an unknown id or an unreadable/
 * unsupported file. `--target-id` is scoped to the session's project unless
 * `allowCrossProject` is set.
 */
export function resolveTargetForBuild(opts: ResolveTargetOptions): ResolvedTarget | null {
  const sid = sessionId(opts.session);
  let artifact: TargetArtifact;
  let dir: string;

  if (opts.targetId) {
    const inProject = loadTargetArtifact(opts.project, opts.targetId);
    if (inProject) {
      ({ artifact, dir } = inProject);
    } else if (opts.allowCrossProject) {
      const anywhere = findTargetById(opts.targetId);
      if (!anywhere) throw new Error(`No target with id "${opts.targetId}" found in any project.`);
      ({ artifact, dir } = anywhere);
      console.warn(`  ⚠ Using target "${opts.targetId}" from project "${artifact.project}" for a build in "${opts.project}" (--allow-cross-project-target).`);
    } else {
      const elsewhere = findTargetById(opts.targetId);
      const hint = elsewhere
        ? ` It belongs to project "${elsewhere.artifact.project}" — pass --allow-cross-project-target to use it here.`
        : '';
      throw new Error(`No target with id "${opts.targetId}" in project "${opts.project}".${hint}`);
    }
    // Link the session and adopt the returned (disk-consistent) artifact.
    artifact = linkSessionToTarget(artifact.project, artifact.id, sid) ?? artifact;
  } else if (opts.targetDesignPath) {
    const created = createTargetArtifact({
      project: opts.project,
      sourcePath: opts.targetDesignPath,
      linkedSessionIds: [sid],
    });
    ({ artifact, dir } = created);
  } else if (opts.embeddedTargetDataUrl) {
    const created = createTargetArtifactFromDataUrl(opts.project, opts.embeddedTargetDataUrl, {
      name: opts.embeddedTargetName,
      notes: opts.embeddedTargetNotes,
      linkedSessionIds: [sid],
    });
    ({ artifact, dir } = created);
  } else {
    return null;
  }

  const srcName = sourceFileFor(artifact, dir);
  const srcPath = join(dir, srcName);
  if (!existsSync(srcPath)) throw new Error(`Target artifact ${artifact.id} is missing its source file.`);
  const design = loadTargetDesign(srcPath);
  const imageDataUrl = imageDataUrlFor(srcPath, design.format);
  return { artifact, dir, format: design.format, design, imageDataUrl };
}

/**
 * Normalize `session.targetDesign` (a legacy data-URL string, or the richer
 * capture object) into a data URL plus a provenance-bearing name/notes for the
 * artifact. Returns null when there is no embedded target.
 */
export function readEmbeddedTarget(td: unknown): { dataUrl: string; name: string; notes: string } | null {
  if (!td) return null;
  if (typeof td === 'string') return td ? { dataUrl: td, name: 'Captured target', notes: '' } : null;
  if (typeof td === 'object' && typeof (td as { dataUrl?: unknown }).dataUrl === 'string') {
    const c = td as { dataUrl: string; sourceKind?: string; capturedAtMs?: number; width?: number; height?: number };
    const kind = c.sourceKind === 'desktop' ? 'app/screen'
      : c.sourceKind === 'chrome-tab' ? 'browser tab' : 'capture';
    const dims = c.width && c.height ? ` ${c.width}×${c.height}` : '';
    const when = c.capturedAtMs ? ` on ${new Date(c.capturedAtMs).toISOString()}` : '';
    return {
      dataUrl: c.dataUrl,
      name: `Captured target (${kind})`,
      notes: `Captured from ${kind}${dims}${when}.`,
    };
  }
  return null;
}

/** Data URL for an image source (for the vision pass), or null for html/markdown. */
export function imageDataUrlFor(path: string, format: TargetFormat): string | null {
  const mime = IMAGE_MIME[extname(path).toLowerCase().replace(/^\./, '')];
  if (!mime || sourceTypeForFormat(format) !== 'image') return null;
  try {
    return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return null;
  }
}

// ─── Packaging ───────────────────────────────────────────────────

/**
 * Copy the target into a package's `target-design/` dir. `target.json` and
 * `summary.md` are re-rendered with the absolute source path redacted to its
 * basename — packages are handed to coding agents and must carry no local
 * filesystem paths. The source design file is copied verbatim.
 */
export function copyTargetIntoPackage(pkgDir: string, resolved: ResolvedTarget): void {
  const outDir = join(pkgDir, 'target-design');
  mkdirSync(outDir, { recursive: true });
  const srcName = sourceFileFor(resolved.artifact, resolved.dir);
  const from = join(resolved.dir, srcName);
  if (existsSync(from)) writeFileSync(join(outDir, srcName), readFileSync(from));
  writeFileSync(join(outDir, 'target.json'), JSON.stringify(redactedArtifact(resolved.artifact), null, 2));
  writeFileSync(join(outDir, 'summary.md'), renderSummary(resolved.artifact, true));
}

/** The `context.json.targetDesign` fragment — always references the artifact id. */
export function targetContextFragment(resolved: ResolvedTarget): Record<string, unknown> {
  const srcName = sourceFileFor(resolved.artifact, resolved.dir);
  return {
    id: resolved.artifact.id,
    name: resolved.artifact.name,
    sourceType: resolved.artifact.sourceType,
    format: resolved.format,
    file: `target-design/${srcName}`,
    record: 'target-design/target.json',
  };
}

// ─── Validation ──────────────────────────────────────────────────

const SOURCE_TYPES: TargetSourceType[] = ['image', 'html', 'markdown'];

export function isTargetArtifact(data: unknown): data is TargetArtifact {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.id === 'string' &&
    typeof d.project === 'string' &&
    typeof d.name === 'string' &&
    typeof d.sourceType === 'string' && SOURCE_TYPES.includes(d.sourceType as TargetSourceType) &&
    typeof d.sourcePath === 'string' &&
    typeof d.createdAt === 'string' &&
    Array.isArray(d.linkedSessionIds) && d.linkedSessionIds.every(s => typeof s === 'string') &&
    typeof d.notes === 'string' &&
    typeof d.hash === 'string'
  );
}
