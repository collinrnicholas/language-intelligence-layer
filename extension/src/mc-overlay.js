// ─── Persado Autopilot — Mailchimp overlay ───────────────────────────────────
//
// A small status pill on Mailchimp campaign pages. Collapsed it is one line of
// status; expanded it offers Optimize draft, the live steps of a run, Revert,
// and a collapsible activity view of what Persado changed. It never edits
// Mailchimp's page: all work goes through the service worker and the Mailchimp
// API. It sits in a closed shadow root (Mailchimp's CSS cannot reach it, and it
// cannot reach Mailchimp's), bottom-left, clear of the editor's own controls,
// and can be hidden for the page.
//
// It holds no credentials and cannot obtain any: the worker only answers it
// MC_STATUS / MC_OPTIMIZE / MC_REVERT, and only from
// *.admin.mailchimp.com (see senderAllowed in background.js).
//
// Content script (manifest content_scripts) after src/messages.js. Idempotent.

(function () {
  if (self.__persadoMcOverlay || !self.PERSADO) return;
  self.__persadoMcOverlay = true;
  const { MSG } = self.PERSADO;

  const host = document.createElement('div');
  host.setAttribute('data-persado-overlay', '');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host{all:initial;}
    *{box-sizing:border-box;margin:0;padding:0;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
    .wrap{position:fixed;left:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-start;gap:8px;}
    .wrap[hidden]{display:none;}
    .pill{display:flex;align-items:center;gap:9px;background:#fff;border:1px solid #ECEAF0;border-radius:10px;padding:7px 10px 7px 9px;
      box-shadow:0 1px 2px rgba(26,17,40,.08);cursor:pointer;max-width:280px;color:#1A1128;text-align:left;}
    .pill:hover{box-shadow:0 4px 14px rgba(26,17,40,.12);}
    .pill:focus-visible{outline:2px solid #1A1128;outline-offset:2px;}
    .mark{font-size:13px;font-weight:700;color:#1A1128;letter-spacing:-.01em;flex:none;}
    .mark b{color:#DC2828;font-weight:700;}
    .lines{display:flex;flex-direction:column;min-width:0;}
    .l1{font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px;white-space:nowrap;}
    .l2{font-size:11px;color:#5C506C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px;}
    .dot{width:6px;height:6px;border-radius:50%;background:#9088A0;flex:none;}
    .dot.ok{background:#10B981;} .dot.work{background:#F59E0B;} .dot.err{background:#DC2828;}
    .x{flex:none;margin-left:2px;width:18px;height:18px;border-radius:5px;border:none;background:none;color:#9088A0;cursor:pointer;font-size:14px;line-height:18px;}
    .x:hover{background:#F7F6F9;color:#1A1128;}
    .card{width:320px;max-height:min(440px,70vh);overflow:auto;background:#fff;border:1px solid #ECEAF0;border-radius:12px;
      box-shadow:0 8px 28px rgba(26,17,40,.14);padding:14px;color:#1A1128;font-size:12.5px;line-height:1.5;}
    .card[hidden]{display:none;}
    .h{font-size:13px;font-weight:700;margin-bottom:2px;}
    .sub{color:#5C506C;font-size:12px;margin-bottom:10px;}
    .btn{display:block;width:100%;border:none;border-radius:10px;background:#1A1128;color:#fff;font-size:13px;font-weight:700;padding:9px 12px;cursor:pointer;}
    .btn[disabled]{opacity:.45;cursor:default;}
    .row{display:flex;gap:12px;margin-top:9px;flex-wrap:wrap;}
    .link{border:none;background:none;color:#1A1128;font-size:12px;cursor:pointer;padding:0;border-bottom:1px solid #ECEAF0;}
    .link:hover{border-bottom-color:#1A1128;}
    .steps{margin-top:10px;display:flex;flex-direction:column;gap:4px;}
    .step{display:flex;align-items:center;gap:7px;color:#9088A0;font-size:12px;}
    .step.active{color:#92400E;} .step.done{color:#065F46;} .step.err{color:#DC2828;}
    .step .dot{background:currentColor;}
    .note{margin-top:10px;padding:8px 10px;border-radius:8px;background:#F7F6F9;color:#5C506C;font-size:12px;}
    .note.ok{background:#ECFDF5;color:#065F46;} .note.err{background:#FEF2F2;color:#991B1B;} .note.warn{background:#FFFBEB;color:#92400E;}
    details{margin-top:12px;border-top:1px solid #ECEAF0;padding-top:10px;}
    summary{cursor:pointer;font-size:12px;font-weight:600;color:#5C506C;list-style:none;}
    summary::-webkit-details-marker{display:none;}
    .act{margin-top:8px;padding-bottom:8px;border-bottom:1px solid #F7F6F9;}
    .act:last-child{border-bottom:none;}
    .act-h{font-size:11px;color:#9088A0;}
    .chg{margin-top:5px;}
    .chg-f{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#9088A0;}
    .was{color:#9088A0;text-decoration:line-through;text-decoration-color:#ECEAF0;}
    .now{color:#1A1128;}
    .why{color:#92400E;font-size:11.5px;}
    .meta{font-family:"JetBrains Mono","SF Mono",monospace;font-size:10.5px;color:#9088A0;word-break:break-all;}
  </style>
  <div class="wrap" hidden>
    <div class="card" id="card" hidden></div>
    <div style="display:flex;align-items:center;gap:4px;">
      <button class="pill" id="pill" aria-expanded="false" aria-controls="card">
        <span class="mark"><b>[</b>P<b>]</b></span>
        <span class="lines"><span class="l1"><span class="dot" id="dot"></span><span id="l1">Persado</span></span><span class="l2" id="l2">Checking…</span></span>
      </button>
      <button class="x" id="hide" title="Hide on this page" aria-label="Hide Persado on this page">×</button>
    </div>
  </div>`;
  const $ = (id) => root.getElementById(id);
  const wrap = root.querySelector('.wrap');
  const card = $('card'), pill = $('pill');

  let state = { webId: null, status: null, steps: [], result: null, error: null, running: false, hidden: false, open: false };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const FIELD = { subject_line: 'Subject line', preview_text: 'Preview text', subject: 'Subject line' };
  const fieldLabel = (f, tp) => FIELD[f] || ({ headline: 'Headline', subheadline: 'Subheadline', body: 'Body', cta: 'Button' }[tp]) || f;
  const STEP_ORDER = ['read', 'optimize', 'write', 'verify'];
  const STEP_LABEL = { read: 'Reading campaign', optimize: 'Optimizing with Persado', write: 'Updating Mailchimp draft', verify: 'Verifying saved draft' };

  function webIdFromLocation() {
    if (!/\/campaigns\//i.test(location.pathname)) return null;
    const id = new URLSearchParams(location.search).get('id');
    return id && /^\d+$/.test(id) ? Number(id) : null;
  }

  async function send(msg) {
    try { return await chrome.runtime.sendMessage(msg); }
    catch (e) { return { ok: false, error: 'The extension was reloaded. Reload this page to reconnect Persado.' }; }
  }

  async function refresh() {
    if (!state.webId) return;
    state.status = await send({ type: MSG.MC_STATUS, webId: state.webId });
    render();
  }

  function pillText() {
    const s = state.status;
    if (state.running) return ['work', 'Persado · Working', state.steps.at(-1)?.label || 'Optimizing'];
    if (!s || !s.ok) return ['err', 'Persado', s?.error || 'Not available'];
    if (!s.persadoKey) return ['err', 'Persado · Not set up', 'Add a Persado key in the side panel'];
    if (!s.connected) return ['err', 'Persado · Mailchimp not connected', 'Connect it in the side panel Settings'];
    if (s.campaignError) return ['err', 'Persado · Connected', s.campaignError];
    if (!s.campaign) return ['', 'Persado · Connected', 'Only drafts can be optimized'];
    if (state.result?.ok) return ['ok', 'Persado · Connected', 'Optimization complete'];
    if (s.optimizedAt) return ['ok', 'Persado · Connected', 'Draft optimized'];
    return ['ok', 'Persado · Connected', 'Campaign optimization available'];
  }

  function stepsHtml() {
    if (!state.steps.length) return '';
    const last = state.steps.at(-1);
    const reached = STEP_ORDER.indexOf(last.step);
    return '<div class="steps">' + STEP_ORDER.map((k, i) => {
      let cls = '';
      if (last.step === 'error' && i === Math.max(0, state.steps.filter(s => STEP_ORDER.includes(s.step)).length - 1)) cls = 'err';
      else if (last.step === 'done' || i < reached) cls = 'done';
      else if (i === reached) cls = 'active';
      return `<div class="step ${cls}"><span class="dot"></span>${esc(STEP_LABEL[k])}</div>`;
    }).join('') + '</div>';
  }

  function changesHtml(changes) {
    return (changes || []).map(c => `<div class="chg"><div class="chg-f">${esc(fieldLabel(c.field, c.touchpoint))}${c.applied === false ? ' · kept' : ''}</div>`
      + (c.applied === false
        ? `<div class="now">${esc(c.original)}</div>${(c.reasons || []).length ? `<div class="why">${esc(c.reasons[0])}</div>` : ''}`
        : `<div class="was">${esc(c.original)}</div><div class="now">${esc(c.optimized)}</div>`)
      + '</div>').join('');
  }

  function activityHtml(list) {
    if (!list?.length) return '<div class="act-h" style="margin-top:8px;">No activity for this campaign yet.</div>';
    return list.map(a => {
      const when = new Date(a.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const perf = a.persado && (a.persado.controlPerformance != null || a.persado.chosenPerformance != null)
        ? ` · Persado score ${a.persado.controlPerformance ?? '–'} → ${a.persado.chosenPerformance ?? '–'}` : '';
      return `<div class="act"><div class="act-h">${esc(when)} · ${esc(a.action)} · ${esc(a.status)}${a.source === 'demo' ? ' · demo fixture' : ''}${esc(perf)}</div>`
        + (a.message ? `<div>${esc(a.message)}</div>` : '')
        + (a.error ? `<div class="why">${esc(a.error.message)}</div>` : '')
        + changesHtml(a.changes)
        + (a.persado?.jobId ? `<div class="meta">job ${esc(a.persado.jobId)}${a.persado.requestId ? ' · request ' + esc(a.persado.requestId) : ''}</div>` : '')
        + '</div>';
    }).join('');
  }

  function render() {
    if (state.hidden || !state.webId) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const [cls, l1, l2] = pillText();
    $('dot').className = 'dot ' + cls;
    $('l1').textContent = l1;
    $('l2').textContent = l2;
    pill.setAttribute('aria-expanded', String(state.open));
    card.hidden = !state.open;
    if (!state.open) return;
    const s = state.status || {};
    const ready = s.ok && s.connected && s.persadoKey && s.campaign && !state.running;
    let html = `<div class="h">${esc(s.campaign?.title || 'Persado Autopilot')}</div>`
      + `<div class="sub">${s.campaign ? 'Draft · subject line, preview text and eligible body copy' : esc(l2)}</div>`;
    if (s.campaign) {
      html += `<button class="btn" id="go" ${ready ? '' : 'disabled'}>${state.running ? 'Optimizing…' : s.optimizedAt ? 'Optimize again' : 'Optimize draft'}</button>`;
      html += `<div class="sub" style="margin:6px 0 0;">Save your work in the editor first. One Persado optimize run (est. 5 runs of your quota). Nothing is sent to your audience.</div>`;
    }
    html += stepsHtml();
    if (state.error) {
      html += `<div class="note err">${esc(state.error)}</div>`;
      if (state.errorKind === 'already_optimized') html += `<div class="row"><button class="link" id="force">Run again anyway</button></div>`;
    }
    if (state.result?.ok) {
      const r = state.result;
      const applied = (r.changes || []).filter(c => c.applied).length;
      const tone = r.status === 'ok' ? 'ok' : r.status === 'no_change' || r.status === 'nothing_eligible' ? 'warn' : 'warn';
      const text = r.status === 'no_change' ? (r.message || 'Persado returned nothing better; the draft is unchanged.')
        : r.status === 'nothing_eligible' ? 'Nothing in this draft is eligible to optimize.'
        : r.status === 'unverified' ? 'Written, but Mailchimp did not read back every change. Check the draft.'
        : `${applied} field${applied === 1 ? '' : 's'} updated and verified in Mailchimp.`
          + (r.persado?.controlPerformance != null && r.alternative?.performance != null ? ` Persado score ${r.persado.controlPerformance} → ${r.alternative.performance}.` : '');
      html += `<div class="note ${tone}">${esc(text)}</div>`;
      if (applied) html += `<div class="row"><button class="link" id="reload">Reload the editor to see the changes</button></div>`;
    }
    if (s.canRevert && !state.running) html += `<div class="row"><button class="link" id="revert">Revert to the original</button></div>`;
    html += `<details id="actd"${state.actOpen ? ' open' : ''}><summary>Activity</summary>${activityHtml(s.activity)}</details>`;
    card.innerHTML = html;
    const go = root.getElementById('go'); if (go) go.onclick = () => optimize(false);
    const force = root.getElementById('force'); if (force) force.onclick = () => optimize(true);
    const rel = root.getElementById('reload'); if (rel) rel.onclick = () => location.reload();
    const rev = root.getElementById('revert'); if (rev) rev.onclick = revert;
    const d = root.getElementById('actd'); if (d) d.ontoggle = () => { state.actOpen = d.open; };
  }

  async function optimize(force) {
    if (state.running) return;
    state = { ...state, running: true, steps: [], result: null, error: null, errorKind: null };
    render();
    const r = await send({ type: MSG.MC_OPTIMIZE, webId: state.webId, campaignId: state.status?.campaign?.id, force });
    state.running = false;
    if (r?.ok) { state.result = r; state.steps.push({ step: 'done', label: 'Optimization complete' }); }
    else { state.error = r?.error || 'Optimization failed.'; state.errorKind = r?.kind || null; }
    await refresh();
  }

  async function revert() {
    const id = state.status?.campaign?.id;
    if (!id) return;
    const r = await send({ type: MSG.MC_REVERT, campaignId: id });
    state.result = null; state.steps = [];
    state.error = r?.ok ? null : (r?.error || 'Could not revert.');
    await refresh();
    if (r?.ok) { state.error = null; card.insertAdjacentHTML('afterbegin', '<div class="note ok" style="margin:0 0 10px;">Original restored. Reload the editor to see it.</div>'); }
  }

  pill.addEventListener('click', () => { state.open = !state.open; render(); if (state.open) refresh(); });
  $('hide').addEventListener('click', () => { state.hidden = true; render(); });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.AUTOPILOT_PROGRESS) {
      if (state.status?.campaign && msg.campaignId && msg.campaignId !== state.status.campaign.id) return;
      if (msg.step === 'error') state.steps.push({ step: 'error', label: msg.label });
      else if (msg.step !== 'reverted') { const last = state.steps.at(-1); if (!last || last.step !== msg.step) state.steps.push({ step: msg.step, label: msg.label }); else last.label = msg.label; }
      render();
    }
    if (msg.type === MSG.USAGE_UPDATED && state.status) { state.status.usage = msg.usage; }
  });

  // Mailchimp is a single-page app: follow the URL instead of reloading.
  function onLocation() {
    const w = webIdFromLocation();
    if (w === state.webId) return;
    state = { ...state, webId: w, status: null, steps: [], result: null, error: null, open: false };
    render();
    if (w) refresh();
  }
  (document.body || document.documentElement).appendChild(host);
  onLocation();
  setInterval(onLocation, 1000);
})();
