// B47: read email attachments on demand for agents. Lists a message's attachments and returns extracted text
// for text/*, PDF (text layer, best effort) and .docx. Nothing is stored: bytes are fetched from Gmail per request
// with the existing read-only token (gmail.readonly) and dropped after extraction.
import { mintGoogleToken } from './gcal.js';
import { htmlToText } from './gmail.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const MAX_BYTES = 5 * 1024 * 1024;
const TEXT_MAX = 100000; // chars returned
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function gmailGet(token, path) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) throw new HttpError(404, 'Not found in Gmail');
  if (!res.ok) {
    let reason = null;
    try { const j = await res.json(); reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || (j.error && j.error.status) || null; } catch (e) { /* ignore */ }
    throw new HttpError(res.status === 429 || res.status === 403 ? 503 : 502, `gmail ${res.status}${reason ? ' ' + reason : ''}`);
  }
  return res.json();
}

async function token(env) {
  if (!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN)) throw new HttpError(503, 'Mail is not configured');
  const t = await mintGoogleToken(env);
  if (!String(t.scope || '').split(' ').includes(GMAIL_SCOPE)) throw new HttpError(503, 'gmail scope not granted');
  return t.access_token;
}

// Attachment parts of a message (anything with a filename), with stable part ids
export function attachmentParts(payload) {
  const out = [];
  const stack = [payload];
  let guard = 0;
  while (stack.length && guard++ < 300) {
    const p = stack.shift();
    if (!p) continue;
    if (p.filename) {
      out.push({
        part_id: p.partId ?? null, filename: p.filename, mime: (p.mimeType || 'application/octet-stream').toLowerCase(),
        size: p.body && Number.isFinite(p.body.size) ? p.body.size : null,
        attachment_id: (p.body && p.body.attachmentId) || null, inline_data: (p.body && p.body.data) || null,
      });
    }
    if (Array.isArray(p.parts)) stack.push(...p.parts);
  }
  return out;
}

export function kindOf(a) {
  const name = (a.filename || '').toLowerCase();
  if (a.mime.startsWith('image/')) return 'image';
  if (a.mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (a.mime === DOCX || name.endsWith('.docx')) return 'docx';
  if (a.mime.startsWith('text/') || /\.(txt|csv|md|ics|html?)$/.test(name)) return 'text';
  return 'other';
}

// Text of a file (shared with chat attachments, src/media.js): docx, pdf (text layer; scanned = no text), text/html.
// Returns { text, method, scanned? } or null when the type has no text extraction.
export async function extractText(bytes, mime, filename) {
  const kind = kindOf({ mime: mime || '', filename: filename || '' });
  if (kind === 'docx') return { text: await docxText(bytes), method: 'docx' };
  if (kind === 'pdf') { const text = await pdfText(bytes); return { text, method: 'pdf', best_effort: true, scanned: !text.trim() }; }
  if (kind === 'text') { let text = utf8(bytes); if (mime === 'text/html' || /\.html?$/i.test(filename || '')) text = htmlToText(text); return { text, method: 'text' }; }
  return null;
}

const b64urlToBytes = (data) => {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};
const utf8 = (bytes) => new TextDecoder('utf-8', { fatal: false }).decode(bytes);
const latin1 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return s; };

async function inflate(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- .docx: find word/document.xml in the zip (central directory), inflate, strip XML ----
export async function docxText(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new HttpError(422, 'Not a valid .docx (zip) file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = utf8(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === 'word/document.xml') {
      const lNameLen = dv.getUint16(local + 26, true), lExtraLen = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(start, start + csize);
      const xmlBytes = method === 0 ? raw : method === 8 ? await inflate(raw, 'deflate-raw') : null;
      if (!xmlBytes) throw new HttpError(422, 'Unsupported .docx compression');
      return utf8(xmlBytes)
        .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new HttpError(422, 'No document text found in the .docx');
}

// ---- PDF: best-effort text layer. Inflate FlateDecode streams and read text operators (Tj, TJ, ', ").
// Works for common simple fonts; CID/encoded fonts may come back empty or garbled.
function pdfString(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] ?? String.fromCharCode(parseInt(c, 8))));
}
function textOps(content) {
  const out = [];
  const re = /\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")|(T\*|ET|Td|TD)\b/g;
  let m;
  while ((m = re.exec(content))) {
    if (m[1] !== undefined) {
      const parts = []; const sre = /\(((?:[^()\\]|\\.)*)\)|(-?\d+(?:\.\d+)?)/g; let s;
      while ((s = sre.exec(m[1]))) { if (s[1] !== undefined) parts.push(pdfString(s[1])); else if (Number(s[2]) < -200) parts.push(' '); }
      out.push(parts.join(''));
    } else if (m[2] !== undefined) out.push(pdfString(m[2]));
    else out.push(m[3] === 'ET' || m[3] === 'T*' ? '\n' : ' ');
  }
  return out.join('').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
}
export async function pdfText(bytes) {
  const src = latin1(bytes);
  if (!src.startsWith('%PDF')) throw new HttpError(422, 'Not a PDF');
  const chunks = [];
  // Linear scan: each "stream" keyword, its object dictionary just before it, data up to "endstream"
  let pos = 0, streams = 0;
  while (streams < 400) {
    const k = src.indexOf('stream', pos);
    if (k < 0) break;
    if (src.slice(k - 3, k) === 'end') { pos = k + 6; continue; }
    let start = k + 6;
    if (src[start] === '\r') start++;
    if (src[start] !== '\n') { pos = k + 6; continue; }
    start++;
    const end = src.indexOf('endstream', start);
    if (end < 0) break;
    streams++;
    const objAt = src.lastIndexOf(' obj', k);
    const dict = src.slice(Math.max(objAt, k - 2000), k);
    pos = end + 9;
    if (/\/(Subtype\s*\/Image|Length1|FontFile|Type\s*\/XRef|Type\s*\/ObjStm)/.test(dict)) continue;
    let e = end;
    while (e > start && (bytes[e - 1] === 10 || bytes[e - 1] === 13)) e--; // EOL before endstream
    let data = bytes.subarray(start, e);
    if (/\/FlateDecode/.test(dict)) {
      try { data = await inflate(data, 'deflate'); } catch (e) { continue; }
    } else if (/\/Filter/.test(dict)) continue; // other filters: skip
    const content = latin1(data);
    if (/\b(Tj|TJ)\b/.test(content)) chunks.push(textOps(content));
  }
  return chunks.join('\n').trim();
}

