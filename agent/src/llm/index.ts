// ─── LLM — Public API ────────────────────────────────────────────
//
// Loupe is a SaaS client: all AI runs through the Loupe gateway. There is no
// provider-key configuration on the client.
//
// Usage:
//   import { callLLM } from './llm/index.js';
//   const result = await callLLM('redesign', prompt, { severity: 'High' });
//
// Configuration (see client-config.ts): ~/.loupe/config/client.json, or for local
// dev the LOUPE_API_URL / LOUPE_DEV_TOKEN env vars.

export { callLLM, getCallTimings, resetCallTimings, timingsSummary } from './tasks/call.js';
export type { CallTiming } from './tasks/call.js';
export { route, getProvider } from './router.js';
export {
  loupeGatewayProvider,
  transcribeViaGateway,
  pingGateway,
  gatewayUnreachableMessage,
  GATEWAY_UNAVAILABLE,
  PROMPT_VERSION,
} from './providers/loupe-gateway.js';
export type { TranscriptionResult, TranscriptSegment } from './providers/loupe-gateway.js';
export { loadClientConfig } from './client-config.js';
export type { LoupeClientConfig } from './client-config.js';
export type {
  TaskRequest,
  RoutingDecision,
  ProviderName,
  TaskName,
  ProviderAdapter,
  GatewayMeta,
} from './types.js';
