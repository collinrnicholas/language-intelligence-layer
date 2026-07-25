// ─── Persado Capture — static smoke test ─────────────────────────
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
import { parse } from 'node-html-parser';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const read = (p) => readFileSync(join(EXT, p), 'utf8');

const HTML = read('sidepanel.html');
const PANEL = read('sidepanel.js');
const BG = read('src/background.js');
const CONTENT = read('src/content.js');
const MESSAGES = read('src/messages.js');
const BOOT = read('src/boot.js');
const CONFIG = read('src/config.js');
const MANIFEST = JSON.parse(read('manifest.json'));
const GATEWAY_SRC = readFileSync(join(ROOT, 'gateway/server.mjs'), 'utf8');

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

// ── 3. primary panels are top-level siblings ───────────────────────
{
  const root = parse(HTML);
  const body = root.querySelector('body');
  const panels = ['panelConfigure', 'panelRecord', 'panelProcess', 'panelBrief', 'panelResults'];
  for (const id of panels) {
    const el = root.querySelector(`#${id}`);
    if (!el) continue;
    if (el.parentNode !== body) {
      fail('panel nesting', `#${id} must be a direct child of <body>, otherwise an inactive parent panel can hide it`);
    }
  }
  notes.push(`${panels.length} primary panels checked as body-level siblings`);
}

// ── 4. message contract: declared / sent / handled ────────────────
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

// ── 5. page-context field contract (the ctx.frames regression) ────
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

// ── 6. storage keys go through the contract ───────────────────────
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

// ── 7. chrome.* namespaces are covered by manifest permissions ────
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

// ── 8. manifest asset paths exist, and scripts the HTML loads exist ──
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

// ── 9. boot guard is loaded before the module ─────────────────────
{
  const iBoot = HTML.indexOf('src/boot.js'), iMsg = HTML.indexOf('src/messages.js'), iMod = HTML.indexOf('sidepanel.js" type="module"');
  if (iMsg < 0 || iBoot < 0) fail('boot guard', 'sidepanel.html must load src/messages.js and src/boot.js');
  else if (!(iMsg < iMod && iBoot < iMod)) fail('boot guard', 'messages.js and boot.js must load BEFORE the module, or a module throw stays silent');
  for (const id of ['fatalBanner', 'fatalMsg', 'fatalReload']) {
    if (!HTML.includes(`id="${id}"`)) fail('boot guard', `sidepanel.html missing #${id}`);
  }
}

