const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hifi', {
  getState:        ()                       => ipcRenderer.invoke('get-state'),
  getConfig:       ()                       => ipcRenderer.invoke('get-config'),
  getSuivi:        ()                       => ipcRenderer.invoke('get-suivi'),
  saveConfig:      (config)                 => ipcRenderer.invoke('save-config', config),
  readCsvRange:    (from, to, spb = 0)      => ipcRenderer.invoke('read-csv-range', from, to, spb),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  restartDaemon:   ()                       => ipcRenderer.invoke('restart-daemon'),
  onStateUpdate:   (cb)                     => ipcRenderer.on('state-update', (_, s) => cb(s)),
  onNavigate:      (cb)                     => ipcRenderer.on('navigate', (_, page) => cb(page)),
  winMinimize:     ()                       => ipcRenderer.send('win-minimize'),
  winMaximize:     ()                       => ipcRenderer.send('win-maximize'),
  winClose:        ()                       => ipcRenderer.send('win-close'),
  deleteDayData:   (dateKey)                 => ipcRenderer.invoke('delete-day-data', dateKey),
  deleteMonthData: (year, month)             => ipcRenderer.invoke('delete-month-data', year, month),
  deleteOldData:   (keepDays)                => ipcRenderer.invoke('delete-old-data', keepDays),
  getLocale:       ()                          => ipcRenderer.invoke('get-locale'),
  setLanguage:     (lang)                      => ipcRenderer.invoke('set-language', lang),
})
