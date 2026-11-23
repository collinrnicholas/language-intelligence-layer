// Test helpers: load the extension's classic scripts into globalThis and build
// fake fetch servers. The fakes reproduce the documented request/response shapes
// of the Persado Martech API (persado/martechapi-cli models.go) and the Mailchimp
// Marketing API v3 — they test OUR code against those contracts, they are not a
// claim that the live services were exercised.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
export async function load(...files) {
  for (const f of files) await import(join(SRC, f) + '?t=' + Date.now());
}

export function json(status, body, headers = {}) {
  return new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** routes: [{ method, match: RegExp|fn, reply: (req)=>Response }] — records calls. */
export function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const req = { url: String(url), method: (init.method || 'GET').toUpperCase(), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(req);
    for (const r of routes) {
      if (r.method && r.method !== req.method) continue;
      const ok = typeof r.match === 'function' ? r.match(req) : r.match.test(req.url);
      if (ok) return r.reply(req);
    }
    return json(404, { error: { code: 'not_found', message: 'no fake route for ' + req.method + ' ' + req.url } });
  };
  f.calls = calls;
  return f;
}

export const noSleep = async () => {};

export function memoryStorage() {
  const data = {};
  return {
    data,
    async get(k) { return { [k]: data[k] }; },
    async set(o) { Object.assign(data, JSON.parse(JSON.stringify(o))); },
  };
}

/** A completed Persado optimize job, in the models.go Result shape. */
export function optimizeJob(id, alternatives, control) {
  return { id, kind: 'optimize', status: 'completed', createdAt: 't', updatedAt: 't', expiresAt: 't',
    result: { complete: true, brand: 'Acme', channel: 'EMAIL_SUBJECT_BODY', complianceApplicable: true,
      variants: [], control: control || null, alternatives, notice: null } };
}
