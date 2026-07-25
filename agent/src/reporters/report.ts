import type { LoupeSession, Opportunity } from '../cli.js';
import type { ReviewOutput, MergedOpportunity, ExperienceScore } from '../ai/review.js';

export function generateReport(
  session: LoupeSession,
  findings: Opportunity[],
  reviewOutput?: ReviewOutput,
  // Relative paths to extracted screenshots, index-aligned with
  // session.screenshots. When omitted, the report renders without images
  // (it never inlines base64).
  screenshotRels: (string | null)[] = [],
  // Report-level status flags. driftSkipped → render an explicit note so the
  // reader knows drift was not evaluated (vs. silently omitted).
  opts: { driftSkipped?: boolean } = {}
): string {
  const { project, flow, startedAt, endedAt, urlTimeline, events, screenshots, viewport, browser, notes } = session;
  const duration = ((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000).toFixed(0);

  // Group findings by severity
  const critical = findings.filter(f => f.severity === 'Critical');
  const high = findings.filter(f => f.severity === 'High');
  const medium = findings.filter(f => f.severity === 'Medium');
  const low = findings.filter(f => f.severity === 'Low');
  const info = findings.filter(f => f.severity === 'Info');

  // Event timeline
  const timeline = events.slice(0, 30);

  // Transcript timeline
  const transcriptHtml = notes.map(t => {
    const sec = (t.timestamp / 1000).toFixed(1);
    return `<div class="transcript-item"><span class="ts">${sec}s</span> <span>🎙️ ${escapeHtml(t.text)}</span></div>`;
  }).join('\n');

  // Console errors
  const consoleErrors = events.filter(e => e.type === 'console_error');
  const consoleHtml = consoleErrors.map(e =>
    `<div class="console-item"><span class="ts">${(e.timestamp / 1000).toFixed(1)}s</span> <span class="err-msg">${escapeHtml(e.message.slice(0, 200))}</span></div>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Loupe Report — ${escapeHtml(project)}</title>
<style>
  /* System font stack — no external font fetch (reports stay local/offline). */
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif; background: #101317; color: #e8eaed; line-height: 1.5; letter-spacing: -0.01em; }
  code, .mono { font-family: 'Spline Sans Mono', 'SF Mono', monospace; }
  .container { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 28px; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.02em; }
  .subtitle { color: #8e9299; margin-bottom: 24px; }
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 32px; }
  .meta-card { background: #181b21; border-radius: 8px; padding: 16px; }
  .meta-card .label { color: #8e9299; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 500; }
  .meta-card .value { font-size: 18px; font-weight: 600; margin-top: 4px; }
  .section { margin-bottom: 32px; }
  .section h2 { font-size: 20px; font-weight: 600; margin-bottom: 12px; border-bottom: 1px solid #2a2e36; padding-bottom: 8px; letter-spacing: -0.01em; }
  .finding { background: #181b21; border-radius: 8px; padding: 16px; margin-bottom: 12px; border-left: 4px solid #555; }
  .finding.Critical { border-left-color: #e74c3c; }
  .finding.High { border-left-color: #f39c12; }
  .finding.Medium { border-left-color: #3498db; }
  .finding.Low { border-left-color: #8e9299; }
  .finding.Info { border-left-color: #12C97E; }
  .finding .severity { display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; margin-bottom: 8px; font-family: 'Space Grotesk', sans-serif; }
  .finding.Critical .severity { background: #3d1a1a; color: #e74c3c; }
  .finding.High .severity { background: #3d2e0f; color: #f39c12; }
  .finding.Medium .severity { background: #1a2d3d; color: #3498db; }
  .finding.Low .severity { background: #181b21; color: #8e9299; }
  .finding.Info .severity { background: rgba(18, 201, 126, 0.1); color: #12C97E; }
  .finding .evidence { margin-top: 10px; padding: 10px 12px; background: rgba(18, 201, 126, 0.05); border-radius: 6px; font-size: 12px; color: #8e9299; }
  .finding .evidence strong { color: #e8eaed; }
  .finding .screenshot { margin-top: 10px; }
  .finding .screenshot img { max-width: 100%; border-radius: 6px; border: 1px solid #2a2e36; }
  .finding .drift-observed { color: #e74c3c; }
  .finding .drift-expected { color: #12C97E; }
  .drift-note { margin: 18px 0; padding: 14px 16px; border: 1px dashed #c9ced6; border-radius: 8px; background: #f7f8f9; color: #4b5563; font-size: 13px; }
  .drift-note strong { color: #101317; }
  .drift-note code { font-family: var(--font-mono, monospace); background: #eef0f2; padding: 1px 5px; border-radius: 4px; }
  .finding h3 { font-size: 16px; font-weight: 600; margin-bottom: 6px; }
  .finding p { color: #b4b8c2; font-size: 14px; margin-bottom: 8px; }
  .finding .detail { font-size: 13px; color: #8e9299; }
  .finding .detail strong { color: #e8eaed; }
  .narrated-quote {
    background: rgba(18, 201, 126, 0.08);
    border-left: 3px solid #12C97E;
    padding: 8px 12px;
    border-radius: 0 6px 6px 0;
    font-size: 13px;
    color: #12C97E;
    margin-bottom: 10px;
    font-style: italic;
  }
  .narrated-intro { color: #8e9299; font-size: 13px; margin-bottom: 16px; }
  .executive-summary {
    display: flex; gap: 24px; align-items: flex-start;
    background: #181b21; border-radius: 12px; padding: 24px;
    margin-bottom: 24px; flex-wrap: wrap;
  }
  .score-hero { text-align: center; min-width: 100px; }
  .score-number { font-size: 56px; font-weight: 700; line-height: 1; letter-spacing: -0.03em; }
  .score-hero .score-label { font-size: 12px; color: #8e9299; text-transform: uppercase; letter-spacing: 0.1em; margin-top: 4px; font-family: 'Spline Sans Mono', monospace; }
  .score-breakdown { flex: 1; min-width: 200px; }
  .score-category {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 6px; font-size: 13px;
  }
  .score-category .score-label { width: 110px; color: #b4b8c2; font-weight: 500; flex-shrink: 0; }
  .score-bar-track { flex: 1; height: 6px; background: #2a2e36; border-radius: 3px; overflow: hidden; }
  .score-bar-fill { height: 100%; border-radius: 3px; transition: width 0.6s ease-out; }
  .score-category .score-value { width: 30px; text-align: right; font-weight: 600; font-size: 12px; font-family: 'Spline Sans Mono', monospace; }
  .reviewed-by { width: 100%; text-align: center; font-size: 12px; color: #8e9299; padding-top: 8px; border-top: 1px solid #2a2e36; }
  .top-finding {
    display: flex; gap: 14px; align-items: flex-start;
    background: #181b21; border-radius: 8px; padding: 14px 16px;
    margin-bottom: 8px; border-left: 3px solid #12C97E;
  }
  .top-finding:first-of-type { border-left-color: #e74c3c; }
  .top-rank { font-size: 18px; font-weight: 700; color: #8e9299; min-width: 28px; }
  .top-finding strong { display: block; font-size: 14px; margin-bottom: 2px; }
  .top-meta { font-size: 11px; color: #8e9299; font-family: 'Spline Sans Mono', monospace; }
  .top-finding p { font-size: 13px; color: #b4b8c2; margin-top: 4px; }
  .severity { font-size: 10px; font-weight: 600; text-transform: uppercase; padding: 1px 6px; border-radius: 3px; margin-right: 6px; }
  .severity.Critical { background: #3d1a1a; color: #e74c3c; }
  .severity.High { background: #3d2e0f; color: #f39c12; }
  .severity.Medium { background: #1a2d3d; color: #3498db; }
  .severity.Low { background: #181b21; color: #8e9299; }
  .severity.Info { background: rgba(18, 201, 126, 0.1); color: #12C97E; }
  .build-intro { color: #8e9299; font-size: 13px; margin-bottom: 16px; }
  .build-card {
    display: flex; gap: 14px; align-items: flex-start;
    background: #181b21; border-radius: 8px; padding: 14px 16px;
    margin-bottom: 8px; border-left: 3px solid #12C97E;
  }
  .build-card:first-of-type { border-left-color: #e74c3c; }
  .build-rank { font-size: 18px; font-weight: 700; color: #8e9299; min-width: 24px; font-family: 'Spline Sans Mono', monospace; }
  .build-body { flex: 1; }
  .build-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .build-header strong { font-size: 14px; }
  .build-prompt {
    background: #0f1117; border-radius: 6px; padding: 10px 12px;
    font-family: 'Spline Sans Mono', monospace; font-size: 12px;
    color: #b4b8c2; overflow-x: auto; white-space: pre-wrap;
    word-break: break-word; line-height: 1.5;
  }
  .build-prompt code { font-family: 'Spline Sans Mono', monospace; }
  .build-criteria {
    margin-top: 8px; font-size: 12px; color: #12C97E;
    font-family: 'Spline Sans Mono', monospace; line-height: 1.6;
  }
  .timeline { display: flex; flex-direction: column; gap: 4px; }
  .timeline-item { display: flex; gap: 8px; font-size: 13px; padding: 4px 0; border-bottom: 1px solid #181b21; }
  .timeline-item .ts { color: #12C97E; font-family: 'Spline Sans Mono', monospace; min-width: 60px; }
  .timeline-item .ev { color: #b4b8c2; }
  .transcript-item { padding: 6px 0; border-bottom: 1px solid #181b21; font-size: 14px; }
  .transcript-item .ts { color: #12C97E; font-family: 'Spline Sans Mono', monospace; margin-right: 8px; }
  .console-item { padding: 4px 0; font-size: 13px; }
  .console-item .err-msg { color: #e74c3c; font-family: 'Spline Sans Mono', monospace; font-size: 12px; }
  .console-item .ts { font-family: 'Spline Sans Mono', monospace; }
  .empty { color: #8e9299; font-style: italic; padding: 16px; text-align: center; }
  .summary-stats { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat-pill { padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 500; font-family: 'Space Grotesk', sans-serif; }
  .stat-pill.Critical { background: #3d1a1a; color: #e74c3c; }
  .stat-pill.High { background: #3d2e0f; color: #f39c12; }
  .stat-pill.Medium { background: #1a2d3d; color: #3498db; }
  .stat-pill.Info { background: rgba(18, 201, 126, 0.1); color: #12C97E; }
  .stat-pill.ok { background: rgba(18, 201, 126, 0.1); color: #12C97E; }
  footer { text-align: center; color: #555; font-size: 12px; padding: 32px 0; }
</style>
</head>
<body>
<div class="container">
  <h1>🔍 Loupe Report</h1>
  <p class="subtitle">${escapeHtml(project)} — ${escapeHtml(flow)}</p>

  ${reviewOutput ? renderExecutiveSummary(reviewOutput) : ''}

  ${reviewOutput?.top5?.length ? renderTopFindings(reviewOutput.top5) : ''}

  ${findings.length > 0 ? renderBuildThis(findings, project) : ''}

  <div class="summary-stats">
    ${critical.length ? `<span class="stat-pill Critical">${critical.length} Critical</span>` : ''}
    ${high.length ? `<span class="stat-pill High">${high.length} High</span>` : ''}
    ${medium.length ? `<span class="stat-pill Medium">${medium.length} Medium</span>` : ''}
    ${findings.length === 0 ? '<span class="stat-pill ok">✓ No issues found</span>' : ''}
  </div>

  <div class="meta-grid">
    <div class="meta-card"><div class="label">Duration</div><div class="value">${duration}s</div></div>
    <div class="meta-card"><div class="label">Events</div><div class="value">${events.length}</div></div>
    <div class="meta-card"><div class="label">Clicks</div><div class="value">${events.filter(e => e.type === 'click').length}</div></div>
    <div class="meta-card"><div class="label">Pages</div><div class="value">${new Set(urlTimeline.map(u => u.url)).size}</div></div>
    <div class="meta-card"><div class="label">Notes</div><div class="value">${notes.length ? '✓' : '—'}</div></div>
    <div class="meta-card"><div class="label">Findings</div><div class="value">${findings.length}</div></div>
  </div>

  ${findings.length > 0 ? `
  <div class="section">
    <h2>🔴 Findings</h2>
    ${findings.map(f => renderFinding(f, screenshotRels)).join('\n')}
  </div>` : ''}

  ${opts.driftSkipped ? renderDriftSkipped(project) : ''}

  ${buildNarratedFindings(findings, notes, screenshots)}

  ${transcriptHtml ? `
  <div class="section">
    <h2>🎙️ Narration</h2>
    ${transcriptHtml}
  </div>` : ''}

  <div class="section">
    <h2>📋 Event Timeline</h2>
    <div class="timeline">
      ${timeline.map(e => renderTimelineEvent(e)).join('\n')}
    </div>
  </div>

  ${consoleErrors.length > 0 ? `
  <div class="section">
    <h2>⚠️ Console Errors</h2>
    ${consoleHtml}
  </div>` : ''}

  <footer>Generated by Loupe v2.0.0-alpha</footer>
</div>
</body>
</html>`;
}

function renderDriftSkipped(project: string): string {
  return `<div class="drift-note">
    <strong>Design-system drift was not evaluated.</strong> No design system is configured for
    project "${escapeHtml(project)}", so the recorded UI was not compared against any token set.
    To enable drift checks, run <code>loupe design-system init ${escapeHtml(project)}</code> and fill in
    your project's color / font / radius / spacing / shadow tokens.
  </div>`;
}

function renderBuildThis(
  findings: Opportunity[],
  project: string
): string {
  const prioritized = [...findings]
    .filter(f => f.severity === 'Critical' || f.severity === 'High' || f.severity === 'Medium')
    .sort((a, b) => {
      const rank: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 };
      return (rank[a.severity] || 5) - (rank[b.severity] || 5);
    })
    .slice(0, 8);

  if (prioritized.length === 0) return '';

  const items = prioritized.map((f, i) => {
    const prompt = f.implementationPrompt ||
      `Fix: ${escapeHtml(f.suggestedFix || f.title)} on ${escapeHtml(f.selector || 'affected element')}`;

    const criteriaPreview = f.acceptanceCriteria?.length
      ? f.acceptanceCriteria.slice(0, 2).map(c => `✓ ${escapeHtml(c)}`).join('<br>')
      : '';

    return `<div class="build-card">
      <div class="build-rank">${i + 1}</div>
      <div class="build-body">
        <div class="build-header">
          <span class="severity ${f.severity}">${f.severity}</span>
          <strong>${escapeHtml(f.title)}</strong>
        </div>
        <div class="build-prompt">
          <code>${escapeHtml(prompt.slice(0, 300))}${prompt.length > 300 ? '…' : ''}</code>
        </div>
        ${criteriaPreview ? `<div class="build-criteria">${criteriaPreview}</div>` : ''}
      </div>
    </div>`;
  }).join('\n');

  return `<div class="section">
    <h2>🔨 Build This</h2>
    <p class="build-intro">Implementation prompts for AI coding agents. Copy any card into Claude Code, Codex, or Cursor.</p>
    ${items}
  </div>`;
}

function renderExecutiveSummary(review: ReviewOutput): string {
  const score = review.score;
  const scoreColor = score.overall >= 80 ? '#12C97E' : score.overall >= 60 ? '#f39c12' : '#e74c3c';

  const categoryBars = score.categories
    .filter(c => c.findingCount > 0)
    .sort((a, b) => a.score - b.score)
    .map(c => {
      const barColor = c.score >= 80 ? '#12C97E' : c.score >= 60 ? '#f39c12' : '#e74c3c';
      return `<div class="score-category">
        <span class="score-label">${c.category}</span>
        <div class="score-bar-track">
          <div class="score-bar-fill" style="width:${c.score}%;background:${barColor};"></div>
        </div>
        <span class="score-value" style="color:${barColor};">${c.score}</span>
      </div>`;
    }).join('\n');

  return `<div class="executive-summary">
    <div class="score-hero">
      <div class="score-number" style="color:${scoreColor};">${score.overall}</div>
      <div class="score-label">Product Experience Score</div>
    </div>
    ${categoryBars ? `<div class="score-breakdown">${categoryBars}</div>` : ''}
    ${review.reviewedBy.length ? `<div class="reviewed-by">Reviewed by: ${review.reviewedBy.join(', ')}</div>` : ''}
  </div>`;
}

function renderTopFindings(top5: MergedOpportunity[]): string {
  const items = top5.map((f, i) => {
    const reviewedBy = f.reviewedBy?.length ? ` · ${f.reviewedBy.join(', ')}` : '';
    return `<div class="top-finding">
      <span class="top-rank">#${i + 1}</span>
      <div>
        <span class="severity ${f.severity}">${f.severity}</span>
        <strong>${escapeHtml(f.title)}</strong>
        <span class="top-meta">${reviewedBy}</span>
        <p>${escapeHtml(f.description.slice(0, 200))}${f.description.length > 200 ? '…' : ''}</p>
      </div>
    </div>`;
  }).join('\n');

  return `<div class="section">
    <h2>🔝 Top 5 Issues</h2>
    ${items}
  </div>`;
}

function buildNarratedFindings(
  findings: Opportunity[],
  notes: LoupeSession['notes'],
  screenshots: LoupeSession['screenshots']
): string {
  // Pair each non-zero-timestamp finding with the closest transcript note
  const transcriptNotes = notes.filter(n => n.type === 'transcript');
  if (transcriptNotes.length === 0) return '';

  const narrated: Array<{ finding: Opportunity; note: typeof transcriptNotes[0] }> = [];
  for (const f of findings) {
    if (!f.timestamp) continue;
    // Find closest transcript note within ±10s
    let closest: typeof transcriptNotes[0] | null = null;
    let closestDist = Infinity;
    for (const note of transcriptNotes) {
      const dist = Math.abs(f.timestamp - note.timestamp);
      if (dist < 10000 && dist < closestDist) {
        closest = note;
        closestDist = dist;
      }
    }
    if (closest) narrated.push({ finding: f, note: closest });
  }

  if (narrated.length === 0) return '';

  const items = narrated.map(({ finding, note }) => {
    // Find screenshot closest to the note timestamp
    let relatedScreenshot: typeof screenshots[0] | null = null;
    let minDist = Infinity;
    for (const s of screenshots) {
      const d = Math.abs(s.timestamp - note.timestamp);
      if (d < minDist) { minDist = d; relatedScreenshot = s; }
    }

    return `<div class="finding narrated ${finding.severity}">
      <span class="severity">narrated · ${finding.severity}</span>
      <div class="narrated-quote">🗣️ "${escapeHtml(note.text)}"</div>
      <h3>${escapeHtml(finding.title)}</h3>
      <p>${escapeHtml(finding.description)}</p>
      <div class="detail">
        ${finding.whyItMatters ? `<div><strong>Why it matters:</strong> ${escapeHtml(finding.whyItMatters)}</div>` : ''}
        ${finding.suggestedFix ? `<div><strong>Fix:</strong> ${escapeHtml(finding.suggestedFix)}</div>` : ''}
        ${finding.selector ? `<div><strong>Element:</strong> <code>${escapeHtml(finding.selector)}</code></div>` : ''}
        ${finding.page ? `<div><strong>Page:</strong> ${escapeHtml(finding.page)}</div>` : ''}
        ${finding.confidence ? `<div><strong>Confidence:</strong> ${(finding.confidence * 100).toFixed(0)}%</div>` : ''}
      </div>
    </div>`;
  }).join('\n');

  return `<div class="section">
    <h2>💬 Narrated Findings</h2>
    <p class="narrated-intro">Findings correlated with reviewer narration — what you said, what Loupe observed.</p>
    ${items}
  </div>`;
}

function renderFinding(f: Opportunity, screenshotRels: (string | null)[]): string {
  const rel = f.screenshotIndex !== undefined ? screenshotRels[f.screenshotIndex] : null;
  const screenshotHtml = rel
    ? `<div class="screenshot"><img src="${escapeAttr(rel)}" loading="lazy" alt="Screenshot #${f.screenshotIndex}" /></div>`
    : '';

  const evidenceHtml = f.evidence
    ? `<div class="evidence">
      ${f.evidence.selector ? `<span><strong>Selector:</strong> <code>${escapeHtml(f.evidence.selector)}</code></span> · ` : ''}
      ${f.evidence.url ? `<span><strong>URL:</strong> ${escapeHtml(shortUrl(f.evidence.url))}</span> · ` : ''}
      ${f.evidence.screenshotIndex !== undefined ? `<span><strong>Screenshot:</strong> #${f.evidence.screenshotIndex}</span>` : ''}
    </div>`
    : '';

  return `<div class="finding ${f.severity}">
    <span class="severity">${f.severity}</span>
    <h3>${escapeHtml(f.title)}</h3>
    <p>${escapeHtml(f.description)}</p>
    ${f.observed && f.expected ? `<div class="detail"><span class="drift-observed">Observed: ${escapeHtml(f.observed)}</span> → <span class="drift-expected">Expected: ${escapeHtml(f.expected)}</span></div>` : ''}
    ${screenshotHtml}
    <div class="detail">
      ${f.whyItMatters ? `<div><strong>Why it matters:</strong> ${escapeHtml(f.whyItMatters)}</div>` : ''}
      ${f.suggestedFix ? `<div><strong>Fix:</strong> ${escapeHtml(f.suggestedFix)}</div>` : ''}
      ${f.selector ? `<div><strong>Element:</strong> <code>${escapeHtml(f.selector)}</code></div>` : ''}
      ${f.page ? `<div><strong>Page:</strong> ${escapeHtml(f.page)}</div>` : ''}
      ${f.confidence ? `<div><strong>Confidence:</strong> ${(f.confidence * 100).toFixed(0)}%</div>` : ''}
    </div>
    ${evidenceHtml}
  </div>`;
}

function renderTimelineEvent(e: LoupeSession['events'][number]): string {
  const ts = (e.timestamp / 1000).toFixed(1);
  switch (e.type) {
    case 'click':
      return `<div class="timeline-item"><span class="ts">${ts}s</span><span class="ev">🖱️ Click "${escapeHtml(e.textContent.slice(0, 40))}"</span></div>`;
    case 'scroll':
      return `<div class="timeline-item"><span class="ts">${ts}s</span><span class="ev">📜 Scroll y=${e.scrollY}</span></div>`;
    case 'dom_snapshot':
      return `<div class="timeline-item"><span class="ts">${ts}s</span><span class="ev">📸 Page snapshot</span></div>`;
    case 'console_error':
      return `<div class="timeline-item"><span class="ts">${ts}s</span><span class="ev">⚠️ ${escapeHtml(e.message.slice(0, 60))}</span></div>`;
    case 'network':
      return `<div class="timeline-item"><span class="ts">${ts}s</span><span class="ev">🌐 ${escapeHtml(e.url.slice(0, 50))} — ${e.duration}ms</span></div>`;
    default:
      return '';
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname || '/';
  } catch {
    return url.slice(0, 40);
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}
