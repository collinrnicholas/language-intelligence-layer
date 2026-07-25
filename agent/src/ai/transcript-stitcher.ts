// Stitch ASR transcript fragments into complete sentences.
//
// ASR splits audio on silence/pauses — often mid-sentence — producing fragment
// quotes like "the screen and isn't fully visible" that appear verbatim in
// build prompt quotes, confusing coding agents. One cheap LLM call post-
// transcription merges adjacent fragments into complete sentences while
// preserving start/end timestamps from the original segments.

import type { LoupeSession, NoteEntry } from '../cli.js';
import { callLLM } from '../llm/index.js';

interface StitchedSegment {
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * Merge adjacent ASR fragment notes into complete sentences. Modifies
 * session.notes in place. Returns the new transcript note count.
 * On any failure, session.notes is unchanged and the original count is returned.
 */
export async function stitchTranscriptFragments(session: LoupeSession): Promise<number> {
  const transcriptNotes = session.notes
    .filter(n => n.type === 'transcript')
    .sort((a, b) => a.timestamp - b.timestamp);

  if (transcriptNotes.length < 2) return transcriptNotes.length;

  const segments = transcriptNotes
    .map(n => {
      const startS = (n.timestamp / 1000).toFixed(1);
      const endS = n.endTimestamp !== undefined ? (n.endTimestamp / 1000).toFixed(1) : startS;
      return `[${startS}s–${endS}s] "${n.text.trim()}"`;
    })
    .join('\n');

  const prompt = [
    'These are ASR transcript segments from a screen recording narration. ASR splits audio on',
    'natural speech pauses, which often fall mid-sentence — producing fragments that cut off at a',
    'clause boundary or conjunction ("the screen and isn\'t fully visible").',
    '',
    'Merge adjacent fragments into grammatically complete sentences. Rules:',
    '- Merge adjacent fragments that are obviously part of the same sentence.',
    '  A new sentence starts after a period/question-mark or a clear change of topic.',
    '  A conjunction (and, but, so, because), comma, or dependent clause is NOT a sentence boundary.',
    '- When merging, set startMs = earliest segment\'s startMs, endMs = latest segment\'s endMs.',
    '- Do NOT change the speaker\'s words. Preserve the exact wording.',
    '- Do NOT merge fragments that are clearly separate statements about different topics.',
    '',
    'INPUT SEGMENTS:',
    segments,
    '',
    'Respond with ONLY a JSON array. One object per resulting sentence:',
    '[{"text": "complete sentence here", "startMs": 0, "endMs": 5400}]',
    'No other text. No markdown fences.',
  ].join('\n');

  let raw: string;
  try {
    raw = await callLLM('explain', prompt, {
      severity: 'Low',
      maxTokens: 1500,
      stage: 'transcript-stitch',
      promptVersion: 'transcript-stitch-v1',
    });
  } catch {
    return transcriptNotes.length;
  }

  let stitched: StitchedSegment[];
  try {
    const json = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const arr = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length === 0) return transcriptNotes.length;
    stitched = (arr as unknown[])
      .filter((s): s is { text: string; startMs: number; endMs: number } =>
        typeof (s as any)?.text === 'string' &&
        typeof (s as any)?.startMs === 'number' &&
        typeof (s as any)?.endMs === 'number')
      .map(s => ({ text: String(s.text).trim(), startMs: Number(s.startMs), endMs: Number(s.endMs) }))
      .filter(s => s.text.length > 0);
    if (stitched.length === 0) return transcriptNotes.length;
  } catch {
    return transcriptNotes.length;
  }

  const nonTranscriptNotes = session.notes.filter(n => n.type !== 'transcript');
  const newNotes: NoteEntry[] = stitched.map(s => ({
    type: 'transcript' as const,
    timestamp: s.startMs,
    endTimestamp: s.endMs,
    text: s.text,
    source: 'audio',
  }));
  session.notes = [...nonTranscriptNotes, ...newNotes];
  return newNotes.length;
}
