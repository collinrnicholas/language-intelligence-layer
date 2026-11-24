// Read-only Mailchimp context pill. Paid actions and all writes require the
// extension panel. No browser credential access; no campaign content logging.
(function () {
  if (self.__persadoMcOverlay || !self.PERSADO) return;
  self.__persadoMcOverlay = true;
  const { MSG } = self.PERSADO;
  const host = document.createElement('div');
  host.setAttribute('data-persado-overlay', '');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host{all:initial} .pill{position:fixed;bottom:16px;left:16px;z-index:2147483000;background:#fff;color:#1A1128;border:1px solid #ECEAF0;border-radius:10px;padding:12px;font:13px/1.5 Inter,system-ui,sans-serif;max-width:280px;box-shadow:0 2px 8px #0001}
    b{color:#DC2828} p{margin:4px 0 0} button{min-width:44px;min-height:44px;border:0;background:#fff;color:#5C506C;cursor:pointer;float:right} button:focus-visible{outline:2px solid #1A1128} [hidden]{display:none}
    </style><div class="pill" hidden><button aria-label="Hide Persado">×</button><strong><b>[</b> Persado <b>]</b></strong><p role="status">Checking campaign…</p><p>Open the Persado side panel from the Chrome toolbar to score and review copy.</p></div>`;
  const pill = root.querySelector('.pill'), status = root.querySelector('[role=status]');
  let lastUrl = '', epoch = 0, hidden = false;
  root.querySelector('button').onclick = () => { hidden = true; pill.hidden = true; };
  document.documentElement.appendChild(host);
  async function check() {
    if (lastUrl === location.href) return;
    lastUrl = location.href; const current = ++epoch; hidden = false;
    const u = new URL(location.href), id = u.searchParams.get('id');
    const webId = /\/campaigns\//.test(u.pathname) && /^\d+$/.test(id || '') ? Number(id) : null;
    pill.hidden = !webId;
    if (!webId) return;
    status.textContent = 'Checking campaign…';
    try {
      const r = await chrome.runtime.sendMessage({ type: MSG.MC_STATUS, webId });
      if (current !== epoch || hidden) return;
      status.textContent = r?.campaign ? 'Draft identified. Detection uses no credits.' : r?.error || 'Connect Mailchimp in Persado Settings.';
    } catch { status.textContent = 'Reload this page after reloading the extension.'; }
  }
  // Covers pushState, replaceState, back/forward and delayed SPA rendering,
  // without patching Mailchimp's page scripts or repeatedly calling providers.
  setInterval(check, 700);
  check();
})();
