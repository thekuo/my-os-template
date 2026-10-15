// B37 P2: mail collector against a fake Gmail API (profile, messages.list, history.list, batch get) and an
// in-memory SQLite shim of D1 (node:sqlite, Node >= 22.5). No network, no real data.
// Run: node scripts/test-mail-sync.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert/strict';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// Schema as it was before 0008, then the 0008 migration (checks the migration applies cleanly)
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf-8');
const before = schema.slice(0, schema.indexOf('-- B37 P2 mail')).replace(/^\s*state TEXT,\n/m, '');
assert.ok(!before.includes('mail_messages') && !/^\s*state TEXT/m.test(before));
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(before);
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0008_mail_sync.sql'), 'utf-8'));
new DatabaseSync(':memory:').exec(schema); // fresh installs

class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, a); }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async run() { if (silentDrop && /INSERT INTO mail_messages/.test(this.sql)) return { meta: { changes: 0 } }; const r = sqlite.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; }
}
let silentDrop = false; // a write that "succeeds" but keeps nothing
let failBatch = false;
const DB = {
  prepare: (sql) => new Stmt(sql),
  batch: async (stmts) => {
    if (failBatch) throw new Error('D1 batch failed');
    sqlite.exec('BEGIN');
    try { const out = []; for (const s of stmts) out.push(await s.run()); sqlite.exec('COMMIT'); return out; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
};
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const flush = async () => { while (pending.length) await pending.shift(); };

// ---- Fake Gmail ----
const DAY = 86400000, NOW = Date.now();
const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64url');
const G = { msgs: new Map(), history: [], hid: 1000, minValid: 0, scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly',
  histPage: 3, listCalls: 0, batchCalls: 0, batchSizes: [], failBatchApi: null, itemFail: {}, apiFail: null };
const rec = (r) => { G.hid += 1; G.history.push({ id: String(G.hid), ...r }); };
function mime({ from = 'Pat Doe <pat@example.com>', to = 'me@example.com', cc, subject = 'Hello', plain, html, attach, ics, unsub }) {
  const headers = [{ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: subject }];
  if (cc) headers.push({ name: 'Cc', value: cc });
  if (unsub) headers.push({ name: 'List-Unsubscribe', value: '<mailto:x@example.com>' });
  const parts = [];
  if (plain !== undefined || html !== undefined) {
    const alt = [];
    if (plain !== undefined) alt.push({ mimeType: 'text/plain', filename: '', body: { data: b64(plain) } });
    if (html !== undefined) alt.push({ mimeType: 'text/html', filename: '', body: { data: b64(html) } });
    parts.push({ mimeType: 'multipart/alternative', filename: '', parts: alt });
  }
  if (attach) parts.push({ mimeType: 'application/pdf', filename: 'doc.pdf', body: { attachmentId: 'att1', size: 10 } });
  if (ics) parts.push({ mimeType: 'text/calendar', filename: 'invite.ics', body: { attachmentId: 'att2', size: 10 } });
  return { mimeType: 'multipart/mixed', headers, parts };
}
function add(id, spec = {}, labels = ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'], ageDays = 1) {
  const m = { id, threadId: spec.thread || 't-' + id, labelIds: labels, snippet: spec.snippet || 'snippet ' + id, internalDate: String(NOW - ageDays * DAY), payload: mime(spec) };
  G.msgs.set(id, m);
  rec({ messagesAdded: [{ message: { id, threadId: m.threadId, labelIds: labels } }] });
}
function relabel(id, labels) { const m = G.msgs.get(id); m.labelIds = labels; rec({ labelsAdded: [{ message: { id, threadId: m.threadId, labelIds: labels }, labelIds: [] }] }); }
function del(id) { const m = G.msgs.get(id); G.msgs.delete(id); rec({ messagesDeleted: [{ message: { id, threadId: m ? m.threadId : 'x' } }] }); }

const mkRes = (status, body, headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.host === 'oauth2.googleapis.com') return mkRes(200, { access_token: 'at-1', scope: G.scope });
  if (u.host === 'www.googleapis.com' && u.pathname === '/batch/gmail/v1') {
    G.batchCalls++;
    if (G.failBatchApi) return mkRes(G.failBatchApi.status, { error: { code: G.failBatchApi.status, errors: G.failBatchApi.reason ? [{ reason: G.failBatchApi.reason }] : [] } });
    const reqB = opts.headers['Content-Type'].match(/boundary=(\S+)/)[1];
    const items = opts.body.split('--' + reqB).filter(p => p.includes('GET '));
    G.batchSizes.push(items.length);
    const RB = 'batch_resp_x';
    const out = items.map(p => {
      const cid = p.match(/Content-ID: <([^>]+)>/)[1];
      const id = decodeURIComponent(p.match(/messages\/([^?\s]+)\?format=full/)[1]);
      const m = G.msgs.get(id);
      const f = G.itemFail[id];
      const body = f ? JSON.stringify({ error: { code: f.code, errors: [{ reason: f.reason }] } }) : m ? JSON.stringify(m) : JSON.stringify({ error: { code: 404 } });
      return `--${RB}\r\nContent-Type: application/http\r\nContent-ID: <response-${cid}>\r\n\r\nHTTP/1.1 ${f ? f.code + ' Err' : m ? '200 OK' : '404 Not Found'}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n`;
    }).join('') + `--${RB}--`;
    return mkRes(200, out, { 'content-type': `multipart/mixed; boundary=${RB}` });
  }
  assert.equal(u.host, 'gmail.googleapis.com', url);
  assert.equal(opts.headers.Authorization, 'Bearer at-1');
  const p = u.pathname.replace('/gmail/v1/users/me', '');
  if (G.apiFail) return mkRes(G.apiFail.status, { error: { code: G.apiFail.status, errors: [{ reason: G.apiFail.reason }] } });
  if (p === '/profile') return mkRes(200, { emailAddress: 'me@example.com', historyId: String(G.hid) });
  if (p === '/messages') {
    G.listCalls++;
    assert.ok(u.searchParams.get('q').startsWith('newer_than:'));
    const all = [...G.msgs.values()].filter(m => !m.labelIds.includes('SPAM') && !m.labelIds.includes('TRASH')).sort((a, b) => b.internalDate - a.internalDate);
    const off = Number(u.searchParams.get('pageToken') || 0), n = Number(u.searchParams.get('maxResults'));
    const page = all.slice(off, off + n);
    return mkRes(200, { messages: page.map(m => ({ id: m.id, threadId: m.threadId })), ...(off + n < all.length ? { nextPageToken: String(off + n) } : {}) });
  }
  if (p === '/history') {
    const start = Number(u.searchParams.get('startHistoryId'));
    if (start < G.minValid) return mkRes(404, { error: { code: 404 } });
    assert.deepEqual(u.searchParams.getAll('historyTypes').sort(), ['labelAdded', 'labelRemoved', 'messageAdded', 'messageDeleted']);
    const recs = G.history.filter(r => Number(r.id) > start);
    const off = Number(u.searchParams.get('pageToken') || 0);
    const page = recs.slice(off, off + G.histPage);
    return mkRes(200, { history: page, historyId: String(G.hid), ...(off + G.histPage < recs.length ? { nextPageToken: String(off + G.histPage) } : {}) });
  }
  throw new Error('unexpected ' + url);
};

const mail = await import('../src/gmail.js');
const worker = (await import('../src/index.js')).default;
const env = { DB, AGENT_KEY: 'k', APP_PASSPHRASE: 'dev', ASSETS: { fetch: async () => new Response('a') },
  GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r', MAIL_MAX_FETCH: '4',
  MAIL_LANES: JSON.stringify([{ lane: 'school', from: ['@school.example.org'], subject: ['field trip'] }]) };

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };
const emitted = [];
const sync = () => mail.runMailSync(env, { emit: (k, p) => emitted.push([k, p]) });
const row = (id) => sqlite.prepare('SELECT * FROM mail_messages WHERE msg_id = ?').get(id);
const count = () => sqlite.prepare('SELECT COUNT(*) AS n FROM mail_messages').get().n;
const cursor = () => sqlite.prepare("SELECT * FROM sync_cursors WHERE source = 'gmail_sync'").get();
const health = () => sqlite.prepare("SELECT * FROM source_health WHERE source = 'gmail_sync'").get();
async function agent(p, method = 'GET') {
  const r = await worker.fetch(new Request('https://x.test' + p, { method, headers: { authorization: 'Bearer k' } }), env, ctx);
  await flush();
  return { status: r.status, data: await r.json() };
}

