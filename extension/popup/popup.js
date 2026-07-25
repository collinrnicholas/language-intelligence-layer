// ─── Persado Demo — Popup Logic ──────────────────────────────────
//
// Flow: Open on any page → auto-detect URL → pick audience/goal →
// Select Element → Narrate → Generate → Results

const GATEWAY = 'http://localhost:8787';

// ─── DOM refs ────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const headerStatus = $('headerStatus');
const headerStatusText = $('headerStatusText');
const toast = $('toast');

const panelConfigure = $('panelConfigure');
const panelCaptured = $('panelCaptured');
const panelResults = $('panelResults');

const pageUrl = $('pageUrl');
const audienceSelect = $('audience');
const goalSelect = $('goal');
const btnSelectElement = $('btnSelectElement');

const elType = $('elType');
const elText = $('elText');
const elContext = $('elContext');
const narrationBlock = $('narrationBlock');
const narrationText = $('narrationText');
const narrationField = $('narrationField');
const narrationInput = $('narration');
const btnGenerate = $('btnGenerate');
const loadingGenerate = $('loadingGenerate');

const resultsContainer = $('resultsContainer');
const btnExportBrief = $('btnExportBrief');
const btnNewBrief = $('btnNewBrief');

// ─── State ───────────────────────────────────────────────────────

let capturedElement = null;
let recommendations = null;
let currentUrl = '';

// ─── Toast ───────────────────────────────────────────────────────

function showToast(msg, kind = 'ok') {
  toast.textContent = msg;
  toast.className = 'toast ' + kind;
  setTimeout(() => { toast.className = 'toast'; }, 3000);
}

function setStatus(text) {
  headerStatusText.textContent = text;
}

// ─── Panel switching ─────────────────────────────────────────────

function showPanel(panel) {
  [panelConfigure, panelCaptured, panelResults].forEach(p => p.classList.remove('active'));
  panel.classList.add('active');
}

// ─── Auto-detect page URL ────────────────────────────────────────

async function detectPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      currentUrl = tab.url;
      // Show domain + path, not full URL
      try {
        const u = new URL(tab.url);
        pageUrl.textContent = u.hostname + u.pathname;
      } catch {
        pageUrl.textContent = tab.url.slice(0, 60);
      }
    }
  } catch {
    pageUrl.textContent = '(unknown)';
  }
}

// ─── Element selection ───────────────────────────────────────────

btnSelectElement.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { showToast('No active tab found', 'err'); return; }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectElementPicker,
    });

    showToast('Click any element on the page ✦');
  } catch (err) {
    showToast('Cannot access this page. Use a regular http:// page.', 'err');
  }
});

// ─── Element Picker (injected into the page) ─────────────────────

function injectElementPicker() {
  document.querySelectorAll('#persado-picker-overlay, #persado-highlight').forEach(el => el.remove());

  let hovered = null;

  const overlay = document.createElement('div');
  overlay.id = 'persado-picker-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;';
  document.body.appendChild(overlay);

  const highlight = document.createElement('div');
  highlight.id = 'persado-highlight';
  highlight.style.cssText =
    'position:fixed;z-index:2147483647;border:2px solid #E8388C;' +
    'background:rgba(92,45,145,0.08);pointer-events:none;' +
    'transition:all 0.1s;border-radius:4px;';
  document.body.appendChild(highlight);

  function classifyElement(el) {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim().toLowerCase();
    if (tag === 'a' || tag === 'button' || el.getAttribute('role') === 'button') {
      if (/(apply|open|start|get started|sign up|learn more|see |try |compare)/i.test(text)) {
        return 'CTA';
      }
    }
    if (/^h[1-4]$/.test(tag)) return 'Headline';
    if (/^h[5-6]$/.test(tag) || /subhead/i.test(el.className || '')) return 'Subhead';
    if (/(guarantee|secure|trust|fdic|insured|protection|safe|backed)/i.test(text)) return 'Trust Line';
    if (/(offer|rate|bonus|cash|reward|save|earn|fee|apr|apy)/i.test(text)) return 'Promo';
    return 'Body Copy';
  }

  function getSurroundingContext(el) {
    const parent = el.closest('section, article, [class*="hero"], [class*="banner"], [class*="card"], [class*="feature"]');
    if (!parent) return '';
    const fullText = (parent.textContent || '').trim().slice(0, 250);
    const elText = (el.textContent || '').trim();
    return fullText.replace(elText, '⟦' + elText + '⟧');
  }

  function getSelector(el) {
    if (el.id) return '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (cls) return el.tagName.toLowerCase() + '.' + cls;
    }
    return el.tagName.toLowerCase();
  }

  function pickElement(el) {
    const type = classifyElement(el);
    const text = (el.textContent || '').trim().slice(0, 300);
    const context = getSurroundingContext(el);
    const selector = getSelector(el);

    overlay.remove();
    highlight.remove();

    chrome.runtime.sendMessage({
      type: 'PERSADO_ELEMENT_CAPTURED',
      element: { type, text, context, selector },
    });
  }

  overlay.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === highlight) return;
    hovered = el;
    const rect = el.getBoundingClientRect();
    highlight.style.left = rect.left + 'px';
    highlight.style.top = rect.top + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';
  });

  overlay.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (hovered) pickElement(hovered);
  });

  function onKey(e) {
    if (e.key === 'Escape') {
      overlay.remove();
      highlight.remove();
      document.removeEventListener('keydown', onKey);
    }
  }
  document.addEventListener('keydown', onKey);
}

