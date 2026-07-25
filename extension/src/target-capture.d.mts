export interface FrameOk { ok: true; dataUrl: string; width: number; height: number; }

export interface DesktopCaptureDeps {
  /** Show the source picker; resolves to a streamId, or '' if cancelled. */
  chooseStream: () => Promise<string>;
  /** Ensure the offscreen document exists. */
  ensureOffscreen: () => Promise<void>;
  /** Ask the offscreen document for one frame from the streamId. */
  requestFrame: (
    streamId: string,
  ) => Promise<{ ok: boolean; dataUrl?: string; width?: number; height?: number; error?: string } | undefined>;
}

export type DesktopCaptureResult =
  | FrameOk
  | { ok: false; error: 'cancelled' | 'timeout' | 'capture-failed' };

export function runDesktopCaptureFlow(
  deps: DesktopCaptureDeps,
  opts?: { timeoutMs?: number },
): Promise<DesktopCaptureResult>;
