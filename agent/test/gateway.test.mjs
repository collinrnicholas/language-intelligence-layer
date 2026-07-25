import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The client must never need provider keys — prove it by removing any that leak
// in from the dev shell before importing the LLM code.
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GOOGLE_API_KEY;

const home = mkdtempSync(join(tmpdir(), 'loupe-gw-home-'));
process.env.HOME = home;

function startGateway(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('router defaults to loupe-gateway', async () => {
  const { route } = await import('../dist/llm/router.js');
  const decision = route({
    task: 'explain', requiresVision: false, requiresLongContext: false,
    requiresStructuredOutput: true, privacy: 'cloud-ok', budget: 'standard',
  });
  assert.equal(decision.provider, 'loupe-gateway');
});

test('client config falls back to LOUPE_API_URL / LOUPE_DEV_TOKEN, never provider keys', async () => {
  process.env.LOUPE_API_URL = 'http://localhost:8787';
  process.env.LOUPE_DEV_TOKEN = 'dev-token-xyz';
  const { loadClientConfig } = await import('../dist/llm/client-config.js');
  const cfg = loadClientConfig();
  assert.equal(cfg.apiUrl, 'http://localhost:8787');
  assert.equal(cfg.authToken, 'dev-token-xyz');
  assert.equal(cfg.mode, 'local');
  delete process.env.LOUPE_DEV_TOKEN;
});

test('unreachable gateway yields a Loupe-specific error with no provider names', async () => {
  process.env.LOUPE_API_URL = 'http://127.0.0.1:1'; // refused
  const { callLLM } = await import('../dist/llm/index.js');
  await assert.rejects(
    () => callLLM('judge', 'ping', {}),
    (err) => {
      assert.match(err.message, /Loupe AI gateway is unavailable/);
      assert.doesNotMatch(err.message, /OpenAI|Anthropic|Gemini|API key|_API_KEY/i);
      return true;
    }
  );
});

test('LLM calls are cached by prompt/model/options and skip duplicate gateway requests', async () => {
  let hits = 0;
  const server = await startGateway((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content: `cached-response-${hits}` }));
  });
  const { port } = server.address();
  process.env.LOUPE_API_URL = `http://127.0.0.1:${port}`;

  const { callLLM } = await import('../dist/llm/index.js');
  const first = await callLLM('explain', 'cache this exact prompt', {
    severity: 'Low',
    maxTokens: 99,
    stage: 'cache-test',
    promptVersion: 'cache-test-v1',
    meta: { project: 'CacheProject', flow: 'CacheFlow' },
  });
  const second = await callLLM('explain', 'cache this exact prompt', {
    severity: 'Low',
    maxTokens: 99,
    stage: 'cache-test',
    promptVersion: 'cache-test-v1',
    meta: { project: 'CacheProject', flow: 'CacheFlow' },
  });
  server.close();

  assert.equal(first, 'cached-response-1');
  assert.equal(second, 'cached-response-1');
  assert.equal(hits, 1, 'second identical call should be served from the local LLM cache');
});

test('image-backed explain calls route with premium model preference and include images', async () => {
  let payload;
  const server = await startGateway((req, res, body) => {
    payload = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content: '[]' }));
  });
  const { port } = server.address();
  process.env.LOUPE_API_URL = `http://127.0.0.1:${port}`;

  const { callLLM } = await import('../dist/llm/index.js');
  await callLLM('explain', 'look at this image', {
    images: ['data:image/png;base64,abc123'],
    stage: 'vision-route-test',
    promptVersion: 'vision-route-test-v1',
  });
  server.close();

  assert.equal(payload.model, 'premium');
  assert.deepEqual(payload.images, ['data:image/png;base64,abc123']);
});

