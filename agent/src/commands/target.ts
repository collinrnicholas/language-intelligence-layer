// ─── `loupe target` — manage persisted TargetDesign artifacts ────
//
//   loupe target add <session-or-project> <file>   create/reuse a target
//   loupe target list --project <project>          list a project's targets
//   loupe target show <target-id>                  show one target
//
// A target is the desired state (see docs/TARGET_DESIGN_INVESTIGATION.md). It is
// stored under ~/.loupe/projects/<project>/targets/<id>/ and reused by
// `loupe build-this <session> --target-id <id>`.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSessionInput } from '../schema.js';
import {
  createTargetArtifact, listTargetArtifacts, findTargetById, loadTargetArtifact,
  sessionId, sourceFileFor,
} from '../target-design/artifact.js';

export interface TargetCommandOptions {
  project?: string;
  name?: string;
  notes?: string;
}

export async function targetCommand(
  action: string,
  args: string[],
  opts: TargetCommandOptions,
): Promise<void> {
  switch (action) {
    case 'add':    return addTarget(args, opts);
    case 'list':   return listTargets(opts);
    case 'show':   return showTarget(args);
    default:
      console.error(`Unknown target action: "${action}"`);
      console.error('Usage:');
      console.error('  loupe target add <session-or-project> <file>');
      console.error('  loupe target list --project <project>');
      console.error('  loupe target show <target-id>');
      process.exitCode = 1;
  }
}

/** `loupe target add <session-or-project> <file>` */
function addTarget(args: string[], opts: TargetCommandOptions): void {
  const [sessionOrProject, file] = args;
  if (!sessionOrProject || !file) {
    console.error('Usage: loupe target add <session-or-project> <file>');
    process.exitCode = 1;
    return;
  }

  // Resolve the project (and optional session link): if arg1 is a readable
  // .loupe session, link the target to it; otherwise treat arg1 as a project name.
  let project = sessionOrProject;
  let linkedSessionIds: string[] = [];
  const asPath = resolve(sessionOrProject);
  if (existsSync(asPath)) {
    try {
      const parsed = parseSessionInput(JSON.parse(readFileSync(asPath, 'utf-8')));
      if (parsed.ok && parsed.value) {
        project = parsed.value.project;
        linkedSessionIds = [sessionId(parsed.value)];
      }
    } catch {
      console.error(`Could not read "${sessionOrProject}" as a session — treating it as a project name.`);
    }
  }

  try {
    const { artifact, dir } = createTargetArtifact({
      project,
      sourcePath: file,
      name: opts.name,
      notes: opts.notes,
      linkedSessionIds,
    });
    console.log(`✓ Target added: ${artifact.name}`);
    console.log(`  ID:        ${artifact.id}`);
    console.log(`  Project:   ${artifact.project}`);
    console.log(`  Type:      ${artifact.sourceType}`);
    console.log(`  Stored:    ${dir}`);
    if (linkedSessionIds.length) console.log(`  Linked to: ${linkedSessionIds[0]}`);
    console.log('');
    console.log(`  Build against it:  loupe build-this <session> --target-id ${artifact.id}`);
  } catch (err: any) {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  }
}

/** `loupe target list --project <project>` */
function listTargets(opts: TargetCommandOptions): void {
  if (!opts.project) {
    console.error('Usage: loupe target list --project <project>');
    process.exitCode = 1;
    return;
  }
  const targets = listTargetArtifacts(opts.project);
  if (targets.length === 0) {
    console.log(`No targets for project "${opts.project}".`);
    console.log('Add one:  loupe target add <session-or-project> <file>');
    return;
  }
  console.log(`Targets for "${opts.project}":\n`);
  for (const t of targets) {
    console.log(`  ${t.id}  ${t.name}  (${t.sourceType})  ·  ${t.linkedSessionIds.length} session(s)  ·  ${t.createdAt}`);
  }
}

/** `loupe target show <target-id>` */
function showTarget(args: string[]): void {
  const [id] = args;
  if (!id) {
    console.error('Usage: loupe target show <target-id>');
    process.exitCode = 1;
    return;
  }
  const found = findTargetById(id) ?? (args[1] ? loadTargetArtifact(args[1], id) : null);
  if (!found) {
    console.error(`No target with id "${id}" found.`);
    process.exitCode = 1;
    return;
  }
  const { artifact, dir } = found;
  console.log(`Target: ${artifact.name}`);
  console.log(`  ID:            ${artifact.id}`);
  console.log(`  Project:       ${artifact.project}`);
  console.log(`  Source type:   ${artifact.sourceType}`);
  console.log(`  Source file:   ${sourceFileFor(artifact, dir)}`);
  console.log(`  Original path: ${artifact.sourcePath}`);
  console.log(`  Created:       ${artifact.createdAt}`);
  console.log(`  Hash:          ${artifact.hash}`);
  console.log(`  Linked sessions: ${artifact.linkedSessionIds.length ? artifact.linkedSessionIds.join(', ') : '(none)'}`);
  if (artifact.notes) console.log(`  Notes:         ${artifact.notes}`);
  console.log(`  Stored:        ${dir}`);
}