// ─── Listen for element capture ──────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PERSADO_ELEMENT_CAPTURED' && msg.element) {
    capturedElement = msg.element;
    elType.textContent = msg.element.type;
    elText.textContent = msg.element.text || '(empty)';
    elContext.textContent = msg.element.context || '';
    elContext.style.display = msg.element.context ? 'block' : 'none';
    showPanel(panelCaptured);
    setStatus('Ready');
  }
});

async function checkPendingCapture() {
  try {
    const stored = await chrome.storage.local.get('persado:pendingCapture');
    if (stored['persado:pendingCapture']) {
      capturedElement = stored['persado:pendingCapture'];
      await chrome.storage.local.remove('persado:pendingCapture');
      elType.textContent = capturedElement.type;
      elText.textContent = capturedElement.text || '(empty)';
      elContext.textContent = capturedElement.context || '';
      elContext.style.display = capturedElement.context ? 'block' : 'none';
      showPanel(panelCaptured);
    }
  } catch {}
}

// ─── Generate ────────────────────────────────────────────────────

btnGenerate.addEventListener('click', async () => {
  const narration = narrationInput.value.trim();
  if (!capturedElement) { showToast('Select an element first', 'err'); return; }

  if (narration) {
    narrationText.textContent = narration;
    narrationBlock.style.display = 'block';
    narrationField.style.display = 'none';
  }

  const brief = {
    element: capturedElement,
    narration: narration || '(no narration provided)',
    audience: audienceSelect.value,
    goal: goalSelect.value,
    pageUrl: currentUrl,
  };

  btnGenerate.style.display = 'none';
  loadingGenerate.classList.add('active');
  setStatus('Generating…');

  try {
    const resp = await fetch(GATEWAY + '/v1/ai/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(brief),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Gateway error' }));
      throw new Error(err.error || 'Gateway returned ' + resp.status);
    }

    const data = await resp.json();
    recommendations = data.variants || [];
    renderResults();
    showPanel(panelResults);
    setStatus('Done');
  } catch (err) {
    showToast(err.message || 'Failed to generate. Is the gateway running?', 'err');
    setStatus('Error');
  } finally {
    loadingGenerate.classList.remove('active');
    btnGenerate.style.display = '';
  }
});

// ─── Render Results ──────────────────────────────────────────────

function renderResults() {
  if (!recommendations?.length) {
    resultsContainer.innerHTML = '<div class="empty-state">No variants generated.</div>';
    return;
  }

  resultsContainer.innerHTML = recommendations.map((v, i) => `
    <div class="rec-card">
      <div class="rc-header">
        <div class="rc-number">Variant ${i + 1}</div>
        <div class="rc-variant">${escapeHtml(v.copy)}</div>
      </div>
      <div class="rc-body">
        <div class="rc-rationale">${escapeHtml(v.rationale || '')}</div>
        <div class="rc-row" style="margin-top:8px;justify-content:space-between;">
          <span class="badge ${v.compliance === 'clear' ? 'clear' : 'flag'}">
            ${v.compliance === 'clear' ? '✓ Compliance Clear' : '⚠ ' + escapeHtml(v.complianceNote || 'Flag')}
          </span>
          <span class="badge lift">📈 ${escapeHtml(v.predictedLift || '+5–12%')} (illustrative)</span>
        </div>
      </div>
    </div>
  `).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Export ──────────────────────────────────────────────────────

btnExportBrief.addEventListener('click', () => {
  if (!capturedElement || !recommendations) {
    showToast('Nothing to export', 'err');
    return;
  }

  const audienceLabels = { new: 'New Customers', existing: 'Existing Customers', lapsed: 'Lapsed / Dormant' };
  const goalLabels = { conversions: 'Conversions', clicks: 'Clicks / CTR', trust: 'Trust / Credibility' };

  const md = [
    '# Persado Marketing Brief',
    '',
    `**Page:** ${currentUrl}`,
    `**Audience:** ${audienceLabels[audienceSelect.value]}`,
    `**Goal:** ${goalLabels[goalSelect.value]}`,
    '',
    '## Captured Element',
    `- **Type:** ${capturedElement.type}`,
    `- **Current Copy:** "${capturedElement.text}"`,
    capturedElement.context ? `- **Surrounding Context:** ${capturedElement.context}` : '',
    `- **Selector:** \`${capturedElement.selector}\``,
    '',
    '## Narration',
    `> ${narrationText.textContent || '(none)'}`,
    '',
    '## Recommendations',
    '',
    '> ⚠️ **Demo only.** Generated by a general-purpose LLM standing in for Persado Motivation AI.',
    '',
    ...recommendations.flatMap((v, i) => [
      `### Variant ${i + 1}`,
      `- **Copy:** ${v.copy}`,
      `- **Rationale:** ${v.rationale || '—'}`,
      `- **Compliance:** ${v.compliance === 'clear' ? '✓ Clear' : '⚠ ' + (v.complianceNote || 'Flag')}`,
      `- **Predicted Lift:** ${v.predictedLift || '+5–12%'} *(illustrative)*`,
      '',
    ]),
  ].filter(l => l !== '').join('\n');

  navigator.clipboard.writeText(md).then(() => {
    showToast('Brief copied to clipboard ✓');
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = md;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast('Brief copied to clipboard ✓');
  });
});

// ─── New Brief ───────────────────────────────────────────────────

btnNewBrief.addEventListener('click', () => {
  capturedElement = null;
  recommendations = null;
  narrationInput.value = '';
  narrationBlock.style.display = 'none';
  narrationField.style.display = '';
  resultsContainer.innerHTML = '';
  showPanel(panelConfigure);
  setStatus('Ready');
});

// ─── Init ────────────────────────────────────────────────────────

async function init() {
  await detectPage();
  await checkPendingCapture();
  if (capturedElement) showPanel(panelCaptured);
  setStatus('Ready');
}

init();
