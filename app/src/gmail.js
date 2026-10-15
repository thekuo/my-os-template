// B37 P2: Gmail collector. A Worker cron mirrors recent mail metadata (plus a short-lived clipped body)
// into D1 using the history API. Read-only toward Gmail (gmail.readonly).
// Built to fit the Workers free plan: message gets go through the batch endpoint (one subrequest per
// batch), parsing is cheap, and every chunk commits on its own with the cursor in the same D1 batch.
import { mintGoogleToken } from './gcal.js';

const SOURCE = 'gmail_sync';
const SCOPE = 'me';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH_URL = 'https://www.googleapis.com/batch/gmail/v1';
const BATCH_SIZE = 10; // gets per batch request; Gmail runs a batch's items in parallel and limits per-user concurrency
const RETRY_MAX = 500; // message ids kept for retry in the cursor state
const MAX_PAGES = 5; // list/history pages per run
const BODY_MAX = 4000;
const HTML_SCAN_MAX = 20000;
const ROWS_PER_STMT = 20;
const DAY = 86400000;
const BODYLESS = new Set(['promotions', 'social']);
const CATEGORIES = { CATEGORY_PERSONAL: 'primary', CATEGORY_SOCIAL: 'social', CATEGORY_PROMOTIONS: 'promotions', CATEGORY_UPDATES: 'updates', CATEGORY_FORUMS: 'forums' };

// Default update rules (generic). MAIL_RULES entries are checked first, then these, in this order.
const DEFAULT_RULES = [
  { kind: 'bills', re: /\b(bill|invoice|statement|payment due|amount due|past due|autopay|auto-pay|receipt|your payment)\b/i },
  { kind: 'appointments', re: /\b(appointment|reservation|booking|booked|confirmed for|check-in|reminder:)/i, ics: true },
  { kind: 'security', re: /\b(security alert|sign-in|sign in attempt|new sign-in|new device|verification code|password reset|reset your password|2-step|two-factor)\b/i },
  { kind: 'travel', re: /\b(flight|itinerary|boarding pass|check in for your|hotel|rental car|e-ticket)\b/i },
];

function jsonList(v) {
  if (!v) return [];
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch (e) { return []; }
}

export function mailConfig(env) {
  const int = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };
  return {
    configured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN),
    backfillDays: int(env.MAIL_BACKFILL_DAYS, 14, 1, 90),
    maxFetch: int(env.MAIL_MAX_FETCH, 40, 1, 500),
    lanes: jsonList(env.MAIL_LANES),
    rules: jsonList(env.MAIL_RULES),
  };
}

// Pattern match for lanes and custom rules: from entries are address substrings ("@domain" = domain suffix),
// subject entries are case-insensitive substrings
function matches(rule, from, subject) {
  const f = (from || '').toLowerCase(), s = (subject || '').toLowerCase();
  const fromHit = Array.isArray(rule.from) && rule.from.some(p => { p = String(p).toLowerCase(); return p.startsWith('@') ? f.endsWith(p) : f.includes(p); });
  const subjHit = Array.isArray(rule.subject) && rule.subject.some(p => s.includes(String(p).toLowerCase()));
  return fromHit || subjHit;
}

export function classify(cfg, { from_addr, subject, has_invite }) {
  const laneRule = cfg.lanes.find(l => l && l.lane && matches(l, from_addr, subject));
  let kind = null;
  const custom = cfg.rules.find(r => r && r.kind && matches(r, from_addr, subject));
  if (custom) kind = String(custom.kind).slice(0, 40);
  else {
    const d = DEFAULT_RULES.find(r => r.re.test(subject || '') || (r.ics && has_invite));
    if (d) kind = d.kind;
  }
  return { lane: laneRule ? String(laneRule.lane).slice(0, 40) : null, update_kind: kind };
}

