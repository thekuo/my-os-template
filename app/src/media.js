// Chat attachments from the Beeper collector (every type: images, pdf, documents, audio, video, other; up to 25 MB).
// The bytes go to a private R2 bucket (ITEM_MEDIA, never public) for 7 days so the CoS can look at them (GET .../raw, or
// as=text for pdf/docx/txt); after looking it stores a one-line note (PATCH /api/agent/attachments/:id) that
// shows in the item snippet ("[image: <note>]"). Optional, off by default: MEDIA_AI=1 also describes images / transcribes
// voice with Workers AI on arrival (then a failed AI call leaves the row "pending" and the collector re-sends it).
// If R2 is down the row is pending too. Agent-only reads; uploads with the scoped ingest key.
import { extractText } from './attachments.js';
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;  // per stored file
const INLINE_MAX = 5 * 1024 * 1024;                 // base64 JSON, text extraction and AI (10 ms CPU on the free plan)
const TEXT_MAX = 100000;
// image | pdf | doc | audio | video | other, from the MIME type (or the file name)
export function mediaKind(mime, filename) {
  const m = String(mime || '').toLowerCase(), n = String(filename || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('text/') || /msword|officedocument|opendocument|rtf|spreadsheet|presentation|ms-excel|ms-powerpoint|csv/.test(m) || /\.(docx?|xlsx?|pptx?|odt|ods|rtf|txt|csv|md)$/.test(n)) return 'doc';
  return 'other';
}
export const MEDIA_RETENTION_DAYS = 7;
const MAX_ATTEMPTS = 6;
const VISION_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const ASR_MODEL = '@cf/openai/whisper-large-v3-turbo';
const VISION_PROMPT = 'This image was shared in a personal chat. Describe it for a personal assistant in 1-3 short sentences: what it shows and why it might matter. '
  + 'Then, on a new line starting with "Text:", copy any visible text that matters (dates, times, names, places, amounts, links); omit the line if there is none. '
  + 'Write in the same language as the image text or the conversation. Plain text, no preamble.';
const rowOut = (r) => ({ id: r.id, item_id: r.item_id, index: r.idx, kind: r.kind || 'image', mime: r.mime, filename: r.filename || null, bytes: r.bytes, duration: r.duration ?? null, width: r.width, height: r.height,
  status: r.status || (r.r2_key ? 'stored' : null), description: r.description || null, note: r.note || null, note_at: r.note_at || null,
  stored: !!(r.r2_key && !r.purged_at), created_at: r.created_at, purged: !!r.purged_at });

// Bytes <-> base64 without Node APIs (the free plan has 10 ms CPU: the collector sends base64 so the Worker never encodes)
const b64ToBytes = (b64) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
function bytesToB64(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); }

const aiText = (r) => {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;
  const c = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => x.text || '').join('');
  return typeof r.text === 'string' ? r.text : '';
};
// Workers AI daily allocation used up (3036) -> wait for 00:00 UTC; other failures back off 10 min, 20, 40, ...
function retryAfter(err, attempts, now = Date.now()) {
  if (/3036|daily free allocation|neurons/i.test(String(err && (err.message || err)))) { const d = new Date(now); d.setUTCHours(24, 0, 5, 0); return d.toISOString(); }
  return new Date(now + 10 * 60000 * Math.pow(2, Math.max(0, attempts - 1))).toISOString();
}

export async function describeMedia(env, kind, mime, b64) {
  if (!env.AI) throw new Error('AI binding missing');
  if (kind === 'audio') {
    const r = await env.AI.run(env.ASR_MODEL || ASR_MODEL, { audio: b64 });
    return String(aiText(r) || '').replace(/\s+/g, ' ').trim();
  }
  const r = await env.AI.run(env.VISION_MODEL || VISION_MODEL, {
    messages: [{ role: 'user', content: [{ type: 'text', text: VISION_PROMPT }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] }],
    max_tokens: 300,
  });
  return String(aiText(r) || '').trim();
}

