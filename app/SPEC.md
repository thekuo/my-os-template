# my-os app — MVP spec (v0.1)
Thin first slice of the original product intent: a Microsoft To Do–style **Planned** view with check-off. Replaces To Do for day-to-day use. Editing: tap a task to open the edit sheet (v0.5); the coordinator agent can also edit D1 directly.

## Stack
- One Cloudflare Worker (`src/index.js`, plain JS modules, no framework, no build step) serving static assets + JSON API.
- Static files in `public/` via Workers Static Assets (`[assets] directory = "./public"`, `binding = "ASSETS"`, `run_worker_first = true` so auth applies to everything).
- D1 database `my-os` (binding `DB`). Schema in `schema.sql`, seed in `seed.sql`.
- Custom domain: `my-os.example.com` (`routes = [{ pattern = "my-os.example.com", custom_domain = true }]`).
- wrangler as a devDependency (`package.json` scripts: `dev`, `deploy`, `db:init:local`, `db:seed:local`).

## Data model (`tasks`)
| column | type | notes |
|---|---|---|
| id | TEXT PK | short random id |
| tenant_id | TEXT NOT NULL DEFAULT 'owner' | multi-tenant ready |
| list | TEXT NOT NULL | 'Tasks' or 'Birthdays' |
| title | TEXT NOT NULL | without "P0 - " prefix |
| priority | TEXT NULL | 'P0'..'P3' or NULL |
| due_date | TEXT NULL | 'YYYY-MM-DD' (local date, no time) |
| recurrence | TEXT NULL | 'daily','weekdays','weekly','monthly','yearly' or NULL |
| starred | INTEGER NOT NULL DEFAULT 0 | |
| parent_task_id | TEXT NULL | set => this row is a Step of the parent |
| sort_order | INTEGER NOT NULL DEFAULT 0 | step order |
| notes | TEXT NULL | free text; rendered with line breaks and tappable links |
| area | TEXT NULL | kids, family, health, work, venture, finance, house |
| snoozed_from | TEXT NULL | original due date while snoozed |
| completed_at | TEXT NULL | ISO timestamp |
| created_at, updated_at | TEXT | ISO timestamps |
Plus `events(id, tenant_id, at, kind, task_id, suggestion_id, area, props JSON)` — telemetry log (no FK, survives deletes), `briefs`, `suggestions` (with `area`), and `completions(id, tenant_id, task_id, due_date, completed_at)` — an append-only log of every check-off (future "Signal" primitive; also powers undo).

## Behavior
- "Today" is computed in **America/Los_Angeles** (server and client).
- **Complete a non-recurring task**: set completed_at; it disappears from Planned.
- **Complete a recurring task**: log to completions, advance due_date from the *old due date* by one interval (daily +1d; weekdays → next Mon–Fri; weekly +7d; monthly same day next month, clamped to month end; yearly same date next year, Feb 29 → Feb 28), keep completed_at NULL, and **reset all its steps' completed_at to NULL**.
- **Complete a step**: toggles the step only. Parent is not auto-completed.
- **Undo**: `POST /api/tasks/:id/uncomplete` restores the previous state (for recurring: restore previous due_date and step states recorded in the completion row as JSON `snapshot`). UI shows an "Undo" toast for 6s after any check-off.
- **Star**: `POST /api/tasks/:id/star` toggles starred.

