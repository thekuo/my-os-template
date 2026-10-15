// Chat media (src/media.js): describe-on-arrival with Workers AI (fake binding here), nothing stored without R2;
// pending + re-send on AI failure (daily allocation used up), 5 MB cap, scopes, snippets, optional R2 copy + retention.
// Real Worker on SQLite. Run: node scripts/test-media.mjs
import assert from 'assert/strict';
import { makeDb } from './dev-v1.mjs';

const { sqlite, DB } = makeDb();
const AI = { calls: [], fail: null, run: async (model, input) => {
  AI.calls.push({ model, input });
  if (AI.fail) throw new Error(AI.fail);
  if (model.includes('whisper')) return { text: '  我們七點到，記得帶外套  ' };
  const url = input.messages[0].content[1].image_url.url;
  assert.ok(url.startsWith('data:image/'), 'image sent as a data URL');
  return { choices: [{ message: { content: 'A school flyer for the fall festival on Oct 24. Families are invited.\nText: Fall Festival, Fri Oct 24, 5-8pm' } }] };
} };
const env = { DB, AI, MEDIA_AI: '1', AGENT_KEY: 'k', INGEST_KEY: 'ik', APP_PASSPHRASE: 'dev' }; // AI mode (optional; off by default)
const pending = []; const ctx = { waitUntil: (p) => pending.push(p) };
const worker = (await import('../src/index.js')).default;
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; }; const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
async function call(method, p, { key = 'k', body, type = 'application/json', headers = {}, e = env } = {}) {
  const h = { authorization: 'Bearer ' + key, ...headers }; if (body !== undefined) h['content-type'] = type;
  const res = await worker.fetch(new Request('https://my-os.test' + p, { method, headers: h, body }), e, ctx);
  while (pending.length) await pending.shift();
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()), type: ct };
}
const ingest = (extId, snippet) => call('POST', '/api/agent/ingest', { key: 'ik', body: JSON.stringify({ source: 'line', items: [{ ext_id: extId, ts: new Date().toISOString(), snippet, meta: { chat_id: '!c' } }] }) });
const itemOf = (extId) => sqlite.prepare('SELECT * FROM items WHERE ext_id = ?').get(extId);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 250, 251, 255, 0]);
const q = (extId, idx, more = '') => `source=line&ext_id=${encodeURIComponent(extId)}&index=${idx}&chat_id=${encodeURIComponent('!c')}&msg_id=${encodeURIComponent(extId.split('|')[1])}${more}`;
const up = (extId, idx, bytes, { type = 'image/jpeg', key = 'ik', e } = {}) => call('POST', '/api/agent/items/attachment?' + q(extId, idx, '&width=800&height=600'),
  { key, body: Buffer.from(bytes).toString('base64'), type, headers: { 'x-encoding': 'base64' }, e });

