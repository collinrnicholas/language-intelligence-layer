import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LoupeSession } from '../cli.js';
import { expectedDurationMs, maxSessionTimestamp, parseSessionInput } from '../schema.js';

interface CheckResult {
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail?: string;
  penalty: number;
}

export async function validateSession(filePath: string) {
  const fullPath = resolve(filePath);
  if (!existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    process.exit(1);
  }

  const raw = readFileSync(fullPath, 'utf-8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error('✗ Invalid JSON — cannot parse session file');
    process.exit(1);
  }

  const parsedSession = parseSessionInput(data);
  const session = parsedSession.value as LoupeSession | undefined;
  const checks: CheckResult[] = [];

  // ─── Schema ──────────────────────────────────────────────────

  if (!parsedSession.ok || !session) {
    checks.push({
      label: 'Schema valid',
      status: 'fail',
      detail: parsedSession.errors.slice(0, 5).join('; '),
      penalty: 50,
    });
  } else {
    checks.push({ label: 'Schema valid', status: 'pass', penalty: 0 });
  }

  if (!session) return printResults(fullPath, checks);

  // ─── URL Timeline ────────────────────────────────────────────

  if (!session.urlTimeline || session.urlTimeline.length === 0) {
    checks.push({ label: 'URL timeline valid', status: 'warn', detail: 'No URL entries recorded', penalty: 5 });
  } else {
    const outOfOrder = session.urlTimeline.some(
      (u, i) => i > 0 && u.timestamp < session.urlTimeline[i - 1].timestamp
    );
    if (outOfOrder) {
      checks.push({ label: 'URL timeline valid', status: 'warn', detail: 'Entries are not in chronological order', penalty: 3 });
    } else {
      checks.push({ label: 'URL timeline valid', status: 'pass', detail: `${session.urlTimeline.length} entries`, penalty: 0 });
    }
  }

  // ─── Screenshots ─────────────────────────────────────────────

  if (!session.screenshots || session.screenshots.length === 0) {
    checks.push({ label: 'Screenshots present', status: 'warn', detail: 'No screenshots captured — enable screenshot interval in extension', penalty: 5 });
  } else {
    checks.push({ label: 'Screenshots present', status: 'pass', detail: `${session.screenshots.length} captured`, penalty: 0 });
  }

  // ─── Audio ───────────────────────────────────────────────────

  if (!session.audioData) {
    checks.push({ label: 'Audio present', status: 'warn', detail: 'No audio data — grant mic permission and re-record', penalty: 0 });
  } else {
    const sizeKb = Math.round(session.audioData.length * 0.75 / 1024);
    checks.push({ label: 'Audio present', status: 'pass', detail: `~${sizeKb}KB embedded`, penalty: 0 });
  }

  // ─── Timestamp Consistency ───────────────────────────────────
  // Timestamps should be ms-from-session-start (small). Absolute
  // performance.now() values from page load will be >> 1 hour in ms.

  const durationMs = expectedDurationMs(session);
  const maxTimestamp = maxSessionTimestamp(session);
  const graceMs = 5000;
  const timestampLimit = durationMs + graceMs;
  const suspiciousEvents = (session.events || []).filter(e => e.timestamp > timestampLimit);
  const suspiciousScreenshots = (session.screenshots || []).filter(s => s.timestamp > timestampLimit);
  const suspiciousUrls = (session.urlTimeline || []).filter(u => u.timestamp > timestampLimit);
  const suspiciousNotes = (session.notes || []).filter(n => n.timestamp > timestampLimit || (n.endTimestamp ?? n.timestamp) > timestampLimit);
  const suspiciousCount = suspiciousEvents.length + suspiciousScreenshots.length + suspiciousUrls.length + suspiciousNotes.length;
  if (suspiciousCount > 0) {
    const types = [...new Set(suspiciousEvents.map(e => e.type))].join(', ') || 'screenshots/urlTimeline/notes';
    checks.push({
      label: 'Timestamp consistency',
      status: 'fail',
      detail: `${suspiciousCount} timestamps exceed session duration (${durationMs}ms + ${graceMs}ms); max=${maxTimestamp}ms; affected=${types}`,
      penalty: 50,
    });
  } else {
    checks.push({ label: 'Timestamp consistency', status: 'pass', detail: `max=${maxTimestamp}ms, duration=${durationMs}ms`, penalty: 0 });
  }

  // ─── Transcript ──────────────────────────────────────────────

  const transcriptNotes = (session.notes || []).filter(n => n.type === 'transcript');
  if (transcriptNotes.length === 0) {
    checks.push({
      label: 'Transcript found',
      status: 'warn',
      detail: 'No transcript — run `loupe transcribe <file>` to add narration',
      penalty: 0,
    });
  } else {
    checks.push({ label: 'Transcript found', status: 'pass', detail: `${transcriptNotes.length} segments`, penalty: 0 });
  }

  // ─── Design System (computed styles captured) ────────────────

  const hasComputedStyles = (session.events || []).some(
    e => e.type === 'dom_snapshot' && e.computedStyles && Object.keys(e.computedStyles).length > 0
  );
  if (!hasComputedStyles) {
    checks.push({
      label: 'Design system attached',
      status: 'warn',
      detail: 'No computed style data captured — design drift checks will be limited',
      penalty: 0,
    });
  } else {
    checks.push({ label: 'Design system attached', status: 'pass', penalty: 0 });
  }

  printResults(fullPath, checks);
}

function printResults(fullPath: string, checks: CheckResult[]): void {
  const totalPenalty = checks.reduce((sum, c) => sum + c.penalty, 0);
  const health = Math.max(0, 100 - totalPenalty);

  console.log(`\nValidating: ${fullPath}\n`);
  for (const check of checks) {
    const icon = check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
    const detail = check.detail ? `  — ${check.detail}` : '';
    console.log(`${icon} ${check.label}${detail}`);
  }

  console.log(`\nOverall Health\n${health}/100\n`);

  const hasFailure = checks.some(c => c.status === 'fail');
  if (hasFailure || health < 50) {
    console.log('Session has critical issues. Fix failures before analyzing.');
    process.exit(1);
  } else if (health < 80) {
    console.log('Session has warnings. Analysis may be incomplete.');
  } else {
    console.log('Session looks good.');
  }
}
