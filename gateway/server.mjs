// ─── Persado Capture — Dev Gateway ───────────────────────────────
//
// The ONLY place model-provider keys live. The extension and CLI are clients
// that never see OPENAI_API_KEY. Run locally for development:
//
//   OPENAI_API_KEY=sk-... node gateway/server.mjs
//   # the extension targets this by default (extension/src/config.js)
//   export PERSADO_API_URL=http://127.0.0.1:8787
//
// Endpoints:
//   GET  /health            → { ok, service, openai }   (reachability probe)
//   POST /v1/ai/transcribe  multipart/form-data (file=...) → { text, segments:[{startMs,endMs,text}] }
//   POST /v1/ai/complete    application/json               → { content }
//   POST /v1/ai/recommend   application/json               → { variants:[...] }
//
// ENVIRONMENT — PERSADO_* are the primary names. The LOUPE_* equivalents are
// DEPRECATED BUT STILL SUPPORTED as a fallback, because this repo is a fork of
// Loupe (see README Provenance) and an existing shell profile or
// ~/.loupe/gateway.env may still export them. Nothing breaks by leaving them set.
//
//   PERSADO_MODEL_PREMIUM   (LOUPE_MODEL_PREMIUM)   premium + vision tier, default gpt-4o
//   PERSADO_MODEL_STANDARD  (LOUPE_MODEL_STANDARD)  everything else, default gpt-4o-mini
//   PERSADO_MODEL_ALLOWED   (LOUPE_MODEL_ALLOWED)   comma-separated ids a client may request
//   PERSADO_GATEWAY_PORT    (LOUPE_GATEWAY_PORT)    default 8787 — unchanged
//   PERSADO_GATEWAY_HOST    (LOUPE_GATEWAY_HOST)    default 127.0.0.1 — unchanged
//   PERSADO_GATEWAY_FFMPEG  (LOUPE_GATEWAY_FFMPEG)  '1' to normalise audio to wav
//
// Uses only Node built-ins + global fetch/FormData/Blob/Response (Node 18+).

import http from 'node:http';
import { spawnSync } from 'node:child_process';

/** PERSADO_* wins; LOUPE_* is the deprecated fallback; then the default. */
const env = (name, fallback) => process.env[`PERSADO_${name}`] ?? process.env[`LOUPE_${name}`] ?? fallback;

const PORT = Number(env('GATEWAY_PORT', process.env.PORT || 8787));
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;       // gateway-side ONLY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // gateway-side ONLY
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';
const ENABLE_FFMPEG = env('GATEWAY_FFMPEG', '') === '1';

// Model routing is configurable without code edits (restart to apply); see the
// ENVIRONMENT block above for the full name list and the LOUPE_* fallbacks.
// Provider is chosen by the resolved model id's prefix: `claude*` → Anthropic,
// everything else → OpenAI. A client may request any real provider id (gpt-*,
// o1/o3*, claude-*) or a tier hint (premium/standard); other explicit ids are
// honored only when listed in PERSADO_MODEL_ALLOWED (cost control, ADR-010).
// Cap on images per recommend call — vision tokens are the dominant cost here.
const MAX_IMAGES = 4;
// Which disclosure regime applies, by product line. The side panel shows the SAME
// citation in its compliance step (see REG_BY_AUDIENCE in extension/sidepanel.js),
// so the UI can never cite a regulation the model was not asked to check.
const REG_BY_AUDIENCE = { retail: 'DD', business: 'DD', wealth: 'DD', cards: 'Z', mortgage: 'Z' };
const REG_LABEL = { DD: 'Truth in Savings (Reg DD)', Z: 'TILA (Reg Z)' };

