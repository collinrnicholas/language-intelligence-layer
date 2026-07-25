// ─── Vision observation pass ─────────────────────────────────────
//
// One structured pass that turns screenshots (and an optional target design)
// into UIObservation JSON. Downstream reasoning models work from these
// STRUCTURED observations, not raw images — vision and reasoning are separate
// tasks routed to the models best at each (see routing-policy.ts).
//
// Fallback: if the primary vision provider fails (quota, outage), the pass
// retries once on the Claude vision fallback and logs internally. Model names
// never surface in user-facing output.
//
// Caching: responses are cached by the standard callLLM content key, which
// includes every image hash + the prompt — i.e. session keyframes + target
// design + prompt version. Re-running Build This on an unchanged session
// reuses the cached observations.

import type { LoupeSession } from '../../cli.js';
import { callLLM } from './call.js';
import { selectKeyframeIndices } from '../../ai/keyframes.js';
import { resolveModel, VISION_FALLBACK_MODEL, type IntentName } from '../routing-policy.js';

// ─── Structured output ──────────────────────────────────────────

export interface UIObservation {
  screenshotId: string;
  timestamp?: number;
  viewport?: { width: number; height: number };
  layout: {
    header?: object;
    primaryAction?: object;
    cards?: object[];
    navigation?: object;
    density?: 'low' | 'medium' | 'high';
  };
  hierarchy: {
    primaryFocus?: string;
    competingElements?: string[];
    clarityScore?: number;
  };
  visualDesign: {
    spacingIssues?: string[];
    typographyIssues?: string[];
    colorIssues?: string[];
    alignmentIssues?: string[];
  };
  targetComparison?: TargetComparison;
  risks?: string[];
  confidence: number;
}

/** The current-vs-target delta the vision pass produces when a target design is
 *  attached. Aggregated across keyframes by {@link aggregateTargetComparison} and
 *  rendered into the unified Target Design section on both build paths. */
export interface TargetComparison {
  targetProvided: boolean;
  majorDifferences: string[];
  elementsToKeep: string[];
  elementsToChange: string[];
  missingFromCurrent: string[];
  presentButShouldBeRemoved: string[];
}

/**
 * Merge the per-keyframe targetComparison blocks into one deduped delta.
 * Returns null when no keyframe produced a target comparison (e.g. vision was
 * unavailable, or the target was not an image) — callers then fall back to the
 * deterministic gap analysis so the section is never empty.
 */
export function aggregateTargetComparison(obs: UIObservation[]): TargetComparison | null {
  const blocks = obs.map(o => o.targetComparison).filter((c): c is TargetComparison => !!c && c.targetProvided);
  if (blocks.length === 0) return null;
  const merge = (pick: (c: TargetComparison) => string[] | undefined): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const b of blocks) {
      for (const s of pick(b) ?? []) {
        const t = String(s).trim();
        if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
      }
    }
    return out;
  };
  return {
    targetProvided: true,
    majorDifferences: merge(c => c.majorDifferences),
    elementsToKeep: merge(c => c.elementsToKeep),
    elementsToChange: merge(c => c.elementsToChange),
    missingFromCurrent: merge(c => c.missingFromCurrent),
    presentButShouldBeRemoved: merge(c => c.presentButShouldBeRemoved),
  };
}

export const DEFAULT_MAX_SHOTS = 5;

// ─── Prompt (exported for determinism tests — stable prompt = stable cache) ──

export function buildVisionPrompt(shotCount: number, hasTarget: boolean, transcriptHint: string): string {
  return [
    'You are the vision-observation pass of a UX analysis pipeline. Read the attached UI',
    `screenshot${shotCount === 1 ? '' : 's'} and return STRUCTURED observations as JSON. A separate reasoning model`,
    'consumes your output — be factual and specific; do not recommend fixes.',
    '',
    hasTarget
      ? `The LAST attached image is the TARGET DESIGN. The first ${shotCount} image(s) show the current UI. Fill targetComparison by comparing current state against the target.`
      : 'No target design is provided — omit targetComparison or set targetProvided:false.',
    '',
    transcriptHint ? `REVIEWER NARRATION (context for what to look at):\n${transcriptHint}\n` : '',
    'For EACH current-UI screenshot, in order, produce one object:',
    '{',
    '  "screenshotId": "shot-<index>",',
    '  "layout": { "header": {...}, "primaryAction": {...}, "cards": [...], "navigation": {...}, "density": "low|medium|high" },',
    '  "hierarchy": { "primaryFocus": "...", "competingElements": [...], "clarityScore": 0-10 },',
    '  "visualDesign": { "spacingIssues": [...], "typographyIssues": [...], "colorIssues": [...], "alignmentIssues": [...] },',
    hasTarget
      ? '  "targetComparison": { "targetProvided": true, "majorDifferences": [...], "elementsToKeep": [...], "elementsToChange": [...], "missingFromCurrent": [...], "presentButShouldBeRemoved": [...] },'
      : '',
    '  "risks": [...],',
    '  "confidence": 0.0-1.0',
    '}',
    '',
    'Rules:',
    '- Describe what is VISIBLE: element names from their visible text, proportions ("the plans panel',
    '  occupies ~60% of viewport height"), what is clipped or cut off, what competes for attention.',
    '- layout.* values are small objects of literal facts (e.g. {"text": "Start Recording", "position": "below fold"}).',
    '- Quote exact visible strings; never invent selectors or CSS values.',
    '- Respond with ONLY a JSON array, one object per current-UI screenshot, in order. No markdown fences.',
  ].filter(s => s !== '').join('\n');
}

