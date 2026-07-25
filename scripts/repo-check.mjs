#!/usr/bin/env node
// ─── repo:check — fail when generated artifacts land in the repo ─
//
// Generated Loupe output belongs in ~/.loupe, never in the repo
// (docs/REPO_HYGIENE.md). This walks the tree (git ls-files when available,
// filesystem otherwise), flags artifact files/dirs outside the approved
// fixture locations, and exits 1 when anything is found.
//
// Usage: npm run repo:check

import { readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// Approved locations for committed fixtures / expected outputs.
const ALLOWED_PREFIXES = [
  'benchmarks/',
  'evals/fixtures/',
  'agent/test/',
];

// Source trees where artifact-ish NAMES are legitimate code (e.g. the
// target-design module) — never flagged.
const SOURCE_PREFIXES = [
  'agent/src/',
  'extension/src/',
  'extension/offscreen/',
  'analyzer/',
  'app/',
  'gateway/',
  'scripts/',
  'prompts/',
  'docs/',
  'specs/',
  'research/',
  'changelog/',
  '.github/',
];

// Never walked at all.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

// Artifact FILE names / extensions that indicate generated output.
const ARTIFACT_FILES = [
  /^report\.html$/,
  /^opportunities\.json$/,
  /\.loupe$/,
  /\.pre-transcribe\.loupe$/,
  /^memory-digest\.md$/,
  /^sessions\.jsonl$/,
  /^opportunities\.jsonl$/,
];

// Artifact DIRECTORY names that indicate generated output.
const ARTIFACT_DIRS = [
  /^runs$/,
  /^implementation-packages$/,
  /^implementation-\d+$/,
  /^screenshots$/,
  /^debug$/,
  /^traces$/,
  /^target-design-artifacts$/,
  /^sessions$/,          // repo-root session dumps (extension/CLI output)
  /^memory$/,            // project memory belongs under ~/.loupe
];

const norm = (p) => p.split(sep).join('/');
const isAllowed = (rel) => ALLOWED_PREFIXES.some(p => rel.startsWith(p));
const isSource = (rel) => SOURCE_PREFIXES.some(p => rel.startsWith(p) || p.startsWith(rel + '/'));

const findings = [];

function flag(rel, why) {
  findings.push({ rel, why });
}

function checkPath(rel, isDir) {
  if (!rel || isAllowed(rel)) return;
  const base = rel.split('/').pop();
  if (isDir) {
    if (isSource(rel)) return;
    if (ARTIFACT_DIRS.some(re => re.test(base))) flag(rel + '/', 'generated artifact directory');
    // dist/ at any level should never be tracked (git mode only reaches here
    // if it IS tracked; fs mode skips dist entirely).
    if (base === 'dist') flag(rel + '/', 'build output directory');
  } else {
    if (isSource(rel) && !/\.loupe$/.test(base)) return; // sources can't be artifact files, except stray captures
    if (ARTIFACT_FILES.some(re => re.test(base))) flag(rel, 'generated artifact file');
  }
}

function gitTrackedFiles() {
  try {
    const out = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean);
  } catch {
    return null; // not a git repo — fall back to a filesystem walk
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name === '.DS_Store') continue;
    const full = join(dir, name);
    const rel = norm(relative(ROOT, full));
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      checkPath(rel, true);
      walk(full);
    } else {
      checkPath(rel, false);
    }
  }
}

const tracked = gitTrackedFiles();
if (tracked) {
  // Git mode: check tracked files + every tracked directory segment.
  const dirs = new Set();
  for (const f of tracked) {
    checkPath(norm(f), false);
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of dirs) checkPath(norm(d), true);
} else {
  console.log('repo:check — no git repo detected; scanning the filesystem instead.');
  walk(ROOT);
}

if (findings.length === 0) {
  console.log('✓ repo:check passed — no generated artifacts in repo paths.');
  process.exit(0);
}

console.error(`✗ repo:check failed — ${findings.length} artifact path(s) found in the repo:\n`);
for (const f of findings.sort((a, b) => a.rel.localeCompare(b.rel))) {
  console.error(`  ${f.rel}  (${f.why})`);
}
console.error('\nGenerated output belongs in ~/.loupe (see docs/REPO_HYGIENE.md).');
console.error('Fixtures are only approved under: ' + ALLOWED_PREFIXES.join(', '));
// Root-level artifact directories can be moved out automatically.
const MIGRATABLE = new Set(['sessions', 'runs', 'reports', 'implementation-packages', 'target-design', 'screenshots', 'debug', 'traces']);
if (findings.some(f => MIGRATABLE.has(f.rel.split('/')[0]))) {
  console.error('Migrate repo-root artifact dirs into the runtime with: loupe runtime migrate --apply');
}
console.error('Clean local artifacts with: loupe clean');
process.exit(1);
