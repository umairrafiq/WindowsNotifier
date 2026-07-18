# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron app for Windows that shows always-on-top desktop notifications. The
notification's **web design is described by the incoming JSON payload** (colors,
size, position, icon, duration, or even raw HTML) — the app itself is a generic
renderer. There is a **single input channel**: an [ntfy](https://ntfy.sh) topic
subscription (`ntfy.js`). Each published message funnels into
`handleIncoming()`. (Earlier versions also had a local HTTP webhook and a
Firebase/Firestore listener; both were removed in favor of ntfy-only.)

## Commands

```bash
npm install          # install deps
npm start            # run the app (electron .)
npm run dev          # run with --dev flag
npm run build        # build assisted NSIS installer + portable .exe into dist/
```

**Building the installer on Windows without admin/Developer Mode** fails while
extracting electron-builder's `winCodeSign` package (it contains macOS `.dylib`
*symlinks* 7-Zip can't create). Workaround: pre-extract it into the cache,
tolerating the two symlink errors, then rebuild:
`7za x winCodeSign-2.6.0.7z -o"<cache>/winCodeSign/winCodeSign-2.6.0"` where
`<cache>` is `%LOCALAPPDATA%/electron-builder/Cache`. The build is unsigned
(`CSC_IDENTITY_AUTO_DISCOVERY=false`).

In VS Code, press **F5** ("Run Notifier (Electron)") to launch, or use the
`install` / `start` / `build (compile .exe)` tasks. There is no test suite,
linter, or build step for the source — the code runs directly under Electron.

To exercise a running instance (needs `ntfy.config.json` with a topic):
- `node send-ntfy.js "Title" "Body"` — publishes a sample notification to the topic.
- `curl -d '{"title":"Hi"}' https://ntfy.sh/<your-topic>` — raw publish.

## Architecture

Electron main/preload/renderer split, all under `src/`. There are **two**
`BrowserWindow`s: the **overlay** (transparent, click-through, always-on-top,
covering the primary work area — where notifications render) and the
**dashboard** (a normal window showing history + mute/snooze controls). A tray
icon ties them together.

Every incoming payload (from ntfy) flows through `handleIncoming()` in
`main.js`, which calls `store.ingest()` first (recording history, computing the
group counter, and the mute/snooze verdict) and only then forwards to the
overlay. So `store.js` is the source of truth; the overlay renderer is a dumb
view.

- **`src/main.js`** — main process. Owns both windows, the tray, the ntfy
  listener wiring, and all IPC. `handleIncoming()` ingests → pushes fresh state
  to the dashboard → forwards to the overlay unless the app is snoozed. Forwarded
  payloads carry extra `_groupKey` / `_count` / `_appId` / `_silent` fields.
  Accepts a single payload or an array (fanned out).

- **`src/store.js`** — persistent state + all the notification *policy*. Holds
  history, mutes, and snoozes in `notifier-data.json` (userData dir), plus an
  **in-memory** `activeGroups` map (group key → history record) driving the
  repeat counter. `ingest()` returns `{ groupKey, count, suppressed, silent }`.
  Active group counts are in-memory only, so they reset on restart.

- **`src/preload.js`** / **`src/renderer.js`** — the overlay. Preload exposes
  `window.notifier` (`onNotification`, `setInteractive`, `dismissGroup`,
  `snooze`, `muteApp`). Renderer keeps a `cards` Map keyed by `_groupKey`: a
  repeat updates the existing card (bumps its `.badge`, re-arms auto-dismiss,
  `pulse()`s, keeps one alarm ringing) instead of stacking a new one. Handles
  styling, the `html` path, progress bar, and the hover-revealed action buttons.

- **`src/dashboard.html` / `dashboard.js` / `dashboard-preload.js`** — the
  history window. Preload exposes `window.dash`; it pulls state via the
  `get-state` invoke and re-renders on pushed `state` events. Self-contained CSS
  in a `<style>` block (its CSP allows `'unsafe-inline'` styles, `'self'`
  scripts).

- **`src/ntfy.js`** — the [ntfy.sh](https://ntfy.sh) listener (the only input
  channel) **and config store**. `startNtfy(onMessage)` streams a topic's NDJSON
  feed over built-in `http`/`https` (no dependency); it's **restartable** (stops
  any prior listener first) so the topic can change at runtime. `loadConfig()` /
  `saveConfig()` / `isConfigured()` manage `ntfy.config.json` — **written to
  userData** so the packaged (read-only) app can be configured post-install.
  `onMessage` is `handleIncoming`. See **ntfy behavior** below.

- **`src/index.html`** — the overlay page: six fixed `.zone` divs (one per
  corner/center position) hold the cards. **`src/assets/tray.png`** — the tray
  icon (generated, committed).

### Click-through mechanism (important, easy to break)

The overlay must let clicks pass through to apps beneath it, *except* when the
cursor is over an actual notification card. This is a coordinated dance:
1. `main.js` starts the window with `setIgnoreMouseEvents(true, { forward: true })`.
2. On card `mouseenter`/`mouseleave`, `renderer.js` calls
   `window.notifier.setInteractive(...)` with a hover **count** (multiple cards).
