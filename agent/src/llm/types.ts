// ─── LLM Router Types ────────────────────────────────────────────
//
// Loupe is a SaaS client. It talks ONLY to the Loupe AI gateway; model providers
// (OpenAI/Anthropic/Google/…) live behind the gateway and are never selected or
// authenticated here. No provider API keys are read on the client.

export type TaskName = 'transcribe' | 'explain' | 'redesign' | 'build' | 'judge';

export type ProviderName = 'loupe-gateway';

export type ModelTier = 'fast' | 'standard' | 'premium';

export interface TaskRequest {
  task: TaskName;
  requiresVision: boolean;
  requiresLongContext: boolean;
  requiresStructuredOutput: boolean;
  severity?: 'Critical' | 'High' | 'Medium' | 'Low' | 'Info';
  confidence?: number;
  privacy: 'local-first' | 'cloud-ok';
  budget: 'minimal' | 'standard' | 'premium';
  contextSize?: 'small' | 'medium' | 'large';
}

export interface RoutingDecision {
  provider: ProviderName;
  model: string;   // a model *preference* hint; the gateway makes the final choice
  tier: ModelTier;
  reason: string;
}

/** Optional metadata forwarded to the gateway alongside the prompt. */
export interface GatewayMeta {
  project?: string;
  flow?: string;
  targetDesignRef?: string;
}

export interface ChatOptions {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json';
  task?: TaskName;
  modelPreference?: string;
  promptVersion?: string;
  meta?: GatewayMeta;
  images?: string[];
}

export interface ProviderAdapter {
  name: ProviderName;
  chat(prompt: string, options?: ChatOptions): Promise<string>;
}
