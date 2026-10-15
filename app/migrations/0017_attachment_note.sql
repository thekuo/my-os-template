-- The CoS's own one-line note on a chat image after looking at it (shown in the item snippet). Additive.
ALTER TABLE item_attachments ADD COLUMN note TEXT;
ALTER TABLE item_attachments ADD COLUMN note_at TEXT;
