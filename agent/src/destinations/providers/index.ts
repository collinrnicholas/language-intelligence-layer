import { cpSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { DestinationProvider, DestinationConfig, ImplementationPackage, DestinationResult } from '../types.js';

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function timestampSlug(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
}
function copyDirectory(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
}
function fail(id: string, msg: string): DestinationResult {
  return { success: false, destinationId: id, filesWritten: [], message: msg };
}

export const localProvider: DestinationProvider = {
  type: 'local',
  async route(pkg, dest) {
    const base = expandHome(dest.output || '~/Loupe/implementation-packages');
    const folderName = `${timestampSlug()}-${slugify(pkg.project)}-${slugify(pkg.flow)}`;
    const targetPath = join(base, folderName);
    if (existsSync(targetPath)) return fail(dest.id, `Package already exists at ${targetPath}`);
    copyDirectory(pkg.packageDir, targetPath);
    return {
      success: true, destinationId: dest.id, packagePath: targetPath,
      filesWritten: pkg.files.map(f => join(targetPath, f)),
      message: `Package written to ${targetPath}`,
    };
  },
};

function workspaceRoute(
  pkg: ImplementationPackage, dest: DestinationConfig,
  outputDir: string, wrapperName: string, wrapperContent: string
): DestinationResult {
  if (!dest.workspace) return fail(dest.id, `${dest.name} destination requires --workspace`);
  const workspace = resolve(expandHome(dest.workspace));
  if (!existsSync(workspace)) return fail(dest.id, `Workspace not found: ${workspace}`);
  const folderName = `${timestampSlug()}-${slugify(pkg.project)}-${slugify(pkg.flow)}`;
  const output = dest.output || outputDir;
  const targetPath = resolve(workspace, output, folderName);
  if (!isWithin(workspace, targetPath)) {
    return fail(dest.id, `Destination output escapes workspace: ${output}`);
  }
  if (existsSync(targetPath)) return fail(dest.id, `Task already exists at ${targetPath}`);
  copyDirectory(pkg.packageDir, targetPath);
  writeFileSync(join(targetPath, wrapperName), wrapperContent);
  const files = pkg.files.map(f => join(targetPath, f));
  files.push(join(targetPath, wrapperName));
  return {
    success: true, destinationId: dest.id, packagePath: targetPath,
    filesWritten: files, message: `Package routed to ${targetPath}`,
  };
}

export const claudeCodeProvider: DestinationProvider = {
  type: 'claude-code',
  async route(pkg, dest) {
    return workspaceRoute(pkg, dest, '.ai/tasks', 'CLAUDE.md', [
      '# Loupe Implementation Task', '',
      `**Project:** ${pkg.project}`, `**Flow:** ${pkg.flow}`,
      `**Generated:** ${new Date().toISOString()}`, '',
      '## Instructions', '',
      'Read and implement:',
      '1. `build-prompt.md` — Full implementation brief',
      '2. `acceptance-criteria.md` — Verification checklist',
      '3. `context.json` — Session context',
      '4. `design-system.json` — Design tokens',
      '5. `screenshots/` — Visual reference',
      '', '## Constraints',
      '- Make surgical edits.', '- Use design tokens.', '- Preserve existing functionality.',
    ].join('\n'));
  },
};

export const cursorProvider: DestinationProvider = {
  type: 'cursor',
  async route(pkg, dest) {
    return workspaceRoute(pkg, dest, '.cursor/tasks', 'cursor-prompt.md', [
      `# ${pkg.project} — ${pkg.flow}`, '',
      '## Objective', `Implement changes from build-prompt.md.`, '',
      '## Files Likely Affected', '(See build-prompt.md)', '',
      '## Constraints', '- Use design tokens. - Surgical edits.',
    ].join('\n'));
  },
};

export const codexProvider: DestinationProvider = {
  type: 'codex',
  async route(pkg, dest) {
    return workspaceRoute(pkg, dest, '.codex/tasks', 'codex-task.md', [
      `# Task: ${pkg.project} — ${pkg.flow}`, '',
      '## Objective', `Implement Loupe brief for ${pkg.project}.`, '',
      '## Verification', 'Run `loupe analyze` after implementation.',
    ].join('\n'));
  },
};

export const geminiProvider: DestinationProvider = {
  type: 'gemini',
  async route(pkg, dest) {
    return workspaceRoute(pkg, dest, '.gemini/tasks', 'gemini-task.md', [
      `# Task: ${pkg.project} — ${pkg.flow}`, '',
      '## Context', `Loupe implementation package for ${pkg.project}.`,
      'Read build-prompt.md for the full brief.',
    ].join('\n'));
  },
};

export const clipboardProvider: DestinationProvider = {
  type: 'clipboard',
  async route(pkg, dest) {
    const path = join(pkg.packageDir, 'build-prompt.md');
    if (!existsSync(path)) return fail(dest.id, 'build-prompt.md not found');
    try {
      execFileSync('pbcopy', [], { input: readFileSync(path, 'utf-8'), stdio: 'pipe' });
      return { success: true, destinationId: dest.id, packagePath: pkg.packageDir, filesWritten: [], message: 'Copied to clipboard' };
    } catch {
      return fail(dest.id, 'pbcopy not available');
    }
  },
};

export const customCommandProvider: DestinationProvider = {
  type: 'custom-command',
  async route(pkg, dest) {
    if (!dest.command) return fail(dest.id, 'Custom command requires --command');
    const workspace = dest.workspace ? resolve(expandHome(dest.workspace)) : process.cwd();
    if (dest.workspace && !existsSync(workspace)) return fail(dest.id, `Workspace not found: ${workspace}`);
    let cmd = dest.command
      .replace(/{{packagePath}}/g, pkg.packageDir)
      .replace(/{{buildPromptPath}}/g, join(pkg.packageDir, 'build-prompt.md'))
      .replace(/{{workspace}}/g, dest.workspace ? workspace : '')
      .replace(/{{project}}/g, pkg.project)
      .replace(/{{flow}}/g, pkg.flow);

    return { success: true, destinationId: dest.id, packagePath: pkg.packageDir, filesWritten: [], commandRun: cmd, commandCwd: workspace, message: cmd };
  },
};

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
