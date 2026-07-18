# WinNotif — Alert Sending Skill (for AI Agents)

How to make a desktop notification appear on this Windows machine via
**WindowsNotifier**. The app renders an always-on-top card whose entire design
is described by the JSON you send. This document is the complete contract.

Alerts are delivered over **[ntfy](https://ntfy.sh)** — the only channel. The
app subscribes to a topic; you publish to that topic. It works from anywhere
(not just this machine), and messages published while the PC is offline are
delivered on its next start.

## TL;DR — the one command you need

Publish your JSON payload as the message body to the topic:

```bash
curl -d '{"title":"Hello","body":"It works!"}' https://ntfy.sh/<your-topic>
```

Replace `<your-topic>` with the real topic (see **Configuration** below). A
plain-text message also works (`curl -d "hello" https://ntfy.sh/<your-topic>`) —
it becomes a simple title/body notification.

## Configuration

- The topic (and, if used, a self-hosted server URL and access token) are set in
  the app's **Setup** screen (tray → *Open History / Settings*). They are stored
  in `ntfy.config.json` — in the app's userData dir for an installed copy
  (`%APPDATA%/windows-notifier/ntfy.config.json`), or the project root when run
  from source. That file is gitignored, so the topic is not reproduced here —
  read it to get the current topic, or ask the user.
- Default server is `https://ntfy.sh`. If a different `server` is configured,
  publish to `<server>/<topic>` instead.
- If the topic is access-controlled (`token` set), add `-H "Authorization: Bearer <token>"`.

> **Security:** a public ntfy topic is readable and writable by anyone who knows
> its name. Treat the topic name as a secret.

## Payload fields (all optional)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `title` | string | — | Bold heading. |
| `body` | string | — | Message text. |
| `icon` | string | — | Leading emoji/character. |
| `appId` | string | `"default"` | Source app id. Drives muting/snoozing **and grouping**. Set this per logical source (e.g. `"ci"`, `"backup"`). |
| `group` | string | = `title` | What counts as "the same alert". Repeats of the same `appId`+`group` collapse into ONE card with a rising counter. |
| `position` | string | `"top-right"` | `top-left` `top-center` `top-right` `bottom-left` `bottom-center` `bottom-right`. |
| `duration` | number | `6000` | Auto-dismiss after N ms. **`0` = stays until the user dismisses it.** |
| `sound` | string | — (silent) | `"beep"` = a few short beeps. `"alarm"` = repeating alarm until dismissed. |
| `style` | object | — | Visual design (see below). |
| `html` | string | — | Raw HTML body for a fully custom card. Scripts are blocked (CSP); styling only. |

### `style` object

Keys: `background`, `color`, `accent` (the card's left border color), `width`,
`borderRadius`, `fontFamily`, `fontSize`, `padding`, `boxShadow`, `opacity`.
All are CSS strings.

```json
{ "background": "#0f172a", "accent": "#38bdf8", "color": "#e2e8f0", "borderRadius": "14px" }
```

## Behavior an agent must understand

- **Grouping / counting.** Send the same `appId`+`group` repeatedly and the user
  sees one card whose number climbs (`2`, `3`, …), not a stack. The count resets
  after the user dismisses it. Use a **stable `group`** for repeated status
  updates; use a **unique `title`/`group`** when each alert is distinct.
- **Indefinite audible alert** = `"sound":"alarm"` + `"duration":0`. It rings on
  a loop and stays until dismissed. One alarm rings per group no matter how many
  repeats arrive.
- **Silent by default.** Omit `sound` unless the alert warrants noise.
- **Mute / snooze are user-controlled.** If the user muted an app, its cards show
  silently; if snoozed, they are logged to history but not shown. You cannot
  override this. Don't spam to bypass it.
- **Arrays** show several at once: publish `[ {...}, {...} ]` as the body.
- **`html` cannot run scripts** — inline styles/markup only.
- **Offline delivery** is bounded by the ntfy server's cache retention (~12h on
  public `ntfy.sh`). A PC offline longer than that may miss messages.

## Recipes (copy-paste)

Examples use `curl` with single-quoted JSON (bash/Git Bash/macOS/Linux) and the
placeholder `https://ntfy.sh/<your-topic>`. On **PowerShell**, use `curl.exe`
and escape inner quotes with `\"`, e.g.
`curl.exe -d "{\"title\":\"Hi\"}" https://ntfy.sh/<your-topic>`.

### 1. Basic info toast (auto-dismiss)

```bash
curl -d '{"appId":"agent","title":"Task done","body":"Report generated.","icon":"✅"}' \
  https://ntfy.sh/<your-topic>
```

### 2. Success / styled toast, bottom-right, 8s

```bash
curl -d '{"appId":"deploy","title":"Deploy complete","body":"v2.3.1 is live.","icon":"🚀","position":"bottom-right","duration":8000,"style":{"background":"#0f172a","accent":"#38bdf8","color":"#e2e8f0"}}' \
  https://ntfy.sh/<your-topic>
```

### 3. Short audible ping

```bash
curl -d '{"appId":"agent","title":"Input needed","body":"Waiting on your review.","icon":"🔔","sound":"beep"}' \
  https://ntfy.sh/<your-topic>
```

### 4. Indefinite audible alarm (rings until dismissed)

```bash
curl -d '{"appId":"siren","title":"ALERT","body":"Click to silence.","icon":"🚨","sound":"alarm","duration":0,"position":"top-center","style":{"background":"#2a0a0a","accent":"#ef4444","color":"#fff5f5"}}' \
  https://ntfy.sh/<your-topic>
```

### 5. Sticky warning (stays, no sound)

```bash
curl -d '{"appId":"disk","title":"Low disk space","body":"Drive C: 4.2 GB left.","icon":"⚠️","duration":0,"style":{"accent":"#f59e0b"}}' \
  https://ntfy.sh/<your-topic>
```

### 6. Repeated status updates that count up (stable group)

```bash
# Send these over time; the user sees ONE card counting 1 → 2 → 3.
curl -d '{"appId":"backup","group":"backup-retry","title":"Backup failing","body":"Retrying…","icon":"💾","duration":0,"sound":"beep"}' \
  https://ntfy.sh/<your-topic>
```

### 7. Fully custom HTML card

```bash
curl -d '{"appId":"agent","html":"<div style=\"font:600 16px Segoe UI;color:#fff\">Custom <span style=\"color:#f43f5e\">design</span></div>","duration":0}' \
  https://ntfy.sh/<your-topic>
```

### 8. Several at once (array)

```bash
curl -d '[{"title":"First"},{"title":"Second","position":"top-left"}]' \
  https://ntfy.sh/<your-topic>
```

### 9. Access-controlled topic (with token)

```bash
curl -H "Authorization: Bearer tk_xxxxxxxx" \
  -d '{"title":"Secured","body":"Sent with a token."}' \
  https://ntfy.sh/<your-topic>
```

## Field-choice guidance for agents

- **Set `appId`** to a short, stable id for the logical source. It lets the user
  mute/snooze your alerts and enables grouping.
- **Reuse `group`** (or `title`) for recurring updates about the *same* thing so
  they count up instead of stacking; vary it for genuinely new events.
- **Escalate sound deliberately:** none → `beep` (attention) → `alarm`+`duration:0`
  (must-acknowledge). Reserve `alarm` for things that truly need a human now.
- **Prefer auto-dismiss** (`duration` > 0) for informational alerts; use
  `duration:0` only when acknowledgement matters.

## There is no confirmation response

ntfy returns `200` when it accepts the publish, but that only means the message
reached the server — not that the app was running or the user saw it. There is
no local health check. If delivery matters, confirm with the user out of band.
