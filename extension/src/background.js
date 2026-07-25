// ─── Persado Demo — Background Service Worker (minimal) ───────────
//
// Only job: relay element-capture messages from the content script
// to the popup, and persist captured elements across popup open/close
// cycles (since the popup closes when focus moves to the page for
// element picking).

console.log('[Persado Demo] Background worker started');

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'PERSADO_ELEMENT_CAPTURED' && msg.element) {
    // Store the captured element so the popup can pick it up
    // when it reopens (popup closes during element selection)
    chrome.storage.local.set({ 'persado:pendingCapture': msg.element });

    // Also try to notify the popup directly if it's still open
    chrome.runtime.sendMessage({
      type: 'PERSADO_ELEMENT_CAPTURED',
      element: msg.element,
    }).catch(() => {
      // Popup is closed — that's fine, it'll read from storage
    });
  }

  return false; // No async response needed
});
