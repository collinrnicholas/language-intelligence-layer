import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { LoupeSession, Opportunity } from '../cli.js';
import { generateImplementationBrief, renderBriefToMarkdown, loadTokenMap, GOALS, TARGETS } from '../ai/implementation-brief.js';
import type { GoalName, TargetName } from '../ai/implementation-brief.js';
import { generateProductReasoning } from '../ai/product-reasoning.js';
import { classifyAndMerge } from '../ai/narration.js';
import { analyzeFindingRelationships } from '../ai/finding-relationships.js';
import { critiqueImplementationBrief } from '../ai/prompt-critic.js';
import { routePackage } from '../destinations/router.js';
import type { ImplementationPackage } from '../destinations/types.js';
import { runGapAnalysis, generateImplementationGuidance, generateTargetAcceptanceCriteria, generateTargetDesignSection } from '../target-design/index.js';
import { resolveTargetForBuild, copyTargetIntoPackage, targetContextFragment, readEmbeddedTarget, type ResolvedTarget } from '../target-design/artifact.js';
import { visionObserve, aggregateTargetComparison, type TargetComparison } from '../llm/tasks/vision-observe.js';
import { parseImplementationPackage, parseOpportunitiesArtifact, parseSessionInput } from '../schema.js';
import { projectRoot } from '../paths.js';
import { getCallTimings, resetCallTimings, timingsSummary } from '../llm/index.js';
import { recordBuilt, generateDigest } from '../memory/index.js';

