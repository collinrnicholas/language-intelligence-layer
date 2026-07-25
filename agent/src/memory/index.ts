// ─── Project memory — public API ─────────────────────────────────
// docs/SESSION_MEMORY_SPIKE.md (approved). Local-first, derived from runs/,
// injected into prompts ONLY via the digest (Build This + Redesign in v1).

export {
  recordAnalyzeRun, recordBuilt, recordFastBuild, markOpportunity, addPreference,
  rebuildFromRuns, resetMemory,
  loadManifest, loadSessions, loadOpportunityEvents, loadPreferences,
  memoryDir, digestPath, MEMORY_SCHEMA_VERSION,
} from './store.js';
export type {
  ProjectMemoryManifest, SessionIndexEntry, OpportunityMemoryEntry,
  OpportunityEvent, PreferenceEntry, PreferenceStrength,
} from './store.js';
export { findingSignature, signaturesLikelySame } from './signature.js';
export {
  generateDigest, memoryPromptBlock, redact, effectiveStrength, derivePatterns,
} from './digest.js';
export type { DigestSection, DerivedPattern } from './digest.js';
