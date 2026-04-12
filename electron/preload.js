const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hifi', {
  getState:        ()           => ipcRenderer.invoke('get-state'),
  getConfig:       ()           => ipcRenderer.invoke('get-config'),
  getSuivi:        ()           => ipcRenderer.invoke('get-suivi'),
  saveConfig:      (config)     => ipcRenderer.invoke('save-config', config),
  readCsvRange:    (from, to)   => ipcRenderer.invoke('read-csv-range', from, to),
  exportData:      ()           => ipcRenderer.invoke('export-data'),
  restartDaemon:   ()           => ipcRenderer.invoke('restart-daemon'),
  onStateUpdate:   (cb)         => ipcRenderer.on('state-update', (_, s) => cb(s)),
  onNavigate:      (cb)         => ipcRenderer.on('navigate', (_, page) => cb(page)),
  // Contrôles fenêtre (titlebar custom)
  winMinimize:     ()           => ipcRenderer.send('win-minimize'),
  winMaximize:     ()           => ipcRenderer.send('win-maximize'),
  winClose:        ()           => ipcRenderer.send('win-close'),
})