export async function buildThisCommand(
  filePath: string,
  opts: {
    goal?: string;
    target?: string;
    opportunities?: string;
    output?: string;
    destination?: string;
    run?: boolean;
    targetDesign?: string;
    /** `--target-id <id>` — reuse a persisted target design artifact. */
    targetId?: string;
    /** `--allow-cross-project-target` — let --target-id resolve another project's target. */
    allowCrossProject?: boolean;
    targetFormat?: string;
    synthesis?: boolean;
    /** Fast path only: lift the 5-keyframe vision cap to 10. */
    deep?: boolean;
  }
) {
  const fullPath = resolve(filePath);
  if (!existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    return;
  }

  resetCallTimings(); // "this run's" timings must not include prior commands

  const artifactPath = resolveOpportunitiesPath(fullPath);
  if (!artifactPath || !existsSync(artifactPath)) {
    // No prior analysis — take the Build This fast path (vision observation +
    // reasoning synthesis, ~30–60s) instead of demanding a review first.
    // Only works when the input is the session itself.
    let sessionData: unknown;
    try {
      sessionData = JSON.parse(readFileSync(fullPath, 'utf-8'));
    } catch {
      console.error('No analyzed artifact found and the input is not a readable .loupe session.');
      console.error('Run:  loupe review ' + filePath);
      return;
    }
    const parsedFast = parseSessionInput(sessionData);
    if (!parsedFast.ok || !parsedFast.value) {
      console.error('No analyzed artifact found and the input is not a valid .loupe session.');
      console.error('Run:  loupe review ' + filePath);
      return;
    }
    // Honor --goal/--target exactly like the rich path (invalid values fail
    // loudly there too); without flags, fall back to the non-TTY defaults.
    let fastGoal: GoalName = 'Minimal changes';
    if (opts.goal && GOALS[opts.goal]) fastGoal = opts.goal as GoalName;
    else if (opts.goal) {
      console.error(`Unknown goal: "${opts.goal}"`);
      console.error('Available: ' + Object.keys(GOALS).join(', '));
      return;
    }
    let fastTarget: TargetName = 'Claude Code';
    if (opts.target && TARGETS.includes(opts.target as any)) fastTarget = opts.target as TargetName;
    else if (opts.target) {
      console.error(`Unknown target: "${opts.target}"`);
      console.error('Available: ' + TARGETS.join(', '));
      return;
    }

    const { fastBuildThis } = await import('./build-fast.js');
    await fastBuildThis(fullPath, parsedFast.value, {
      output: opts.output,
      destination: opts.destination,
      run: opts.run,
      targetDesign: opts.targetDesign,
      targetId: opts.targetId,
      allowCrossProject: opts.allowCrossProject,
      deep: opts.deep,
      goal: fastGoal,
      target: fastTarget,
    });
    return;
  }

  let artifactData: unknown;
  try {
    artifactData = JSON.parse(readFileSync(artifactPath, 'utf-8'));
  } catch {
    console.error(`Invalid JSON in opportunities artifact: ${artifactPath}`);
    process.exitCode = 1;
    return;
  }

  const parsedArtifact = parseOpportunitiesArtifact(artifactData);
  if (!parsedArtifact.ok || !parsedArtifact.value) {
    console.error(`Malformed opportunities artifact: ${artifactPath}`);
    for (const err of parsedArtifact.errors) console.error(`  - ${err}`);
    process.exitCode = 1;
    return;
  }

  const artifact = parsedArtifact.value;
  const allFindings = artifact.opportunities;

  // Resolve the session: embedded (v1) or referenced by relative path (v2).
  let session: LoupeSession;
  if (artifact.version === 1) {
    session = artifact.session; // already validated by parseOpportunitiesArtifact
  } else {
    const sessionPath = join(dirname(artifactPath), artifact.sessionFile);
    if (!existsSync(sessionPath)) {
      console.error(`Session referenced by artifact not found: ${sessionPath}`);
      process.exitCode = 1;
      return;
    }
    let sessionData: unknown;
    try {
      sessionData = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    } catch {
      console.error(`Invalid JSON in referenced session: ${sessionPath}`);
      process.exitCode = 1;
      return;
    }
    const parsedSession = parseSessionInput(sessionData);
    if (!parsedSession.ok || !parsedSession.value) {
      console.error('Malformed session referenced by opportunities artifact:');
      for (const err of parsedSession.errors) console.error(`  - ${err}`);
      process.exitCode = 1;
      return;
    }
    session = parsedSession.value;
  }

  if (allFindings.length === 0) {
    console.error(`No opportunities in analyzed artifact: ${artifactPath}`);
    return;
  }

  // ─── Select findings ──────────────────────────────────────────
  let selectedFindings: Opportunity[];

  if (opts.opportunities === 'all' || !opts.opportunities) {
    selectedFindings = allFindings;
  } else {
    const indices = opts.opportunities.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(i => i >= 0 && i < allFindings.length);
    if (indices.length === 0) {
      console.error('Invalid finding indices. Use "all" or "1,2,5".');
      return;
    }
    selectedFindings = indices.map(i => allFindings[i]);
  }

  // ─── Resolve goal ─────────────────────────────────────────────
  let goal: GoalName;
  if (opts.goal && GOALS[opts.goal]) {
    goal = opts.goal as GoalName;
  } else if (opts.goal) {
    console.error(`Unknown goal: "${opts.goal}"`);
    console.error('Available: ' + Object.keys(GOALS).join(', '));
    return;
  } else {
    // Interactive: show goals
    goal = await selectGoal();
  }

  // ─── Resolve target ───────────────────────────────────────────
  let target: TargetName;
  if (opts.target && TARGETS.includes(opts.target as any)) {
    target = opts.target as TargetName;
  } else if (opts.target) {
    console.error(`Unknown target: "${opts.target}"`);
    console.error('Available: ' + TARGETS.join(', '));
    return;
  } else {
    target = await selectTarget();
  }

  // ─── Print selection ──────────────────────────────────────────
  console.log(`\n${selectedFindings.length} findings · Goal: ${goal} · Target: ${target}\n`);

  // ─── Resolve target design (persisted artifact) ────────────────
  // Both --target-design <file> and --target-id <id> funnel through the same
  // artifact store as the fast path, so target handling is identical across
  // paths (only the surrounding brief depth differs — see build-fast.ts).
  let resolvedTarget: ResolvedTarget | null = null;
  let targetCriteria: string[] | null = null;
  let targetDesignSection: string | null = null;

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
        // Image targets get a real current-vs-target vision comparison — parity
        // with the fast path. HTML/Markdown fall back to the deterministic gap.
        let comparison: TargetComparison | null = null;
        if (resolvedTarget.imageDataUrl) {
          console.log('  Comparing current UI against target (vision)...');
          const obs = await visionObserve(session, {
            intent: 'buildThis',
            targetDesignDataUrl: resolvedTarget.imageDataUrl,
          }).catch(() => []);
          comparison = aggregateTargetComparison(obs);
          console.log(comparison ? '  Vision comparison: done' : '  Vision comparison unavailable — using deterministic gap');
        }
        const gap = runGapAnalysis(session, resolvedTarget.design, selectedFindings);
        const guidance = generateImplementationGuidance(session, resolvedTarget.design, gap, Object.keys(loadTokenMap(session.project)));
        targetCriteria = generateTargetAcceptanceCriteria(gap);
        targetDesignSection = generateTargetDesignSection(resolvedTarget.design, gap, guidance, targetCriteria, {
          name: resolvedTarget.artifact.name,
          id: resolvedTarget.artifact.id,
          sourceFile: resolvedTarget.artifact.sourceFile,
          comparison,
        });
      }
    } catch (err: any) {
      console.error(`  Target design failed: ${err.message}`);
      console.error('  Continuing without target design.');
      resolvedTarget = null;
    }
  }

  // ─── Generate package ─────────────────────────────────────────
  // Default into the run's implementation/ sibling (analysis/ → ../implementation).
  const outputDir = opts.output || join(dirname(artifactPath), '..', 'implementation');
  // We need to generate package first, then patch build-prompt.md, then copy target files
  console.log('Generating implementation package...');
  
  // 1. Generate the standard brief. One product-reasoning call produces BOTH the
  //    plain-language Goal & Context paragraph and the UX/Product Synthesis section
  //    (seeded by analyze's SessionUnderstanding). On failure the brief falls back
  //    to a deterministic context line and omits the synthesis section.
  console.log('Synthesizing product reasoning...');
  const synthesisEnabled = opts.synthesis !== false;
  // The narrated BUILD set, so we can analyze how its findings relate before assembly.
  const { build: buildSet } = classifyAndMerge(selectedFindings, session);
  const [reasoning, relationships] = await Promise.all([
    generateProductReasoning(
      selectedFindings, session, goal, synthesisEnabled,
      artifact.version === 2 ? artifact.sessionUnderstanding : undefined,
    ).catch(() => ({ goalContext: null, synthesis: null, raw: '' })),
    buildSet.length >= 2
      ? analyzeFindingRelationships(buildSet, session).catch(() => null)
      : Promise.resolve(null),
  ]);
  const goalContext = reasoning.goalContext;
  const synthesisMarkdown = reasoning.synthesis;
  if (reasoning.raw) console.log('\n[Product Reasoning]\n' + reasoning.raw + '\n');
  if (!synthesisEnabled) console.log('  UX/Product Synthesis disabled (--no-synthesis)');
  else if (!synthesisMarkdown) console.log('  UX/Product Synthesis unavailable — section omitted');
  else console.log('  UX/Product Synthesis: done');

  if (relationships) {
    const roles = [...relationships.byId.values()];
    const principles = roles.filter(r => r.role === 'principle').length;
    const consequences = roles.filter(r => r.role === 'consequence').length;
    const primaries = roles.filter(r => r.role === 'primary').length;
    console.log(`  Finding relationships: ${primaries} primary · ${principles} folded principle(s) · ${consequences} conditional`);
  } else if (buildSet.length >= 2) {
    console.log('  Finding relationships: none found — findings are independent');
  }

  const brief = generateImplementationBrief(
    selectedFindings, session, goal, target, goalContext, synthesisMarkdown, relationships,
  );
  let briefMarkdown = renderBriefToMarkdown(brief);
  
  // 2. Append Target Design section if available
  if (targetDesignSection) {
    briefMarkdown += '\n\n---\n\n' + targetDesignSection;
  }

  const preCriticBrief = briefMarkdown; // saved for debug artifact 08
  // The critic only sharpens narrated BUILD findings and their surrounding prose.
  // With no BUILD findings there is nothing for it to improve — skip the premium
  // call entirely rather than spend it on a review-only brief.
  const hasBuildFindings = /^### B\d+\./m.test(briefMarkdown);
  const criticResult = hasBuildFindings
    ? await (async () => {
        console.log('Critiquing implementation brief...');
        return critiqueImplementationBrief(briefMarkdown, {
          project: session.project,
          flow: session.flow,
          goal,
          target,
        });
      })()
    : null;
  if (!hasBuildFindings) console.log('  Prompt critic skipped — no BUILD findings to critique');
  if (criticResult) {
    const guarded = criticResult.changesMade.filter(c => c.startsWith('[critic-guard]')).length;
    const label = criticResult.applied
      ? ` — ${criticResult.changesMade.filter(c => c.startsWith('Rewrote ')).length} section(s) rewritten`
      : ' — kept original';
    const guardNote = guarded > 0 ? ` (${guarded} guard skip(s))` : '';
    console.log(`  Prompt critic: ${criticResult.overallScore.toFixed(1)}/10${label}${guardNote}`);
    briefMarkdown = criticResult.reviewedBriefMarkdown;
  } else if (hasBuildFindings) {
    console.log('  Prompt critic unavailable — using original brief');
  }
  
  // 3. Write package files manually (using generateImplementationPackage for structure, or direct)
  const pkgDir = join(outputDir, `implementation-${Date.now()}`);
  mkdirSync(pkgDir, { recursive: true });
  
  // Write build-prompt.md with optional target design section
  writeFileSync(join(pkgDir, 'build-prompt.md'), briefMarkdown);
  
  // Write context.json with target-design refs
  const context = {
    project: session.project,
    flow: session.flow,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    urlTimeline: session.urlTimeline,
    eventCount: session.events.length,
    screenshotCount: session.screenshots.length,
    noteCount: session.notes.length,
    targetDesign: resolvedTarget ? targetContextFragment(resolvedTarget) : undefined,
  };
  writeFileSync(join(pkgDir, 'context.json'), JSON.stringify(context, null, 2));

  // Copy the persisted target artifact (target.json + source + summary) into the package.
  if (resolvedTarget) copyTargetIntoPackage(pkgDir, resolvedTarget);

  // Copy screenshots from session
  const screenshotsDir = join(pkgDir, 'screenshots');
  mkdirSync(screenshotsDir, { recursive: true });
  let extracted = 0;
  for (let i = 0; i < session.screenshots.length; i++) {
    const s = session.screenshots[i];
    try {
      const match = s.dataUrl.match(/^data:image\/(jpeg|png);base64,(.+)$/);
      if (match) {
        const ext = match[1] === 'png' ? 'png' : 'jpg';
        const buf = Buffer.from(match[2], 'base64');
        writeFileSync(join(screenshotsDir, `${String(i).padStart(3, '0')}.${ext}`), buf);
        extracted++;
      }
    } catch { /* skip */ }
  }
  
  // Write summary.md
  writeFileSync(join(pkgDir, 'summary.md'), [
    `# Implementation Package — ${session.project}`,
    '',
    `**Flow:** ${session.flow}`,
    `**Goal:** ${goal}`,
    `**Target:** ${target}`,
    resolvedTarget ? `**Target design:** ${resolvedTarget.artifact.name} (${resolvedTarget.format}, id ${resolvedTarget.artifact.id})` : '',
    `**Opportunities addressed:** ${selectedFindings.length}`,
    ...(resolvedTarget ? ['', '## Target Design Mode', '', `This package builds toward a target design (desired state). See the Target Design section of build-prompt.md; the artifact is in target-design/ (source, target.json, summary.md).`, ''] : []),
  ].filter(Boolean).join('\n'));
  
  // Write acceptance-criteria.md — sourced from the brief's own acceptance (same
  // items shown per-finding), not the never-populated f.acceptanceCriteria.
  const allCriteria = [
    ...(targetCriteria || []),
    ...brief.acceptanceCriteria,
  ];
  if (allCriteria.length === 0) {
    console.warn(`  ⚠ acceptance-criteria.md is empty — ${brief.findings.length} narrated finding(s) produced no acceptance criteria. Expected only when nothing was narrated (empty BUILD).`);
  }
  writeFileSync(join(pkgDir, 'acceptance-criteria.md'), [
    `# Acceptance Criteria — ${session.project} / ${session.flow}`,
    `**Goal:** ${goal} · **Findings to verify:** ${brief.findings.length}`,
    '',
    ...(allCriteria.length ? allCriteria.map(c => `- [ ] ${c}`) : ['_No acceptance criteria — no narrated findings to build._']),
  ].join('\n'));
  
  // Write findings.json
  writeFileSync(join(pkgDir, 'findings.json'), JSON.stringify(selectedFindings, null, 2));

  // Project memory: the BUILD set just entered a package — record `built`
  // lifecycle events so future digests know these went out. Best-effort.
  try {
    if (artifact.version === 2 && buildSet.length > 0) {
      recordBuilt(session.project, artifact.runId, buildSet.map(m => m.representative));
      generateDigest(session.project);
    }
  } catch { /* never fatal */ }

  // Debug artifacts for this build.
  const debugDir = join(pkgDir, 'debug');
  mkdirSync(debugDir, { recursive: true });
  // 07 — product-reasoning raw output (Goal & Context + UX/Product Synthesis).
  if (reasoning.raw) {
    writeFileSync(join(debugDir, '07_product_reasoning.md'), [
      `# Product Reasoning (Goal & Context + UX/Product Synthesis)`,
      `**Session:** ${session.project} / ${session.flow}`,
      `**Generated:** ${new Date().toISOString()}`,
      '',
      reasoning.raw,
    ].join('\n'), 'utf-8');
  }
  // 07b — finding relationships (primary / folded principle / conditional consequence).
  if (relationships) {
    writeFileSync(join(debugDir, '07b_finding_relationships.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      relations: [...relationships.byId.values()],
    }, null, 2), 'utf-8');
  }
  // 08 — pre-critic brief (always written so the critic's delta is visible).
  writeFileSync(join(debugDir, '08_pre_critic_brief.md'), preCriticBrief, 'utf-8');
  // 09 — critic scores, rationale, and guard outcome.
  if (criticResult) {
    writeFileSync(join(debugDir, '09_prompt_critic.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      applied: criticResult.applied,
      overallScore: criticResult.overallScore,
      scores: criticResult.scores,
      rationale: criticResult.rationale,
      changesMade: criticResult.changesMade,
    }, null, 2), 'utf-8');
  }
  // 10 — final build prompt (post-critic, or identical to 08 if critic was rejected/skipped).
  writeFileSync(join(debugDir, '10_build_prompt.md'), briefMarkdown, 'utf-8');
  // 11 — per-stage AI call timings for this build (latency, cache, retries).
  const timings = getCallTimings();
  if (timings.length > 0) {
    writeFileSync(join(debugDir, '11_timings.json'), JSON.stringify(timings, null, 2), 'utf-8');
  }
  
  // Copy design system if available
  const dsPath = join(homedir(), '.loupe', 'config', 'design-system.json');
  const projDsPath = join(homedir(), '.loupe', 'projects', session.project, 'config', 'design-system.json');
  for (const p of [projDsPath, dsPath]) {
    if (existsSync(p)) {
      writeFileSync(join(pkgDir, 'design-system.json'), readFileSync(p));
      break;
    }
  }

  // ─── Route to destination ────────────────────────────────────
  const packageFiles = readdirSync(pkgDir).filter(f => f !== '.DS_Store');
  const screenshotFiles = readdirSync(join(pkgDir, 'screenshots')).length;

  const pkgCandidate: ImplementationPackage = {
    packageDir: pkgDir,
    files: packageFiles,
    screenshotCount: screenshotFiles,
    project: session.project,
    flow: session.flow,
  };
  const parsedPkg = parseImplementationPackage(pkgCandidate);
  if (!parsedPkg.ok || !parsedPkg.value) {
    console.error('Generated implementation package is malformed:');
    for (const err of parsedPkg.errors) console.error(`  - ${err}`);
    process.exitCode = 1;
    return;
  }
  const pkg = parsedPkg.value;

  const result = await routePackage(pkg, {
    project: session.project,
    destinationId: opts.destination,
    run: opts.run,
  });

  // ─── Display result ───────────────────────────────────────────
  console.log('');
  if (result.success) {
    console.log(`✓ Package routed to: ${result.message}`);
    if (result.packagePath) console.log(`  Path: ${result.packagePath}`);
    if (result.filesWritten.length > 0) {
      console.log(`  Files: ${result.filesWritten.length} written`);
    }
    if (result.commandRun) {
      console.log(`\n  Command:\n  ${result.commandRun}`);
    }
  } else {
    console.error(`✗ Routing failed: ${result.message}`);
    console.log(`  Package available at: ${pkgDir}`);
  }
  const { printHandoff } = await import('./build-fast.js');
  printHandoff(result.success && result.packagePath ? result.packagePath : pkgDir);

  const summary = timingsSummary();
  if (summary) console.log(`  ${summary}`);
}

