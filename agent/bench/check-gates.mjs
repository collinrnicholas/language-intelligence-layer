#!/usr/bin/env node
// Hard-gate checker for a generated build-prompt.md. Judges whether Claude Code
// would likely implement the RIGHT UI — not whether the prose sounds nicer.
//
// Usage: node bench/check-gates.mjs <path-to-build-prompt.md>
// Exit 0 if all gates pass, 1 otherwise. Prints a per-gate PASS/FAIL table.
//
// The gates are the ones the user set for the NNA session. They are heuristic —
// a FAIL is a strong signal to read the section; a PASS means the deterministic
// markers are present. Model-family benchmarking should diff these across configs.

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('usage: check-gates.mjs <build-prompt.md>'); process.exit(2); }
const md = readFileSync(path, 'utf-8');

const buildSection = slice(md, /^## BUILD/m, /^## Also Detected|^## Definition of Done/m);
const synthSection = slice(md, /UX\/Product Synthesis/m, /^## BUILD/m);

const gates = [
  gate('Complete quotes (no mid-sentence fragments)', () => {
    const quotes = [...buildSection.matchAll(/^> [“"](.+?)[”"]/gm)].map(m => m[1].trim());
    if (quotes.length === 0) return fail('no reviewer quotes found in BUILD');
    // A fragment starts lowercase or with a bare conjunction, or ends without
    // terminal punctuation. (A capitalized "The …" sentence is NOT a fragment.)
    const frag = quotes.find(q => /^[a-z]/.test(q) || /^(and|but|so)\b/i.test(q) || !/[.?!]["”']?$/.test(q));
    return frag ? fail(`fragment-looking quote: "${frag.slice(0, 60)}…"`) : pass(`${quotes.length} complete quote(s)`);
  }),

  gate('Correct BUILD findings (hide-plans present, no bogus "Accessibility gaps")', () => {
    const hasHide = /hide|hidden|toggle|collaps/i.test(buildSection) && /plan/i.test(buildSection);
    const bogus = /###\s+B\d+\..*Accessibility gaps/i.test(buildSection);
    if (!hasHide) return fail('no hide-plans primary in BUILD');
    if (bogus) return fail('bogus "Accessibility gaps" BUILD finding present');
    return pass('hide-plans present; no mis-titled a11y finding');
  }),

  gate('No blind CSS prescriptions for layout findings', () => {
    // A raw CSS rule for a layout/visibility problem is the regression we banned.
    const cssRule = buildSection.match(/#[\w-]+\s*\{[^}]*(overflow|width|flex|grid|position)[^}]*\}/i);
    return cssRule ? fail(`prescriptive CSS in BUILD: ${cssRule[0].slice(0, 60)}…`)
                   : pass('no prescriptive width/overflow/flex CSS in BUILD');
  }),

  gate('Documents prioritized over plans', () => {
    const prioritized = /prioriti|front and center|primary (output|workspace|focus)|documents? .*(over|before|above) .*plan/i.test(md);
    return prioritized ? pass('document-priority language present')
                       : fail('no "documents prioritized over plans" framing');
  }),

  gate('Synthesis aligns with BUILD (no scroll-only fix contradicting synthesis)', () => {
    if (!synthSection) return fail('no UX/Product Synthesis section');
    const synthWantsHierarchy = /hierarch|prioriti|primary|front and center/i.test(synthSection);
    const buildAddsScroll = /overflow-x:\s*auto|horizontal scroll(?!ing)/i.test(buildSection)
      && !/without horizontal scrolling|last[- ]resort|fallback/i.test(buildSection);
    if (!synthWantsHierarchy) return fail('synthesis does not state the hierarchy/priority problem');
    if (buildAddsScroll) return fail('BUILD adds horizontal scroll while synthesis wants hierarchy fix');
    return pass('synthesis and BUILD both target hierarchy, not scrolling');
  }),

  gate('Directly usable by Claude Code (sections + locating guidance)', () => {
    const need = ['## Goal & Context', '## How to Work', '## BUILD', '## Definition of Done'];
    const missing = need.filter(h => !new RegExp(h.replace(/[/]/g, '\\$&'), 'm').test(md));
    const locating = /Search the codebase|locate the .*component|rendered.*selectors/i.test(md);
    if (missing.length) return fail(`missing sections: ${missing.join(', ')}`);
    if (!locating) return fail('no code-locating guidance');
    return pass('all sections present + code-locating guidance');
  }),

  gate('Explore-first / sequencing present (architecture-aware)', () => {
    const explore = /propose 2.?3 ranked|before writing code|explore|investigate|verify whether/i.test(buildSection);
    return explore ? pass('explore-first / verify-first framing present')
                   : fail('no explore-first or conditional sequencing in BUILD');
  }),
];

let allPass = true;
console.log(`\nHard-gate report — ${path}\n${'='.repeat(60)}`);
for (const g of gates) {
  const r = g.run();
  if (!r.ok) allPass = false;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${g.name}\n      ${r.msg}`);
}
console.log('='.repeat(60));
console.log(allPass ? 'ALL GATES PASS ✅' : 'SOME GATES FAILED ❌');
process.exit(allPass ? 0 : 1);

function gate(name, run) { return { name, run }; }
function pass(msg) { return { ok: true, msg }; }
function fail(msg) { return { ok: false, msg }; }
function slice(s, start, end) {
  const a = s.search(start); if (a < 0) return '';
  const rest = s.slice(a); const b = rest.slice(1).search(end);
  return b < 0 ? rest : rest.slice(0, b + 1);
}
