// Throwaway diagnostic: print the stage-1 narrated-evidence block the AI reviewers
// would receive for the most recent recording. Read-only — touches nothing.
//
//   node agent/scripts/dump-evidence.mjs
//
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { parseSessionInput } from '../dist/schema.js';
import { buildNarratedEvidence, buildChunkEvidence } from '../dist/ai/review.js';

const f = execSync('ls -t ~/Downloads/loupe/*.loupe ~/Downloads/loupe/*.json 2>/dev/null | head -1')
  .toString().trim();
if (!f) { console.error('No session file in ~/Downloads/loupe/'); process.exit(1); }

const parsed = parseSessionInput(JSON.parse(readFileSync(f, 'utf-8')));
if (!parsed.ok || !parsed.value) {
  console.error('Parse failed:', parsed.errors);
  process.exit(1);
}
const session = parsed.value;
const transcript = session.notes.filter((n) => n.type === 'transcript');

console.error(`# file: ${f}`);
console.error(`# transcript notes: ${transcript.length} | events: ${session.events.length} | screenshots: ${session.screenshots.length}`);
console.error('');

if (transcript.length > 0) {
  // Highlight the "hard to distinguish" moment (~11s) if present.
  const target = transcript.find((n) => /distinguish|left rail|right rail|centerpiece|sections/i.test(n.text));
  if (target) {
    console.error(`===== TARGET CHUNK (~${(target.timestamp / 1000).toFixed(1)}s) =====`);
    console.log(buildChunkEvidence(session, target));
    console.log('');
  }
  console.error('===== ALL CHUNKS (buildNarratedEvidence) =====');
  console.log(buildNarratedEvidence(session));
} else {
  // No transcript notes (recording not transcribed). Inject a clearly-labeled
  // SYNTHETIC narration note at ~11s so we can see the region evidence the model
  // would receive. Only the narration TEXT is placeholder; all UI evidence is real.
  console.error('===== NO TRANSCRIPT NOTES — using a SYNTHETIC narration note at ~11.3s =====');
  console.error('===== (evidence below is REAL from this recording; only the quoted text is placeholder) =====');
  const syntheticNote = {
    type: 'transcript',
    timestamp: 11300,
    endTimestamp: 16700,
    text: '[SYNTHETIC PLACEHOLDER — run `loupe transcribe` for real text] within the header, the left rail, right rail and centerpiece, it is very hard to distinguish the sections',
  };
  console.log(buildChunkEvidence(session, syntheticNote));
}
