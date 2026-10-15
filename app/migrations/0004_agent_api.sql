-- B27 agent API: collected items + per-source health (additive only)
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  source TEXT NOT NULL,
  ext_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  who TEXT,
  title TEXT,
  snippet TEXT,
  unread INTEGER,
  needs_reply INTEGER,
  meta TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE(tenant_id, source, ext_id)
);
CREATE INDEX IF NOT EXISTS idx_items_tenant_source_ts ON items(tenant_id, source, ts);

CREATE TABLE IF NOT EXISTS source_health (
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  source TEXT NOT NULL,
  last_ok TEXT,
  last_attempt TEXT,
  last_error TEXT,
  stale_after_hours INTEGER DEFAULT 12,
  PRIMARY KEY (tenant_id, source)
);
