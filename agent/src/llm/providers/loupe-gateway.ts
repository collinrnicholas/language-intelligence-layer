// ─── Loupe Gateway Provider ──────────────────────────────────────
//
// The single AI provider used by the client. All tasks (explain/redesign/build/
// judge/transcribe) are sent to the Loupe gateway, which owns the model-provider
// credentials and chooses the actual model. The client never sees provider keys.

import type { ProviderAdapter, ChatOptions } from '../types.js';
import { loadClientConfig, type LoupeClientConfig } from '../client-config.js';

/** User-facing error when the gateway can't be reached. Never names a provider. */
export const GATEWAY_UNAVAILABLE = 'Loupe AI gateway is unavailable. Check Loupe backend configuration.';

/**
 * Quick reachability probe for the gateway (used before AI-dependent steps so a
 * down gateway becomes a clear, actionable message instead of a silent no-op).
 * Any HTTP response — even 404 from an older build without /health — counts as
 * reachable; only a connection error or timeout is "down".
 */
export async function pingGateway(timeoutMs = 1500): Promise<{ reachable: boolean; url: string }> {
  const { apiUrl } = loadClientConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(`${apiUrl}/health`, { method: 'GET', signal: ctrl.signal });
    return { reachable: true, url: apiUrl };
  } catch {
    return { reachable: false, url: apiUrl };
  } finally {
    clearTimeout(timer);
  }
}

// The gateway's live tier→model mapping (from /health), fetched once per
// process. Folded into the client's response-cache key so changing the
// gateway's LOUPE_MODEL_PREMIUM/STANDARD env invalidates cached responses —
// without this, a model swap silently serves the old model's cached output.
// Older gateways without the field yield {} (cache behaves as before).
let modelMapPromise: Promise<Record<string, string>> | null = null;

export function gatewayModelMap(timeoutMs = 1500): Promise<Record<string, string>> {
  if (!modelMapPromise) {
    modelMapPromise = (async () => {
      const { apiUrl } = loadClientConfig();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetch(`${apiUrl}/health`, { method: 'GET', signal: ctrl.signal });
        const data = await resp.json() as { models?: Record<string, string> };
        return data.models && typeof data.models === 'object' ? data.models : {};
      } catch {
        return {};
      } finally {
        clearTimeout(timer);
      }
    })();
  }
  return modelMapPromise;
}

/** Actionable message for a down gateway, naming what was skipped and how to fix.
 *  Provider-agnostic on purpose — the client never names provider keys (ADR-010). */
export function gatewayUnreachableMessage(url: string, whatSkipped: string): string {
  return (
    `Gateway not reachable at ${url} — ${whatSkipped} skipped.\n` +
    `  Start it with:  npm run gateway   (ensure the gateway has its provider key configured)`
  );
}

/** Bumped when prompt contracts change; forwarded so the gateway can version prompts. */
export const PROMPT_VERSION = 'v1';

const COMPLETE_PATH = '/v1/ai/complete';
const TRANSCRIBE_PATH = '/v1/ai/transcribe';
const TIMEOUT_MS = 120_000;

interface GatewayCompletionRequest {
  task?: string;
  promptVersion: string;
  model?: string;
  systemPrompt?: string;
  prompt: string;
  responseFormat?: 'text' | 'json';
  maxTokens?: number;
  temperature?: number;
  project?: string;
  flow?: string;
  images?: string[];
  targetDesignRef?: string;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments?: TranscriptSegment[];
}

export const loupeGatewayProvider: ProviderAdapter = {
  name: 'loupe-gateway',

  async chat(prompt: string, options: ChatOptions = {}): Promise<string> {
    const cfg = loadClientConfig();
    const payload: GatewayCompletionRequest = {
      task: options.task,
      promptVersion: options.promptVersion || PROMPT_VERSION,
      model: options.modelPreference,
      systemPrompt: options.systemPrompt,
      prompt,
      responseFormat: options.responseFormat,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      project: options.meta?.project,
      flow: options.meta?.flow,
      images: options.images,
      targetDesignRef: options.meta?.targetDesignRef,
    };

    const data = await gatewayFetch(cfg, COMPLETE_PATH, payload);
    // Accept Loupe's native shape ({ content }) or an OpenAI-compatible shape.
    return data.content ?? data.choices?.[0]?.message?.content ?? '';
  },
};

/**
 * Transcribe audio through the gateway. The base64 audio is decoded to binary and
 * sent as multipart/form-data (so the gateway can stream it straight to Whisper).
 * The gateway holds the provider key and returns text + {startMs,endMs,text} segments.
 */
export async function transcribeViaGateway(
  audioBase64: string,
  mimeType: string,
  meta: { project?: string; flow?: string } = {}
): Promise<TranscriptionResult> {
  const cfg = loadClientConfig();

  const bytes = Buffer.from(audioBase64, 'base64');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: `audio/${mimeType}` }), `audio.${mimeType}`);
  form.append('task', 'transcribe');
  form.append('promptVersion', PROMPT_VERSION);
  if (meta.project) form.append('project', meta.project);
  if (meta.flow) form.append('flow', meta.flow);

  const headers: Record<string, string> = {};
  if (cfg.authToken) headers['Authorization'] = `Bearer ${cfg.authToken}`;
  // No Content-Type — fetch sets the multipart boundary.

  let resp: Response;
  try {
    resp = await fetch(`${cfg.apiUrl}${TRANSCRIBE_PATH}`, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error(GATEWAY_UNAVAILABLE);
  }
  if (!resp.ok) throw new Error(`${GATEWAY_UNAVAILABLE} (status ${resp.status})`);

  let data: any;
  try {
    data = await resp.json();
  } catch {
    throw new Error(GATEWAY_UNAVAILABLE);
  }
  return { text: data.text ?? '', segments: data.segments };
}

// ─── Transport ───────────────────────────────────────────────────

async function gatewayFetch(cfg: LoupeClientConfig, path: string, body: unknown): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.authToken) headers['Authorization'] = `Bearer ${cfg.authToken}`;

  let resp: Response;
  try {
    resp = await fetch(`${cfg.apiUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Network failure, DNS, refused connection, or timeout.
    throw new Error(GATEWAY_UNAVAILABLE);
  }

  if (!resp.ok) {
    // Surface the gateway's error body (it carries the upstream provider error,
    // e.g. "OpenAI error 400: invalid image") — without it every failure looks
    // like "gateway unavailable" and real 4xx causes are undiagnosable.
    let detail = '';
    try {
      const errBody = await resp.json() as { error?: string };
      if (typeof errBody?.error === 'string') detail = ` — ${errBody.error.slice(0, 200)}`;
    } catch { /* body unreadable; status alone will have to do */ }
    throw new Error(`${GATEWAY_UNAVAILABLE} (status ${resp.status})${detail}`);
  }

  try {
    return await resp.json();
  } catch {
    throw new Error(GATEWAY_UNAVAILABLE);
  }
}
