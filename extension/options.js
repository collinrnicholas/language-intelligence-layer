// ─── Persado Capture — options page ──────────────────────────────
//
// One administrator-facing setting: the screen-capture toggle. Persisted to
// chrome.storage.local under KEYS.CAPTURE_SCREENSHOTS. Absent → the config default
// (PERSADO_CONFIG.CAPTURE_SCREENSHOTS, off). Takes effect on the NEXT recording;
// the panel and worker both read the stored value at recording start, so no
// extension reload is needed.
//
// This is the demo/developer affordance — production would lock it via Chrome
// enterprise policy. There is deliberately NO capture control in the side panel.

const { KEYS } = self.PERSADO;
const DEFAULT = self.PERSADO_CONFIG.CAPTURE_SCREENSHOTS;

const toggle = document.getElementById('captureToggle');
const stateWord = document.getElementById('stateWord');
const savedNote = document.getElementById('savedNote');
let savedTimer = null;

function render(on) {
  toggle.checked = on;
  stateWord.textContent = on ? 'on' : 'off';
}

async function load() {
  let on = DEFAULT;
  try {
    const v = (await chrome.storage.local.get(KEYS.CAPTURE_SCREENSHOTS))[KEYS.CAPTURE_SCREENSHOTS];
    if (typeof v === 'boolean') on = v;
  } catch (e) { console.warn('[persado] could not read capture setting', e); }
  render(on);
}

toggle.addEventListener('change', async () => {
  const on = toggle.checked;
  try {
    await chrome.storage.local.set({ [KEYS.CAPTURE_SCREENSHOTS]: on });
    render(on);
    savedNote.textContent = 'Saved — applies to the next recording.';
    savedNote.className = 'saved';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { savedNote.textContent = ''; savedNote.className = ''; }, 3000);
  } catch (e) {
    console.warn('[persado] could not save capture setting', e);
    savedNote.textContent = 'Could not save.';
    render(!on);   // revert the visual to the actual state
  }
});

// Reflect changes made elsewhere (another options tab) live.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[KEYS.CAPTURE_SCREENSHOTS]) {
    render(!!changes[KEYS.CAPTURE_SCREENSHOTS].newValue);
  }
});

load();
