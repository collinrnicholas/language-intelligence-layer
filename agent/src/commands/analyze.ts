import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import type { LoupeSession, Opportunity } from '../cli.js';
import { runDeterministicChecks } from '../checks/deterministic.js';
import { runDriftChecks } from '../checks/drift.js';
import { runPersonaReview, type ReviewOutput } from '../ai/review.js';
import { transcribeIntoSession } from './transcribe.js';
import { stitchTranscriptFragments } from '../ai/transcript-stitcher.js';
import { judgeNarration } from '../ai/narration-judge.js';
import { generateTargets } from '../ai/target-generator.js';
import { enumerateContentPatterns } from '../ai/content-enumerator.js';
import { loadTokenMap } from '../ai/implementation-brief.js';
import { isJudgeableFinding } from '../ai/narration.js';
import { deriveSessionUnderstanding, type SessionUnderstanding } from '../ai/session-understanding.js';
import { pingGateway, gatewayUnreachableMessage, getCallTimings, resetCallTimings, timingsSummary } from '../llm/index.js';
import { intentRuns } from '../llm/routing-policy.js';
import { visionObserve, type UIObservation } from '../llm/tasks/vision-observe.js';
import { synthesizeOpportunities, mergeWithDeterministic } from '../llm/tasks/synthesize-opportunities.js';
import { generateReport } from '../reporters/report.js';
import { quarantineOpportunities, parseSessionInput, type OpportunitiesArtifactV2 } from '../schema.js';
import { makeRunId, runDir } from '../paths.js';
import { extractScreenshots, extractedCount } from '../screenshots.js';
import { recordAnalyzeRun, generateDigest } from '../memory/index.js';

interface AnalyzeOptions {
  output?: string;
  ai?: boolean;
  /** User intent (docs/UX_STATES.md): 'review' = UX Review (vision pass + one
   *  reasoning synthesis); 'audit' = Complete Audit (5-persona fanout + judge).
   *  Users pick intents via `loupe review` / `loupe audit`; the internal
   *  pipeline map lives in llm/routing-policy.ts. */
  intent?: 'review' | 'audit';
}

/** Write one debug artifact. Silently skips on any error so a debug write never
 *  kills a real analysis run. */
function writeDebug(debugDir: string, filename: string, content: string): void {
  try {
    mkdirSync(debugDir, { recursive: true });
    writeFileSync(join(debugDir, filename), content, 'utf-8');
  } catch { /* never fatal */ }
}

