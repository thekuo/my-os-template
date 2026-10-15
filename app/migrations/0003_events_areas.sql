-- B24 areas + B25 telemetry (additive only)
ALTER TABLE tasks ADD COLUMN area TEXT;
ALTER TABLE suggestions ADD COLUMN area TEXT;

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_id TEXT,
  suggestion_id TEXT,
  area TEXT,
  props TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_tenant_at ON events(tenant_id, at);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