// image: described on arrival, snippet updated, nothing stored
await ingest('!c|m1', 'look [image ×1]');
let r = await up('!c|m1', 0, jpg);
eq(r.status, 201); eq([r.data.status, r.data.kind, r.data.stored, r.data.bytes], ['described', 'image', false, 10]);
ok(r.data.description.includes('Fall Festival, Fri Oct 24'), 'description + visible text');
eq(itemOf('!c|m1').snippet, 'look [image: A school flyer for the fall festival on Oct 24.]', 'snippet carries the short description');
eq(AI.calls[0].model, '@cf/google/gemma-4-26b-a4b-it');
r = await up('!c|m1', 0, jpg); eq([r.status, r.data.existed], [200, true], 'described once'); eq(AI.calls.length, 1);
// a re-sent item (edit/backfill) keeps its description in the snippet
await ingest('!c|m1', 'look again [image ×1]');
eq(itemOf('!c|m1').snippet, 'look again [image: A school flyer for the fall festival on Oct 24.]');
// voice note: transcript
await ingest('!c|m2', '[voice]');
r = await up('!c|m2', 0, Buffer.from('OggS fake audio'), { type: 'audio/ogg' });
eq([r.data.status, r.data.kind, r.data.description], ['described', 'audio', '我們七點到，記得帶外套']);
eq(itemOf('!c|m2').snippet, '[voice: 我們七點到，記得帶外套]');
// AI fails (free daily allocation used up): pending until 00:00 UTC, then the collector re-sends and it's described
await ingest('!c|m3', '[image ×2]');
AI.fail = '3036: You have used up your daily free allocation of 10,000 neurons';
r = await up('!c|m3', 0, jpg); eq([r.status, r.data.status], [201, 'pending']);
const row = sqlite.prepare("SELECT * FROM item_attachments WHERE ext_id = '!c|m3'").get();
ok(row.retry_after.endsWith('T00:00:05.000Z') && row.retry_after > new Date().toISOString(), 'retry after the daily reset');
eq(itemOf('!c|m3').snippet, '[image ×2]', 'pending: the collector tag stays');
r = await call('GET', '/api/agent/items/attachment/pending', { key: 'ik' }); eq(r.data.count, 0, 'not before retry_after');
sqlite.prepare("UPDATE item_attachments SET retry_after = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), row.id);
r = await call('GET', '/api/agent/items/attachment/pending', { key: 'ik' });
eq(r.data.pending, [{ source: 'line', ext_id: '!c|m3', chat_id: '!c', msg_id: 'm3', index: 0, kind: 'image', attempts: 1 }]);
AI.fail = null;
r = await up('!c|m3', 0, jpg); eq([r.status, r.data.status, r.data.id], [200, 'described', row.id], 're-send describes the same row');
// other failures back off; after 6 attempts it gives up
AI.fail = 'network';
await ingest('!c|m4', '[image ×1]');
for (let i = 0; i < 6; i++) { r = await up('!c|m4', 0, jpg); sqlite.prepare("UPDATE item_attachments SET retry_after = NULL WHERE ext_id = '!c|m4'").run(); }
eq([r.data.status, sqlite.prepare("SELECT attempts FROM item_attachments WHERE ext_id = '!c|m4'").get().attempts], ['failed', 6]);
AI.fail = null;
// limits and scopes
r = await call('POST', '/api/agent/items/attachment?' + q('!c|m1', 3), { key: 'ik', body: 'A'.repeat(Math.ceil(25 * 1024 * 1024 * 4 / 3) + 8), type: 'image/jpeg', headers: { 'x-encoding': 'base64' } }); eq(r.status, 413, 'over 25 MB');
r = await up('!c|m1', 4, jpg, { type: 'video/mp4' }); eq(r.status, 503, 'AI-only mode (no R2) cannot keep a video');
r = await up('!c|nope', 0, jpg); eq(r.status, 404);
r = await call('POST', '/api/agent/items/attachment?' + q('!c|m1', 5), { key: 'ik', body: '###', type: 'image/png', headers: { 'x-encoding': 'base64' } }); eq(r.status, 400);
r = await call('GET', `/api/agent/items/${itemOf('!c|m1').id}/attachments`, { key: 'ik' }); eq(r.status, 403, 'ingest key cannot read');
r = await call('GET', `/api/agent/items/${itemOf('!c|m1').id}/attachments`); eq([r.status, r.data.count, r.data.attachments[0].status], [200, 1, 'described']);
const a1 = r.data.attachments[0];
r = await call('GET', `/api/agent/attachments/${a1.id}/raw`); eq(r.status, 404, 'no bytes without R2');
ok(!sqlite.prepare("SELECT 1 FROM item_attachments WHERE r2_key != ''").get(), 'AI-only mode: nothing stored');
// optional R2: bytes kept privately, raw works, retention deletes after 30 days (description stays)
const R2 = new Map();
const ITEM_MEDIA = { put: async (k, v) => { R2.set(k, new Uint8Array(v)); }, get: async (k) => (R2.has(k) ? { body: new Blob([R2.get(k)]).stream(), arrayBuffer: async () => R2.get(k).buffer } : null), delete: async (ks) => { for (const k of [].concat(ks)) R2.delete(k); } };
const env2 = { ...env, ITEM_MEDIA };
await ingest('!c|m5', '[image ×1]');
r = await up('!c|m5', 0, jpg, { e: env2 }); eq([r.data.status, r.data.stored], ['described', true]);
r = await call('GET', `/api/agent/attachments/${r.data.id}/raw`, { e: env2 }); ok(Buffer.from(r.data.data, 'base64').equals(jpg), 'raw round-trip with R2');
sqlite.prepare("UPDATE item_attachments SET created_at = ? WHERE ext_id = '!c|m5'").run(new Date(Date.now() - 8 * 86400000).toISOString());
const { purgeItemMedia } = await import('../src/media.js');
eq(await purgeItemMedia(env2), { purged: 1 }); eq(R2.size, 0);
ok(sqlite.prepare("SELECT description FROM item_attachments WHERE ext_id = '!c|m5'").get().description.includes('flyer'), 'description stays');
eq(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'media_described'").get().n >= 4, true);
// ---- default mode (the live setup): R2 keeps the bytes 7 days, no AI; the CoS looks and adds a note ----
const R3 = new Map(); AI.calls = [];
const toBytes = async (v) => (v instanceof ReadableStream ? new Uint8Array(await new Response(v).arrayBuffer()) : new Uint8Array(v));
const env3 = { DB, AI, AGENT_KEY: 'k', INGEST_KEY: 'ik', ITEM_MEDIA: { put: async (k, v) => { const b = await toBytes(v); R3.set(k, b); return { size: b.length }; }, get: async (k) => (R3.has(k) ? { body: new Blob([R3.get(k)]).stream(), arrayBuffer: async () => R3.get(k).buffer } : null), delete: async (ks) => { for (const k of [].concat(ks)) R3.delete(k); } } };
await ingest('!c|n1', 'from the class [image ×1]');
r = await up('!c|n1', 0, jpg, { e: env3 }); eq([r.status, r.data.status, r.data.stored, r.data.description], [201, 'stored', true, null]);
eq(AI.calls.length, 0, 'no Cloudflare AI by default');
eq(itemOf('!c|n1').snippet, 'from the class [image ×1]', 'no note yet: collector tag stays');
const n1 = r.data.id;
r = await call('GET', `/api/agent/attachments/${n1}/raw`, { e: env3 }); ok(Buffer.from(r.data.data, 'base64').equals(jpg), 'CoS can look at it');
r = await call('PATCH', `/api/agent/attachments/${n1}`, { body: JSON.stringify({ note: 'Picture day order form, due Fri Oct 16' }), e: env3 });
eq([r.status, r.data.note], [200, 'Picture day order form, due Fri Oct 16']); ok(r.data.note_at);
eq(itemOf('!c|n1').snippet, 'from the class [image: Picture day order form, due Fri Oct 16]', 'note in the snippet');
r = await call('GET', `/api/agent/items/${itemOf('!c|n1').id}/attachments`, { e: env3 }); eq(r.data.attachments[0].note, 'Picture day order form, due Fri Oct 16');
await ingest('!c|n1', 'from the class [image ×1]'); eq(itemOf('!c|n1').snippet, 'from the class [image: Picture day order form, due Fri Oct 16]', 'note survives a re-send');
r = await call('PATCH', `/api/agent/attachments/${n1}`, { body: JSON.stringify({ note: '' }), e: env3 }); eq(r.status, 400);
r = await call('PATCH', `/api/agent/attachments/${n1}`, { key: 'ik', body: JSON.stringify({ note: 'x' }), e: env3 }); eq(r.status, 403, 'ingest key cannot write notes');
r = await call('PATCH', '/api/agent/attachments/ia-nope', { body: JSON.stringify({ note: 'x' }), e: env3 }); eq(r.status, 404);
r = await call('PATCH', `/api/agent/attachments/${n1}`, { body: JSON.stringify({ note: null }), e: env3 }); eq(itemOf('!c|n1').snippet, 'from the class [image]', 'note cleared');
// 7-day retention: bytes deleted, row + item text stay
sqlite.prepare("UPDATE item_attachments SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 6 * 86400000).toISOString(), n1);
eq(await purgeItemMedia(env3), { purged: 0 }, 'kept under 7 days');
sqlite.prepare("UPDATE item_attachments SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 7 * 86400000 - 60000).toISOString(), n1);
eq(await purgeItemMedia(env3), { purged: 1 }); eq(R3.size, 0);
r = await call('GET', `/api/agent/attachments/${n1}/raw`, { e: env3 }); eq(r.status, 410);
// neither R2 nor AI: refuse (the collector counts it failed and a backfill re-sends later)
await ingest('!c|n2', '[image ×1]');
r = await up('!c|n2', 0, jpg, { e: { DB, AGENT_KEY: 'k', INGEST_KEY: 'ik' } }); eq(r.status, 503);

// ---- every attachment type (raw bytes streamed to R2, up to 25 MB): pdf, docs, video, other; text for pdf/docx/txt ----
const rawUp = (extId, idx, bytes, type, more = '') => call('POST', '/api/agent/items/attachment?' + q(extId, idx, more), { key: 'ik', body: bytes, type, e: env3 });
const pdfDoc = Buffer.from('%PDF-1.4\n4 0 obj << /Length 44 >>\nstream\nBT /F1 12 Tf 72 720 Td (Permission slip due Fri) Tj ET\nendstream\nendobj\ntrailer << >>\n%%EOF\n', 'latin1');
const scan = Buffer.from('%PDF-1.4\n4 0 obj << /Length 28 >>\nstream\nq 612 0 0 792 0 0 cm /I Do Q\nendstream\nendobj\ntrailer << >>\n%%EOF\n', 'latin1');
await ingest('!c|f1', 'here you go [pdf: slip.pdf] [pdf: scan.pdf] [video 1:10] [file: data.bin]');
r = await rawUp('!c|f1', 0, pdfDoc, 'application/pdf', '&filename=slip.pdf'); eq([r.status, r.data.kind, r.data.filename, r.data.bytes, r.data.stored], [201, 'pdf', 'slip.pdf', pdfDoc.length, true]);
const pdfId = r.data.id;
r = await rawUp('!c|f1', 1, scan, 'application/pdf', '&filename=scan.pdf'); const scanId = r.data.id;
r = await rawUp('!c|f1', 2, Buffer.alloc(2048, 7), 'video/mp4', '&filename=clip.mp4&duration=70.4'); eq([r.data.kind, r.data.duration], ['video', 70.4]);
const vidId = r.data.id;
r = await rawUp('!c|f1', 3, Buffer.from([1, 2, 3]), 'application/octet-stream', '&filename=data.bin'); eq(r.data.kind, 'other');
r = await rawUp('!c|f1', 4, Buffer.from('Bring snacks ✓'), 'text/plain', '&filename=notes.txt'); eq(r.data.kind, 'doc'); const txtId = r.data.id;
eq(AI.calls.length, 0, 'still no AI');
r = await call('GET', `/api/agent/items/${itemOf('!c|f1').id}/attachments`, { e: env3 });
eq(r.data.attachments.map(a => `${a.kind}:${a.filename}:${a.bytes}`), [`pdf:slip.pdf:${pdfDoc.length}`, `pdf:scan.pdf:${scan.length}`, 'video:clip.mp4:2048', 'other:data.bin:3', 'doc:notes.txt:16']);
r = await call('GET', `/api/agent/attachments/${pdfId}/raw?as=text`, { e: env3 }); eq([r.data.method, r.data.scanned, r.data.text], ['pdf', false, 'Permission slip due Fri']);
r = await call('GET', `/api/agent/attachments/${scanId}/raw?as=text`, { e: env3 }); eq([r.data.scanned, r.data.text], [true, ''], 'scanned pdf');
r = await call('GET', `/api/agent/attachments/${txtId}/raw?as=text`, { e: env3 }); eq(r.data.text, 'Bring snacks ✓');
r = await call('GET', `/api/agent/attachments/${vidId}/raw?as=text`, { e: env3 }); eq(r.data.text, null, 'no text for video');
r = await call('GET', `/api/agent/attachments/${vidId}/raw`, { e: env3 }); eq([r.data.encoding, Buffer.from(r.data.data, 'base64').length], ['base64', 2048]);
r = await call('GET', `/api/agent/attachments/${pdfId}/raw?as=binary`, { e: env3 }); ok(Buffer.from(r.data).equals(pdfDoc) && r.type === 'application/pdf', 'binary, any type');
r = await call('GET', `/api/agent/attachments/${pdfId}/raw?as=zip`, { e: env3 }); eq(r.status, 400);
// a big file: stored up to 25 MB; base64/text refused over 5 MB (binary works)
await ingest('!c|f2', '[video 9:00]');
r = await rawUp('!c|f2', 0, Buffer.alloc(6 * 1024 * 1024, 1), 'video/mp4'); eq(r.status, 201); const bigId = r.data.id;
r = await call('GET', `/api/agent/attachments/${bigId}/raw`, { e: env3 }); eq(r.status, 413, 'base64 capped at 5 MB');
r = await call('GET', `/api/agent/attachments/${bigId}/raw?as=binary`, { e: env3 }); eq(r.data.length, 6 * 1024 * 1024);
r = await rawUp('!c|f2', 1, Buffer.alloc(25 * 1024 * 1024 + 1, 1), 'video/mp4'); eq(r.status, 413, 'over 25 MB');
// snippet: tags stay until a note, then rebuilt per file with the note where there is one
eq(itemOf('!c|f1').snippet, 'here you go [pdf: slip.pdf] [pdf: scan.pdf] [video 1:10] [file: data.bin]');
r = await call('PATCH', `/api/agent/attachments/${pdfId}`, { body: JSON.stringify({ note: 'Field trip permission slip, due Fri' }), e: env3 });
eq(itemOf('!c|f1').snippet, 'here you go [pdf: Field trip permission slip, due Fri] [pdf: scan.pdf] [video 1:10] [file: data.bin] [file: notes.txt]');

console.log(`test-media: ${checks} checks passed`);
