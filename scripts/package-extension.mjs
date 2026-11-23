// ─── Persado Autopilot — extension build ─────────────────────────
//
//   npm run build   (root)  →  agent build, then this
//
// The extension has no compile step: Chrome loads extension/ unpacked, exactly
// as it is in the repo. "Building" therefore means: verify it, then copy the
// files Chrome needs (no tests, no package.json) to extension/dist/unpacked and,
// when the `zip` tool exists, write extension/dist/persado-autopilot-<v>.zip for
// sideloading or the Chrome Web Store. dist/ is gitignored.

import { rmSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const DIST = join(EXT, 'dist');
const OUT = join(DIST, 'unpacked');
const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

run('node', ['scripts/smoke.mjs']);
const version = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8')).version;

rmSync(DIST, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// Plain file-by-file copy: fs.cpSync tries to preserve directory modes, which
// fails on some mounted/synced folders.
function copy(from, to) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const n of readdirSync(from)) copy(join(from, n), join(to, n));
  } else copyFileSync(from, to);
}
for (const p of ['manifest.json', 'sidepanel.html', 'sidepanel.js', 'options.html', 'options.js', 'public', 'src']) {
  copy(join(EXT, p), join(OUT, p));
}
let zipped = '';
try {
  execFileSync('zip', ['-v'], { stdio: 'ignore' });
  const zip = join(DIST, `persado-autopilot-${version}.zip`);
  execFileSync('zip', ['-qr', zip, '.'], { cwd: OUT });
  zipped = zip;
} catch { /* zip not installed: the unpacked folder is the build */ }
console.log(`\nextension ${version} built → ${OUT}${zipped ? `\n                      zip → ${zipped}` : ''}`);
if (!existsSync(join(OUT, 'src', 'background.js'))) process.exit(1);
