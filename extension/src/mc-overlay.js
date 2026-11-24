// Quiet Mailchimp change observer. No overlays, content reads, or paid actions.
// The side panel re-reads saved campaign data after debouncing these hints.
(function () {
  if (self.__persadoMcOverlay || !self.PERSADO) return;
  self.__persadoMcOverlay = true;
  const { MSG } = self.PERSADO;
  let timer = null, lastUrl = location.href;
  const notify = () => {
    if (!/\/campaigns\//i.test(location.pathname) || document.hidden) return;
    chrome.runtime.sendMessage({ type: MSG.MC_CONTEXT_CHANGED }).catch(() => {});
  };
  const changed = () => { clearTimeout(timer); timer = setTimeout(notify, 1000); };
  document.addEventListener('input', changed, true);
  document.addEventListener('change', changed, true);
  document.addEventListener('click', event => {
    // Captures Save/Done actions without depending on Mailchimp's CSS classes.
    if (event.target.closest?.('button,[role="button"]')) changed();
  }, true);
  window.addEventListener('popstate', changed);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) changed(); });
  setInterval(() => {
    if (lastUrl !== location.href) { lastUrl = location.href; changed(); }
  }, 1000);
})();