const MODEL_PREMIUM = env('MODEL_PREMIUM', 'gpt-4o');
const MODEL_STANDARD = env('MODEL_STANDARD', 'gpt-4o-mini');
const MODEL_ALLOWED = new Set(
  env('MODEL_ALLOWED', '').split(',').map(s => s.trim()).filter(Boolean),
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

// Bind explicitly to 127.0.0.1. Without a host, Node listens on all interfaces,
// which usually works but makes IPv6-vs-IPv4 mismatches possible; the extension
// targets 127.0.0.1 (see extension/src/config.js) so the two now agree exactly.
const HOST = env('GATEWAY_HOST', '127.0.0.1');

const server = http.createServer(async (req, res) => {
  // One line per request: path in, status out, duration. Answers "did it arrive".
  const t0 = Date.now();
  res.on('finish', () => console.log(`[gateway] ${req.method} ${req.url} → ${res.statusCode} ${Date.now() - t0}ms`));
  try {
    if (req.method === 'GET' && req.url === '/health') {
      // `models` exposes the live tier→model mapping so clients can key their
      // response caches on the CONCRETE models — without it, changing
      // PERSADO_MODEL_PREMIUM would silently serve cached answers from the old model.
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

server.listen(PORT, HOST, () => {
  console.log(`Persado Capture gateway → http://${HOST}:${PORT}`);
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
// Enable with PERSADO_GATEWAY_FFMPEG=1 ONLY if segment timestamps come back wrong
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

// ─── Recommendation (Persado Capture) ─────────────────────────────
//
// Accepts a marketing brief (element + narration + audience + goal)
// and returns Persado-style copy variants with compliance flags and
// stubbed predicted lift. Uses a general LLM as a stand-in for
// Persado's Motivation AI — clearly labeled throughout.

async function handleRecommend(req, res) {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');

  const productLabels = { retail: 'Retail Banking', cards: 'Credit Cards', mortgage: 'Mortgage & Lending', wealth: 'Wealth Management', business: 'Small Business Banking' };
  // Tracks the objective chip set in the side panel (claude-design.md §5).
  const objectiveLabels = { 'cross-sell': 'Cross-Sell', acquisition: 'Acquisition', engagement: 'Engagement', conversion: 'Conversion', retention: 'Retention' };

  const element = body.element || {};
  // Other on-page candidates the client extracted, so the model can ground a
  // reference the narration made to something other than the primary element.
  const others = (Array.isArray(body.elements) ? body.elements : [])
    .filter(e => e?.text && e.text !== element.text)
    .slice(0, 6);
  // Any image switches this call to the vision path (premium tier). `images` is the
  // current field (chronological frames from the recording session); `screenshot`
  // is the older single-image field, still accepted for backwards compatibility.
  const images = [
    ...(Array.isArray(body.images) ? body.images : []),
    ...(body.screenshot ? [body.screenshot] : []),
  ].filter(u => typeof u === 'string' && /^data:image\//.test(u)).slice(0, MAX_IMAGES);
  const narration = body.narration || '(none)';
  const productLine = productLabels[body.audience] || body.audience || 'Retail Banking';
  const objective = objectiveLabels[body.goal] || body.goal || 'Acquisition';
  const reg = REG_BY_AUDIENCE[body.audience] || 'DD';

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
    `FINANCE COMPLIANCE (illustrative — you are a stand-in, not a real compliance engine). For this`,
    `product line the applicable disclosure regime is ${REG_LABEL[reg]}:`,
    '- Flag any language that could raise UDAAP concerns: unsubstantiated claims ("guaranteed", "risk-free",',
    '  "100% safe"), misleading urgency ("limited time" without actual limits), hidden conditions.',
    ...(reg === 'Z' ? [
      '- Flag missing TILA/Reg Z disclosures: a credit offer without its APR, a promotional rate without the',
      '  go-to rate or duration, financing terms that omit the cost of credit.',
    ] : [
      '- Flag missing Truth in Savings/Reg DD disclosures: an APY stated without the required qualifiers, a',
      '  rate without its compounding or crediting basis, a bonus offer without its qualifying conditions.',
    ]),
    '- Flag language that implies a promise the bank cannot keep ("you\'ll never pay a fee" vs "no monthly',
    '  maintenance fee on this account").',
    '- If no issues, mark compliance as "clear". If flagged, explain the specific concern briefly.',
    '',
    ...(images.length ? [
      'WHAT THE PAGE LOOKS LIKE:',
      images.length === 1
        ? '- A screenshot of the marketer\'s actual screen is attached. Use it to judge visual hierarchy,'
        : `- ${images.length} screenshots of the marketer's actual screen are attached, in CHRONOLOGICAL order`,
      images.length === 1
        ? '  where the element sits on the page, how much room its copy has, and what surrounds it.'
        : '  from the recording session (earliest first). Later frames may show scrolled or changed state —\n'
          + '  read them together to understand the page, and use them to judge visual hierarchy, where the\n'
          + '  element sits, how much room its copy has, and what surrounds it.',
      '- Rewrite the ACTUAL copy you were given below. Do NOT invent page elements, sections, offers,',
      '  or products that are not visible in the screenshots or listed in the brief.',
      '- Where the screenshot and the extracted text disagree, trust the extracted text for exact',
      '  wording and the screenshot for placement, prominence, and tone of the surrounding page.',
      '',
    ] : []),
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
    `Page: ${body.pageUrl || 'Unknown page'}`,
    `Product Line: ${productLine}`,
    `Objective: ${objective}`,
    '',
    ...(element.text ? [
      'ELEMENT TO OPTIMIZE',
      '─────────────────',
      `Type: ${element.type || 'Unknown'}`,
      `Current Copy: "${element.text}"`,
      `Surrounding Context: ${element.context || '(none)'}`,
      `Selector: ${element.selector || 'unknown'}`,
      '',
    ] : []),
    ...(others.length ? [
      'OTHER COPY ON THIS PAGE (for context — optimize one of these only if the narration points at it)',
      '─────────────────',
      ...others.map(e => `- [${e.type || 'element'}] "${e.text}"`),
      '',
    ] : []),
    'MARKETER\'S BRIEF (spoken narration)',
    '─────────────────────────────────────',
    `"${narration}"`,
    '',
    element.text
      ? 'Generate 2–3 optimized copy variants that REWRITE the "Current Copy" above — same element, same'
        + ' intent, better language. If the narration clearly points at a different element listed on this'
        + ' page, rewrite that one instead. Never invent copy for an element that is not listed. Return ONLY the JSON.'
      : 'Generate 2–3 optimized copy variants based on this brief. If a specific element was mentioned,'
        + ' optimize that element. If not, propose copy for the most relevant element on the page. Return ONLY the JSON.',
  ].join('\n');

  // Resolve model through tier mapping (same logic as handleComplete). Any attached
  // image forces the premium tier because only it is vision-capable.
  const hasImages = images.length > 0;
  const requested = body.model || (hasImages ? 'premium' : 'standard');
  const honorExplicit = MODEL_ALLOWED.has(requested) || KNOWN_PROVIDER_ID.test(requested);
  const model = honorExplicit ? requested : hasImages ? MODEL_PREMIUM : MODEL_STANDARD;
  console.log(`[gateway] recommend → ${model} ${hasImages ? `(vision, ${images.length} image${images.length === 1 ? '' : 's'})` : '(text-only)'}`
    + ` reg=${reg} element=${element.text ? JSON.stringify(element.text.slice(0, 60)) : 'none'} others=${others.length}`);

  try {
    // completeOpenAI/completeAnthropic already build a multimodal user message from
    // body.images; text-only calls pass hasImages=false and are unchanged.
    const llmBody = { prompt: userPrompt, systemPrompt, ...(hasImages ? { images } : {}) };
    let content;
    if (isAnthropicModel(model)) {
      content = await completeAnthropic(model, llmBody, hasImages);
    } else {
      content = await completeOpenAI(model, llmBody, hasImages);
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
