-- my-os v1: titles for free/busy calendar blocks, supplied by the CoS (the work calendar is free/busy only). Additive.
CREATE TABLE IF NOT EXISTS event_labels (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  date TEXT,            -- YYYY-MM-DD for a one-off label
  weekday INTEGER,      -- 0-6 (Sun-Sat) for a recurring label
  start TEXT NOT NULL,  -- HH:MM local time
  "end" TEXT,           -- HH:MM local time (optional; narrows the match)
  title TEXT NOT NULL,
  recurring INTEGER NOT NULL DEFAULT 0,
  created_via TEXT,
  created_at TEXT NOT NULL
);
