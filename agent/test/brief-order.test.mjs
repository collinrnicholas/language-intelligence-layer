// The build-prompt template is a CONSTANT: every session, every site emits the
// same sections in the same order. Only the content of each section varies. This
// test locks that invariant — generate briefs from two structurally different
// sessions and assert the section headers appear in the identical canonical order.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'loupe-order-'));
process.env.HOME = home;

const { generateImplementationBrief, BRIEF_SECTION_ORDER } = await import('../dist/ai/implementation-brief.js');

// Hardcoded INDEPENDENT oracle — deliberately NOT derived from the code, so that
// reordering the template without updating this literal fails the test.
const EXPECTED_ORDER = [
  'Goal & Context',
  'Constraints',
  'How to Work This Brief',
  'Design System',
  'UX/Product Synthesis',
  'BUILD',
  'Also Detected',
  'Definition of Done',
];

// BUILD / Also Detected headings carry a dynamic "(N)" suffix — reduce to the
// stable canonical id.
function canonicalId(heading) {
  if (heading.startsWith('BUILD')) return 'BUILD';
  if (heading.startsWith('Also Detected')) return 'Also Detected';
  return heading;
}

function sessionWith(project, flow) {
  return {
    project,
    flow,
    startedAt: '2026-06-27T12:00:00.000Z',
    endedAt: '2026-06-27T12:00:45.000Z',
    urlTimeline: [{ url: `https://${project}.test/`, timestamp: 0, navigationType: 'initial' }],
    events: [{
      type: 'dom_snapshot',
      timestamp: 2000,
      url: `https://${project}.test/`,
      html: '<button>Go</button>',
      computedStyles: { 'button.go': { height: '30px', color: 'rgb(1, 2, 3)' } },
    }],
    screenshots: [{ timestamp: 1500, dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' }],
    viewport: { width: 1280, height: 720 },
    browser: { userAgent: 'node-test' },
    notes: [{ type: 'transcript', timestamp: 1200, text: 'the go button feels cramped', source: 'audio' }],
  };
}

function finding(id, over) {
  return {
    id,
    category: 'UX',
    severity: 'High',
    title: `Finding ${id}`,
    description: 'desc',
    whyItMatters: 'matters',
    confidence: 0.9,
    ...over,
  };
}

function orderedIds(brief) {
  return brief.sections.map(s => canonicalId(s.heading));
}

// Every emitted section must be a known section, and they must appear in strictly
// increasing canonical position (i.e. a subsequence of EXPECTED_ORDER).
function assertCanonicalOrder(brief, label) {
  const ids = orderedIds(brief);
  let last = -1;
  for (const id of ids) {
    const idx = EXPECTED_ORDER.indexOf(id);
    assert.notEqual(idx, -1, `${label}: unknown section "${id}"`);
    assert.ok(idx > last, `${label}: section "${id}" is out of order — got [${ids.join(' → ')}]`);
    last = idx;
  }
  return ids;
}

test('brief section order is a constant template across different sessions', () => {
  // Session A: one narrated + one detected finding, NO design tokens.
  //   → Also Detected present, Design System ABSENT.
  const findingsA = [
    finding('a1', { narrated: true, title: 'Go button too small', selector: 'button.go' }),
    finding('a2', { narrated: false, category: 'Accessibility', title: 'Low contrast text', selector: 'p.muted' }),
  ];
  const briefA = generateImplementationBrief(findingsA, sessionWith('AlphaApp', 'Checkout'), 'Minimal changes', 'Claude Code', 'Context A');

  // Session B: all narrated (no detected), WITH design tokens.
  //   → Design System present, Also Detected ABSENT.
  const dsDir = join(home, '.loupe', 'projects', 'BetaApp', 'config');
  mkdirSync(dsDir, { recursive: true });
  writeFileSync(join(dsDir, 'design-system.json'), JSON.stringify({ color: { green: '#12C97E', border: '#ECEEF1' } }));
  const findingsB = [
    finding('b1', { narrated: true, title: 'Cramped spacing', selector: 'div.card' }),
    finding('b2', { narrated: true, category: 'Visual Design', title: 'Weak hierarchy', selector: 'section.hero' }),
  ];
  const briefB = generateImplementationBrief(findingsB, sessionWith('BetaApp', 'Onboarding'), 'Modernize UI', 'Cursor', 'Context B');

  const idsA = assertCanonicalOrder(briefA, 'A');
  const idsB = assertCanonicalOrder(briefB, 'B');

  // The two briefs must have DIFFERENT section sets — otherwise identical order is
  // a lucky artifact of identical inputs rather than a guaranteed template.
  assert.ok(idsA.includes('Also Detected') && !idsA.includes('Design System'),
    `A: expected Also Detected and no Design System — got [${idsA.join(', ')}]`);
  assert.ok(idsB.includes('Design System') && !idsB.includes('Also Detected'),
    `B: expected Design System and no Also Detected — got [${idsB.join(', ')}]`);

  // Yet the sections they SHARE must appear in the identical relative order.
  const shared = EXPECTED_ORDER.filter(id => idsA.includes(id) && idsB.includes(id));
  assert.deepEqual(idsA.filter(id => shared.includes(id)), shared, 'A: shared sections out of canonical order');
  assert.deepEqual(idsB.filter(id => shared.includes(id)), shared, 'B: shared sections out of canonical order');

  // The exported template constant documents the same order.
  assert.deepEqual([...BRIEF_SECTION_ORDER], EXPECTED_ORDER);
});

test('two different sessions with the same section set produce IDENTICAL header order', () => {
  function fullBrief(project, flow, findings, goal, target) {
    const dsDir = join(home, '.loupe', 'projects', project, 'config');
    mkdirSync(dsDir, { recursive: true });
    writeFileSync(join(dsDir, 'design-system.json'), JSON.stringify({ color: { green: '#12C97E' } }));
    // Pass a non-null synthesis string so the optional UX/Product Synthesis section appears
    // and the full 8-section set is emitted.
    const synthesis = `**Product purpose:** Test product for ${project}.\n**User's goal:** Test.`;
    return generateImplementationBrief(findings, sessionWith(project, flow), goal, target, `Context ${project}`, synthesis);
  }

  // Two different sites, different findings — but each has a narrated finding, a
  // detected finding, design tokens, and synthesis, so both yield the full 8-section set.
  const briefX = fullBrief('DeltaApp', 'Search', [
    finding('x1', { narrated: true, title: 'Cramped results', selector: 'ul.results' }),
    finding('x2', { narrated: false, category: 'Accessibility', title: 'Low contrast labels', selector: 'span.lbl' }),
  ], 'Minimal changes', 'Claude Code');
  const briefY = fullBrief('EpsilonApp', 'Profile', [
    finding('y1', { narrated: true, title: 'Misaligned avatar', selector: 'img.avatar' }),
    finding('y2', { narrated: false, category: 'Performance', title: 'Sluggish avatar image', selector: 'img.avatar' }),
  ], 'Best-in-class UX', 'Cursor');

  const idsX = orderedIds(briefX);
  const idsY = orderedIds(briefY);
  assert.deepEqual(idsX, idsY, `header order differs between sessions: X=[${idsX}] Y=[${idsY}]`);
  assert.deepEqual(idsX, EXPECTED_ORDER, 'a full brief must emit the complete canonical order');
});

test('mandatory sections are always present, first, and last — even with an empty BUILD', () => {
  // All findings detected (none narrated) → empty BUILD, Also Detected present.
  const findings = [finding('g1', { narrated: false, category: 'Accessibility', title: 'Missing ARIA labels', selector: 'button.x' })];
  const brief = generateImplementationBrief(findings, sessionWith('GammaApp', 'Settings'), 'Minimal changes', 'Codex', 'Context G');
  const ids = assertCanonicalOrder(brief, 'G');

  for (const must of ['Goal & Context', 'Constraints', 'How to Work This Brief', 'BUILD', 'Definition of Done']) {
    assert.ok(ids.includes(must), `missing mandatory section "${must}" — got [${ids.join(', ')}]`);
  }
  assert.equal(ids[0], 'Goal & Context', 'brief must open with Goal & Context');
  assert.equal(ids[ids.length - 1], 'Definition of Done', 'brief must end with Definition of Done');
});