3. `main.js` responds to the `set-interactive` IPC by toggling
   `setIgnoreMouseEvents`. When changing hover/interactive logic, keep this loop
   intact or the overlay will either eat all clicks or make its own buttons dead.

### Grouping, mute & snooze (all decided in `store.js`)

- **Grouping key** is `appId` + `group` (group defaults to `title`). While a
  group is "active" (undismissed) in `activeGroups`, repeats increment its
  `count` instead of creating a new card/record. `dismissGroup()` (fired by the
  renderer's close/auto-dismiss via the `dismiss-group` IPC) removes it, so the
  next arrival starts a fresh record at count 1. **This is why the overlay must
  tell main when a card closes** — otherwise the counter never resets.
- **Mute** (`mutes.system` or `mutes.apps[appId]`) → `silent: true`: the card
  still shows, but the renderer skips `playSound`. Persistent.
- **Snooze** (`snoozes[appId] > now`, set to `now + 1h`) → `suppressed: true`:
  `handleIncoming` records it to history but does **not** forward to the overlay.
  Auto-expires; pruned lazily on read.
- Everything is logged to history regardless of mute/snooze.

Closing the dashboard window only hides it (to the tray); real exit is the
tray's **Quit**, which sets `quitting = true` so the `close` handler stops
intercepting. `main.js` also sets `quitting` on `before-quit`.

### Setup, autostart & the installer

- **First run** = `!ntfy.isConfigured()`. On first run the dashboard is shown
  (so the user can set a topic); once configured, launch is **silent to the
  tray**. The dashboard's Setup panel calls `get-config` / `save-config` /
  `generate-topic` IPC; `save-config` writes userData config and **restarts the
  listener live** (no relaunch). `config` events push updates back.
- **Autostart** uses Electron's `app.setLoginItemSettings({ openAtLogin })` —
  no registry code of our own. Enabled by default on the first run of the
  **packaged** app only (`app.isPackaged`, so dev never touches your startup),
  and toggleable from the tray and the Setup panel. `getLoginItemSettings()` is
  the source of truth (no separate persisted flag).
- **Installer**: assisted NSIS (`build.nsis`, `oneClick:false`), desktop +
  start-menu shortcuts, `runAfterFinish`. Icon `build/icon.ico` (generated).
  `build/` is `directories.buildResources`.

### ntfy behavior & the offline backlog

`ntfy.js` subscribes to `<server>/<topic>/json?since=<cursor>` and reconnects on
drop (5s). The `since` param replays messages cached while the PC was offline
(bounded by server retention — ~12h on public ntfy.sh).

**The cursor is the last message _id_, not its timestamp** — this matters:
ntfy's `since=<seconds>` is *inclusive* and re-delivers the boundary message on
every restart, whereas `since=<id>` is *exclusive*. `readLastSeen()` stores
`{ id, sec }` in `ntfy-last-seen.json` (userData); `connect()` prefers
`since=id`, falls back to `since=sec`, then `since=all` on a first-ever run. An
in-memory `seenIds` set also dedupes within a session. `toPayload()` uses the
ntfy message body as the notifier payload when it's JSON, else falls back to
ntfy's `title`/`message` (so plain-text publishes still work). Config:
`NTFY_TOPIC` / `NTFY_SERVER` / `NTFY_TOKEN` env vars → `./ntfy.config.json` →
`../ntfy.config.json`; a missing topic disables the listener. `send-ntfy.js` is
the publish helper (POSTs the payload JSON as the message body). Array bodies
are fanned out in `handleIncoming`.

## Payload contract

Fields: `appId` (source id for mute/snooze/grouping,
default `default`), `group` (grouping key, default = `title`), `title`, `body`,
`icon`, `position`
(`top-left|top-center|top-right|bottom-left|bottom-center|bottom-right`, default
`top-right`), `duration` (ms; `0` = sticky until clicked, default `6000`),
`sound` (`beep` = short beeps, `alarm` = repeating until dismissed, omit for
silent), `style` (object → `background`, `color`, `accent`, `width`,
`borderRadius`, `fontFamily`, `fontSize`, `padding`, `boxShadow`, `opacity`),
and `html` (raw markup for a fully custom card). `accent` maps to the card's
left border color.

`html` is injected via `innerHTML`. The page CSP (`index.html`) blocks scripts,
so custom markup can style but cannot execute — keep it that way.

### Sound

`sound` is played by [renderer.js](src/renderer.js) using the **Web Audio API**
— tones are synthesized in JS, so no audio files are bundled or fetched and the
CSP (which blocks external media) is untouched. `alarm` returns a `stop()`
stored on `card._stopAlarm` and cleared in `dismiss()`, so the loop ends when
the card is dismissed or auto-dismissed. Audio plays with no user gesture only
because `main.js` sets `webPreferences.autoplayPolicy: "no-user-gesture-required"`.

## Notes

- `ntfy.config.json` is gitignored; only `ntfy.config.example.json` is
  committed. Never commit a real (private) topic name or access token.
- `dist/`, `node_modules/`, and `*.log` are gitignored.
- The app deliberately stays alive with no visible windows
  (`window-all-closed` is a no-op) — it's a background overlay, not a
  foreground app.