// --- Parsing and classification (pure) ---
{
  const cfg = mail.mailConfig(env);
  const mk = (spec, labels = ['INBOX'], age = 1) => ({ id: 'p', threadId: 't', labelIds: labels, snippet: 's', internalDate: String(NOW - age * DAY), payload: mime(spec) });
  let r = mail.parseMessage(mk({ from: '"Doe, Pat" <Pat@Example.com>', to: 'a@x.com, "B" <b@y.com>', cc: 'c@z.com', plain: 'Hi there\n\nOn Mon, Oct 5 Pat wrote:\n> old stuff' }), cfg);
  eq(r.from_addr, 'pat@example.com'); eq(r.from_name, 'Doe, Pat');
  eq(JSON.stringify(r.to_addrs), JSON.stringify(['a@x.com', 'b@y.com'])); eq(r.cc_count, 1);
  eq(r.body_text, 'Hi there', 'quoted reply cut');
  eq(r.direction, 'in'); eq(r.is_read, 1); eq(r.is_archived, 0);
  r = mail.parseMessage(mk({ html: '<html><head><style>x{}</style></head><body><p>Hello&nbsp;<b>world</b></p><script>bad()</script></body></html>' }), cfg);
  eq(r.body_text, 'Hello world', 'html stripped');
  r = mail.parseMessage(mk({ plain: 'é ✓ 日本' }), cfg);
  eq(r.body_text, 'é ✓ 日本', 'utf-8');
  r = mail.parseMessage(mk({ plain: 'x'.repeat(9000) }), cfg);
  eq(r.body_text.length, 4000, 'clipped');
  r = mail.parseMessage(mk({ plain: 'sale!', unsub: true }, ['INBOX', 'CATEGORY_PROMOTIONS']), cfg);
  eq(r.body_text, null, 'no body for promotions'); eq(r.category, 'promotions'); eq(r.list_unsubscribe, 1); eq(r.snippet, 's');
  r = mail.parseMessage(mk({ plain: 'old' }, ['INBOX'], 40), cfg);
  eq(r.body_text, null, 'no body past 30 days');
  r = mail.parseMessage(mk({ plain: 'Club news', subject: 'Your invoice' }, ['INBOX', 'CATEGORY_FORUMS']), cfg);
  eq(r.category, 'forums'); eq(r.body_text, 'Club news', 'forums keep the body'); eq(r.update_kind, 'bills', 'rules run on forums');
  r = mail.parseMessage(mk({ plain: 'u' }, ['INBOX', 'CATEGORY_UPDATES']), cfg); eq(r.body_text, 'u');
  r = mail.parseMessage(mk({ plain: 'sp' }, ['INBOX', 'CATEGORY_SOCIAL']), cfg); eq(r.body_text, null, 'social snippet only');
  r = mail.parseMessage(mk({ plain: 'p' }, ['INBOX']), cfg); eq(r.category, 'primary', 'no category = primary');
  r = mail.parseMessage(mk({ plain: 'x', attach: true }, ['SENT']), cfg);
  eq(r.has_attachments, 1); eq(r.direction, 'out'); eq(r.is_archived, 1);
  // Rules
  const k = (subject, extra = {}) => mail.classify(cfg, { from_addr: 'x@shop.example.com', subject, has_invite: 0, ...extra });
  eq(k('Your invoice for October').update_kind, 'bills');
  eq(k('Payment due in 3 days').update_kind, 'bills');
  eq(k('Appointment reminder').update_kind, 'appointments');
  eq(k('Lunch?', { has_invite: 1 }).update_kind, 'appointments', 'ics invite');
  eq(k('Security alert: new sign-in').update_kind, 'security');
  eq(k('Your verification code').update_kind, 'security');
  eq(k('Your flight itinerary').update_kind, 'travel');
  eq(k('Hello friend').update_kind, null);
  // Lanes + custom rules first
  eq(mail.classify(cfg, { from_addr: 'office@school.example.org', subject: 'Newsletter' }).lane, 'school');
  eq(mail.classify(cfg, { from_addr: 'x@y.com', subject: 'Field trip form' }).lane, 'school');
  eq(mail.classify(cfg, { from_addr: 'x@notschool.example.org.evil', subject: 'Hi' }).lane, null);
  const cfg2 = { ...cfg, rules: [{ kind: 'bills', from: ['@utility.example.com'] }] };
  eq(mail.classify(cfg2, { from_addr: 'noreply@utility.example.com', subject: 'Your flight' }).update_kind, 'bills', 'custom rule first');
}

