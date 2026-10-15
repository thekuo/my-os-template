CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  list TEXT NOT NULL,
  title TEXT NOT NULL,
  priority TEXT,
  due_date TEXT,
  recurrence TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  parent_task_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  completed_at TEXT,
  snoozed_from TEXT,
  area TEXT,
  ask_outcome INTEGER NOT NULL DEFAULT 0,
  dropped_at TEXT,
  inbox INTEGER NOT NULL DEFAULT 0,
  start TEXT,
  evening INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  flagged INTEGER NOT NULL DEFAULT 0,
  area_id TEXT,
  project_id TEXT,
  heading_id TEXT,
  today_index REAL,
  sort_index REAL,
  trashed_at TEXT,
  reminder_at TEXT,
  repeat_rule TEXT,
  source TEXT,
  reason TEXT,
  suggestion_state TEXT,
  created_via TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS completions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  task_id TEXT NOT NULL,
  due_date TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  snapshot TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_list ON tasks(tenant_id, list);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_completions_task ON completions(task_id);

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
  area TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  task_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_briefs_tenant_date ON briefs(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_suggestions_tenant_status ON suggestions(tenant_id, status);

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

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  source TEXT NOT NULL,
  ext_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  who TEXT,
  title TEXT,
  snippet TEXT,
  unread INTEGER,
  needs_reply INTEGER,
  meta TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  removed_at TEXT,
  prev TEXT,
  UNIQUE(tenant_id, source, ext_id)
);
CREATE INDEX IF NOT EXISTS idx_items_tenant_source_ts ON items(tenant_id, source, ts);

CREATE TABLE IF NOT EXISTS source_health (
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  source TEXT NOT NULL,
  last_ok TEXT,
  last_attempt TEXT,
  last_error TEXT,
  stale_after_hours INTEGER DEFAULT 12,
  retired_at TEXT,
  PRIMARY KEY (tenant_id, source)
);

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
  state TEXT,
  PRIMARY KEY (tenant_id, source, scope)
);

-- B37 P2 mail
CREATE TABLE IF NOT EXISTS mail_messages (
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  msg_id TEXT NOT NULL,
  thread_id TEXT,
  ts TEXT NOT NULL,
  direction TEXT NOT NULL,
  from_addr TEXT,
  from_name TEXT,
  to_addrs TEXT,
  cc_count INTEGER,
  subject TEXT,
  snippet TEXT,
  body_text TEXT,
  body_purged_at TEXT,
  labels TEXT,
  category TEXT,
  is_read INTEGER,
  is_archived INTEGER,
  is_trashed INTEGER,
  is_spam INTEGER,
  is_starred INTEGER,
  has_attachments INTEGER,
  has_invite INTEGER,
  list_unsubscribe INTEGER,
  lane TEXT,
  update_kind TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (tenant_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_ts ON mail_messages(tenant_id, ts);
CREATE INDEX IF NOT EXISTS idx_mail_thread ON mail_messages(tenant_id, thread_id, ts);

-- B42 weekly theme
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

-- my-os v1 model
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

-- my-os v1 settings (migration 0013)
CREATE TABLE IF NOT EXISTS settings (
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

-- my-os v1 event labels (migration 0014)
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

-- chat images (migration 0015)
CREATE TABLE IF NOT EXISTS item_attachments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'owner',
  item_id TEXT NOT NULL,
  idx INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL,
  purged_at TEXT,
  kind TEXT,
  status TEXT,
  description TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_after TEXT,
  last_error TEXT,
  source TEXT,
  ext_id TEXT,
  chat_id TEXT,
  msg_id TEXT,
  note TEXT,
  note_at TEXT,
  filename TEXT,
  duration REAL
);
CREATE INDEX IF NOT EXISTS idx_item_attachments_status ON item_attachments(status, retry_after);
CREATE INDEX IF NOT EXISTS idx_item_attachments_item ON item_attachments(item_id);
CREATE INDEX IF NOT EXISTS idx_item_attachments_created ON item_attachments(created_at);
