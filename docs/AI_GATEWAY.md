# Loupe AI Gateway

Loupe is a SaaS product. The CLI and Chrome extension are **clients** of the Loupe
AI gateway. The gateway owns all model-provider credentials (OpenAI, Anthropic,
Gemini, etc.). **Users never configure provider keys.** See ADR-010.

## Why

A bring-your-own-key model leaks provider identity, pushes credential management
onto users, and prevents Loupe from controlling model mix, pricing, and rate
limits. The gateway centralizes all of that.

## Client configuration

Resolved by `agent/src/llm/client-config.ts`, first match wins:

1. `~/.loupe/config/client.json`
   ```json
   { "apiUrl": "https://api.loupe.dev", "authToken": "...", "mode": "cloud" }
   ```
2. Env fallback (local dev only): `LOUPE_API_URL`, `LOUPE_DEV_TOKEN`
3. Built-in default cloud endpoint (`https://api.loupe.dev`)

The client reads **no** model-provider keys. `mode` is `cloud` by default and
`local` when `apiUrl` points at localhost.

## Endpoints

The client calls (`agent/src/llm/providers/loupe-gateway.ts`):

- `POST {apiUrl}/v1/ai/complete` — chat/completion tasks
- `POST {apiUrl}/v1/ai/transcribe` — audio transcription

`Authorization: Bearer <authToken>` is sent when a token is configured.

### Completion request payload

```jsonc
{
  "task": "explain",            // explain | redesign | build | judge
  "promptVersion": "v1",
  "model": "standard",          // preference/hint; the gateway makes the final choice
  "systemPrompt": "…",
  "prompt": "…",
  "responseFormat": "json",     // or "text"
  "maxTokens": 2000,
  "temperature": 0.3,
  "project": "PM Toolkit",      // metadata
  "flow": "Dashboard Redesign",
  "screenshotRefs": ["screenshots/000.jpg"],
  "targetDesignRef": "…"
}
```

Response: `{ "content": "…" }` (OpenAI-compatible `{ choices: [...] }` is also accepted).

### Transcription request

`multipart/form-data` — the client decodes the session's base64 audio to binary and
sends it as a file part (so the gateway can stream it straight to the speech model):

```
file:          <binary audio>   (e.g. audio.webm)
task:          transcribe
promptVersion: v1
project:       PM Toolkit
flow:          Workspace
```

The gateway attaches its server-side `OPENAI_API_KEY` and calls Whisper with
`model=whisper-1`, `response_format=verbose_json`, `timestamp_granularities=["segment"]`,
then maps Whisper's second-based segments to milliseconds.

Response:

```jsonc
{ "text": "…", "segments": [{ "startMs": 0, "endMs": 4000, "text": "…" }] }
```

An ffmpeg→wav normalization step exists in the gateway but is **off by default**
(`LOUPE_GATEWAY_FFMPEG=1` to enable) — only needed if segment timestamps misbehave.

## Routing

`agent/src/llm/router.ts` always routes to `loupe-gateway`. Per-task model
*preferences* (and an upgrade hint for high-severity / low-confidence / large
context) are sent to the gateway, which selects the concrete model.

## Local development

A minimal dev gateway ships in `gateway/server.mjs` (zero build, Node 18+ only).
The provider key lives **only** in that process:

```bash
# terminal 1 — run the gateway (this is the only place the key exists)
OPENAI_API_KEY=sk-... npm run gateway
#   → Loupe dev gateway → http://localhost:8787
#   set LOUPE_GATEWAY_FFMPEG=1 to enable the ffmpeg→wav fallback

# terminal 2 — point the client at it
export LOUPE_API_URL=http://localhost:8787
export LOUPE_DEV_TOKEN=<dev token>   # optional
node agent/dist/cli.js transcribe ~/Downloads/loupe/<session>.loupe
node agent/dist/cli.js analyze   ~/Downloads/loupe/<session>.loupe
```

The dev gateway implements `/v1/ai/transcribe` (Whisper) and `/v1/ai/complete`
(chat). The client never sees provider keys. A production gateway implements the
same contract; this dev script is the reference.

## Errors

If the gateway is missing or unreachable the client throws:

```
Loupe AI gateway is unavailable. Check Loupe backend configuration.
```

It never references a model provider. `loupe analyze` catches this and continues
with deterministic findings only.

## Extension

The extension is recording-only and makes no AI calls. Any future extension AI
must call this same gateway — never a model provider directly.
