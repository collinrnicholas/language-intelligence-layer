import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LoupeSession } from '../cli.js';
import { parseSessionInput } from '../schema.js';

const LOUPE_HOME = join(homedir(), '.loupe');

export async function processSession(filePath: string, projectName?: string) {
  console.log(`Processing: ${filePath}`);

  // Read the file
  const raw = readFileSync(filePath, 'utf-8');
  let data: unknown;

  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error('Invalid JSON in session file');
    return;
  }

  // Normalize: file might be { session: {...} } or just the session object
  let parsedSession = parseSessionInput(data);
  if (!parsedSession.ok || !parsedSession.value) {
    console.error('Invalid session file:');
    for (const err of parsedSession.errors) console.error(`  - ${err}`);
    process.exitCode = 1;
    return;
  }
  let session: LoupeSession = parsedSession.value;

  console.log(`  Project:  ${session.project}`);
  console.log(`  Flow:     ${session.flow}`);
  console.log(`  Duration: ${(new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 1000}s`);
  console.log(`  Events:   ${session.events.length}`);
  console.log(`  URLs:     ${session.urlTimeline.length}`);
  console.log(`  Notes:    ${session.notes.length}`);

  // Copy to loupe home
  const project = projectName || session.project;
  const safeProject = project.replace(/[^a-zA-Z0-9_-]/g, '_');
  const destDir = join(LOUPE_HOME, 'projects', safeProject, 'sessions');
  mkdirSync(destDir, { recursive: true });

  const ts = Date.now();
  const destFile = join(destDir, `session-${ts}.json`);
  writeFileSync(destFile, JSON.stringify({ session }, null, 2));

  console.log(`  Saved:    ${destFile}`);
  console.log('✓ Process complete');
}
