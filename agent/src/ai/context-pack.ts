// Shared per-session context pack.
//
// Five pipeline stages (session understanding, target generation, product
// reasoning, narration judge, content enumeration) each rebuilt the same
// sorted-transcript views from session.notes. This module computes them once
// per notes array and memoizes, so every stage reuses one construction — and,
// because the rendered text is byte-identical across stages, the LLM cache keys
// stay stable too.
//
// Memoized by the session.notes ARRAY (not the session object): transcript
// stitching replaces session.notes with a new array, which correctly
// invalidates the pack while pre-stitch consumers (none today) stay isolated.

import type { LoupeSession, NoteEntry } from '../cli.js';

export interface ContextPack {
  /** Transcript notes sorted by timestamp. */
  transcriptNotes: NoteEntry[];
  /** Transcript notes with their original index into session.notes (for the
   *  narration judge, whose verdicts reference note indices). */
  indexedTranscript: Array<{ note: NoteEntry; index: number }>;
  /** Canonical timestamped block: `[12–15s] "text"` per line. Used verbatim by
   *  session understanding, target generation, and product reasoning. */
  transcriptBlock: string;
}

const packs = new WeakMap<NoteEntry[], ContextPack>();

export function contextPack(session: LoupeSession): ContextPack {
  const cached = packs.get(session.notes);
  if (cached) return cached;

  const indexedTranscript = session.notes
    .map((note, index) => ({ note, index }))
    .filter(x => x.note.type === 'transcript')
    .sort((a, b) => a.note.timestamp - b.note.timestamp);

  const transcriptNotes = indexedTranscript.map(x => x.note);

  const transcriptBlock = transcriptNotes
    .map(n => {
      const startS = (n.timestamp / 1000).toFixed(0);
      const endS = n.endTimestamp ? `–${(n.endTimestamp / 1000).toFixed(0)}` : '';
      return `[${startS}${endS}s] "${n.text.trim()}"`;
    })
    .join('\n');

  const pack: ContextPack = { transcriptNotes, indexedTranscript, transcriptBlock };
  packs.set(session.notes, pack);
  return pack;
}
