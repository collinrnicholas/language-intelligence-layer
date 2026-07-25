// This offscreen document exists solely for DESKTOP-frame capture (a target
// design in another app/screen). Mic capture lives in the content script
// (src/content.ts) and does NOT use this document.

const MAX_LONG_EDGE = 2560; // cap so a 4K/5K grab doesn't bloat the .loupe

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    // Grab ONE frame from a desktopCapture streamId (the user picked a screen or
    // window in the background via chrome.desktopCapture) and return it as a JPEG
    // data URL. This is how a target design in a SEPARATE app (Figma desktop,
    // Safari, any window/screen) becomes the session's target: getUserMedia needs
    // a DOM context, which the service worker lacks but this offscreen doc has.
    case 'CAPTURE_DESKTOP_FRAME': {
      captureDesktopFrame(msg.streamId as string)
        .then((frame) => sendResponse({ ok: true, ...frame }))
        .catch((err: Error) => {
          console.error('[Loupe Offscreen] Desktop capture error:', err.message);
          sendResponse({ ok: false, error: err.message });
        });
      return true; // async response
    }
  }
});

interface DesktopFrame { dataUrl: string; width: number; height: number; }

async function captureDesktopFrame(streamId: string): Promise<DesktopFrame> {
  if (!streamId) throw new Error('no-stream');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    // chromeMediaSource constraints are non-standard and absent from the typings.
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } },
  } as unknown as MediaStreamConstraints);
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // One rAF lets the first frame paint so videoWidth/Height are populated.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    // Downscale on draw so a 4K/5K grab never becomes a multi-MB base64 blob.
    const scale = Math.min(1, MAX_LONG_EDGE / Math.max(vw, vh));
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no-2d-context');
    ctx.drawImage(video, 0, 0, w, h);
    video.pause();
    video.srcObject = null;
    // Screen/window grabs often carry solid letterboxing or desktop background
    // around the actual content — trim it so the vision compare isn't diluted.
    const cropped = autoCropUniformBorders(canvas);
    return { dataUrl: cropped.toDataURL('image/jpeg', 0.85), width: cropped.width, height: cropped.height };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/**
 * Trim uniform (single-color) borders — letterboxing, solid desktop background,
 * or window matting — so the captured target is mostly content. Deterministic
 * and conservative: it refuses to crop if that would remove too much (guards
 * against nuking an intentionally flat design), returning the original instead.
 */
function autoCropUniformBorders(source: HTMLCanvasElement): HTMLCanvasElement {
  const W = source.width, H = source.height;
  if (W < 80 || H < 80) return source;
  const ctx = source.getContext('2d');
  if (!ctx) return source;
  const data = ctx.getImageData(0, 0, W, H).data;
  const at = (x: number, y: number) => (y * W + x) * 4;
  const TOL = 14; // per-channel tolerance absorbs JPEG/scaling noise
  const [r0, g0, b0] = [data[0], data[1], data[2]]; // top-left = border reference
  const near = (i: number) =>
    Math.abs(data[i] - r0) <= TOL && Math.abs(data[i + 1] - g0) <= TOL && Math.abs(data[i + 2] - b0) <= TOL;
  const rowUniform = (y: number) => { for (let x = 0; x < W; x++) if (!near(at(x, y))) return false; return true; };
  const colUniform = (x: number) => { for (let y = 0; y < H; y++) if (!near(at(x, y))) return false; return true; };

  let top = 0; while (top < H - 1 && rowUniform(top)) top++;
  let bottom = H - 1; while (bottom > top && rowUniform(bottom)) bottom--;
  let left = 0; while (left < W - 1 && colUniform(left)) left++;
  let right = W - 1; while (right > left && colUniform(right)) right--;

  const cw = right - left + 1, ch = bottom - top + 1;
  // Nothing trimmed, or trimming would be too aggressive → keep the original.
  if (cw === W && ch === H) return source;
  if (cw < W * 0.3 || ch < H * 0.3 || cw < 200 || ch < 200) return source;

  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  out.getContext('2d')?.drawImage(source, left, top, cw, ch, 0, 0, cw, ch);
  return out;
}
