// Local v1 server: the real Worker on an in-memory SQLite D1 (schema + migrations) with generic sample data,
// public/ served as the static assets, every host treated as the v1 host. No network, no real data.
//   node scripts/dev-v1.mjs [port]      -> http://localhost:8788 (passphrase: dev)
// Also imported by scripts/test-v1-ui.mjs.
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

export function makeDb() {
  const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf-8');
  const before = schema.replace(/^  start TEXT,\n[\s\S]*?^  created_via TEXT,\n/m, '').replace(/-- my-os v1 model[\s\S]*$/, '');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(before);
  sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0012_v1_model.sql'), 'utf-8'));
  sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0013_settings.sql'), 'utf-8'));
  sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0014_event_labels.sql'), 'utf-8'));
  sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0015_item_attachments.sql'), 'utf-8'));
  sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0016_attachment_descriptions.sql'), 'utf-8'));
  sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0017_attachment_note.sql'), 'utf-8'));
  sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0018_attachment_files.sql'), 'utf-8'));
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...a) { return new Stmt(this.sql, a); }
    async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
    async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
    async run() { const r = sqlite.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; }
  }
  const DB = { prepare: (s) => new Stmt(s), batch: async (st) => { const o = []; for (const s of st) o.push(await s.run()); return o; } };
  return { sqlite, DB };
}

const laDate = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(Date.now() + offsetDays * 86400000));

// Generic sample data relative to today (Pacific time)
export function seed(sqlite) {
  const now = new Date().toISOString();
  const T = sqlite.prepare(`INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, area, inbox, start, evening, deadline, flagged, area_id, project_id, heading_id, repeat_rule, source, reason, suggestion_state, completed_at, created_at, updated_at)
    VALUES (?, 'owner', ?, ?, 'P2', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const add = (id, o) => T.run(id, o.list || 'Tasks', o.title, o.due ?? null, o.rec ?? null, o.area ?? null, o.inbox ? 1 : 0, o.start ?? null, o.evening ? 1 : 0, o.deadline ?? null, o.flag ? 1 : 0,
    o.area_id ?? null, o.project ?? null, o.heading ?? null, o.rec ? JSON.stringify({ mode: 'schedule', freq: o.rec, interval: 1 }) : null, o.source ?? null, o.reason ?? null, o.state ?? null, o.done ?? null, now, now);
  sqlite.prepare("INSERT INTO projects (id, tenant_id, area_id, title, notes, start, status, sort, created_at, updated_at) VALUES ('p-school', 'owner', 'a-family', 'School plan', 'Reading plan and a support decision.', 'anytime', 'open', 1, ?, ?)").run(now, now);
  sqlite.prepare("INSERT INTO projects (id, tenant_id, area_id, title, start, status, sort, created_at, updated_at) VALUES ('p-garden', 'owner', 'a-home', 'Garden care', 'anytime', 'open', 2, ?, ?)").run(now, now);
  sqlite.prepare("INSERT INTO headings (id, tenant_id, project_id, title, sort, created_at) VALUES ('h-month', 'owner', 'p-school', 'This month', 1, ?)").run(now);
  add('t-milk', { title: 'Buy milk', inbox: true });
  add('t-call', { title: 'Call the clinic to book', due: laDate(0), area: 'health', area_id: 'a-health', flag: true });
  add('t-expense', { title: 'Expense report', due: laDate(0), area: 'work', area_id: 'a-work', deadline: laDate(0) });
  add('t-bins', { title: 'Trash bins out', due: laDate(0), area: 'house', area_id: 'a-home', evening: true, rec: 'weekly' });
  add('t-vitamins', { title: 'Take vitamins', due: laDate(-1), area: 'health', area_id: 'a-health', rec: 'daily' });
  add('t-sign', { title: 'Sign and return the plan', due: laDate(2), area: 'family', area_id: 'a-family', project: 'p-school', heading: 'h-month', deadline: laDate(4) });
  add('t-read', { title: 'Start home reading plan', start: 'anytime', area: 'family', area_id: 'a-family', project: 'p-school' });
  add('t-water', { title: 'Start watering', due: laDate(3), area: 'house', area_id: 'a-home', project: 'p-garden' });
  add('t-lights', { title: 'Choose new lights', start: 'someday', area: 'house', area_id: 'a-home' });
  add('t-done', { title: 'Paid the water bill', area: 'finance', area_id: 'a-money', done: new Date(Date.now() - 3600000).toISOString() });
  add('t-sug', { title: 'Get a flu shot', inbox: true, source: 'claude', reason: 'The clinic says it is due this month.', state: 'pending' });
  add('t-cl', { list: 'Claude', title: 'Research school options', due: laDate(1) });
  sqlite.prepare("INSERT INTO checklist_items (id, task_id, title, done, sort) VALUES ('c-1', 't-read', 'Pick three books', 1, 0), ('c-2', 't-read', 'Set up a 20-minute slot', 0, 1)").run();
  const ev = sqlite.prepare("INSERT INTO calendar_events (tenant_id, calendar_id, event_id, start_ts, end_ts, all_day, start_raw, end_raw, title, status, first_seen, last_seen) VALUES ('owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const at = (h) => new Date(Date.now() + h * 3600000).toISOString();
  ev.run('primary', 'e1', at(-2), at(-1.5), 0, null, null, 'Morning block', 'confirmed', now, now);
  ev.run('primary', 'e2', at(1), at(2), 0, null, null, 'Lunch', 'confirmed', now, now);
  ev.run('work@group', 'e3', at(3), at(4), 0, null, null, 'Busy', 'busy', now, now);
  ev.run('family@group', 'e4', laDate(0) + 'T07:00:00Z', laDate(1) + 'T07:00:00Z', 1, laDate(0), laDate(1), 'Picture day', 'confirmed', now, now);
  ev.run('family@group', 'e5', at(26), at(27), 0, null, null, 'Soccer game', 'confirmed', now, now);
  sqlite.prepare("INSERT INTO briefs (id, tenant_id, date, body_md, created_at) VALUES ('b-1', 'owner', ?, ?, ?)").run(laDate(0), '# Monday brief\n\nThe one thing today: **call the clinic** to book.\n\n- Lunch at noon\n- Focus block after', now);
}

export async function startServer({ port = 8788, seedData = true } = {}) {
  const { sqlite, DB } = makeDb();
  if (seedData) seed(sqlite);
  const worker = (await import('../src/index.js')).default;
  // Mimics Workers static assets' default html_handling ("auto-trailing-slash"): /x/index.html -> 307 /x/, /x/ serves x/index.html
  const ASSETS = { fetch: async (req) => {
    let p = new URL(req.url).pathname;
    if (p.endsWith('/index.html')) return new Response(null, { status: 307, headers: { Location: p.slice(0, -'index.html'.length) } });
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(path.join(root, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' } });
  } };
  const env = { DB, APP_PASSPHRASE: 'dev', AGENT_KEY: 'k', ASSETS, V1_HOSTS: 'localhost,127.0.0.1' };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const waits = [];
    const r = await worker.fetch(request, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((ok) => server.listen(port, ok));
  return { server, sqlite, env, url: `http://localhost:${server.address().port}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startServer({ port: +(process.argv[2] || 8788) });
  console.log(`my-os v1 dev server: ${url} (passphrase: dev)`);
}