// --- Not configured / scope missing ---
{
  const r = await mail.runMailSync({ DB });
  eq(r.configured, false); eq(health().last_error, 'not configured');
  G.scope = 'https://www.googleapis.com/auth/calendar.readonly';
  const r2 = await sync();
  ok(r2.error.includes('gmail scope not granted'), r2.error);
  ok(health().last_error.includes('scope'));
  G.scope += ' https://www.googleapis.com/auth/gmail.readonly';
}

// --- Backfill across runs (cap 4 per run), baseline, then incremental ---
add('m1', { subject: 'Your invoice', plain: 'Amount due' });
add('m2', { from: 'Teacher <t@school.example.org>', subject: 'Class news', plain: 'News' });
add('m3', { subject: 'Re: plans', plain: 'Sounds good' }, ['SENT'], 2);
add('m4', { subject: 'Big sale', plain: 'Buy', unsub: true }, ['INBOX', 'CATEGORY_PROMOTIONS', 'UNREAD'], 3);
add('m5', { subject: 'Spammy' }, ['SPAM'], 1);
add('m6', { subject: 'Older', html: '<p>Old</p>' }, ['INBOX'], 5);
add('d1', { subject: 'Draft' }, ['DRAFT'], 1);
add('m7', { subject: 'Trip: flight itinerary', plain: 'Boarding pass attached', attach: true }, ['INBOX', 'UNREAD'], 6);
let r = await sync();
eq(r.mode, 'backfill'); eq(r.fetched, 4);
ok(cursor().state && !cursor().cursor, 'backfill in progress');
eq(G.batchSizes.at(-1), 4, 'one batch request for the page');
r = await sync();
eq(r.mode, 'backfill'); eq(r.fetched, 3); ok(r.backfill_done, 'done');
ok(cursor().cursor && !cursor().state, 'cursor set, state cleared');
eq(count(), 6, 'spam and drafts excluded'); eq(row('d1'), undefined);
eq(row('m1').update_kind, 'bills'); eq(row('m2').lane, 'school'); eq(row('m3').direction, 'out');
eq(row('m4').body_text, null); eq(row('m6').body_text, 'Old'); eq(row('m7').has_attachments, 1); eq(row('m7').update_kind, 'travel');
ok(health().last_ok && !health().last_error, 'healthy');

