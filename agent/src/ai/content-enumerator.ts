// Content-pattern enumeration for a session.
//
// One vision call that reads the full visible list off the screenshot — not the
// click log, which only captures rows the user touched — then identifies near-
// duplicate groups, repeated labels, latent groupings, and missing differentiators.
// The raw output feeds directly into the target generator as context for Content-
// category findings so those findings produce Fable-style explore-first briefs
// instead of single-prescription targets.

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { LoupeSession } from '../cli.js';
import { callLLM } from '../llm/index.js';

type ClickEvent = Extract<LoupeSession['events'][number], { type: 'click' }>;

// sips embeds a creation timestamp in its PNG output, so re-encoding the same
// JPEG produces different bytes every run — which changed the image hash in the
// LLM cache key and made the enumeration call (and every downstream prompt that
// embeds its output) miss the cache on every run. Persisting the conversion by
// input hash makes the forwarded PNG byte-stable AND skips the re-encode.
const PNG_CACHE_DIR = join(homedir(), '.loupe', 'cache', 'png');

/**
 * Re-encode a JPEG dataUrl to lossless PNG so the vision model can read small
 * text (filenames, row labels) without JPEG compression softening the strokes.
 * Uses macOS `sips`; on other platforms, falls back to the original dataUrl.
 * The conversion is cached by input hash so repeat runs forward identical bytes.
 */
function toPNGDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/(jpeg|png);base64,(.+)$/);
  if (!match) return dataUrl;
  if (match[1] === 'png') return dataUrl; // already lossless

  const inputHash = createHash('sha256').update(dataUrl).digest('hex');
  const cachePath = join(PNG_CACHE_DIR, `${inputHash}.png`);
  try {
    if (existsSync(cachePath)) {
      return `data:image/png;base64,${readFileSync(cachePath).toString('base64')}`;
    }
  } catch { /* fall through to conversion */ }

  const inPath = join(tmpdir(), `loupe-enum-${inputHash.slice(0, 12)}.jpg`);
  const outPath = join(tmpdir(), `loupe-enum-${inputHash.slice(0, 12)}.png`);
  try {
    writeFileSync(inPath, Buffer.from(match[2], 'base64'));
    const r = spawnSync('sips', ['-s', 'format', 'png', inPath, '--out', outPath], {
      timeout: 8000,
      encoding: 'buffer',
    });
    if (r.status === 0) {
      const png = readFileSync(outPath);
      try {
        mkdirSync(PNG_CACHE_DIR, { recursive: true });
        writeFileSync(cachePath, png);
      } catch { /* cache is best-effort */ }
      return `data:image/png;base64,${png.toString('base64')}`;
    }
  } catch {
    // sips unavailable (non-macOS) or failed — fall back to original
  } finally {
    try { unlinkSync(inPath); } catch { /* ignore */ }
    try { unlinkSync(outPath); } catch { /* ignore */ }
  }
  return dataUrl;
}

/**
 * Select the screenshot most relevant to content-list narration.
 * Anchors on the earliest narration note about hierarchy/naming/navigation.
 */
function selectContentScreenshot(session: LoupeSession): string | null {
  if (session.screenshots.length === 0) return null;

  const contentNoteTs = session.notes
    .filter(n => n.type === 'transcript' &&
      /hierarchy|flat|difficult|can.t tell|see what|organize|navigate|distinguish|each.*plan|what.*plan/i.test(n.text))
    .map(n => n.timestamp);

  // Add 1s to the anchor so we land on the first screenshot AFTER page load,
  // not the frame captured mid-navigation just before content appeared.
  const anchorTs = contentNoteTs.length > 0
    ? contentNoteTs[0] + 1000
    : session.screenshots[Math.floor(session.screenshots.length * 0.4)]?.timestamp ?? 0;

  return session.screenshots.reduce((best, s) =>
    Math.abs(s.timestamp - anchorTs) < Math.abs(best.timestamp - anchorTs) ? s : best,
    session.screenshots[0]
  ).dataUrl;
}

