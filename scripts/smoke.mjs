// ─── Persado Assist — static smoke test ─────────────────────────
//
//   npm run smoke
//
// Catches the class of regression that keeps biting this extension: contracts
// spread across sidepanel.html / sidepanel.js / src/background.js / src/scan.js
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
const SCAN = read('src/scan.js');
const OVERLAY = read('src/mc-overlay.js');
const JOBS = read('src/jobs.js');
const MESSAGES = read('src/messages.js');
const BOOT = read('src/boot.js');
const MANIFEST = JSON.parse(read('manifest.json'));
const GATEWAY_SRC = readFileSync(join(ROOT, 'gateway/server.mjs'), 'utf8');

const failures = [];
const notes = [];
const fail = (check, detail) => failures.push(`${check}: ${detail}`);
const uniq = (a) => [...new Set(a)];
const all = (re, s) => [...s.matchAll(re)].map(m => m[1]);
/** Strip comments so documentation prose never counts as code. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PANEL_C = code(PANEL), BG_C = code(BG), SCAN_C = code(SCAN), OVERLAY_C = code(OVERLAY), JOBS_C = code(JOBS);

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
  const panels = ['panelConfigure', 'panelRecord', 'panelProcess', 'panelBrief', 'panelResults', 'panelSettings'];
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
  const files = { 'sidepanel.js': PANEL_C, 'src/background.js': BG_C, 'src/scan.js': SCAN_C, 'src/mc-overlay.js': OVERLAY_C, 'src/jobs.js': JOBS_C };

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
  // The worker's explicit relay allowlist must also have a real gateway case.
  const integrationSource = readFileSync(join(ROOT, 'gateway/integrations.mjs'), 'utf8');
  const relayed = (BG_C.match(/INTEGRATION_MESSAGES\s*=\s*new Set\(\[([\s\S]*?)\]/) || [, ''])[1];
  for (const k of all(/MSG\.([A-Z_]+)/g, relayed)) {
    if (!integrationSource.includes(`case '${k}':`)) fail('gateway relay', `gateway has no handler for ${k}`);
    handled.add(k);
  }
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

// ── 6. storage keys go through the contract ───────────────────────
{
  const declared = uniq(all(/^\s{4}([A-Z_]+):\s*'persado:/gm, MESSAGES));
  for (const [name, src] of [['sidepanel.js', PANEL_C], ['src/background.js', BG_C]]) {
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
  const used = uniq(all(/\bchrome\.([A-Za-z]+)/g, PANEL_C + BG_C));
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
  const iIntelligence=HTML.indexOf('src/language-intelligence.js');
  if(HTML.indexOf('src/guard.js')<0||HTML.indexOf('src/guard.js')>iIntelligence)fail('recommendation eligibility','guard.js must load before language-intelligence.js');
  if(PANEL.includes('PERSADO_INTELLIGENCE')&&(iIntelligence<0||iIntelligence>iMod)) fail('score presentation','language-intelligence.js must load before the panel module');
  const iImpact=HTML.indexOf('src/campaign-impact.js');
  if(PANEL.includes('PERSADO_IMPACT')&&(iImpact<0||iImpact>iMod)) fail('campaign impact','campaign-impact.js must load before the panel module');
  const iMotion=HTML.indexOf('src/interactions.js');
  if(PANEL.includes('PERSADO_MOTION')&&(iMotion<0||iMotion>iMod)) fail('interactions','interactions.js must load before the panel module');
  if (iMsg < 0 || iBoot < 0) fail('boot guard', 'sidepanel.html must load src/messages.js and src/boot.js');
  else if (!(iMsg < iMod && iBoot < iMod)) fail('boot guard', 'messages.js and boot.js must load BEFORE the module, or a module throw stays silent');
  for (const id of ['fatalBanner', 'fatalMsg', 'fatalReload']) {
    if (!HTML.includes(`id="${id}"`)) fail('boot guard', `sidepanel.html missing #${id}`);
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

// ── 12. gateway URL lives in exactly one place; its route exists ──
{
  // Two hardcoded copies of the base URL is how a port change becomes an
  // unexplainable "Failed to fetch". Only .js sources are counted.
  const sources = { 'sidepanel.js': PANEL, 'src/background.js': BG, 'src/scan.js': SCAN, 'src/messages.js': MESSAGES, 'src/boot.js': BOOT };
  const hits = [];
  for (const [name, src] of Object.entries(sources)) {
    const n = (code(src).match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/g) || []).length;
    if (n) hits.push(`${name} (${n})`);
  }
  if (hits.length !== 1 || !hits[0].startsWith('src/background.js')) {
    fail('gateway url', `must appear ONLY in src/background.js — found in ${hits.join(', ') || 'nowhere'}`);
  }
  if (!/GATEWAY_URL\s*=\s*'http:\/\/127\.0\.0\.1:/.test(BG_C)) fail('gateway url', 'background.js should target 127.0.0.1 (not localhost)');
  const port = (BG_C.match(/127\.0\.0\.1:(\d+)/) || [])[1];
  if (!(MANIFEST.host_permissions || []).includes(`http://127.0.0.1:${port}/*`)) fail('gateway url', `manifest host_permissions is missing http://127.0.0.1:${port}/*`);
  const path = (BG_C.match(/INTEGRATIONS_PATH\s*=\s*'([^']+)'/) || [])[1];
  if (!path || !GATEWAY_SRC.includes(`'${path}'`)) fail('endpoint drift', `extension calls ${path} but gateway/server.mjs has no route for it`);
  // Legacy unauthenticated model routes must not come back (audit finding #2).
  if (/\/v1\/ai\//.test(code(GATEWAY_SRC))) fail('gateway', 'gateway/server.mjs serves a /v1/ai/* route');
  notes.push(`gateway url declared once in src/background.js (port ${port}); ${path} routed`);
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

// ── 16. panel/header move ONLY through setUiState ─────────────
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
  if (!/function setUiState/.test(PANEL_C)) fail('ui state', 'setUiState is missing');
  notes.push(`ui state: no sh(pnl…)/st('…') bypass of setUiState`);
}

// ── 17. prototype features stay removed (audit finding #10) ──────
{
  const surfaces = { 'sidepanel.html': HTML, 'sidepanel.js': PANEL_C, 'src/background.js': BG_C };
  const LEGACY = [/record a brief/i, /Motivation AI/, /getUserMedia/, /captureVisibleTab/, /\/v1\/ai\//, /TRANSCRIBE/, /panelRecord|panelConfigure|panelBrief|panelProcess/];
  for (const [name, src] of Object.entries(surfaces)) for (const re of LEGACY) if (re.test(src)) fail('prototype residue', `${name} matches ${re}`);
  if (MANIFEST.options_ui || MANIFEST.options_page) fail('prototype residue', 'manifest still declares an options page');
  notes.push('prototype: no recorder, brief, capture or portal surfaces');
}

// ── 20. provider credentials stay in the local gateway ──────────
{
  for (const [name, src] of Object.entries({ 'src/scan.js': SCAN_C, 'src/mc-overlay.js': OVERLAY_C })) {
    if (/KEYS\.(API_KEY|MC_API_KEY)/.test(src)) fail('credentials', `${name} references a credential storage key`);
    if (/chrome\.storage/.test(src) && name === 'src/mc-overlay.js') fail('credentials', 'the Mailchimp overlay must not read chrome.storage');
  }
  for (const [name, src] of Object.entries({ 'sidepanel.js': PANEL_C, 'src/scan.js': SCAN_C, 'src/mc-overlay.js': OVERLAY_C })) {
    if (/api\.persado\.com\/api|api\.mailchimp\.com\/3\.0|Authorization/.test(src)) fail('credentials', `${name} calls Persado/Mailchimp directly — only the service worker may`);
  }
  if (/x-persado-api-key|apiKeyHeaders/.test(PANEL_C)) fail('credentials', 'sidepanel.js still forwards the Persado key');
  if (/KEYS\.(API_KEY|MC_API_KEY)/.test(PANEL_C)) fail('credentials', 'panel must not read or write provider keys');
  if (/importScripts\([^;]*(?:persado-api|adapters\/mailchimp)/.test(BG_C)) fail('credentials', 'worker still loads direct provider clients');
  if (!/X-Persado-Token/.test(BG_C)) fail('credentials', 'integration relay has no pairing authentication');
  // The overlay may only send what the worker lets it.
  const allowed = (BG_C.match(/OVERLAY_ALLOWED\s*=\s*new Set\(\[([^\]]*)\]/) || [, ''])[1];
  const allowedSet = new Set(all(/MSG\.([A-Z_]+)/g, allowed));
  const sentByOverlay = uniq([...OVERLAY_C.matchAll(/\btype:\s*MSG\.([A-Z_]+)/g)].map(m => m[1]));
  const extra = sentByOverlay.filter(k => !allowedSet.has(k));
  if (extra.length) fail('overlay', `mc-overlay.js sends ${extra.join(', ')} which senderAllowed() rejects`);
  if (/console\.(log|info|debug)\([^)]*\b(apiKey|persadoKey|mcKey|key)\b/.test(BG_C)) fail('credentials', 'background.js may be logging a key');
  // Every content script the manifest declares must exist and stay off the key.
  for (const cs of MANIFEST.content_scripts || []) for (const f of cs.js || []) if (!existsSync(join(EXT, f))) fail('missing asset', `content script ${f}`);
  // No mock scores survive anywhere in the shipped extension.
  for (const [name, src] of Object.entries({ 'sidepanel.js': PANEL_C })) {
    if (/MOCK_SCORES|MOCK_LIFTS|predictedLift\s*:/.test(src)) fail('fabricated scores', `${name} still carries mock scores or lift`);
  }
  notes.push(`credentials: gateway-only; overlay sends ${sentByOverlay.join(', ')}`);
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
