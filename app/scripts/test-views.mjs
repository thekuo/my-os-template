// B37 P4: agent views (awaiting-me, awaiting-them, new-since) and the app's health strip, on an in-memory
// SQLite shim of D1 (node:sqlite, Node >= 22.5). No network, no real data.
// Run: node scripts/test-views.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert/strict';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf-8'));
class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, a); }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async run() { const r = sqlite.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; }
}
const DB = { prepare: (sql) => new Stmt(sql), batch: async (st) => { for (const s of st) await s.run(); } };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const env = { DB, AGENT_KEY: 'k', APP_PASSPHRASE: 'dev', ASSETS: { fetch: async () => new Response('a') } };
const worker = (await import('../src/index.js')).default;

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };
const H = 3600000, NOW = Date.now(), iso = (h) => new Date(NOW - h * H).toISOString();
async function agent(p) {
  const r = await worker.fetch(new Request('https://x.test' + p, { headers: { authorization: 'Bearer k' } }), env, ctx);
  while (pending.length) await pending.shift();
  return { status: r.status, data: await r.json() };
}

// Mail fixtures
const mail = sqlite.prepare(`INSERT INTO mail_messages (tenant_id, msg_id, thread_id, ts, direction, from_addr, from_name, to_addrs, subject, snippet, category, is_read, is_archived,
  is_trashed, is_spam, list_unsubscribe, lane, first_seen, last_seen, deleted_at) VALUES ('owner', ?, ?, ?, ?, ?, ?, '["x@y.com"]', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`);
const M = (id, thread, h, dir, from, subject, o = {}) => mail.run(id, thread, iso(h), dir, from, o.name || null, subject, 'snip ' + id, o.category ?? 'primary', o.read ?? 0, o.archived ?? 0, o.trashed ?? 0, o.unsub ?? 0, o.lane ?? null, iso(0), iso(0), o.deleted ?? null);
M('a1', 'tA', 30, 'in', 'pat@example.com', 'Question', { name: 'Pat', lane: 'school' }); // awaiting me
M('b1', 'tB', 50, 'in', 'sam@example.com', 'Plans');
M('b2', 'tB', 40, 'out', 'me@example.com', 'Re: Plans'); // awaiting them (40h < 48h default) -> only with min_hours 24
M('c1', 'tC', 100, 'in', 'lee@example.com', 'Docs');
M('c2', 'tC', 90, 'out', 'me@example.com', 'Re: Docs'); // awaiting them (90h)
M('d1', 'tD', 5, 'in', 'news@shop.example.com', 'Sale', { category: 'promotions', unsub: 1 }); // bulk
M('e1', 'tE', 6, 'in', 'noreply@bank.example.com', 'Statement'); // automated
M('f1', 'tF', 7, 'in', 'kim@example.com', 'Archived ask', { archived: 1 }); // archived
M('g1', 'tG', 8, 'in', 'joe@example.com', 'Trashed', { trashed: 1 });
M('h1', 'tH', 9, 'in', 'ann@example.com', 'Deleted', { deleted: iso(1) });
M('i1', 'tI', 3, 'in', 'club@lists.example.org', 'Forum post', { category: 'forums' }); // not primary -> not awaiting; is new
M('old', 'tOld', 24 * 30, 'in', 'old@example.com', 'Ancient');

