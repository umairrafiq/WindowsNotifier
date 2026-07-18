// Sends a notification by publishing to an ntfy topic. The app's ntfy listener
// picks it up live, or on its next start if the PC was offline.
//
//   node send-ntfy.js "Title here" "Body text here"
//
// Uses the same ntfy.config.json (or NTFY_* env vars) as the app.
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");

function loadConfig() {
  if (process.env.NTFY_TOPIC) {
    return {
      server: process.env.NTFY_SERVER || "https://ntfy.sh",
      topic: process.env.NTFY_TOPIC,
      token: process.env.NTFY_TOKEN || "",
    };
  }
  const cfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "ntfy.config.json"), "utf8")
  );
  return {
    server: cfg.server || "https://ntfy.sh",
    topic: cfg.topic,
    token: cfg.token || "",
  };
}

const title = process.argv[2] || "Hello from ntfy";
const body = process.argv[3] || "This message was published to ntfy.";

const cfg = loadConfig();

// The full styled payload travels as the ntfy message body; the listener
// JSON.parses it back into a notification.
const payload = JSON.stringify({
  appId: "ntfy-demo",
  title,
  body,
  icon: "📣",
  position: "top-right",
  duration: 6000,
  style: { background: "#11131a", accent: "#3b82f6", color: "#ffffff" },
});

const base = new URL(cfg.server);
const isHttps = base.protocol === "https:";
const lib = isHttps ? https : http;

const options = {
  hostname: base.hostname,
  port: base.port || (isHttps ? 443 : 80),
  path: base.pathname.replace(/\/$/, "") + `/${encodeURIComponent(cfg.topic)}`,
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  },
};
if (cfg.token) options.headers.Authorization = `Bearer ${cfg.token}`;

const req = lib.request(options, (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    if (res.statusCode === 200) {
      console.log(`Published to ntfy topic "${cfg.topic}".`);
      process.exit(0);
    }
    console.error(`ntfy publish failed: HTTP ${res.statusCode} ${data}`);
    process.exit(1);
  });
});
req.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
req.write(payload);
req.end();
