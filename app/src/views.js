// B37 P4: read views over the collected stores (mail_messages, chat items, calendar_changes) for agents.
const DAY = 86400000, HOUR = 3600000;

const parse = (s) => { if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; } };
const ageHours = (ts, now) => Math.round((now - Date.parse(ts)) / 360000) / 10;
// Senders that never expect a reply
export const AUTOMATED_SQL = "(from_addr LIKE '%noreply%' OR from_addr LIKE '%no-reply%' OR from_addr LIKE '%donotreply%' OR from_addr LIKE '%do-not-reply%' OR from_addr LIKE 'notifications@%' OR from_addr LIKE 'mailer-daemon@%')";

function intParam(url, name, def, lo, hi) {
  if (!url.searchParams.has(name)) return def;
  const n = Number(url.searchParams.get(name));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
}

// Latest message of each mail thread in the window (not deleted / trashed / spam)
async function latestMail(env, sinceIso) {
  const rows = (await env.DB.prepare(
    `SELECT m.* FROM mail_messages m
     JOIN (SELECT thread_id, MAX(ts) AS ts FROM mail_messages WHERE tenant_id = 'owner' AND deleted_at IS NULL AND is_trashed = 0 AND is_spam = 0 AND ts >= ? GROUP BY thread_id) l
       ON m.thread_id = l.thread_id AND m.ts = l.ts
     WHERE m.tenant_id = 'owner' AND m.deleted_at IS NULL AND m.is_trashed = 0 AND m.is_spam = 0`
  ).bind(sinceIso).all()).results || [];
  // Two messages can share a thread's max ts; keep one per thread
  const seen = new Set();
  return rows.filter(r => (seen.has(r.thread_id) ? false : seen.add(r.thread_id)));
}

// Latest item of each collected chat in the window (items whose meta has a chat_id)
async function latestChats(env, sinceIso) {
  const rows = (await env.DB.prepare(
    `SELECT i.* FROM items i
     WHERE i.tenant_id = 'owner' AND i.removed_at IS NULL AND i.ts >= ? AND json_extract(i.meta, '$.chat_id') IS NOT NULL
       AND i.ts = (SELECT MAX(j.ts) FROM items j WHERE j.tenant_id = 'owner' AND j.source = i.source AND j.removed_at IS NULL
                   AND json_extract(j.meta, '$.chat_id') = json_extract(i.meta, '$.chat_id'))`
  ).bind(sinceIso).all()).results || [];
  const seen = new Set();
  return rows.filter(r => { const k = r.source + '|' + (parse(r.meta) || {}).chat_id; return seen.has(k) ? false : seen.add(k); });
}

const mailOut = (r, now) => ({
  kind: 'mail', id: r.thread_id, msg_id: r.msg_id, title: r.subject, who: r.direction === 'out' ? 'me' : (r.from_name || r.from_addr),
  from_addr: r.from_addr, last_ts: r.ts, age_hours: ageHours(r.ts, now), snippet: r.snippet, lane: r.lane, update_kind: r.update_kind,
  category: r.category, unread: !r.is_read, archived: !!r.is_archived,
});
const chatOut = (r, now) => {
  const meta = parse(r.meta) || {};
  return {
    kind: 'chat', id: meta.chat_id, source: r.source, ext_id: r.ext_id, title: r.title, who: r.who, last_ts: r.ts, age_hours: ageHours(r.ts, now),
    snippet: r.snippet, chat_type: meta.chat_type || null, unread: r.unread === null ? null : !!r.unread,
  };
};

// B39: chat noise. Short codes (all digits, <= 6) and toll-free numbers never need a reply; nor do chats whose
// inbound messages all look like one-time codes or marketing texts. Raw phone numbers rank below named contacts.
const digitsOf = (t) => String(t || '').replace(/[\s().+-]/g, '');
export function isShortCode(t) { const d = digitsOf(t); return /^\d{3,6}$/.test(d); }
export function isTollFree(t) {
  let d = digitsOf(t);
  if (!/^\d+$/.test(d)) return false;
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 && /^(800|833|844|855|866|877|888)/.test(d);
}
export const isRawPhone = (t) => /^\+?[\d\s().-]{7,}$/.test(String(t || '').trim());
const OTP_RE = /\b(verification|verify|one[- ]time|passcode|otp|2fa|security code|login code|sign[- ]in code|your code|code is|code:)\b|\b\d{4,8}\b[^.]{0,40}\bcode\b/i;
const MARKETING_RE = /\b(reply stop|text stop|stop to (opt[- ]out|unsubscribe|end|cancel|quit)|msg ?(&|and) ?data rates|unsubscribe|promo code|% off|limited time|shop now|deal ends)\b/i;
export const isNoiseText = (t) => OTP_RE.test(String(t || '')) || MARKETING_RE.test(String(t || ''));

