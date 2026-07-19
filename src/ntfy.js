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
// ntfy sends a keepalive roughly every 45s. If nothing (message or keepalive)
// arrives within this window the connection is dead — typically because the PC
// hibernated and the socket is half-open with no error event. Force a reconnect.
// Overridable via NTFY_STALE_MS (mainly for testing).
const STALE_MS = Number(process.env.NTFY_STALE_MS) || 75000;
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

// Report a connection-state change to the host (main process).
// state: "unconfigured" | "connecting" | "connected" | "disconnected".
function emitState(ctl, state, info) {
  ctl.state = state;
  if (typeof ctl.onState === "function") {
    try {
      ctl.onState(state, info || {});
    } catch {
      /* ignore */
    }
  }
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
  const gen = ++ctl.gen; // this attempt's id; a newer connect() invalidates it
  emitState(ctl, "connecting", { fails: ctl.fails });

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

  // Exactly one terminal transition per attempt: `settled` dedupes the
  // request-error + response-abort that both fire when we destroy a socket;
  // the generation check ignores attempts already superseded by a reconnect.
  let settled = false;
  const fail = (error) => {
    if (ctl.closed || settled || gen !== ctl.gen) return;
    settled = true;
    ctl.fails += 1;
    console.error(`ntfy: ${error} (attempt ${ctl.fails})`);
    emitState(ctl, "disconnected", { fails: ctl.fails, error });
    scheduleReconnect(ctl);
  };

  const req = lib.request(options, (res) => {
    if (gen !== ctl.gen) {
      res.destroy();
      return;
    }
    if (res.statusCode !== 200) {
      res.resume();
      return fail(`HTTP ${res.statusCode}`);
    }
    ctl.fails = 0;
    emitState(ctl, "connected", {});
    console.log(
      `Listening to ntfy topic "${ctl.config.topic}" on ${ctl.config.server}.`
    );
    res.setEncoding("utf8");
    let buffer = "";
    res.on("data", (chunk) => {
      if (ctl.closed || gen !== ctl.gen) return;
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handleLine(ctl, line);
      }
    });
    res.on("end", () => fail("stream ended"));
    res.on("error", (err) => fail(err.message));
  });
  ctl.req = req;
  // Idle-timeout watchdog: keepalives reset this; prolonged silence (a dead,
  // half-open socket after hibernation) trips it and forces a reconnect.
  req.setTimeout(STALE_MS, () => req.destroy(new Error("idle timeout")));
  req.on("error", (err) => fail(err.message));
  req.end();
}

// Starts (or restarts) the subscription. Returns false if no topic is set.
// `onMessage(payload)` gets each notification; `onState(state, info)` gets
// connection-state changes.
function startNtfy(onMessage, onState) {
  stopNtfy();
  const config = loadConfig();
  if (!config) {
    if (typeof onState === "function") onState("unconfigured", {});
    console.log("ntfy not configured (no topic). Waiting for setup.");
    return false;
  }
  active = {
    onMessage,
    onState,
    config,
    closed: false,
    req: null,
    reconnectTimer: null,
    seenIds: new Set(),
    seen: readLastSeen(),
    fails: 0,
    gen: 0,
    state: "connecting",
  };
  connect(active);
  return true;
}

// Force an immediate reconnect (e.g. on system resume). No-op if not running.
function reconnectNow() {
  const ctl = active;
  if (!ctl || ctl.closed) return;
  if (ctl.reconnectTimer) {
    clearTimeout(ctl.reconnectTimer);
    ctl.reconnectTimer = null;
  }
  if (ctl.req) {
    try {
      ctl.req.destroy();
    } catch {
      /* ignore */
    }
  }
  connect(ctl); // bumps gen, invalidating the old attempt's handlers
}

module.exports = {
  startNtfy,
  stopNtfy,
  reconnectNow,
  loadConfig,
  saveConfig,
  isConfigured,
  DEFAULT_SERVER,
};
