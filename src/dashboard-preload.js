const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dash", {
  getState: () => ipcRenderer.invoke("get-state"),
  onState: (callback) =>
    ipcRenderer.on("state", (_event, state) => callback(state)),
  setSystemMute: (value) => ipcRenderer.send("set-system-mute", value),
  setAppMute: (appId, value) => ipcRenderer.send("set-app-mute", appId, value),
  snoozeApp: (appId) => ipcRenderer.send("snooze-app", appId),
  unsnoozeApp: (appId) => ipcRenderer.send("unsnooze-app", appId),
  clearHistory: () => ipcRenderer.send("clear-history"),
  // Setup / config
  getConfig: () => ipcRenderer.invoke("get-config"),
  onConfig: (callback) =>
    ipcRenderer.on("config", (_event, config) => callback(config)),
  saveConfig: (cfg) => ipcRenderer.invoke("save-config", cfg),
  generateTopic: () => ipcRenderer.invoke("generate-topic"),
  setAutostart: (value) => ipcRenderer.send("set-autostart", value),
});
