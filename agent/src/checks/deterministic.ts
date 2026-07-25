import type { LoupeSession, Opportunity, Evidence } from '../cli.js';

/**
 * Run deterministic checks on a session.
 * These are cheap, don't require AI, and produce structured evidence.
 */
export function runDeterministicChecks(session: LoupeSession): Opportunity[] {
  const findings: Opportunity[] = [];
  const startUrl = session.urlTimeline[0]?.url || 'about:blank';

  // Helper to build evidence
  function mkEvidence(opts: Partial<Evidence> = {}): Evidence {
    return {
      events: [],
      url: startUrl,
      ...opts,
    };
  }

  // ─── Console errors (from events) ─────────────────────────────
  const consoleErrors = session.events.filter(e => e.type === 'console_error');
  if (consoleErrors.length > 0) {
    const unique = new Set(consoleErrors.map(e => e.message.slice(0, 80)));
    if (unique.size > 0) {
      findings.push({
        id: 'console-errors',
        category: 'Engineering',
        severity: 'High',
        title: `${unique.size} console error${unique.size > 1 ? 's' : ''}`,
        description: Array.from(unique).slice(0, 5).join('\n'),
        page: startUrl,
        timestamp: consoleErrors[0].timestamp,
        selector: '',
        whyItMatters: 'Console errors indicate unhandled edge cases or API failures. They erode user trust.',
        suggestedFix: 'Investigate each error at its source and add proper error handling.',
        confidence: 1.0,
        evidence: mkEvidence({
          events: consoleErrors.map(e => session.events.indexOf(e)).filter(i => i >= 0),
        }),
      });
    }
  }

  // ─── Slow network requests ───────────────────────────────────
  const slow = session.events.filter(e => e.type === 'network' && e.duration > 1000);
  if (slow.length > 0) {
    findings.push({
      id: 'slow-requests',
      category: 'Performance',
      severity: 'Medium',
      title: `${slow.length} slow network request${slow.length > 1 ? 's' : ''}`,
      description: slow.slice(0, 5).map(n => n.type === 'network' ? `${n.url.slice(0, 60)} — ${n.duration}ms` : '').filter(Boolean).join('\n'),
      page: startUrl,
      timestamp: slow[0].timestamp,
      selector: '',
      whyItMatters: 'Slow API responses degrade perceived performance and can cause loading states to appear.',
      suggestedFix: 'Review API endpoint performance or add skeleton loading states for slow responses.',
      confidence: 0.9,
      evidence: mkEvidence({
        events: slow.map(e => session.events.indexOf(e)).filter(i => i >= 0),
      }),
    });
  }

  // ─── Small touch targets ─────────────────────────────────────
  const touchTargets: Array<{ selector: string; height: number; eventIndex: number; timestamp: number }> = [];
  for (let i = 0; i < session.events.length; i++) {
    const event = session.events[i];
    if (event.type === 'dom_snapshot' && event.computedStyles) {
      for (const [sel, styles] of Object.entries(event.computedStyles)) {
        const height = parsePx(styles.height);
        if (height > 0 && height < 44) {
          touchTargets.push({ selector: sel, height, eventIndex: i, timestamp: event.timestamp });
        }
      }
    }
  }

  if (touchTargets.length > 0) {
    const deduped = [...new Map(touchTargets.map(t => [t.selector, t])).values()];
    const screenshotIndex = findNearestScreenshotIndex(session.screenshots, touchTargets[0].timestamp);

    findings.push({
      id: 'touch-targets',
      category: 'Accessibility',
      severity: 'High',
      title: `${touchTargets.length} touch target${touchTargets.length > 1 ? 's' : ''} below 44px`,
      description: deduped.slice(0, 8).map(t => `${t.selector} — ${t.height}px`).join('\n'),
      page: startUrl,
      timestamp: touchTargets[0].timestamp,
      selector: '',
      whyItMatters: 'WCAG 2.5.5 requires touch targets ≥ 44px. Small targets frustrate mobile and tablet users.',
      suggestedFix: 'Increase min-height to at least 44px on interactive elements.',
      confidence: 0.95,
      screenshotIndex,
      evidence: mkEvidence({
        screenshotIndex,
        events: deduped.map(t => t.eventIndex),
        domSnapshotTimestamp: touchTargets[0].timestamp,
      }),
    });
  }

  // ─── URL navigation health ───────────────────────────────────
  const clicks = session.events.filter(e => e.type === 'click');
  if (session.urlTimeline.length === 0 && clicks.length > 0) {
    findings.push({
      id: 'spa-routing',
      category: 'Interaction',
      severity: 'Low',
      title: 'No URL changes detected',
      description: `${clicks.length} clicks but no URL navigation. SPA routing may not be captured or the app is MPA.`,
      page: startUrl,
      timestamp: 0,
      selector: '',
      whyItMatters: 'Without route tracking, user flow analysis is incomplete.',
      suggestedFix: 'Verify the app uses history.pushState or enable hashchange detection.',
      confidence: 0.7,
      evidence: mkEvidence({
        events: clicks.map(e => session.events.indexOf(e)).filter(i => i >= 0),
      }),
    });
  }

  // ─── No narration ────────────────────────────────────────────
  if (session.notes.length === 0) {
    findings.push({
      id: 'no-narration',
      category: 'Content',
      severity: 'Info',
      title: 'No narration recorded',
      description: 'No mic audio transcript or manual notes. Grant mic permission for richer analysis.',
      page: startUrl,
      timestamp: 0,
      selector: '',
      whyItMatters: 'Narration provides reviewer intent — without it, analysis is purely automated.',
      suggestedFix: 'Grant microphone access and re-record with narration.',
      confidence: 1.0,
      evidence: mkEvidence(),
    });
  }

  return findings;
}

function parsePx(val: string | undefined): number {
  if (!val) return 0;
  const m = val.match(/^([\d.]+)px$/);
  return m ? parseFloat(m[1]) : 0;
}

function findNearestScreenshotIndex(
  screenshots: LoupeSession['screenshots'],
  timestamp: number
): number | undefined {
  let bestIdx: number | undefined;
  let bestDist = Infinity;
  for (let i = 0; i < screenshots.length; i++) {
    const dist = Math.abs(screenshots[i].timestamp - timestamp);
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  }
  return bestIdx;
}
