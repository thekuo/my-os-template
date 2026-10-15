# my-os

A Things-style personal task app: a Cloudflare Worker with D1 storage, a vanilla-JS PWA front end, and a Capacitor Android shell with home-screen widgets. It can optionally sync Google Calendar and Gmail (read-only) and exposes an agent API so an AI assistant can read and write your tasks.

> Shared as a reference, as-is. It was built for one household's personal use, then sanitized into this generic template. There is no support and no stability guarantee. It is MIT licensed (see LICENSE). Expect to adapt it.

## Architecture

```
app/        Cloudflare Worker + D1 + static PWA
  src/        Worker modules (index.js router/cron, v1.js + v1app.js for the v1 model, gcal.js, gmail.js, views.js, signals.js, media.js, attachments.js)
  public/     Static assets: the original UI (app.js, index.html) and the v1 Things-style UI (public/v1/)
  migrations/ Ordered D1 migrations (0001 ... 0018)
  schema.sql  Full schema for a fresh database; seed.sql is a tiny example seed
  scripts/    Node test scripts (test-*.mjs), local dev server (dev-v1.mjs), icon generators, Google refresh-token helper
  docs/       Design notes for the calendar and mail collectors and Google OAuth setup
  SPEC.md     Detailed behavior and API reference
android/    Capacitor shell that loads the v1 web app, plus native overlay (widgets, timer notification, quick-add, back handling)
.github/workflows/android.yml   Builds and signs the APK
```

**API surfaces.** (1) App API, `/api/*` and `/api/v1/*`, behind a passphrase login cookie, used by the two web UIs and the Android shell. (2) Agent API, `/api/agent/*`, behind `Authorization: Bearer <AGENT_KEY>`: tasks, briefs and suggestions, collected items, calendar and mail views, weekly theme, snapshot markdown. An optional scoped `INGEST_KEY` may only post collected items and source health. (3) `/snapshot.md?key=...`, a read-only markdown view guarded by `SNAPSHOT_KEY`. The Worker serves the v1 UI on any host starting with `v1.` (or hosts listed in `V1_HOSTS`) and the original UI elsewhere. See `app/SPEC.md` for the details.

**Crons** (in `app/wrangler.toml`). `17 11 * * *` is the daily job (full calendar resync, retention purges). `*/10 * * * *` syncs Google Calendar. `5-55/10 * * * *` syncs Gmail. Both syncs are no-ops until the Google secrets are set.

**Data model.** Every table carries a `tenant_id` (default `'owner'`; the app is single-tenant today). `tasks` holds to-dos with priority P0-P3, due date, recurrence (daily, weekdays, weekly, monthly, yearly), steps (rows with `parent_task_id`), notes, area and project links. The v1 model adds `areas`, `projects`, `headings`, tags, checklists, reminders, a timer and attachments. `completions` is an append-only check-off log (it powers undo), `events` is a telemetry log, and `briefs`, `suggestions` and `weekly_theme` carry what an AI assistant writes. `calendar_events`, `calendar_changes`, `mail_messages`, `sync_cursors`, `items` and `source_health` back the optional collectors. "Today" is computed in `America/Los_Angeles`; change it if you live elsewhere (search for that string).

**Android.** `android/` is a Capacitor remote-URL shell (`capacitor.config.json` points at your v1 host). The generated native project is not committed: CI runs `cap add android`, copies `android/overlay/` over it (`scripts/prepare-native.mjs`), builds a release APK and signs it. Set the app id and host to your own (see below).

## Deploy your own

Prerequisites: Node 22+, a Cloudflare account, `wrangler` (installed through `app/package.json`).

1. **Install and configure.**
   ```
   cd app && npm install
   ```
   Edit `wrangler.toml`: set `account_id`, replace `my-os.example.com` and `v1.my-os.example.com` with your domains (or remove `routes` to use a workers.dev URL), and keep the cron, `[ai]`, R2 and D1 bindings.
2. **Create the database and apply the schema.**
   ```
   npx wrangler d1 create my-os        # copy the database_id into wrangler.toml
   npx wrangler d1 execute my-os --remote --file=schema.sql
   # or apply migrations/*.sql in order, as an alternative to schema.sql
   npx wrangler d1 execute my-os --remote --file=seed.sql   # optional example tasks
   ```
   `deploy.sh` automates the create step when `wrangler.toml` still holds the `<YOUR_D1_DATABASE_ID>` placeholder.
3. **Create the R2 bucket** used for chat media: `npx wrangler r2 bucket create my-os-media` (or drop the `[[r2_buckets]]` block and the media code path).
4. **Set secrets.**
   ```
   npx wrangler secret put APP_PASSPHRASE      # login passphrase
   npx wrangler secret put AGENT_KEY           # bearer key for /api/agent/*
   npx wrangler secret put SNAPSHOT_KEY        # optional, /snapshot.md?key=
   npx wrangler secret put INGEST_KEY          # optional, scoped collector key
   npx wrangler secret put OWNER_NAME          # your name, used in the AI quick-add prompt
   npx wrangler secret put HOUSEHOLD_CONTEXT   # one or two sentences about your household (names, roles) for the AI prompt
   ```
   Optional Google sync: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `CALENDAR_IDS`, plus the mail settings listed in `app/SPEC.md`. Follow `app/docs/google-oauth-setup.md`; `scripts/google-refresh-token.mjs` mints the refresh token. Other optional variables: `QUICKADD_AI`, `V1_HOSTS`, `OWN_ADDRESSES`, `WAKE_VIP`, `MAIL_LANES`, `MAIL_RULES`, `CALENDAR_TZ`. If `OWNER_NAME` or `HOUSEHOLD_CONTEXT` are unset, the prompt shows the literal placeholders `<OWNER_NAME>` and `<HOUSEHOLD_CONTEXT>`.
5. **Deploy.** `npx wrangler deploy`
6. **Local development and tests.** `node scripts/dev-v1.mjs` runs the v1 UI against an in-memory SQLite. Run all tests with `for f in scripts/test-*.mjs; do node $f || echo FAIL $f; done` (Node 22+ for `node:sqlite`; `test-v1-ui` needs Playwright with Chromium installed globally).
7. **Android build.**
   - Edit `android/capacitor.config.json` and the `APP_HOST` constant in `MainActivity.java`, `android/www/*.html` and `android/overlay/.../myos-shell.js` to your v1 host. The sample app id is `com.example.myos`; if you change it, rename the `java/com/example/myos` directory and the `package` lines to match.
   - Push to GitHub. `.github/workflows/android.yml` builds on changes under `android/**`, on manual dispatch and weekly. Signing uses the repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS` when present; otherwise it generates a key once and caches it. Builds from `main` publish a GitHub release with `my-os.apk`. See `android/README.md` for details.

## Notes

- The chat collector that posts to `/api/agent/ingest` (source id `beeper`) is not included; any client that posts items in the documented shape works.
- Nothing here is a hosted service: you run your own Worker, database and keys.
