# WindowsNotifier

An always-on-top desktop notifier for Windows. It subscribes to an
[ntfy](https://ntfy.sh) topic and renders each published message as a
notification on top of everything (including fullscreen apps). The
notification's **web design is described by the JSON payload** — colors, size,
position, icon, or even raw HTML.

Built with Electron, so it runs and compiles directly from Visual Studio Code.
ntfy delivery uses only Node's built-in HTTP, so the app has **no runtime
dependencies**.

## Install (recommended)

1. Run `npm install`, then `npm run build`. This produces an installer in
   `dist/` — **`WindowsNotifier Setup <version>.exe`** — plus a portable `.exe`.
2. Run the setup `.exe`. It installs the app, adds Start-menu/desktop shortcuts,
   turns on **Start with Windows**, and launches the app.
3. On first launch the **Setup** screen opens. Enter a **topic** (or click
   **Generate** for a random one), optionally set a self-hosted `Server` /
   access `Token` under *Advanced*, then **Save & Connect**. That's it — the app
   drops to the tray and starts listening.

Change the topic or the *Start with Windows* setting any time from the tray icon
→ *Open History / Settings*.

Because it listens to a cloud topic, notifications work from **anywhere** — not
just this machine — and messages published while the PC was offline are
delivered on its next start (bounded by the server's cache retention: ~12h on
the public `ntfy.sh`, configurable if you self-host).

## Run from source (dev)

1. Open this folder in VS Code.
2. Optionally copy `ntfy.config.example.json` to `ntfy.config.json` and set a
   `topic` (or configure it via the first-run Setup screen; you can also use the
   `NTFY_TOPIC` / `NTFY_SERVER` / `NTFY_TOKEN` environment variables).
3. `npm install`, then press **F5** ("Run Notifier (Electron)") or `npm start`.

> Config precedence: `NTFY_*` env vars → the app's userData `ntfy.config.json`
> (what the installed app and Setup screen use) → `./ntfy.config.json` in the
> project. A **long, unguessable topic** matters — public ntfy topics are open
> to anyone who knows the name.

## Sending a notification

Publish the JSON payload as the message body to your topic:

```bash
node send-ntfy.js "Deploy done" "v2.3.1 is live"
# or with plain curl (JSON body = the notification payload):
curl -d '{"title":"Deploy done","body":"v2.3.1 is live","icon":"🚀"}' https://ntfy.sh/your-topic
```

A plain-text message (`curl -d "hello" …`) also works — it becomes a simple
title/body notification. For an access-controlled topic, add
`-H "Authorization: Bearer <token>"`.

> **Security:** a public ntfy topic is readable and writable by anyone who knows
> its name. Use a random topic name plus an access token, or self-host, for
> anything sensitive.

> **For AI agents:** see [winnotif_skill.md](winnotif_skill.md) for the full
> send contract and copy-paste recipes.

## JSON format

| Field      | Type   | Description                                                        |
| ---------- | ------ | ----------------------------------------------------------------- |
| `appId`    | string | Source application id. Used for muting/snoozing and grouping. Default `default`. |
| `group`    | string | What counts as "the same alert". Repeats of the same `appId`+`group` collapse into one card with a rising counter. Default = `title`. |
| `title`    | string | Bold heading text.                                                 |
| `body`     | string | Message text.                                                      |
| `icon`     | string | Leading icon (emoji or character).                                 |
| `position` | string | `top-left` `top-center` `top-right` `bottom-left` `bottom-center` `bottom-right`. Default `top-right`. |
| `duration` | number | Auto-dismiss after N ms. `0` = stays until clicked. Default `6000`. |
| `sound`    | string | `beep` = a few short beeps. `alarm` = repeating alarm that rings until the card is dismissed. Omit for silent. |
| `style`    | object | Visual design (see below).                                         |
| `html`     | string | Optional raw HTML body for full custom web design (scripts blocked by CSP). |

### `style` object

```json
{
  "background": "#11131a",
  "color": "#ffffff",
  "accent": "#22c55e",
  "width": "380px",
  "borderRadius": "14px",
  "fontFamily": "Segoe UI",
  "fontSize": "14px"
}
```

### Examples

A styled success toast:

```json
{
  "title": "Deploy complete",
  "body": "v2.3.1 is live in production.",
  "icon": "🚀",
  "position": "bottom-right",
  "duration": 8000,
  "style": { "background": "#0f172a", "accent": "#38bdf8", "color": "#e2e8f0" }
}
```

Fully custom web design via HTML:

```json
{
  "html": "<div style='font:600 16px Segoe UI;color:#fff'>Custom <span style='color:#f43f5e'>design</span> here</div>",
  "duration": 0
}
```

Send an **array** to show several at once:

```json
[{ "title": "First" }, { "title": "Second", "position": "top-left" }]
```

## Grouping, counting, mute, snooze & history

**Grouping.** Repeated alerts with the same `appId` + `group` (group defaults to
`title`) collapse into a **single card with a counter** that climbs each time
(`2`, `3`, …). Dismissing the card resets the count, so the next arrival starts
again at 1. An `alarm` sound rings once for the group and keeps going until
dismissed, no matter how many repeats land.

**Card actions** (hover a card): **⏱ Snooze** the app for 1 hour, **🔇 Mute**
the app, or **× dismiss**.

**Mute vs. snooze.**

- **Mute** (per app, or system-wide) is a persistent toggle that **silences
  sound** — cards still appear.
- **Snooze** (per app, 1 hour) **hides the popup entirely** for that hour;
  the alert is still recorded in history and delivery resumes automatically.

**History app & tray.** A history window opens on launch and from the **tray
icon** (click it, or right-click → *Open History*). It lists every alert (with
repeat counts and times) and provides per-app mute/snooze plus a system-wide
*Mute all*. Closing the window hides it to the tray; the tray menu's **Quit**
actually exits. History and settings persist in `notifier-data.json` in the
app's userData dir.
