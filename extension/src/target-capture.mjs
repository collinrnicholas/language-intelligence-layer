// Pure orchestration for desktop target capture — deliberately free of any
// chrome/DOM references so it is unit-testable. background.ts injects the real
// chrome-backed dependencies (picker, offscreen doc, frame request).

/**
 * @typedef {{ ok: true, dataUrl: string, width: number, height: number }} FrameOk
 * @typedef {{ ok: false, error: string }} FrameErr
 * @typedef {{
 *   chooseStream: () => Promise<string>,
 *   ensureOffscreen: () => Promise<void>,
 *   requestFrame: (streamId: string) => Promise<(FrameOk | FrameErr | undefined)>,
 * }} DesktopCaptureDeps
 */

/**
 * Run the desktop capture flow: pick a source, ensure the offscreen doc, request
 * one frame with a timeout. Never rejects — always resolves to a tagged result,
 * so the caller can surface a friendly message for every outcome.
 *
 * @param {DesktopCaptureDeps} deps
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<FrameOk | { ok: false, error: 'cancelled'|'timeout'|'capture-failed' }>}
 */
export async function runDesktopCaptureFlow(deps, opts = {}) {
  let streamId;
  try {
    streamId = await deps.chooseStream();
  } catch {
    return { ok: false, error: 'capture-failed' };
  }
  if (!streamId) return { ok: false, error: 'cancelled' };

  try {
    await deps.ensureOffscreen();
  } catch {
    return { ok: false, error: 'capture-failed' };
  }

  const timeoutMs = opts.timeoutMs ?? 15000;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs);
  });
  const frame = deps
    .requestFrame(streamId)
    .then((r) =>
      r && r.ok && r.dataUrl
        ? { ok: true, dataUrl: r.dataUrl, width: r.width ?? 0, height: r.height ?? 0 }
        : { ok: false, error: 'capture-failed' },
    )
    .catch(() => ({ ok: false, error: 'capture-failed' }));

  try {
    return await Promise.race([frame, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
