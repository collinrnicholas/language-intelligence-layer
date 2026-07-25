// ─── Build This — fast path (no prior analysis run) ─────────────
//
// The 30–60s pipeline (docs/UX_STATES.md): deterministic checks → one vision
// observation pass over ≤5 keyframes (≤10 with --deep) → one reasoning
// synthesis that writes the brief. No persona fanout, no per-finding target
// generation — that fidelity belongs to UX Review / Complete Audit, after
// which `build-this` picks up the analyzed artifact as before.
//
// With a target design image, the vision pass compares current vs target and
// the brief becomes Target Design Mode; without one, the brief is built from
// session evidence alone.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { projectRoot } from '../paths.js';
import type { LoupeSession } from '../cli.js';
import { runDeterministicChecks } from '../checks/deterministic.js';
import { loadTokenMap, GOALS, type GoalName, type TargetName } from '../ai/implementation-brief.js';
import { visionObserve, aggregateTargetComparison } from '../llm/tasks/vision-observe.js';
import { synthesizeBuildBrief } from '../llm/tasks/synthesize-build-brief.js';
import { runCritic } from '../llm/tasks/critic.js';
import { contextPack } from '../ai/context-pack.js';
import { pingGateway, gatewayUnreachableMessage, timingsSummary } from '../llm/index.js';
import { routePackage } from '../destinations/router.js';
import { recordFastBuild, generateDigest } from '../memory/index.js';
import { parseImplementationPackage } from '../schema.js';
import type { ImplementationPackage } from '../destinations/types.js';
import {
  resolveTargetForBuild, copyTargetIntoPackage, targetContextFragment, readEmbeddedTarget,
  type ResolvedTarget,
} from '../target-design/artifact.js';
import {
  runGapAnalysis, generateImplementationGuidance, generateTargetAcceptanceCriteria,
  generateTargetDesignSection,
} from '../target-design/index.js';

/** Deterministic skeleton brief when every AI stage fails — the run still
 *  ships something actionable rather than aborting. */
function skeletonBrief(session: LoupeSession, detLines: string[]): string {
  const transcript = contextPack(session).transcriptBlock;
  return [
    `# Implementation Brief — ${session.project} / ${session.flow}`,
    '',
    '## Goal & Context',
    'AI synthesis was unavailable for this run. Below is the raw session evidence — the',
    'narration transcript is the authoritative statement of what the reviewer wants changed.',
    '',
    '## Narration',
    transcript || '(no narration captured)',
    '',
    '## Verified Findings',
    ...(detLines.length ? detLines : ['(none)']),
    '',
    '## Constraints',
    '- Make surgical edits; preserve existing conventions.',
    '- Findings reference rendered UI, not source paths — search for the quoted text.',
  ].join('\n');
}

export interface FastBuildOptions {
  output?: string;
  destination?: string;
  run?: boolean;
  targetDesign?: string;
  /** `--target-id <id>` — reuse a persisted target design artifact. */
  targetId?: string;
  /** Allow `--target-id` to resolve a target owned by another project. */
  allowCrossProject?: boolean;
  deep?: boolean;
  goal: GoalName;
  target: TargetName;
}

/**
 * The final step Loupe cannot do for the user: hand the prompt to their
 * coding agent. Printed after every successful build — Loupe's job ends at
 * build-prompt.md, but the user's job doesn't, so say the next command.
 */
export function printHandoff(packagePath: string): void {
  const promptPath = join(packagePath, 'build-prompt.md');
  console.log('');
  console.log('── Next: build it ─────────────────────────────');
  console.log('  1. Review the prompt:');
  console.log(`       open "${promptPath}"`);
  console.log('  2. In YOUR app\'s code folder, hand it to your coding agent, e.g.:');
  console.log(`       cd /path/to/your/app`);
  console.log(`       claude "Implement the brief in ${promptPath}"`);
  console.log('     (or drag build-prompt.md into Cursor/Codex — any agent works)');
}

/** Acceptance checklist for the package: the brief's own `- [ ]` items. */
function extractAcceptance(brief: string): string[] {
  return brief.split('\n')
    .map(l => l.trim())
    .filter(l => /^[-*] \[ \]/.test(l))
    .map(l => l.replace(/^[-*] \[ \]\s*/, ''));
}

