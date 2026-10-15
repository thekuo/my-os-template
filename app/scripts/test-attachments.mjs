// B47: mail attachment reader against a fake Gmail API, with real .docx (zip) and PDF (FlateDecode) fixtures
// built here. No network, no real data. Run: node scripts/test-attachments.mjs
import assert from 'assert/strict';
import zlib from 'zlib';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ---- fixtures ----
function makeZip(files) { // stored + deflated entries; minimal but valid
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content, deflate] of files) {
    const nameB = Buffer.from(name), data = Buffer.from(content);
    const comp = deflate ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    locals.push(lh, nameB, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const docxXml = '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Field trip form</w:t></w:r></w:p><w:p><w:r><w:t>Return by Friday &amp; sign</w:t><w:tab/><w:t>here</w:t></w:r></w:p></w:body></w:document>';
const docx = makeZip([['[Content_Types].xml', '<Types/>', false], ['word/document.xml', docxXml, true]]);

function makePdf() {
  const content = 'BT /F1 12 Tf 72 720 Td (Invoice total: $42.00) Tj T* [(Due) -300 (Oct) 20 ( 15)] TJ ET';
  const comp = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const head = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n4 0 obj << /Length ' + comp.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1');
  const img = Buffer.from('\nendstream\nendobj\n5 0 obj << /Subtype /Image /Length 4 >>\nstream\nJUNK\nendstream\nendobj\ntrailer << >>\n%%EOF\n', 'latin1');
  return Buffer.concat([head, comp, img]);
}
const pdf = makePdf();
// A scanned PDF: an image page, no text layer
function makeScan() {
  const content = 'q 612 0 0 792 0 0 cm /Im1 Do Q';
  return Buffer.from('%PDF-1.4\n4 0 obj << /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n5 0 obj << /Subtype /Image /Length 4 >>\nstream\nJUNK\nendstream\nendobj\ntrailer << >>\n%%EOF\n', 'latin1');
}

// ---- fake Gmail ----
const G = { calls: [], attIdCounter: 0, failAtt: null, scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly' };
const files = {
  '1': { filename: 'form.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: docx },
  '2': { filename: 'invoice.pdf', mimeType: 'application/pdf', data: pdf },
  '3': { filename: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('Bring snacks ✓') },
  '4': { filename: 'photo.jpg', mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xfb, 0xff, 0xbf, 0x3e, 0x00, 0x7f]) }, // bytes that need + and / in base64
  '5': { filename: 'page.html', mimeType: 'text/html', data: Buffer.from('<p>Hello <b>there</b></p><script>x()</script>') },
  '6': { filename: 'big.pdf', mimeType: 'application/pdf', data: null, size: 6 * 1024 * 1024 },
  '7': { filename: 'data.bin', mimeType: 'application/octet-stream', data: Buffer.alloc(3) },
  '9': { filename: 'scan.pdf', mimeType: 'application/pdf', data: makeScan() },
};
function message() {
  // Attachment ids change on every fetch (like Gmail); part ids are stable
  const parts = Object.entries(files).map(([pid, f]) => ({
    partId: pid, filename: f.filename, mimeType: f.mimeType,
    body: { size: f.size ?? f.data.length, attachmentId: `att-${pid}-${++G.attIdCounter}` },
  }));
  parts.push({ partId: '8', filename: 'tiny.txt', mimeType: 'text/plain', body: { size: 5, data: b64u('hello') } }); // inline data
  return { id: 'm1', threadId: 't1', payload: { mimeType: 'multipart/mixed', parts: [{ partId: '0', mimeType: 'text/plain', filename: '', body: { data: b64u('body') } }, ...parts] } };
}
const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  G.calls.push(u.pathname);
  if (u.host === 'oauth2.googleapis.com') return res(200, { access_token: 'at', scope: G.scope });
  assert.equal(opts.headers.Authorization, 'Bearer at');
  let m;
  if ((m = u.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/))) return m[1] === 'm1' ? res(200, message()) : res(404, { error: { code: 404 } });
  if ((m = u.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/m1\/attachments\/(att-(\d+)-\d+)$/))) {
    if (G.failAtt) return res(G.failAtt, { error: { errors: [{ reason: 'rateLimitExceeded' }] } });
    const f = files[m[2]];
    return res(200, { size: f.data.length, data: b64u(f.data) });
  }
  throw new Error('unexpected ' + url);
};

