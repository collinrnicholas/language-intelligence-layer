// ─── Persado Autopilot — Mailchimp adapter ───────────────────────────────────
//
// Reads a DRAFT campaign through the Mailchimp Marketing API, says which of its
// copy may be optimized, writes the chosen rewrites back, and re-reads the draft
// to prove they were saved. It knows nothing about Persado — the optimizer
// (src/optimizer.js) owns that — so the next platform is a new file shaped like
// this one, not a rewrite.
//
// Mailchimp Marketing API v3 (https://mailchimp.com/developer/marketing/api/):
//   Base     https://{dc}.api.mailchimp.com/3.0   (dc = the key's "-us21" suffix)
//   Auth     HTTP Basic, any user name, the API key as password
//   GET   /ping                                   health
//   GET   /?fields=account_name                   account
//   GET   /campaigns?status=save                  drafts
//   GET   /campaigns/{id}                         settings.subject_line / preview_text
//   GET   /campaigns/{id}/content                 html, plain_text
//   PATCH /campaigns/{id}        { settings }     subject line, preview text
//   PUT   /campaigns/{id}/content { html }        body
//   POST  /campaigns/{id}/actions/test            test send (Mailchimp's own flow)
//
// What the API can and cannot do (documented in docs/AUTOPILOT.md):
//   • There is no pre-send hook or webhook for "campaign saved/about to send", so
//     optimization cannot intercept a send. It runs on an explicit action.
//   • Only campaigns in status "save" (draft) are touched — never scheduled,
//     sending or sent ones — and this adapter never calls /actions/send.
//   • Writing `html` replaces the body as custom HTML. For a campaign built in
//     Mailchimp's drag-and-drop builder that can turn it into a code-your-own
//     campaign, so body write-back on builder campaigns is OFF unless the user
//     enables it in Settings. Subject line and preview text are always safe.
//
// Classic script; the API key is passed in and never logged or returned.

