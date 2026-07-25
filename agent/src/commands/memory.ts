// ─── `loupe memory` — inspect and steer project memory ──────────
//
// Memory is derived from runs/ and always rebuildable (`index`). The digest is
// the exact text prompts see (`digest`) — inspectability is a design
// requirement, not a debug convenience. See docs/SESSION_MEMORY_SPIKE.md.

import {
  rebuildFromRuns, resetMemory, markOpportunity, addPreference,
  loadManifest, loadSessions, loadOpportunityEvents, loadPreferences,
  generateDigest,
} from '../memory/index.js';

export interface MemoryOptions {
  why?: string;
  rule?: boolean;
  keepPreferences?: boolean;
}

export async function memoryCommand(
  action: string,
  args: string[],
  opts: MemoryOptions,
): Promise<void> {
  switch (action) {
    case 'index': {
      const project = requireProject(args[0]);
      if (!project) return;
      const { runs, events } = rebuildFromRuns(project);
      generateDigest(project);
      console.log(`✓ Rebuilt memory for ${project}: ${runs} run(s) indexed, ${events} lifecycle event(s) preserved`);
      return;
    }

    case 'show': {
      const project = requireProject(args[0]);
      if (!project) return;
      const m = loadManifest(project);
      const sessions = loadSessions(project);
      const events = loadOpportunityEvents(project);
      const prefs = loadPreferences(project);
      console.log(`Project memory — ${project}`);
      console.log(`  Sessions indexed: ${sessions.length} (last: ${m.lastRunId ?? '—'})`);
      console.log(`  Lifecycle events: ${events.length}`);
      console.log(`  Preferences:      ${prefs.length}`);
      console.log(`  Digest updated:   ${m.digestUpdatedAt ?? 'never'}`);
      if (m.productFrame) {
        console.log(`  Product frame:    ${m.productFrame.understanding.productType} (${m.productFrame.agreeingRuns} agreeing run(s))`);
      }
      console.log(`\nRun \`loupe memory digest ${project}\` to see exactly what prompts receive.`);
      return;
    }

    case 'digest': {
      const project = requireProject(args[0]);
      if (!project) return;
      // Regenerate first so what's printed is what the next run will inject.
      const digest = generateDigest(project);
      console.log(digest || '(memory is empty)');
      return;
    }

    case 'mark': {
      const ref = args[0] || '';
      const status = args[1] as 'accepted' | 'rejected' | 'verified';
      const [runId, findingId] = ref.split(':');
      const project = requireProject(args[2]);
      if (!project) return;
      if (!runId || !findingId || !['accepted', 'rejected', 'verified'].includes(status)) {
        console.error('Usage: loupe memory mark <runId>:<findingId> <accepted|rejected|verified> <project> [--why "…"]');
        return;
      }
      const entry = markOpportunity(project, runId, findingId, status, opts.why);
      if (!entry) {
        console.error(`Finding ${findingId} not found in run ${runId} of project ${project}.`);
        console.error('Check the run\'s analysis/opportunities.json for valid ids.');
        process.exitCode = 1;
        return;
      }
      generateDigest(project);
      console.log(`✓ ${entry.title} → ${status}${opts.why ? ` ("${opts.why}")` : ''}`);
      if (status === 'rejected' && opts.why) {
        console.log('  Reason recorded as a preference hint — repeated signals promote it.');
      }
      return;
    }

    case 'prefer': {
      const project = requireProject(args[0]);
      if (!project) return;
      const statement = args.slice(1).join(' ').trim();
      if (!statement) {
        console.error('Usage: loupe memory prefer <project> "<statement>" [--rule]');
        return;
      }
      const entry = addPreference(project, statement, !!opts.rule);
      generateDigest(project);
      console.log(`✓ Preference recorded [${entry.strength}]: ${entry.statement}`);
      return;
    }

    case 'reset': {
      const project = requireProject(args[0]);
      if (!project) return;
      resetMemory(project, !!opts.keepPreferences);
      console.log(`✓ Memory reset for ${project}${opts.keepPreferences ? ' (preferences kept)' : ''}`);
      console.log('  Rebuild anytime from runs/ with: loupe memory index ' + project);
      return;
    }

    default:
      console.error(`Unknown memory action: ${action}`);
      console.error('Actions: index, show, digest, mark, prefer, reset');
      process.exitCode = 1;
  }
}

function requireProject(name: string | undefined): string | null {
  if (!name) {
    console.error('Project name required.');
    process.exitCode = 1;
    return null;
  }
  return name;
}