// Chat fixtures (items from the collector)
const item = sqlite.prepare(`INSERT INTO items (id, tenant_id, source, ext_id, ts, who, title, snippet, unread, needs_reply, meta, first_seen, last_seen)
  VALUES (?, 'owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
let n = 0;
const C = (source, chat, msg, h, dir, o = {}) => item.run('i' + (n++), source, `${chat}|${msg}`, iso(h), dir === 'out' ? 'me' : 'Sam', o.title || chat, 'chat ' + msg,
  dir === 'in' ? 1 : 0, o.needs ?? 0, JSON.stringify({ chat_id: chat, chat_type: o.type || 'single', direction: dir }), iso(0), iso(0));
C('whatsapp', '!c1', 'm1', 20, 'out'); C('whatsapp', '!c1', 'm2', 2, 'in', { needs: 1, title: 'Sam' }); // awaiting me
C('signal', '!c2', 'm1', 80, 'in'); C('signal', '!c2', 'm2', 60, 'out'); // awaiting them
C('signal', '!g1', 'm1', 70, 'out', { type: 'group' }); // groups never awaiting them
C('whatsapp', '!c3', 'm1', 4, 'in', { needs: 0 }); // muted or cleared: not awaiting me, but new
item.run('x1', 'gmail', 'legacy-1', iso(1), 'x', 't', 's', 1, 1, null, iso(0), iso(0)); // agent-path item without chat meta: ignored

// Calendar change
sqlite.prepare("INSERT INTO calendar_changes (id, tenant_id, calendar_id, event_id, kind, at, before, after, via) VALUES ('cc1', 'owner', 'primary', 'e1', 'changed', ?, ?, ?, 'incremental')")
  .run(iso(1), JSON.stringify({ title: 'Dentist', start: 'a' }), JSON.stringify({ title: 'Dentist', start: 'b' }));

// awaiting-me
let r = await agent('/api/agent/views/awaiting-me');
eq(r.status, 200);
let ids = r.data.items.map(i => i.kind + ':' + i.id);
eq(JSON.stringify(ids), JSON.stringify(['mail:tA', 'chat:!c1']), JSON.stringify(ids));
const a = r.data.items[0];
eq(a.title, 'Question'); eq(a.who, 'Pat'); eq(a.lane, 'school'); ok(a.age_hours > 29 && a.age_hours < 31); eq(a.unread, true);
eq(r.data.items[1].source, 'whatsapp'); eq(r.data.items[1].title, 'Sam');
r = await agent('/api/agent/views/awaiting-me?include_archived=1');
ok(r.data.items.some(i => i.id === 'tF'), 'archived on request');
r = await agent('/api/agent/views/awaiting-me?days=1');
eq(JSON.stringify(r.data.items.map(i => i.id)), JSON.stringify(['!c1']), 'window');
r = await agent('/api/agent/views/awaiting-me?days=0'); eq(r.status, 400);

// awaiting-them
r = await agent('/api/agent/views/awaiting-them');
ids = r.data.items.map(i => i.kind + ':' + i.id);
eq(JSON.stringify(ids), JSON.stringify(['mail:tC', 'chat:!c2']), JSON.stringify(ids));
eq(r.data.items[0].who, 'me'); eq(JSON.stringify(r.data.items[0].to_addrs), JSON.stringify(['x@y.com']));
r = await agent('/api/agent/views/awaiting-them?min_hours=24');
ok(r.data.items.some(i => i.id === 'tB'), 'shorter wait');
ok(!r.data.items.some(i => i.id === '!g1'), 'groups excluded');
r = await agent('/api/agent/views/awaiting-them?min_hours=-1'); eq(r.status, 400);

// new-since
r = await agent('/api/agent/views/new-since?since=' + encodeURIComponent(iso(10)));
eq(r.status, 200);
eq(JSON.stringify(r.data.mail.map(m => m.msg_id)), JSON.stringify(['i1', 'e1', 'f1']), 'inbound incl. archived, not bulk/trash/deleted, newest first');
eq(JSON.stringify(r.data.chats.map(c => c.ext_id)), JSON.stringify(['!c1|m2', '!c3|m1']), 'inbound chat messages');
eq(r.data.calendar.length, 1); eq(r.data.calendar[0].title, 'Dentist');
eq(r.data.counts.mail, 3);
r = await agent('/api/agent/views/new-since?since=' + encodeURIComponent(iso(10)) + '&include_bulk=1');
ok(r.data.mail.some(m => m.msg_id === 'd1'), 'bulk on request');
r = await agent('/api/agent/views/new-since'); eq(r.status, 200); ok(r.data.mail.some(m => m.msg_id === 'i1'), 'default 24h');
r = await agent('/api/agent/views/new-since?since=nope'); eq(r.status, 400);
r = await agent('/api/agent/views/unknown'); eq(r.status, 404);

// B39: noise filter
{
  const { isShortCode, isTollFree, isRawPhone, isNoiseText } = await import('../src/views.js');
  ok(isShortCode('227898') && isShortCode('85638') && !isShortCode('Sam') && !isShortCode('5551234567'));
  ok(isTollFree('+1 (800) 555-0100') && isTollFree('8885550100') && !isTollFree('4155550100'));
  ok(isRawPhone('+1 415-555-0100') && !isRawPhone('Sam'));
  ok(isNoiseText('Your verification code is 123456') && isNoiseText('G-123456 is your code') && isNoiseText('20% off today! Reply STOP to opt out'));
  ok(!isNoiseText('Can you call me back?'));
  C('google-messages', '!sc', 'm1', 3, 'in', { needs: 1, title: '227898' });                // short code
  C('google-messages', '!tf', 'm1', 3, 'in', { needs: 1, title: '+1 (888) 555-0100' });     // toll-free
  item.run('i' + (n++), 'google-messages', '!otp|m1', iso(3), '+1 415-555-0199', '+1 415-555-0199', 'Your verification code is 482913', 1, 1,
    JSON.stringify({ chat_id: '!otp', chat_type: 'single', direction: 'in' }), iso(0), iso(0));         // OTP-only from a raw number
  C('google-messages', '!raw', 'm1', 6, 'in', { needs: 1, title: '+1 415-555-0123' });      // a real person without a contact name
  C('whatsapp', '!named', 'm1', 1, 'in', { needs: 1, title: 'Alex' });
  r = await agent('/api/agent/views/awaiting-me');
  ids = r.data.items.map(i => i.id);
  ok(!ids.includes('!sc') && !ids.includes('!tf') && !ids.includes('!otp'), JSON.stringify(ids));
  eq(r.data.noise_hidden, 3);
  eq(JSON.stringify(ids), JSON.stringify(['tA', '!c1', '!named', '!raw']), 'named first, raw numbers last');
  eq(r.data.items.at(-1).raw_number, true);
  r = await agent('/api/agent/views/awaiting-me?include_noise=1');
  ok(['!sc', '!tf', '!otp'].every(x => r.data.items.some(i => i.id === x)), 'noise on request'); eq(r.data.noise_hidden, 0);
}

// Health strip via /api/brief
const hs = sqlite.prepare("INSERT INTO source_health (tenant_id, source, last_ok, last_attempt, last_error, stale_after_hours) VALUES ('owner', ?, ?, ?, ?, ?)");
hs.run('gcal_sync', iso(0.1), iso(0.1), null, 1);
hs.run('gmail_sync', iso(0.2), iso(0.1), 'rate limited, will retry (rateLimitExceeded)', 1);
hs.run('beeper', iso(5), iso(5), null, 1);
hs.run('whatsapp', iso(100), iso(100), null, 12); // agent-path source: not in the strip
const form = new FormData(); form.set('passphrase', 'dev');
const login = await worker.fetch(new Request('https://x.test/login', { method: 'POST', body: form }), env, ctx);
const cookie = login.headers.get('set-cookie').split(';')[0];
const br = await worker.fetch(new Request('https://x.test/api/brief', { headers: { cookie } }), env, ctx);
while (pending.length) await pending.shift();
const strip = (await br.json()).sources;
eq(JSON.stringify(strip.map(s => s.source + ':' + s.status)), JSON.stringify(['gcal_sync:ok', 'gmail_sync:warn', 'beeper:stale']));
eq(strip[1].label, 'Mail'); ok(strip[1].error.includes('rate limited'));
sqlite.exec("DELETE FROM source_health WHERE source = 'beeper'");
sqlite.exec("UPDATE source_health SET last_error = 'not configured', last_ok = NULL WHERE source = 'gcal_sync'");
const br2 = await worker.fetch(new Request('https://x.test/api/brief', { headers: { cookie } }), env, ctx);
while (pending.length) await pending.shift();
const strip2 = (await br2.json()).sources;
eq(strip2[0].status, 'off'); eq(strip2[2].status, 'off'); eq(strip2[2].detail, 'not set up');

console.log(`test-views: ${checks} checks passed`);
