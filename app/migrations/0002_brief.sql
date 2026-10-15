-- Add briefs and suggestions tables
CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  date TEXT NOT NULL,
  body_md TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  brief_date TEXT NOT NULL,
  title TEXT NOT NULL,
  due_date TEXT,
  priority TEXT,
  list TEXT NOT NULL DEFAULT 'Tasks',
  recurrence TEXT,
  source TEXT,
  source_detail TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  task_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_briefs_tenant_date ON briefs(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_suggestions_tenant_status ON suggestions(tenant_id, status);