// ---- endpoints ----
const pub = (a) => ({ part_id: a.part_id, filename: a.filename, mime: a.mime, size: a.size, kind: kindOf(a), attachment_id: a.attachment_id });

// GET /api/agent/mail/attachments?msg_id=
export async function listAttachments(env, url) {
  const msgId = url.searchParams.get('msg_id');
  if (!msgId || !/^[A-Za-z0-9_-]{1,100}$/.test(msgId)) return { status: 400, body: { error: 'msg_id required' } };
  try {
    const tk = await token(env);
    const m = await gmailGet(tk, `/messages/${encodeURIComponent(msgId)}?format=full`);
    const atts = attachmentParts(m.payload || {}).map(pub);
    return { status: 200, body: { msg_id: msgId, count: atts.length, attachments: atts } };
  } catch (e) { return { status: e.status || 500, body: { error: e.message } }; }
}

// GET /api/agent/mail/attachment?msg_id=&id=<part_id or attachment_id>&as=text
export async function readAttachment(env, url, emit = () => {}) {
  const msgId = url.searchParams.get('msg_id'), id = url.searchParams.get('id');
  const as = url.searchParams.get('as') || 'text';
  if (!msgId || !/^[A-Za-z0-9_-]{1,100}$/.test(msgId) || !id || id.length > 2000) return { status: 400, body: { error: 'msg_id and id required' } };
  if (as !== 'text' && as !== 'raw') return { status: 400, body: { error: 'as must be text or raw' } };
  try {
    const tk = await token(env);
    // Re-read the message: attachment ids are not stable across fetches, part ids are
    const m = await gmailGet(tk, `/messages/${encodeURIComponent(msgId)}?format=full`);
    const a = attachmentParts(m.payload || {}).find(x => x.part_id === id || x.attachment_id === id);
    if (!a) return { status: 404, body: { error: 'No such attachment on this message' } };
    const meta = pub(a);
    const kind = meta.kind;
    if (as === 'text' && (kind === 'image' || kind === 'other')) {
      return { status: 200, body: { msg_id: msgId, ...meta, text: null, note: (kind === 'image' ? 'images return metadata only' : 'no text extraction for this type') + '; use as=raw for the bytes' } };
    }
    if (a.size !== null && a.size > MAX_BYTES) return { status: 413, body: { error: `Attachment is ${a.size} bytes; the limit is ${MAX_BYTES}`, ...meta } };
    let data = a.inline_data;
    if (!data) {
      if (!a.attachment_id) return { status: 404, body: { error: 'Attachment has no data' } };
      const body = await gmailGet(tk, `/messages/${encodeURIComponent(msgId)}/attachments/${encodeURIComponent(a.attachment_id)}`);
      data = body.data;
    }
    if (as === 'raw') {
      // Gmail already sends base64url: convert the alphabet (no decode/re-encode, cheap for 5 MB). Nothing is stored.
      let b64 = String(data || '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
      const n = Math.floor(b64.length * 3 / 4);
      if (n > MAX_BYTES) return { status: 413, body: { error: `Attachment is ${n} bytes; the limit is ${MAX_BYTES}`, ...meta } };
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      emit('mail_attachment_read', { kind, bytes: n, raw: true });
      return { status: 200, body: { msg_id: msgId, ...meta, bytes: n, encoding: 'base64', data: b64 } };
    }
    const bytes = b64urlToBytes(data || '');
    if (bytes.length > MAX_BYTES) return { status: 413, body: { error: `Attachment is ${bytes.length} bytes; the limit is ${MAX_BYTES}`, ...meta } };
    let text;
    if (kind === 'text') { text = utf8(bytes); if (a.mime === 'text/html' || /\.html?$/i.test(a.filename)) text = htmlToText(text); }
    else if (kind === 'docx') text = await docxText(bytes);
    else text = await pdfText(bytes);
    const truncated = text.length > TEXT_MAX;
    emit('mail_attachment_read', { kind, bytes: bytes.length, chars: text.length });
    // A PDF with no text layer is a scan: say so, so the caller fetches as=raw
    const scanned = kind === 'pdf' && !text.trim();
    return { status: 200, body: { msg_id: msgId, ...meta, bytes: bytes.length, method: kind, ...(kind === 'pdf' ? { best_effort: true, scanned } : {}), truncated, text: truncated ? text.slice(0, TEXT_MAX) : text } };
  } catch (e) { return { status: e.status || 500, body: { error: e.message } }; }
}