export async function fastBuildThis(
  sessionPath: string,
  session: LoupeSession,
  opts: FastBuildOptions,
): Promise<void> {
  console.log('Build This — fast path (no prior analysis run found)');
  console.log(`  Goal: ${opts.goal} · Target: ${opts.target}`);

  const ping = await pingGateway();
  if (!ping.reachable) {
    console.warn(gatewayUnreachableMessage(ping.url, 'Build This synthesis'));
    console.warn('  Run UX Review later for full analysis, or start the gateway and retry.');
  }

  // 1) Deterministic checks — always run, never discarded.
  console.log('Running deterministic checks...');
  const deterministic = runDeterministicChecks(session);
  console.log(`  ${deterministic.length} finding(s)`);

  // 1b) Resolve the target design (desired state) through the persisted artifact
  //     store — the SAME path the rich build uses. --target-design creates/reuses
  //     an artifact; --target-id reuses one. HTML/Markdown are supported here too:
  //     they don't drive vision, but they are compared deterministically, included
  //     in the brief, and copied into the package (parity with the rich path).
  let resolvedTarget: ResolvedTarget | null = null;
  const embedded = readEmbeddedTarget(session.targetDesign);
  if (opts.targetDesign || opts.targetId || embedded) {
    try {
      resolvedTarget = resolveTargetForBuild({
        project: session.project,
        session,
        targetId: opts.targetId,
        targetDesignPath: opts.targetDesign,
        embeddedTargetDataUrl: embedded?.dataUrl,
        embeddedTargetName: embedded?.name,
        embeddedTargetNotes: embedded?.notes,
        allowCrossProject: opts.allowCrossProject,
      });
      if (resolvedTarget) {
        console.log(`Target design: ${resolvedTarget.artifact.name} · id ${resolvedTarget.artifact.id} · ${resolvedTarget.format}`);
      }
    } catch (err: any) {
      console.error(`  Target design failed: ${err.message}`);
      console.error('  Continuing without target design.');
      resolvedTarget = null;
    }
  }
  const targetUrl = resolvedTarget?.imageDataUrl ?? null;
  if (resolvedTarget && !targetUrl) {
    console.log('  Target is HTML/Markdown — brief uses it as context; no vision comparison');
  }

  // 2) Vision observation pass (≤5 keyframes; ≤10 with --deep).
  let observations: Awaited<ReturnType<typeof visionObserve>> = [];
  if (ping.reachable) {
    console.log('Observing screenshots (vision pass)...');
    observations = await visionObserve(session, {
      intent: 'buildThis',
      targetDesignDataUrl: targetUrl,
      maxShots: opts.deep ? 10 : 5,
    });
    console.log(`  ${observations.length} structured observation(s)${targetUrl ? ' · target comparison included' : ''}`);
  }

  // 3) Reasoning synthesis → the brief.
  const tokenMap = loadTokenMap(session.project);
  const tokenLines = Object.entries(tokenMap).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  let brief: string | null = null;
  if (ping.reachable) {
    console.log('Synthesizing implementation brief...');
    brief = await synthesizeBuildBrief({
      session,
      deterministic,
      observations,
      tokenLines,
      hasTargetDesign: !!targetUrl,
      goal: opts.goal,
      goalDescription: GOALS[opts.goal]?.description ?? '',
      target: opts.target,
    });
  }
  if (!brief) {
    console.log('  Synthesis unavailable — writing deterministic skeleton brief');
    brief = skeletonBrief(
      session,
      deterministic.map(f => `- [${f.severity}] ${f.title}: ${(f.description || '').slice(0, 160)}`),
    );
  }

  // 4a) Unified Target Design section — the SAME builder the rich path uses, so
  //     both paths emit a consistent section (Current vs Target, implications,
  //     acceptance). Image targets carry the vision comparison; html/markdown use
  //     the deterministic gap. Appended BEFORE the judge so the section is scored;
  //     the critic is barred from rewriting "## Target Design" (protected heading),
  //     so its evidence stays intact.
  let targetCriteria: string[] = [];
  if (resolvedTarget) {
    const comparison = targetUrl ? aggregateTargetComparison(observations) : null;
    const gap = runGapAnalysis(session, resolvedTarget.design, deterministic);
    const guidance = generateImplementationGuidance(session, resolvedTarget.design, gap, Object.keys(tokenMap));
    targetCriteria = generateTargetAcceptanceCriteria(gap);
    const section = generateTargetDesignSection(resolvedTarget.design, gap, guidance, targetCriteria, {
      name: resolvedTarget.artifact.name,
      id: resolvedTarget.artifact.id,
      sourceFile: resolvedTarget.artifact.sourceFile,
      comparison,
    });
    brief += '\n\n---\n\n' + section;
  }

  // 4b) Judge — policy-gated; buildThis ships without one unless enabled in
  //    ~/.loupe/config/routing-policy.json.
  const critic = await runCritic('buildThis', brief, {
    project: session.project,
    flow: session.flow,
  }).catch(() => null);
  if (critic) {
    console.log(`  Judge: ${critic.overallScore.toFixed(1)}/10${critic.applied ? ' — sections tightened' : ''}`);
    brief = critic.reviewedBriefMarkdown;
  }

  // 5) Package — the SAME contract the full path produces (build-prompt.md,
  //    acceptance-criteria.md, context.json, findings.json, summary.md,
  //    design-system.json, screenshots/): destination wrappers tell coding
  //    agents to read these files by name, so none may be missing.
  // Stage under the project's runtime dir — NEVER beside the input session
  // (staging next to a session in ~/Downloads/loupe/ leaked an
  // `implementation/` folder into the user's Downloads). The destination
  // router copies the package to its final location (e.g. loupe-prompts/).
  const outputDir = opts.output || join(projectRoot(session.project), 'packages');
  const pkgDir = join(outputDir, `implementation-${Date.now()}`);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'build-prompt.md'), brief, 'utf-8');
  writeFileSync(join(pkgDir, 'findings.json'), JSON.stringify(deterministic, null, 2), 'utf-8');

  // Acceptance = the brief's own checkboxes plus the target match criteria (deduped).
  const acceptance = Array.from(new Set([...targetCriteria, ...extractAcceptance(brief)]));
  writeFileSync(join(pkgDir, 'acceptance-criteria.md'), [
    `# Acceptance Criteria — ${session.project} / ${session.flow}`,
    `**Goal:** ${opts.goal} · **Criteria:** ${acceptance.length}`,
    '',
    ...(acceptance.length
      ? acceptance.map(c => `- [ ] ${c}`)
      : ['_See the Changes section of build-prompt.md — verify each change against its stated outcome._']),
  ].join('\n'), 'utf-8');

  writeFileSync(join(pkgDir, 'context.json'), JSON.stringify({
    project: session.project,
    flow: session.flow,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    urlTimeline: session.urlTimeline,
    eventCount: session.events.length,
    screenshotCount: session.screenshots.length,
    noteCount: session.notes.length,
    goal: opts.goal,
    target: opts.target,
    path: 'build-this-fast',
    ...(resolvedTarget ? { targetDesign: targetContextFragment(resolvedTarget) } : {}),
  }, null, 2), 'utf-8');

  // Copy the persisted target artifact into the package (parity with the rich path).
  if (resolvedTarget) copyTargetIntoPackage(pkgDir, resolvedTarget);

  writeFileSync(join(pkgDir, 'summary.md'), [
    `# Implementation Package — ${session.project}`,
    '',
    `**Flow:** ${session.flow}`,
    `**Goal:** ${opts.goal}`,
    `**Target:** ${opts.target}`,
    '**Path:** Build This (fast)',
    resolvedTarget ? `**Target design:** ${resolvedTarget.artifact.name} (${resolvedTarget.format}, id ${resolvedTarget.artifact.id})` : '',
    '',
    'Generated directly from the captured session. For a deeper opportunity analysis,',
    'run `loupe review <session>`; for a pre-ship audit, run `loupe audit <session>`.',
  ].filter(Boolean).join('\n'), 'utf-8');

  // Design tokens travel with the package, same lookup order as the rich path.
  for (const p of [
    join(homedir(), '.loupe', 'projects', session.project, 'config', 'design-system.json'),
    join(homedir(), '.loupe', 'config', 'design-system.json'),
  ]) {
    if (existsSync(p)) {
      writeFileSync(join(pkgDir, 'design-system.json'), readFileSync(p));
      break;
    }
  }

  const screenshotsDir = join(pkgDir, 'screenshots');
  mkdirSync(screenshotsDir, { recursive: true });
  let extracted = 0;
  for (let i = 0; i < session.screenshots.length; i++) {
    const m = session.screenshots[i].dataUrl.match(/^data:image\/(jpeg|png);base64,(.+)$/);
    if (!m) continue;
    try {
      writeFileSync(join(screenshotsDir, `${String(i).padStart(3, '0')}.${m[1] === 'png' ? 'png' : 'jpg'}`), Buffer.from(m[2], 'base64'));
      extracted++;
    } catch { /* skip */ }
  }

  const pkgFiles = ['build-prompt.md', 'acceptance-criteria.md', 'context.json', 'findings.json', 'summary.md'];
  if (existsSync(join(pkgDir, 'design-system.json'))) pkgFiles.push('design-system.json');
  const pkgCandidate: ImplementationPackage = {
    packageDir: pkgDir,
    files: pkgFiles,
    screenshotCount: extracted,
    project: session.project,
    flow: session.flow,
  };
  const parsed = parseImplementationPackage(pkgCandidate);
  if (!parsed.ok || !parsed.value) {
    console.error('Generated package is malformed:');
    for (const err of parsed.errors) console.error(`  - ${err}`);
    process.exitCode = 1;
    return;
  }

  const result = await routePackage(parsed.value, {
    project: session.project,
    destinationId: opts.destination,
    run: opts.run,
  });

  console.log('');
  if (result.success) {
    console.log(`✓ Package routed to: ${result.message}`);
    if (result.packagePath) console.log(`  Path: ${result.packagePath}`);
  } else {
    console.error(`✗ Routing failed: ${result.message}`);
    console.log(`  Package available at: ${pkgDir}`);
  }
  printHandoff(result.success && result.packagePath ? result.packagePath : pkgDir);

  // Project memory: a package shipped from the fast path — record it so
  // memory learns what was built even without an analysis run. Best-effort.
  try {
    recordFastBuild(session, deterministic);
    generateDigest(session.project);
  } catch { /* never fatal */ }

  const summary = timingsSummary();
  if (summary) console.log(`  ${summary}`);
}
