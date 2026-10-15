-- my-os v1 data model (additive only). See design/BUILD-v1.md (c).
-- Task fields (due_date is reused as the v1 start date)
ALTER TABLE tasks ADD COLUMN start TEXT;
ALTER TABLE tasks ADD COLUMN evening INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN deadline TEXT;
ALTER TABLE tasks ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN area_id TEXT;
ALTER TABLE tasks ADD COLUMN project_id TEXT;
ALTER TABLE tasks ADD COLUMN heading_id TEXT;
ALTER TABLE tasks ADD COLUMN today_index REAL;
ALTER TABLE tasks ADD COLUMN sort_index REAL;
ALTER TABLE tasks ADD COLUMN trashed_at TEXT;
ALTER TABLE tasks ADD COLUMN reminder_at TEXT;
ALTER TABLE tasks ADD COLUMN repeat_rule TEXT;
ALTER TABLE tasks ADD COLUMN source TEXT;
ALTER TABLE tasks ADD COLUMN reason TEXT;
ALTER TABLE tasks ADD COLUMN suggestion_state TEXT;
ALTER TABLE tasks ADD COLUMN created_via TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_area ON tasks(area_id);

CREATE TABLE IF NOT EXISTS areas (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  title TEXT NOT NULL,
  sort REAL NOT NULL DEFAULT 0,
  created_at TEXT,
  archived_at TEXT
);
INSERT OR IGNORE INTO areas (id, tenant_id, title, sort) VALUES
  ('a-family', 'owner', 'Family', 1), ('a-health', 'owner', 'Health', 2), ('a-home', 'owner', 'Home', 3),
  ('a-money', 'owner', 'Money', 4), ('a-work', 'owner', 'Work', 5), ('a-people', 'owner', 'People', 6);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  area_id TEXT,
  title TEXT NOT NULL,
  notes TEXT,
  start TEXT NOT NULL DEFAULT 'anytime',
  start_date TEXT,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  sort REAL NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  completed_at TEXT,
  canceled_at TEXT,
  trashed_at TEXT
);

CREATE TABLE IF NOT EXISTS headings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  sort REAL NOT NULL DEFAULT 0,
  created_at TEXT,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  sort REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_checklist_task ON checklist_items(task_id);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  title TEXT NOT NULL,
  parent_id TEXT,
  sort REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (task_id, tag_id)
);

CREATE TABLE IF NOT EXISTS time_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  task_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  seconds INTEGER
);
CREATE INDEX IF NOT EXISTS idx_time_task ON time_entries(task_id);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  note TEXT,
  screen TEXT,
  app_version TEXT,
  device TEXT,
  screenshot TEXT
);

CREATE TABLE IF NOT EXISTS device_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  label TEXT,
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS wake_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kinds TEXT,
  ids TEXT,
  status TEXT
);

CREATE TABLE IF NOT EXISTS migration_log (
  task_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old TEXT,
  new TEXT,
  at TEXT NOT NULL
);
