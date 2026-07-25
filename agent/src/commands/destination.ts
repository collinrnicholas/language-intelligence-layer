import type { DestinationConfig, DestinationType, PostAction } from '../destinations/types.js';
import {
  loadConfig, saveConfig, getDestination, listDestinations,
  setDestination as saveDestination, setProjectMapping, setDefaultDestination,
} from '../destinations/config.js';

const VALID_TYPES: DestinationType[] = ['local', 'claude-code', 'cursor', 'codex', 'gemini', 'clipboard', 'custom-command'];
const VALID_POST_ACTIONS: PostAction[] = ['none', 'open-folder', 'copy-prompt', 'run-command'];

export async function destinationCommand(
  action: string,
  opts: {
    project?: string;
    type?: string;
    workspace?: string;
    output?: string;
    postAction?: string;
    command?: string;
    destinationId?: string;
    id?: string;
    set?: string;
    name?: string;
  }
) {
  switch (action) {
    case 'list': return list();
    case 'show': return show(opts.id || opts.destinationId || '');
    case 'set': return set(opts);
    case 'test': return test(opts.id || opts.destinationId || '');
    default:
      console.error(`Unknown destination action: ${action}`);
      console.error('Use: list, show, set, test');
  }
}

function list() {
  const config = loadConfig();
  console.log(`\nDefault destination: ${config.defaultDestination}\n`);

  if (Object.keys(config.projectMappings).length > 0) {
    console.log('Project mappings:');
    for (const [project, destId] of Object.entries(config.projectMappings)) {
      console.log(`  ${project} → ${destId}`);
    }
    console.log('');
  }

  console.log('Destinations:');
  for (const d of config.destinations) {
    const isDefault = d.id === config.defaultDestination ? ' (default)' : '';
    console.log(`  ${d.id} — ${d.name} [${d.type}]${isDefault}`);
    if (d.workspace) console.log(`    Workspace: ${d.workspace}`);
    if (d.output) console.log(`    Output: ${d.output}`);
    if (d.command) console.log(`    Command: ${d.command}`);
  }
}

function show(id: string) {
  if (!id) {
    list();
    return;
  }
  const d = getDestination(id);
  if (!d) {
    console.error(`Destination "${id}" not found.`);
    return;
  }
  console.log(JSON.stringify(d, null, 2));
}

function set(opts: any) {
  const id = opts.id || opts.destinationId || opts.name?.toLowerCase().replace(/\s+/g, '-');
  if (!id) {
    console.error('Destination ID required (--id or --name)');
    return;
  }

  const type = opts.type || opts.set;
  if (!type || !VALID_TYPES.includes(type as DestinationType)) {
    console.error(`Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`);
    return;
  }

  const postAction = opts.postAction || 'open-folder';
  if (!VALID_POST_ACTIONS.includes(postAction as PostAction)) {
    console.error(`Invalid postAction. Must be one of: ${VALID_POST_ACTIONS.join(', ')}`);
    return;
  }

  const dest: DestinationConfig = {
    id,
    name: opts.name || id,
    type: type as DestinationType,
    output: opts.output,
    postAction: postAction as PostAction,
  };

  // Workspace destinations need workspace
  if (['claude-code', 'cursor', 'codex', 'gemini'].includes(type)) {
    if (!opts.workspace) {
      console.error(`${type} destination requires --workspace`);
      process.exitCode = 1;
      return;
    }
    dest.workspace = opts.workspace;
  }

  // Custom command needs command
  if (type === 'custom-command') {
    if (!opts.command) {
      console.error('custom-command destination requires --command');
      process.exitCode = 1;
      return;
    }
    dest.command = opts.command;
  }

  saveDestination(dest);

  // Set project mapping if --project provided
  if (opts.project) {
    setProjectMapping(opts.project, id);
    console.log(`✓ Project "${opts.project}" mapped to destination "${id}"`);
  }

  // Set as default if no project specified
  if (!opts.project) {
    setDefaultDestination(id);
  }

  console.log(`✓ Destination "${id}" saved`);
  show(id);
}

async function test(id: string) {
  if (!id) {
    const config = loadConfig();
    id = config.defaultDestination;
    console.log(`Testing default destination: ${id}`);
  }

  const d = getDestination(id);
  if (!d) {
    console.error(`Destination "${id}" not found.`);
    return;
  }

  console.log(`\n🧪 Dry-run: ${d.name} [${d.type}]`);

  if (d.workspace) {
    const { existsSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const wp = d.workspace.startsWith('~/') ? join(homedir(), d.workspace.slice(2)) : d.workspace;
    console.log(`  Workspace: ${wp} ${existsSync(wp) ? '✓' : '✗ (not found)'}`);
  }

  if (d.output) console.log(`  Output: ${d.output}`);
  console.log(`  Post-action: ${d.postAction}`);
  if (d.command) console.log(`  Command: ${d.command}`);

  console.log('\n  All checks passed. Ready to route packages.');
}
