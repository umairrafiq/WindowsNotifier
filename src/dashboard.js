const $ = (id) => document.getElementById(id);
let now = Date.now();

function ago(ms) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function snoozeRemaining(untilMs) {
  const mins = Math.max(0, Math.round((untilMs - now) / 60000));
  return mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
}

function render(state) {
  now = Date.now();
  $("system-mute").checked = !!state.mutes.system;

  // --- Applications: mute toggle + snooze status/controls ---
  const apps = $("apps");
  apps.innerHTML = "";
  state.apps
    .slice()
    .sort()
    .forEach((appId) => {
      const row = document.createElement("div");
      row.className = "app-row";

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = appId;
      row.appendChild(name);

      const snoozeUntil = state.snoozes[appId];
      if (snoozeUntil > now) {
        const s = document.createElement("span");
        s.className = "snoozed";
        s.textContent = `snoozed ${snoozeRemaining(snoozeUntil)}`;
        row.appendChild(s);

        const un = document.createElement("button");
        un.className = "pill-btn";
        un.textContent = "Wake";
        un.onclick = () => window.dash.unsnoozeApp(appId);
        row.appendChild(un);
      } else {
        const sn = document.createElement("button");
        sn.className = "pill-btn";
        sn.textContent = "Snooze 1h";
        sn.onclick = () => window.dash.snoozeApp(appId);
        row.appendChild(sn);
      }

      const mute = document.createElement("label");
      mute.className = "toggle";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!state.mutes.apps[appId];
      cb.onchange = () => window.dash.setAppMute(appId, cb.checked);
      mute.appendChild(cb);
      mute.appendChild(document.createTextNode("Mute"));
      row.appendChild(mute);

      apps.appendChild(row);
    });

  // --- History: newest first ---
  const hist = $("history");
  hist.innerHTML = "";
  const items = state.history.slice().reverse();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No notifications yet.";
    hist.appendChild(empty);
    return;
  }

  for (const r of items) {
    const item = document.createElement("div");
    item.className = "item";

    const ic = document.createElement("div");
    ic.className = "ic";
    ic.textContent = r.icon || "🔔";
    item.appendChild(ic);

    const mid = document.createElement("div");
    mid.className = "mid";

    const top = document.createElement("div");
    top.className = "top";
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = r.title || "(no title)";
    top.appendChild(t);
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = r.appId;
    top.appendChild(chip);
    mid.appendChild(top);

    if (r.body) {
      const b = document.createElement("div");
      b.className = "b";
      b.textContent = r.body;
      mid.appendChild(b);
    }

    const when = document.createElement("div");
    when.className = "when";
    when.textContent =
      r.count > 1 ? `${ago(r.lastAt)} · ×${r.count}` : ago(r.lastAt);
    mid.appendChild(when);

    item.appendChild(mid);

    if (r.count > 1) {
      const c = document.createElement("div");
      c.className = "count";
      c.textContent = r.count > 99 ? "99+" : String(r.count);
      item.appendChild(c);
    }

    hist.appendChild(item);
  }
}

$("system-mute").onchange = (e) => window.dash.setSystemMute(e.target.checked);
$("clear").onclick = () => window.dash.clearHistory();

// --- Setup / config ---
function renderConfig(cfg) {
  // Don't clobber a field the user is actively editing.
  if (document.activeElement !== $("topic")) $("topic").value = cfg.topic || "";
  if (document.activeElement !== $("server")) $("server").value = cfg.server || "";
  if (document.activeElement !== $("token")) $("token").value = cfg.token || "";
  $("autostart").checked = !!cfg.autostart;
  $("setup").classList.toggle("needed", !cfg.configured);
  const status = $("status");
  if (!cfg.configured) {
    status.textContent = "Not connected — set a topic and Save.";
    status.className = "status warn";
    $("advanced").open = false;
    return;
  }
  switch (cfg.connection) {
    case "connected":
      status.textContent = `Connected — listening on ${cfg.topic}`;
      status.className = "status ok";
      break;
    case "disconnected":
      status.textContent = `Disconnected from ${cfg.topic} — retrying…`;
      status.className = "status warn";
      break;
    default: // connecting / unknown
      status.textContent = `Connecting to ${cfg.topic}…`;
      status.className = "status";
  }
}

$("gen").onclick = async () => {
  $("topic").value = await window.dash.generateTopic();
};

$("autostart").onchange = (e) => window.dash.setAutostart(e.target.checked);

$("save").onclick = async () => {
  const topic = $("topic").value.trim();
  const status = $("status");
  if (!topic) {
    status.textContent = "Enter a topic first.";
    status.className = "status warn";
    return;
  }
  status.textContent = "Saving…";
  status.className = "status";
  const cfg = await window.dash.saveConfig({
    topic,
    server: $("server").value.trim() || undefined,
    token: $("token").value.trim() || undefined,
  });
  renderConfig(cfg);
};

window.dash.onConfig(renderConfig);
window.dash.getConfig().then(renderConfig);

window.dash.onState(render);
window.dash.getState().then(render);

// Keep relative timestamps fresh.
setInterval(() => window.dash.getState().then(render), 30000);
