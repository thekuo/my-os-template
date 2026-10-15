-- Describe-on-arrival for chat media (no stored bytes on the free plan): AI description / transcript, retry state,
-- and where to re-fetch the original from (the collector re-reads pending ones from Beeper). Additive.
ALTER TABLE item_attachments ADD COLUMN kind TEXT;            -- image | audio
ALTER TABLE item_attachments ADD COLUMN status TEXT;          -- described | pending | failed | stored
ALTER TABLE item_attachments ADD COLUMN description TEXT;     -- image description + visible text, or voice transcript
ALTER TABLE item_attachments ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE item_attachments ADD COLUMN retry_after TEXT;
ALTER TABLE item_attachments ADD COLUMN last_error TEXT;
ALTER TABLE item_attachments ADD COLUMN source TEXT;
ALTER TABLE item_attachments ADD COLUMN ext_id TEXT;
ALTER TABLE item_attachments ADD COLUMN chat_id TEXT;
ALTER TABLE item_attachments ADD COLUMN msg_id TEXT;
CREATE INDEX IF NOT EXISTS idx_item_attachments_status ON item_attachments(status, retry_after);
