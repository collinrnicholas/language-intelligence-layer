// ─── Persado Assist — local development gateway ──────────────────
//
// The ONLY process that holds provider credentials (PERSADO_API_KEY,
// MAILCHIMP_API_KEY). The extension is a client that never sees them.
//
//   npm run gateway            # binds 127.0.0.1:8788
//
// Routes (everything else is 404):
//   GET  /health            → { ok, service, version }   reachability probe, no secrets
//   POST /v1/integrations   → authenticated Persado + Mailchimp operations
//                             (loopback Host + extension Origin + pairing token +
//                              JSON only; see handleIntegrationRequest)
//
// The Loupe-era model routes (/v1/ai/transcribe, /v1/ai/complete,
// /v1/ai/recommend) were removed: they had no authentication and could spend
// OpenAI/Anthropic credits for any local caller. Nothing in Persado Assist used
// them. test/gateway-security.test.mjs keeps them gone.

import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createIntegrations, handleIntegrationRequest } from './integrations.mjs';

const SERVICE = 'persado-assist-gateway';

/** Build the HTTP server. Exported so tests exercise the real router. */
export function createGatewayServer({ service, env = process.env, version = 'dev', log = () => {} } = {}) {
  return http.createServer(async (req, res) => {
    const t0 = Date.now();
    // Path and status only — never bodies, headers or query strings.
    res.on('finish', () => log(`[gateway] ${req.method} ${req.url?.split('?')[0]} → ${res.statusCode} ${Date.now() - t0}ms`));
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, { ok: true, service: SERVICE, version });
      }
      if (req.url === '/v1/integrations') return await handleIntegrationRequest(req, res, service, env);
      // Drain and refuse. No body is parsed for an unknown route.
      req.resume();
      sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (err) {
      console.error('[gateway] request failed', err?.message || err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Gateway error' });
    }
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ─── Run directly ────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  // Environment injection (secret manager `run`) is preferred. Optional .env
  // loading supports local development without shipping keys.
  try { process.loadEnvFile(new URL('../.env', import.meta.url)); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }

  const PORT = Number(process.env.PERSADO_GATEWAY_PORT || 8788);
  // Loopback only. handleIntegrationRequest also refuses non-loopback Host headers.
  const HOST = '127.0.0.1';
  const version = (() => {
    try {
      return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', cwd: new URL('.', import.meta.url).pathname }).stdout?.trim() || 'unknown';
    } catch { return 'unknown'; }
  })();

  const server = createGatewayServer({ service: createIntegrations(), version, log: console.log });
  server.listen(PORT, HOST, () => {
    console.log(`Persado Assist gateway → http://${HOST}:${PORT}`);
    // Presence only. Values are never logged.
    for (const k of ['PERSADO_API_KEY', 'MAILCHIMP_API_KEY', 'PERSADO_PROXY_TOKEN']) {
      console.log(`  ${k}: ${process.env[k] ? 'set' : 'MISSING'}`);
    }
  });
}