// Incremental: the backfill's history overlap is replayed idempotently
r = await sync();
eq(r.mode, 'incremental'); eq(count(), 6);

// New mail, read/archive/trash label changes, delete
add('m8', { subject: 'Security alert', plain: 'New sign-in' });
relabel('m1', ['INBOX']); // read
relabel('m2', ['CATEGORY_PERSONAL']); // archived (no INBOX), read
relabel('m6', ['TRASH']);
del('m3');
r = await sync();
eq(r.mode, 'incremental'); eq(r.added, 1); eq(r.label_changes, 3); eq(r.deleted, 1); eq(r.stored, 1, 'stored counted from D1 changes');
eq(row('m8').update_kind, 'security');
eq(row('m1').is_read, 1); eq(row('m2').is_archived, 1); eq(row('m6').is_trashed, 1);
ok(row('m3').deleted_at, 'tombstone'); eq(row('m3').body_text, null); eq(row('m3').snippet, null); eq(row('m3').subject, 'Re: plans', 'headers kept');
ok(emitted.some(e => e[0] === 'mail_sync' && e[1].added === 1), 'mail_sync emitted');
emitted.length = 0;
r = await sync();
eq(r.added + r.label_changes + r.deleted, 0); eq(emitted.length, 0, 'quiet run emits nothing');