// ─── Parsing (exported for schema tests) ─────────────────────────

export function parseUIObservations(raw: string): UIObservation[] | null {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const candidates = [cleaned];
  const first = cleaned.indexOf('[');
  const last = cleaned.lastIndexOf(']');
  if (first !== -1 && last > first) candidates.push(cleaned.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const arr = JSON.parse(c);
      if (!Array.isArray(arr)) continue;
      const valid = arr.filter(isUIObservation);
      if (valid.length > 0) return valid;
    } catch { /* next candidate */ }
  }
  return null;
}

function isUIObservation(o: unknown): o is UIObservation {
  if (!o || typeof o !== 'object') return false;
  const v = o as Record<string, unknown>;
  return (
    typeof v.screenshotId === 'string' &&
    typeof v.confidence === 'number' && v.confidence >= 0 && v.confidence <= 1 &&
    !!v.layout && typeof v.layout === 'object' &&
    !!v.hierarchy && typeof v.hierarchy === 'object' &&
    !!v.visualDesign && typeof v.visualDesign === 'object'
  );
}

// ─── Task ────────────────────────────────────────────────────────

export interface VisionObserveOptions {
  intent: IntentName;
  /** Data-URL of a target design image, when the user provided one. */
  targetDesignDataUrl?: string | null;
  maxShots?: number;
}

/**
 * Run the vision observation pass over the session's keyframes.
 * Returns [] on total failure — callers proceed on deterministic evidence
 * alone; a failed AI stage never aborts the run.
 */
export async function visionObserve(
  session: LoupeSession,
  opts: VisionObserveOptions,
): Promise<UIObservation[]> {
  const maxShots = opts.maxShots ?? DEFAULT_MAX_SHOTS;
  const narrationTs = session.notes
    .filter(n => n.type === 'transcript')
    .map(n => n.timestamp)
    .sort((a, b) => a - b);
  const anchors = narrationTs.length > 0
    ? [narrationTs[0], narrationTs[Math.floor(narrationTs.length / 2)], narrationTs[narrationTs.length - 1]]
    : [];
  // Keep ORIGINAL screenshot indices so observations stay auditable — the
  // returned screenshotId ties to screenshots/NNN.jpg and its capture time.
  const shotIndices = selectKeyframeIndices(session, anchors, maxShots);
  const shots = shotIndices.map(i => session.screenshots[i].dataUrl);
  if (shots.length === 0) return [];

  const transcriptHint = session.notes
    .filter(n => n.type === 'transcript')
    .slice(0, 12)
    .map(n => `- "${n.text.trim()}"`)
    .join('\n');

  const hasTarget = !!opts.targetDesignDataUrl;
  const images = hasTarget ? [...shots, opts.targetDesignDataUrl as string] : shots;
  const prompt = buildVisionPrompt(shots.length, hasTarget, transcriptHint);

  const primary = resolveModel(opts.intent, 'vision');
  const models = [primary, VISION_FALLBACK_MODEL].filter(
    (m, i, a): m is string => !!m && a.indexOf(m) === i,
  );

  for (const model of models) {
    try {
      const raw = await callLLM('explain', prompt, {
        model,
        images,
        maxTokens: 3000,
        stage: 'vision-observe',
        promptVersion: 'vision-observe-v1',
      });
      const parsed = parseUIObservations(raw);
      if (parsed) {
        // Observations come back in shot order — remap identity to the ORIGINAL
        // screenshot index + capture timestamp, not the model's batch labels.
        return parsed.map((o, i) => {
          const origIdx = shotIndices[i];
          return {
            ...o,
            screenshotId: origIdx !== undefined ? `screenshot-${origIdx}` : (o.screenshotId || `shot-${i}`),
            timestamp: origIdx !== undefined ? session.screenshots[origIdx].timestamp : o.timestamp,
            viewport: o.viewport ?? session.viewport,
          };
        });
      }
      console.log('[vision-observe] unparseable response — trying fallback provider');
    } catch (err) {
      // Internal log only; user-facing output never names models (ADR-010 spirit).
      console.log(`[vision-observe] provider failed (${err instanceof Error ? err.message.slice(0, 80) : 'error'}) — trying fallback`);
    }
  }
  return [];
}

/** Render observations as a compact evidence block for reasoning prompts. */
export function observationsBlock(obs: UIObservation[]): string {
  if (obs.length === 0) return '';
  return [
    'STRUCTURED UI OBSERVATIONS (from the vision pass — factual, per screenshot):',
    JSON.stringify(obs, null, 1),
  ].join('\n');
}
