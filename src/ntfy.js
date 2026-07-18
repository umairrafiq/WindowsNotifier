// ntfy (https://ntfy.sh) listener — the app's only input channel. Subscribes to
// a topic over a streaming HTTP GET (NDJSON) and replays anything cached while
// the PC was offline via `?since=<cursor>`. Uses only Node's built-in
// http/https, so it adds no dependency. The listener is restartable so the
// topic can be changed at runtime from the setup screen.
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { app } = require("electron");

const RECONNECT_MS = 5000;
const DEFAULT_SERVER = "https://ntfy.sh";

// The user-writable config lives in userData so the packaged (read-only) app
// can still be configured after install.
function userConfigPath() {
  return path.join(app.getPath("userData"), "ntfy.config.json");
}

// Config resolution: NTFY_* env vars → userData → cwd → repo root. A missing
// topic means "not configured yet".
function loadConfig() {
  if (process.env.NTFY_TOPIC) {
    return {
      server: process.env.NTFY_SERVER || DEFAULT_SERVER,
      topic: process.env.NTFY_TOPIC,
      token: process.env.NTFY_TOKEN || "",
    };
  }
  const candidates = [
    userConfigPath(),
    path.join(process.cwd(), "ntfy.config.json"),
    path.join(__dirname, "..", "ntfy.config.json"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      if (cfg && cfg.topic) {
        return {
          server: cfg.server || DEFAULT_SERVER,
          topic: cfg.topic,
          token: cfg.token || "",
        };
      }
    } catch {
      console.error(`Could not parse ${file}`);
    }
  }
  return null;
}

// Writes the config to userData and returns the normalized object.
function saveConfig(cfg) {
  const out = {
    server: (cfg && cfg.server) || DEFAULT_SERVER,
    topic: (cfg && cfg.topic ? String(cfg.topic) : "").trim(),
    token: (cfg && cfg.token) || "",
  };
  fs.writeFileSync(userConfigPath(), JSON.stringify(out, null, 2));
  return out;
}

function isConfigured() {
  const c = loadConfig();
  return !!(c && c.topic);
}

function lastSeenPath() {
  return path.join(app.getPath("userData"), "ntfy-last-seen.json");
}
// We track the last message *id*, not just its timestamp: ntfy's `since=<id>`
// is exclusive (returns messages strictly after it), whereas `since=<seconds>`
// is inclusive and would re-deliver the boundary message on every restart.
function readLastSeen() {
  try {
    const saved = JSON.parse(fs.readFileSync(lastSeenPath(), "utf8"));
    return { id: saved.id || "", sec: Number(saved.sec) || 0 };
  } catch {
    return { id: "", sec: 0 };
  }
}
function writeLastSeen(seen) {
  try {
    fs.writeFileSync(lastSeenPath(), JSON.stringify(seen));
  } catch (err) {
    console.error(`Could not persist ntfy last-seen: ${err.message}`);
  }
}

// Turn an ntfy message into a notifier payload. If the sender put JSON in the
// message body, use it directly (so the full styled contract works); otherwise
// fall back to ntfy's own title/message so plain `curl -d "hi"` still shows.
function toPayload(msg) {
  const text = typeof msg.message === "string" ? msg.message : "";
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* not JSON after all — fall through */
    }
  }
  return { title: msg.title || msg.topic, body: text };
}

let active = null; // the current listener controller, or null when stopped

function stopNtfy() {
  if (!active) return;
  active.closed = true;
  if (active.reconnectTimer) clearTimeout(active.reconnectTimer);
  if (active.req) {
    try {
      active.req.destroy();
    } catch {
      /* ignore */
    }
  }
  active = null;
}

function scheduleReconnect(ctl) {
  if (ctl.closed || ctl.reconnectTimer) return;
  ctl.reconnectTimer = setTimeout(() => {
    ctl.reconnectTimer = null;
    if (!ctl.closed) connect(ctl);
  }, RECONNECT_MS);
}

function handleLine(ctl, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // The stream also carries open/keepalive/poll_request events — ignore them.
  if (msg.event !== "message") return;
  if (msg.id) {
    if (ctl.seenIds.has(msg.id)) return;
    ctl.seenIds.add(msg.id);
    if (ctl.seenIds.size > 1000) ctl.seenIds.clear(); // bound memory
    ctl.seen.id = msg.id;
  }
  if (typeof msg.time === "number") ctl.seen.sec = msg.time;
  writeLastSeen(ctl.seen);
  ctl.onMessage(toPayload(msg));
}

function connect(ctl) {
  const base = new URL(ctl.config.server);
  const isHttps = base.protocol === "https:";
  const lib = isHttps ? https : http;
  // Prefer the exclusive id cursor; fall back to seconds, then to the full
  // cached backlog on a first-ever run.
  const since = ctl.seen.id || (ctl.seen.sec > 0 ? String(ctl.seen.sec) : "all");
  const reqPath =
    base.pathname.replace(/\/$/, "") +
    `/${encodeURIComponent(ctl.config.topic)}/json?since=${encodeURIComponent(
      since
    )}`;

  const options = {
    hostname: base.hostname,
    port: base.port || (isHttps ? 443 : 80),
    path: reqPath,
    method: "GET",
    headers: {},
  };
  if (ctl.config.token) {
    options.headers.Authorization = `Bearer ${ctl.config.token}`;
  }

  const req = lib.request(options, (res) => {
    if (res.statusCode !== 200) {
      console.error(`ntfy: HTTP ${res.statusCode} from ${ctl.config.server}`);
      res.resume();
      return scheduleReconnect(ctl);
    }
    console.log(
      `Listening to ntfy topic "${ctl.config.topic}" on ${ctl.config.server}.`
    );
    res.setEncoding("utf8");
    let buffer = "";
    res.on("data", (chunk) => {
      if (ctl.closed) return;
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handleLine(ctl, line);
      }
    });
    res.on("end", () => scheduleReconnect(ctl));
    res.on("error", () => scheduleReconnect(ctl));
  });
  ctl.req = req;
  req.on("error", (err) => {
    if (ctl.closed) return;
    console.error(`ntfy connection error: ${err.message}`);
    scheduleReconnect(ctl);
  });
  req.end();
}

// Starts (or restarts) the subscription. Returns false if no topic is set.
// `onMessage` is called with each payload, including offline backlog.
function startNtfy(onMessage) {
  stopNtfy();
  const config = loadConfig();
  if (!config) {
    console.log("ntfy not configured (no topic). Waiting for setup.");
    return false;
  }
  active = {
    onMessage,
    config,
    closed: false,
    req: null,
    reconnectTimer: null,
    seenIds: new Set(),
    seen: readLastSeen(),
  };
  connect(active);
  return true;
}

module.exports = {
  startNtfy,
  stopNtfy,
  loadConfig,
  saveConfig,
  isConfigured,
  DEFAULT_SERVER,
};
