// ─── Persado Assist — paid-run tracking in the panel ─────────────────────────
//
// A Persado optimize can take minutes. The gateway hands back a job reference
// (cacheId) when a run outlives one short request; this module remembers it in
// chrome.storage.local and polls JOB_STATUS with short requests, so the user
// can close the panel, switch tabs or restart the browser and still get the
// result. It never starts or repeats a paid run: JOB_STATUS is a free read, and
// JOB_RETRY is only ever sent from an explicit user action in the panel.
//
// Stored per job: { cacheId, op, surface, kind, textHash, startedAt } — a hash
// of the copy, never the copy itself.
//
// Classic script: loaded by the side panel and by node tests.

(function (root) {
  // Poll cadence: quick at first (scores and short optimizes land fast), then
  // every 15 s. After MAX_WATCH_MS the panel stops polling on its own and shows
  // "Still processing — check again"; the job stays recorded.
  const SCHEDULE_MS = [2000, 3000, 5000, 8000, 13000];
  const STEADY_MS = 15000;
  const MAX_WATCH_MS = 20 * 60000;
  const KEEP_MS = 24 * 3600000;

  /** FNV-1a; identifies copy without storing it. Not security. */
  function textHash(s) {
    let h = 0x811c9dc5;
    const str = String(s || '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0') + ':' + str.length;
  }

  /**
   * The one place a status answer becomes a UI phase:
   *   done        → result ready
   *   running     → in progress (real status, no fake percentage)
   *   stale       → still processing — check again (long run, or status unreadable right now)
   *   unavailable → unable to retrieve result (failed / unknown / missing); `retry` says how
   */
  function phase(r) {
    if (!r) return 'stale';
    if (r.ok === false) return ['gateway_down', 'gateway_timeout', 'unreachable', 'timeout'].includes(r.kind) ? 'stale' : 'unavailable';
    if (r.status === 'done' || (r.result && !r.status)) return 'done';
    if (r.status === 'running') return r.stale || r.checkFailed ? 'stale' : 'running';
    return 'unavailable';
  }

  function create({ worker, storage, key, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    async function read() {
      try { return (await storage.get(key))[key] || {}; } catch { return {}; }
    }
    async function write(map) { try { await storage.set({ [key]: map }); } catch {} }

    async function remember(job) {
      if (!job?.cacheId) return;
      const map = await read();
      map[job.cacheId] = { cacheId: job.cacheId, op: job.op, surface: job.surface, kind: job.kind || null,
        textHash: job.textHash, startedAt: job.startedAt || now() };
      await write(map);
    }
    async function forget(cacheId) {
      const map = await read();
      if (map[cacheId]) { delete map[cacheId]; await write(map); }
    }
    /** Jobs for this copy on this surface, newest first; old entries are dropped. */
    async function find(surface, text) {
      const map = await read(), h = textHash(text), t = now();
      let pruned = false;
      for (const [id, j] of Object.entries(map)) if (t - (j.startedAt || 0) > KEEP_MS) { delete map[id]; pruned = true; }
      if (pruned) await write(map);
      return Object.values(map).filter(j => j.surface === surface && j.textHash === h).sort((a, b) => b.startedAt - a.startedAt);
    }
    async function list() { return Object.values(await read()); }

    /** One free status read. */
    function check(cacheId) { return worker({ type: root.PERSADO.MSG.JOB_STATUS, cacheId }); }

    /**
     * Poll until the job leaves "running", the watch times out, or `signal.aborted`.
     * onUpdate(phase, response) fires on every answer. Resolves with the last answer.
     */
    async function watch(cacheId, { onUpdate = () => {}, signal = {}, startedAt = now() } = {}) {
      let i = 0, last = null;
      while (!signal.aborted) {
        last = await check(cacheId);
        if (signal.aborted) break;
        let p = phase(last);
        if (p === 'running' && now() - startedAt > MAX_WATCH_MS) p = 'stale';
        onUpdate(p, last);
        if (p === 'done' || p === 'unavailable') { if (p === 'done') await forget(cacheId); return last; }
        if (p === 'stale' && now() - startedAt > MAX_WATCH_MS) return last;
        await sleep(i < SCHEDULE_MS.length ? SCHEDULE_MS[i++] : STEADY_MS);
      }
      return last;
    }

    /** User-initiated only. `confirmUncertain` acknowledges a possible second charge. */
    function retry(cacheId, { confirmUncertain = false } = {}) {
      return worker({ type: root.PERSADO.MSG.JOB_RETRY, cacheId, confirmUncertain });
    }

    return { remember, forget, find, list, check, watch, retry };
  }

  root.PERSADO_JOBS = Object.freeze({ create, phase, textHash, SCHEDULE_MS, STEADY_MS, MAX_WATCH_MS });
})(typeof self !== 'undefined' ? self : globalThis);
