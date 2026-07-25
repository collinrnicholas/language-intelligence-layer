// ─── Loupe Dev Gateway ───────────────────────────────────────────
//
// The ONLY place model-provider keys live. The CLI/extension are clients that
// authenticate to this gateway; they never see OPENAI_API_KEY. Run locally for
// development:
//
//   OPENAI_API_KEY=sk-... node gateway/server.mjs
//   # then point the client at it:
//   export LOUPE_API_URL=http://localhost:8787
//
// Endpoints:
//   GET  /health            → { ok, service, openai }   (reachability probe)
//   POST /v1/ai/transcribe  multipart/form-data (file=...) → { text, segments:[{startMs,endMs,text}] }
//   POST /v1/ai/complete    application/json               → { content }
//
// Uses only Node built-ins + global fetch/FormData/Blob/Response (Node 18+).

import http from 'node:http';
import { spawnSync } from 'node:child_process';

const PORT = Number(process.env.LOUPE_GATEWAY_PORT || process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;       // gateway-side ONLY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // gateway-side ONLY
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';
const ENABLE_FFMPEG = process.env.LOUPE_GATEWAY_FFMPEG === '1';

// Model routing is configurable without code edits (restart to apply):
//   LOUPE_MODEL_PREMIUM  — model for premium-tier + vision calls (default gpt-4o)
//   LOUPE_MODEL_STANDARD — model for everything else (default gpt-4o-mini)
//   LOUPE_MODEL_ALLOWED  — comma-separated full model ids a client may request
//                          explicitly (per-stage A/B via client routing.json).
// Provider is chosen by the resolved model id's prefix: `claude*` → Anthropic,
// everything else → OpenAI. A client may request any real provider id (gpt-*,
// o1/o3*, claude-*) or a tier hint (premium/standard); other explicit ids are
// honored only when listed in LOUPE_MODEL_ALLOWED (cost control, ADR-010).
const MODEL_PREMIUM = process.env.LOUPE_MODEL_PREMIUM || 'gpt-4o';
const MODEL_STANDARD = process.env.LOUPE_MODEL_STANDARD || 'gpt-4o-mini';
const MODEL_ALLOWED = new Set(
  (process.env.LOUPE_MODEL_ALLOWED || '').split(',').map(s => s.trim()).filter(Boolean),
);
// Real provider model ids are always honorable without an explicit allowlist entry
// (the client's routing.json is the control point); unknown strings still fall back
// to the tier map so a stale config can never break a run.
const KNOWN_PROVIDER_ID = /^(gpt-|o1|o3|chatgpt-|claude-)/i;
const isAnthropicModel = (m) => /^claude/i.test(m);

// Stamped once at startup so /health proves which code is running and when.
const STARTED_AT = new Date().toISOString();
const GIT_SHA = (() => {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      cwd: new URL('.', import.meta.url).pathname,
    });
    return r.stdout?.trim() || 'unknown';
  } catch { return 'unknown'; }
})();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      // `models` exposes the live tier→model mapping so clients can key their
      // response caches on the CONCRETE models — without it, changing
      // LOUPE_MODEL_PREMIUM would silently serve cached answers from the old model.
      return sendJson(res, 200, {
        ok: true,
        service: 'loupe-gateway',
        openai: !!OPENAI_API_KEY,
        anthropic: !!ANTHROPIC_API_KEY,
        version: GIT_SHA,
        startedAt: STARTED_AT,
        models: { premium: MODEL_PREMIUM, standard: MODEL_STANDARD },
      });
    }
    if (req.method === 'POST' && req.url === '/v1/ai/transcribe') return await handleTranscribe(req, res);
    if (req.method === 'POST' && req.url === '/v1/ai/complete') return await handleComplete(req, res);
    if (req.method === 'POST' && req.url === '/v1/ai/recommend') return await handleRecommend(req, res);
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[gateway]', err);
    sendJson(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`Persado Demo gateway → http://localhost:${PORT}`);
  console.log(`  OPENAI_API_KEY: ${OPENAI_API_KEY ? 'loaded' : 'MISSING'}`);
  console.log(`  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? 'loaded' : 'MISSING'}`);
});

// ─── Transcription (Whisper) ─────────────────────────────────────

async function handleTranscribe(req, res) {
  if (!OPENAI_API_KEY) return sendJson(res, 500, { error: 'Gateway missing OPENAI_API_KEY' });

  const raw = await readBody(req);
  const inbound = await new Response(raw, {
    headers: { 'content-type': req.headers['content-type'] || '' },
  }).formData();

  const file = inbound.get('file');
  if (!file || typeof file === 'string') return sendJson(res, 400, { error: 'Missing audio file part' });

  let bytes = Buffer.from(await file.arrayBuffer());
  let filename = file.name || 'audio.webm';
  let contentType = file.type || 'audio/webm';

  // Optional ffmpeg → wav normalization (off by default; see normalizeToWav).
  if (ENABLE_FFMPEG) {
    const wav = normalizeToWav(bytes);
    if (wav) { bytes = wav; filename = 'audio.wav'; contentType = 'audio/wav'; }
  }

  const whisperForm = new FormData();
  whisperForm.append('file', new Blob([bytes], { type: contentType }), filename);
  whisperForm.append('model', 'whisper-1');
  whisperForm.append('response_format', 'verbose_json');
  whisperForm.append('timestamp_granularities[]', 'segment');

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: whisperForm,
  });

  if (!resp.ok) {
    const text = await resp.text();
    return sendJson(res, 502, { error: `Whisper error ${resp.status}: ${text.slice(0, 300)}` });
  }

  const data = await resp.json();
  // Whisper segment start/end are in seconds → map to {startMs, endMs, text}.
  const segments = (data.segments || []).map((s) => ({
    startMs: Math.round((s.start || 0) * 1000),
    endMs: Math.round((s.end || 0) * 1000),
    text: (s.text || '').trim(),
  }));

  sendJson(res, 200, { text: data.text || '', segments });
}

