import test from 'node:test';
import assert from 'node:assert/strict';
import { runDesktopCaptureFlow } from '../src/target-capture.mjs';

// Deps that always succeed unless overridden.
function deps(over = {}) {
  return {
    chooseStream: async () => 'stream-1',
    ensureOffscreen: async () => {},
    requestFrame: async () => ({ ok: true, dataUrl: 'data:image/jpeg;base64,AAA', width: 800, height: 600 }),
    ...over,
  };
}

test('success returns the frame with dimensions', async () => {
  const r = await runDesktopCaptureFlow(deps());
  assert.deepEqual(r, { ok: true, dataUrl: 'data:image/jpeg;base64,AAA', width: 800, height: 600 });
});

test('cancelled picker short-circuits before requesting a frame', async () => {
  let requested = false;
  const r = await runDesktopCaptureFlow(deps({
    chooseStream: async () => '',
    requestFrame: async () => { requested = true; return { ok: true, dataUrl: 'x' }; },
  }));
  assert.deepEqual(r, { ok: false, error: 'cancelled' });
  assert.equal(requested, false, 'must not request a frame after cancel');
});

test('a failed frame maps to capture-failed', async () => {
  const r = await runDesktopCaptureFlow(deps({ requestFrame: async () => ({ ok: false, error: 'no-2d-context' }) }));
  assert.deepEqual(r, { ok: false, error: 'capture-failed' });
});

test('a thrown frame request maps to capture-failed (never rejects)', async () => {
  const r = await runDesktopCaptureFlow(deps({ requestFrame: async () => { throw new Error('boom'); } }));
  assert.deepEqual(r, { ok: false, error: 'capture-failed' });
});

test('a hung frame request times out instead of stalling forever', async () => {
  const r = await runDesktopCaptureFlow(
    deps({ requestFrame: () => new Promise(() => {}) }), // never resolves
    { timeoutMs: 30 },
  );
  assert.deepEqual(r, { ok: false, error: 'timeout' });
});

test('missing dimensions default to 0', async () => {
  const r = await runDesktopCaptureFlow(deps({ requestFrame: async () => ({ ok: true, dataUrl: 'd' }) }));
  assert.deepEqual(r, { ok: true, dataUrl: 'd', width: 0, height: 0 });
});
