const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notifier", {
  onNotification: (callback) =>
    ipcRenderer.on("notification", (_event, payload) => callback(payload)),
  setInteractive: (interactive) =>
    ipcRenderer.send("set-interactive", interactive),
  // Tell main a group's card was dismissed, so its counter resets.
  dismissGroup: (groupKey) => ipcRenderer.send("dismiss-group", groupKey),
  // Snooze / mute the app a card belongs to, straight from the card.
  snooze: (appId) => ipcRenderer.send("snooze-app", appId),
  muteApp: (appId) => ipcRenderer.send("set-app-mute", appId, true),
  // Main asks us to dismiss a card (e.g. clear the "offline" popup on reconnect).
  onRemoteDismiss: (callback) =>
    ipcRenderer.on("remote-dismiss", (_event, groupKey) => callback(groupKey)),
});
