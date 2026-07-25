import { route, getProvider } from '../router.js';
import { gatewayModelMap } from '../providers/loupe-gateway.js';
import type { TaskRequest, ChatOptions, GatewayMeta } from '../types.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const CACHE_SCHEMA_VERSION = 1;
const CACHE_DIR = join(homedir(), '.loupe', 'cache', 'llm');

// Transient gateway failures (rate limits, momentary 5xx) surface as instant
// errors or empty content. One short-backoff retry recovers them; without it a
// whole stage silently degrades (e.g. narrated findings shipping with no
// generated targets because one batch call failed in 200ms).
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 500;

// Routing/timing console lines are developer instrumentation — hidden unless
// requested, so model names don't leak into normal user-facing CLI output.
const LLM_DEBUG = process.env.LOUPE_DEBUG_LLM === '1';

// ─── Per-stage routing overrides + cost rates ────────────────────
//
// ~/.loupe/config/routing.json lets model routing change without code edits:
//   {
//     "stages": { "prompt-critic": "claude-sonnet-4-6", "transcript-stitch": "standard" },
//     "rates":  { "premium": {"in": 2.5, "out": 10}, "claude-sonnet-4-6": {"in": 3, "out": 15} }
//   }
// stages: stage label (exact, or prefix before ':' e.g. "persona-review") →
//   model preference forwarded to the gateway. Full model ids only take effect
//   when the gateway allowlists them (LOUPE_MODEL_ALLOWED) — otherwise the
//   gateway falls back to its tier mapping, so a stale entry can't break runs.
// rates: USD per 1M tokens for the cost estimate in timing logs.

interface RoutingConfig {
  stages?: Record<string, string>;
  rates?: Record<string, { in: number; out: number }>;
}

const ROUTING_CONFIG_PATH = join(homedir(), '.loupe', 'config', 'routing.json');
const DEFAULT_RATES: Record<string, { in: number; out: number }> = {
  // gpt-4o legacy / gpt-4o-mini rates; override in routing.json when models change.
  premium: { in: 2.5, out: 10 },
  standard: { in: 0.15, out: 0.6 },
  fast: { in: 0.15, out: 0.6 },
};

let routingConfig: RoutingConfig | null | undefined;

function loadRoutingConfig(): RoutingConfig | null {
  if (routingConfig !== undefined) return routingConfig;
  try {
    routingConfig = existsSync(ROUTING_CONFIG_PATH)
      ? (JSON.parse(readFileSync(ROUTING_CONFIG_PATH, 'utf-8')) as RoutingConfig)
      : null;
  } catch {
    routingConfig = null; // malformed config must never break a run
  }
  return routingConfig;
}

/** Model-preference override for a stage, or null. Matches the exact stage
 *  label first, then its prefix before ':' ("persona-review:PM:…" → "persona-review"). */
function stageModelOverride(stage: string): string | null {
  const stages = loadRoutingConfig()?.stages;
  if (!stages) return null;
  return stages[stage] ?? stages[stage.split(':')[0]] ?? null;
}

/** Rough USD cost for a call. Token estimates exclude image tokens, so
 *  vision-call costs are underestimates — the log says ≈ for a reason. */
function estimateCostUSD(model: string, inputTokens: number, outputTokens: number): number {
  const rates = { ...DEFAULT_RATES, ...(loadRoutingConfig()?.rates ?? {}) };
  const rate = rates[model] ?? rates.premium;
  return (inputTokens / 1e6) * rate.in + (outputTokens / 1e6) * rate.out;
}

interface CacheRecord {
  schemaVersion: number;
  createdAt: string;
  content: string;
  outputTokens: number;
}

/**
 * Call the Loupe AI gateway for any task. Single entry point for all AI work.
 *
 * Throws a Loupe-specific error if the gateway is unreachable — callers that want
 * graceful degradation (e.g. `analyze` continuing on deterministic findings only)
 * should catch it. The error never references model-provider keys.
 */
