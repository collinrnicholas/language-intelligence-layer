// Keyframe selection — pick the few screenshots that actually matter, the way a
// person hand-picks frames when prompting a frontier model. Shared by the persona
// reviewers (before findings exist) and per-finding target generation (after).
//
// Signals, in priority order: caller-supplied "moments" (narration/issue
// timestamps), then route changes (a new screen appeared), then click bursts (the
// settled frame after a cluster of interactions). Frames are deduped by index and
// spread in time so a request never gets several near-identical shots.

import type { LoupeSession, Opportunity, SessionEvent } from '../cli.js';

// Clicks within this window are one interaction burst; we keep the settled frame.
const BURST_WINDOW_MS = 1500;
// Two chosen frames closer than this in time are treated as near-duplicates and
// the later one is skipped.
const KEYFRAME_MIN_GAP_MS = 3000;

/**
 * Select up to `maxCount` distinct, well-spread keyframes. `priorityTs` are the
 * caller's most-relevant moments (issue/narration timestamps); route changes and
 * click bursts add diversity. Falls back to timeline-spread anchors when there are
 * no priority moments or events. Returns data URLs ready for callLLM images[].
 */
export function selectKeyframes(
  session: LoupeSession,
  priorityTs: number[],
  maxCount = 3,
): string[] {
  return selectKeyframeIndices(session, priorityTs, maxCount)
    .map(idx => session.screenshots[idx].dataUrl);
}

/**
 * Same selection, returning ORIGINAL screenshot indices so callers can keep
 * evidence auditable — a vision observation for `screenshot-7` ties back to
 * `screenshots/007.jpg` in the package and its capture timestamp.
 */
export function selectKeyframeIndices(
  session: LoupeSession,
  priorityTs: number[],
  maxCount = 3,
): number[] {
  const shots = session.screenshots;
  if (shots.length === 0) return [];

  const nearestIndex = (ts: number): number => {
    let best = 0;
    for (let i = 1; i < shots.length; i++) {
      if (Math.abs(shots[i].timestamp - ts) < Math.abs(shots[best].timestamp - ts)) best = i;
    }
    return best;
  };

  const candidates: number[] = [];
  for (const ts of priorityTs) if (typeof ts === 'number') candidates.push(ts);
  for (const u of session.urlTimeline) if (u.navigationType !== 'initial') candidates.push(u.timestamp);
  const clicks = session.events
    .filter((e): e is Extract<SessionEvent, { type: 'click' }> => e.type === 'click')
    .sort((a, b) => a.timestamp - b.timestamp);
  for (let i = 0; i < clicks.length; ) {
    let j = i;
    while (j + 1 < clicks.length && clicks[j + 1].timestamp - clicks[j].timestamp <= BURST_WINDOW_MS) j++;
    candidates.push(clicks[j].timestamp); // the settled frame after the burst
    i = j + 1;
  }

  const chosenIdx: number[] = [];
  const chosenTs: number[] = [];
  const consider = (ts: number, force = false): void => {
    if (chosenIdx.length >= maxCount) return;
    const idx = nearestIndex(ts);
    if (chosenIdx.includes(idx)) return;
    const shotTs = shots[idx].timestamp;
    if (!force && chosenTs.some(t => Math.abs(t - shotTs) < KEYFRAME_MIN_GAP_MS)) return;
    chosenIdx.push(idx);
    chosenTs.push(shotTs);
  };

  candidates.forEach((ts, k) => consider(ts, k === 0 && priorityTs.length > 0));

  // No relevant moment matched (sparse session) → spread across the timeline so a
  // vision caller still sees representative frames rather than nothing.
  if (chosenIdx.length === 0) {
    [0.25, 0.5, 0.75].map(f => shots[Math.floor((shots.length - 1) * f)].timestamp)
      .forEach((ts, k) => consider(ts, k === 0));
  }

  return chosenIdx;
}

/** Keyframes for a batch of findings — their narration (or finding) timestamps are
 *  the priority moments. Used by target generation. */
export function keyframesForFindings(
  session: LoupeSession,
  batch: Opportunity[],
  maxCount = 3,
): string[] {
  if (batch.length === 0) return [];
  const priorityTs = batch.map(f => {
    const noteTs = typeof f.narrationNote === 'number' ? session.notes[f.narrationNote]?.timestamp : undefined;
    return noteTs ?? f.timestamp;
  }).filter((ts): ts is number => typeof ts === 'number');
  return selectKeyframes(session, priorityTs, maxCount);
}
