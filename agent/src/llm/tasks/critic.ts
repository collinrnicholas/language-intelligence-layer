// ─── Critic task (policy-gated judge) ────────────────────────────
//
// Thin task wrapper around the implementation-brief critic: the routing
// policy decides whether an intent runs a judge at all (buildThis/uxReview
// default to none; completeAudit judges). The critic implementation itself
// (section-rewrite guards, scoring) is unchanged — see ai/prompt-critic.ts.

import { critiqueImplementationBrief, type PromptCriticResult } from '../../ai/prompt-critic.js';
import { resolveModel, type IntentName } from '../routing-policy.js';

/**
 * Run the critic for an intent, or skip (null) when the policy disables it.
 * Never throws — a failed judge returns null and the brief ships as-is.
 */
export async function runCritic(
  intent: IntentName,
  briefMarkdown: string,
  meta: { project?: string; flow?: string; target?: string; goal?: string } = {},
): Promise<PromptCriticResult | null> {
  const judgeModel = resolveModel(intent, 'judge');
  if (!judgeModel) return null; // policy: this intent ships without a judge pass
  return critiqueImplementationBrief(briefMarkdown, meta, { model: judgeModel });
}