/**
 * Run the content-enumeration call and return the raw model text.
 * Returns null on failure — callers fall back to the finding description alone.
 */
export async function enumerateContentPatterns(session: LoupeSession): Promise<string | null> {
  const rawDataUrl = selectContentScreenshot(session);
  if (!rawDataUrl) return null;

  // Re-encode to PNG so JPEG compression artifacts don't soften filename text.
  // The stored screenshot stays compressed; only this forwarded copy is lossless.
  const screenshotDataUrl = toPNGDataUrl(rawDataUrl);

  const clickLog = session.events
    .filter((e): e is ClickEvent => e.type === 'click')
    .map(e => `[${(e.timestamp / 1000).toFixed(1)}s] "${(e.textContent ?? '').slice(0, 120).trim()}"  →  ${e.selector}`)
    .join('\n') || '(none)';

  const transcript = session.notes
    .filter(n => n.type === 'transcript')
    .map(n => `[${(n.timestamp / 1000).toFixed(0)}s] ${n.text}`)
    .join('\n') || '(none)';

  const prompt = [
    // ── PRIMARY SOURCE ────────────────────────────────────────────────────────
    // The screenshot is the ground truth for what is visible. The click log is',
    // supplementary — it only captures rows the user touched, not all rows shown.',
    // Read the image first and answer from what you see.',
    'You are auditing the content of a UI screenshot for a design review.',
    'The attached screenshot shows the COMPLETE visible state of the interface.',
    '',
    'STEP 1 — READ THE SCREENSHOT FIRST.',
    'Before reading anything else: look at the screenshot and enumerate every row,',
    'filename, label, and subtitle you can see. Read ALL visible rows — do not stop',
    'at the ones the user interacted with. The screenshot is the primary source.',
    '',
    'STEP 2 — Use the click log ONLY as a supplement.',
    'The click log below tells you which items the user interacted with, but it is a',
    'PARTIAL FLOOR — it captures only 4–5 of the rows the user touched, not all 9+',
    'rows visible in the screenshot. Do not derive the full item list from the click',
    'log. Derive it from the screenshot.',
    '',
    'REVIEWER NARRATION (what the user said aloud):',
    transcript,
    '',
    'CLICK LOG (partial — interacted rows only, NOT the full visible list):',
    clickLog,
    '',
    // ── QUESTIONS ─────────────────────────────────────────────────────────────
    'Answer each question using the screenshot as the primary source:',
    '',
    '1. COMPLETE ITEM LIST: Read every filename, row title, or item visible in the',
    '   screenshot. List ALL of them — including rows the user did not click.',
    '   Quote the exact text you read off the image.',
    '',
    '2. REPEATED LABELS: Which subtitle, type label, or metadata string appears',
    '   identically on multiple rows? Quote the exact string and state how many rows',
    '   show it.',
    '',
    '3. NEAR-DUPLICATE FILENAMES: Which filenames share a prefix or naming pattern',
    '   that makes them hard to distinguish at a glance? Find ALL groups — do not',
    '   stop after the first.',
    '   For each group: name the shared pattern and list every member.',
    '',
    '4. LATENT GROUPINGS: What grouping dimensions are latent in the filenames?',
    '   (e.g. revision status — prelim/final/#N; drawing type — A-series/T-series;',
    '   date; category). Name the specific naming convention you can infer.',
    '',
    '5. MISSING DIFFERENTIATORS: What information is absent that would let a user',
    '   tell items apart? (upload date, file size, page count, revision tag, thumbnail)',
    '',
    '6. NOISE: Is any displayed metadata identical on every row and therefore noise?',
    '   Quote the exact string.',
    '',
    'Be specific. Quote exact strings from the screenshot. Do not generalize or invent.',
  ].join('\n');

  try {
    return await callLLM('explain', prompt, {
      images: [screenshotDataUrl],
      maxTokens: 1500,
      stage: 'content-enumeration',
      promptVersion: 'content-enumeration-v1',
    });
  } catch {
    return null;
  }
}
