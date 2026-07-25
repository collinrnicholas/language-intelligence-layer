import { readFileSync, existsSync } from 'node:fs';
import type { LoupeSession, Opportunity, Evidence } from '../cli.js';
import { projectDesignSystemPath } from '../paths.js';

interface DesignSystem {
  color?: Record<string, string>;
  font?: { ui?: string; mono?: string };
  radius?: Record<string, number>;
  space?: number[];
  shadow?: Record<string, string>;
}

/**
 * Run design drift checks against the project's design-system.json.
 * Compares DOM snapshots against token values and reports violations.
 */
export interface DriftResult {
  findings: Opportunity[];
  /** True when drift was not evaluated because no per-project design system exists. */
  skipped: boolean;
}

export function runDriftChecks(session: LoupeSession): DriftResult {
  const findings: Opportunity[] = [];

  // ─── Load design system ───────────────────────────────────────
  // Drift requires a PER-PROJECT design system. There is intentionally no global
  // fallback: grading an arbitrary project's CSS against Loupe's own brand tokens
  // (the global file that tends to exist) produces wrong-but-confident findings.
  // No project config → skip entirely and say so (here + in the report).
  const ds = loadDesignSystem(session.project);
  if (!ds) {
    console.log(
      `  Drift checks skipped — no design system configured for project '${session.project}'. ` +
      `Run 'loupe design-system init ${session.project}' to enable.`
    );
    return { findings, skipped: true };
  }

  // Collect all color tokens into a flat set of hex values
  const tokenColors = collectTokenColors(ds);
  const tokenRadii = collectTokenRadii(ds);
  const tokenSpacing = new Set(ds.space || [4, 8, 12, 16, 20, 24, 32]);

  // ─── Analyze each DOM snapshot ────────────────────────────────
  const domSnapshots = session.events.filter(e => e.type === 'dom_snapshot');
  if (domSnapshots.length === 0) return { findings, skipped: false };

  // Track unique findings to avoid duplicates
  const seenColors = new Set<string>();
  const seenFonts = new Set<string>();
  const seenRadii = new Set<string>();

  for (let i = 0; i < domSnapshots.length; i++) {
    const snap = domSnapshots[i];
    if (snap.type !== 'dom_snapshot') continue;

    const snapIndex = session.events.indexOf(snap);
    const styles = snap.computedStyles || {};
    const currentUrl = snap.url || '';
    const eventIndex = session.events.indexOf(snap);

    // Find nearest screenshot
    const screenshotIndex = findNearestScreenshot(session.screenshots, snap.timestamp);

    for (const [selector, css] of Object.entries(styles)) {
      // ─── Color drift ──────────────────────────────────────────
      const colorKeys = ['color', 'backgroundColor', 'borderColor', 'outlineColor'];
      for (const key of colorKeys) {
        const val = css[key];
        if (!val || val === 'transparent' || val === 'rgba(0, 0, 0, 0)') continue;
        const hex = normalizeColor(val);
        if (!hex || hex.length < 6) continue;
        if (tokenColors.has(hex)) continue;

        const dedupKey = `${key}:${hex}`;
        if (seenColors.has(dedupKey)) continue;
        seenColors.add(dedupKey);

        // Find closest token color
        const closest = findClosestTokenColor(hex, tokenColors);

        findings.push({
          id: `drift-color-${findings.length}`,
          category: 'Design System',
          severity: 'Medium',
          title: `${formatSelector(selector)} uses non-token color`,
          description: `The ${key} "${hex}" on ${formatSelector(selector)} does not match any design system color token.${closest ? ` Closest token: ${closest}` : ''}`,
          page: currentUrl,
          timestamp: snap.timestamp,
          selector,
          whyItMatters: 'Non-token colors create inconsistent visuals and make dark mode, theming, and global changes impossible.',
          suggestedFix: `Replace "${hex}" with the nearest design system token${closest ? ` (${closest})` : ''} or add this color to the design system.`,
          confidence: 0.85,
          observed: hex,
          expected: closest || 'any design system color token',
          screenshotIndex,
          evidence: {
            screenshotIndex,
            domSnapshotTimestamp: snap.timestamp,
            events: [eventIndex],
            url: currentUrl,
            selector,
          },
        });
      }

      // ─── Font drift ───────────────────────────────────────────
      const fontFamily = css['fontFamily'];
      if (fontFamily && ds.font) {
        const normalizedFont = fontFamily.toLowerCase().replace(/['"]/g, '');
        const uiOk = ds.font.ui && normalizedFont.includes(ds.font.ui.toLowerCase().replace(/['"]/g, ''));
        const monoOk = ds.font.mono && normalizedFont.includes(ds.font.mono.toLowerCase().replace(/['"]/g, ''));

        if (!uiOk && !monoOk) {
          const dedupKey = `font:${fontFamily}`;
          if (seenFonts.has(dedupKey)) continue;
          seenFonts.add(dedupKey);

          const isProbablyMono = /mono|console|courier|typewriter/i.test(fontFamily);
          const expectedFont = isProbablyMono ? (ds.font.mono || 'monospace') : (ds.font.ui || 'system-ui');

          findings.push({
            id: `drift-font-${findings.length}`,
            category: 'Design System',
            severity: 'Medium',
            title: `${formatSelector(selector)} uses non-token font`,
            description: `"${fontFamily}" does not match the design system font.`,
            page: currentUrl,
            timestamp: snap.timestamp,
            selector,
            whyItMatters: 'Font drift degrades typographic consistency and brand recognition across the product.',
            suggestedFix: `Use ${expectedFont} instead of "${fontFamily}".`,
            confidence: 0.8,
            observed: fontFamily,
            expected: expectedFont,
            screenshotIndex,
            evidence: {
              screenshotIndex,
              domSnapshotTimestamp: snap.timestamp,
              events: [eventIndex],
              url: currentUrl,
              selector,
            },
          });
        }
      }

      // ─── Border radius drift ──────────────────────────────────
      const borderRadius = css['borderRadius'];
      if (borderRadius && borderRadius !== '0px' && borderRadius !== '0' && tokenRadii.size > 0) {
        const radiusPx = parseFloat(borderRadius);
        if (!isNaN(radiusPx) && radiusPx > 0 && !tokenRadii.has(radiusPx)) {
          const dedupKey = `radius:${radiusPx}`;
          if (seenRadii.has(dedupKey)) continue;
          seenRadii.add(dedupKey);

          const closestRadius = [...tokenRadii].sort((a, b) =>
            Math.abs(a - radiusPx) - Math.abs(b - radiusPx)
          )[0];

          findings.push({
            id: `drift-radius-${findings.length}`,
            category: 'Design System',
            severity: 'Low',
            title: `${formatSelector(selector)} uses off-scale border radius`,
            description: `Border radius ${radiusPx}px on ${formatSelector(selector)} is not in the design system scale. Closest token: ${closestRadius}px.`,
            page: currentUrl,
            timestamp: snap.timestamp,
            selector,
            whyItMatters: 'Consistent border radius creates visual rhythm. Off-scale values look like mistakes.',
            suggestedFix: `Use ${closestRadius}px (--r-card or --r-control) instead of ${radiusPx}px.`,
            confidence: 0.7,
            observed: `${radiusPx}px`,
            expected: `${closestRadius}px (design system radius token)`,
            screenshotIndex,
            evidence: {
              screenshotIndex,
              domSnapshotTimestamp: snap.timestamp,
              events: [eventIndex],
              url: currentUrl,
              selector,
            },
          });
        }
      }

      // ─── Spacing drift ────────────────────────────────────────
      const spacingKeys = ['padding', 'margin', 'gap'];
      for (const key of spacingKeys) {
        const val = css[key];
        if (!val || val === '0px' || val === '0') continue;
        const px = parseFloat(val);
        if (isNaN(px) || px === 0) continue;
        if (tokenSpacing.has(px)) continue;

        // Only report multiples of the base unit that miss the scale
        if (px % 4 !== 0) continue;

        findings.push({
          id: `drift-spacing-${findings.length}`,
          category: 'Design System',
          severity: 'Low',
          title: `${formatSelector(selector)} ${key}: ${px}px is off-scale`,
          description: `Spacing value ${px}px (${key}) is not in the design system spacing scale.`,
          page: currentUrl,
          timestamp: snap.timestamp,
          selector,
          whyItMatters: 'Off-scale spacing creates uneven rhythm and makes the layout feel unpolished.',
          suggestedFix: `Use a design system spacing token (${[...tokenSpacing].sort((a,b) => a-b).slice(0,5).join(', ')}...).`,
          confidence: 0.6,
          observed: `${px}px`,
          expected: 'design system spacing token',
          screenshotIndex,
          evidence: {
            screenshotIndex,
            domSnapshotTimestamp: snap.timestamp,
            events: [eventIndex],
            url: currentUrl,
            selector,
          },
        });
        break; // one spacing finding per element
      }
    }
  }

  // ─── Shadow / elevation drift ────────────────────────────────
  // Check if box-shadow values match design system shadows
  const tokenShadows = collectTokenShadows(ds);
  for (let i = 0; i < domSnapshots.length; i++) {
    const snap = domSnapshots[i];
    if (snap.type !== 'dom_snapshot') continue;
    const styles = snap.computedStyles || {};
    const eventIndex = session.events.indexOf(snap);
    const screenshotIndex = findNearestScreenshot(session.screenshots, snap.timestamp);

    for (const [selector, css] of Object.entries(styles)) {
      const boxShadow = css['boxShadow'];
      if (!boxShadow || boxShadow === 'none' || boxShadow === 'none ' || tokenShadows.size === 0) continue;

      const normalized = boxShadow.replace(/\s+/g, ' ').trim();
      if (tokenShadows.has(normalized)) continue;

      findings.push({
        id: `drift-shadow-${findings.length}`,
        category: 'Design System',
        severity: 'Low',
        title: `${formatSelector(selector)} uses non-token shadow`,
        description: `Box shadow on ${formatSelector(selector)} does not match design system elevation tokens.`,
        page: snap.url || '',
        timestamp: snap.timestamp,
        selector,
        whyItMatters: 'Inconsistent shadows create conflicting depth cues and degrade the elevation system.',
        suggestedFix: 'Use a design system shadow token (--shadow-popup or --shadow-sheet).',
        confidence: 0.5,
        observed: normalized.slice(0, 80),
        expected: 'design system shadow token',
        screenshotIndex,
        evidence: {
          screenshotIndex,
          domSnapshotTimestamp: snap.timestamp,
          events: [eventIndex],
          url: snap.url || '',
          selector,
        },
      });
    }
  }

  // If forced against the global system, mark every finding as uncalibrated so the
  // report is honest about what it was compared against.
  console.log(`  Drift: ${findings.length} findings (colors/fonts/radii/spacing/shadows)`);
  return { findings, skipped: false };
}

// ─── Helpers ────────────────────────────────────────────────────

function loadDesignSystem(project: string): DesignSystem | null {
  // Per-project ONLY — never the global file (see projectDesignSystemPath).
  const p = projectDesignSystemPath(project);
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      console.error(`  Failed to parse design system: ${p}`);
    }
  }
  return null;
}

function collectTokenColors(ds: DesignSystem): Set<string> {
  const colors = new Set<string>();
  if (!ds.color) return colors;
  for (const hex of Object.values(ds.color)) {
    const normalized = hex.toUpperCase().replace('#', '');
    colors.add(normalized);
  }
  return colors;
}

function collectTokenRadii(ds: DesignSystem): Set<number> {
  const radii = new Set<number>();
  if (!ds.radius) return radii;
  for (const val of Object.values(ds.radius)) {
    if (typeof val === 'number') radii.add(val);
  }
  return radii;
}

function collectTokenShadows(ds: DesignSystem): Set<string> {
  const shadows = new Set<string>();
  if (!ds.shadow) return shadows;
  for (const val of Object.values(ds.shadow)) {
    shadows.add(val.replace(/\s+/g, ' ').trim());
  }
  return shadows;
}

function normalizeColor(val: string): string | null {
  // rgb(r, g, b) → hex
  const rgbMatch = val.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (rgbMatch) {
    return [parseInt(rgbMatch[1]), parseInt(rgbMatch[2]), parseInt(rgbMatch[3])]
      .map(c => c.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }
  // #hex or #hexhex
  const hexMatch = val.match(/^#([0-9a-fA-F]{3,8})/);
  if (hexMatch) {
    let hex = hexMatch[1].toUpperCase();
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length === 8) hex = hex.slice(0, 6);
    return hex;
  }
  return null;
}

function findClosestTokenColor(hex: string, tokens: Set<string>): string | null {
  const r1 = parseInt(hex.slice(0, 2), 16);
  const g1 = parseInt(hex.slice(2, 4), 16);
  const b1 = parseInt(hex.slice(4, 6), 16);

  let best = null;
  let bestDist = Infinity;

  for (const token of tokens) {
    if (token.length < 6) continue;
    const r2 = parseInt(token.slice(0, 2), 16);
    const g2 = parseInt(token.slice(2, 4), 16);
    const b2 = parseInt(token.slice(4, 6), 16);
    const dist = Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
    if (dist < bestDist) {
      bestDist = dist;
      best = token;
    }
  }

  return best ? `#${best}` : null;
}

function findNearestScreenshot(
  screenshots: LoupeSession['screenshots'],
  timestamp: number
): number | undefined {
  let bestIdx: number | undefined;
  let bestDist = Infinity;
  for (let i = 0; i < screenshots.length; i++) {
    const dist = Math.abs(screenshots[i].timestamp - timestamp);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function formatSelector(sel: string): string {
  if (!sel || sel === 'unknown') return 'element';
  if (sel.startsWith('#')) return sel;
  if (sel.length > 40) return sel.slice(0, 38) + '…';
  return sel;
}