// GET /api/agent/views/awaiting-me?days=14&include_archived=1&include_noise=1
// Mail threads whose latest message is from someone else (Primary, not bulk/automated, not archived unless asked)
// and chats whose latest message is flagged needs_reply by the collector. Oldest first.
export async function awaitingMe(env, url) {
  const days = intParam(url, 'days', 14, 1, 90);
  if (days === undefined) return { status: 400, body: { error: 'days must be 1-90' } };
  const now = Date.now(), since = new Date(now - days * DAY).toISOString();
  const includeArchived = url.searchParams.get('include_archived') === '1';
  const mailIds = new Set((await env.DB.prepare(
    `SELECT msg_id FROM mail_messages WHERE tenant_id = 'owner' AND direction = 'in' AND COALESCE(category, 'primary') = 'primary'
       AND COALESCE(list_unsubscribe, 0) = 0 AND NOT ${AUTOMATED_SQL} AND ts >= ?`
  ).bind(since).all()).results.map(r => r.msg_id));
  const mail = (await latestMail(env, since)).filter(r => mailIds.has(r.msg_id) && (includeArchived || !r.is_archived)).map(r => mailOut(r, now));
  let chatRows = (await latestChats(env, since)).filter(r => r.needs_reply === 1);
  let noise = 0;
  if (url.searchParams.get('include_noise') !== '1' && chatRows.length) {
    // Inbound snippets per candidate chat, to spot chats that are only codes or marketing
    const inbound = (await env.DB.prepare(
      `SELECT source, json_extract(meta, '$.chat_id') AS chat_id, snippet FROM items
       WHERE tenant_id = 'owner' AND removed_at IS NULL AND ts >= ? AND json_extract(meta, '$.direction') = 'in'`
    ).bind(since).all()).results || [];
    const byChat = new Map();
    for (const r of inbound) { const k = r.source + '|' + r.chat_id; (byChat.get(k) || byChat.set(k, []).get(k)).push(r.snippet); }
    const kept = chatRows.filter(r => {
      const meta = parse(r.meta) || {};
      const label = r.title || r.who;
      const snippets = byChat.get(r.source + '|' + meta.chat_id) || [r.snippet];
      return !(isShortCode(label) || isTollFree(label) || isShortCode(r.who) || isTollFree(r.who) || snippets.every(isNoiseText));
    });
    noise = chatRows.length - kept.length;
    chatRows = kept;
  }
  const chats = chatRows.map(r => ({ ...chatOut(r, now), raw_number: isRawPhone(r.title || r.who) }));
  // Named contacts first, raw phone numbers after; oldest first within each group
  const rank = (i) => (i.raw_number ? 1 : 0);
  const items = [...mail, ...chats].sort((a, b) => rank(a) - rank(b) || (a.last_ts < b.last_ts ? -1 : 1));
  return { status: 200, body: { since, count: items.length, noise_hidden: noise, items } };
}

// GET /api/agent/views/awaiting-them?days=14&min_hours=48
// Mail threads and 1:1 chats where I sent the latest message at least min_hours ago. Oldest first.
export async function awaitingThem(env, url) {
  const days = intParam(url, 'days', 14, 1, 90), minHours = intParam(url, 'min_hours', 48, 0, 24 * 90);
  if (days === undefined || minHours === undefined) return { status: 400, body: { error: 'days must be 1-90, min_hours 0-2160' } };
  const now = Date.now(), since = new Date(now - days * DAY).toISOString(), cutoff = new Date(now - minHours * HOUR).toISOString();
  const mail = (await latestMail(env, since)).filter(r => r.direction === 'out' && r.ts <= cutoff).map(r => ({ ...mailOut(r, now), to_addrs: parse(r.to_addrs) || [] }));
  const chats = (await latestChats(env, since)).filter(r => {
    const meta = parse(r.meta) || {};
    return meta.direction === 'out' && meta.chat_type === 'single' && r.ts <= cutoff;
  }).map(r => chatOut(r, now));
  const items = [...mail, ...chats].sort((a, b) => (a.last_ts < b.last_ts ? -1 : 1));
  return { status: 200, body: { since, min_hours: minHours, count: items.length, items } };
}

