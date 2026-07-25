import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LoupeSession } from '../cli.js';

const LOUPE_HOME = join(homedir(), '.loupe');

export async function listSessions() {
  const projectsDir = join(LOUPE_HOME, 'projects');

  if (!existsSync(projectsDir)) {
    console.log('No sessions yet. Run `loupe init <project>` first.');
    return;
  }

  const projects = await readdirSafe(projectsDir);
  if (projects.length === 0) {
    console.log('No projects found. Run `loupe init <project>` first.');
    return;
  }

  let totalSessions = 0;

  for (const project of projects) {
    const sessionsDir = join(projectsDir, project, 'sessions');
    const sessions = await readdirSafe(sessionsDir);
    const reportsDir = join(projectsDir, project, 'reports');
    const reports = await readdirSafe(reportsDir);

    console.log(`\n\x1b[1m${project}\x1b[0m`);
    console.log(`  Sessions: ${sessions.length}`);
    console.log(`  Reports:  ${reports.length}`);

    // Show last few sessions with metadata
    const sessionFiles = sessions.filter(s => s.endsWith('.json'));
    for (const sf of sessionFiles.slice(-3)) {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, sf), 'utf-8'));
        const s: LoupeSession = data.session || data;
        const events = s.events?.length || 0;
        const noteCount = s.notes?.length || 0;
        console.log(`  📄 ${sf.replace('.json', '')} — ${events} events, ${noteCount} notes`);
      } catch {
        console.log(`  📄 ${sf}`);
      }
    }

    totalSessions += sessions.length;
  }

  console.log(`\nTotal: ${projects.length} projects, ${totalSessions} sessions`);
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises');
    return await readdir(dir);
  } catch {
    return [];
  }
}