// The item's snippet: once the CoS adds a note (or AI describes something), the collector's tags ("[image ×2]",
// "[pdf: x.pdf]", "[voice 0:42]", …) are rebuilt per attachment, with "[kind: note]" where there is one.
const TAG_RE = /\s*\[(image|voice|audio|video|pdf|file)(?:[^\]]*)\]/g;
const shortOf = (d, n = 120) => { const one = String(d || '').split(/\n|(?<=[.!?。！？])\s/)[0].trim(); return one.length > n ? one.slice(0, n - 1) + '…' : one; };
const mmss = (s) => (s > 0 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
function defaultTag(r) {
  const k = r.kind || 'image', d = mmss(r.duration);
  if (k === 'image') return '[image]';
  if (k === 'audio') return d ? `[voice ${d}]` : '[voice]';
  if (k === 'video') return d ? `[video ${d}]` : '[video]';
  if (k === 'pdf') return r.filename ? `[pdf: ${r.filename}]` : '[pdf]';
  return r.filename ? `[file: ${r.filename}]` : '[file]';
}
const labelOf = (k) => (k === 'audio' ? 'voice' : k === 'doc' || k === 'other' ? 'file' : k || 'image');
export async function refreshItemSnippet(env, itemId, force = false) {
  const item = await env.DB.prepare('SELECT snippet FROM items WHERE id = ?').bind(itemId).first();
  if (!item) return;
  const rows = (await env.DB.prepare('SELECT kind, status, description, note, filename, duration FROM item_attachments WHERE item_id = ? ORDER BY idx').bind(itemId).all()).results || [];
  const text = (r) => r.note || (r.status === 'described' ? r.description : null);
  if (!rows.some(text) && !force) return; // no notes: the collector's tags stay as sent (force: a note was just cleared)
  const base = String(item.snippet || '').replace(TAG_RE, '').trim();
  const tags = rows.map(r => (text(r) ? `[${labelOf(r.kind)}: ${shortOf(text(r))}]` : defaultTag(r)));
  const snippet = [base, ...tags].filter(Boolean).join(' ').slice(0, 300);
  if (snippet !== item.snippet) await env.DB.prepare('UPDATE items SET snippet = ? WHERE id = ?').bind(snippet, itemId).run();
}

// After an ingest batch: re-apply descriptions to re-sent items (a resend carries the collector's plain tags)
export async function reapplySnippets(env, source, extIds) {
  for (let i = 0; i < extIds.length; i += 50) {
    const chunk = extIds.slice(i, i + 50);
    const rows = (await env.DB.prepare(`SELECT DISTINCT a.item_id FROM item_attachments a JOIN items i ON i.id = a.item_id WHERE i.tenant_id = 'owner' AND i.source = ? AND i.ext_id IN (${chunk.map(() => '?').join(',')})`).bind(source, ...chunk).all()).results || [];
    for (const r of rows) await refreshItemSnippet(env, r.item_id);
  }
}

// POST /api/agent/items/attachment?source=&ext_id=&index=&chat_id=&msg_id=&filename=&duration=&width=&height=
// body: the raw file (streamed to R2, any type, up to 25 MB), or base64 with X-Encoding: base64 (AI mode, up to 5 MB)
export async function uploadItemMedia(env, request, url, d) {
  const source = url.searchParams.get('source') || '', extId = url.searchParams.get('ext_id') || '';
  const idx = parseInt(url.searchParams.get('index') || '0', 10);
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(source) || !extId || extId.length > 200 || !(idx >= 0 && idx < 50)) return json({ error: 'source, ext_id and index (0-49) required' }, 400);
  const ctype = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const mime = /^[a-z]+\/[a-z0-9.+-]+$/.test(ctype) ? ctype : 'application/octet-stream';
  const clip = (k, max) => { const v = url.searchParams.get(k); return v ? v.slice(0, max) : null; };
  const filename = clip('filename', 200);
  const kind = mediaKind(mime, filename);
  const isB64 = (request.headers.get('x-encoding') || '').toLowerCase() === 'base64';
  const ai = env.MEDIA_AI === '1' && (kind === 'image' || kind === 'audio');
  if (!env.ITEM_MEDIA && !ai) return json({ error: 'Media storage is not set up (R2 binding ITEM_MEDIA missing)' }, 503);
  const declared = parseInt(request.headers.get('content-length') || '0', 10);
  if (declared > (isB64 ? Math.ceil(MEDIA_MAX_BYTES * 4 / 3) + 4 : MEDIA_MAX_BYTES)) return json({ error: `Larger than the ${MEDIA_MAX_BYTES}-byte limit` }, 413);
  const item = await env.DB.prepare("SELECT id FROM items WHERE tenant_id = 'owner' AND source = ? AND ext_id = ?").bind(source, extId).first();
  if (!item) return json({ error: 'Unknown item (ingest the message first)' }, 404);
  const have = await env.DB.prepare('SELECT * FROM item_attachments WHERE item_id = ? AND idx = ? AND purged_at IS NULL ORDER BY created_at DESC LIMIT 1').bind(item.id, idx).first();
  if (have && have.status !== 'pending') return json({ ...rowOut(have), existed: true });
  const dim = (k) => { const v = parseInt(url.searchParams.get(k) || '', 10); return v > 0 && v < 100000 ? v : null; };
  const dur = (() => { const v = parseFloat(url.searchParams.get('duration') || ''); return v > 0 && v < 86400 ? Math.round(v * 10) / 10 : null; })();
  const now = new Date().toISOString();
  const attempts = (have ? have.attempts : 0) + 1;
  let status = 'stored', description = null, lastError = null, retry = null, n = 0, b64 = null;
  let r2Key = have ? have.r2_key : '';
  try {
    if (!isB64) {
      // raw bytes: streamed into R2 without touching them (no CPU), size checked by R2's result
      if (!env.ITEM_MEDIA) return json({ error: 'Raw uploads need the R2 binding' }, 503);
      const key = r2Key || `items/${item.id}/${idx}-${d.generateId().slice(0, 10)}`;
      const obj = declared > 0 && request.body ? await env.ITEM_MEDIA.put(key, request.body, { httpMetadata: { contentType: mime } })
        : await env.ITEM_MEDIA.put(key, await request.arrayBuffer(), { httpMetadata: { contentType: mime } });
      n = obj && obj.size != null ? obj.size : declared;
      if (!n) { await env.ITEM_MEDIA.delete(key); return json({ error: 'Empty body' }, 400); }
      if (n > MEDIA_MAX_BYTES) { await env.ITEM_MEDIA.delete(key); return json({ error: `${kind} is ${n} bytes; the limit is ${MEDIA_MAX_BYTES}` }, 413); }
      r2Key = key;
    } else {
      b64 = (await request.text()).replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]*=*$/.test(b64)) return json({ error: 'Invalid base64' }, 400);
      n = Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
      if (!n) return json({ error: 'Empty body' }, 400);
      if (n > MEDIA_MAX_BYTES) return json({ error: `${kind} is ${n} bytes; the limit is ${MEDIA_MAX_BYTES}` }, 413);
      if (env.ITEM_MEDIA && !r2Key) { const key = `items/${item.id}/${idx}-${d.generateId().slice(0, 10)}`; await env.ITEM_MEDIA.put(key, b64ToBytes(b64), { httpMetadata: { contentType: mime } }); r2Key = key; }
    }
    // optional AI description (MEDIA_AI=1; images/audio sent as base64 up to 5 MB)
    if (ai && b64 && n <= INLINE_MAX) {
      description = (await describeMedia(env, kind, mime, b64)).slice(0, 2000);
      if (!description) throw new Error('empty AI response');
      status = 'described';
    }
  } catch (e) {
    lastError = String(e && (e.message || e)).slice(0, 300);
    status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    retry = status === 'pending' ? retryAfter(e, attempts) : null;
  }
  const id = have ? have.id : 'ia-' + d.generateId().slice(0, 12);
  if (have) {
    await env.DB.prepare('UPDATE item_attachments SET status = ?, description = ?, attempts = ?, retry_after = ?, last_error = ?, r2_key = ?, bytes = ?, mime = ?, kind = ? WHERE id = ?')
      .bind(status, description, attempts, retry, lastError, r2Key, n, mime, kind, id).run();
  } else {
    await env.DB.prepare(`INSERT INTO item_attachments (id, tenant_id, item_id, idx, r2_key, mime, bytes, width, height, created_at, kind, status, description, attempts, retry_after, last_error, source, ext_id, chat_id, msg_id, filename, duration)
      VALUES (?, 'owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, item.id, idx, r2Key, mime, n, dim('width'), dim('height'), now, kind, status, description, attempts, retry, lastError, source, extId, clip('chat_id', 200), clip('msg_id', 200), filename, dur).run();
  }
  await refreshItemSnippet(env, item.id);
  d.emit(env, d.ctx, 'media_' + status, { props: { kind, bytes: n, attempts, ...(lastError ? { error: lastError.slice(0, 80) } : {}) } });
  const row = await env.DB.prepare('SELECT * FROM item_attachments WHERE id = ?').bind(id).first();
  return json({ ...rowOut(row), ...(lastError ? { error: lastError } : {}) }, have ? 200 : 201);
}

// GET /api/agent/items/attachment/pending (ingest key): what the collector should re-fetch and re-send
export async function pendingMedia(env) {
  const now = new Date().toISOString(), since = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = (await env.DB.prepare(`SELECT source, ext_id, chat_id, msg_id, idx, kind, attempts FROM item_attachments WHERE tenant_id = 'owner' AND status = 'pending'
      AND (retry_after IS NULL OR retry_after <= ?) AND created_at >= ? AND chat_id IS NOT NULL AND msg_id IS NOT NULL ORDER BY created_at LIMIT 20`).bind(now, since).all()).results || [];
  return json({ count: rows.length, pending: rows.map(r => ({ source: r.source, ext_id: r.ext_id, chat_id: r.chat_id, msg_id: r.msg_id, index: r.idx, kind: r.kind, attempts: r.attempts })) });
}

// PATCH /api/agent/attachments/:id {note}: the CoS's one-line note after looking at the image (null clears it)
export async function noteItemMedia(env, ctx, id, request, d) {
  let b; try { b = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }
  if (!b || !('note' in b) || (b.note !== null && (typeof b.note !== 'string' || !b.note.trim() || b.note.length > 300))) return json({ error: 'note: a string up to 300 chars, or null' }, 400);
  const row = await env.DB.prepare("SELECT * FROM item_attachments WHERE tenant_id = 'owner' AND id = ?").bind(id).first();
  if (!row) return json({ error: 'Not found' }, 404);
  const note = b.note === null ? null : b.note.replace(/\s+/g, ' ').trim();
  await env.DB.prepare('UPDATE item_attachments SET note = ?, note_at = ? WHERE id = ?').bind(note, note ? new Date().toISOString() : null, id).run();
  await refreshItemSnippet(env, row.item_id, !note);
  d.emit(env, ctx, 'media_noted', { props: { kind: row.kind || 'image', cleared: !note } });
  return json(rowOut(await env.DB.prepare('SELECT * FROM item_attachments WHERE id = ?').bind(id).first()));
}

// GET /api/agent/items/:id/attachments
export async function listItemMedia(env, itemId) {
  const item = await env.DB.prepare("SELECT id, source, ext_id, ts, title, who, snippet FROM items WHERE tenant_id = 'owner' AND id = ?").bind(itemId).first();
  if (!item) return json({ error: 'Not found' }, 404);
  const rows = (await env.DB.prepare('SELECT * FROM item_attachments WHERE item_id = ? ORDER BY idx').bind(itemId).all()).results || [];
  return json({ item, count: rows.length, attachments: rows.map(rowOut) });
}

// GET /api/agent/attachments/:id/raw — every type:
//   default: {…, encoding:'base64', data} (same shape as mail as=raw), up to 5 MB (bigger: use ?as=binary)
//   ?as=binary: the bytes, any size
//   ?as=text: pdf / docx / txt text via the mail extractors ({text, method, truncated, scanned for PDFs}), up to 5 MB
export async function rawItemMedia(env, id, url) {
  const row = await env.DB.prepare("SELECT * FROM item_attachments WHERE tenant_id = 'owner' AND id = ?").bind(id).first();
  if (!row) return json({ error: 'Not found' }, 404);
  if (!env.ITEM_MEDIA || !row.r2_key) return json({ error: 'Not stored', ...rowOut(row) }, 404);
  if (row.purged_at) return json({ error: `Deleted after ${MEDIA_RETENTION_DAYS} days`, ...rowOut(row) }, 410);
  const as = url.searchParams.get('as') || 'base64';
  if (!['base64', 'binary', 'text'].includes(as)) return json({ error: 'as must be base64, binary or text' }, 400);
  if (as !== 'binary' && row.bytes > INLINE_MAX) return json({ error: `${row.bytes} bytes is over the ${INLINE_MAX}-byte limit for as=${as}; use ?as=binary`, ...rowOut(row) }, 413);
  const obj = await env.ITEM_MEDIA.get(row.r2_key);
  if (!obj) return json({ error: 'Missing from storage', ...rowOut(row) }, 404);
  if (as === 'binary') return new Response(obj.body, { headers: { 'Content-Type': row.mime || 'application/octet-stream', 'Cache-Control': 'no-store',
    ...(row.filename ? { 'Content-Disposition': `inline; filename="${row.filename.replace(/[^A-Za-z0-9._ -]/g, '_')}"` } : {}) } });
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (as === 'text') {
    let out;
    try { out = await extractText(bytes, row.mime, row.filename); } catch (e) { return json({ error: e.message, ...rowOut(row) }, e.status || 422); }
    if (!out) return json({ ...rowOut(row), text: null, note: 'no text extraction for this type; use as=base64 or as=binary' });
    const truncated = out.text.length > TEXT_MAX;
    return json({ ...rowOut(row), ...out, truncated, text: truncated ? out.text.slice(0, TEXT_MAX) : out.text });
  }
  return json({ ...rowOut(row), filename: row.filename || `${row.id}.${(row.mime || '').split('/')[1] || 'bin'}`, encoding: 'base64', data: bytesToB64(bytes) });
}

// Daily: stored copies (R2) older than the retention window are deleted; the description and the item stay.
// Pending rows older than 7 days give up.
export async function purgeItemMedia(env, now = Date.now()) {
  const old = new Date(now - 7 * 86400000).toISOString();
  await env.DB.prepare("UPDATE item_attachments SET status = 'failed', retry_after = NULL WHERE status = 'pending' AND created_at < ?").bind(old).run();
  if (!env.ITEM_MEDIA) return { purged: 0 };
  const cutoff = new Date(now - MEDIA_RETENTION_DAYS * 86400000).toISOString();
  const rows = (await env.DB.prepare("SELECT id, r2_key FROM item_attachments WHERE tenant_id = 'owner' AND purged_at IS NULL AND r2_key != '' AND created_at < ? ORDER BY created_at LIMIT 1000").bind(cutoff).all()).results || [];
  if (!rows.length) return { purged: 0 };
  await env.ITEM_MEDIA.delete(rows.map(r => r.r2_key));
  const at = new Date(now).toISOString();
  const stmts = rows.map(r => env.DB.prepare('UPDATE item_attachments SET purged_at = ? WHERE id = ?').bind(at, r.id));
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  return { purged: rows.length };
}
