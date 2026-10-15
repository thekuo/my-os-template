-- B37 P1 calendar collector (additive only)
CREATE TABLE IF NOT EXISTS calendar_events (
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recurring_event_id TEXT,
  start_raw TEXT,
  end_raw TEXT,
  start_ts TEXT NOT NULL,
  end_ts TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  location TEXT,
  status TEXT,
  attendees TEXT,
  updated TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  removed_at TEXT,
  prev TEXT,
  PRIMARY KEY (tenant_id, calendar_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(tenant_id, start_ts);

CREATE TABLE IF NOT EXISTS calendar_changes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  before TEXT,
  after TEXT,
  via TEXT
);
CREATE INDEX IF NOT EXISTS idx_calendar_changes_at ON calendar_changes(tenant_id, at);

CREATE TABLE IF NOT EXISTS sync_cursors (
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  source TEXT NOT NULL,
  scope TEXT NOT NULL,
  cursor TEXT,
  last_ok TEXT,
  last_attempt TEXT,
  last_error TEXT,
  last_full_sync TEXT,
  PRIMARY KEY (tenant_id, source, scope)
);