function resolveOpportunitiesPath(inputPath: string): string | null {
  if (inputPath.endsWith('opportunities.json')) return inputPath;

  // Sibling artifact (e.g. an exported analysis dir, or a v1 layout).
  const sibling = join(dirname(inputPath), 'opportunities.json');
  if (existsSync(sibling)) return sibling;

  // Fall back to the latest canonical run for this session's project.
  return latestRunArtifact(inputPath);
}

/**
 * Find the newest ~/.loupe run whose analysis is OF THIS SESSION.
 * Matching by project alone is not enough: a fresh capture handed to
 * build-this would silently marry the newest run of some OLDER session and
 * produce a brief about the wrong recording (0 findings, stale context).
 * Session identity = startedAt (millisecond ISO — collision-free in practice).
 * No matching run → caller takes the fast path on the fresh session.
 */
function latestRunArtifact(sessionPath: string): string | null {
  try {
    const data = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    const parsed = parseSessionInput(data);
    if (!parsed.ok || !parsed.value) return null;
    const inputStartedAt = parsed.value.startedAt;

    const runsDir = join(projectRoot(parsed.value.project), 'runs');
    if (!existsSync(runsDir)) return null;

    // runIds are sortable ISO timestamps — newest last.
    for (const run of readdirSync(runsDir).sort().reverse()) {
      const candidate = join(runsDir, run, 'analysis', 'opportunities.json');
      if (!existsSync(candidate)) continue;
      const runSessionPath = join(runsDir, run, 'analysis', 'session.loupe');
      try {
        const runSession = parseSessionInput(JSON.parse(readFileSync(runSessionPath, 'utf-8')));
        if (runSession.ok && runSession.value?.startedAt === inputStartedAt) return candidate;
      } catch { /* unreadable run session — not a match */ }
    }
  } catch {
    // input not a readable session (e.g. a .html report) — give up
  }
  return null;
}

