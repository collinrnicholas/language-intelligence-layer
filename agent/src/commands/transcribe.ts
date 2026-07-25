import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { LoupeSession, NoteEntry } from '../cli.js';
import { parseSessionInput } from '../schema.js';
import { transcribeViaGateway, pingGateway, gatewayUnreachableMessage, type TranscriptionResult } from '../llm/index.js';

// Whisper output for identical audio is stable enough to reuse: cache the
// segments by audio hash so re-analyzing the same capture never re-uploads
// multi-MB audio. Same opt-out as the LLM cache.
const TRANSCRIPT_CACHE_DIR = join(homedir(), '.loupe', 'cache', 'transcribe');

function transcriptCachePath(base64: string, mimeType: string): string {
  const key = createHash('sha256').update(`whisper-1:${mimeType}:${base64}`).digest('hex');
  return join(TRANSCRIPT_CACHE_DIR, `${key}.json`);
}

function readTranscriptCache(path: string): TranscriptionResult | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed?.text !== 'string') return null;
    return parsed as TranscriptionResult;
  } catch {
    return null;
  }
}

/**
 * Transcribe a session's embedded audio into timestamped transcript notes,
 * appended to `session.notes`. In-memory only (no file I/O), so both the
 * `transcribe` command and `analyze`'s auto-transcribe step can share it.
 * Returns the number of notes added. Throws if the gateway is unavailable —
 * the caller decides whether that's fatal.
 */
export async function transcribeIntoSession(session: LoupeSession): Promise<number> {
  if (!session.audioData) return 0;

  const match = session.audioData.match(/^data:audio\/(webm|mp4|ogg|wav);base64,(.+)$/);
  if (!match) throw new Error('Unrecognized audio format in audioData');

  const [, mimeType, base64] = match;

  const cacheEnabled = process.env.LOUPE_DISABLE_LLM_CACHE !== '1';
  const cachePath = transcriptCachePath(base64, mimeType);
  let result: TranscriptionResult | null = cacheEnabled ? readTranscriptCache(cachePath) : null;
  if (result) {
    console.log('  Transcription cache hit — audio not re-uploaded');
  } else {
    result = await transcribeViaGateway(base64, mimeType, {
      project: session.project,
      flow: session.flow,
    });
    if (cacheEnabled) {
      try {
        mkdirSync(TRANSCRIPT_CACHE_DIR, { recursive: true });
        writeFileSync(cachePath, JSON.stringify(result), 'utf-8');
      } catch { /* cache is best-effort */ }
    }
  }

  const before = session.notes.length;
  const segments = result.segments || [];
  if (segments.length === 0) {
    session.notes.push({
      type: 'transcript',
      timestamp: 0,
      text: result.text || '',
      source: 'audio',
      confidence: 1.0,
    } as NoteEntry);
  } else {
    for (const seg of segments) {
      session.notes.push({
        type: 'transcript',
        timestamp: seg.startMs,
        endTimestamp: seg.endMs,
        text: seg.text.trim(),
        source: 'audio',
      } as NoteEntry);
    }
  }
  return session.notes.length - before;
}

export async function transcribeSession(filePath: string) {
  const fullPath = resolve(filePath);
  if (!existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    return;
  }

  console.log(`Transcribing: ${fullPath}`);

  const raw = readFileSync(fullPath, 'utf-8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error('Invalid JSON');
    return;
  }

  const parsedSession = parseSessionInput(data);
  if (!parsedSession.ok || !parsedSession.value) {
    console.error('Invalid Loupe session:');
    for (const err of parsedSession.errors) console.error(`  - ${err}`);
    process.exitCode = 1;
    return;
  }
  const session: LoupeSession = parsedSession.value;
  if (!session.audioData) {
    console.error('No audio data embedded in this session. Record with mic enabled.');
    return;
  }

  console.log(`  Audio: ${(session.audioData.length / 1024).toFixed(1)}KB (base64)`);

  // Fail fast with an actionable message if the gateway is down, rather than
  // emitting a generic error mid-request.
  const ping = await pingGateway();
  if (!ping.reachable) {
    console.error(gatewayUnreachableMessage(ping.url, 'transcription'));
    process.exitCode = 1;
    return;
  }

  console.log('Transcribing via Loupe gateway...');

  let added: number;
  try {
    added = await transcribeIntoSession(session);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return;
  }
  console.log(`  ${added} transcript note(s) added`);

  // ─── Save enriched .loupe file ───────────────────────────────
  const backupPath = fullPath.replace(/\.loupe$/, '.pre-transcribe.loupe');
  writeFileSync(backupPath, raw);
  console.log(`  Backup: ${backupPath}`);

  writeFileSync(fullPath, JSON.stringify({ session }, null, 2));
  console.log(`✓ Session updated with ${session.notes.length} total notes`);

  // Print overview
  const transcriptNotes = session.notes.filter(n => n.type === 'transcript');
  if (transcriptNotes.length > 0) {
    console.log(`\nTranscript:`);
    for (const note of transcriptNotes) {
      const start = (note.timestamp / 1000).toFixed(0);
      const end = note.endTimestamp ? `-${(note.endTimestamp / 1000).toFixed(0)}s` : '';
      console.log(`  [${start}${end}] ${note.text.slice(0, 120)}`);
    }
  }
}