// GET /api/agent/views/new-since?since=ISO&include_bulk=1&limit=
// Inbound mail (Primary/Updates/Forums; Promotions/Social only with include_bulk), inbound chat messages,
// and calendar changes after `since`. Newest first in each list.
export async function newSince(env, url) {
  let since = new Date(Date.now() - DAY).toISOString();
  if (url.searchParams.get('since')) { const t = Date.parse(url.searchParams.get('since')); if (isNaN(t)) return { status: 400, body: { error: 'Invalid since' } }; since = new Date(t).toISOString(); }
  const limit = intParam(url, 'limit', 200, 1, 1000);
  if (limit === undefined) return { status: 400, body: { error: 'limit must be 1-1000' } };
  const bulk = url.searchParams.get('include_bulk') === '1' ? '' : " AND COALESCE(category, 'primary') NOT IN ('promotions', 'social')";
  const now = Date.now();
  const mail = ((await env.DB.prepare(
    `SELECT * FROM mail_messages WHERE tenant_id = 'owner' AND direction = 'in' AND deleted_at IS NULL AND is_trashed = 0 AND is_spam = 0 AND ts > ?${bulk}
     ORDER BY ts DESC LIMIT ?`
  ).bind(since, limit).all()).results || []).map(r => mailOut(r, now));
  const chats = ((await env.DB.prepare(
    `SELECT * FROM items WHERE tenant_id = 'owner' AND removed_at IS NULL AND ts > ? AND json_extract(meta, '$.chat_id') IS NOT NULL
       AND json_extract(meta, '$.direction') = 'in' ORDER BY ts DESC LIMIT ?`
  ).bind(since, limit).all()).results || []).map(r => chatOut(r, now));
  const calendar = ((await env.DB.prepare(
    "SELECT * FROM calendar_changes WHERE tenant_id = 'owner' AND at > ? ORDER BY at DESC LIMIT ?"
  ).bind(since, limit).all()).results || []).map(r => {
    const before = parse(r.before), after = parse(r.after);
    return { kind: r.kind, at: r.at, calendar_id: r.calendar_id, event_id: r.event_id, title: (after || before || {}).title ?? null, before, after };
  });
  return { status: 200, body: { since, counts: { mail: mail.length, chats: chats.length, calendar: calendar.length }, mail, chats, calendar } };
}

// Source health for the app's strip: the code collectors only (agent-reported sources stay in /api/agent/health)
export const STRIP_SOURCES = [['gcal_sync', 'Calendar'], ['gmail_sync', 'Mail'], ['beeper', 'Chats']];
export async function healthStrip(env) {
  const rows = (await env.DB.prepare(
    `SELECT * FROM source_health WHERE tenant_id = 'owner' AND source IN (${STRIP_SOURCES.map(() => '?').join(',')})`
  ).bind(...STRIP_SOURCES.map(s => s[0])).all()).results || [];
  const now = Date.now();
  return STRIP_SOURCES.map(([source, label]) => {
    const r = rows.find(x => x.source === source);
    if (!r) return { source, label, status: 'off', detail: 'not set up' };
    const lastOk = r.last_ok ? Date.parse(r.last_ok) : NaN;
    const age = isNaN(lastOk) ? null : Math.round((now - lastOk) / 360000) / 10;
    const staleAfter = r.stale_after_hours ?? 12;
    const err = r.last_error || null;
    let status;
    if (err === 'not configured') status = 'off';
    else if (age === null || age > staleAfter) status = 'stale';
    else if (err) status = 'warn'; // e.g. rate limited, will retry
    else status = 'ok';
    return { source, label, status, age_hours: age, last_ok: r.last_ok, error: err ? String(err).slice(0, 160) : null };
  });
}