// ---- MIME helpers (cheap) ----
function b64urlDecode(data) {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function htmlToText(html) {
  return html.slice(0, HTML_SCAN_MAX)
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

function cleanBody(text) {
  let t = text.replace(/\r\n/g, '\n');
  // Cut quoted history where it's easy to spot
  const cut = t.search(/\n(On [^\n]{0,200}wrote:|-{2,} ?Original Message ?-{2,}|From: [^\n]+\nSent: )/);
  if (cut > 0) t = t.slice(0, cut);
  t = t.split('\n').filter(l => !l.startsWith('>')).join('\n');
  return t.replace(/\n{3,}/g, '\n\n').trim().slice(0, BODY_MAX);
}

// Walk the payload once: first text/plain, first text/html, attachments, calendar invites
function scanParts(payload) {
  const out = { plain: null, html: null, attachments: false, invite: false };
  const stack = [payload];
  let guard = 0;
  while (stack.length && guard++ < 200) {
    const p = stack.shift();
    if (!p) continue;
    const mt = (p.mimeType || '').toLowerCase();
    if (p.filename) { out.attachments = true; if (/\.ics$/i.test(p.filename)) out.invite = true; }
    if (mt === 'text/calendar') out.invite = true;
    if (!p.filename && p.body && p.body.data) {
      if (mt === 'text/plain' && out.plain === null) out.plain = p.body.data;
      else if (mt === 'text/html' && out.html === null) out.html = p.body.data;
    }
    if (Array.isArray(p.parts)) stack.push(...p.parts);
  }
  return out;
}

const header = (headers, name) => { const h = (headers || []).find(x => x.name && x.name.toLowerCase() === name); return h ? h.value : null; };
function parseFrom(v) {
  if (!v) return { addr: null, name: null };
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { addr: m[2].trim().toLowerCase(), name: m[1].trim() || null };
  return { addr: v.trim().toLowerCase(), name: null };
}
const addrs = (v) => (v ? (v.match(/[^\s<>,"';:]+@[^\s<>,"';:]+/g) || []).map(a => a.toLowerCase()) : []);

function flags(labels) {
  const has = (l) => labels.includes(l);
  const cat = labels.map(l => CATEGORIES[l]).find(Boolean) || 'primary'; // no category label = Primary
  return {
    labels, category: cat, direction: has('SENT') ? 'out' : 'in',
    is_read: has('UNREAD') ? 0 : 1, is_archived: has('INBOX') ? 0 : 1, is_trashed: has('TRASH') ? 1 : 0,
    is_spam: has('SPAM') ? 1 : 0, is_starred: has('STARRED') ? 1 : 0,
  };
}

// Gmail message (format=full) -> row
export function parseMessage(m, cfg, nowMs = Date.now()) {
  const labels = Array.isArray(m.labelIds) ? m.labelIds : [];
  const hs = (m.payload && m.payload.headers) || [];
  const from = parseFrom(header(hs, 'from'));
  const subject = (header(hs, 'subject') || '').slice(0, 300) || null;
  const ts = new Date(Number(m.internalDate) || nowMs).toISOString();
  const f = flags(labels);
  const scan = scanParts(m.payload || {});
  let body = null;
  if (!BODYLESS.has(f.category) && Date.parse(ts) > nowMs - 30 * DAY) {
    try {
      if (scan.plain) body = cleanBody(b64urlDecode(scan.plain));
      else if (scan.html) body = cleanBody(htmlToText(b64urlDecode(scan.html)));
    } catch (e) { body = null; }
    if (body === '') body = null;
  }
  const cls = classify(cfg, { from_addr: from.addr, subject, has_invite: scan.invite });
  return {
    msg_id: m.id, thread_id: m.threadId || null, ts,
    from_addr: from.addr ? from.addr.slice(0, 200) : null, from_name: from.name ? from.name.slice(0, 120) : null,
    to_addrs: addrs(header(hs, 'to')).slice(0, 10), cc_count: addrs(header(hs, 'cc')).length,
    subject, snippet: m.snippet ? String(m.snippet).slice(0, 300) : null, body_text: body,
    ...f, has_attachments: scan.attachments ? 1 : 0, has_invite: scan.invite ? 1 : 0,
    list_unsubscribe: header(hs, 'list-unsubscribe') ? 1 : 0, ...cls,
  };
}

// ---- Gmail API ----
class GoneError extends Error {}
// A Google API error with its status and reason (e.g. userRateLimitExceeded, insufficientPermissions)
class GmailError extends Error {
  constructor(what, status, reason) { super(`${what} ${status}${reason ? ' ' + reason : ''}`); this.status = status; this.reason = reason; }
  get rateLimited() { return isRate(this.status, this.reason); }
}
const isRate = (status, reason) => status === 429 || (status === 403 && /rate|concurrent|RESOURCE_EXHAUSTED/i.test(reason || ''));
const reasonOf = (j) => { const e = (j && j.error) || {}; return (Array.isArray(e.errors) && e.errors[0] && e.errors[0].reason) || e.status || null; };

async function gget(token, path) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) throw new GoneError('not found');
  if (!res.ok) throw new GmailError(`gmail ${path.split('?')[0]}`, res.status, reasonOf(await res.json().catch(() => null)));
  return res.json();
}

// Fetch messages through the batch endpoint, BATCH_SIZE per request, sequentially.
// Returns { got: Map id -> message, retry: [ids that failed with a retryable error], reason }.
// Missing (404) ids were deleted since and are dropped. A rate limit stops further batches (the rest go to retry).
async function batchGet(token, ids) {
  const got = new Map(), retry = [];
  let reason = null;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const slice = ids.slice(i, i + BATCH_SIZE);
    if (reason) { retry.push(...slice); continue; }
    const boundary = 'b' + Math.random().toString(36).slice(2);
    const body = slice.map(id =>
      `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <m-${id}>\r\n\r\nGET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full\r\n\r\n`
    ).join('') + `--${boundary}--`;
    const res = await fetch(BATCH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/mixed; boundary=${boundary}` },
      body,
    });
    if (!res.ok) {
      const err = new GmailError('gmail batch', res.status, reasonOf(await res.json().catch(() => null)));
      if (!err.rateLimited && res.status < 500) throw err;
      reason = err.reason || `http ${res.status}`; retry.push(...slice); continue;
    }
    const m = (res.headers.get('content-type') || '').match(/boundary="?([^";]+)"?/i);
    if (!m) throw new Error('gmail batch: no boundary');
    const text = await res.text();
    const seen = new Set();
    for (const part of text.split('--' + m[1])) {
      const st = part.match(/HTTP\/1\.1 (\d{3})/);
      if (!st) continue;
      const cid = part.match(/Content-ID:\s*<?response-m-([^>\s]+)>?/i);
      const id = cid ? decodeURIComponent(cid[1]) : null;
      const code = Number(st[1]);
      const j = part.indexOf('{', st.index), k = part.lastIndexOf('}');
      let json = null;
      if (j >= 0 && k > j) { try { json = JSON.parse(part.slice(j, k + 1)); } catch (e) { json = null; } }
      if (id) seen.add(id);
      if (code === 404) continue;
      if (code !== 200) {
        const r = reasonOf(json);
        if (isRate(code, r) || code >= 500) { if (id) retry.push(id); reason = reason || r || `http ${code}`; continue; }
        throw new GmailError('gmail batch item', code, r);
      }
      if (json && json.id) got.set(id || json.id, json);
    }
    for (const id of slice) if (!seen.has(id) && !got.has(id)) retry.push(id); // no part came back for it
  }
  return { got, retry, reason };
}

const RATE_RE = /rate|concurrent|RESOURCE_EXHAUSTED|429/i;
const retryMessage = (reason) => `${RATE_RE.test(reason) ? 'rate limited' : 'temporary Gmail error'}, will retry (${reason})`;
const mergeRetry = (...lists) => [...new Set(lists.flat().filter(Boolean))].slice(0, RETRY_MAX);
const parseState = (cur) => { try { return cur && cur.state ? JSON.parse(cur.state) : null; } catch (e) { return null; } };

// Drafts change on every save; they are not mail yet
const notDraft = (m) => !(m.labelIds || []).includes('DRAFT');

// ---- D1 writes ----
// rows the upsert statements actually wrote (D1 reports changes per statement; the upserts come first in each batch)
const storedOf = (results, n) => (results || []).slice(0, n).reduce((a, r) => a + Number((r && r.meta && r.meta.changes) || 0), 0);
const chunked = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

function upsertStmts(DB, rows, nowIso) {
  return chunked(rows, ROWS_PER_STMT).map(c => DB.prepare(
    `INSERT INTO mail_messages (tenant_id, msg_id, thread_id, ts, direction, from_addr, from_name, to_addrs, cc_count, subject, snippet, body_text, body_purged_at,
       labels, category, is_read, is_archived, is_trashed, is_spam, is_starred, has_attachments, has_invite, list_unsubscribe, lane, update_kind, first_seen, last_seen, deleted_at)
     SELECT 'owner', json_extract(value, '$.msg_id'), json_extract(value, '$.thread_id'), json_extract(value, '$.ts'), json_extract(value, '$.direction'),
       json_extract(value, '$.from_addr'), json_extract(value, '$.from_name'), json_extract(value, '$.to_addrs'), json_extract(value, '$.cc_count'),
       json_extract(value, '$.subject'), json_extract(value, '$.snippet'), json_extract(value, '$.body_text'), NULL,
       json_extract(value, '$.labels'), json_extract(value, '$.category'), json_extract(value, '$.is_read'), json_extract(value, '$.is_archived'),
       json_extract(value, '$.is_trashed'), json_extract(value, '$.is_spam'), json_extract(value, '$.is_starred'), json_extract(value, '$.has_attachments'),
       json_extract(value, '$.has_invite'), json_extract(value, '$.list_unsubscribe'), json_extract(value, '$.lane'), json_extract(value, '$.update_kind'), ?1, ?1, NULL
     FROM json_each(?2) WHERE true
     ON CONFLICT(tenant_id, msg_id) DO UPDATE SET thread_id = excluded.thread_id, ts = excluded.ts, direction = excluded.direction, from_addr = excluded.from_addr,
       from_name = excluded.from_name, to_addrs = excluded.to_addrs, cc_count = excluded.cc_count, subject = excluded.subject, snippet = excluded.snippet,
       body_text = excluded.body_text, body_purged_at = NULL, labels = excluded.labels, category = excluded.category, is_read = excluded.is_read,
       is_archived = excluded.is_archived, is_trashed = excluded.is_trashed, is_spam = excluded.is_spam, is_starred = excluded.is_starred,
       has_attachments = excluded.has_attachments, has_invite = excluded.has_invite, list_unsubscribe = excluded.list_unsubscribe, lane = excluded.lane,
       update_kind = excluded.update_kind, last_seen = excluded.last_seen, deleted_at = NULL`
  ).bind(nowIso, JSON.stringify(c)));
}

function labelStmts(DB, updates, nowIso) {
  return chunked(updates, 100).map(c => DB.prepare(
    `UPDATE mail_messages SET labels = json_extract(j.value, '$.labels'), category = json_extract(j.value, '$.category'), direction = json_extract(j.value, '$.direction'),
       is_read = json_extract(j.value, '$.is_read'), is_archived = json_extract(j.value, '$.is_archived'), is_trashed = json_extract(j.value, '$.is_trashed'),
       is_spam = json_extract(j.value, '$.is_spam'), is_starred = json_extract(j.value, '$.is_starred'), last_seen = ?1
     FROM json_each(?2) AS j WHERE mail_messages.tenant_id = 'owner' AND mail_messages.msg_id = json_extract(j.value, '$.msg_id')`
  ).bind(nowIso, JSON.stringify(c)));
}

function deleteStmts(DB, ids, nowIso) {
  return chunked(ids, 200).map(c => DB.prepare(
    `UPDATE mail_messages SET deleted_at = ?1, body_text = NULL, snippet = NULL, body_purged_at = COALESCE(body_purged_at, ?1), last_seen = ?1
     WHERE tenant_id = 'owner' AND deleted_at IS NULL AND msg_id IN (SELECT value FROM json_each(?2))`
  ).bind(nowIso, JSON.stringify(c)));
}

function cursorStmt(DB, cursor, state, nowIso) {
  return DB.prepare(
    `INSERT INTO sync_cursors (tenant_id, source, scope, cursor, state, last_ok, last_attempt, last_error) VALUES ('owner', ?1, ?2, ?3, ?4, ?5, ?5, NULL)
     ON CONFLICT(tenant_id, source, scope) DO UPDATE SET cursor = excluded.cursor, state = excluded.state, last_ok = excluded.last_ok,
       last_attempt = excluded.last_attempt, last_error = NULL`
  ).bind(SOURCE, SCOPE, cursor, state ? JSON.stringify(state) : null, nowIso);
}

// ---- Sync ----
// Every write below commits the cursor and the retry list (st.retry) in the same D1 batch. A rate limit
// (st.rate) ends the run after the current commit; the next run retries the failed ids first.

// Fetch ids kept from earlier rate-limited runs
async function retryPending(env, token, cfg, cur, st) {
  const state = parseState(cur) || {};
  const ids = st.retry.slice(0, Math.max(st.budget, 0));
  if (!ids.length) return;
  const { got, retry, reason } = await batchGet(token, ids);
  const nowIso = new Date().toISOString();
  const rows = [...got.values()].filter(notDraft).map(m => parseMessage(m, cfg));
  st.retry = mergeRetry(retry, st.retry.slice(ids.length));
  st.fetched += ids.length - retry.length; st.added += rows.length; st.retried += got.size; st.budget -= ids.length;
  if (reason) st.rate = reason;
  const next = { ...state, retry: st.retry };
  const ups = upsertStmts(env.DB, rows, nowIso);
  st.stored += storedOf(await env.DB.batch([...ups, cursorStmt(env.DB, cur ? cur.cursor : null, stateOrNull(next), nowIso)]), ups.length);
}
const stateOrNull = (s) => { const out = { ...s }; if (!out.retry || !out.retry.length) delete out.retry; return Object.keys(out).length ? out : null; };

async function backfill(env, token, cfg, cur, st) {
  const DB = env.DB;
  let state = parseState(cur);
  if (!state || !state.history_id) {
    const prof = await gget(token, '/profile');
    state = { history_id: String(prof.historyId), page: null, fetched: 0 };
  }
  for (let pages = 0; pages < MAX_PAGES && st.budget > 0 && !st.rate; pages++) {
    const q = new URLSearchParams({ q: `newer_than:${cfg.backfillDays}d`, maxResults: String(Math.min(st.budget, 500)) });
    if (state.page) q.set('pageToken', state.page);
    const list = await gget(token, '/messages?' + q);
    st.pages++;
    const ids = (list.messages || []).map(m => m.id);
    const { got, retry, reason } = await batchGet(token, ids);
    const nowIso = new Date().toISOString();
    const rows = [...got.values()].filter(notDraft).map(m => parseMessage(m, cfg));
    st.fetched += ids.length - retry.length; st.added += rows.length; st.budget -= ids.length;
    st.retry = mergeRetry(st.retry, retry);
    if (reason) st.rate = reason;
    // Failed ids go to the retry list, so the page can still advance. Done -> the cursor is the historyId read before the backfill.
    const next = list.nextPageToken ? { ...state, page: list.nextPageToken, fetched: (state.fetched || 0) + ids.length, retry: st.retry } : null;
    const ups = upsertStmts(DB, rows, nowIso);
    st.stored += storedOf(await DB.batch([...ups, cursorStmt(DB, next ? null : state.history_id, next ? stateOrNull(next) : stateOrNull({ retry: st.retry }), nowIso)]), ups.length);
    if (!next) { st.backfill_done = true; return; }
    state = next;
  }
}

async function incremental(env, token, cfg, cur, st) {
  const DB = env.DB;
  const start = cur.cursor; // pageToken belongs to the original query, so startHistoryId stays fixed across pages
  let pageToken = null;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    if (pages > 0 && (st.budget <= 0 || st.rate)) return; // the previous page's cursor is already committed
    const q = new URLSearchParams({ startHistoryId: start, maxResults: '500' });
    for (const t of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) q.append('historyTypes', t);
    if (pageToken) q.set('pageToken', pageToken);
    const res = await gget(token, '/history?' + q); // 404 -> GoneError
    st.pages++;
    const records = res.history || [];
    // Walk records in order; stop at a record boundary when the fetch budget runs out
    const toFetch = new Set(), deleted = new Set(), labelled = new Map();
    let lastId = null, stopped = false;
    for (const rec of records) {
      const adds = (rec.messagesAdded || []).map(x => x.message).filter(m => m && m.id && !toFetch.has(m.id));
      if (adds.length && toFetch.size + adds.length > st.budget && lastId !== null) { stopped = true; break; }
      for (const m of adds) { toFetch.add(m.id); deleted.delete(m.id); }
      for (const x of rec.messagesDeleted || []) if (x.message && x.message.id) { deleted.add(x.message.id); toFetch.delete(x.message.id); labelled.delete(x.message.id); }
      for (const x of [...(rec.labelsAdded || []), ...(rec.labelsRemoved || [])]) {
        const m = x.message;
        if (m && m.id && Array.isArray(m.labelIds) && !deleted.has(m.id)) labelled.set(m.id, m.labelIds); // latest full label list wins
      }
      lastId = rec.id;
    }
    const { got, retry, reason } = await batchGet(token, [...toFetch]);
    const nowIso = new Date().toISOString();
    const rows = [...got.values()].filter(notDraft).map(m => parseMessage(m, cfg));
    const labelUpdates = [...labelled].filter(([id]) => !got.has(id)).map(([id, labels]) => ({ msg_id: id, ...flags(labels) }));
    st.retry = mergeRetry(st.retry.filter(id => !deleted.has(id)), retry);
    if (reason) st.rate = reason;
    const done = stopped || !res.nextPageToken;
    const cursor = stopped ? String(lastId) : (done ? String(res.historyId || lastId || cur.cursor) : String(lastId || cur.cursor));
    const ups = upsertStmts(DB, rows, nowIso);
    st.stored += storedOf(await DB.batch([...ups, ...labelStmts(DB, labelUpdates, nowIso), ...deleteStmts(DB, [...deleted], nowIso),
      cursorStmt(DB, cursor, stateOrNull({ retry: st.retry }), nowIso)]), ups.length);
    cur = { ...cur, cursor };
    st.fetched += toFetch.size - retry.length; st.added += rows.length; st.label_changes += labelUpdates.length; st.deleted += deleted.size; st.budget -= toFetch.size;
    if (done) return;
    pageToken = res.nextPageToken;
  }
}

async function setHealth(DB, { ok, error }) {
  const nowIso = new Date().toISOString();
  await DB.prepare(
    `INSERT INTO source_health (tenant_id, source, last_ok, last_attempt, last_error, stale_after_hours) VALUES ('owner', ?, ?, ?, ?, 1)
     ON CONFLICT(tenant_id, source) DO UPDATE SET last_ok = COALESCE(excluded.last_ok, last_ok), last_attempt = excluded.last_attempt, last_error = excluded.last_error`
  ).bind(SOURCE, ok ? nowIso : null, nowIso, error || null).run();
}

async function cursorError(DB, msg) {
  await DB.prepare(
    `INSERT INTO sync_cursors (tenant_id, source, scope, last_attempt, last_error) VALUES ('owner', ?, ?, ?, ?)
     ON CONFLICT(tenant_id, source, scope) DO UPDATE SET last_attempt = excluded.last_attempt, last_error = excluded.last_error`
  ).bind(SOURCE, SCOPE, new Date().toISOString(), msg).run();
}

// Cron entry point. emit(kind, props) logs telemetry. Never throws on Gmail errors.
// Rate limits are not failures: the run stops cleanly, keeps its cursor, and records "rate limited, will retry".
export async function runMailSync(env, { emit = () => {} } = {}) {
  const cfg = mailConfig(env);
  if (!cfg.configured) { await setHealth(env.DB, { ok: false, error: 'not configured' }); return { configured: false }; }
  const started = Date.now();
  const st = { mode: null, budget: cfg.maxFetch, fetched: 0, added: 0, stored: 0, retried: 0, label_changes: 0, deleted: 0, pages: 0, retry: [], rate: null };
  const summary = () => {
    const { budget, retry, rate, ...out } = st;
    out.pending_retry = retry.length;
    if (rate) { out.retry_later = true; out.rate_limited = RATE_RE.test(rate); out.reason = rate; }
    out.ms = Date.now() - started;
    return out;
  };
  try {
    const tok = await mintGoogleToken(env);
    if (!String(tok.scope || '').split(' ').includes(GMAIL_SCOPE)) throw new Error('gmail scope not granted (re-run the token script with --scopes calendar,gmail)');
    let cur = await env.DB.prepare("SELECT * FROM sync_cursors WHERE tenant_id = 'owner' AND source = ? AND scope = ?").bind(SOURCE, SCOPE).first();
    st.retry = mergeRetry((parseState(cur) || {}).retry || []);
    if (st.retry.length) {
      await retryPending(env, tok.access_token, cfg, cur, st);
      cur = await env.DB.prepare("SELECT * FROM sync_cursors WHERE tenant_id = 'owner' AND source = ? AND scope = ?").bind(SOURCE, SCOPE).first();
    }
    if (st.rate || st.budget <= 0) st.mode = st.mode || 'retry';
    else if (cur && cur.cursor) {
      st.mode = 'incremental';
      try { await incremental(env, tok.access_token, cfg, cur, st); }
      catch (e) {
        if (!(e instanceof GoneError)) throw e;
        // History expired: restart the bounded backfill (upserts are idempotent; the retry list is kept)
        st.mode = 'resync';
        await env.DB.prepare("UPDATE sync_cursors SET cursor = NULL, state = ? WHERE tenant_id = 'owner' AND source = ? AND scope = ?")
          .bind(st.retry.length ? JSON.stringify({ retry: st.retry }) : null, SOURCE, SCOPE).run();
        await backfill(env, tok.access_token, cfg, null, st);
      }
    } else {
      st.mode = 'backfill';
      await backfill(env, tok.access_token, cfg, cur, st);
    }
    const out = summary();
    if (st.rate) {
      const msg = retryMessage(st.rate);
      await cursorError(env.DB, msg);
      await setHealth(env.DB, { ok: false, error: msg });
    } else if (st.stored < st.added) {
      // parsed messages the database did not keep: a silent write failure must not read as healthy
      await setHealth(env.DB, { ok: false, error: `fetched ${st.added} messages, stored ${st.stored}` });
      out.store_short = true;
    } else await setHealth(env.DB, { ok: true });
    if (out.added || out.label_changes || out.deleted || out.retry_later || out.store_short || out.mode !== 'incremental') emit('mail_sync', out);
    return { configured: true, ...out };
  } catch (e) {
    // A rate limit on a list/history/profile call: nothing for this step was written, the cursor is unchanged
    if (e instanceof GmailError && e.rateLimited) {
      st.rate = e.reason || String(e.status);
      const out = summary();
      const msg = retryMessage(st.rate);
      await cursorError(env.DB, msg);
      await setHealth(env.DB, { ok: false, error: msg });
      emit('mail_sync', out);
      return { configured: true, ...out };
    }
    const msg = String(e.message || e).slice(0, 300);
    await cursorError(env.DB, msg);
    await setHealth(env.DB, { ok: false, error: msg });
    emit('mail_sync', { mode: st.mode, error: msg.slice(0, 120), fetched: st.fetched, ...(e.reason ? { reason: e.reason } : {}) });
    return { configured: true, mode: st.mode, error: msg, ...(e.reason ? { reason: e.reason } : {}), fetched: st.fetched, added: st.added };
  }
}

// Daily retention: bodies after 30 days, metadata after 365, tombstones after 90
export async function purgeMail(env) {
  const now = Date.now(), iso = (d) => new Date(now - d * DAY).toISOString(), nowIso = new Date(now).toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE mail_messages SET body_text = NULL, body_purged_at = ? WHERE tenant_id = 'owner' AND body_text IS NOT NULL AND ts < ?").bind(nowIso, iso(30)),
    env.DB.prepare("DELETE FROM mail_messages WHERE tenant_id = 'owner' AND ts < ?").bind(iso(365)),
    env.DB.prepare("DELETE FROM mail_messages WHERE tenant_id = 'owner' AND deleted_at IS NOT NULL AND deleted_at < ?").bind(iso(90)),
  ]);
}

// Re-apply lanes and rules to stored rows (after MAIL_LANES / MAIL_RULES change)
export async function retagMail(env) {
  const cfg = mailConfig(env);
  const rows = (await env.DB.prepare("SELECT msg_id, from_addr, subject, has_invite, lane, update_kind FROM mail_messages WHERE tenant_id = 'owner'").all()).results || [];
  const changed = [];
  for (const r of rows) {
    const c = classify(cfg, r);
    if (c.lane !== r.lane || c.update_kind !== r.update_kind) changed.push({ msg_id: r.msg_id, ...c });
  }
  const stmts = chunked(changed, 200).map(c => env.DB.prepare(
    `UPDATE mail_messages SET lane = json_extract(j.value, '$.lane'), update_kind = json_extract(j.value, '$.update_kind')
     FROM json_each(?1) AS j WHERE mail_messages.tenant_id = 'owner' AND mail_messages.msg_id = json_extract(j.value, '$.msg_id')`
  ).bind(JSON.stringify(c)));
  if (stmts.length) await env.DB.batch(stmts);
  return { scanned: rows.length, changed: changed.length };
}

// ---- Agent views ----
function rowOut(r, withBody) {
  const out = {
    msg_id: r.msg_id, thread_id: r.thread_id, ts: r.ts, direction: r.direction, from_addr: r.from_addr, from_name: r.from_name,
    to_addrs: jsonList(r.to_addrs), cc_count: r.cc_count, subject: r.subject, snippet: r.snippet, labels: jsonList(r.labels), category: r.category,
    is_read: !!r.is_read, is_archived: !!r.is_archived, is_trashed: !!r.is_trashed, is_spam: !!r.is_spam, is_starred: !!r.is_starred,
    has_attachments: !!r.has_attachments, has_invite: !!r.has_invite, list_unsubscribe: !!r.list_unsubscribe, lane: r.lane, update_kind: r.update_kind,
    deleted_at: r.deleted_at, body_purged_at: r.body_purged_at,
  };
  if (withBody) out.body_text = r.body_text;
  return out;
}

// GET /api/agent/mail/messages
export async function mailMessages(env, url) {
  const p = url.searchParams;
  let since = new Date(Date.now() - 2 * DAY).toISOString();
  if (p.get('since')) { const t = Date.parse(p.get('since')); if (isNaN(t)) return { status: 400, body: { error: 'Invalid since' } }; since = new Date(t).toISOString(); }
  let limit = 200;
  if (p.has('limit')) { limit = parseInt(p.get('limit'), 10); if (!(limit >= 1)) return { status: 400, body: { error: 'Invalid limit' } }; limit = Math.min(limit, 1000); }
  let sql = "SELECT * FROM mail_messages WHERE tenant_id = 'owner' AND ts >= ?";
  const b = [since];
  for (const k of ['lane', 'update_kind', 'category']) if (p.get(k)) { sql += ` AND ${k} = ?`; b.push(p.get(k)); }
  if (p.get('direction')) {
    if (!['in', 'out'].includes(p.get('direction'))) return { status: 400, body: { error: 'direction must be in or out' } };
    sql += ' AND direction = ?'; b.push(p.get('direction'));
  }
  if (p.get('unread') === '1') sql += ' AND is_read = 0';
  if (p.get('q')) { sql += " AND (lower(subject) LIKE ? OR lower(from_addr) LIKE ? OR lower(from_name) LIKE ?)"; const like = '%' + p.get('q').toLowerCase().slice(0, 100) + '%'; b.push(like, like, like); }
  if (p.get('include_deleted') !== '1') sql += ' AND deleted_at IS NULL';
  if (p.get('include_trash') !== '1') sql += ' AND is_trashed = 0 AND is_spam = 0';
  sql += ' ORDER BY ts DESC LIMIT ?'; b.push(limit);
  const rows = (await env.DB.prepare(sql).bind(...b).all()).results || [];
  const withBody = p.get('include_body') === '1';
  return { status: 200, body: { since, count: rows.length, messages: rows.map(r => rowOut(r, withBody)) } };
}

// GET /api/agent/mail/threads/:id
export async function mailThread(env, threadId, url) {
  const rows = (await env.DB.prepare("SELECT * FROM mail_messages WHERE tenant_id = 'owner' AND thread_id = ? ORDER BY ts ASC LIMIT 500").bind(threadId).all()).results || [];
  if (!rows.length) return { status: 404, body: { error: 'Not found' } };
  const withBody = url.searchParams.get('include_body') === '1';
  return { status: 200, body: { thread_id: threadId, count: rows.length, messages: rows.map(r => rowOut(r, withBody)) } };
}