// ---- worker ----
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf-8'));
class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, a); }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async run() { sqlite.prepare(this.sql).run(...this.args); return { meta: { changes: 1 } }; }
}
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const env = { DB: { prepare: (s) => new Stmt(s), batch: async (st) => { for (const s of st) await s.run(); } }, AGENT_KEY: 'k', INGEST_KEY: 'ik', APP_PASSPHRASE: 'dev',
  ASSETS: { fetch: async () => new Response('a') }, GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' };
const worker = (await import('../src/index.js')).default;
async function agent(p, key = 'k', e = env) {
  const r = await worker.fetch(new Request('https://x.test' + p, { headers: { authorization: 'Bearer ' + key } }), e, ctx);
  while (pending.length) await pending.shift();
  return { status: r.status, data: await r.json() };
}

// Unit: extractors
const { docxText, pdfText } = await import('../src/attachments.js');
eq(await docxText(new Uint8Array(docx)), 'Field trip form\nReturn by Friday & sign\there');
const pt = await pdfText(new Uint8Array(pdf));
ok(pt.includes('Invoice total: $42.00') && /Due Oct\s?15/.test(pt), JSON.stringify(pt));
await assert.rejects(docxText(new Uint8Array(Buffer.from('not a zip at all, nope'))), /zip/); checks++;
await assert.rejects(pdfText(new Uint8Array(Buffer.from('hello'))), /Not a PDF/); checks++;

// List
let r = await agent('/api/agent/mail/attachments?msg_id=m1');
eq(r.status, 200); eq(r.data.count, 9, 'the body part is not an attachment');
const byName = Object.fromEntries(r.data.attachments.map(a => [a.filename, a]));
eq(byName['form.docx'].kind, 'docx'); eq(byName['invoice.pdf'].kind, 'pdf'); eq(byName['photo.jpg'].kind, 'image'); eq(byName['notes.txt'].kind, 'text');
eq(byName['form.docx'].part_id, '1'); ok(byName['form.docx'].size > 0);
r = await agent('/api/agent/mail/attachments?msg_id=nope'); eq(r.status, 404);
r = await agent('/api/agent/mail/attachments'); eq(r.status, 400);

// Read by part id (stable even though attachment ids rotate)
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=1&as=text');
eq(r.status, 200); eq(r.data.method, 'docx'); eq(r.data.text, 'Field trip form\nReturn by Friday & sign\there'); eq(r.data.truncated, false);
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=2');
eq(r.status, 200); eq(r.data.method, 'pdf'); eq(r.data.best_effort, true); ok(r.data.text.includes('Invoice total'));
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=3'); eq(r.data.text, 'Bring snacks ✓');
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=5'); eq(r.data.text, 'Hello there', 'html stripped');
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=8'); eq(r.data.text, 'hello', 'inline data, no attachment fetch');
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=4'); eq(r.status, 200); eq(r.data.text, null); ok(r.data.note.includes('metadata'));
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=7'); eq(r.data.text, null);
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=6'); eq(r.status, 413);
// An attachment id from an earlier listing still resolves when it matches the current fetch only; part ids are the way
const list = await agent('/api/agent/mail/attachments?msg_id=m1');
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=' + list.data.attachments[0].attachment_id); eq(r.status, 404, 'rotated attachment id');
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=99'); eq(r.status, 404);
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=1&as=bytes'); eq(r.status, 400);
// as=raw: the bytes as standard base64 (any kind), same 5 MB cap; scanned PDFs are flagged in text mode
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=4&as=raw');
eq(r.status, 200); eq(r.data.encoding, 'base64'); eq(r.data.mime, 'image/jpeg'); eq(r.data.filename, 'photo.jpg'); eq(r.data.bytes, 10);
eq(Buffer.from(r.data.data, 'base64').equals(files['4'].data), true, 'raw bytes round-trip'); ok(/^[A-Za-z0-9+/]+=*$/.test(r.data.data), 'standard base64 alphabet');
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=9&as=raw'); ok(Buffer.from(r.data.data, 'base64').equals(files['9'].data), 'raw pdf');
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=8&as=raw'); eq(Buffer.from(r.data.data, 'base64').toString(), 'hello', 'raw inline data');
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=6&as=raw'); eq(r.status, 413, 'raw is capped at 5 MB');
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=9'); eq(r.status, 200); eq(r.data.scanned, true, 'scanned pdf flagged'); eq(r.data.text, '');
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=2'); eq(r.data.scanned, false);
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=4'); ok(r.data.note.includes('as=raw'));
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=4&as=raw', 'ik'); eq(r.status, 403, 'agent key only');
r = await agent('/api/agent/mail/attachment?msg_id=m1'); eq(r.status, 400);
// Gmail rate limit -> 503 with the reason
G.failAtt = 429; r = await agent('/api/agent/mail/attachment?msg_id=m1&id=1'); G.failAtt = null;
eq(r.status, 503); ok(r.data.error.includes('rateLimitExceeded'));
// Scope / config / auth
G.scope = 'https://www.googleapis.com/auth/calendar.readonly';
r = await agent('/api/agent/mail/attachments?msg_id=m1'); eq(r.status, 503); ok(r.data.error.includes('scope'));
G.scope += ' https://www.googleapis.com/auth/gmail.readonly';
r = await agent('/api/agent/mail/attachments?msg_id=m1', 'k', { ...env, GOOGLE_REFRESH_TOKEN: undefined }); eq(r.status, 503);
r = await agent('/api/agent/mail/attachments?msg_id=m1', 'ik'); eq(r.status, 403, 'ingest key cannot read attachments');
r = await agent('/api/agent/mail/attachment?msg_id=m1&id=1', 'ik'); eq(r.status, 403);
// Nothing stored, telemetry only
ok(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'mail_attachment_read'").get().n >= 5, 'telemetry');
ok(!sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%attach%' AND name NOT LIKE '%item_attachments%'").all().length, 'no mail attachment table (item_attachments is for chat images)');

console.log(`test-attachments: ${checks} checks passed`);
