-- B42 weekly themes pinned in the app (additive only)
CREATE TABLE IF NOT EXISTS weekly_theme (
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  week_start TEXT NOT NULL,
  work_title TEXT,
  work_line TEXT,
  personal_title TEXT,
  personal_line TEXT,
  through_line TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, week_start)
);