test('analyze runs through the gateway with no provider keys set', async () => {
  let hits = 0;
  const aiOpportunity = {
    id: 'ai-1', category: 'UX', severity: 'High',
    title: 'AI: Confusing CTA', description: 'The primary CTA is ambiguous.',
    page: 'https://example.test/', selector: 'button.cta',
    whyItMatters: 'Users hesitate at the decision point.',
    suggestedFix: 'Use an action-specific label.',
    timestamp: 1000, confidence: 0.8,
  };

  const server = await startGateway((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content: JSON.stringify([aiOpportunity]) }));
  });
  const { port } = server.address();
  process.env.LOUPE_API_URL = `http://127.0.0.1:${port}`;

  assert.equal(process.env.OPENAI_API_KEY, undefined);
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);

  const { analyzeSession } = await import('../dist/commands/analyze.js');
  const dir = mkdtempSync(join(tmpdir(), 'loupe-gw-analyze-'));
  const sessionPath = join(dir, 'session.loupe');
  writeFileSync(sessionPath, JSON.stringify(sampleSession(), null, 2));
  const exportDir = join(dir, 'export');

  await analyzeSession(sessionPath, { ai: true, output: exportDir });
  server.close();

  assert.ok(hits >= 1, 'the gateway should have been called');
  assert.equal(existsSync(join(exportDir, 'opportunities.json')), true);
  const artifact = JSON.parse(readFileSync(join(exportDir, 'opportunities.json'), 'utf-8'));
  assert.equal(artifact.version, 2);
  assert.ok(
    artifact.opportunities.some((o) => o.title === 'AI: Confusing CTA'),
    'the gateway-provided AI finding should be present',
  );
});

test('LLM client source carries no user-facing provider-key text', () => {
  const files = [
    'llm/router.js', 'llm/tasks/call.js', 'llm/index.js', 'llm/types.js',
    'llm/client-config.js', 'llm/providers/loupe-gateway.js',
    'commands/transcribe.js', 'commands/analyze.js',
  ];
  for (const f of files) {
    const src = readFileSync(join(import.meta.dirname, '..', 'dist', f), 'utf-8');
    assert.doesNotMatch(src, /OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY/, `${f} must not reference a provider key`);
  }
});

test('transcribe POSTs multipart audio and maps {startMs,endMs,text} segments to notes', async () => {
  let contentType = '';
  let sawFilePart = false;
  const server = await startGateway((req, res, body) => {
    contentType = req.headers['content-type'] || '';
    sawFilePart = body.includes('filename="audio.webm"');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      text: 'hello there',
      segments: [
        { startMs: 0, endMs: 1500, text: ' hello' },
        { startMs: 1500, endMs: 3000, text: ' there' },
      ],
    }));
  });
  const { port } = server.address();
  process.env.LOUPE_API_URL = `http://127.0.0.1:${port}`;

  const dir = mkdtempSync(join(tmpdir(), 'loupe-transcribe-'));
  const sessionPath = join(dir, 'narrated.loupe');
  const session = sampleSession();
  session.audioData = 'data:audio/webm;base64,' + Buffer.from('fake-webm-bytes').toString('base64');
  writeFileSync(sessionPath, JSON.stringify(session, null, 2));

  const { transcribeSession } = await import('../dist/commands/transcribe.js');
  await transcribeSession(sessionPath);
  server.close();

  assert.match(contentType, /^multipart\/form-data/, 'audio must be sent as multipart/form-data');
  assert.ok(sawFilePart, 'request must include a binary file part');

  const updated = JSON.parse(readFileSync(sessionPath, 'utf-8')).session;
  // transcribe appends to existing notes; the audio-derived ones carry endTimestamp.
  const fromAudio = updated.notes.filter((n) => n.type === 'transcript' && n.endTimestamp !== undefined);
  assert.equal(fromAudio.length, 2);
  assert.equal(fromAudio[0].timestamp, 0);
  assert.equal(fromAudio[0].endTimestamp, 1500);
  assert.equal(fromAudio[0].text, 'hello');
});

function sampleSession() {
  return {
    project: 'TestProject',
    flow: 'Checkout',
    startedAt: '2026-06-27T12:00:00.000Z',
    endedAt: '2026-06-27T12:00:45.000Z',
    urlTimeline: [{ url: 'https://example.test/', timestamp: 0, navigationType: 'initial' }],
    events: [
      { type: 'console_error', timestamp: 1000, message: 'Boom', source: 'test.js:1' },
    ],
    screenshots: [],
    viewport: { width: 1280, height: 720 },
    browser: { userAgent: 'node-test' },
    notes: [{ type: 'transcript', timestamp: 1200, text: 'The CTA is unclear', source: 'audio' }],
  };
}
