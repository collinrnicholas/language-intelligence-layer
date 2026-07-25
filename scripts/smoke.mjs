// ─── Persado Demo — static smoke test ────────────────────────────
//
//   npm run smoke
//
// Catches the class of regression that keeps biting this extension: contracts
// spread across sidepanel.html / sidepanel.js / src/background.js / src/content.js
// with nothing checking that both ends still agree. No browser required.
//
// Exits non-zero on any failure so it can gate a commit.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const read = (p) => readFileSync(join(EXT, p), 'utf8');

const HTML = read('sidepanel.html');
const PANEL = read('sidepanel.js');
const BG = read('src/background.js');
const CONTENT = read('src/content.js');
const MESSAGES = read('src/messages.js');
const BOOT = read('src/boot.js');
const MANIFEST = JSON.parse(read('manifest.json'));

const failures = [];
const notes = [];
const fail = (check, detail) => failures.push(`${check}: ${detail}`);
const uniq = (a) => [...new Set(a)];
const all = (re, s) => [...s.matchAll(re)].map(m => m[1]);
/** Strip comments so documentation prose never counts as code. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PANEL_C = code(PANEL), BG_C = code(BG), CONTENT_C = code(CONTENT);

// ── 1. every $('id') in the panel exists in the HTML ──────────────
{
  const ids = uniq(all(/\bid="([^"]+)"/g, HTML));
  const looked = uniq(all(/\$\('([^']+)'\)/g, PANEL_C));
  const missing = looked.filter(id => !ids.includes(id));
  if (missing.length) fail('panel id lookups', `not in sidepanel.html: ${missing.join(', ')}`);
  // getElementById used directly (bypasses the $ guard) counts too
  const direct = uniq(all(/getElementById\('([^']+)'\)/g, PANEL_C + BOOT));
  const missingDirect = direct.filter(id => !ids.includes(id));
  if (missingDirect.length) fail('getElementById', `not in sidepanel.html: ${missingDirect.join(', ')}`);
  notes.push(`${looked.length} panel id lookups checked against ${ids.length} ids`);
}

// ── 2. no duplicate ids in the HTML ───────────────────────────────
{
  const ids = all(/\bid="([^"]+)"/g, HTML);
  const dupes = uniq(ids.filter((id, i) => ids.indexOf(id) !== i));
  if (dupes.length) fail('duplicate ids', dupes.join(', '));
}

// ── 3. message contract: declared / sent / handled ────────────────
{
  const declared = uniq(all(/^\s{4}([A-Z_]+):\s*'/gm, MESSAGES));
  const files = { 'sidepanel.js': PANEL_C, 'src/background.js': BG_C, 'src/content.js': CONTENT_C };

  // Any MSG.X referenced anywhere must exist in messages.js.
  for (const [name, src] of Object.entries(files)) {
    const used = uniq(all(/\bMSG\.([A-Za-z_]+)/g, src));
    const unknown = used.filter(k => !declared.includes(k));
    if (unknown.length) fail('unknown message type', `${name} references MSG.${unknown.join(', MSG.')}`);
  }

  // Raw string literals for known types mean someone bypassed the contract.
  for (const [name, src] of Object.entries(files)) {
    const raw = declared.filter(k => new RegExp(`['"\`]${k}['"\`]`).test(src));
    if (raw.length) fail('raw message literal', `${name} hardcodes ${raw.join(', ')} — use MSG.*`);
  }

  const sent = new Set(), handled = new Set();
  for (const src of Object.values(files)) {
    // { type: MSG.X   /  { type: cond ? MSG.A : MSG.B
    for (const m of src.matchAll(/\btype:\s*([^,}\n]+)/g)) {
      for (const k of all(/MSG\.([A-Za-z_]+)/g, m[1])) sent.add(k);
    }
    // msg.type === MSG.X   and computed dispatch  [MSG.X]: fn
    for (const k of all(/msg\.type\s*===?\s*MSG\.([A-Za-z_]+)/g, src)) handled.add(k);
    for (const k of all(/\[MSG\.([A-Za-z_]+)\]\s*:/g, src)) handled.add(k);
  }
  const unhandled = [...sent].filter(k => !handled.has(k));
  const unsent = [...handled].filter(k => !sent.has(k));
  if (unhandled.length) fail('message sent but never handled', unhandled.join(', '));
  if (unsent.length) fail('message handled but never sent', unsent.join(', '));
  const unusedDecl = declared.filter(k => !sent.has(k) && !handled.has(k));
  if (unusedDecl.length) notes.push(`declared but unused: ${unusedDecl.join(', ')}`);
  notes.push(`${declared.length} message types declared, ${sent.size} sent, ${handled.size} handled`);
}

// ── 4. page-context field contract (the ctx.frames regression) ────
{
  const declared = uniq(all(/^\s{4}([A-Z_]+):\s*'/gm, MESSAGES.slice(MESSAGES.indexOf('const CTX'))));
  const written = uniq(all(/\[CTX\.([A-Z_]+)\]\s*:/g, BG_C));
  const readBg = uniq(all(/ctx\[CTX\.([A-Z_]+)\]/g, BG_C));
  const readPanel = uniq(all(/(?:ctx|c)\??\.?\[CTX\.([A-Z_]+)\]/g, PANEL_C));

  const unknown = [...written, ...readBg, ...readPanel].filter(k => !declared.includes(k));
  if (unknown.length) fail('unknown context field', `CTX.${uniq(unknown).join(', CTX.')} not declared`);

  const orphanReads = readPanel.filter(k => !written.includes(k));
  if (orphanReads.length) {
    fail('context field read but never written',
      `panel reads CTX.${orphanReads.join(', CTX.')} but background never writes it — this is the ctx.startShot/ctx.frames bug`);
  }
  // A bare literal read of the stored context object bypasses the contract.
  const bare = uniq(all(/\bctx\.([a-z][A-Za-z]*)/g, PANEL_C).concat(all(/\bctx\.([a-z][A-Za-z]*)/g, BG_C)));
  if (bare.length) fail('bare context field access', `use ctx[CTX.*] instead of ctx.${bare.join(', ctx.')}`);

  // EVERY key written into the stored object must go through CTX, or a partial
  // rename at one of several writeCtx call sites slips through the set comparison
  // above (the other sites keep the old name "written", masking the break).
  for (const m of BG_C.matchAll(/writeCtx\(\{([^}]*)\}\)/g)) {
    const body = m[1];
    for (const part of body.split(',')) {
      const key = part.trim();
      if (!key || key.startsWith('...')) continue;
      if (!/^\[CTX\.[A-Z_]+\]\s*:/.test(key)) {
        fail('unkeyed context write', `writeCtx({ ${key.slice(0, 40)} }) must use [CTX.*] as its key`);
      }
    }
  }
  notes.push(`context fields written=${written.join(',')} readByPanel=${readPanel.join(',')}`);
}

// ── 5. storage keys go through the contract ───────────────────────
{
  const declared = uniq(all(/^\s{4}([A-Z_]+):\s*'persado:/gm, MESSAGES));
  for (const [name, src] of [['sidepanel.js', PANEL_C], ['src/background.js', BG_C], ['src/content.js', CONTENT_C]]) {
    const raw = uniq(all(/'(persado:[A-Za-z]+)'/g, src));
    if (raw.length) fail('raw storage key', `${name} hardcodes ${raw.join(', ')} — use KEYS.*`);
    const used = uniq(all(/\bKEYS\.([A-Z_]+)/g, src));
    const unknown = used.filter(k => !declared.includes(k));
    if (unknown.length) fail('unknown storage key', `${name} references KEYS.${unknown.join(', KEYS.')}`);
  }
  notes.push(`${declared.length} storage keys declared`);
}

// ── 6. chrome.* namespaces are covered by manifest permissions ────
{
  const perms = new Set([...(MANIFEST.permissions || [])]);
  const hostPerms = MANIFEST.host_permissions || [];
  const NEEDS = { storage: 'storage', scripting: 'scripting', sidePanel: 'sidePanel', tabs: 'tabs',
                  alarms: 'alarms', offscreen: 'offscreen', notifications: 'notifications',
                  webNavigation: 'webNavigation', cookies: 'cookies', downloads: 'downloads' };
  const used = uniq(all(/\bchrome\.([A-Za-z]+)/g, PANEL_C + BG_C + CONTENT_C));
  for (const ns of used) {
    const need = NEEDS[ns];
    if (need && !perms.has(need)) fail('missing permission', `chrome.${ns} used but "${need}" not in manifest.permissions`);
  }
  if (/captureVisibleTab/.test(BG_C) && !hostPerms.length && !perms.has('activeTab')) {
    fail('missing permission', 'captureVisibleTab needs host_permissions or activeTab');
  }
  const declaredUnused = [...perms].filter(p => !used.includes(p) && p !== 'activeTab');
  if (declaredUnused.length) notes.push(`permissions declared but no chrome.<ns> use: ${declaredUnused.join(', ')}`);
  notes.push(`chrome namespaces used: ${used.join(', ')}`);
}

// ── 7. manifest asset paths exist, and scripts the HTML loads exist ──
{
  const paths = [];
  const walk = (v) => {
    if (typeof v === 'string') { if (/\.(png|js|html|svg|css|json)$/.test(v)) paths.push(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(MANIFEST);
  for (const p of uniq(paths)) if (!existsSync(join(EXT, p))) fail('missing asset', `manifest references ${p}`);

  for (const src of uniq(all(/<script src="([^"]+)"/g, HTML))) {
    if (!existsSync(join(EXT, src))) fail('missing script', `sidepanel.html loads ${src}`);
  }
  // Files injected programmatically must exist too.
  for (const m of PANEL_C.matchAll(/files:\s*\[([^\]]+)\]/g)) {
    for (const f of all(/'([^']+)'/g, m[1])) {
      if (!existsSync(join(EXT, f))) fail('missing injected file', `executeScript injects ${f}`);
    }
  }
  notes.push(`${uniq(paths).length} manifest assets checked`);
}

// ── 8. boot guard is loaded before the module ─────────────────────
{
  const iBoot = HTML.indexOf('src/boot.js'), iMsg = HTML.indexOf('src/messages.js'), iMod = HTML.indexOf('sidepanel.js" type="module"');
  if (iMsg < 0 || iBoot < 0) fail('boot guard', 'sidepanel.html must load src/messages.js and src/boot.js');
  else if (!(iMsg < iMod && iBoot < iMod)) fail('boot guard', 'messages.js and boot.js must load BEFORE the module, or a module throw stays silent');
  for (const id of ['fatalBanner', 'fatalMsg', 'fatalReload']) {
    if (!HTML.includes(`id="${id}"`)) fail('boot guard', `sidepanel.html missing #${id}`);
  }
}

// ── 9. content script is idempotent and version-stamped ──────────
{
  if (/^(let|var)\s/m.test(CONTENT_C)) {
    fail('content script', 'has top-level let/var — re-injection will throw "already been declared"');
  }
  if (!/self\.__persadoContent/.test(CONTENT_C)) fail('content script', 'missing the __persadoContent re-injection guard');
  if (!/MSG\.PING/.test(CONTENT_C)) fail('content script', 'does not answer PING — the panel cannot verify its version');

  // Changing content.js without bumping CONTENT_VERSION leaves stale copies live.
  const hash = createHash('sha256').update(CONTENT).digest('hex').slice(0, 12);
  const version = (MESSAGES.match(/CONTENT_VERSION\s*=\s*(\d+)/) || [])[1];
  const recorded = (MESSAGES.match(/CONTENT_HASH\s*=\s*'([a-f0-9]+)'/) || [])[1];
  if (!version) fail('content version', 'CONTENT_VERSION not found in src/messages.js');
  else if (!recorded) fail('content version', `CONTENT_HASH missing in src/messages.js — add: const CONTENT_HASH = '${hash}';`);
  else if (recorded !== hash) {
    fail('content version', `src/content.js changed (hash ${hash}, recorded ${recorded}). Bump CONTENT_VERSION (now ${version}) and set CONTENT_HASH = '${hash}'.`);
  }
}

// ── 10. no deprecated purple survives on rebuilt surfaces ─────────
{
  const banned = ['#5C2D91', '#E8388C', '--prp', '--grad'];
  // The results screen (1d) is NOT rebuilt yet, so its rules and markup may still
  // reference the deprecated palette. Every such survivor must be listed here, so
  // the list itself is the to-do — anything unlisted fails.
  const NOT_YET_REBUILT = [
    '--prp:', '--mag:', '--grad:',        // the alias declarations themselves
    'DEPRECATED',                          // the comment marking them
    '.rec-card .rh', '.rec-card .rn',      // results variant cards
    '.badge.lift',                         // results lift pill
    'Recommendations',                     // results section heading markup
  ];
  const resultsAt = HTML.indexOf('id="panelResults"');
  const lineAt = (i) => HTML.slice(HTML.lastIndexOf('\n', i) + 1, HTML.indexOf('\n', i));
  for (const tok of banned) {
    for (const m of HTML.matchAll(new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))) {
      if (resultsAt >= 0 && m.index > resultsAt) continue;        // inside results markup
      const line = lineAt(m.index);
      if (NOT_YET_REBUILT.some(a => line.includes(a))) continue;
      fail('deprecated purple', `${tok} on a rebuilt surface → ${line.trim().slice(0, 70)}`);
    }
  }
  if (HTML.indexOf('</style>') < 0) fail('sidepanel.html', 'no </style> found');
}

// ── 11. no emoji in the panel UI ──────────────────────────────────
{
  const start = HTML.indexOf('id="panelResults"');
  const rebuilt = HTML.slice(0, start < 0 ? HTML.length : start);
  // Typographic + box-drawing characters used in copy and comment rules are not emoji.
  const ALLOWED = new Set([...'↑—…·’“”─═│┌┐└┘'])
  const bad = uniq([...rebuilt].filter(c => c.codePointAt(0) > 0x2100 && !ALLOWED.has(c)));
  if (bad.length) fail('emoji', `found ${bad.map(c => JSON.stringify(c)).join(', ')} on a rebuilt surface`);
}

// ── report ───────────────────────────────────────────────────────
console.log('persado smoke\n');
for (const n of notes) console.log(`  · ${n}`);
console.log('');
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`\n${failures.length} smoke failure${failures.length === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log('  ✓ all smoke checks passed');
