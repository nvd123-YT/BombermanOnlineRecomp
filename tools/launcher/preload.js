const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("state:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  pickDisc: () => ipcRenderer.invoke("disc:pick"),
  detectDisc: () => ipcRenderer.invoke("disc:detect"),
  play: (settings) => ipcRenderer.invoke("game:play", settings),
  headless: (settings) => ipcRenderer.invoke("game:headless", settings),
  build: (settings) => ipcRenderer.invoke("game:build", settings),
  stop: () => ipcRenderer.invoke("game:stop"),
  testNet: (host, port) => ipcRenderer.invoke("net:test", host, port),
  quit: () => ipcRenderer.invoke("app:quit"),
  minimize: () => ipcRenderer.invoke("win:minimize"),
  maximize: () => ipcRenderer.invoke("win:maximize"),
  close: () => ipcRenderer.invoke("win:close"),
  readBindings: () => ipcRenderer.invoke("bindings:read"),
  readBindingsDefaults: () => ipcRenderer.invoke("bindings:defaults"),
  writeBindings: (text) => ipcRenderer.invoke("bindings:write", text),
  onLog: (cb) => ipcRenderer.on("log", (_e, payload) => cb(payload)),
  onTask: (cb) => ipcRenderer.on("task", (_e, payload) => cb(payload)),
  onToast: (cb) => ipcRenderer.on("toast", (_e, payload) => cb(payload)),
});
