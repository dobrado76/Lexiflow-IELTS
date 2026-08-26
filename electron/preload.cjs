const { contextBridge } = require('electron');

// No privileged APIs are exposed to the renderer yet. This preload exists so
// that contextIsolation stays enabled and can be extended safely if needed.
contextBridge.exposeInMainWorld('electron', {
  isElectron: true,
});
