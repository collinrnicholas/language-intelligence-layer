// ─── Screenshot Extraction ───────────────────────────────────────
//
// Screenshots are captured as base64 data URLs inside the .loupe session. They
// are extracted to real image files exactly once per run, then referenced by
// relative path from both the report and the implementation package — so the
// large binary payload is never duplicated inside opportunities.json or inlined
// into the HTML report.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoupeSession } from './cli.js';

const DATA_URL = /^data:image\/(jpeg|png);base64,(.+)$/;

/**
 * Extract every screenshot in the session to `<screenshotsDir>/NNN.{jpg,png}`.
 *
 * Returns an array whose index matches `session.screenshots` (and therefore any
 * `screenshotIndex` on an opportunity): each entry is the path relative to the
 * parent of `screenshotsDir` (e.g. "screenshots/000.jpg"), or `null` if that
 * screenshot was missing/corrupt and could not be written.
 */
export function extractScreenshots(
  session: LoupeSession,
  screenshotsDir: string,
  relPrefix = 'screenshots'
): (string | null)[] {
  mkdirSync(screenshotsDir, { recursive: true });
  const rels: (string | null)[] = [];

  for (let i = 0; i < session.screenshots.length; i++) {
    const match = session.screenshots[i].dataUrl.match(DATA_URL);
    if (!match) {
      rels[i] = null;
      continue;
    }
    const ext = match[1] === 'png' ? 'png' : 'jpg';
    const name = `${String(i).padStart(3, '0')}.${ext}`;
    try {
      writeFileSync(join(screenshotsDir, name), Buffer.from(match[2], 'base64'));
      rels[i] = `${relPrefix}/${name}`;
    } catch {
      rels[i] = null; // skip corrupt screenshot, keep index alignment
    }
  }

  return rels;
}

/** Count of successfully extracted (non-null) screenshots. */
export function extractedCount(rels: (string | null)[]): number {
  return rels.filter(Boolean).length;
}
