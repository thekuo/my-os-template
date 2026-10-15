-- B35 calendar change detection (additive only)
-- removed_at: set when a complete snapshot of the item's window no longer contains it (row is kept)
-- prev: JSON of the previous {ts,title,snippet,changed_at} after a snapshot saw it change
ALTER TABLE items ADD COLUMN removed_at TEXT;
ALTER TABLE items ADD COLUMN prev TEXT;