// ─── Interactive helpers (CLI prompts) ──────────────────────────

async function selectGoal(): Promise<GoalName> {
  const goals = Object.keys(GOALS);
  console.log('\nSelect goal:');
  goals.forEach((g, i) => {
    console.log(`  ${i + 1}. ${g} — ${GOALS[g].description.split('.')[0]}`);
  });

  // Default to "Minimal changes" if no TTY
  if (!process.stdin.isTTY) {
    console.log('  (no TTY, defaulting to "Minimal changes")');
    return 'Minimal changes';
  }

  // Read from stdin
  const answer = await prompt('Choose goal (1-' + goals.length + '): ');
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < goals.length) return goals[idx] as GoalName;
  console.log('  Defaulting to "Minimal changes"');
  return 'Minimal changes';
}

async function selectTarget(): Promise<TargetName> {
  console.log('\nSelect target:');
  TARGETS.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

  if (!process.stdin.isTTY) {
    console.log('  (no TTY, defaulting to "Claude Code")');
    return 'Claude Code';
  }

  const answer = await prompt('Choose target (1-' + TARGETS.length + '): ');
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < TARGETS.length) return TARGETS[idx];
  console.log('  Defaulting to "Claude Code"');
  return 'Claude Code';
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const onData = (data: Buffer) => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve(data.toString().trim());
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}