// Added then deleted within the same window: not fetched, nothing stored
add('m9', { subject: 'Oops' }); del('m9');
const bc = G.batchCalls;
r = await sync();
eq(row('m9'), undefined); eq(G.batchCalls, bc, 'no fetch for a deleted add');

// Budget stop at a record boundary, resumes next run
for (let i = 0; i < 6; i++) add('n' + i, { subject: 'Note ' + i, plain: 'n' });
r = await sync();
eq(r.fetched, 4, 'budget'); eq(count() - 7, 4);
const mid = cursor().cursor;
ok(Number(mid) < G.hid, 'cursor at a record boundary');
r = await sync();
eq(r.fetched, 2); ok(row('n5'), 'rest fetched'); eq(cursor().cursor, String(G.hid));

// Failed write keeps the cursor
{
  add('f1', { subject: 'After failure', plain: 'x' });
  const keep = cursor().cursor;
  failBatch = true; r = await sync(); failBatch = false;
  ok(r.error, 'error reported'); eq(cursor().cursor, keep); ok(cursor().last_error); eq(row('f1'), undefined);
  r = await sync();
  ok(row('f1'), 'picked up'); eq(cursor().last_error, null); eq(health().last_error, null);
}

// Whole batch 503: ids kept for retry, not a hard failure; next run fetches only them
{
  add('f2', { subject: 'Batch down', plain: 'x' });
  G.failBatchApi = { status: 503 };
  r = await sync();
  G.failBatchApi = null;
  ok(r.retry_later && !r.error, JSON.stringify(r)); eq(r.rate_limited, false); eq(r.pending_retry, 1);
  ok(health().last_error.startsWith('temporary Gmail error, will retry'), health().last_error);
  eq(row('f2'), undefined); ok(JSON.parse(cursor().state).retry.includes('f2'));
  const sizes = G.batchSizes.length;
  r = await sync();
  eq(r.retried, 1); ok(row('f2')); eq(r.pending_retry, 0); eq(cursor().state, null); eq(health().last_error, null);
  eq(G.batchSizes[sizes], 1, 'retry fetched only the failed id');
}

// Per-item 403 rateLimitExceeded: others stored, failed one retried next run, reason surfaced
{
  add('r1', { subject: 'one', plain: '1' }); add('r2', { subject: 'two', plain: '2' }); add('r3', { subject: 'three', plain: '3' });
  G.itemFail = { r2: { code: 403, reason: 'rateLimitExceeded' } };
  const lastOk = health().last_ok;
  r = await sync();
  ok(r.rate_limited && r.retry_later && !r.error, JSON.stringify(r)); eq(r.reason, 'rateLimitExceeded'); eq(r.pending_retry, 1);
  ok(row('r1') && row('r3'), 'others stored'); eq(row('r2'), undefined);
  eq(health().last_error, 'rate limited, will retry (rateLimitExceeded)'); eq(health().last_ok, lastOk, 'not marked ok');
  eq(cursor().last_error, 'rate limited, will retry (rateLimitExceeded)');
  ok(emitted.some(e => e[0] === 'mail_sync' && e[1].rate_limited), 'telemetry');
  G.itemFail = {};
  r = await sync();
  eq(r.retried, 1); ok(row('r2'), 'retried'); eq(health().last_error, null);
}

// Whole batch 429 and a deleted retry id
{
  add('r4', { subject: 'four', plain: '4' });
  G.failBatchApi = { status: 429 };
  r = await sync(); G.failBatchApi = null;
  ok(r.rate_limited, 'http 429 is a rate limit'); eq(r.pending_retry, 1);
  del('r4');
  r = await sync();
  eq(r.pending_retry, 0, 'deleted id dropped from retry'); eq(row('r4'), undefined);
}

