import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const LOUPE_HOME = join(homedir(), '.loupe');

export async function initProject(name: string) {
  const projectDir = join(LOUPE_HOME, 'projects', name);
  const sessionsDir = join(projectDir, 'sessions');
  const reportsDir = join(projectDir, 'reports');
  const configDir = join(projectDir, 'config');

  if (existsSync(projectDir)) {
    console.log(`Project "${name}" already exists at ${projectDir}`);
    return;
  }

  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  // Copy default design system if it exists
  const defaultDs = join(LOUPE_HOME, 'config', 'design-system.json');
  if (existsSync(defaultDs)) {
    writeFileSync(join(configDir, 'design-system.json'), readFileSync(defaultDs));
    console.log('  Design system: default copied to project config');
  }

  writeFileSync(join(projectDir, 'project.json'), JSON.stringify({
    name,
    created: new Date().toISOString(),
    sessions: [],
    reports: [],
  }, null, 2));

  console.log(`✓ Project "${name}" created at ${projectDir}`);
}
