// ─── Persado Demo — Content Script (minimal) ─────────────────────
//
// Only job: relay element-capture messages from the injected picker
// back to the extension background worker. No recording, no DOM
// snapshots, no click tracking.

console.log('[Persado Demo] Content script loaded');

// Listen for messages from the injected element picker (runs in page
// main world via scripting.executeScript).
window.addEventListener('message', (event) => {
  // Only accept messages from our own picker
  if (event.source !== window) return;
  if (!event.data || event.data.source !== 'persado-picker') return;

  if (event.data.type === 'PERSADO_ELEMENT_CAPTURED') {
    chrome.runtime.sendMessage({
      type: 'PERSADO_ELEMENT_CAPTURED',
      element: event.data.element,
    });
  }
});
