# my-os Android shell

A Capacitor app that loads **https://v1.my-os.example.com** (remote-URL mode). A web deploy updates the app with no reinstall. You only need a new APK when something in `android/` changes.

## Install on your phone

1. On the phone, open **https://github.com/<owner>/<repo>/releases/latest/download/my-os.apk** in Chrome. Sign in to GitHub if it asks (if the repo is private). The download starts.
2. Open the downloaded `my-os.apk` from the notification or the Files app. If Android asks, tap **Settings → Allow from this source** for Chrome, then go back.
3. Tap **Install**. If Play Protect warns about an unknown app, tap **More details → Install anyway**. This is expected for an app that isn't on the Play Store.
4. Open **my-os** and sign in with your passphrase once. The login cookie is kept.
5. To update later, repeat steps 1–3. It installs over the old version and you stay signed in. If Android says the app "conflicts with an existing package", the signing key changed: uninstall my-os, install again, and sign in again. No data is lost because everything lives on the server.

## What the shell adds to the web app

| Piece | How |
|---|---|
| Back gesture / button (predictive back on) | Asks the page first through `myosShell.back()`, which closes Quick Find, popovers or the open to-do, then steps back through `#route` history. It only leaves the app at Today or Lists. The web app can take over by setting `myosShell.onBack` or `window.myosBack` (`() => true/false`); the v1 app registers `window.myosBack`. |
| Haptics | `@capacitor/haptics`. The page gets `window.myosShell.haptic('light' \| 'medium' \| 'heavy' \| 'success' \| 'warning' \| 'error')`, plus a `myosshell` event when the bridge is ready. Existing `navigator.vibrate(ms)` calls become real haptics: under 30 ms is a light tick, longer or a pattern is "success". |
| Keyboard | Edge to edge. The WebView is inset by the system bars and the keyboard, so the page resizes when the keyboard opens. |
| Status and navigation bars | Take the page's background color (light, dark or the in-app theme), with matching icon contrast. |
| Splash | The system splash with the my-os mark on the page color. It stays up until the page loads (2.5 s at most). |
| Offline | When the site can't be reached, a local page reads "Can't reach my-os". It retries on its own when you're back online, or on a tap. |
| Today widget | Long-press the home screen → Widgets → my-os → "Today". It shows today's to-dos (flag, evening and deadline text) and the next event. It refreshes every 30 minutes and whenever you leave the app. Tap a row to open my-os. Tap its box to check it off: the row turns checked at once with a haptic tick, and the server is told 2.5 s later, so a second tap undoes it. |
| Add-task widget | Long-press the home screen → Widgets → my-os → "Add task". Tap it and a small box opens with the keyboard already up. Type, then Add (or Enter), and the to-do goes to Inbox. It works with the app closed. Offline, entries wait on the phone (the widget shows "N waiting") and send when the network is back. |
| Timer notification | While a timer runs (started in the app), an ongoing notification shows the to-do and a counting chronometer. **Stop** stops it on the server with the device token, even with the app closed. |
| Reminders | To-dos with a reminder become local notifications, re-synced whenever the app loads or a to-do changes. They need the notification permission, which the app asks for the first time it is needed. |
| Shake to report | Shake the phone in the app: the feedback sheet opens as before, and the shell attaches a screenshot of the screen behind it (JPEG under 600 KB). |
| Device token | After you sign in, the shell calls `POST /api/v1/devices` (cookie) once. It stores the token in Android Keystore-encrypted storage and never hands it back to JS. Native pieces (widget, timer Stop) use it. The agent key is never on the phone. |

Everything in phase 5b reads the app's own API traffic: the injected script wraps `fetch` and watches `/api/v1/state`, `/api/v1/timer` and task writes. No web change is needed. `android/test/shell.test.mjs` tests that script in headless Chromium against a mock app page.

## Layout

- `package.json`, `capacitor.config.json`, `www/` (only the offline page is used).
- `overlay/app/...` holds our native files: `MainActivity`, the `MyOSShell` plugin, `TokenStore`, the injected `myos-shell.js`, the manifest, theme, icon and splash.
- `scripts/prepare-native.mjs` copies the overlay over the project that `npx cap add android` generates and sets the version.
- The generated `android/android/` is not committed. CI makes it fresh each build (this dev environment can't reach Google's Maven).

## App icon

`node android/scripts/icons.mjs <dir>` turns the three adaptive-icon layers (`foreground.svg`, `background.svg` and optional `monochrome.svg`, each on a 108×108 canvas with the mark inside the central 72) into the launcher PNGs for every density. It also writes the legacy square and round icons, the splash icon and the adaptive XML in `overlay/`. Run it locally (it uses Playwright's Chromium) and commit the output.

## CI

`.github/workflows/android.yml` runs on pull requests that touch `android/**`, on pushes to `main` that touch it, and on manual dispatch. It runs `cap add` → `cap sync` → overlay → `gradlew assembleRelease` → zipalign + apksigner. It uploads the APK as a workflow artifact. Builds from `main` also publish a GitHub release, so the link in step 1 always points at the newest one.

**Signing.** With no secrets set, the first build generates a keystore and keeps it in the GitHub Actions cache (not in git, never printed). A weekly scheduled run keeps that cache from expiring. If the cache is ever lost, the next APK has a new key and you'd reinstall once (step 5). For a permanent key, add these repository secrets (Settings → Secrets and variables → Actions):

1. On any computer with Java: `keytool -genkeypair -keystore myos.jks -storetype PKCS12 -alias myos -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=my-os"` (pick a password when asked).
2. `base64 -w0 myos.jks` (macOS: `base64 -i myos.jks`). Copy the output.
3. Add secret `ANDROID_KEYSTORE_BASE64` = that output, `ANDROID_KEYSTORE_PASSWORD` = the password, and `ANDROID_KEY_ALIAS` = `myos`.
4. Keep `myos.jks` and the password somewhere safe (a password manager), never in the repo.
5. Re-run the workflow. Switching keys means one uninstall and reinstall (step 5 above).
