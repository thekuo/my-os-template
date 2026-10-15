-- B29 outcome box + B30 Won't do (additive only)
ALTER TABLE tasks ADD COLUMN ask_outcome INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN dropped_at TEXT;