// history.list 403 userRateLimitExceeded: clean stop, cursor unchanged
{
  const keep = cursor().cursor;
  add('r5', { subject: 'five', plain: '5' });
  G.apiFail = { status: 403, reason: 'userRateLimitExceeded' };
  r = await sync(); G.apiFail = null;
  ok(r.rate_limited && !r.error, JSON.stringify(r)); eq(r.reason, 'userRateLimitExceeded'); eq(cursor().cursor, keep);
  eq(health().last_error, 'rate limited, will retry (userRateLimitExceeded)');
  r = await sync(); ok(row('r5'));
}

// Non-rate 403 is a config error: nothing committed for the page, reason in the response and health
{
  const keep = cursor().cursor;
  add('x1', { subject: 'perm', plain: 'p' });
  G.itemFail = { x1: { code: 403, reason: 'insufficientPermissions' } };
  r = await sync(); G.itemFail = {};
  ok(r.error && r.error.includes('insufficientPermissions'), JSON.stringify(r)); eq(r.reason, 'insufficientPermissions');
  ok(!r.rate_limited); eq(cursor().cursor, keep); ok(health().last_error.includes('insufficientPermissions'));
  r = await sync(); ok(row('x1'));
}

// Batches are at most 10 gets
{
  env.MAIL_MAX_FETCH = '50'; G.histPage = 50;
  for (let i = 0; i < 23; i++) add('bb' + i, { subject: 'b' + i, plain: 'b' });
  const from = G.batchSizes.length;
  r = await sync();
  eq(r.added, 23); eq(JSON.stringify(G.batchSizes.slice(from)), JSON.stringify([10, 10, 3]));
  env.MAIL_MAX_FETCH = '4'; G.histPage = 3;
}

// History expired (404) -> bounded backfill again, idempotent
{
  G.minValid = G.hid + 1;
  add('g1', { subject: 'During gap', plain: 'g' });
  const n = count();
  env.MAIL_MAX_FETCH = '50';
  r = await sync();
  eq(r.mode, 'resync'); ok(row('g1'), 'gap message stored'); eq(count(), n + 1);
  ok(cursor().cursor, 'cursor again'); G.minValid = 0;
  r = await sync(); eq(r.mode, 'incremental');
  // Rate limit during a backfill: finished backfill still sets the cursor, the failed id waits in state.retry
  G.minValid = G.hid + 1;
  add('g2', { subject: 'Gap two', plain: 'g' });
  G.itemFail = { g2: { code: 429, reason: 'rateLimitExceeded' } };
  r = await sync(); G.itemFail = {}; G.minValid = 0;
  eq(r.mode, 'resync'); ok(r.rate_limited); ok(cursor().cursor, 'cursor set'); eq(JSON.parse(cursor().state).retry[0], 'g2');
  r = await sync(); ok(row('g2'), 'retried after backfill'); eq(cursor().state, null);
}

// Retag after config change
{
  env.MAIL_LANES = JSON.stringify([{ lane: 'school', from: ['@school.example.org'] }, { lane: 'travel-lane', subject: ['trip'] }]);
  const res = await agent('/api/agent/mail/retag', 'POST');
  eq(res.status, 200); ok(res.data.changed >= 1); eq(row('m7').lane, 'travel-lane');
}

