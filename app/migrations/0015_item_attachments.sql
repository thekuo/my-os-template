-- Chat images kept for the CoS: bytes live in a private R2 bucket (binding ITEM_MEDIA), rows link them to items.
-- Retention: the daily cron deletes the R2 object after 30 days and sets purged_at (the item's text stays). Additive.
CREATE TABLE IF NOT EXISTS item_attachments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  item_id TEXT NOT NULL,
  idx INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL,
  purged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_item_attachments_item ON item_attachments(item_id);
CREATE INDEX IF NOT EXISTS idx_item_attachments_created ON item_attachments(created_at);
