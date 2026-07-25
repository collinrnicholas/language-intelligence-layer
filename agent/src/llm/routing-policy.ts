// ─── Task-based routing policy ───────────────────────────────────
//
// Loupe owns model routing internally; users choose INTENTS (Build This /
// UX Review / Complete Audit), never models. The policy maps each intent's
// task roles to a provider:model alias:
//
//   vision    — reads screenshots (and target designs) into structured
//               UIObservation JSON. GPT vision models by default.
//   reasoning — product reasoning, opportunity synthesis, implementation
//               briefs. Claude Sonnet by default: it reasons over the
//               STRUCTURED observations, not raw images.
//   judge     — the prompt critic / final quality gate. null = skip.
//   personas  — the 5-reviewer fanout. Complete Audit only.
//
// Override without code edits: ~/.loupe/config/routing-policy.json (same
// shape, deep-merged over the default). Per-stage overrides in routing.json
// still win over everything (debug escape hatch).

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type IntentName = 'buildThis' | 'uxReview' | 'completeAudit';
export type TaskRole = 'vision' | 'reasoning' | 'judge' | 'personas';

export interface IntentPolicy {
  vision: string;
  reasoning: string;
  judge: string | null;
  personas?: string;
}

export type RoutingPolicy = Record<IntentName, IntentPolicy>;

export const DEFAULT_POLICY: RoutingPolicy = {
  buildThis: {
    vision: 'openai:gpt-4.1',
    reasoning: 'anthropic:claude-sonnet',
    // The prompt critic is a standing quality gate on anything that ships a
    // build prompt — one lightweight pass (~2–3s) fits the 30–60s budget.
    // Set to null in routing-policy.json to trade the gate for speed.
    judge: 'openai:gpt-4.1',
  },
  uxReview: {
    vision: 'openai:gpt-4.1',
    reasoning: 'anthropic:claude-sonnet',
    judge: null,
  },
  completeAudit: {
    vision: 'openai:gpt-4.1',
    reasoning: 'anthropic:claude-sonnet',
    judge: 'openai:gpt-4.1',
    personas: 'anthropic:claude-sonnet',
  },
};

// provider:alias → concrete model id the gateway understands. Concrete ids
// pass through unchanged, so the policy file can pin exact versions too.
const MODEL_ALIASES: Record<string, string> = {
  'openai:gpt-4.1': 'gpt-4.1',
  'openai:gpt-4o': 'gpt-4o',
  'anthropic:claude-sonnet': 'claude-sonnet-4-6',
  'anthropic:claude-haiku': 'claude-haiku-4-5',
};

/** Vision fallback when the primary vision provider fails (quota, outage). */
export const VISION_FALLBACK_MODEL = 'claude-sonnet-4-6';
/** Reasoning fallback when the primary reasoning provider fails. */
export const REASONING_FALLBACK_MODEL = 'gpt-4.1';

const POLICY_PATH = join(homedir(), '.loupe', 'config', 'routing-policy.json');

let cached: RoutingPolicy | undefined;

export function loadRoutingPolicy(): RoutingPolicy {
  if (cached) return cached;
  let overrides: Partial<Record<IntentName, Partial<IntentPolicy>>> = {};
  try {
    if (existsSync(POLICY_PATH)) {
      overrides = JSON.parse(readFileSync(POLICY_PATH, 'utf-8'));
    }
  } catch { /* malformed policy must never break a run */ }

  cached = {
    buildThis: { ...DEFAULT_POLICY.buildThis, ...overrides.buildThis },
    uxReview: { ...DEFAULT_POLICY.uxReview, ...overrides.uxReview },
    completeAudit: { ...DEFAULT_POLICY.completeAudit, ...overrides.completeAudit },
  };
  return cached;
}

/** Test seam: clear the memoized policy (e.g. after writing a temp override). */
export function resetRoutingPolicyCache(): void {
  cached = undefined;
}

/** Concrete model id for an intent + role, or null when the role is disabled. */
export function resolveModel(intent: IntentName, role: TaskRole): string | null {
  const policy = loadRoutingPolicy()[intent];
  const alias = role === 'personas' ? (policy.personas ?? null) : policy[role];
  if (alias === null || alias === undefined) return null;
  return MODEL_ALIASES[alias] ?? alias;
}

// ─── Intent pipelines ────────────────────────────────────────────
//
// The single source of truth for which stages each intent runs. Commands gate
// on this — tests assert on it — so "Build This never fans out to persona
// reviewers" is a checked property, not a comment.

export type PipelineStage =
  | 'deterministic'
  | 'drift'
  | 'vision-observe'
  | 'synthesize-opportunities'
  | 'persona-review'
  | 'narration-judge'
  | 'target-generation'
  | 'synthesize-build-brief'
  | 'critic';

export const INTENT_PIPELINES: Record<IntentName, readonly PipelineStage[]> = {
  buildThis: ['deterministic', 'vision-observe', 'synthesize-build-brief'],
  uxReview: [
    'deterministic', 'drift', 'vision-observe', 'synthesize-opportunities',
    'narration-judge', 'target-generation',
  ],
  completeAudit: [
    'deterministic', 'drift', 'vision-observe', 'persona-review',
    'narration-judge', 'target-generation', 'critic',
  ],
};

export function pipelineForIntent(intent: IntentName): readonly PipelineStage[] {
  return INTENT_PIPELINES[intent];
}

export function intentRuns(intent: IntentName, stage: PipelineStage): boolean {
  return INTENT_PIPELINES[intent].includes(stage);
}
