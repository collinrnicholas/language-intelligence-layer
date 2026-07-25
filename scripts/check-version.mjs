// ─── Persado Demo — version gate ─────────────────────────────────
//
//   node scripts/check-version.mjs [--staged]
//
// Shipped code must never change without a version bump. Three redesigns and a
// bug fix went out on 0.5.0 because bumping was a thing to remember rather than a
// thing that was checked; this makes it the latter.
//
// --staged  compare the staged tree against HEAD (used by the pre-commit hook)
// default   compare the working tree against HEAD

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'extension/manifest.json';
const CHANGELOG = 'CHANGELOG.md';
// Directories whose contents are shipped to users. Changes here require a bump;
// docs/ and scripts/ do not.
const SHIPPED = /^(extension|gateway)\//;

const staged = process.argv.includes('--staged');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const semver = (v) => v.split('.').map(Number);
const gt = (a, b) => {
  const [A, B] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) { if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) > (B[i] || 0); }
  return false;
};

const changed = git('diff', '--name-only', ...(staged ? ['--cached'] : []), 'HEAD')
  .split('\n').map(s => s.trim()).filter(Boolean);

const shipped = changed.filter(f => SHIPPED.test(f));
if (!shipped.length) {
  console.log('version gate: no shipped code changed — no bump required');
  process.exit(0);
}

const now = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8')).version;
let head;
try { head = JSON.parse(git('show', `HEAD:${MANIFEST}`)).version; }
catch { console.log('version gate: no manifest at HEAD — skipping'); process.exit(0); }

const problems = [];
if (!gt(now, head)) {
  problems.push(
    `extension/manifest.json is still ${now} but shipped code changed:\n` +
    shipped.map(f => `      ${f}`).join('\n') +
    `\n\n    Bump it:  npm run bump         (patch → ${semver(head)[0]}.${semver(head)[1]}.${semver(head)[2] + 1})` +
    `\n              npm run bump:minor   (feature → ${semver(head)[0]}.${semver(head)[1] + 1}.0)`
  );
}

let changelog = '';
try { changelog = readFileSync(join(ROOT, CHANGELOG), 'utf8'); } catch {
  problems.push(`${CHANGELOG} is missing`);
}
if (changelog && !new RegExp(`^##\\s*\\[?${now.replace(/\./g, '\\.')}\\]?`, 'm').test(changelog)) {
  problems.push(`${CHANGELOG} has no "## ${now}" section — describe what shipped in this version`);
}

if (problems.length) {
  console.error('version gate FAILED\n');
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}
console.log(`version gate: ${head} → ${now}, documented in ${CHANGELOG}`);