## API (all JSON, all behind the session cookie unless noted)
- `GET /api/tasks` → open top-level tasks (plus `steps: []`; Won't do tasks excluded), `today` (LA date), `completed_today` (B4: `[{task_id, title, completed_at, recurring, can_undo, ...}]`) and `dropped` (B30: Won't do tasks from the last 30 days).
- `POST /api/tasks/:id/drop` (B30 Won't do) body `{reason?, text?, series?}`: reason `not_worth_it|someone_else|overtaken|changed_mind|duplicate` (or the label), text ≤200 one line; recurring tasks need `series: 'skip'` (advance to the next occurrence) or `'stop'` (drop the series). Sets `dropped_at` (soft close) and appends `YYYY-MM-DD won't do: <reason> (<text>)` to notes when a reason/text is given. `POST /api/tasks/:id/restore` clears `dropped_at`, or with `{due_date, snoozed_from}` undoes a skip.
- `POST /api/tasks/:id/signal` (B28/B29) body `{kind: 'later', reason: no_time|waiting|not_important|blocked, text?}` or `{kind: 'outcome', text}`: appends one dated line to notes and adds `reason`/`text` (or `outcome`) to the latest snooze/edit/completion event's props.
- `POST /api/tasks` → create. Body: title, list, due_date, recurrence, priority, area, notes (optional), raw/explicit (quick-add + AI cleanup).
- `PATCH /api/tasks/:id` → partial edit of title, notes, due_date (cannot be cleared), recurrence, priority (P0–P3/null), list, area. Changing due_date clears `snoozed_from`. Returns the task.
- `DELETE /api/tasks/:id` → delete task and steps.
- `POST /api/tasks/:id/complete | uncomplete | star`, `POST /api/tasks/:id/snooze` (`{to: tomorrow|nextweek}`), `/unsnooze` (`{due_date, snoozed_from}`), `/priority` (`{priority}`).
- `GET /api/brief` → latest brief + pending suggestions (logs `brief_viewed`); `POST /api/suggestions/:id/accept | dismiss`.
- `POST /api/events` → client telemetry; kinds `app_open` (props.mode), `view` (props.name), `sheet_opened` (task_id). Others → 400.
- `GET /api/stats?days=7` → counts_by_kind, completions {on_time, late, avg_days_late, by_area}, repeatedly_pushed, overdue_untouched_7d, suggestions_by_source, app_open_by_day.
- `GET /snapshot.md?key=…` → read-only markdown for agents; **no cookie**, secret `SNAPSHOT_KEY`; 401 otherwise.
- Server events written by the handlers: task_created, task_completed, task_uncompleted, task_snoozed, task_unsnoozed, task_edited, task_starred, task_unstarred, task_priority, task_deleted, task_dropped, task_skipped, task_restored, task_reason (fallback when no event to attach a reason to), suggestion_accepted, suggestion_dismissed, brief_viewed.

## Agent API (B27) — for cloud sessions and routines
Base URL `https://my-os.example.com`. Needs only HTTPS and the key; no wrangler, no Cloudflare credentials.

**Auth.** Every `/api/agent/*` request needs `Authorization: Bearer <AGENT_KEY>` (Worker secret `AGENT_KEY`, compared in constant time). Missing or wrong key → `401 {"error":"Unauthorized"}`. The app cookie does **not** work here and the agent key does **not** work on `/api/*` app routes. Separate from `SNAPSHOT_KEY`. Rotate: `npx wrangler secret put AGENT_KEY`. All bodies and responses are JSON (`Content-Type: application/json`) except the snapshot (markdown). Errors: `{"error": "..."}` with 400 (validation), 404, 401, 500. "Today" is America/Los_Angeles; timestamps are ISO 8601 UTC.

Enums: priority `P0|P1|P2|P3`; list `Tasks|Birthdays`; recurrence `daily|weekdays|weekly|monthly|yearly`; area `kids|family|health|work|venture|finance|house`; suggestion source `Gmail|Calendar|Messages|Messenger|WhatsApp`.

### Collected items and source health
- **Scoped ingest key:** optional secret `INGEST_KEY`. A Bearer `INGEST_KEY` may only `POST /api/agent/ingest` and `POST /api/agent/health` (everything else under `/api/agent/` → 403). For collectors on other machines, so they never hold `AGENT_KEY`.
- `POST /api/agent/ingest` body `{"source":"whatsapp","items":[{"ext_id","ts","who","title","snippet","unread","needs_reply","meta"}]}`. `source`: 1-40 chars of letters, digits, `_ . -`. Max 500 items. Required per item: `ext_id` (≤200 chars, stable id of the message/thread/event) and `ts` (ISO 8601). Optional: `who` (≤120), `title` (≤200), `snippet` (≤300; longer is truncated), `unread`/`needs_reply` (booleans), `meta` (any JSON, ≤2000 chars serialized). Upserts on `(source, ext_id)`: a repeat updates `ts`, `last_seen` and any field supplied (omitted/null fields keep their old value; `unread`/`needs_reply` can be flipped by sending the boolean). Also marks the source healthy (`last_ok = last_attempt = now`, clears `last_error`). Response `{"inserted":N,"updated":N}`, plus `"rejected":[{"index","error"}]` for bad items (the rest are still stored). Send only minimal fields; never full message bodies. Items not seen for 30 days are purged by a daily cron (11:17 UTC).
  - **Snapshot diff (B35):** optional `"snapshot":{"source","window_start","window_end","complete":true}` (ISO 8601, start < end; `source` must match if given) says the batch is the full set of items for that source with `ts` in `[window_start, window_end)`. The response then also has `"added":[ext_id]` (new, or previously removed), `"changed":[{"ext_id","before":{ts,title,snippet},"after":{…}}]` (omitted title/snippet count as unchanged; the previous values are stored in `prev`), and `"removed":[ext_id]` (stored items in the window missing from the batch: `removed_at` is set, the row is kept). Removals apply only when `complete` is `true` and no item was rejected; otherwise `"removals_skipped":"<why>"`. A removed item that is ingested again is un-removed. Logs `calendar_diff` with counts. Recurring events must use the instance id as `ext_id`.
- `POST /api/agent/health` body `{"source","ok":boolean,"error"?:string,"stale_after_hours"?:1-720}`. Use `ok:false` + `error` when a collection attempt fails (sets `last_attempt` and `last_error`, keeps `last_ok`); `ok:true` also sets `last_ok`. Returns the source's health row.
- Retired sources (B40): `source_health.retired_at` (migration 0009 retires the superseded agent-reported `calendar`, `gmail`, `messages`, `messenger`). Retired rows are hidden from `GET /api/agent/health` (unless `include_retired=1`) and from the snapshot's Source freshness, and are never stale; health posts don't un-retire. `POST /api/agent/health/retire {source, retired: boolean}` (full agent key only) retires or restores one.
- `GET /api/agent/health` → `{"now","sources":[{"source","last_ok","last_attempt","last_error","stale_after_hours","age_hours","stale"}]}`. `stale` is true when `last_ok` is missing or older than `stale_after_hours` (default 12).
- `GET /api/agent/items?since=ISO&source=&unread=1&limit=` → `{"since","count","items":[...]}` newest first by `ts`. Defaults: since = 48h ago, limit 200 (max 1000). Items have booleans for `unread`/`needs_reply` and `meta` parsed. Removed items (B35) are hidden unless `include_removed=1`; items have `removed_at` and `prev` (parsed, or null).

### Calendar collector (B37 P1)
- A Worker cron (`*/10 * * * *`) syncs Google Calendar into `calendar_events` with per-calendar sync tokens (`sync_cursors`), read-only (`calendar.readonly`). Config: secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `CALENDAR_IDS` (comma-separated, default `primary`); optional `CALENDAR_TZ`. Unset → no-op, health `gcal_sync: not configured`. Setup: `docs/google-oauth-setup.md`.
- First sync = baseline of now-7d..now+60d (no change rows). Then added / changed (start, end, all-day, title, location, status) / cancelled are logged in `calendar_changes`; cancelled or vanished events keep their row with `removed_at`; changed ones keep `prev`. Sync token expired (410) → full window resync + diff. The daily cron also does a full window resync and purges events that ended > 365 days ago and changes > 90 days old.
- **Free/busy calendars (P1b):** optional secret `FREEBUSY_IDS` (comma-separated) for calendars shared as free/busy only. Each run calls `freeBusy.query` for the window and stores busy blocks as events with `title: "busy"`, `status: "busy"`, no details; new blocks are `added`, vanished ones `cancelled` (a moved block is both), `via: "freebusy"`. First read is a baseline. An ID in both lists is synced in full. Events have `free_busy: true|false`. The free/busy window is snapped to whole days in CALENDAR_TZ (start of day -7 .. end of day +60, B41), and blocks within a day of either edge (clipped by Google) are stored but never logged as added/cancelled.
- `POST /api/agent/calendar/sync` (`?full=1` = window resync) runs the sync now, same as the cron → `{"configured","results":[{calendar, mode, added, changed, cancelled, events, ms | error}]}` (no tokens).
- `GET /api/agent/calendar/changes?since=ISO&limit=` (default since 24h, limit 500, max 2000) → `{"since","count","changes":[{"at","kind":"added|changed|cancelled","calendar_id","event_id","title","before","after","via":"incremental|resync|freebusy"}]}` oldest first. `before`/`after` = `{start,end,all_day,title,location,status}` (start/end as Google gives them: dateTime or date).
- `GET /api/agent/calendar/events?start=ISO&end=ISO&include_removed=1` (default today 00:00 in CALENDAR_TZ + 7 days) → `{"start","end","count","events":[{calendar_id,event_id,recurring_event_id,start,end,start_ts,end_ts,all_day,title,location,status,free_busy,attendees:{count,self},updated,removed_at,prev}]}` overlapping the window, by start.
- `GET /api/agent/health` also returns `cursors: [{source, scope, has_cursor, last_ok, last_attempt, last_error, last_full_sync, lag_minutes}]`.
- Telemetry: `calendar_sync` {calendar, mode initial|incremental|resync, added, changed, cancelled, events, pages, ms | error} only for runs that changed something, resynced, or failed.

### Mail collector (B37 P2)
- Runs on its own cron `5-55/10 * * * *` (offset from calendar, separate free-plan budget; same Google OAuth client and refresh token; needs the `gmail.readonly` scope, else health `gmail_sync: gmail scope not granted`). Read-only.
- First run: resumable backfill of `newer_than:MAIL_BACKFILL_DAYS` (default 14; spam/trash excluded), `MAIL_MAX_FETCH` messages per run (default 40), fetched through the Gmail batch endpoint (10 gets per batch request, batches sequential: Gmail limits per-user concurrency). Rate limits (403 rate/userRateLimitExceeded, 429) and 5xx are not failures: the run commits what it has, keeps the failed ids in the cursor state and retries only those first next run; health shows `rate limited, will retry (<reason>)` or `temporary Gmail error, will retry (<reason>)`. Other 4xx (e.g. insufficientPermissions) are errors with the Google reason in health and the response. Then `history.list` from the stored historyId: new messages fetched, label changes (read, archived, trashed, starred) applied from the history records, deletions become tombstones (`deleted_at`, body and snippet purged, headers kept). Each page commits on its own with the cursor in the same D1 batch; an expired historyId (404) restarts the bounded backfill.
- `mail_messages`: msg_id, thread_id, ts, direction (`out` = SENT), from_addr/from_name, to_addrs, cc_count, subject, snippet, body_text (≤4,000 chars, text/plain or stripped HTML, quoted replies cut; none for promotions/social or mail older than 30 days), labels, category (primary when there is no category label; forums and updates keep bodies and get lanes/rules), is_read/is_archived/is_trashed/is_spam/is_starred, has_attachments, has_invite, list_unsubscribe, lane, update_kind, deleted_at.
- Lanes: `MAIL_LANES` JSON `[{"lane","from":[...],"subject":[...]}]` (from = address substring, `@domain` = domain suffix; subject = case-insensitive substring; first match wins). Update kinds: `MAIL_RULES` (same shape plus `kind`) checked first, then defaults bills / appointments (incl. calendar invites) / security / travel by subject. `POST /api/agent/mail/retag` re-applies both to stored mail.
- Retention (daily cron): bodies purged after 30 days, rows deleted after 365 days, tombstones after 90.
- `GET /api/agent/mail/messages?since=ISO&lane=&update_kind=&category=&direction=in|out&unread=1&q=&include_body=1&include_deleted=1&include_trash=1&limit=` (default since 48h, limit 200, max 1000; trash/spam/deleted hidden by default; bodies only with include_body) → `{"since","count","messages":[...]}` newest first.
- `GET /api/agent/mail/threads/:thread_id?include_body=1` → the thread's stored messages, oldest first (404 if none). `POST /api/agent/mail/sync` runs the sync now.
- Telemetry: `mail_sync` {mode backfill|incremental|resync, fetched, added, label_changes, deleted, pages, ms | error}, only for non-quiet runs.

### Mail attachments (B47)
- `GET /api/agent/mail/attachments?msg_id=` → `{msg_id, count, attachments:[{part_id, filename, mime, size, kind: text|pdf|docx|image|other, attachment_id}]}`, read live from Gmail (`messages.get`).
- `GET /api/agent/mail/attachment?msg_id=&id=<part_id>&as=text` → `{…meta, bytes, method, text, truncated}` (text capped at 100k chars). Use `part_id`: Gmail attachment ids change between fetches. Extraction: `text/*` (HTML stripped), `.docx` (word/document.xml from the zip), PDF text layer (`best_effort: true`; simple fonts only, scanned/CID-font PDFs may return little). Images and other types return metadata with `text: null`. Over 5 MB → 413. Gmail rate limit / 403 → 503 with the Google reason.
- Nothing is stored: bytes are fetched per request with the read-only token and dropped. Full agent key only (ingest key 403). Telemetry `mail_attachment_read` {kind, bytes, chars}. Cost per read: 3 subrequests (token, message, attachment); large PDFs can be CPU-heavy on the free plan.

### Views (B37 P4)
- `GET /api/agent/views/awaiting-me?days=14&include_archived=1`: mail threads whose latest message is inbound, Primary, not bulk (List-Unsubscribe) or automated (noreply…), not archived unless asked; plus collected chats whose latest message has `needs_reply`. Items `{kind: mail|chat, id (thread or chat id), title, who, last_ts, age_hours, snippet, lane, …}`, oldest first.
  - Noise (B39): chats whose title/sender is an SMS short code (all digits, ≤6) or a toll-free number, or whose inbound messages in the window all look like one-time codes or marketing, are left out (`noise_hidden` counts them; `include_noise=1` shows them). Chats titled with a raw phone number (`raw_number: true`) rank after named contacts. The chat collector applies the same rules to `needs_reply`.
- `GET /api/agent/views/awaiting-them?days=14&min_hours=48`: mail threads and 1:1 chats where my message is the latest and at least `min_hours` old (mail items include `to_addrs`). Oldest first.
- `GET /api/agent/views/new-since?since=ISO&include_bulk=1&limit=` (default since 24h): `{counts, mail, chats, calendar}`: inbound mail (Promotions/Social only with include_bulk; trash/spam/deleted never), inbound chat messages, calendar changes. Newest first.
- App: `/api/brief` also returns `sources` (Calendar / Mail / Chats collector health: ok, warn = error but recent success e.g. rate limited, stale, off = not set up); the app shows them as a chip strip above the brief (hidden until a collector exists; tap a chip for last-ok time and error). Telemetry: `view` {name: 'health_chip'}.

### Quick-add Inbox and no AI rewrite (Oct 11 hotfix)
- Quick-add no longer runs the AI cleanup: the title is kept as typed (minus the explicit tokens the parser understands: dates like `tomorrow`/`fri`, `p0`-`p3`, repeats, `someday`/`backlog`), and no date or priority is guessed. Set the Worker var `QUICKADD_AI=1` to turn the old cleanup back on.
- A quick-add with no typed date and no repeat lands in the **Inbox** (`tasks.inbox = 1`, due date NULL; migration 0011) instead of defaulting to today. The app shows an "Inbox (n)" section at the top of the list (scope/area-filtered); tapping a row opens the edit sheet. A task leaves the Inbox when it gets a due date or is moved to the backlog (edit sheet "Move to backlog" or `PATCH {backlog: true}`); completing or dropping it also ends its Inbox life. Inbox tasks are not in the Backlog section or `status=backlog`.
- Agent API: `GET /api/agent/tasks?status=inbox`; the snapshot shows an `## Inbox (n)` count line. Agent-created tasks never go to the Inbox.
- Telemetry: `quickadd_inbox` on create; `inbox_triaged` {to: date|backlog|done|dropped}.

### Backlog (B43)
- A task with no `due_date` is in the **backlog** (existing undated tasks included). `POST /api/agent/tasks` and the app's `POST /api/tasks` accept `"backlog": true`: stored with `due_date` NULL, no default-to-today, and not combinable with a due date or a repeat. `PATCH` (agent and app) accepts `"backlog": true` to move a task to the backlog (rejected for recurring tasks unless `recurrence: null` comes with it); a `due_date` schedules it again. `GET /api/agent/tasks?status=backlog` lists them. The snapshot shows only a `## Backlog (n)` count line. Telemetry: `task_backlogged` {via, created?, from?}, `task_scheduled` {to, via}.
- Quick-add: the word `someday` or `backlog` puts the task in the backlog (an explicit date or a repeat wins).
- App: a collapsed "Backlog (n)" section at the bottom (before Won't do), scope- and area-filtered, grouped by area (No area last); each row has a Schedule date picker; tapping the title opens the edit sheet, which can also "Move to backlog".

### Weekly theme (B42)
- `weekly_theme` (migration 0010): one row per Monday-start week (`week_start`, LA dates): `work_title` (≤120), `work_line` (≤300), `personal_title` (≤120), `personal_line` (≤300), `through_line` (≤300), `updated_at`.
- `GET /api/agent/theme[?week_start=YYYY-MM-DD]` → `{week_start, theme|null}` (default: the current week). `PUT /api/agent/theme {week_start (a Monday), …fields}` replaces that week's theme (omitted fields become null; at least one field). Full agent key only. Logs `theme_set`.
- App: `/api/brief` returns `theme` for the current week; the app pins it as a compact "This week" card at the top (Work / Personal lines, through-line in italics), collapsible with the state remembered per device; hidden when the week has no theme. Telemetry: `view` {name: 'theme_card', state}.

### Snapshot and tasks
- `GET /api/agent/snapshot` → markdown, same as `/snapshot.md` (Overdue, Today, Recurring due today, This week, Completed last 24h, Pending suggestions) plus a final `## Source freshness` section (one line per source: ok/STALE, last ok, last error).
- `GET /api/agent/tasks?status=open|all|dropped` (default `open`) → `{"today","count","tasks":[...]}` top-level tasks with `steps_total`/`steps_done`, `ask_outcome` (0/1) and `dropped_at`, ordered by due date then priority (max 1000). `open` excludes completed and Won't do tasks; `dropped` = Won't do only.
- `POST /api/agent/tasks` body `{title (required, ≤200), list?, priority?, due_date? (YYYY-MM-DD, default today LA), recurrence?, notes? (≤10000), area?, ask_outcome? (boolean: show the Outcome box on complete)}` → 201 + the task. No AI cleanup. Logs `task_created` with `props.via='agent'`.
- `PATCH /api/agent/tasks/:id` partial update with the same validation as the app's PATCH (title, notes, due_date (cannot be cleared), recurrence, priority (or null), list, area). Add `"completed": true` to complete: recurring tasks advance to their next due date (steps reset, completion logged), non-recurring get `completed_at`. May be combined with other fields (edits apply first) or sent alone. `completed:false` is rejected (400); there is no uncomplete or delete via the agent API. Logs `task_edited` / `task_priority` / `task_completed` with `props.via='agent'`. Returns the task (404 if unknown id).
  - Also accepts `ask_outcome` (boolean). **Won't do (B30):** `"dropped": true` with optional `reason` (`not_worth_it|someone_else|overtaken|changed_mind|duplicate` or the label), `text` (≤200) and, for recurring tasks, required `series: "skip"|"stop"`; sets `dropped_at` (or skips one occurrence) and appends the dated notes line. `"dropped": false` restores. Not combinable with `completed`. Logs `task_dropped` / `task_skipped` / `task_restored`.
- The snapshot has a `## Won't do (last 24h)` section (drops and skipped occurrences, with reason).

### Brief
- `POST /api/agent/brief` body `{"date":"YYYY-MM-DD","last_run":"...","body_md":"markdown ≤20000","suggestions":[{"title","due_date","priority","list","recurrence","source","source_detail","area"}]}` (same shape as `scripts/post-brief.py`; `last_run` is accepted and ignored). Replaces the brief for that date and that date's still-pending suggestions. Each suggestion is validated (title ≤200, source_detail ≤300, enums above); invalid ones are skipped. Dedupe: a suggestion is dropped if its title matches an open task, or a suggestion decided (accepted/dismissed) in the last 14 days. "Matches" = case-insensitive equal, or one title starts with the other's first 18 characters. Response `{"ok":true,"date","briefs":1,"suggestions_inserted":N,"suggestions_deduped":N,"suggestions_skipped_invalid":[{"index","title","error"}]}`. Suggestions are proposals; the owner accepts them in the app.

### Example
```
KEY=$(cat agent-key)   # or the env var in the routine
curl -s -H "Authorization: Bearer $KEY" https://my-os.example.com/api/agent/health
curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"source":"whatsapp","items":[{"ext_id":"chat-123","ts":"2026-10-05T17:00:00Z","who":"Sam","snippet":"Can you pick up...","unread":true,"needs_reply":true}]}' \
  https://my-os.example.com/api/agent/ingest
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"completed":true}' https://my-os.example.com/api/agent/tasks/t-1a2b3c4d
```

## UI (`public/index.html`, `app.js`, `style.css`)
- Clone of To Do's **Planned** look, dark theme: teal accent `#5fd3c6`-ish, row cards `#2b2b2b` on `#1f1f1f`, round check circle on the left, star on the right.
- Header "Planned" + filter chips: **All Planned · Overdue · Today · Tomorrow · This Week · Later** (This Week = after tomorrow through Sunday of this week; Later = after that).
- Under All Planned, group by date header: "Thu, Sep 24", "Today", "Tomorrow", "Tue, Oct 6"… Overdue dates shown in red in the row meta.
- Row: title (with a small P0/P1 pill if priority), meta line: `List • x of n (if steps) • due date • ↻ (if recurring)`.
- Tasks with steps have a chevron; tapping the row expands steps inline, each with its own check circle (strike-through when done). Expanded by default when due Today.
- Checking: circle fills with a check, row fades out (~300ms), then the list re-renders; Undo toast at bottom.
- Responsive: comfortable on a 375px phone and on desktop (max-width ~760px centered). Large tap targets (≥44px).
- **Installable PWA**: `manifest.webmanifest` (name "my-os", short_name "my-os", display "standalone", theme/background `#1f1f1f`, start_url "/"), PNG icons 192 and 512 (generate with a small dependency-free Node script `scripts/make-icons.mjs` — teal circle with a check on dark bg is fine), and a minimal `sw.js` (cache app shell; network-only for `/api/*`).

## Auth (MVP, until Cloudflare Access is enabled)
- Worker secret `APP_PASSPHRASE`. Unauthenticated requests to any path except `/login`, `/manifest.webmanifest`, icons → serve a minimal login page (passphrase field). POST `/login` compares in constant time; on success set cookie `myos_session` = HMAC-SHA256(passphrase, "myos-v1") hex, `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`. Validate by recomputing. API returns 401 JSON when unauthenticated.
- Local dev: `.dev.vars` with `APP_PASSPHRASE=dev` (gitignored).

## Not in MVP
Reminders, attachments, journal, MCP, grooming, notifications.