// Endpoints
{
  let res = await agent('/api/agent/mail/messages?since=' + encodeURIComponent(new Date(NOW - 30 * DAY).toISOString()));
  eq(res.status, 200);
  ok(!res.data.messages.some(m => m.msg_id === 'm3'), 'deleted hidden'); ok(!res.data.messages.some(m => m.msg_id === 'm6'), 'trash hidden');
  ok(res.data.messages.every(m => !('body_text' in m)), 'no bodies by default');
  const ts = res.data.messages.map(m => m.ts); ok(ts.every((t, i) => i === 0 || ts[i - 1] >= t), 'newest first');
  res = await agent('/api/agent/mail/messages?since=2000-01-01T00:00:00Z&lane=school&include_body=1');
  eq(res.data.count, 1); eq(res.data.messages[0].body_text, 'News');
  res = await agent('/api/agent/mail/messages?since=2000-01-01T00:00:00Z&update_kind=bills'); eq(res.data.messages[0].msg_id, 'm1');
  res = await agent('/api/agent/mail/messages?since=2000-01-01T00:00:00Z&direction=out&include_deleted=1'); eq(res.data.messages[0].msg_id, 'm3');
  res = await agent('/api/agent/mail/messages?since=2000-01-01T00:00:00Z&unread=1'); ok(res.data.messages.every(m => !m.is_read));
  res = await agent('/api/agent/mail/messages?since=2000-01-01T00:00:00Z&q=SECURITY'); eq(res.data.messages[0].msg_id, 'm8');
  res = await agent('/api/agent/mail/messages?since=2000-01-01T00:00:00Z&include_trash=1'); ok(res.data.messages.some(m => m.msg_id === 'm6'));
  res = await agent('/api/agent/mail/messages?direction=sideways'); eq(res.status, 400);
  res = await agent('/api/agent/mail/messages?since=bad'); eq(res.status, 400);
  res = await agent('/api/agent/mail/threads/t-m2?include_body=1'); eq(res.status, 200); eq(res.data.messages[0].body_text, 'News');
  res = await agent('/api/agent/mail/threads/nope'); eq(res.status, 404);
  res = await agent('/api/agent/mail/sync', 'POST'); eq(res.status, 200); eq(res.data.mode, 'incremental');
  res = await agent('/api/agent/health');
  ok(res.data.sources.some(s => s.source === 'gmail_sync')); ok(res.data.cursors.some(c => c.source === 'gmail_sync' && c.has_cursor));
  const unauth = await worker.fetch(new Request('https://x.test/api/agent/mail/messages'), env, ctx); eq(unauth.status, 401);
}

// Retention
{
  const iso = (d) => new Date(NOW - d * DAY).toISOString();
  const ins = sqlite.prepare("INSERT INTO mail_messages (tenant_id, msg_id, ts, direction, body_text, first_seen, last_seen, deleted_at) VALUES ('owner', ?, ?, 'in', ?, ?, ?, ?)");
  ins.run('old-body', iso(31), 'text', iso(0), iso(0), null);
  ins.run('ancient', iso(400), null, iso(0), iso(0), null);
  ins.run('old-tomb', iso(10), null, iso(0), iso(0), iso(100));
  ins.run('new-tomb', iso(10), null, iso(0), iso(0), iso(10));
  await mail.purgeMail(env);
  eq(row('old-body').body_text, null); ok(row('old-body').body_purged_at);
  eq(row('ancient'), undefined); eq(row('old-tomb'), undefined); ok(row('new-tomb')); eq(row('m1').body_text, 'Amount due', 'recent body kept');
}

// Cron runs mail after calendar
{
  const n = G.batchCalls; add('c1', { subject: 'Cron', plain: 'c' });
  await worker.scheduled({ cron: '*/10 * * * *' }, env, ctx); await flush();
  eq(row('c1'), undefined, 'calendar cron does not run mail'); eq(G.batchCalls, n);
  await worker.scheduled({ cron: '5-55/10 * * * *' }, env, ctx); await flush();
  ok(row('c1'), 'mail cron synced mail'); ok(G.batchCalls > n);
}

{ // a run that fetched mail but stored none reports unhealthy, then recovers
  add('m8b', { subject: 'Silently dropped', plain: 'x' });
  silentDrop = true; const r2 = await sync(); silentDrop = false;
  eq(`${r2.added},${r2.stored},${r2.store_short}`, '1,0,true'); eq(health().last_error, 'fetched 1 messages, stored 0');
  add('m8c', { subject: 'Next one', plain: 'x' });
  const r3 = await sync(); eq(`${r3.added},${r3.stored}`, '1,1'); eq(health().last_error, null, 'healthy again'); }
console.log(`test-mail-sync: ${checks} checks passed`);