export async function analyzeSession(filePath: string, opts: AnalyzeOptions) {
  const fullPath = resolve(filePath);
  if (!existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    return;
  }

  resetCallTimings(); // "this run's" timings must not include prior commands
  const intent: 'review' | 'audit' = opts.intent === 'audit' ? 'audit' : 'review';
  console.log(`Analyzing: ${fullPath}`);
  console.log(`  Intent: ${intent === 'audit' ? 'Complete Audit' : 'UX Review'}`);

  // Read session
  const raw = readFileSync(fullPath, 'utf-8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error('Invalid JSON');
    process.exitCode = 1;
    return;
  }

  const parsedSession = parseSessionInput(data);
  if (!parsedSession.ok || !parsedSession.value) {
    console.error('Invalid Loupe session:');
    for (const err of parsedSession.errors) console.error(`  - ${err}`);
    process.exitCode = 1;
    return;
  }
  const session: LoupeSession = parsedSession.value;

  // Gate all AI steps (transcription + persona review) on one upfront
  // reachability check. When the gateway is down this turns the silent
  // empty-brief failure into a single clear, actionable message — instead of a
  // transcription no-op followed by five reviewer stack traces.
  const aiEnabled = opts.ai !== false;
  let aiReachable = aiEnabled;
  if (aiEnabled) {
    const ping = await pingGateway();
    aiReachable = ping.reachable;
    if (!aiReachable) {
      console.warn(gatewayUnreachableMessage(ping.url, 'transcription + AI review'));
      console.warn('  Continuing with deterministic checks only (no narrated findings).');
    }
  }

  // Auto-transcribe: turn embedded narration audio into transcript notes so that
  // narrated findings — and the Build This brief — work from `analyze` alone,
  // with no separate `transcribe` step.
  let sessionEnriched = false;
  const alreadyTranscribed = session.notes.some(n => n.type === 'transcript');
  if (aiReachable && session.audioData && !alreadyTranscribed) {
    console.log('Transcribing narration audio...');
    try {
      const transcribedNotes = await transcribeIntoSession(session);
      console.log(`  ${transcribedNotes} transcript note(s)`);
      if (transcribedNotes > 0) sessionEnriched = true;
    } catch (err) {
      console.log(`  Transcription failed — continuing without narration (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // Stitch adjacent ASR fragments into complete sentences. ASR segments on
  // silence/pauses, often mid-sentence, producing fragment quotes ("the screen
  // and isn't fully visible") that appear verbatim in build prompt quotes.
  if (aiReachable && session.notes.some(n => n.type === 'transcript')) {
    console.log('Stitching transcript fragments...');
    try {
      const fragCount = session.notes.filter(n => n.type === 'transcript').length;
      const stitchedCount = await stitchTranscriptFragments(session);
      if (stitchedCount < fragCount) {
        console.log(`  ${fragCount} fragments → ${stitchedCount} sentences`);
        sessionEnriched = true;
      } else {
        console.log(`  ${fragCount} note(s) — no fragments to merge`);
      }
    } catch {
      console.log('  Transcript stitching unavailable — continuing with raw segments');
    }
  }

  // Debug artifact buffer — accumulated through the pipeline, written once the
  // analysis dir is known. Each entry is { filename, content }.
  const debugArtifacts: Array<{ filename: string; content: string }> = [];

  // Analysis state (not in canonical format — added by analyzer)
  const findings: Opportunity[] = [];

  // 1) Run deterministic checks
  console.log('Running deterministic checks...');
  const detFindings = runDeterministicChecks(session);
  findings.push(...detFindings);
  console.log(`  ${detFindings.length} findings`);

  // 1.5) Run design drift checks (only when a per-project design system exists).
  console.log('Running design drift checks...');
  const drift = runDriftChecks(session);
  findings.push(...drift.findings);

  // Debug: 01 — full session transcript.
  const transcriptNotes = session.notes.filter(n => n.type === 'transcript');
  if (transcriptNotes.length > 0) {
    const transcriptLines = [
      `# Session Transcript — ${session.project} / ${session.flow}`,
      `**Duration:** ${((new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 1000).toFixed(0)}s · **Notes:** ${transcriptNotes.length}`,
      `**URL:** ${session.urlTimeline[0]?.url ?? '(unknown)'}`,
      '',
      ...transcriptNotes
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(n => {
          const startS = (n.timestamp / 1000).toFixed(0);
          const endS = n.endTimestamp ? `–${(n.endTimestamp / 1000).toFixed(0)}` : '';
          return `[${startS}${endS}s] ${n.text.trim()}`;
        }),
    ].join('\n');
    debugArtifacts.push({ filename: '01_transcript.md', content: transcriptLines });
  }

  // 2) AI persona review (skipped when the gateway is unreachable — already
  //    warned once above, so no per-reviewer failure spam).
  let reviewOutput: ReviewOutput | undefined;
  // Product-level frame. Two roles (specs/session-understanding.md):
  //   • preliminaryUnderstanding — derived from the transcript+URL BEFORE persona
  //     review, so reviewers identify issues with the product's purpose in mind.
  //   • sessionUnderstanding — derived after the judge from the NARRATED findings,
  //     used for target generation + synthesis and persisted on the artifact.
  let sessionUnderstanding: SessionUnderstanding | null = null;
  if (aiReachable) {
    let preliminaryUnderstanding: SessionUnderstanding | null = null;
    if (session.notes.some(n => n.type === 'transcript')) {
      console.log('Framing product (pre-review)...');
      try {
        // Empty findings on purpose: the frame must come from the reviewer's own
        // words, not from deterministic findings that would pollute the product model.
        preliminaryUnderstanding = await deriveSessionUnderstanding(session, []);
        if (preliminaryUnderstanding) {
          console.log(`  Product: ${preliminaryUnderstanding.productType} (confidence ${preliminaryUnderstanding.confidence.toFixed(2)})`);
          debugArtifacts.push({
            filename: '01b_preliminary_understanding.json',
            content: JSON.stringify(preliminaryUnderstanding, null, 2),
          });
        }
      } catch {
        console.log('  Pre-review product framing unavailable — reviewers run without it');
      }
    }

    // Vision observation pass — shared by both intents. Structured observations
    // feed the reasoning synthesis (review) or supplement the report (audit).
    const policyIntent = intent === 'audit' ? 'completeAudit' : 'uxReview';
    let observations: UIObservation[] = [];
    if (intentRuns(policyIntent, 'vision-observe')) {
      console.log('Observing screenshots (vision pass)...');
      observations = await visionObserve(session, { intent: policyIntent });
      console.log(`  ${observations.length} structured observation(s)`);
      if (observations.length > 0) {
        debugArtifacts.push({
          filename: '02_vision_observations.json',
          content: JSON.stringify(observations, null, 2),
        });
      }
    }

    if (intentRuns(policyIntent, 'persona-review')) {
      // ── Complete Audit: full 5-persona fanout (the only fanout-heavy path).
      console.log('Running AI persona review (Complete Audit)...');
      try {
        const review = await runPersonaReview(session, findings, preliminaryUnderstanding);
        findings.push(...review.findings);
        console.log(`  ${review.findings.length} merged findings from ${review.reviewedBy.length} reviewers`);
        reviewOutput = review;

        // Debug: 02b — per-reviewer raw findings.
        debugArtifacts.push({
          filename: '02b_per_reviewer.json',
          content: JSON.stringify(
            review.perReviewer.map(r => ({
              reviewer: r.name,
              findingCount: r.findings.length,
              findings: r.findings.map(f => ({
                id: f.id, title: f.title, category: f.category,
                severity: f.severity, confidence: f.confidence,
                description: (f.description ?? '').slice(0, 300),
              })),
            })),
            null, 2,
          ),
        });

        // Debug: 03 — merged findings from all reviewers.
        debugArtifacts.push({
          filename: '03_merged_findings.json',
          content: JSON.stringify(
            review.findings.map(f => ({
              id: f.id, title: f.title, category: f.category,
              severity: f.severity, confidence: f.confidence,
              reviewedBy: f.reviewedBy,
              description: (f.description ?? '').slice(0, 300),
            })),
            null, 2,
          ),
        });
      } catch (err) {
        console.log('  AI review unavailable — continuing with deterministic checks');
      }
    } else {
      // ── UX Review: one reasoning synthesis over structured observations —
      //    no persona fanout. Deterministic findings are preserved regardless
      //    of whether the synthesis succeeds.
      console.log('Synthesizing opportunities...');
      const synthesized = await synthesizeOpportunities(
        session, findings, observations, policyIntent, preliminaryUnderstanding,
      ).catch(() => null);
      // Single merge point between deterministic and synthesized findings —
      // future dedupe between the two belongs inside mergeWithDeterministic.
      const merged = mergeWithDeterministic([...findings], synthesized);
      findings.length = 0;
      findings.push(...merged);
      console.log(synthesized
        ? `  ${synthesized.length} opportunity(ies) from synthesis`
        : '  Synthesis unavailable — continuing with deterministic findings');

      if (synthesized && synthesized.length > 0) {
        debugArtifacts.push({
          filename: '03_merged_findings.json',
          content: JSON.stringify(
            synthesized.map(f => ({
              id: f.id, title: f.title, category: f.category,
              severity: f.severity, confidence: f.confidence,
              description: (f.description ?? '').slice(0, 300),
            })),
            null, 2,
          ),
        });
      }
    }
  }

  // 2.5) Judge which findings the reviewer actually narrated (semantic gate).
  //      Tags each candidate with `narrated` + supporting note; build-this reads
  //      these instead of keyword-matching. Machine-only findings (console errors)
  //      are excluded up front; deterministic-but-narratable ones (touch targets,
  //      slow requests) ARE judged, so an explicit verdict can promote them.
  if (aiReachable && session.notes.some(n => n.type === 'transcript')) {
    const candidates = findings.filter(f => isJudgeableFinding(f));
    if (candidates.length > 0) {
      console.log('Judging which findings the reviewer narrated...');
      try {
        const verdicts = await judgeNarration(session, candidates);
        let narratedCount = 0;
        for (const f of candidates) {
          const v = verdicts.get(f.id);
          if (!v) continue;
          f.narrated = v.narrated;
          if (v.note !== null) f.narrationNote = v.note;
          if (v.narrated) narratedCount++;
        }
        console.log(`  ${verdicts.size} judged · ${narratedCount} narrated`);

        // Debug: 04 — narration judge verdicts.
        debugArtifacts.push({
          filename: '04_narration_verdicts.json',
          content: JSON.stringify(
            candidates.map(f => {
              const v = verdicts.get(f.id);
              const noteText = typeof f.narrationNote === 'number'
                ? session.notes[f.narrationNote]?.text?.trim() ?? null
                : null;
              return {
                id: f.id,
                title: f.title,
                category: f.category,
                narrated: v?.narrated ?? null,
                noteIndex: v?.note ?? null,
                quote: noteText,
              };
            }),
            null, 2,
          ),
        });

        // 2.55) Derive the product-level understanding NOW — before targets are
        //       written — so each generated target can reason about what the
        //       product is FOR, not just its own finding. Persisted on the
        //       artifact and reused by build-this synthesis. Null-safe.
        //
        //       Runs CONCURRENTLY with content-pattern enumeration (2.6a): both
        //       feed target generation but are independent of each other —
        //       understanding reads the transcript, enumeration reads the
        //       screenshot. Sequencing them was pure added latency.
        const narratedFindings = candidates.filter(f => f.narrated);
        let contentEnumeration: string | null = null;
        if (narratedFindings.length > 0) {
          console.log('Deriving session understanding...');
          const hasContentFindings = narratedFindings.some(f => f.category === 'Content');
          if (hasContentFindings) console.log('  Enumerating content patterns (screenshot-primary)...');

          const [understandingResult, enumerationResult] = await Promise.all([
            // Frame the product from the narrated (judge-confirmed) findings only —
            // detected/unconfirmed findings would pollute the product model with
            // issues the reviewer never actually voiced.
            deriveSessionUnderstanding(session, narratedFindings).catch(() => null),
            hasContentFindings
              ? enumerateContentPatterns(session).catch(() => null)
              : Promise.resolve(null),
          ]);

          sessionUnderstanding = understandingResult;
          contentEnumeration = enumerationResult;

          if (sessionUnderstanding) {
            console.log(`  Product: ${sessionUnderstanding.productType} (confidence ${sessionUnderstanding.confidence.toFixed(2)})`);
            debugArtifacts.push({
              filename: '04b_session_understanding.json',
              content: JSON.stringify(sessionUnderstanding, null, 2),
            });
          } else {
            console.log('  Session understanding unavailable — targets use finding context only');
          }
          if (hasContentFindings) {
            if (contentEnumeration) console.log('  Content enumeration: done');
            else console.log('  Content enumeration unavailable — content targets will use finding description only');
          }
        }

        // 2.6) Generate a concrete target per narrated finding (functional vs
        //      visual, element- and token-specific) — replacing the templates.
        if (narratedFindings.length > 0) {
          console.log('Generating per-finding targets...');

          // Debug: 05 — content enumeration (if any).
          if (contentEnumeration) {
            debugArtifacts.push({
              filename: '05_content_enumeration.md',
              content: `# Content Enumeration\n\n${contentEnumeration}`,
            });
          }

          try {
            const fixes = await generateTargets(session, narratedFindings, loadTokenMap(session.project), contentEnumeration, sessionUnderstanding);
            for (const f of narratedFindings) {
              const fx = fixes.get(f.id);
              if (!fx) continue;
              f.fixKind = fx.kind;
              f.generatedTarget = fx.target;
              if (fx.task) f.generatedTask = fx.task;
              if (fx.acceptance.length) f.generatedAcceptance = fx.acceptance;
            }
            console.log(`  ${fixes.size} target(s) generated`);

            // Debug: 06 — narrated findings with generated targets.
            debugArtifacts.push({
              filename: '06_narrated_findings.json',
              content: JSON.stringify(
                narratedFindings.map(f => ({
                  id: f.id,
                  title: f.title,
                  category: f.category,
                  severity: f.severity,
                  confidence: f.confidence,
                  narrationNote: typeof f.narrationNote === 'number'
                    ? session.notes[f.narrationNote]?.text?.trim() ?? null
                    : null,
                  fixKind: f.fixKind ?? null,
                  generatedTarget: f.generatedTarget ?? null,
                  generatedTask: f.generatedTask ?? null,
                  generatedAcceptance: f.generatedAcceptance ?? [],
                })),
                null, 2,
              ),
            });
          } catch {
            console.log('  Target generation unavailable — build-this will use templates');
          }
        }
      } catch {
        console.log('  Narration judge unavailable — build-this will use keyword fallback');
      }
    }
  }

  // Debug: 00 — per-stage AI call timings for this run (stage, model, token
  // estimates, image count, latency, cache hit/miss, retries).
  const timings = getCallTimings();
  if (timings.length > 0) {
    debugArtifacts.push({
      filename: '00_timings.json',
      content: JSON.stringify(timings, null, 2),
    });
  }

  // Quarantine malformed findings instead of aborting. Deterministic and
  // drift findings are code-generated and trusted, but AI reviewers can emit
  // malformed objects — one bad finding must never discard a valid report (ADR-008).
  const { valid: validFindings, dropped } = quarantineOpportunities(findings);
  if (dropped > 0) {
    console.warn(`  ⚠ Dropped ${dropped} malformed finding(s); keeping ${validFindings.length}`);
  }

  // 3) Write the canonical run directory under ~/.loupe.
  //
  //   <runDir>/analysis/
  //     session.loupe     — the capture, copied in once (the ONLY base64 home)
  //     screenshots/      — extracted once, referenced by report + packages
  //     opportunities.json — v2: references session.loupe + screenshots, no base64
  //     report.html       — references screenshots/, no inline base64
  //     debug/            — numbered pipeline artifacts for each run
  //
  // ~/.loupe is canonical; --output produces a flat export ("view") of analysis/.
  console.log('Generating report...');
  const runId = makeRunId();
  const analysisDir = join(runDir(session.project, runId), 'analysis');
  mkdirSync(analysisDir, { recursive: true });

  // Flush buffered debug artifacts now that we have the analysis dir.
  if (debugArtifacts.length > 0) {
    const debugDir = join(analysisDir, 'debug');
    for (const { filename, content } of debugArtifacts) {
      writeDebug(debugDir, filename, content);
    }
    console.log(`  Debug artifacts: ${debugArtifacts.length} file(s) → debug/`);
  }

  // Persist the capture into the run. Normally a verbatim copy (exact bytes incl.
  // audio), but when we auto-transcribed we write the enriched session so the
  // notes are available to downstream `build-this` (which reads this file).
  const sessionFile = 'session.loupe';
  const sessionDest = join(analysisDir, sessionFile);
  if (sessionEnriched) {
    writeFileSync(sessionDest, JSON.stringify({ session }, null, 2), 'utf-8');
  } else {
    cpSync(fullPath, sessionDest);
  }

  // Extract screenshots once; everything downstream references these.
  const screenshots = extractScreenshots(session, join(analysisDir, 'screenshots'));

  const reportFile = 'report.html';
  const html = generateReport(session, validFindings, reviewOutput, screenshots, { driftSkipped: drift.skipped });
  writeFileSync(join(analysisDir, reportFile), html, 'utf-8');

  const artifact: OpportunitiesArtifactV2 = {
    version: 2,
    generatedAt: new Date().toISOString(),
    runId,
    sessionFile,
    reportFile,
    screenshots,
    opportunities: validFindings,
    ...(sessionUnderstanding ? { sessionUnderstanding } : {}),
  };
  const opportunitiesPath = join(analysisDir, 'opportunities.json');
  writeFileSync(opportunitiesPath, JSON.stringify(artifact, null, 2), 'utf-8');

  // Project memory: index this run and refresh the digest. Best-effort — a
  // memory failure must never break an analysis (same rule as debug writes).
  try {
    recordAnalyzeRun(session, runId, intent, validFindings, sessionUnderstanding);
    generateDigest(session.project);
  } catch { /* never fatal */ }

  // Optional local export — a flat copy of analysis/, never the source of truth.
  let exportDir: string | undefined;
  if (opts.output) {
    exportDir = resolve(opts.output);
    mkdirSync(exportDir, { recursive: true });
    cpSync(analysisDir, exportDir, { recursive: true });
  }

  console.log(`\n✓ Run: ${analysisDir}`);
  console.log(`✓ Report: ${join(analysisDir, reportFile)}`);
  console.log(`✓ Opportunities: ${opportunitiesPath}`);
  if (exportDir) console.log(`✓ Exported to: ${exportDir}`);
  console.log(`  Report size: ${html.length} bytes`);
  console.log(`  Screenshots: ${extractedCount(screenshots)}/${session.screenshots.length} extracted`);
  console.log(`  Total opportunities: ${validFindings.length}`);

  // Summary by severity
  const bySeverity: Record<string, number> = {};
  for (const f of validFindings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }
  if (bySeverity.Critical) console.log(`  Critical: ${bySeverity.Critical}`);
  if (bySeverity.High) console.log(`  High:     ${bySeverity.High}`);
  if (bySeverity.Medium) console.log(`  Medium:   ${bySeverity.Medium}`);
  if (bySeverity.Low) console.log(`  Low:      ${bySeverity.Low}`);
  if (bySeverity.Info) console.log(`  Info:     ${bySeverity.Info}`);

  const summary = timingsSummary();
  if (summary) console.log(`  ${summary}`);
}
