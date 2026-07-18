const {
  app,
  BrowserWindow,
  screen,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const path = require("path");
const crypto = require("crypto");
const ntfy = require("./ntfy");
const store = require("./store");

const SNOOZE_MS = 60 * 60 * 1000; // snooze length: 1 hour

let overlay = null; // transparent click-through notification layer
let dashboard = null; // normal window: history + mute/snooze controls
let tray = null;
let quitting = false; // true once the user really wants to exit

function createOverlay() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;

  overlay = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Notifications ring on arrival, with no click first, so allow the
      // renderer's Web Audio to start without a user gesture.
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  // Sit above virtually everything, including fullscreen apps.
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // The whole window is click-through; the renderer re-enables hit testing
  // only while the pointer is over an actual notification card.
  overlay.setIgnoreMouseEvents(true, { forward: true });

  overlay.loadFile(path.join(__dirname, "index.html"));
  overlay.once("ready-to-show", () => overlay.showInactive());
}

function createDashboard() {
  dashboard = new BrowserWindow({
    width: 480,
    height: 660,
    show: false,
    title: "Notifier History",
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: path.join(__dirname, "dashboard-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dashboard.setMenuBarVisibility(false);
  dashboard.loadFile(path.join(__dirname, "dashboard.html"));
  // Closing the window just hides it to the tray; only Quit really exits.
  dashboard.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      dashboard.hide();
    }
  });
}

function showDashboard() {
  if (!dashboard || dashboard.isDestroyed()) createDashboard();
  dashboard.show();
  dashboard.focus();
  pushState();
}

function pushState() {
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.webContents.send("state", store.getState(Date.now()));
  }
}

// Current setup snapshot for the dashboard's settings/first-run screen.
function configSnapshot() {
  const c = ntfy.loadConfig() || {};
  return {
    configured: !!c.topic,
    server: c.server || ntfy.DEFAULT_SERVER,
    topic: c.topic || "",
    token: c.token || "",
    autostart: autostartEnabled(),
  };
}
function pushConfig() {
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.webContents.send("config", configSnapshot());
  }
}

function trayImage() {
  const img = nativeImage.createFromPath(
    path.join(__dirname, "assets", "tray.png")
  );
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function autostartEnabled() {
  return app.getLoginItemSettings().openAtLogin;
}
function setAutostart(value) {
  app.setLoginItemSettings({ openAtLogin: !!value });
}

function updateTray() {
  if (!tray) return;
  const muted = store.getState(Date.now()).mutes.system;
  const menu = Menu.buildFromTemplate([
    { label: "Open History / Settings", click: showDashboard },
    { type: "separator" },
    {
      label: "Mute all notifications",
      type: "checkbox",
      checked: muted,
      click: (item) => {
        store.setSystemMute(item.checked);
        pushState();
        updateTray();
      },
    },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: autostartEnabled(),
      click: (item) => {
        setAutostart(item.checked);
        pushConfig();
        updateTray();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(muted ? "WindowsNotifier (muted)" : "WindowsNotifier");
}

function createTray() {
  tray = new Tray(trayImage());
  tray.on("click", showDashboard);
  updateTray();
}

// The single entry point for every incoming notification (from ntfy). An array
// payload is fanned out into one notification per element.
function handleIncoming(payload) {
  if (Array.isArray(payload)) {
    payload.forEach(handleIncoming);
    return;
  }
  if (!payload || typeof payload !== "object") return;
  const res = store.ingest(payload, Date.now());
  pushState(); // reflect the new/updated entry in an open dashboard

  if (res.suppressed) return; // snoozed: logged only, no popup

  if (overlay && !overlay.isDestroyed()) {
    overlay.webContents.send("notification", {
      ...payload,
      _groupKey: res.groupKey,
      _count: res.count,
      _appId: res.appId,
      _silent: res.silent,
    });
  }
}

// --- IPC: overlay -> main ---
ipcMain.on("set-interactive", (_event, interactive) => {
  if (!overlay) return;
  overlay.setIgnoreMouseEvents(!interactive, { forward: true });
});
ipcMain.on("dismiss-group", (_event, groupKey) => {
  store.dismissGroup(groupKey);
});
ipcMain.on("snooze-app", (_event, appId) => {
  store.snoozeApp(appId, Date.now() + SNOOZE_MS);
  pushState();
});
ipcMain.on("set-app-mute", (_event, appId, value) => {
  store.setAppMute(appId, value);
  pushState();
});

// --- IPC: dashboard -> main ---
ipcMain.handle("get-state", () => store.getState(Date.now()));
ipcMain.on("set-system-mute", (_event, value) => {
  store.setSystemMute(value);
  pushState();
  updateTray();
});
ipcMain.on("unsnooze-app", (_event, appId) => {
  store.unsnoozeApp(appId);
  pushState();
});
ipcMain.on("clear-history", () => {
  store.clearHistory();
  pushState();
});

// --- IPC: setup / config ---
ipcMain.handle("get-config", () => configSnapshot());
ipcMain.handle("generate-topic", () => "winnotif-" + crypto.randomBytes(9).toString("hex"));
ipcMain.handle("save-config", (_event, cfg) => {
  ntfy.saveConfig(cfg);
  const listening = ntfy.startNtfy(handleIncoming); // restart with new topic
  return { ...configSnapshot(), listening };
});
ipcMain.on("set-autostart", (_event, value) => {
  setAutostart(value);
  pushConfig();
  updateTray();
});

app.whenReady().then(() => {
  createOverlay();
  createDashboard();
  createTray();

  const configured = ntfy.isConfigured();
  // First run of the installed app: opt into launch-at-login by default.
  if (!configured && app.isPackaged) setAutostart(true);
  updateTray();

  ntfy.startNtfy(handleIncoming);

  // Show the window only when there's something for the user to do (first-run
  // setup). Once configured, launch silently to the tray.
  if (!configured) showDashboard();
});

app.on("before-quit", () => {
  quitting = true;
});

// Keep running with no windows visible; this is a background overlay app.
app.on("window-all-closed", () => {
  /* stay alive */
});