(function (root) {
  const G = root.PERSADO_GUARD;
  const SUBJECT_MAX = 150;
  const PREVIEW_MAX = 150;

  class MailchimpError extends Error {
    constructor(kind, message, extra = {}) { super(message); this.name = 'MailchimpError'; this.kind = kind; Object.assign(this, extra); }
  }

  /** "abc123-us21" → "us21". An explicit server prefix wins. */
  function serverPrefixFor(apiKey, override) {
    const o = String(override || '').trim().toLowerCase();
    if (o) {
      if (!/^[a-z]{2,4}\d{1,3}$/.test(o)) throw new MailchimpError('invalid_config', `"${override}" is not a Mailchimp server prefix (it looks like us21).`);
      return o;
    }
    const m = /-([a-z]{2,4}\d{1,3})$/i.exec(String(apiKey || '').trim());
    if (!m) throw new MailchimpError('invalid_config', 'Could not read the server prefix from the key. Enter it in Settings (for example us21).');
    return m[1].toLowerCase();
  }

  /** campaign editor URL → web_id, e.g. /campaigns/edit?id=12345 */
  function webIdFromUrl(url) {
    try {
      const u = new URL(url);
      if (!/(^|\.)admin\.mailchimp\.com$/i.test(u.hostname)) return null;
      if (!/\/campaigns\//i.test(u.pathname)) return null;
      const id = u.searchParams.get('id');
      return id && /^\d+$/.test(id) ? Number(id) : null;
    } catch { return null; }
  }

  function create({ apiKey, serverPrefix, fetchImpl = fetch, allowBodyOnBuilder = false, timeoutMs = 30000 }) {
    if (!apiKey) throw new MailchimpError('no_key', 'Mailchimp is not connected. Add a Mailchimp API key in Settings.');
    const dc = serverPrefixFor(apiKey, serverPrefix);
    const base = `https://${dc}.api.mailchimp.com/3.0`;
    const auth = 'Basic ' + btoa('persado:' + String(apiKey).trim());

    async function call(method, path, body) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let resp;
      try {
        resp = await fetchImpl(base + path, {
          method,
          headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: ac.signal,
        });
      } catch (e) {
        if (e?.name === 'AbortError') throw new MailchimpError('timeout', 'Mailchimp did not answer in time.');
        throw new MailchimpError('unreachable', `Cannot reach ${dc}.api.mailchimp.com. Check the network and the server prefix.`);
      } finally { clearTimeout(timer); }
      if (resp.status === 204) return null;
      let json = null, text = '';
      try { text = await resp.text(); json = text ? JSON.parse(text) : null; } catch {}
      if (!resp.ok) {
        const detail = json?.detail || json?.title || text.slice(0, 200) || `HTTP ${resp.status}`;
        const kind = resp.status === 401 || resp.status === 403 ? 'invalid_key'
          : resp.status === 404 ? 'not_found' : resp.status === 429 ? 'rate_limited'
          : resp.status >= 500 ? 'unavailable' : 'rejected';
        throw new MailchimpError(kind, `Mailchimp: ${detail}`, { status: resp.status, instance: json?.instance || null });
      }
      return json;
    }

    async function test() {
      await call('GET', '/ping');
      const acct = await call('GET', '/?fields=account_name,account_id');
      return { ok: true, dc, accountName: acct?.account_name || '', accountId: acct?.account_id || '' };
    }

    const DRAFT_FIELDS = 'campaigns.id,campaigns.web_id,campaigns.type,campaigns.status,campaigns.content_type,campaigns.create_time,'
      + 'campaigns.settings.title,campaigns.settings.subject_line,campaigns.settings.preview_text,total_items';
    async function listDrafts(count = 25) {
      const r = await call('GET', `/campaigns?status=save&count=${count}&sort_field=create_time&sort_dir=DESC&fields=${DRAFT_FIELDS}`);
      return (r?.campaigns || []).map(c => ({
        id: c.id, webId: c.web_id, type: c.type, status: c.status, contentType: c.content_type,
        createdAt: c.create_time, title: c.settings?.title || '', subject: c.settings?.subject_line || '',
        previewText: c.settings?.preview_text || '',
      }));
    }

    async function findByWebId(webId) {
      const drafts = await listDrafts(100);
      return drafts.find(d => Number(d.webId) === Number(webId)) || null;
    }

    async function getCampaign(id) {
      return call('GET', `/campaigns/${encodeURIComponent(id)}?fields=id,web_id,type,status,content_type,settings`);
    }
    async function getContent(id) {
      return call('GET', `/campaigns/${encodeURIComponent(id)}/content?fields=html,plain_text`);
    }

    /**
     * Read a draft and decide what may be optimized.
     * fields: [{ field, touchpoint, text, maxLength, location }]  — sent to Persado
     * skipped: [{ field, text, reason }]                          — shown, never sent
     */
    async function read(id) {
      const c = await getCampaign(id);
      if (!c) throw new MailchimpError('not_found', 'Campaign not found.');
      if (c.status !== 'save') throw new MailchimpError('not_draft', `This campaign is "${c.status}", not a draft. Only drafts are optimized.`);
      if (c.type !== 'regular') throw new MailchimpError('unsupported', `"${c.type}" campaigns are not supported yet; use a regular e-mail campaign.`);
      const content = await getContent(id);
      const html = content?.html || '';
      const s = c.settings || {};
      const fields = [], skipped = [];
      const consider = (f) => {
        const e = G.eligible(f.text, f.touchpoint);
        if (e.ok) fields.push(f); else skipped.push({ field: f.field, text: f.text, reason: e.reason });
      };
      if (s.subject_line) consider({ field: 'subject_line', touchpoint: 'subject_line', text: s.subject_line, maxLength: SUBJECT_MAX, location: 'settings' });
      else skipped.push({ field: 'subject_line', text: '', reason: 'no subject line yet' });
      if (s.preview_text) consider({ field: 'preview_text', touchpoint: 'preheader', text: s.preview_text, maxLength: PREVIEW_MAX, location: 'settings' });
      else skipped.push({ field: 'preview_text', text: '', reason: 'no preview text yet' });

      const bodyWritable = c.content_type === 'html' || allowBodyOnBuilder;
      const blocks = html ? G.htmlBlocks(html) : [];
      if (html && !bodyWritable) {
        skipped.push({ field: 'body', text: '', reason: `built in Mailchimp's ${c.content_type === 'multichannel' ? 'new' : 'drag-and-drop'} builder — body write-back is off (Settings › Mailchimp)` });
      } else if (html) {
        // One block per Persado touchpoint: the first eligible of each kind.
        const pick = (touchpoint, test, limitFactor) => {
          for (const b of blocks) {
            if (!test(b)) continue;
            const e = G.eligible(b.text, touchpoint);
            if (!e.ok) { if (e.reason !== 'too short to optimize') skipped.push({ field: `body:${b.id}`, text: b.text, reason: e.reason }); continue; }
            const maxLength = Math.max(touchpoint === 'cta' ? 30 : 60, Math.ceil([...b.text].length * limitFactor));
            fields.push({ field: `body:${b.id}`, touchpoint, text: b.text, maxLength, location: 'html', block: b });
            return;
          }
        };
        pick('headline', b => b.kind === 'headline', 1.6);
        pick('subheadline', b => b.kind === 'subheadline', 1.6);
        pick('body', b => b.kind === 'body', 1.5);
        pick('cta', b => b.tag === 'a' && b.cta, 1.6);
      }
      return {
        platform: 'mailchimp',
        ref: { id: c.id, webId: c.web_id, title: s.title || '' },
        contentType: c.content_type,
        settings: { subject_line: s.subject_line || '', preview_text: s.preview_text || '', title: s.title || '', from_name: s.from_name || '', reply_to: s.reply_to || '' },
        html,
        fields, skipped,
        fingerprint: G.hash((s.subject_line || '') + '\u0000' + (s.preview_text || '') + '\u0000' + html),
      };
    }

    function settingsPatch(cur, next) {
      const settings = { subject_line: next.subject_line, preview_text: next.preview_text };
      // Some accounts reject a settings PATCH without these; resend the current values.
      if (cur.title) settings.title = cur.title;
      if (cur.from_name) settings.from_name = cur.from_name;
      if (cur.reply_to) settings.reply_to = cur.reply_to;
      return { settings };
    }

    /**
     * Write accepted changes [{ field, location, text, block? }]. Settings first,
     * then body; if the body write fails the settings are rolled back so the draft
     * is never left half-optimized. Returns { html, settings } as written.
     */
    async function write(draft, changes) {
      const id = draft.ref.id;
      const next = { subject_line: draft.settings.subject_line, preview_text: draft.settings.preview_text };
      let settingsChanged = false;
      for (const c of changes) {
        if (c.field === 'subject_line') { next.subject_line = c.text; settingsChanged = true; }
        if (c.field === 'preview_text') { next.preview_text = c.text; settingsChanged = true; }
      }
      const bodyChanges = changes.filter(c => c.location === 'html').map(c => ({ start: c.block.start, end: c.block.end, raw: c.block.raw, text: c.text }));
      const html = bodyChanges.length ? G.replaceBlocks(draft.html, bodyChanges) : draft.html;
      // Re-check the draft has not been edited since it was read.
      const live = await read(id);
      if (live.fingerprint !== draft.fingerprint) throw new MailchimpError('changed', 'The draft was edited in Mailchimp while Persado was working. Nothing was written; run it again.');
      if (settingsChanged) await call('PATCH', `/campaigns/${encodeURIComponent(id)}`, settingsPatch(draft.settings, next));
      if (bodyChanges.length) {
        try { await call('PUT', `/campaigns/${encodeURIComponent(id)}/content`, { html }); }
        catch (e) {
          if (settingsChanged) {
            try { await call('PATCH', `/campaigns/${encodeURIComponent(id)}`, settingsPatch(draft.settings, draft.settings)); }
            catch (re) { e.message += ' The subject line/preview text could not be rolled back — use Revert.'; }
          }
          throw e;
        }
      }
      return { html, settings: next };
    }

    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    /** Re-read the draft and confirm every written change is there. */
    async function verify(draft, changes) {
      const c = await getCampaign(draft.ref.id);
      const content = changes.some(x => x.location === 'html') ? await getContent(draft.ref.id) : null;
      const blocks = content?.html ? G.htmlBlocks(content.html) : [];
      const results = changes.map(ch => {
        let saved = false;
        if (ch.field === 'subject_line') saved = norm(c?.settings?.subject_line) === norm(ch.text);
        else if (ch.field === 'preview_text') saved = norm(c?.settings?.preview_text) === norm(ch.text);
        else saved = blocks.some(b => norm(b.text) === norm(ch.text));
        return { field: ch.field, saved };
      });
      return { ok: results.every(r => r.saved), results, status: c?.status || null };
    }

    /** Put a snapshot back exactly as it was read. */
    async function restore(snapshot) {
      const c = await getCampaign(snapshot.id);
      if (c?.status !== 'save') throw new MailchimpError('not_draft', 'The campaign is no longer a draft, so it was not changed.');
      await call('PATCH', `/campaigns/${encodeURIComponent(snapshot.id)}`, settingsPatch(c.settings || {}, snapshot.settings));
      if (snapshot.bodyWritten) await call('PUT', `/campaigns/${encodeURIComponent(snapshot.id)}/content`, { html: snapshot.html });
      return { ok: true };
    }

    /** Mailchimp's own test send — to the addresses given, never to the list. */
    async function sendTest(id, emails) {
      const list = (emails || []).map(e => String(e).trim()).filter(Boolean);
      if (!list.length) throw new MailchimpError('invalid_config', 'Add a test e-mail address in Settings first.');
      if (list.some(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) throw new MailchimpError('invalid_config', 'One of the test addresses is not an e-mail address.');
      await call('POST', `/campaigns/${encodeURIComponent(id)}/actions/test`, { test_emails: list, send_type: 'html' });
      return { ok: true, sentTo: list };
    }

    return { id: 'mailchimp', label: 'Mailchimp', dc, channel: 'EMAIL_SUBJECT_BODY', test, listDrafts, findByWebId, read, write, verify, restore, sendTest };
  }

  root.PERSADO_ADAPTERS = Object.freeze({ ...(root.PERSADO_ADAPTERS || {}),
    mailchimp: Object.freeze({ create, serverPrefixFor, webIdFromUrl, MailchimpError, SUBJECT_MAX, PREVIEW_MAX }) });
})(typeof self !== 'undefined' ? self : globalThis);
