import type { DestinationConfig, DestinationResult, ImplementationPackage, PostAction } from './types.js';
import { resolveDestination } from './config.js';
import * as providers from './providers/index.js';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, existsSync as fsExists } from 'node:fs';

/**
 * Route an implementation package to the correct destination.
 *
 * Flow:
 *   1. Resolve which destination to use
 *   2. Call the destination provider to write/format the package
 *   3. Execute post-action (open folder, copy prompt, run command)
 */
export async function routePackage(
  pkg: ImplementationPackage,
  options: {
    project?: string;
    destinationId?: string;
    run?: boolean;
  } = {}
): Promise<DestinationResult> {
  // Resolve destination
  let dest: DestinationConfig;
  try {
    dest = resolveDestination(options.project, options.destinationId);
  } catch (err) {
    return { success: false, destinationId: 'unknown', filesWritten: [], message: `Failed to resolve destination: ${err}` };
  }

  console.log(`\nDestination: ${dest.name} (${dest.type})`);

  // Route to provider
  const provider = getProvider(dest.type);
  if (!provider) {
    return { success: false, destinationId: dest.id, filesWritten: [], message: `No provider for destination type: ${dest.type}` };
  }

  const result = await provider.route(pkg, dest);

  // Post-action
  if (result.success && result.packagePath) {
    await executePostAction(dest.postAction, result.packagePath, options.run ?? false, result);
  }

  return result;
}

function getProvider(type: string) {
  switch (type) {
    case 'local': return providers.localProvider;
    case 'claude-code': return providers.claudeCodeProvider;
    case 'cursor': return providers.cursorProvider;
    case 'codex': return providers.codexProvider;
    case 'gemini': return providers.geminiProvider;
    case 'clipboard': return providers.clipboardProvider;
    case 'custom-command': return providers.customCommandProvider;
    default: return null;
  }
}

async function executePostAction(
  action: PostAction,
  packagePath: string,
  forceRun: boolean,
  result: DestinationResult
): Promise<void> {
  // Desktop side effects (Finder windows, clipboard writes) only make sense
  // for a human at an interactive terminal. Tests, benchmarks, and piped/CI
  // runs route packages constantly — without this gate every routed package
  // opened a Finder window (hundreds per test run). LOUPE_NO_OPEN=1 opts out
  // even interactively.
  const interactive = process.stdout.isTTY === true &&
    process.env.LOUPE_NO_OPEN !== '1' &&
    process.env.NODE_ENV !== 'test';
  if (!interactive && (action === 'open-folder' || action === 'copy-prompt')) {
    console.log(`  Folder: ${packagePath}  (post-action "${action}" skipped — non-interactive run)`);
    return;
  }

  switch (action) {
    case 'open-folder':
      try {
        execFileSync('open', [packagePath], { stdio: 'pipe' });
        console.log(`  Opened: ${packagePath}`);
      } catch {
        console.log(`  Folder: ${packagePath}`);
      }
      break;

    case 'copy-prompt':
      try {
        const promptPath = join(packagePath, 'build-prompt.md');
        if (fsExists(promptPath)) {
          execFileSync('pbcopy', [], { input: readFileSync(promptPath, 'utf-8'), stdio: 'pipe' });
          console.log('  Copied build-prompt.md to clipboard');
        }
      } catch {
        // pbcopy not available
      }
      break;

    case 'run-command':
      if (result.commandRun) {
        console.log(`  Command preview: ${result.commandRun}`);
      }
      if (forceRun && result.commandRun) {
        const parsed = parseCommand(result.commandRun);
        if (!parsed) {
          console.error('  Command failed: could not parse command safely');
          return;
        }
        console.log(`  Running: ${result.commandRun}`);
        try {
          execFileSync(parsed.file, parsed.args, { stdio: 'inherit', cwd: result.commandCwd });
        } catch {
          console.error('  Command failed');
        }
      } else if (result.commandRun) {
        console.log(`  Command ready (use --run): ${result.commandRun}`);
      }
      break;
  }
}

function parseCommand(command: string): { file: string; args: string[] } | null {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!parts || parts.length === 0) return null;
  const cleaned = parts.map(part => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  });
  return { file: cleaned[0], args: cleaned.slice(1) };
}
