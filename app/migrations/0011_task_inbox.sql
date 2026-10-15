-- Quick-add inbox: undated quick-adds wait here until given a date or moved to the backlog (additive only)
ALTER TABLE tasks ADD COLUMN inbox INTEGER NOT NULL DEFAULT 0;
