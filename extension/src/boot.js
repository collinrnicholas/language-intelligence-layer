// ─── Language Intelligence Layer — panel boot guard ──────────────────────────
//
// Loaded as a CLASSIC script BEFORE sidepanel.js (a module). That ordering is the
// whole point: a top-level throw while a module evaluates silently prevents every
// listener registered after it from binding, so the panel renders normally and
// the buttons simply do nothing. Registering these handlers first means such a
// failure paints a visible banner instead. A broken panel must LOOK broken.

(function () {
  let shown = false;

  function show(detail) {
    const banner = document.getElementById('fatalBanner');
    const text = String((detail && detail.stack) || detail || 'Unknown error');
    if (!banner) { console.error('[persado] fatal (no banner element):', text); return; }
    // Keep the FIRST error — later ones are usually knock-on effects of it.
    if (!shown) {
      const msg = document.getElementById('fatalMsg');
      if (msg) msg.textContent = text;
      shown = true;
    }
    banner.style.display = 'block';
    console.error('[persado] fatal:', text);
  }

  self.__persadoFatal = show;
  self.addEventListener('error', (e) => show(e.error || e.message));
  self.addEventListener('unhandledrejection', (e) => show(e.reason));

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('fatalReload');
    if (btn) btn.addEventListener('click', () => location.reload());
  });
})();