// ─── Completion (chat) — companion endpoint for analyze/explain/etc. ──

async function handleComplete(req, res) {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const hasImages = Array.isArray(body.images) && body.images.length > 0;

  // Resolve the concrete model. A real provider id (gpt-*/o1/o3/claude-*) or an
  // allowlisted id is honored as-is; otherwise the tier hint / vision rule maps to
  // premium/standard. Unknown strings fall back to standard so a stale config can't break runs.
  const requested = typeof body.model === 'string' ? body.model : '';
  const honorExplicit = MODEL_ALLOWED.has(requested) || KNOWN_PROVIDER_ID.test(requested);
  const model = honorExplicit
    ? requested
    : hasImages || requested === 'premium' ? MODEL_PREMIUM : MODEL_STANDARD;

  try {
    const content = isAnthropicModel(model)
      ? await completeAnthropic(model, body, hasImages)
      : await completeOpenAI(model, body, hasImages);
    sendJson(res, 200, { content });
  } catch (err) {
    sendJson(res, 502, { error: String(err?.message || err) });
  }
}

async function completeOpenAI(model, body, hasImages) {
  if (!OPENAI_API_KEY) throw new Error('Gateway missing OPENAI_API_KEY');
  const messages = [];
  if (body.systemPrompt) messages.push({ role: 'system', content: body.systemPrompt });
  const userContent = hasImages
    ? [
        { type: 'text', text: body.prompt || '' },
        ...body.images.map(url => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
      ]
    : body.prompt || '';
  messages.push({ role: 'user', content: userContent });

  // Newer OpenAI reasoning models (gpt-5*, o1/o3/o4*) changed the API: they take
  // `max_completion_tokens` (not `max_tokens`) and only support the default
  // temperature. Older chat models (gpt-4o, gpt-4.1) keep the classic params.
  const isNewGen = /^(gpt-5|o1|o3|o4)/i.test(model);
  const payload = { model, messages };
  if (isNewGen) {
    payload.max_completion_tokens = body.maxTokens || 2000;
  } else {
    payload.max_tokens = body.maxTokens || 2000;
    payload.temperature = body.temperature ?? 0.3;
  }

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`OpenAI error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function completeAnthropic(model, body, hasImages) {
  if (!ANTHROPIC_API_KEY) throw new Error('Gateway missing ANTHROPIC_API_KEY (needed for a claude-* model)');
  // Anthropic: system is a top-level field; images are content blocks with a
  // base64 or url source (the client sends data: URLs → base64).
  const content = hasImages
    ? [{ type: 'text', text: body.prompt || '' }, ...body.images.map(toAnthropicImage).filter(Boolean)]
    : body.prompt || '';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: body.maxTokens || 2000,
      temperature: body.temperature ?? 0.3,
      ...(body.systemPrompt ? { system: body.systemPrompt } : {}),
      messages: [{ role: 'user', content }],
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  // content is an array of blocks; concatenate the text blocks.
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('') || '';
}

/** Convert a client image (data: URL or http URL) to an Anthropic image block. */
function toAnthropicImage(url) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url || '');
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  if (/^https?:\/\//.test(url || '')) return { type: 'image', source: { type: 'url', url } };
  return null; // unsupported → dropped rather than erroring the whole call
}

// ─── ffmpeg normalization — STUBBED, OFF by default ──────────────
//
// Whisper accepts webm/opus directly, so this is unnecessary in the common case.
// Enable with LOUPE_GATEWAY_FFMPEG=1 ONLY if segment timestamps come back wrong
// (some containers report bad durations). Requires ffmpeg on PATH.
function normalizeToWav(buf) {
  try {
    const r = spawnSync('ffmpeg', ['-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'], {
      input: buf,
      maxBuffer: 1 << 28,
    });
    if (r.status === 0 && r.stdout?.length) return r.stdout;
    console.warn('[gateway] ffmpeg normalization failed; using original audio');
  } catch {
    console.warn('[gateway] ffmpeg not available; using original audio');
  }
  return null;
}

// ─── Recommendation (Persado Demo) ────────────────────────────────
//
// Accepts a marketing brief (element + narration + audience + goal)
// and returns Persado-style copy variants with compliance flags and
// stubbed predicted lift. Uses a general LLM as a stand-in for
// Persado's Motivation AI — clearly labeled throughout.

async function handleRecommend(req, res) {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');

  const audienceLabels = { new: 'New Customers', existing: 'Existing Customers', lapsed: 'Lapsed / Dormant' };
  const goalLabels = { conversions: 'Conversions', clicks: 'Clicks / CTR', trust: 'Trust / Credibility' };

  const element = body.element || {};
  const narration = body.narration || '(none)';
  const audience = audienceLabels[body.audience] || body.audience || 'General';
  const goal = goalLabels[body.goal] || body.goal || 'Conversions';

  const systemPrompt = [
    'You are a marketing language AI trained on millions of high-performing marketing messages across',
    'regulated industries — finance, banking, insurance, healthcare. You operate like Persado\'s',
    'Motivation AI: you understand that word choice, emotional framing, and narrative structure drive',
    'measurable conversion lifts, and you ground every recommendation in that data-driven understanding.',
    '',
    'Your job: given an existing on-page marketing element (headline, CTA, promo, trust line) and a',
    'marketer\'s spoken concern about its performance, generate 2–3 optimized copy variants that would',
    'be expected to outperform the original. Each variant is backed by a rationale grounded in marketing',
    'psychology and language-performance data.',
    '',
    'FINANCE COMPLIANCE (illustrative — you are a stand-in, not a real compliance engine):',
    '- Flag any language that could raise UDAAP concerns: unsubstantiated claims ("guaranteed", "risk-free",',
    '  "100% safe"), misleading urgency ("limited time" without actual limits), hidden conditions.',
    '- Flag missing TILA/Reg Z disclosures: APY without qualifiers, loan terms without APR, promotional',
    '  rates without the go-to rate or duration.',
    '- Flag language that implies a promise the bank cannot keep ("you\'ll never pay a fee" vs "no monthly',
    '  maintenance fee on this account").',
    '- If no issues, mark compliance as "clear". If flagged, explain the specific concern briefly.',
    '',
    'PREDICTED LIFT:',
    '- Provide a stubbed predicted-lift range (e.g. "+8–14%") based on the type of change:',
    '  - Emotional language / narrative reframe: +10–20%',
    '  - Specificity / number anchoring: +5–12%',
    '  - Trust/credibility emphasis: +8–15%',
    '  - Urgency/scarcity (when compliant): +12–25%',
    '  - Removing friction / clarifying: +3–8%',
    '- Always label these as illustrative estimates.',
    '',
    'OUTPUT FORMAT — return ONLY valid JSON, no markdown, no code fences:',
    '{',
    '  "variants": [',
    '    {',
    '      "copy": "The rewritten element text",',
    '      "rationale": "One-line explanation of why this motivates (e.g., anchors savings to a concrete number, uses social proof framing, invokes loss aversion)",',
    '      "compliance": "clear",',
    '      "complianceNote": "",',
    '      "predictedLift": "+8–14%"',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- Each variant should take a DIFFERENT psychological approach (emotion, specificity, social proof,',
    '  urgency, authority, curiosity, loss aversion, etc.).',
    '- Copy should match the element TYPE: headlines are short and punchy, CTAs are action-oriented,',
    '  trust lines are reassuring and specific, promos are benefit-forward.',
    '- Never invent specific numbers (rates, APYs, dollar amounts) unless the original had them.',
    '- Keep copy concise. A variant should not be longer than 2x the original.',
  ].join('\n');

  const userPrompt = [
    'MARKETING BRIEF',
    '─────────────────',
    `Campaign: ${body.campaign || 'Unnamed'}`,
    `Target Audience: ${audience}`,
    `Objective: ${goal}`,
    '',
    'ELEMENT TO OPTIMIZE',
    '─────────────────',
    `Type: ${element.type || 'Unknown'}`,
    `Current Copy: "${element.text || '(none)'}"`,
    `Surrounding Context: ${element.context || '(none)'}`,
    `Selector: ${element.selector || 'unknown'}`,
    '',
    'MARKETER\'S CONCERN (spoken narration)',
    '─────────────────────────────────────',
    `"${narration}"`,
    '',
    'Generate 2–3 optimized variants for this element. Return ONLY the JSON.',
  ].join('\n');

  // Use the standard model (no need for premium on this task)
  const requested = body.model || 'standard';

  try {
    let content;
    if (isAnthropicModel(requested)) {
      content = await completeAnthropic(requested, { prompt: userPrompt, systemPrompt }, false);
    } else {
      content = await completeOpenAI(requested, { prompt: userPrompt, systemPrompt }, false);
    }

    // Parse the LLM response as JSON
    let parsed;
    try {
      const cleaned = content.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      // If JSON parsing fails, return a graceful fallback
      parsed = {
        variants: [{
          copy: content.slice(0, 200).trim() || '(generation failed — raw output unavailable)',
          rationale: 'Fallback — structured output could not be parsed.',
          compliance: 'flag',
          complianceNote: 'Unable to verify compliance — structured generation failed.',
          predictedLift: 'N/A',
        }],
      };
    }

    sendJson(res, 200, parsed);
  } catch (err) {
    sendJson(res, 502, { error: String(err?.message || err) });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
