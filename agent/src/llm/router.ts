import type { TaskRequest, RoutingDecision, ProviderAdapter, TaskName, ModelTier } from './types.js';
import { loupeGatewayProvider } from './providers/loupe-gateway.js';

// ─── Routing ─────────────────────────────────────────────────────
//
// Every task routes to the Loupe gateway. The gateway owns provider credentials
// and selects the concrete model; the client only sends a tier/model *preference*
// as a hint, plus signals (severity/confidence) that justify an upgrade.

const MODEL_PREFERENCE: Record<TaskName, { model: string; tier: ModelTier }> = {
  transcribe: { model: 'speech', tier: 'fast' },
  explain: { model: 'standard', tier: 'standard' },
  redesign: { model: 'premium', tier: 'premium' },
  build: { model: 'premium', tier: 'premium' },
  judge: { model: 'fast', tier: 'fast' },
};

export function route(request: TaskRequest): RoutingDecision {
  const pref = MODEL_PREFERENCE[request.task] ?? { model: 'standard', tier: 'standard' as ModelTier };

  // Upgrade to the premium model for high-stakes or low-confidence work — and
  // for any call carrying images, which needs a vision-capable model.
  //
  // The upgrade is folded into `model` because that is the ONLY routing signal
  // the gateway receives (the wire payload carries `model`, not `tier`). It
  // previously set only `tier`, which was computed and then dropped — severity
  // and confidence had no effect on routing at all. Call sites now use these
  // as declarative quality levers: `severity: 'High'` routes an explain-task
  // call to the premium model (e.g. session understanding, critical-finding
  // explanations).
  const upgrade =
    request.requiresVision ||
    request.severity === 'Critical' ||
    request.severity === 'High' ||
    (request.confidence !== undefined && request.confidence < 0.7) ||
    request.contextSize === 'large';

  const model = upgrade ? 'premium' : pref.model;
  const tier: ModelTier = model === 'premium' ? 'premium' : pref.tier;

  return {
    provider: 'loupe-gateway',
    model,
    tier,
    reason: `Loupe gateway · ${request.task}${request.requiresVision ? ' (vision)' : upgrade ? ' (upgraded)' : ''}`,
  };
}

export function getProvider(_decision: RoutingDecision): ProviderAdapter {
  return loupeGatewayProvider;
}
