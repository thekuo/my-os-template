-- B37 P2 mail collector (additive only)
ALTER TABLE sync_cursors ADD COLUMN state TEXT;

CREATE TABLE IF NOT EXISTS mail_messages (
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  msg_id TEXT NOT NULL,
  thread_id TEXT,
  ts TEXT NOT NULL,
  direction TEXT NOT NULL,
  from_addr TEXT,
  from_name TEXT,
  to_addrs TEXT,
  cc_count INTEGER,
  subject TEXT,
  snippet TEXT,
  body_text TEXT,
  body_purged_at TEXT,
  labels TEXT,
  category TEXT,
  is_read INTEGER,
  is_archived INTEGER,
  is_trashed INTEGER,
  is_spam INTEGER,
  is_starred INTEGER,
  has_attachments INTEGER,
  has_invite INTEGER,
  list_unsubscribe INTEGER,
  lane TEXT,
  update_kind TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (tenant_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_ts ON mail_messages(tenant_id, ts);
CREATE INDEX IF NOT EXISTS idx_mail_thread ON mail_messages(tenant_id, thread_id, ts);
