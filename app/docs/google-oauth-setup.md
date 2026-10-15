# Google OAuth setup for the collectors (B37)

One-time setup so the Worker can read Google Calendar (and later Gmail) on its own. Everything is **read-only**: the scopes are `calendar.readonly` now and `gmail.readonly` in P2. Until the three secrets below are set, the calendar cron does nothing and `/api/agent/health` shows `gcal_sync: not configured`.

## 1. Google Cloud project
1. Go to https://console.cloud.google.com/ and create a project (any name, e.g. `my-os-collectors`).
2. **APIs & Services → Library**: enable **Google Calendar API**. (For P2 also enable **Gmail API**.)

## 2. OAuth consent screen
1. **APIs & Services → OAuth consent screen** (or "Google Auth Platform → Branding/Audience").
2. User type **External**. Fill in the app name and your email; no logo or domain needed.
3. Scopes: you can skip this page (the script requests scopes itself).
4. **Audience → Publish app → In production.** This matters: in *Testing* mode refresh tokens expire after 7 days and the sync silently stops.
   The app stays unverified, which is fine for your own account: during consent you'll see "Google hasn't verified this app" → **Advanced → Go to … (unsafe)**.

## 3. OAuth client
1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type **Desktop app**. Name it anything.
3. Copy the **Client ID** and **Client secret**.

## 4. Get the refresh token (on your own machine)
From the `app/` folder:
```
node scripts/google-refresh-token.mjs --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET>
```
Open the printed URL, sign in with the account whose calendars you want to read, and approve. The terminal prints the refresh token. Nothing is written to disk.
For P2 run it again with `--scopes calendar,gmail` and replace the secret (one token covers both).

## 5. Store the secrets in the Worker
```
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put CALENDAR_IDS      # comma-separated, e.g. primary,abc123@group.calendar.google.com
```
`CALENDAR_IDS` defaults to `primary`. Keep it out of `wrangler.toml` (the IDs are personal). Find a calendar's ID in Google Calendar → Settings → the calendar → *Integrate calendar → Calendar ID*. Optional: `FREEBUSY_IDS` (comma-separated) for calendars shared with you as free/busy only: only busy blocks are stored, titled "busy". Optional: `CALENDAR_TZ` (default `America/Los_Angeles`) places all-day events.

## Mail (P2)
The refresh token must include `gmail.readonly` (run the script with `--scopes calendar,gmail`). Optional settings: `MAIL_BACKFILL_DAYS` (default 14), `MAIL_MAX_FETCH` (default 40), `MAIL_LANES` and `MAIL_RULES` (JSON; see SPEC.md). Keep lane patterns in a secret if they name real senders.

## 6. Check it
Within 10 minutes:
```
curl -s -H "Authorization: Bearer $AGENT_KEY" https://<host>/api/agent/health
```
`gcal_sync` should have a recent `last_ok` and each calendar a `cursors` entry with `has_cursor: true`. The first sync is a baseline (no change rows); after that, `GET /api/agent/calendar/changes?since=…` lists what moved.

## Revoking
https://myaccount.google.com/permissions → remove the app. The next run records `refresh token revoked or expired` in health. Delete the Worker secrets to switch the collector off entirely.
