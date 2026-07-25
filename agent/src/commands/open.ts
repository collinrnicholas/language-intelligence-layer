import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const LOUPE_HOME = join(homedir(), '.loupe');

export async function openReport(ref: string) {
  // If it's a .loupe or .json file, use its project context
  if (ref.endsWith('.loupe') || ref.endsWith('.spotter') || ref.endsWith('.json')) {
    const fullPath = resolve(ref);
    if (!existsSync(fullPath)) {
      console.error(`File not found: ${fullPath}`);
      return;
    }
    // Open the HTML report next to it
    const reportPath = fullPath.replace(/\.(loupe|spotter|json)$/, '.html');
    if (existsSync(reportPath)) {
      await openBrowser(reportPath);
      return;
    }
    console.log(`No report found at ${reportPath}. Run \`loupe analyze\` first.`);
    return;
  }

  // Otherwise treat as project name — find latest report
  const reportsDir = join(LOUPE_HOME, 'projects', ref, 'reports');
  if (!existsSync(reportsDir)) {
    console.error(`No reports found for project "${ref}"`);
    return;
  }

  const { readdir } = await import('node:fs/promises');
  const files = await readdir(reportsDir);
  const htmlFiles = files.filter(f => f.endsWith('.html')).sort().reverse();

  if (htmlFiles.length === 0) {
    console.error(`No HTML reports for project "${ref}"`);
    return;
  }

  const latest = join(reportsDir, htmlFiles[0]);
  await openBrowser(latest);
}

async function openBrowser(path: string) {
  const { execFileSync } = await import('node:child_process');
  const url = `file://${path}`;
  console.log(`Opening: ${url}`);

  const platform = process.platform;
  if (platform === 'darwin') {
    execFileSync('open', [url]);
  } else if (platform === 'win32') {
    execFileSync('cmd', ['/c', 'start', '', url]);
  } else {
    execFileSync('xdg-open', [url]);
  }
}