export async function callLLM(
  task: TaskRequest['task'],
  prompt: string,
  options: {
    systemPrompt?: string;
    maxTokens?: number;
    severity?: TaskRequest['severity'];
    confidence?: number;
    contextSize?: TaskRequest['contextSize'];
    promptVersion?: string;
    stage?: string;
    /** Explicit model preference from a routing policy (task-based routing).
     *  routing.json per-stage overrides still win (debug escape hatch). */
    model?: string;
    retryCount?: number;
    cache?: boolean;
    meta?: GatewayMeta;
    images?: string[];
    responseFormat?: ChatOptions['responseFormat'];
  } = {}
): Promise<string> {
  const hasImages = (options.images?.length ?? 0) > 0;

  const request: TaskRequest = {
    task,
    // Any image-backed call needs a vision-capable model — not just redesign.
    // Narration-anchored target generation now attaches screenshots to build/
    // explain calls, so vision must be driven by the payload, not the task name.
    requiresVision: task === 'redesign' || hasImages,
    requiresLongContext: task === 'build' || task === 'redesign',
    requiresStructuredOutput: task === 'explain' || task === 'redesign' || task === 'build',
    severity: options.severity,
    confidence: options.confidence,
    privacy: 'cloud-ok',
    budget: task === 'judge' ? 'minimal' : task === 'redesign' || task === 'build' ? 'premium' : 'standard',
    contextSize: options.contextSize || 'medium',
  };

  const decision = route(request);
  const stage = options.stage || task;
  // Precedence: routing.json debug override > caller's policy model > route table.
  const override = stageModelOverride(stage);
  const routedModel = override ?? options.model ?? decision.model;
  // Model/provider names stay out of normal CLI output — routing is Loupe's
  // internal concern. Set LOUPE_DEBUG_LLM=1 to see routing + timing lines;
  // timings are always collected and land in the run's debug artifacts.
  if (LLM_DEBUG) {
    console.log(`[LLM] ${stage} → ${decision.provider}/${routedModel} (${decision.reason}${override ? ' · routing.json override' : ''})`);
  }

  const provider = getProvider(decision);

  const chatOpts: ChatOptions = {
    systemPrompt: options.systemPrompt,
    maxTokens: options.maxTokens || (task === 'build' ? 3000 : 2000),
    temperature: task === 'judge' ? 0.1 : 0.3,
    // Default by task, but let a caller that wants markdown prose out of a
    // JSON-default task (e.g. UX synthesis on 'build') override it explicitly —
    // otherwise the gateway is told to force JSON around plain markdown.
    responseFormat: options.responseFormat
      ?? (task === 'explain' || task === 'redesign' || task === 'build' ? 'json' : 'text'),
    task,
    modelPreference: routedModel,
    promptVersion: options.promptVersion,
    meta: options.meta,
    images: options.images,
  };

  const inputTokens = estimateTokens([
    prompt,
    options.systemPrompt || '',
    JSON.stringify(options.meta || {}),
  ].join('\n'));
  const imageCount = options.images?.length ?? 0;
  const retryCount = options.retryCount ?? 0;
  const cacheEnabled = options.cache !== false && process.env.LOUPE_DISABLE_LLM_CACHE !== '1';
  // The gateway's concrete tier→model mapping is part of the key: a tier hint
  // like "premium" is not a model identity, and swapping LOUPE_MODEL_PREMIUM
  // on the gateway must invalidate responses cached under the old model.
  const gatewayModels = cacheEnabled ? await gatewayModelMap() : {};
  const cacheKey = cacheEnabled ? makeCacheKey(task, prompt, chatOpts, routedModel, gatewayModels) : null;
  const start = performance.now();

  if (cacheEnabled && cacheKey) {
    const cached = readCache(cacheKey);
    if (cached) {
      logTiming({
        stage,
        task,
        model: routedModel,
        inputTokens,
        outputTokens: cached.outputTokens,
        imageCount,
        latencyMs: performance.now() - start,
        cache: 'hit',
        retryCount,
      });
      return cached.content;
    }
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const attemptStart = performance.now();
    try {
      const content = await provider.chat(prompt, chatOpts);
      // An empty completion is never a usable stage output — downstream parsers
      // all fail on it. Treat it as transient and let the retry recover it.
      if (content.trim().length === 0) throw new Error('gateway returned empty content');
      const outputTokens = estimateTokens(content);
      if (cacheEnabled && cacheKey) {
        writeCache(cacheKey, { schemaVersion: CACHE_SCHEMA_VERSION, createdAt: new Date().toISOString(), content, outputTokens });
      }
      logTiming({
        stage,
        task,
        model: routedModel,
        inputTokens,
        outputTokens,
        imageCount,
        latencyMs: performance.now() - attemptStart,
        cache: cacheEnabled ? 'miss' : 'off',
        retryCount: retryCount + attempt,
      });
      return content;
    } catch (err) {
      lastErr = err;
      logTiming({
        stage,
        task,
        model: routedModel,
        inputTokens,
        outputTokens: 0,
        imageCount,
        latencyMs: performance.now() - attemptStart,
        cache: cacheEnabled ? 'miss' : 'off',
        retryCount: retryCount + attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempt + 1 < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function makeCacheKey(
  task: TaskRequest['task'],
  prompt: string,
  options: ChatOptions,
  routedModel: string,
  gatewayModels: Record<string, string> = {},
): string {
  const imageHashes = (options.images || []).map(img => sha256(img));
  return sha256(JSON.stringify({
    schemaVersion: CACHE_SCHEMA_VERSION,
    task,
    routedModel,
    gatewayModels,
    promptHash: sha256(prompt),
    systemPromptHash: sha256(options.systemPrompt || ''),
    responseFormat: options.responseFormat || null,
    maxTokens: options.maxTokens || null,
    temperature: options.temperature || null,
    modelPreference: options.modelPreference || null,
    promptVersion: options.promptVersion || null,
    meta: options.meta || {},
    imageHashes,
  }));
}

function readCache(key: string): CacheRecord | null {
  const file = join(CACHE_DIR, `${key}.json`);
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as CacheRecord;
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION || typeof parsed.content !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(key: string, record: CacheRecord): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify(record), 'utf-8');
  } catch {
    // Cache is an optimization only; never let it affect analysis quality.
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface CallTiming {
  stage: string;
  task: TaskRequest['task'];
  model: string;
  inputTokens: number;
  outputTokens: number;
  imageCount: number;
  latencyMs: number;
  cache: 'hit' | 'miss' | 'off';
  retryCount: number;
  error?: string;
  /** Rough USD estimate (excludes image tokens); 0 for cache hits and errors. */
  costUSD?: number;
}

// Per-process collector so commands can persist a run's timings as a debug
// artifact and print a per-stage summary at the end. Commands call
// resetCallTimings() at entry so "this run" never includes calls from a
// previous command or test in the same process.
const callTimings: CallTiming[] = [];

export function getCallTimings(): CallTiming[] {
  return [...callTimings];
}

export function resetCallTimings(): void {
  callTimings.length = 0;
}

/** Human-readable end-of-run summary of every AI call in this process. */
export function timingsSummary(): string {
  if (callTimings.length === 0) return '';
  const wall = callTimings.reduce((s, t) => s + (t.cache === 'hit' ? 0 : t.latencyMs), 0);
  const hits = callTimings.filter(t => t.cache === 'hit').length;
  const premium = callTimings.filter(t => t.model === 'premium' && t.cache !== 'hit').length;
  const errors = callTimings.filter(t => t.error).length;
  const cost = callTimings.reduce((s, t) => s + (t.costUSD ?? 0), 0);
  return (
    `AI calls: ${callTimings.length} total · ${(wall / 1000).toFixed(1)}s model time · ` +
    `${hits} cache hit(s) · ${premium} premium call(s) · ~$${cost.toFixed(3)} est. model cost` +
    (errors > 0 ? ` · ${errors} failed attempt(s)` : '')
  );
}

function logTiming(info: CallTiming): void {
  // Cost accrues only on real, successful completions — cache hits are free
  // and failed attempts produced no billable output worth attributing.
  const costUSD = info.cache !== 'hit' && !info.error
    ? estimateCostUSD(info.model, info.inputTokens, info.outputTokens)
    : 0;
  const entry = { ...info, costUSD };
  callTimings.push(entry);
  if (LLM_DEBUG) {
    console.log(
      `[LLM:timing] stage=${quote(entry.stage)} task=${entry.task} model=${entry.model}` +
      ` in≈${entry.inputTokens} out≈${entry.outputTokens} images=${entry.imageCount}` +
      ` latency=${Math.round(entry.latencyMs)}ms cache=${entry.cache} retry=${entry.retryCount}` +
      ` cost≈$${costUSD.toFixed(4)}` +
      (entry.error ? ` error=${quote(entry.error.slice(0, 200))}` : '')
    );
  }
}

function quote(value: string): string {
  return value.includes(' ') ? JSON.stringify(value) : value;
}
