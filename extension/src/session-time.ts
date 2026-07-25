let recordingStartMs = 0;

export function startSessionClock(nowMs = Date.now()): void {
  recordingStartMs = nowMs;
}

export function resetSessionClock(): void {
  recordingStartMs = 0;
}

export function sessionNowMs(nowMs = Date.now()): number {
  if (!recordingStartMs) return 0;
  return Math.max(0, Math.round(nowMs - recordingStartMs));
}

export function sessionNowMsFrom(startMs: number, nowMs = Date.now()): number {
  return Math.max(0, Math.round(nowMs - startMs));
}