// ── 10. content script is idempotent and version-stamped ─────────
{
  if (/^(let|var)\s/m.test(CONTENT_C)) {
    fail('content script', 'has top-level let/var — re-injection will throw "already been declared"');
  }
  if (!/self\.__persadoContent/.test(CONTENT_C)) fail('content script', 'missing the __persadoContent re-injection guard');
  if (!/MSG\.PING/.test(CONTENT_C)) fail('content script', 'does not answer PING — the panel cannot verify its version');
  if (/catch\s*\(\s*e\s*=>\s*\{\s*report\(e\);\s*sendResponse/.test(CONTENT_C)) {
    fail('content script', 'command failures must return to the retry UI, not emit CONTENT_ERROR/fatal');
  }

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

// ── 11. no deprecated purple survives on rebuilt surfaces ─────────
{
  // Every screen is now rebuilt on the token system — the whole file is covered,
  // no results exemption. Re-introducing any of these anywhere fails the build.
  const banned = ['#5C2D91', '#E8388C', '--prp', '--mag', '--grad'];
  const lineAt = (i) => HTML.slice(HTML.lastIndexOf('\n', i) + 1, HTML.indexOf('\n', i));
  for (const tok of banned) {
    for (const m of HTML.matchAll(new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))) {
      const line = lineAt(m.index);
      fail('deprecated palette', `${tok} on a rebuilt surface → ${line.trim().slice(0, 70)}`);
    }
  }
  if (HTML.indexOf('</style>') < 0) fail('sidepanel.html', 'no </style> found');
}

// ── 12. gateway URL lives in exactly one place ────────────────────
{
  // Two hardcoded copies of the base URL is how a port change becomes an
  // unexplainable "Failed to fetch". manifest host_permissions are allowed to
  // name it (they must), so only .js sources are counted.
  const sources = { 'src/config.js': CONFIG, 'sidepanel.js': PANEL, 'src/background.js': BG,
                    'src/content.js': CONTENT, 'src/messages.js': MESSAGES, 'src/boot.js': BOOT };
  const hits = [];
  for (const [name, src] of Object.entries(sources)) {
    const n = (src.match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/g) || []).length;
    if (n) hits.push(`${name} (${n})`);
  }
  if (hits.length !== 1 || !hits[0].startsWith('src/config.js')) {
    fail('gateway url', `must appear ONLY in src/config.js — found in ${hits.join(', ') || 'nowhere'}`);
  }
  if (!/GATEWAY_URL\s*=\s*'http:\/\/127\.0\.0\.1:/.test(CONFIG)) {
    fail('gateway url', 'config.js should target 127.0.0.1 (not localhost) to avoid IPv6/IPv4 drift');
  }
  // ...and the manifest must actually permit it.
  const port = (CONFIG.match(/127\.0\.0\.1:(\d+)/) || [])[1];
  const host = MANIFEST.host_permissions || [];
  for (const h of [`http://127.0.0.1:${port}/*`, `http://localhost:${port}/*`]) {
    if (!host.includes(h)) fail('gateway url', `manifest host_permissions is missing ${h}`);
  }
  notes.push(`gateway url declared once in src/config.js (port ${port})`);
}

// ── 13. every endpoint the extension calls has a gateway route ────
{
  const declared = [...CONFIG.matchAll(/^\s{4}[A-Z_]+:\s*'(\/[^']+)'/gm)].map(m => m[1]);
  if (!declared.length) fail('endpoints', 'no ENDPOINTS found in src/config.js');
  for (const ep of declared) {
    // Routes look like: req.url === '/health'  /  req.url === '/v1/ai/recommend'
    if (!new RegExp(`['"\`]${ep.replace(/\//g, '\\/')}['"\`]`).test(GATEWAY_SRC)) {
      fail('endpoint drift', `extension calls ${ep} but gateway/server.mjs has no route for it`);
    }
  }
  // And every ENDPOINTS entry should actually be used by the extension.
  const used = uniq(all(/ENDPOINTS\.([A-Z_]+)/g, PANEL_C + BG_C));
  const names = [...CONFIG.matchAll(/^\s{4}([A-Z_]+):\s*'\//gm)].map(m => m[1]);
  const unused = names.filter(n => !used.includes(n));
  if (unused.length) notes.push(`endpoints declared but unused: ${unused.join(', ')}`);
  notes.push(`${declared.length} endpoints checked against gateway routes`);
}

// ── 14. manifest version is documented in the changelog ───────────
{
  const version = MANIFEST.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail('version', `manifest version "${version}" is not x.y.z`);
  let log = '';
  try { log = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'); } catch { fail('version', 'CHANGELOG.md is missing'); }
  if (log && !new RegExp(`^##\\s*\\[?${version.replace(/\./g, '\\.')}\\]?`, 'm').test(log)) {
    fail('version', `CHANGELOG.md has no "## ${version}" section`);
  }
  notes.push(`manifest version ${version}`);
}

// ── 15. no emoji in the panel UI ──────────────────────────────────
{
  const start = HTML.indexOf('id="panelResults"');
  const rebuilt = HTML.slice(0, start < 0 ? HTML.length : start);
  // Typographic + box-drawing characters used in copy and comment rules are not emoji.
  const ALLOWED = new Set([...'↑—…·’“”─═│┌┐└┘'])
  const bad = uniq([...rebuilt].filter(c => c.codePointAt(0) > 0x2100 && !ALLOWED.has(c)));
  if (bad.length) fail('emoji', `found ${bad.map(c => JSON.stringify(c)).join(', ')} on a rebuilt surface`);
}

// ── 16. panel/header/.on move ONLY through setUiState ─────────────
{
  // The recording screen went blank because the active panel (sh), the header
  // (st), and the .rec-live.on toggle were set by separate call sites that could
  // disagree. setUiState is the single source of truth; nothing may bypass it.
  // setUiState itself uses sh(s.panel)/st(s.header) — variables, not literals — so
  // a literal sh(pnl…) or st('…') call anywhere is a bypass.
  const shCalls = (PANEL_C.match(/\bsh\(pnl[A-Za-z]+\)/g) || []);
  if (shCalls.length) fail('ui state', `direct panel switch bypasses setUiState: ${uniq(shCalls).join(', ')}`);
  const stCalls = (PANEL_C.match(/\bst\('[^']*'\)/g) || []);
  if (stCalls.length) fail('ui state', `direct header set bypasses setUiState: ${uniq(stCalls).join(', ')}`);
  // The .on toggle may appear only inside the setUiState/assert/heal region.
  const region = PANEL_C.slice(PANEL_C.indexOf('function setUiState'), PANEL_C.indexOf('// ─── Objective chips'));
  const onAll = (PANEL_C.match(/recLive\.classList\.(add|remove|toggle)\([^)]*\)/g) || []);
  const onRegion = (region.match(/recLive\.classList\.(add|remove|toggle)\([^)]*\)/g) || []);
  if (onAll.length !== onRegion.length) fail('ui state', `.rec-live.on toggled outside setUiState (${onAll.length - onRegion.length} site(s))`);
  if (!/function setUiState/.test(PANEL_C)) fail('ui state', 'setUiState is missing');
  notes.push(`ui state: ${onRegion.length} .on toggle(s), all inside setUiState; no sh(pnl…)/st('…') bypass`);
}

// ── 17. content-script version handshake forces re-injection ──────
{
  // The blank/ghost failure traces to a stale content script surviving an
  // extension reload. ensureContentScript must PING, compare CONTENT_VERSION, and
  // re-inject on absence OR mismatch — never drive an unverified script.
  const fn = PANEL_C.slice(PANEL_C.indexOf('async function ensureContentScript'), PANEL_C.indexOf('async function ensureContentScript') + 700);
  if (!fn) fail('handshake', 'ensureContentScript missing');
  else {
    if (!/MSG\.PING/.test(fn)) fail('handshake', 'ensureContentScript does not PING');
    if (!/version\s*===?\s*CONTENT_VERSION/.test(fn)) fail('handshake', 'ensureContentScript does not compare CONTENT_VERSION');
    if (!/executeScript/.test(fn)) fail('handshake', 'ensureContentScript never re-injects');
    // The early-return must be gated on BOTH ok and a version match.
    if (!/if\(r\?\.ok&&r\.version===CONTENT_VERSION\)return/.test(fn.replace(/\s+/g, ''))) {
      fail('handshake', 'ensureContentScript returns without confirming version match');
    }
  }
  notes.push('handshake: ensureContentScript PINGs + version-gates + re-injects');
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
